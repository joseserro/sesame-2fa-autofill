// Exercises the vault against a stand-in for chrome.storage, so the locking and
// dedupe rules are checked without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';

function fakeArea() {
  const data = new Map();
  return {
    dump: data,
    async get(keys) {
      const wanted = keys == null ? [...data.keys()] : (Array.isArray(keys) ? keys : [keys]);
      const out = {};
      for (const key of wanted) if (data.has(key)) out[key] = structuredClone(data.get(key));
      return out;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    async remove(keys) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) data.delete(key);
    },
    async clear() {
      data.clear();
    },
  };
}

globalThis.chrome = { storage: { local: fakeArea(), session: fakeArea() } };

const vault = await import('../src/lib/vault.js');

// A shorter KDF keeps the suite fast; the real cost only matters in the browser.
const { deriveKey } = await import('../src/lib/crypto.js');
assert.equal(typeof deriveKey, 'function');

const SECRET_A = 'JBSWY3DPEHPK3PXP';
const SECRET_B = 'GEZDGNBVGY3TQOJQ';

test.beforeEach(async () => {
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
});

test('adds accounts and fills in domains from the issuer', async () => {
  const { added } = await vault.addAccounts([{ issuer: 'GitHub', account: 'octocat', secret: SECRET_A }]);
  assert.equal(added, 1);

  const [account] = await vault.loadAccounts();
  assert.deepEqual(account.domains, ['github.com']);
  assert.equal(account.digits, 6);
  assert.equal(account.period, 30);
  assert.equal(account.type, 'totp');
  assert.ok(account.id);
});

test('re-importing the same export does not duplicate anything', async () => {
  const entries = [
    { issuer: 'GitHub', account: 'octocat', secret: SECRET_A },
    { issuer: 'Stripe', account: 'a@b.com', secret: SECRET_B },
  ];
  assert.equal((await vault.addAccounts(entries)).added, 2);

  const second = await vault.addAccounts(entries);
  assert.equal(second.added, 0);
  assert.equal(second.skipped, 2);
  assert.equal((await vault.loadAccounts()).length, 2);
});

test('the same secret under a different account is kept', async () => {
  await vault.addAccounts([{ issuer: 'Stripe', account: 'one@example.com', secret: SECRET_A }]);
  const { added } = await vault.addAccounts([{ issuer: 'Stripe', account: 'two@example.com', secret: SECRET_A }]);
  assert.equal(added, 1, 'two Stripe logins can legitimately share nothing but the label');
  assert.equal((await vault.loadAccounts()).length, 2);
});

test('rejects malformed input instead of storing it', async () => {
  const { added } = await vault.addAccounts([{ issuer: 'Broken', account: '', secret: '' }]);
  assert.equal(added, 0);
  assert.equal((await vault.loadAccounts()).length, 0);
});

test('normalisation clamps out-of-range values', async () => {
  await vault.addAccounts([{
    issuer: 'Odd', account: 'x', secret: SECRET_A,
    digits: 99, period: -5, algorithm: 'MD5', type: 'weird',
  }]);
  const [account] = await vault.loadAccounts();
  assert.equal(account.digits, 6);
  assert.equal(account.period, 30);
  assert.equal(account.algorithm, 'SHA1');
  assert.equal(account.type, 'totp');
});

test('editing and deleting work through the vault', async () => {
  await vault.addAccounts([{ issuer: 'GitHub', account: 'octocat', secret: SECRET_A }]);
  const [account] = await vault.loadAccounts();

  await vault.updateAccount(account.id, { domains: ['github.com', 'gist.github.com'], account: 'renamed' });
  const [updated] = await vault.loadAccounts();
  assert.equal(updated.account, 'renamed');
  assert.deepEqual(updated.domains, ['github.com', 'gist.github.com']);

  await vault.deleteAccount(account.id);
  assert.equal((await vault.loadAccounts()).length, 0);
});

test('HOTP counters advance on use', async () => {
  await vault.addAccounts([{ issuer: 'Bank', account: 'x', secret: SECRET_A, type: 'hotp', counter: 4 }]);
  const [account] = await vault.loadAccounts();
  await vault.recordUse(account.id);
  const [after] = await vault.loadAccounts();
  assert.equal(after.counter, 5);
  assert.equal(after.useCount, 1);
});

