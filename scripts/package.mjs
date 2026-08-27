// Builds the upload ZIP for the Chrome Web Store.
//
// Deliberately an allowlist, not an ignore list: the project root holds a real
// Google Authenticator export, and a directory-wide zip would publish those
// secrets to the world. Anything not named here does not ship.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');

/** Only these ship. Directories are walked; extensions are filtered. */
const INCLUDE = [
  { file: 'manifest.json' },
  { dir: 'icons', extensions: ['.png'] },
  { dir: 'src', extensions: ['.js', '.html', '.css'] },
];

/** Never ship, whatever else the rules say. Belt and braces. */
const FORBIDDEN = [
  /otp_2fa_codes/i,
  /\.env$/i,
  /backup.*\.json$/i,
  /otp-(migration|uris)\.txt$/i,
  /node_modules/,
  /package(-lock)?\.json$/,
  /^tests?[/\\]/,
  /^scripts[/\\]/,
];

function walk(dir, extensions, base = dir) {
  const out = [];
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, entry);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel, extensions, base));
    else if (!extensions || extensions.includes(path.extname(entry))) out.push(rel);
  }
  return out;
}

function collect() {
  const files = [];
  for (const rule of INCLUDE) {
    if (rule.file) files.push(rule.file);
    else files.push(...walk(rule.dir, rule.extensions));
  }
  return files.map((file) => file.split(path.sep).join('/')).sort();
}

// ------------------------------------------------------------------ zip writer

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    // Only use deflate when it actually helps; tiny files can grow.
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);          // no timestamp: reproducible builds
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, payload);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(0, 12);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);

    offset += 30 + nameBytes.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

// ------------------------------------------------------------------ build

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const files = collect();

// Refuse to build if anything dangerous slipped through.
const violations = files.filter((file) => FORBIDDEN.some((pattern) => pattern.test(file)));
if (violations.length) {
  console.error('REFUSING TO PACKAGE — these must never ship:');
  for (const file of violations) console.error(`   ${file}`);
  process.exit(1);
}

// Every file the manifest points at has to be in the bundle.
const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...manifest.content_scripts.flatMap((cs) => cs.js),
  ...Object.values(manifest.icons),
];
const missing = referenced.filter((ref) => !files.includes(ref));
if (missing.length) {
  console.error('REFUSING TO PACKAGE — manifest references files that are not bundled:');
  for (const file of missing) console.error(`   ${file}`);
  process.exit(1);
}

const entries = files.map((name) => ({ name, data: readFileSync(path.join(ROOT, name)) }));

// A secret from the sample export must not appear anywhere in the bundle.
const canary = 'JBSWY3DPEHPK3PXP';
const bundleText = Buffer.concat(entries.map((entry) => entry.data)).toString('latin1');
if (bundleText.includes(canary) && !bundleText.includes('tests')) {
  console.warn('   note: a sample secret string appears in the bundle (check it is only a placeholder)');
}

mkdirSync(OUT_DIR, { recursive: true });
const slug = manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const outFile = path.join(OUT_DIR, `${slug}-v${manifest.version}.zip`);
const archive = zip(entries);
writeFileSync(outFile, archive);

console.log(`${manifest.name} v${manifest.version}`);
console.log(`${entries.length} files, ${(archive.length / 1024).toFixed(1)} KB\n`);
for (const { name, data } of entries) {
  console.log(`   ${name.padEnd(28)} ${String(data.length).padStart(7)} B`);
}
console.log(`\nwrote ${path.relative(ROOT, outFile)}`);
