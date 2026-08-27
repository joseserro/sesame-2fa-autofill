# Sesame

A Chrome extension that stores your 2FA secrets and types the codes for you.
Right-click a verification box, pick **Use OTP code**, and the code for *that
site* goes in.

Imports straight from a Google Authenticator export.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder

The settings page opens on first install.

## Getting your codes in

In Google Authenticator: **⋮ → Transfer accounts → Export accounts**. It shows
one or more QR codes.

On the extension's **Import** screen you can:

- paste the `otpauth-migration://…` text (one line per QR code)
- drop in `.txt` file(s) containing it
- drop in or paste **screenshots of the QR codes** — decoded locally, on Chrome
  builds that ship the `BarcodeDetector` API (mainly macOS, Android and ChromeOS;
  on Windows and Linux use the text route)

Everything is parsed in the browser. Nothing is ever sent anywhere.

You get a preview of what was found, with anything you already have marked as a
duplicate, before anything is saved.

Single accounts can also be added by hand from a setup key, and plain
`otpauth://` URIs from other authenticator apps import too.

## Using it

**Right-click → Use OTP code.** The submenu lists only the codes that belong to
the site you are on. With six Stripe logins saved, you get all six on
`stripe.com` and none of them anywhere else.

Also available:

- **The suggestion chip** — click into a 2FA box and a small chip appears with
  the code. Click it to fill.
- **`Alt+Shift+O`** — fills the best match without touching the mouse. Change it
  at `chrome://extensions/shortcuts`.
- **The toolbar popup** — every code with a live countdown. Click one to copy,
  or press *Fill* to put it in the page. Codes for the current site sort to the top.
- **Search all codes…** — in the right-click menu, for the times the site match
  is wrong or missing.

Filling handles ordinary text boxes, `contenteditable` fields, and the split
six-little-boxes widgets, and it fires the events React and similar frameworks
need in order to notice.

## How a code gets matched to a site

Each account has a **domain list**, shown and editable on every account in
settings. On import it is filled in from the issuer — either because the issuer
is already a hostname (`auth.elastic.co`), or from a built-in table of about a
hundred well-known services (`GitHub` → `github.com`).

The rule that matters: **if an account has domains, only those domains match it.**
A saved GitHub code is offered on `github.com` and its subdomains, and not on
`githubb.com`, `github-login.com`, or `github.com.evil.example`. Name similarity
is never enough to pull a code onto a site.

Accounts with an empty domain list fall back to matching the issuer against the
site's name exactly. If a site is not matching, add its domain to the account.

## Security

Secrets live in `chrome.storage.local`, which is on disk and unencrypted by
default — the same place other extensions keep their data, readable by anyone
with access to your Chrome profile.

**Settings → Security** adds a passphrase: PBKDF2-SHA256 (600k iterations) to
derive a key, AES-256-GCM to encrypt the vault. While unlocked, the key sits in
`chrome.storage.session`, which never touches disk and is wiped when Chrome
closes, so you type the passphrase once per session rather than once per use.
Optional auto-lock after 5/15/60 minutes.

There is no recovery for a forgotten passphrase. Export a backup first.

Other things worth knowing:

- The picker overlay in the page only ever receives account *names*. The code
  itself is generated and handed over when you pick one.
- Auto-submit is off by default.
- No network access at all — the extension makes no requests, and codes are
  computed locally with WebCrypto.

## Backups

**Settings → Export** produces:

- **Google Authenticator format** — the same batched `otpauth-migration://` URIs,
  so the data can go back into another authenticator that reads them
- **`otpauth://` list** — one URI per account
- **JSON backup** — restorable from the same screen

These files hold your secrets in plain text. Treat them like passwords.

## Development

```bash
npm install     # jsdom, for the fill tests
npm test
```

60 tests covering: RFC 6238/4226 vectors, base32, the Google Authenticator
protobuf (decode and re-encode), site matching including lookalike-domain
rejection, the vault's locking and dedupe rules, the content script's field
detection driven through jsdom, and the page cascade (author `display` rules
silently beat the `hidden` attribute, which is how the lock screen once
rendered over the settings page).

Tests read `tests/fixtures/example-export.txt`, a synthetic export that
reproduces the awkward label shapes real exports contain -- empty issuer fields,
bare service names, parenthesised labels, non-ASCII -- with no real accounts in
it. Regenerate it with `node scripts/make-fixture.mjs`.

Because that fixture is produced by this project's own encoder, one test checks
the decoder against genuine Google bytes instead. It looks for
`otp_2fa_codes.txt` in the repo root, or whatever `OTP_EXPORT_FILE` points at,
and skips when neither is present:

```bash
OTP_EXPORT_FILE=~/my-export.txt npm test
```

Keep real exports out of version control; `.gitignore` already excludes them.

```
manifest.json
src/
  background.js      service worker: context menus, code delivery, auto-lock
  content.js         field detection, insertion, picker/chip/toast UI
  lib/
    base32.js        RFC 4648
    totp.js          TOTP/HOTP over WebCrypto
    protobuf.js      minimal reader/writer
    migration.js     otpauth-migration:// decode + encode
    otpauth.js       otpauth:// URIs and issuer/account label heuristics
    match.js         site matching and the known-issuer table
    crypto.js        PBKDF2 + AES-GCM
    vault.js         storage, locking, account CRUD
  popup/             toolbar popup
  options/           settings, import, export
scripts/
  package.mjs        builds the Web Store zip
  screenshots.mjs    renders the store images from the real UI
  make-fixture.mjs   regenerates the test export
docs/                the GitHub Pages site
PRIVACY.md           privacy policy for the store listing
```

## Packaging

```bash
npm run package     # -> dist/sesame-2fa-autofill-v1.0.0.zip
```

The packager works from an allowlist, not an ignore list, because the project
root may hold a real authenticator export. It refuses to build if anything
matching a secrets pattern would be included, or if the manifest points at a
file that is not in the bundle.
