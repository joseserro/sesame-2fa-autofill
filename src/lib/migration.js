// Google Authenticator "otpauth-migration://offline?data=..." payloads.
//
// The payload is a base64 protobuf:
//   MigrationPayload { repeated OtpParameters otp = 1; int32 version = 2;
//                      int32 batch_size = 3; int32 batch_index = 4; int32 batch_id = 5; }
//   OtpParameters { bytes secret = 1; string name = 2; string issuer = 3;
//                   Algorithm algorithm = 4; DigitCount digits = 5;
//                   OtpType type = 6; int64 counter = 7; }
import { base32Encode, base32Decode } from './base32.js';
import { eachField, createWriter, utf8 } from './protobuf.js';
import { splitLabel, migrationName } from './otpauth.js';

const ALGORITHM_FROM = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' };
const ALGORITHM_TO = { SHA1: 1, SHA256: 2, SHA512: 3 };
const DIGITS_FROM = { 0: 6, 1: 6, 2: 8 };
const DIGITS_TO = { 6: 1, 8: 2 };
const TYPE_FROM = { 0: 'totp', 1: 'hotp', 2: 'totp' };
const TYPE_TO = { hotp: 1, totp: 2 };

function base64ToBytes(b64) {
  // Migration URIs are URL-encoded, and some tools hand them over base64url.
  const normalised = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function parseOtpParameters(bytes) {
  const raw = { digits: 6, algorithm: 'SHA1', type: 'totp', counter: 0, name: '', issuer: '' };
  eachField(bytes, (field, value) => {
    switch (field) {
      case 1: raw.secret = base32Encode(value); break;
      case 2: raw.name = utf8(value); break;
      case 3: raw.issuer = utf8(value); break;
      case 4: raw.algorithm = ALGORITHM_FROM[Number(value)] || 'SHA1'; break;
      case 5: raw.digits = DIGITS_FROM[Number(value)] || 6; break;
      case 6: raw.type = TYPE_FROM[Number(value)] || 'totp'; break;
      case 7: raw.counter = Number(value); break;
    }
  });
  if (!raw.secret) throw new Error('Entry has no secret');
  const { issuer, account } = splitLabel(raw.issuer, raw.name);
  return { ...raw, issuer, account, period: 30 };
}

/** Decode one migration URI into { accounts, batchIndex, batchSize, batchId }. */
export function decodeMigrationUri(uri) {
  const trimmed = String(uri).trim();
  const match = trimmed.match(/[?&]data=([^&\s]+)/);
  if (!match) throw new Error('Migration URI has no data parameter');

  const payload = base64ToBytes(decodeURIComponent(match[1]));
  const result = { accounts: [], version: 0, batchSize: 1, batchIndex: 0, batchId: 0 };
  const errors = [];

  eachField(payload, (field, value) => {
    switch (field) {
      case 1:
        try {
          result.accounts.push(parseOtpParameters(value));
        } catch (err) {
          errors.push(err.message);
        }
        break;
      case 2: result.version = Number(value); break;
      case 3: result.batchSize = Number(value); break;
      case 4: result.batchIndex = Number(value); break;
      case 5: result.batchId = Number(value); break;
    }
  });

  if (!result.accounts.length && errors.length) throw new Error(errors[0]);
  result.errors = errors;
  return result;
}

/**
 * Pull every migration or plain otpauth URI out of a blob of pasted text.
 * Returns { accounts, batches, skipped } so callers can report what happened.
 */
export function extractUris(text) {
  const migration = String(text).match(/otpauth-migration:\/\/\S+/gi) || [];
  const plain = String(text).match(/otpauth:\/\/\S+/gi) || [];
  return { migration, plain };
}

/** Encode accounts back into migration URIs, batched the way Google does. */
export function encodeMigrationUris(accounts, { perBatch = 10 } = {}) {
  const batches = [];
  for (let i = 0; i < accounts.length; i += perBatch) {
    batches.push(accounts.slice(i, i + perBatch));
  }
  if (!batches.length) return [];

  const batchId = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;

  return batches.map((batch, index) => {
    const w = createWriter();
    for (const account of batch) {
      const entry = createWriter();
      entry.bytes(1, base32Decode(account.secret));
      entry.string(2, migrationName(account));
      if (account.issuer) entry.string(3, account.issuer);
      entry.uint(4, ALGORITHM_TO[account.algorithm] || 1);
      entry.uint(5, DIGITS_TO[account.digits] || 1);
      entry.uint(6, TYPE_TO[account.type] || 2);
      if (account.type === 'hotp') entry.uint(7, account.counter || 0);
      w.bytes(1, entry.finish());
    }
    w.uint(2, 1);                 // version
    w.uint(3, batches.length);    // batch_size
    w.uint(4, index);             // batch_index
    w.uint(5, batchId);
    return `otpauth-migration://offline?data=${encodeURIComponent(bytesToBase64(w.finish()))}`;
  });
}
