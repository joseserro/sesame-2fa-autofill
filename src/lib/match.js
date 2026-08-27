// Deciding which stored account belongs to the site you are looking at.
//
// Accounts carry an explicit `domains` list that the user can edit; everything
// else here exists to make that list good enough on day one, straight out of a
// Google Authenticator import where all we get is a name like "Namecheap (ExampleUser)".

/** Multi-label public suffixes common enough to matter for eTLD+1 guessing. */
const MULTI_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'gov.uk', 'ac.uk', 'co.jp', 'ne.jp', 'or.jp',
  'com.au', 'net.au', 'org.au', 'com.br', 'com.mx', 'com.ar', 'com.tr',
  'co.nz', 'co.za', 'co.in', 'co.kr', 'com.sg', 'com.hk', 'com.tw', 'com.cn',
  'com.pt', 'com.es', 'com.pl', 'co.il', 'com.ua', 'com.my', 'com.ph', 'com.vn',
]);

/** Well-known issuer -> the hosts you actually sign in on. */
const KNOWN_ISSUERS = {
  'amazon web services': ['aws.amazon.com', 'signin.aws.amazon.com', 'amazonaws.com', 'console.aws.amazon.com'],
  aws: ['aws.amazon.com', 'signin.aws.amazon.com', 'amazonaws.com'],
  amazon: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.es', 'amazon.fr', 'amazon.it'],
  google: ['google.com', 'accounts.google.com', 'youtube.com', 'gmail.com', 'cloud.google.com'],
  microsoft: ['microsoft.com', 'live.com', 'outlook.com', 'office.com', 'azure.com', 'login.microsoftonline.com', 'xbox.com'],
  apple: ['apple.com', 'icloud.com', 'appleid.apple.com'],
  github: ['github.com'],
  gitlab: ['gitlab.com'],
  bitbucket: ['bitbucket.org'],
  atlassian: ['atlassian.com', 'atlassian.net', 'jira.com'],
  digitalocean: ['digitalocean.com', 'cloud.digitalocean.com'],
  linode: ['linode.com', 'cloud.linode.com'],
  vultr: ['vultr.com'],
  hetzner: ['hetzner.com', 'hetzner.cloud', 'console.hetzner.cloud'],
  ovh: ['ovh.com', 'ovhcloud.com'],
  ramnode: ['ramnode.com', 'clientarea.ramnode.com'],
  cloudflare: ['cloudflare.com', 'dash.cloudflare.com'],
  heroku: ['heroku.com', 'id.heroku.com'],
  vercel: ['vercel.com'],
  netlify: ['netlify.com', 'app.netlify.com'],
  stripe: ['stripe.com', 'dashboard.stripe.com', 'connect.stripe.com'],
  paypal: ['paypal.com'],
  wise: ['wise.com', 'transferwise.com'],
  revolut: ['revolut.com'],
  coinbase: ['coinbase.com'],
  kraken: ['kraken.com'],
  binance: ['binance.com'],
  dropbox: ['dropbox.com'],
  box: ['box.com'],
  facebook: ['facebook.com', 'meta.com', 'business.facebook.com'],
  meta: ['facebook.com', 'meta.com'],
  instagram: ['instagram.com'],
  whatsapp: ['whatsapp.com'],
  twitter: ['twitter.com', 'x.com'],
  x: ['x.com', 'twitter.com'],
  linkedin: ['linkedin.com'],
  reddit: ['reddit.com'],
  discord: ['discord.com', 'discordapp.com'],
  slack: ['slack.com'],
  zoom: ['zoom.us'],
  twitch: ['twitch.tv'],
  steam: ['steampowered.com', 'steamcommunity.com'],
  'epic games': ['epicgames.com'],
  ubisoft: ['ubisoft.com', 'ubi.com', 'account.ubisoft.com'],
  'battle.net': ['battle.net', 'blizzard.com'],
  nintendo: ['nintendo.com'],
  playstation: ['playstation.com', 'sonyentertainmentnetwork.com'],
  uber: ['uber.com', 'ubereats.com'],
  lyft: ['lyft.com'],
  airbnb: ['airbnb.com'],
  booking: ['booking.com'],
  ebay: ['ebay.com'],
  etsy: ['etsy.com'],
  shopify: ['shopify.com', 'myshopify.com'],
  squarespace: ['squarespace.com'],
  wordpress: ['wordpress.com', 'wordpress.org'],
  namecheap: ['namecheap.com'],
  godaddy: ['godaddy.com'],
  'name.com': ['name.com'],
  gandi: ['gandi.net'],
  mailchimp: ['mailchimp.com', 'login.mailchimp.com'],
  sendgrid: ['sendgrid.com', 'app.sendgrid.com'],
  twilio: ['twilio.com'],
  okta: ['okta.com'],
  auth0: ['auth0.com', 'manage.auth0.com'],
  salesforce: ['salesforce.com', 'force.com'],
  hubspot: ['hubspot.com'],
  zendesk: ['zendesk.com'],
  notion: ['notion.so', 'notion.com'],
  figma: ['figma.com'],
  linear: ['linear.app'],
  asana: ['asana.com'],
  trello: ['trello.com'],
  '1password': ['1password.com'],
  bitwarden: ['bitwarden.com', 'vault.bitwarden.com'],
  lastpass: ['lastpass.com'],
  proton: ['proton.me', 'protonmail.com', 'account.proton.me'],
  protonmail: ['proton.me', 'protonmail.com'],
  fastmail: ['fastmail.com'],
  zoho: ['zoho.com', 'accounts.zoho.com'],
  npm: ['npmjs.com'],
  docker: ['docker.com', 'hub.docker.com'],
  elastic: ['elastic.co', 'cloud.elastic.co'],
  mongodb: ['mongodb.com', 'cloud.mongodb.com'],
  datadog: ['datadoghq.com'],
  sentry: ['sentry.io'],
  plex: ['plex.tv'],
  synology: ['synology.com'],
  nordvpn: ['nordvpn.com'],
  netflix: ['netflix.com'],
  spotify: ['spotify.com'],
  robinhood: ['robinhood.com'],
  chase: ['chase.com'],
};

