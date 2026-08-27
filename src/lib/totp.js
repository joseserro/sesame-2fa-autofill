// TOTP (RFC 6238) and HOTP (RFC 4226) over WebCrypto.
import { base32Decode } from './base32.js';

const SUBTLE_ALGO = {
  SHA1: 'SHA-1',
  SHA256: 'SHA-256',
  SHA512: 'SHA-512',
};

const keyCache = new Map();

async function hmacKey(secretBytes, algorithm) {
  const hash = SUBTLE_ALGO[algorithm] || SUBTLE_ALGO.SHA1;
  const cacheKey = `${hash}:${Array.from(secretBytes).join(',')}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash }, false, ['sign']);
    // Bound the cache so a large vault plus long uptime cannot grow it without limit.
    if (keyCache.size > 200) keyCache.clear();
    keyCache.set(cacheKey, key);
  }
  return key;
}

function counterBytes(counter) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(counter), false);
  return new Uint8Array(buf);
}

/** RFC 4226 dynamic truncation. */
function truncate(hmac, digits) {
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Generate the current code for an account.
 * `atMs` lets callers pin a moment so a whole list renders from one instant.
 */
export async function generateCode(account, atMs = Date.now()) {
  const digits = account.digits || 6;
  const algorithm = account.algorithm || 'SHA1';
  const secret = base32Decode(account.secret);
  if (!secret.length) throw new Error('Empty secret');

  const counter =
    account.type === 'hotp'
      ? Number(account.counter || 0)
      : Math.floor(atMs / 1000 / (account.period || 30));

  const key = await hmacKey(secret, algorithm);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes(counter)));
  return truncate(sig, digits);
}

/** Seconds until the current TOTP window rolls over. */
export function secondsRemaining(account, atMs = Date.now()) {
  const period = account.period || 30;
  return period - Math.floor(atMs / 1000) % period;
}

export function formatCode(code) {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}
