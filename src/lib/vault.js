// The stored vault: accounts, settings, and the optional passphrase lock.
//
// Layout in chrome.storage.local:
//   meta      { version, encrypted, kdf: { salt, iterations } }
//   accounts  [Account]              when the vault is not encrypted
//   blob      { iv, ct }             when it is
//   settings  { ... }                never encrypted
// chrome.storage.session holds the derived key while unlocked, so the vault
// survives service-worker restarts but never touches disk and clears on exit.

import { deriveKey, encryptJson, decryptJson, exportKey, importKey, randomBytes, toBase64, fromBase64, PBKDF2_ITERATIONS } from './crypto.js';
import { deriveDomains } from './match.js';

const KEY_META = 'meta';
const KEY_ACCOUNTS = 'accounts';
const KEY_BLOB = 'blob';
const KEY_SETTINGS = 'settings';
const SESSION_KEY = 'vaultKey';
const SESSION_UNLOCKED_AT = 'unlockedAt';

export class VaultLockedError extends Error {
  constructor() {
    super('Vault is locked');
    this.name = 'VaultLockedError';
  }
}

export const DEFAULT_SETTINGS = {
  showChip: true,        // floating "fill this" hint on OTP fields
  autoSubmit: false,     // press the submit button after filling
  copyOnFill: false,     // also drop the code on the clipboard
  autoLockMinutes: 0,    // 0 = stay unlocked until the browser closes
  sortMode: 'manual',    // 'manual' | 'name'
};

const local = chrome.storage.local;
const session = chrome.storage.session;

async function readLocal(keys) {
  return chrome.storage.local.get(keys);
}

export async function getMeta() {
  const { [KEY_META]: meta } = await readLocal(KEY_META);
  return meta || { version: 1, encrypted: false, kdf: null };
}

