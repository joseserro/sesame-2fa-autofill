// otpauth:// URI parsing and building, plus the label heuristics that turn
// whatever an authenticator app wrote into a readable issuer + account pair.
import { isValidBase32 } from './base32.js';

const ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'];

/**
 * Authenticators are inconsistent about where the service name lives: sometimes
 * the `issuer` field, sometimes an "Issuer:account" label, sometimes only a bare
 * name like "Namecheap (ExampleUser)". Normalise all of those into one shape.
 */
export function splitLabel(issuer, name) {
  let service = (issuer || '').trim();
  let account = (name || '').trim();

  const colon = account.indexOf(':');
  if (colon > 0) {
    const prefix = account.slice(0, colon).trim();
    const rest = account.slice(colon + 1).trim();
    if (!service) {
      service = prefix;
      account = rest;
    } else if (prefix.toLowerCase() === service.toLowerCase()) {
      account = rest;
    }
  } else if (!service && account) {
    // "Namecheap (ExampleUser)" or "Stripe (old) (jose@example.com)" -> service + last group.
    const paren = account.indexOf('(');
    if (paren > 0 && account.endsWith(')')) {
      const groups = account.match(/\(([^()]*)\)/g);
      if (groups && groups.length) {
        service = account.slice(0, paren).trim();
        account = groups[groups.length - 1].slice(1, -1).trim();
      }
    } else {
      // A bare "Amazon" or "Ubisoft" is the service, with no account attached.
      service = account;
      account = '';
    }
  }

  // A bare "Amazon"/"Amazon" pair carries no account, it just repeats the service.
  if (service && account && account.toLowerCase() === service.toLowerCase()) account = '';
  // "kraken.com" + "Kraken - Sign-in (ExampleUser)" reads better without the echo.
  if (service && account) {
    const root = service.split('.')[0];
    if (root.length > 2 && account.toLowerCase().startsWith(root.toLowerCase())) {
      const rest = account.slice(root.length).replace(/^[\s\-–:|]+/, '').trim();
      if (rest) account = rest;
    }
  }

  return { issuer: service, account };
}

export function parseOtpauthUri(uri) {
  let url;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new Error('Not a valid URI');
  }
  if (url.protocol !== 'otpauth:') throw new Error('Not an otpauth:// URI');

  const type = url.host.toLowerCase() === 'hotp' ? 'hotp' : 'totp';
  const rawLabel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const params = url.searchParams;

  const secret = (params.get('secret') || '').replace(/\s/g, '');
  if (!secret) throw new Error('URI has no secret');
  if (!isValidBase32(secret)) throw new Error('URI secret is not valid base32');

  const { issuer, account } = splitLabel(params.get('issuer'), rawLabel);
  const algorithm = (params.get('algorithm') || 'SHA1').toUpperCase().replace('-', '');

  return {
    type,
    secret: secret.toUpperCase(),
    issuer,
    account,
    algorithm: ALGORITHMS.includes(algorithm) ? algorithm : 'SHA1',
    digits: clampDigits(params.get('digits')),
    period: clampPeriod(params.get('period')),
    counter: type === 'hotp' ? Number(params.get('counter') || 0) : 0,
  };
}

function clampDigits(value) {
  const n = parseInt(value, 10);
  return n >= 4 && n <= 10 ? n : 6;
}

function clampPeriod(value) {
  const n = parseInt(value, 10);
  return n >= 5 && n <= 300 ? n : 30;
}

export function buildOtpauthUri(account) {
  const label = account.issuer && account.account
    ? `${account.issuer}:${account.account}`
    : account.account || account.issuer || 'Account';
  const params = new URLSearchParams();
  params.set('secret', account.secret);
  if (account.issuer) params.set('issuer', account.issuer);
  if (account.algorithm && account.algorithm !== 'SHA1') params.set('algorithm', account.algorithm);
  if (account.digits && account.digits !== 6) params.set('digits', String(account.digits));
  if (account.type === 'hotp') params.set('counter', String(account.counter || 0));
  else if (account.period && account.period !== 30) params.set('period', String(account.period));
  return `otpauth://${account.type || 'totp'}/${encodeURIComponent(label)}?${params.toString()}`;
}

/** The label an authenticator app expects back on export. */
export function migrationName(account) {
  if (account.issuer && account.account) return `${account.issuer}:${account.account}`;
  return account.account || account.issuer || 'Account';
}
