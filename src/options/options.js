import { generateCode, secondsRemaining, formatCode } from '../lib/totp.js';
import { decodeMigrationUri, encodeMigrationUris, extractUris } from '../lib/migration.js';
import { parseOtpauthUri, buildOtpauthUri } from '../lib/otpauth.js';
import { deriveDomains, displayName } from '../lib/match.js';
import { isValidBase32 } from '../lib/base32.js';
import * as vault from '../lib/vault.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  accounts: [],
  filter: '',
  pending: [],      // parsed-but-not-yet-imported entries
  existingKeys: new Set(),
};

const PALETTE = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#0284c7'];

function colorFor(text) {
  let hash = 0;
  for (const ch of String(text)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

const initials = (text) => String(text || '?').trim().slice(0, 2).toUpperCase();

function toast(message, tone = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${tone === 'error' ? 'error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------- boot

async function init() {
  if (!(await vault.isUnlocked())) {
    $('#lock-gate').hidden = false;
    $('#passphrase').focus();
    return;
  }
  $('#lock-gate').hidden = true;
  $('#page').hidden = false;

  if (location.hash === '#welcome') $('#welcome-banner').hidden = false;

  await refreshAccounts();
  await loadSettings();
  setupQrSupport();
  setInterval(tickCodes, 1000);

  if (location.hash && location.hash !== '#welcome') {
    document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth' });
  }
}

$('#unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#unlock-error');
  error.hidden = true;
  try {
    await vault.unlock($('#passphrase').value);
    location.reload();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

async function refreshAccounts() {
  state.accounts = await vault.loadAccounts();
  state.existingKeys = new Set(state.accounts.map(vault.accountKey));
  $('#nav-count').textContent = state.accounts.length || '';
  renderAccounts();
}

// ---------------------------------------------------------------- nav

$$('[data-nav]').forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    const target = document.querySelector(link.getAttribute('href'));
    target?.scrollIntoView({ behavior: 'smooth' });
    history.replaceState(null, '', link.getAttribute('href'));
  });
});

$$('[data-goto]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelector(button.dataset.goto)?.scrollIntoView({ behavior: 'smooth' });
  });
});

const navObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    $$('[data-nav]').forEach((link) =>
      link.classList.toggle('active', link.getAttribute('href') === `#${entry.target.id}`));
  }
}, { rootMargin: '-10% 0px -70% 0px' });

// ---------------------------------------------------------------- accounts

$('#account-search').addEventListener('input', (event) => {
  state.filter = event.target.value.trim().toLowerCase();
  renderAccounts();
});

function renderAccounts() {
  const list = $('#account-list');
  const visible = state.filter
    ? state.accounts.filter((a) => `${a.issuer} ${a.account} ${a.domains.join(' ')}`.toLowerCase().includes(state.filter))
    : state.accounts;

  if (!state.accounts.length) {
    list.innerHTML = '<div class="row-empty">No codes yet — import them below.</div>';
    return;
  }
  if (!visible.length) {
    list.innerHTML = '<div class="row-empty">Nothing matches that filter.</div>';
    return;
  }

  list.innerHTML = '';
  for (const account of visible) list.append(accountCard(account));
  tickCodes();
}