export async function getSettings() {
  const { [KEY_SETTINGS]: settings } = await readLocal(KEY_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await local.set({ [KEY_SETTINGS]: next });
  return next;
}

export async function isEncrypted() {
  return (await getMeta()).encrypted === true;
}

async function sessionKey() {
  const stored = await session.get([SESSION_KEY, SESSION_UNLOCKED_AT]);
  if (!stored[SESSION_KEY]) return null;

  const { autoLockMinutes } = await getSettings();
  if (autoLockMinutes > 0) {
    const age = Date.now() - (stored[SESSION_UNLOCKED_AT] || 0);
    if (age > autoLockMinutes * 60000) {
      await lock();
      return null;
    }
  }
  return importKey(stored[SESSION_KEY]);
}

export async function isUnlocked() {
  if (!(await isEncrypted())) return true;
  return (await sessionKey()) !== null;
}

/** Push the auto-lock deadline out; called whenever the user actually does something. */
export async function touch() {
  const stored = await session.get(SESSION_KEY);
  if (stored[SESSION_KEY]) await session.set({ [SESSION_UNLOCKED_AT]: Date.now() });
}

export async function unlock(passphrase) {
  const meta = await getMeta();
  if (!meta.encrypted) return true;

  const key = await deriveKey(passphrase, fromBase64(meta.kdf.salt), meta.kdf.iterations);
  const { [KEY_BLOB]: blob } = await readLocal(KEY_BLOB);
  try {
    // Decrypting is the passphrase check: AES-GCM fails authentication on a wrong key.
    if (blob) await decryptJson(key, blob);
  } catch {
    throw new Error('Wrong passphrase');
  }
  await session.set({ [SESSION_KEY]: await exportKey(key), [SESSION_UNLOCKED_AT]: Date.now() });
  return true;
}

export async function lock() {
  await session.remove([SESSION_KEY, SESSION_UNLOCKED_AT]);
}

export async function loadAccounts() {
  const meta = await getMeta();
  if (!meta.encrypted) {
    const { [KEY_ACCOUNTS]: accounts } = await readLocal(KEY_ACCOUNTS);
    return (accounts || []).map(normaliseAccount);
  }
  const key = await sessionKey();
  if (!key) throw new VaultLockedError();
  const { [KEY_BLOB]: blob } = await readLocal(KEY_BLOB);
  if (!blob) return [];
  const accounts = await decryptJson(key, blob);
  return accounts.map(normaliseAccount);
}

export async function saveAccounts(accounts) {
  const clean = accounts.map(normaliseAccount);
  const meta = await getMeta();
  if (!meta.encrypted) {
    await local.set({ [KEY_ACCOUNTS]: clean });
    return clean;
  }
  const key = await sessionKey();
  if (!key) throw new VaultLockedError();
  await local.set({ [KEY_BLOB]: await encryptJson(key, clean) });
  await touch();
  return clean;
}

export function normaliseAccount(raw) {
  const type = raw.type === 'hotp' ? 'hotp' : 'totp';
  return {
    id: raw.id || crypto.randomUUID(),
    secret: String(raw.secret || '').toUpperCase().replace(/[\s-]/g, ''),
    issuer: (raw.issuer || '').trim(),
    account: (raw.account || '').trim(),
    type,
    algorithm: ['SHA1', 'SHA256', 'SHA512'].includes(raw.algorithm) ? raw.algorithm : 'SHA1',
    digits: Number(raw.digits) >= 4 && Number(raw.digits) <= 10 ? Number(raw.digits) : 6,
    period: Number(raw.period) >= 5 && Number(raw.period) <= 300 ? Number(raw.period) : 30,
    counter: type === 'hotp' ? Number(raw.counter || 0) : 0,
    domains: [...new Set((raw.domains || []).map((d) => String(d).trim().toLowerCase().replace(/^www\./, '')).filter(Boolean))],
    favourite: Boolean(raw.favourite),
    createdAt: raw.createdAt || Date.now(),
    lastUsedAt: raw.lastUsedAt || 0,
    useCount: Number(raw.useCount || 0),
  };
}

/** Two entries are the same account if the secret and the labels line up. */
export function accountKey(account) {
  return [
    account.secret,
    (account.issuer || '').toLowerCase(),
    (account.account || '').toLowerCase(),
  ].join('|');
}

/**
 * Merge imported entries into the vault, skipping ones already present.
 * Returns { added, skipped } so the import screen can say what happened.
 */
export async function addAccounts(incoming) {
  const existing = await loadAccounts();
  const seen = new Set(existing.map(accountKey));
  const added = [];

  for (const raw of incoming) {
    const account = normaliseAccount({
      ...raw,
      domains: raw.domains && raw.domains.length ? raw.domains : deriveDomains(raw),
    });
    if (!account.secret) continue;
    const key = accountKey(account);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(account);
  }

  if (added.length) await saveAccounts([...existing, ...added]);
  return { added: added.length, skipped: incoming.length - added.length, accounts: added };
}

export async function updateAccount(id, patch) {
  const accounts = await loadAccounts();
  const index = accounts.findIndex((a) => a.id === id);
  if (index === -1) throw new Error('Account not found');
  accounts[index] = normaliseAccount({ ...accounts[index], ...patch, id });
  await saveAccounts(accounts);
  return accounts[index];
}

export async function deleteAccount(id) {
  const accounts = await loadAccounts();
  await saveAccounts(accounts.filter((a) => a.id !== id));
}

export async function reorderAccounts(orderedIds) {
  const accounts = await loadAccounts();
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const next = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  for (const account of accounts) if (!orderedIds.includes(account.id)) next.push(account);
  await saveAccounts(next);
  return next;
}

/** Bump usage stats so the popup can float what you actually use to the top. */
export async function recordUse(id) {
  const accounts = await loadAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) return;
  account.lastUsedAt = Date.now();
  account.useCount = (account.useCount || 0) + 1;
  if (account.type === 'hotp') account.counter = (account.counter || 0) + 1;
  await saveAccounts(accounts);
}

export async function enableEncryption(passphrase) {
  if (await isEncrypted()) throw new Error('Vault is already encrypted');
  const accounts = await loadAccounts();
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);

  await local.set({
    [KEY_META]: {
      version: 1,
      encrypted: true,
      kdf: { salt: toBase64(salt), iterations: PBKDF2_ITERATIONS },
    },
    [KEY_BLOB]: await encryptJson(key, accounts),
  });
  await local.remove(KEY_ACCOUNTS);
  await session.set({ [SESSION_KEY]: await exportKey(key), [SESSION_UNLOCKED_AT]: Date.now() });
}

export async function disableEncryption(passphrase) {
  await unlock(passphrase);
  const accounts = await loadAccounts();
  await local.set({ [KEY_META]: { version: 1, encrypted: false, kdf: null }, [KEY_ACCOUNTS]: accounts });
  await local.remove(KEY_BLOB);
  await lock();
}

export async function changePassphrase(current, next) {
  await unlock(current);
  const accounts = await loadAccounts();
  const salt = randomBytes(16);
  const key = await deriveKey(next, salt, PBKDF2_ITERATIONS);
  await local.set({
    [KEY_META]: {
      version: 1,
      encrypted: true,
      kdf: { salt: toBase64(salt), iterations: PBKDF2_ITERATIONS },
    },
    [KEY_BLOB]: await encryptJson(key, accounts),
  });
  await session.set({ [SESSION_KEY]: await exportKey(key), [SESSION_UNLOCKED_AT]: Date.now() });
}

/** Wipe everything. Used by the "delete all data" button in options. */
export async function wipe() {
  await local.clear();
  await session.clear();
}
