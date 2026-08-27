// Regenerates tests/fixtures/example-export.txt.
//
// The committed fixture stands in for a real Google Authenticator export so the
// suite runs anywhere. It writes the protobuf fields directly, rather than going
// through encodeMigrationUris(), so the awkward real-world label shapes are
// preserved exactly: empty issuer fields, bare service names with no account,
// parenthesised labels, and issuers echoed inside the name.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createWriter } from '../src/lib/protobuf.js';
import { base32Encode } from '../src/lib/base32.js';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Deterministic filler so the fixture is stable across regenerations. */
function fakeSecret(length, seed) {
  const bytes = new Uint8Array(length);
  let state = seed * 2654435761 % 4294967296;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 4294967296;
    bytes[i] = (state >>> 16) & 0xff;
  }
  return bytes;
}

// [name, issuer, secretBytes] -- mirrors the shapes a real export contains.
const ENTRIES = [
  ['Amazon Web Services:root-account-mfa-device@111122223333', 'Amazon Web Services', 40],
  ['DigitalOcean:user@example.com', 'DigitalOcean', 20],
  ['auth.elastic.co:user@example.net', 'auth.elastic.co', 10],
  ['Stripe (old@example.com) (user@example.com)', '', 15],
  ['Stripe: user@example.com', 'Stripe', 15],
  ['Dropbox:user@example.com', 'Dropbox', 16],
  ['Amazon', '', 32],
  ['ExampleUser', 'Facebook', 20],
  ['Instagram:example.user', 'Instagram', 20],
  ['Reddit:exampleuser', 'Reddit', 20],
  ['Uber:Renée Example', 'Uber', 20],
  ['GitHub:exampleuser', 'GitHub', 10],
  ['Microsoft:exampleuser', '', 10],
  ['RamNode:user@example.com', '', 10],
  ['Namecheap (ExampleUser)', '', 20],
  ['Google:user@example.com', 'Google', 20],
  ['AB1234-EXPT', 'controlpanel.example.pt', 20],
  ['Ubisoft', '', 10],
  ['Stripe: billing@example.com', 'Stripe', 15],
  ['Stripe: payouts@example.com', 'Stripe', 15],
  ['Stripe: team@example.org', 'Stripe', 15],
  ['Stripe: shop@example.net', 'Stripe', 15],
  ['Kraken - Sign-in (ExampleUser)', 'kraken.com', 15],
  ['Stripe: orders@example.co', 'Stripe', 15],
  ['Cloudflare:ops@example.com', 'Cloudflare', 20],
];

const ALGORITHM_SHA1 = 1;
const DIGITS_SIX = 1;
const TYPE_TOTP = 2;
const BATCH_ID = 1549051484; // fixed, so regenerating does not churn the file

function encodeBatch(entries, index, total) {
  const w = createWriter();
  for (const [name, issuer, secret] of entries) {
    const entry = createWriter();
    entry.bytes(1, secret);
    entry.string(2, name);
    if (issuer) entry.string(3, issuer);
    entry.uint(4, ALGORITHM_SHA1);
    entry.uint(5, DIGITS_SIX);
    entry.uint(6, TYPE_TOTP);
    w.bytes(1, entry.finish());
  }
  w.uint(2, 1);        // version
  w.uint(3, total);    // batch_size
  w.uint(4, index);    // batch_index
  w.uint(5, BATCH_ID);

  const bytes = w.finish();
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `otpauth-migration://offline?data=${encodeURIComponent(btoa(binary))}`;
}

const withSecrets = ENTRIES.map(([name, issuer, length], i) => [name, issuer, fakeSecret(length, i + 1)]);
const perBatch = 10;
const batches = [];
for (let i = 0; i < withSecrets.length; i += perBatch) batches.push(withSecrets.slice(i, i + perBatch));

const uris = batches.map((batch, i) => encodeBatch(batch, i, batches.length));

mkdirSync(path.join(ROOT, 'tests/fixtures'), { recursive: true });
const outPath = path.join(ROOT, 'tests/fixtures/example-export.txt');
writeFileSync(outPath, `${uris.join('\n')}\n`);

console.log(`${withSecrets.length} entries in ${uris.length} batches`);
console.log(`wrote ${path.relative(ROOT, outPath)}`);
console.log('\nbase32 secrets (for reference):');
for (const [name, , secret] of withSecrets) {
  console.log(`   ${base32Encode(secret).slice(0, 10)}...  ${name}`);
}
