# Privacy Policy

**Last updated: 27 August 2026**

This policy covers the browser extension described in this repository ("the
extension").

## The short version

The extension collects nothing, transmits nothing, and contacts no server. It
has no analytics, no telemetry, no crash reporting, and no accounts. Everything
it stores stays in your own browser profile.

## What the extension stores

To generate two-factor authentication codes, the extension stores, **on your
device only**:

- **Your 2FA secret keys**, and the issuer, account label, and site domains that
  go with them
- **Your settings** — whether to show the suggestion chip, whether to submit
  forms automatically, the auto-lock interval

These are held in `chrome.storage.local`, which is part of your Chrome profile
on your own computer.

If you turn on a passphrase (Settings → Security), the secrets are encrypted
with AES-256-GCM using a key derived from your passphrase via PBKDF2-SHA256
(600,000 iterations). The passphrase itself is never stored — not in plain text,
not as a hash. While the vault is unlocked, the derived key is held in
`chrome.storage.session`, which lives in memory only and is discarded when Chrome
closes.

If you have Chrome Sync enabled for extensions, note that the extension does
**not** use `chrome.storage.sync`, so your secrets are not synchronised between
devices by the extension.

## What the extension does not do

- It makes **no network requests of any kind**. Codes are computed locally with
  the browser's built-in WebCrypto API.
- It does **not** collect, transmit, sell, rent, or share any personal data.
- It does **not** track your browsing, record the pages you visit, or log the
  sites you use codes on.
- It contains no third-party libraries, no remote code, and no advertising or
  analytics SDKs.

## Why it asks for the permissions it does

| Permission | Why |
|---|---|
| `storage` | To keep your codes and settings in your browser profile. |
| `contextMenus` | To put "Use OTP code" in the right-click menu. |
| `scripting` | To insert a code into the page when you ask for one, and to reach pages that were already open when the extension was installed. |
| `alarms` | To run the auto-lock timer. |
| `clipboardWrite` | To copy a code when you click one, or when "also copy" is enabled. |
| Access to all websites | 2FA prompts can appear on any site. The extension reads the address of the active tab only to work out which of your saved codes belongs to it, and only writes to a page when you explicitly ask it to fill a code. Page contents are never read, stored, or sent anywhere. |

## Reading the address of the active tab

To show the right codes for the site you are on, the extension looks at the
hostname of the active tab (for example `github.com`) and compares it against the
domains saved on your accounts. This happens entirely inside your browser. The
address is not stored, logged, or transmitted.

## Data retention and deletion

Your data stays until you delete it. Removing an account deletes it immediately.
**Settings → Security → Delete all data** erases everything the extension holds.
Uninstalling the extension removes its storage along with it.

There is nothing to delete on any server, because nothing is ever sent to one.

## Children

The extension is a general-purpose security tool and is not directed at
children.

## Changes

If this policy changes, the date at the top will change with it, and the updated
policy will be published at the same address.

## Contact

Questions about this policy: please [open an issue on GitHub](https://github.com/joseserro/sesame-2fa-autofill/issues).

Published at <https://joseserro.github.io/sesame-2fa-autofill/privacy.html>
