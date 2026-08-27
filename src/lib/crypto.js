// Passphrase encryption for the vault: PBKDF2-SHA256 -> AES-256-GCM.
// Only the secrets blob is encrypted; settings stay readable so the UI can
// render (and offer to unlock) without a passphrase.

export const PBKDF2_ITERATIONS = 600000;

export function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function deriveKey(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    true, // extractable, so the unlocked key can live in chrome.storage.session
    ['encrypt', 'decrypt'],
  );
}

export async function exportKey(key) {
  return toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

export async function importKey(rawBase64) {
  return crypto.subtle.importKey('raw', fromBase64(rawBase64), { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptJson(key, value) {
  const iv = randomBytes(12);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptJson(key, blob) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(blob.iv) },
    key,
    fromBase64(blob.ct),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
