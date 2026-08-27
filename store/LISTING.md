# Chrome Web Store listing

Everything the dashboard asks for, ready to paste. Field names match the
Developer Dashboard as of August 2026.

Assets live beside this file:

| Asset | Where |
|---|---|
| Upload package | `dist/sesame-2fa-autofill-v1.0.0.zip` (rebuild with `npm run package`) |
| Screenshots, 1280×800 | `store/1-popup.png` … `store/5-chip.png` |
| Store icon, 128×128 | `icons/icon128.png` |
| Small promo tile, 440×280 | `store/promo-440x280.png` |
| Marquee promo tile, 1400×560 | `store/promo-1400x560.png` |
| Privacy policy | <https://joseserro.github.io/sesame-2fa-autofill/privacy.html> |

---

## Store listing tab

**Title** (max 75 characters)

```
Sesame — 2FA Autofill
```

**Summary** (max 132 characters — must match `manifest.description`)

```
Store 2FA secrets and fill one-time codes with a right click. Imports directly from Google Authenticator exports.
```

**Category**

```
Workflow & Planning
```

Runner-up: *Privacy & Security*. Pick one and leave it alone — changing category
resets some review state.

**Language**

```
English (United States)
```

**Description** (max 16,000 characters)

```
Sesame fills your two-factor codes for you.

Right-click any verification box and choose "Use OTP code". The submenu lists only the codes saved for the site you are on — pick one and it goes straight in.


BRING YOUR CODES OVER

Already using Google Authenticator? Open it, go to Transfer accounts → Export accounts, and paste the text it encodes into Sesame's import screen. Or drop the QR screenshots straight in. Everything is parsed on your own machine.

You get a preview of what was found, with codes you already have marked as duplicates, before anything is saved.

Setup keys from sites that show you a string instead of a QR code work too, as do otpauth:// URIs from other authenticator apps.


FOUR WAYS TO FILL

• Right-click → Use OTP code
• A chip that appears when you click into a 2FA box, with the code ready to fill
• Alt+Shift+O to fill the best match from the keyboard
• The toolbar popup, with every code and a live countdown — click one to copy

Filling handles ordinary text boxes, contenteditable fields, and the split six-little-boxes widgets that defeat most autofill.


CODES GO WHERE THEY BELONG

Every account carries a list of the sites it may be used on, filled in on import and editable at any time.

If an account has domains, only those domains match it. A saved GitHub code is offered on github.com and its subdomains — never on githubb.com, github-login.com, or github.com.evil.example. Resemblance to a site's name is never enough to pull a code onto it.

Several logins on one site? All of them are offered, so you can pick the right one.


NOTHING LEAVES YOUR BROWSER

Sesame makes no network requests at all. No account, no sync service, no analytics, no telemetry, no third-party code. Codes are computed locally with the browser's own WebCrypto.

Add a passphrase and your secrets are encrypted with AES-256-GCM behind a PBKDF2-derived key. You enter it once per browser session, not once per use. Optional auto-lock after 5, 15 or 60 minutes.


YOUR DATA STAYS YOURS

Export whenever you like: back to Google Authenticator format, as otpauth:// URIs, or as a JSON backup you can restore from.

Source code: https://github.com/joseserro/sesame-2fa-autofill
```

**Homepage URL**

```
https://joseserro.github.io/sesame-2fa-autofill/
```

**Support URL**

```
https://github.com/joseserro/sesame-2fa-autofill/issues
```

### Screenshots, in this order

1. `store/2-right-click.png` — the right-click flow. **Put this first**; it is the
   one thing that distinguishes Sesame from every other authenticator listing.
2. `store/1-popup.png` — the popup with live codes
3. `store/3-import.png` — the Google Authenticator import, duplicates flagged
4. `store/4-codes.png` — accounts and their domains
5. `store/5-chip.png` — the suggestion chip

---

## Privacy tab

**Single purpose**

```
Sesame stores the user's own two-factor authentication secrets (TOTP and HOTP)
and generates the resulting one-time codes, filling them into the sign-in page
the user is on. Every feature serves that single purpose: importing secrets,
the right-click menu, the suggestion chip, the toolbar popup, and export.
```

**Permission justifications**

| Field | Text to paste |
|---|---|
| `storage` | Stores the user's own 2FA secrets and their settings in the browser profile. This is the extension's entire data model. Nothing is transmitted anywhere. |
| `contextMenus` | Adds the "Use OTP code" entry to the right-click menu, which is the extension's primary way of filling a code. |
| `scripting` | Inserts a generated code into the field the user asked for, and injects the content script into tabs that were already open when the extension was installed or updated. |
| `alarms` | Runs the optional auto-lock timer that re-locks the passphrase-protected vault after a period of inactivity. |
| `clipboardWrite` | Copies a code to the clipboard when the user clicks it in the popup, or when the "also copy the code" setting is enabled. |
| Host permission (`<all_urls>`) | Two-factor prompts can appear on any website, so the site cannot be known in advance. The extension reads only the hostname of the active tab, in order to work out which of the user's saved codes belongs to it, and writes to a page only when the user explicitly asks for a code to be filled. Page content is never read, stored, or transmitted. |

**Are you using remote code?**

```
No, I am not using remote code
```

All code is in the package. No `<script src>` to a remote host, no `eval`, no
modules fetched at runtime, no third-party libraries.

**What user data do you plan to collect?**

Select **nothing**. The store defines collection as *transmitting data off the
user's device*, and Sesame makes no network requests whatsoever. The 2FA secrets
never leave `chrome.storage.local` on the user's own machine.

> Reviewers cross-check this against behaviour. It holds here because there is
> no network code in the extension at all — searching the package for `fetch`,
> `XMLHttpRequest`, or `WebSocket` returns nothing.

**Certifications** — all three are true, tick all three:

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**

```
https://joseserro.github.io/sesame-2fa-autofill/privacy.html
```

---

## Distribution tab

**Visibility** — start with **Unlisted**.

Same review, but the listing does not compete in a category full of established
authenticators, and you still get install-by-link on every machine, Chrome Sync,
and silent auto-updates. Switch to Public later; nothing in the package changes.

**Regions** — all.

---

## Before you submit

- [ ] `npm test` passes (60 tests)
- [ ] `npm run package` run **after** the last source change — the zip is a build
      artifact and goes stale silently
- [ ] The uploaded zip does not contain `otp_2fa_codes.txt`; the packager refuses
      to build if it would, but confirm the file list it prints
- [ ] 2-Step Verification is enabled on the publishing Google account (mandatory)
- [ ] $5 developer registration paid
- [ ] Privacy policy URL resolves

Expect a slow first review. Broad host permissions get deeper scrutiny — think
weeks, not days, and do not plan anything around the first submission date.
