// Renders the Chrome Web Store screenshots (1280x800) from the real UI.
//
// The popup and options pages are loaded exactly as they ship, with a stubbed
// chrome.* API backed by demo data, so what you see in the store is what the
// extension actually draws -- not a mockup that can drift from the code.
//
//   node scripts/screenshots.mjs
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { encodeMigrationUris } from '../src/lib/migration.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'store');
const BARE = path.join(ROOT, 'docs', 'img');
const TEMP = [];

// Demo accounts. Deliberately generic -- these end up on a public listing, so
// nothing here may resemble a real person or a real secret.
const DEMO_ACCOUNTS = [
  ['GitHub', 'you@example.com', 'JBSWY3DPEHPK3PXP', ['github.com']],
  ['GitHub', 'work@example.com', 'SGSWY3DPEHPK3PXS', ['github.com']],
  ['Google', 'you@example.com', 'KRSXG5CTMVRXEZLU', ['google.com', 'accounts.google.com']],
  ['Amazon Web Services', 'admin@example.com', 'MFRGGZDFMZTWQ2LK', ['aws.amazon.com', 'signin.aws.amazon.com']],
  ['Stripe', 'billing@example.com', 'NBSWY3DPEB3W64TM', ['stripe.com']],
  ['Stripe', 'payouts@example.com', 'ONSWG4TFOQFA====', ['stripe.com']],
  ['Cloudflare', 'ops@example.com', 'PB2WY3DPEHPK3PXP', ['cloudflare.com']],
  ['Dropbox', 'you@example.com', 'QJSWY3DPEHPK3PXQ', ['dropbox.com']],
  ['Namecheap', 'you@example.com', 'RFSWY3DPEHPK3PXR', ['namecheap.com']],
].map(([issuer, account, secret, domains], index) => ({
  id: `demo-${index}`,
  issuer, account, secret, domains,
  type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, counter: 0,
  favourite: false, createdAt: 0, lastUsedAt: 0, useCount: 0,
}));

/** A chrome.* stand-in, injected before the page's own modules run. */
function chromeStub({ tabUrl = 'https://github.com/login', accounts = DEMO_ACCOUNTS } = {}) {
  return `
  (() => {
    const local = new Map(Object.entries(${JSON.stringify({ accounts, meta: { version: 1, encrypted: false, kdf: null }, settings: {} })}));
    const session = new Map();
    const area = (map) => ({
      get: async (keys) => {
        const want = keys == null ? [...map.keys()] : (Array.isArray(keys) ? keys : [keys]);
        const out = {};
        for (const k of want) if (map.has(k)) out[k] = structuredClone(map.get(k));
        return out;
      },
      set: async (items) => { for (const [k, v] of Object.entries(items)) map.set(k, structuredClone(v)); },
      remove: async (keys) => { for (const k of [].concat(keys)) map.delete(k); },
      clear: async () => map.clear(),
    });
    window.chrome = {
      storage: { local: area(local), session: area(session) },
      tabs: {
        query: async () => [{ id: 1, url: ${JSON.stringify(tabUrl)} }],
        create: () => {},
        sendMessage: async () => ({ ok: true }),
      },
      runtime: {
        id: 'demo',
        getURL: (p) => p,
        openOptionsPage: () => {},
        sendMessage: async () => ({ ok: true, suggestion: null }),
        onMessage: { addListener: () => {} },
      },
    };
  })();`;
}

/** Copy a shipped page next to itself with the stub injected, so imports resolve. */
function makeDemoPage(pagePath, stub, extraHead = '') {
  const source = readFileSync(path.join(ROOT, pagePath), 'utf8');
  const patched = source.replace('</head>', `<script>${stub}</script>${extraHead}</head>`);
  const outPath = pagePath.replace(/([^/]+)\.html$/, '_demo-$1.html');
  writeFileSync(path.join(ROOT, outPath), patched);
  TEMP.push(outPath);
  return outPath;
}

// ------------------------------------------------------------------ framing

const FRAME_CSS = `
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1280px; height: 800px; overflow: hidden; display: flex;
    flex-direction: column; align-items: center; justify-content: center; gap: 30px;
    font: 400 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(140deg, #4f46e5 0%, #7c3aed 55%, #4338ca 100%);
    color: #fff;
  }
  h1 { font-size: 30px; font-weight: 650; letter-spacing: -.4px; text-align: center; }
  h1 small { display: block; font-size: 15px; font-weight: 400; opacity: .82; margin-top: 7px; letter-spacing: 0; }
  .stage { border-radius: 14px; overflow: hidden; box-shadow: 0 26px 70px rgba(15,23,42,.42); background: #fff; }
  iframe { border: 0; display: block; }
`;

function framePage(bodyHtml) {
  return `<!doctype html><meta charset="utf-8"><style>${FRAME_CSS}</style><body>${bodyHtml}</body>`;
}

/** An iframe scaled about its top-left, wrapped in a box of the resulting size. */
function scaledFrame(src, width, height, scale) {
  return `<div class="stage" style="width:${Math.round(width * scale)}px;height:${Math.round(height * scale)}px">
    <iframe src="${src}" style="width:${width}px;height:${height}px;transform:scale(${scale});transform-origin:0 0"></iframe>
  </div>`;
}

