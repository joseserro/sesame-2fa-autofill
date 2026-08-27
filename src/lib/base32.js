// RFC 4648 base32 — tolerant decoding (ignores spaces, dashes, padding, case).
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const LOOKUP = (() => {
  const map = new Map();
  for (let i = 0; i < ALPHABET.length; i++) map.set(ALPHABET[i], i);
  // Common transcription slips people make when typing a secret by hand.
  map.set('0', 14); // O
  map.set('1', 8);  // I
  map.set('8', 1);  // B
  return map;
})();

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s\-_=]/g, '');
  if (!clean) return new Uint8Array(0);
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = LOOKUP.get(ch);
    if (idx === undefined) throw new Error(`Not a base32 secret: unexpected character "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function isValidBase32(input) {
  try {
    return base32Decode(input).length > 0;
  } catch {
    return false;
  }
}