export function hostFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Approximate eTLD+1: "dashboard.stripe.com" -> "stripe.com". */
export function registrableDomain(host) {
  const parts = String(host).toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

const normalise = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const looksLikeHost = (value) =>
  /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(String(value || '').trim());

/** Best-effort domain list for a freshly imported account. */
export function deriveDomains({ issuer = '', account = '' }) {
  const domains = new Set();
  const trimmed = issuer.trim();

  if (looksLikeHost(trimmed)) domains.add(trimmed.toLowerCase().replace(/^www\./, ''));

  const known = KNOWN_ISSUERS[trimmed.toLowerCase()] || KNOWN_ISSUERS[normalise(trimmed)];
  if (known) known.forEach((domain) => domains.add(domain));

  // Sometimes the service only shows up in the account half.
  if (!domains.size && looksLikeHost(account.trim())) {
    domains.add(account.trim().toLowerCase());
  }

  return [...domains];
}

/**
 * Score how well an account matches a hostname. 0 means "no reason to think so".
 * Higher is a stronger claim; anything at or above MATCH_THRESHOLD gets offered.
 */
export const MATCH_THRESHOLD = 35;

export function scoreAccount(account, host) {
  if (!host) return 0;
  const registrable = registrableDomain(host);
  let best = 0;

  for (const raw of account.domains || []) {
    const domain = String(raw).toLowerCase().replace(/^www\./, '').trim();
    if (!domain) continue;
    if (domain === host) best = Math.max(best, 100);
    else if (host.endsWith(`.${domain}`)) best = Math.max(best, 95);
    else if (registrableDomain(domain) === registrable) best = Math.max(best, 90);
  }
  if (best) return best;

  // An account that has a domain list is authoritative: if none of its domains
  // matched, this is not its site. Without this, a lookalike host like
  // "githubb.com" would collect a real GitHub code from the name heuristics below.
  if ((account.domains || []).length) return 0;

  const issuer = account.issuer || '';
  if (looksLikeHost(issuer)) {
    const asHost = issuer.toLowerCase().replace(/^www\./, '');
    if (asHost === host || host.endsWith(`.${asHost}`)) return 70;
    if (registrableDomain(asHost) === registrable) return 68;
  }

  const known = KNOWN_ISSUERS[issuer.toLowerCase()] || KNOWN_ISSUERS[normalise(issuer)];
  if (known && known.some((domain) => registrableDomain(domain) === registrable)) return 60;

  // Last resort for accounts with no domain set: the issuer has to *be* the
  // site's name. Substring matching is deliberately not used here — "github"
  // inside "githubb" is exactly the case an attacker would arrange.
  const label = registrable.split('.')[0];
  const issuerKey = normalise(issuer);
  if (issuerKey && label && issuerKey === label) return 45;

  return 0;
}

/** Accounts that plausibly belong to `host`, strongest first. */
export function matchAccounts(accounts, host) {
  return accounts
    .map((account) => ({ account, score: scoreAccount(account, host) }))
    .filter((entry) => entry.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score || displayName(a.account).localeCompare(displayName(b.account)));
}

export function displayName(account) {
  if (account.issuer && account.account) return `${account.issuer} — ${account.account}`;
  return account.issuer || account.account || 'Unnamed account';
}

export { KNOWN_ISSUERS };