// ------------------------------------------------------------------ mock site

/** A believable sign-in page, used as the backdrop for the in-page features. */
const MOCK_SITE = `<!doctype html><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font: 400 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f6f8fa; color: #1f2328; height: 100vh; display: grid; place-items: center; }
  .card { width: 340px; background: #fff; border: 1px solid #d1d9e0; border-radius: 10px; padding: 26px 24px; }
  .logo { width: 34px; height: 34px; margin: 0 auto 18px; display: block; }
  h1 { font-size: 19px; font-weight: 400; text-align: center; margin-bottom: 6px; }
  p { text-align: center; color: #59636e; font-size: 13px; margin-bottom: 20px; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  input { width: 100%; padding: 9px 11px; border: 1px solid #d1d9e0; border-radius: 6px; font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .28em; text-align: center; font-size: 17px; }
  input:focus { outline: 0; border-color: #0969da; box-shadow: 0 0 0 3px rgba(9,105,218,.28); }
  button { width: 100%; margin-top: 16px; padding: 9px; border: 0; border-radius: 6px;
    background: #1f883d; color: #fff; font: 600 14px inherit; cursor: pointer; }
</style>
<body>
  <div class="card">
    <svg class="logo" viewBox="0 0 16 16" fill="#1f2328"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
    <h1>Two-factor authentication</h1>
    <p>Enter the 6-digit code from your authenticator app</p>
    <label for="otp">Authentication code</label>
    <input id="otp" autocomplete="one-time-code" inputmode="numeric" maxlength="6" placeholder="······">
    <button>Verify</button>
  </div>
</body>`;

/** A faithful redraw of the Chrome right-click menu; native UI cannot be captured. */
function contextMenuHtml(top, left) {
  const row = (label, extra = '') =>
    `<div style="padding:7px 14px;color:#3c4043;white-space:nowrap;${extra}">${label}</div>`;
  const sep = '<div style="height:1px;background:#e8eaed;margin:5px 0"></div>';

  // Only codes belonging to the site being viewed may appear here.
  const submenu = `
    <div style="position:absolute;left:calc(100% + 1px);top:-6px;width:250px;background:#fff;border-radius:8px;
                padding:6px 0;box-shadow:0 3px 14px rgba(0,0,0,.22),0 0 0 1px rgba(0,0,0,.06);">
      ${row('GitHub — you@example.com', 'background:#e8f0fe')}
      ${row('GitHub — work@example.com')}
      ${sep}
      ${row('Search all codes…')}
    </div>`;

  return `
  <div style="position:absolute;top:${top}px;left:${left}px;font:400 13px/1 -apple-system,'Segoe UI',Roboto,sans-serif;">
    <div style="width:230px;background:#fff;border-radius:8px;padding:6px 0;
                box-shadow:0 3px 14px rgba(0,0,0,.22),0 0 0 1px rgba(0,0,0,.06);">
      ${row('Back')}${row('Forward')}${row('Reload')}
      ${sep}
      ${row('Save as…')}${row('Print…')}
      ${sep}
      <div style="position:relative;padding:7px 14px;background:#e8f0fe;color:#1967d2;font-weight:500;
                  display:flex;align-items:center;justify-content:space-between;">
        <span style="display:flex;align-items:center;gap:9px">
          <span style="width:16px;height:16px;border-radius:4px;background:#4f46e5;display:inline-block"></span>
          Use OTP code
        </span>
        <span style="opacity:.7">&#9656;</span>
        ${submenu}
      </div>
      ${row('Inspect')}
    </div>
  </div>`;
}

/** The mock site with its card pushed left, leaving room for the menu. */
const MOCK_SITE_LEFT = MOCK_SITE.replace(
  'place-items: center;',
  'place-items: center start; padding-left: 56px;'
);

/** A Google Authenticator export: three codes already saved, three new. */
const DEMO_IMPORT = encodeMigrationUris([
  { issuer: 'GitHub', account: 'you@example.com', secret: 'JBSWY3DPEHPK3PXP', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30 },
  { issuer: 'Google', account: 'you@example.com', secret: 'KRSXG5CTMVRXEZLU', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30 },
  { issuer: 'Stripe', account: 'billing@example.com', secret: 'NBSWY3DPEB3W64TM', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30 },
  { issuer: 'Linear', account: 'you@example.com', secret: 'TFSWY3DPEHPK3PXT', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30 },
  { issuer: 'Vercel', account: 'you@example.com', secret: 'UGSWY3DPEHPK3PXU', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30 },
  { issuer: 'Proton', account: 'you@example.com', secret: 'VHSWY3DPEHPK3PXV', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30 },
]).join('\n');

// ------------------------------------------------------------------ server