test('reordering survives a round trip', async () => {
  await vault.addAccounts([
    { issuer: 'A', account: '1', secret: SECRET_A },
    { issuer: 'B', account: '2', secret: SECRET_B },
  ]);
  const ids = (await vault.loadAccounts()).map((a) => a.id);
  await vault.reorderAccounts([ids[1], ids[0]]);
  assert.deepEqual((await vault.loadAccounts()).map((a) => a.issuer), ['B', 'A']);
});

test('encryption locks the vault and the right passphrase opens it', async () => {
  await vault.addAccounts([{ issuer: 'GitHub', account: 'octocat', secret: SECRET_A }]);
  await vault.enableEncryption('correct horse battery');

  assert.equal(await vault.isEncrypted(), true);
  // Plaintext accounts must be gone from disk.
  assert.equal('accounts' in (await chrome.storage.local.get('accounts')), false);
  const { blob } = await chrome.storage.local.get('blob');
  assert.ok(blob.iv && blob.ct);
  assert.ok(!JSON.stringify(blob).includes(SECRET_A), 'secret is not readable in the stored blob');

  // Still readable while unlocked.
  assert.equal((await vault.loadAccounts()).length, 1);

  await vault.lock();
  assert.equal(await vault.isUnlocked(), false);
  await assert.rejects(() => vault.loadAccounts(), (err) => err.name === 'VaultLockedError');

  await assert.rejects(() => vault.unlock('wrong passphrase'), /Wrong passphrase/);
  assert.equal(await vault.isUnlocked(), false);

  await vault.unlock('correct horse battery');
  assert.equal(await vault.isUnlocked(), true);
  assert.equal((await vault.loadAccounts())[0].secret, SECRET_A);
});

test('changing the passphrase keeps the data and invalidates the old one', async () => {
  await vault.addAccounts([{ issuer: 'GitHub', account: 'octocat', secret: SECRET_A }]);
  await vault.enableEncryption('first passphrase');
  await vault.changePassphrase('first passphrase', 'second passphrase');

  await vault.lock();
  await assert.rejects(() => vault.unlock('first passphrase'), /Wrong passphrase/);
  await vault.unlock('second passphrase');
  assert.equal((await vault.loadAccounts())[0].secret, SECRET_A);
});

test('removing encryption restores plaintext storage', async () => {
  await vault.addAccounts([{ issuer: 'GitHub', account: 'octocat', secret: SECRET_A }]);
  await vault.enableEncryption('a passphrase');
  await vault.disableEncryption('a passphrase');

  assert.equal(await vault.isEncrypted(), false);
  assert.equal((await vault.loadAccounts()).length, 1);
  assert.equal('blob' in (await chrome.storage.local.get('blob')), false);
});

test('writes are refused while locked', async () => {
  await vault.enableEncryption('a passphrase');
  await vault.lock();
  await assert.rejects(() => vault.saveAccounts([]), (err) => err.name === 'VaultLockedError');
});

test('auto-lock closes the vault once the window passes', async () => {
  await vault.addAccounts([{ issuer: 'GitHub', account: 'octocat', secret: SECRET_A }]);
  await vault.enableEncryption('a passphrase');
  await vault.setSettings({ autoLockMinutes: 5 });

  assert.equal(await vault.isUnlocked(), true);
  // Pretend the unlock happened six minutes ago.
  await chrome.storage.session.set({ unlockedAt: Date.now() - 6 * 60000 });
  assert.equal(await vault.isUnlocked(), false);
  assert.equal('vaultKey' in (await chrome.storage.session.get('vaultKey')), false);
});

test('settings round-trip with defaults filled in', async () => {
  const defaults = await vault.getSettings();
  assert.equal(defaults.showChip, true);
  assert.equal(defaults.autoSubmit, false);

  await vault.setSettings({ autoSubmit: true });
  const updated = await vault.getSettings();
  assert.equal(updated.autoSubmit, true);
  assert.equal(updated.showChip, true, 'untouched keys keep their defaults');
});

test('wipe clears everything', async () => {
  await vault.addAccounts([{ issuer: 'GitHub', account: 'octocat', secret: SECRET_A }]);
  await vault.setSettings({ autoSubmit: true });
  await vault.wipe();
  assert.equal((await vault.loadAccounts()).length, 0);
  assert.equal((await vault.getSettings()).autoSubmit, false);
});
