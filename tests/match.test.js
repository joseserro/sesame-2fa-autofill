import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeMigrationUri, extractUris } from '../src/lib/migration.js';
import { deriveDomains, matchAccounts, scoreAccount, registrableDomain, hostFromUrl } from '../src/lib/match.js';

const FIXTURE = new URL('./fixtures/example-export.txt', import.meta.url);

/** The fixture export, with the domain guessing that import would apply. */
const accounts = extractUris(readFileSync(FIXTURE, 'utf8')).migration
  .flatMap((uri) => decodeMigrationUri(uri).accounts)
  .map((entry) => ({ ...entry, domains: deriveDomains(entry) }));

const labelsFor = (host) => matchAccounts(accounts, host).map(({ account }) =>
  `${account.issuer}|${account.account}`);

test('registrable domain handles plain and multi-part suffixes', () => {
  assert.equal(registrableDomain('dashboard.stripe.com'), 'stripe.com');
  assert.equal(registrableDomain('stripe.com'), 'stripe.com');
  assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('controlpanel.example.pt'), 'example.pt');
});

test('host extraction ignores non-web URLs', () => {
  assert.equal(hostFromUrl('https://www.GitHub.com/login'), 'github.com');
  assert.equal(hostFromUrl('chrome://extensions'), '');
  assert.equal(hostFromUrl('about:blank'), '');
  assert.equal(hostFromUrl('not a url'), '');
});

test('known issuers get useful domains at import time', () => {
  const github = accounts.find((a) => a.issuer === 'GitHub');
  assert.deepEqual(github.domains, ['github.com']);

  // Issuer that is already a hostname.
  const elastic = accounts.find((a) => a.issuer === 'auth.elastic.co');
  assert.ok(elastic.domains.includes('auth.elastic.co'));

  const aws = accounts.find((a) => a.issuer === 'Amazon Web Services');
  assert.ok(aws.domains.includes('signin.aws.amazon.com'));
});

test('finds the right account for a site', () => {
  assert.deepEqual(labelsFor('github.com'), ['GitHub|exampleuser']);
  assert.deepEqual(labelsFor('reddit.com'), ['Reddit|exampleuser']);
  assert.deepEqual(labelsFor('kraken.com'), ['kraken.com|Sign-in (ExampleUser)']);
  assert.deepEqual(labelsFor('controlpanel.example.pt'), ['controlpanel.example.pt|AB1234-EXPT']);
  assert.deepEqual(labelsFor('auth.elastic.co'), ['auth.elastic.co|user@example.net']);
});

test('subdomains of a saved domain still match', () => {
  assert.ok(labelsFor('cloud.digitalocean.com').length, 'digitalocean subdomain');
  assert.ok(labelsFor('login.microsoftonline.com').includes('Microsoft|exampleuser'));
  assert.ok(labelsFor('accounts.google.com').includes('Google|user@example.com'));
});

test('every Stripe account is offered on Stripe, so the menu can disambiguate', () => {
  const stripe = labelsFor('dashboard.stripe.com');
  assert.equal(stripe.length, 7);
  assert.ok(stripe.every((label) => label.toLowerCase().startsWith('stripe')));
});

test('an entry whose issuer was only in the label still matches', () => {
  // This one arrives with an empty issuer field: "Stripe (old@…) (user@…)".
  const recovered = accounts.filter((a) => a.issuer === 'Stripe' && a.account === 'user@example.com');
  assert.ok(recovered.length >= 1, 'issuer recovered from the bare label');
  assert.ok(recovered.every((a) => scoreAccount(a, 'stripe.com') > 0));
});

test('unrelated sites match nothing', () => {
  for (const host of ['example.com', 'news.ycombinator.com', 'wikipedia.org', 'my-bank.co.uk']) {
    assert.deepEqual(labelsFor(host), [], host);
  }
});

test('a site never sees codes belonging to another site', () => {
  const github = labelsFor('github.com');
  assert.ok(!github.some((label) => label.includes('Stripe')));
  assert.ok(!github.some((label) => label.includes('Google')));

  // An attacker-controlled lookalike must not pull the real account.
  assert.deepEqual(labelsFor('github.com.evil.example'), []);
  assert.deepEqual(labelsFor('githubb.com'), []);
});

test('no host means no matches', () => {
  assert.deepEqual(matchAccounts(accounts, ''), []);
  assert.equal(scoreAccount(accounts[0], ''), 0);
});

test('explicit user domains win over guessing', () => {
  const custom = { issuer: 'Work VPN', account: 'jane', domains: ['vpn.internal.example'] };
  assert.equal(scoreAccount(custom, 'vpn.internal.example'), 100);
  assert.equal(scoreAccount(custom, 'other.example'), 0);
});

test('a domain list shuts off name guessing entirely', () => {
  // "GitHub" would otherwise read like the site name on any github-ish host.
  const github = { issuer: 'GitHub', account: 'octocat', domains: ['github.com'] };
  assert.equal(scoreAccount(github, 'github.xyz'), 0);
  assert.equal(scoreAccount(github, 'githubb.com'), 0);
  assert.equal(scoreAccount(github, 'github.com'), 100);

  // With no domains at all, the issuer still has to equal the site's name.
  const bare = { issuer: 'GitHub', account: 'octocat', domains: [] };
  assert.equal(scoreAccount(bare, 'githubb.com'), 0);
  assert.equal(scoreAccount(bare, 'github-login.com'), 0);
  assert.ok(scoreAccount(bare, 'github.com') > 0);
});