function accountCard(account) {
  const card = document.createElement('div');
  card.className = 'acct';
  card.dataset.id = account.id;
  card.draggable = !state.filter; // reordering only makes sense on the full list

  const domains = account.domains.length
    ? account.domains.map((d) => `<span class="domain">${escapeHtml(d)}</span>`).join('')
    : '<span class="domain none">no site set</span>';

  card.innerHTML = `
    <div class="acct-head">
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <span class="mark"></span>
      <span class="info">
        <div class="issuer"></div>
        <div class="sub"></div>
        <div class="domains">${domains}</div>
      </span>
      <span class="live">••••••</span>
      <span class="chev">›</span>
    </div>
    <div class="acct-body">
      <div class="grid-2">
        <div><label>Service</label><input type="text" data-field="issuer"></div>
        <div><label>Account</label><input type="text" data-field="account"></div>
      </div>
      <label>Sites this code belongs to (comma separated)</label>
      <input type="text" data-field="domains" spellcheck="false" placeholder="example.com, login.example.com">
      <label>Secret key</label>
      <div class="secret-row">
        <input type="password" data-field="secret" spellcheck="false">
        <button class="ghost" data-action="reveal">Show</button>
      </div>
      <div class="grid-4">
        <div><label>Type</label>
          <select data-field="type"><option value="totp">Time (TOTP)</option><option value="hotp">Counter (HOTP)</option></select></div>
        <div><label>Algorithm</label>
          <select data-field="algorithm"><option>SHA1</option><option>SHA256</option><option>SHA512</option></select></div>
        <div><label>Digits</label><input type="number" data-field="digits" min="4" max="10"></div>
        <div><label data-period-label>Period (s)</label><input type="number" data-field="period" min="5" max="300"></div>
      </div>
      <div class="actions">
        <button class="primary" data-action="save">Save changes</button>
        <button class="ghost" data-action="copy-uri">Copy otpauth:// URI</button>
        <span style="flex:1"></span>
        <button class="danger" data-action="delete">Delete</button>
      </div>
    </div>`;

  const mark = card.querySelector('.mark');
  mark.className = 'mark';
  mark.textContent = initials(account.issuer || account.account);
  mark.style.background = colorFor(displayName(account));
  card.querySelector('.issuer').textContent = account.issuer || account.account || 'Unnamed';
  card.querySelector('.sub').textContent = account.issuer ? account.account : '';

  const field = (name) => card.querySelector(`[data-field="${name}"]`);
  field('issuer').value = account.issuer;
  field('account').value = account.account;
  field('domains').value = account.domains.join(', ');
  field('secret').value = account.secret;
  field('type').value = account.type;
  field('algorithm').value = account.algorithm;
  field('digits').value = account.digits;
  field('period').value = account.type === 'hotp' ? account.counter : account.period;
  card.querySelector('[data-period-label]').textContent = account.type === 'hotp' ? 'Counter' : 'Period (s)';

  field('type').addEventListener('change', () => {
    const isHotp = field('type').value === 'hotp';
    card.querySelector('[data-period-label]').textContent = isHotp ? 'Counter' : 'Period (s)';
    field('period').value = isHotp ? 0 : 30;
  });

  card.querySelector('.acct-head').addEventListener('click', (event) => {
    if (event.target.closest('.drag-handle')) return;
    card.classList.toggle('open');
  });

  card.querySelector('[data-action=reveal]').addEventListener('click', () => {
    const input = field('secret');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    card.querySelector('[data-action=reveal]').textContent = hidden ? 'Hide' : 'Show';
  });

  card.querySelector('[data-action=save]').addEventListener('click', async () => {
    const secret = field('secret').value.trim().toUpperCase().replace(/[\s-]/g, '');
    if (!isValidBase32(secret)) return toast('That secret key is not valid base32', 'error');

    const isHotp = field('type').value === 'hotp';
    try {
      await vault.updateAccount(account.id, {
        issuer: field('issuer').value,
        account: field('account').value,
        domains: field('domains').value.split(',').map((d) => d.trim()).filter(Boolean),
        secret,
        type: field('type').value,
        algorithm: field('algorithm').value,
        digits: Number(field('digits').value),
        period: isHotp ? 30 : Number(field('period').value),
        counter: isHotp ? Number(field('period').value) : 0,
      });
      await refreshAccounts();
      toast('Saved');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  card.querySelector('[data-action=copy-uri]').addEventListener('click', async () => {
    await navigator.clipboard.writeText(buildOtpauthUri(account));
    toast('URI copied — it contains your secret');
  });

  card.querySelector('[data-action=delete]').addEventListener('click', async () => {
    if (!confirm(`Delete the code for ${displayName(account)}?\n\nYou will lose access to this account unless you have another copy.`)) return;
    await vault.deleteAccount(account.id);
    await refreshAccounts();
    toast('Deleted');
  });

  attachDragHandlers(card);
  return card;
}

async function tickCodes() {
  const now = Date.now();
  for (const card of $$('.acct')) {
    const account = state.accounts.find((a) => a.id === card.dataset.id);
    const live = card.querySelector('.live');
    if (!account || !live) continue;
    try {
      const code = await generateCode(account, now);
      const left = account.type === 'hotp' ? '' : ` · ${secondsRemaining(account, now)}s`;
      live.textContent = formatCode(code) + left;
    } catch {
      live.textContent = 'bad secret';
    }
  }
}

// ---- drag to reorder ----------------------------------------------------

let dragId = null;

function attachDragHandlers(card) {
  card.addEventListener('dragstart', (event) => {
    dragId = card.dataset.id;
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    dragId = null;
    card.classList.remove('dragging');
    $$('.acct').forEach((el) => el.classList.remove('drop-target'));
  });
  card.addEventListener('dragover', (event) => {
    if (!dragId || dragId === card.dataset.id) return;
    event.preventDefault();
    card.classList.add('drop-target');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
  card.addEventListener('drop', async (event) => {
    event.preventDefault();
    card.classList.remove('drop-target');
    if (!dragId || dragId === card.dataset.id) return;

    const ids = state.accounts.map((a) => a.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(card.dataset.id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    await vault.reorderAccounts(ids);
    await refreshAccounts();
  });
}

// ---------------------------------------------------------------- import

function setupQrSupport() {
  const note = $('#qr-support');
  if ('BarcodeDetector' in window) {
    note.textContent = 'QR images are read on this device.';
  } else {
    note.textContent = 'This Chrome build cannot read QR images — paste the otpauth-migration:// text instead.';
  }
}

async function decodeQrImage(file) {
  if (!('BarcodeDetector' in window)) throw new Error('QR decoding is not available in this browser');
  const formats = await window.BarcodeDetector.getSupportedFormats();
  if (!formats.includes('qr_code')) throw new Error('QR decoding is not available in this browser');

  const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  const bitmap = await createImageBitmap(file);
  const codes = await detector.detect(bitmap);
  bitmap.close?.();
  if (!codes.length) throw new Error(`No QR code found in ${file.name}`);
  return codes.map((code) => code.rawValue).join('\n');
}

/** Turn pasted text into entries, reporting anything we could not read. */
function parseText(text) {
  const { migration, plain } = extractUris(text);
  const entries = [];
  const problems = [];

  for (const uri of migration) {
    try {
      const batch = decodeMigrationUri(uri);
      entries.push(...batch.accounts);
      if (batch.errors?.length) problems.push(`${batch.errors.length} entry/entries in one batch were unreadable`);
    } catch (err) {
      problems.push(err.message);
    }
  }
  for (const uri of plain) {
    try {
      entries.push(parseOtpauthUri(uri));
    } catch (err) {
      problems.push(err.message);
    }
  }
  return { entries, problems };
}

$('#browse-btn').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (event) => ingestFiles([...event.target.files]));

const dropZone = $('#drop-zone');
['dragenter', 'dragover'].forEach((type) =>
  dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.add('over');
  }));
['dragleave', 'drop'].forEach((type) =>
  dropZone.addEventListener(type, () => dropZone.classList.remove('over')));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  ingestFiles([...event.dataTransfer.files]);
});

document.addEventListener('paste', (event) => {
  const images = [...(event.clipboardData?.items || [])]
    .filter((item) => item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (images.length) {
    event.preventDefault();
    ingestFiles(images);
  }
});

async function ingestFiles(files) {
  if (!files.length) return;
  const status = $('#import-status');
  status.textContent = `Reading ${files.length} file(s)…`;
  const chunks = [];
  const problems = [];

  for (const file of files) {
    try {
      chunks.push(file.type.startsWith('image/') ? await decodeQrImage(file) : await file.text());
    } catch (err) {
      problems.push(err.message);
    }
  }

  const textarea = $('#import-text');
  textarea.value = [textarea.value.trim(), ...chunks].filter(Boolean).join('\n');
  status.textContent = problems.length ? problems.join(' · ') : '';
  if (chunks.length) showPreview();
}

$('#parse-btn').addEventListener('click', showPreview);

function showPreview() {
  const { entries, problems } = parseText($('#import-text').value);
  const status = $('#import-status');

  if (!entries.length) {
    $('#import-preview').hidden = true;
    status.textContent = problems.length
      ? `Nothing importable: ${problems[0]}`
      : 'No otpauth URIs found in that text.';
    return;
  }

  status.textContent = problems.length ? `${problems.length} item(s) skipped: ${problems[0]}` : '';
  state.pending = entries.map((entry) => ({
    ...entry,
    domains: deriveDomains(entry),
    duplicate: state.existingKeys.has(vault.accountKey(vault.normaliseAccount(entry))),
  }));

  $('#preview-count').textContent = String(state.pending.length);
  const list = $('#preview-list');
  list.innerHTML = '';

  state.pending.forEach((entry, index) => {
    const row = document.createElement('label');
    row.className = `pv${entry.duplicate ? ' dupe' : ''}`;
    row.innerHTML = `
      <input type="checkbox" data-index="${index}" ${entry.duplicate ? '' : 'checked'}>
      <span class="mark"></span>
      <span class="info">
        <div class="issuer"></div>
        <div class="sub"></div>
      </span>
      <span class="badge">${entry.duplicate ? 'ALREADY SAVED' : (entry.domains[0] || 'no site')}</span>`;
    const mark = row.querySelector('.mark');
    mark.textContent = initials(entry.issuer || entry.account);
    mark.style.background = colorFor(`${entry.issuer}${entry.account}`);
    row.querySelector('.issuer').textContent = entry.issuer || entry.account || 'Unnamed';
    row.querySelector('.sub').textContent = entry.issuer ? entry.account : '';
    list.append(row);
  });

  $('#import-preview').hidden = false;
  $('#import-preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#select-all').addEventListener('click', () =>
  $$('#preview-list input').forEach((box) => { box.checked = true; }));
$('#select-none').addEventListener('click', () =>
  $$('#preview-list input').forEach((box) => { box.checked = false; }));
$('#cancel-import').addEventListener('click', () => {
  $('#import-preview').hidden = true;
  state.pending = [];
});

$('#confirm-import').addEventListener('click', async () => {
  const chosen = $$('#preview-list input:checked').map((box) => state.pending[Number(box.dataset.index)]);
  if (!chosen.length) return toast('Nothing selected', 'error');

  const { added, skipped } = await vault.addAccounts(chosen);
  await refreshAccounts();
  $('#import-preview').hidden = true;
  $('#import-text').value = '';
  state.pending = [];
  toast(`Imported ${added} code${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} duplicate(s)` : ''}`);
  $('#accounts').scrollIntoView({ behavior: 'smooth' });
});

// ---------------------------------------------------------------- add manually

$('#add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const secret = $('#add-secret').value.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!isValidBase32(secret)) return toast('That secret key is not valid base32', 'error');

  const issuer = $('#add-issuer').value.trim();
  const account = $('#add-account').value.trim();
  const typed = $('#add-domains').value.split(',').map((d) => d.trim()).filter(Boolean);

  const { added } = await vault.addAccounts([{
    issuer,
    account,
    secret,
    domains: typed.length ? typed : deriveDomains({ issuer, account }),
    type: $('#add-type').value,
    algorithm: $('#add-algorithm').value,
    digits: Number($('#add-digits').value),
    period: Number($('#add-period').value),
  }]);

  if (!added) return toast('That code is already saved', 'error');
  event.target.reset();
  $('#add-digits').value = 6;
  $('#add-period').value = 30;
  await refreshAccounts();
  toast('Code added');
});

// ---------------------------------------------------------------- export

function showExport(text, filename) {
  const output = $('#export-output');
  output.value = text;
  output.hidden = false;
  $('#export-actions').hidden = false;
  $('#download-export').dataset.filename = filename;
}

$('#export-migration').addEventListener('click', () => {
  if (!state.accounts.length) return toast('Nothing to export', 'error');
  showExport(encodeMigrationUris(state.accounts).join('\n\n'), 'otp-migration.txt');
  toast('Each line is one Google Authenticator batch');
});

$('#export-otpauth').addEventListener('click', () => {
  if (!state.accounts.length) return toast('Nothing to export', 'error');
  showExport(state.accounts.map(buildOtpauthUri).join('\n'), 'otp-uris.txt');
});

$('#export-json').addEventListener('click', () => {
  if (!state.accounts.length) return toast('Nothing to export', 'error');
  showExport(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), accounts: state.accounts }, null, 2), 'otp-backup.json');
});

$('#copy-export').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#export-output').value);
  toast('Copied — this contains your secrets');
});

$('#download-export').addEventListener('click', () => {
  const blob = new Blob([$('#export-output').value], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = $('#download-export').dataset.filename || 'otp-export.txt';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('#hide-export').addEventListener('click', () => {
  $('#export-output').hidden = true;
  $('#export-output').value = '';
  $('#export-actions').hidden = true;
});

$('#import-json-btn').addEventListener('click', () => $('#json-input').click());
$('#json-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const incoming = Array.isArray(parsed) ? parsed : parsed.accounts;
    if (!Array.isArray(incoming)) throw new Error('No accounts array in that file');
    const { added, skipped } = await vault.addAccounts(incoming);
    await refreshAccounts();
    toast(`Restored ${added} code(s)${skipped ? `, skipped ${skipped} duplicate(s)` : ''}`);
  } catch (err) {
    toast(`Could not read that backup: ${err.message}`, 'error');
  }
  event.target.value = '';
});

// ---------------------------------------------------------------- security

async function loadSettings() {
  const settings = await vault.getSettings();
  $('#set-chip').checked = settings.showChip;
  $('#set-autosubmit').checked = settings.autoSubmit;
  $('#set-copy').checked = settings.copyOnFill;
  $('#auto-lock').value = String(settings.autoLockMinutes);

  const encrypted = await vault.isEncrypted();
  $('#enc-off').hidden = encrypted;
  $('#enc-on').hidden = !encrypted;
}

$('#enable-enc-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const pass = $('#new-pass').value;
  const confirmPass = $('#new-pass2').value;
  if (pass.length < 8) return toast('Use at least 8 characters', 'error');
  if (pass !== confirmPass) return toast('Passphrases do not match', 'error');
  if (!confirm('Encrypt the vault with this passphrase?\n\nThere is no way to recover it if you forget.')) return;

  await vault.enableEncryption(pass);
  event.target.reset();
  await loadSettings();
  toast('Vault encrypted');
});

$('#change-pass-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const next = $('#chg-pass').value;
  if (next.length < 8) return toast('Use at least 8 characters', 'error');
  if (next !== $('#chg-pass2').value) return toast('New passphrases do not match', 'error');
  try {
    await vault.changePassphrase($('#cur-pass').value, next);
    event.target.reset();
    toast('Passphrase changed');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#disable-enc').addEventListener('click', async () => {
  const pass = prompt('Enter your current passphrase to remove encryption:');
  if (!pass) return;
  try {
    await vault.disableEncryption(pass);
    location.reload();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#auto-lock').addEventListener('change', async (event) => {
  await vault.setSettings({ autoLockMinutes: Number(event.target.value) });
  toast('Saved');
});

$('#wipe-btn').addEventListener('click', async () => {
  if (!confirm('Delete every saved code and setting?\n\nThis cannot be undone.')) return;
  if (!confirm('Really delete everything? Export a backup first if you are unsure.')) return;
  await vault.wipe();
  location.reload();
});

// ---------------------------------------------------------------- behaviour

for (const [id, key] of [['#set-chip', 'showChip'], ['#set-autosubmit', 'autoSubmit'], ['#set-copy', 'copyOnFill']]) {
  $(id).addEventListener('change', async (event) => {
    await vault.setSettings({ [key]: event.target.checked });
    toast('Saved');
  });
}

$('#shortcut-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ---------------------------------------------------------------- misc

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

init()
  .then(() => $$('main section[id]').forEach((section) => navObserver.observe(section)))
  .catch((err) => toast(`Could not load: ${err.message}`, 'error'));