function serve(root) {
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json',
  };
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ------------------------------------------------------------------ capture

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(BARE, { recursive: true });
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;

  const popupDemo = makeDemoPage('src/popup/popup.html', chromeStub());
  const optionsDemo = makeDemoPage('src/options/options.html', chromeStub({ tabUrl: 'https://github.com/login' }));

  const browser = await puppeteer.launch({ headless: 'new', args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

  // Frames are written to disk and navigated to, rather than injected with
  // setContent: a setContent document has an opaque origin, and the http://
  // iframes inside it are blocked.
  const shot = async (name, html, prepare) => {
    const frameFile = `store/_frame-${name.replace('.png', '')}.html`;
    writeFileSync(path.join(ROOT, frameFile), html);
    TEMP.push(frameFile);
    await page.goto(`${base}/${frameFile}`, { waitUntil: 'networkidle0' });
    if (prepare) await prepare(page);
    await new Promise((r) => setTimeout(r, 700)); // let codes render and fonts settle
    await page.screenshot({ path: path.join(OUT, name) });

    // The store images carry their own headline on a gradient. The website
    // reuses the same UI, so grab it on its own to avoid repeating the text.
    const stage = await page.$('.stage');
    if (stage) {
      await stage.screenshot({ path: path.join(BARE, `bare-${name}`), omitBackground: true });
    }
    console.log(`   ${name}`);
  };

  /** Iframes may not be attached the instant setContent resolves. */
  const waitForFrame = async (needle) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const frame = page.frames().find((f) => f.url().includes(needle));
      if (frame) {
        await frame.waitForSelector('body', { timeout: 5000 }).catch(() => {});
        return frame;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`iframe "${needle}" never appeared`);
  };

  console.log('capturing:');

  // 1 - the popup, full of live codes
  await shot('1-popup.png', framePage(`
    <h1>Every code, one click away
      <small>Live codes with a countdown. The ones for the site you are on come first.</small></h1>
    ${scaledFrame(`${base}/${popupDemo}`, 360, 470, 1.28)}`));

  // 2 - the right-click flow, the whole point of the extension
  await shot('2-right-click.png', framePage(`
    <h1>Right-click, and the code goes in
      <small>Only the codes that belong to this site are offered.</small></h1>
    <div class="stage" style="width:900px;height:470px;position:relative">
      <iframe srcdoc="${MOCK_SITE_LEFT.replace(/"/g, '&quot;')}" style="width:900px;height:470px"></iframe>
      ${contextMenuHtml(150, 372)}
    </div>`));

  // 3 - importing from Google Authenticator
  await shot('3-import.png', framePage(`
    <h1>Move in from Google Authenticator
      <small>Paste the export, or drop the QR screenshots in. Duplicates are spotted for you.</small></h1>
    ${scaledFrame(`${base}/${optionsDemo}#import`, 1180, 720, 0.82)}`),
    async (p) => {
      const frame = await waitForFrame('_demo-options');
      await frame.evaluate(async (uris) => {
        document.querySelector('#import-text').value = uris;
        document.querySelector('#parse-btn').click();
        await new Promise((r) => setTimeout(r, 400));
        document.querySelector('#import').scrollIntoView();
        window.scrollBy(0, 150);
      }, DEMO_IMPORT);
    });

  // 4 - the account list, showing the domain rules
  await shot('4-codes.png', framePage(`
    <h1>Your codes, and where each one belongs
      <small>Every account carries the sites it may be used on. Nothing else can pull it.</small></h1>
    ${scaledFrame(`${base}/${optionsDemo}#accounts`, 1180, 720, 0.82)}`),
    async (p) => {
      const frame = await waitForFrame('_demo-options');
      await frame.evaluate(() => document.querySelector('#accounts').scrollIntoView());
    });

  // 5 - the suggestion chip, drawn by the real content script
  const chipStub = `
    window.chrome = {
      runtime: {
        id: 'demo',
        sendMessage: async (m) => m.type === 'otp:suggest'
          ? { ok: true, suggestion: { id: 'demo-0', label: 'GitHub — you@example.com', code: '418 902'.replace(' ', ''), alternatives: 1 } }
          : { ok: true },
        onMessage: { addListener: () => {} },
      },
    };`;
  // The content script must load same-origin, so this one is a real file.
  const chipPage = MOCK_SITE
    + `<script>${chipStub}</script>`
    + `<script src="/src/content.js"></script>`
    + `<script>addEventListener('load', () => setTimeout(() => document.querySelector('#otp').focus(), 150));</script>`;
  writeFileSync(path.join(OUT, '_chip.html'), chipPage);
  TEMP.push('store/_chip.html');

  await shot('5-chip.png', framePage(`
    <h1>Or let it offer
      <small>Click into a 2FA box and the right code is already waiting.</small></h1>
    <div class="stage" style="width:900px;height:470px">
      <iframe src="${base}/store/_chip.html" style="width:900px;height:470px"></iframe>
    </div>`),
    async () => new Promise((r) => setTimeout(r, 900)));

  await browser.close();
  server.close();

  for (const file of TEMP) rmSync(path.join(ROOT, file), { force: true });
  console.log(`\nwrote ${OUT}`);
}

// The chip page needs to be a real file so the content script loads same-origin.
mkdirSync(OUT, { recursive: true });

main().catch((err) => {
  console.error(err);
  for (const file of TEMP) rmSync(path.join(ROOT, file), { force: true });
  process.exit(1);
});
