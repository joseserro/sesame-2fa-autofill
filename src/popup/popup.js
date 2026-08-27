import { generateCode, secondsRemaining, formatCode } from '../lib/totp.js';
import { hostFromUrl, scoreAccount, MATCH_THRESHOLD, displayName } from '../lib/match.js';
import * as vault from '../lib/vault.js';

const $ = (selector) => document.querySelector(selector);

const state = {
  accounts: [],
  host: '',
  tabId: null,
  query: '',
  ticker: null,
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
  toast.timer = setTimeout(() => el.classList.remove('show'), 1800);
}

// ---------------------------------------------------------------- boot

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab?.id ?? null;
  state.host = hostFromUrl(tab?.url || '');

  if (!(await vault.isUnlocked())) return showLock();
  await showMain();
}

function showLock() {
  $('#lock-screen').hidden = false;
  $('#main').hidden = true;
  $('#passphrase').focus();
}

async function showMain() {
  $('#lock-screen').hidden = true;
  $('#main').hidden = false;
  $('#lock-btn').hidden = !(await vault.isEncrypted());

  if (state.host) {
    $('#site-bar').hidden = false;
    $('#site-host').textContent = state.host;
  }

  state.accounts = await vault.loadAccounts();
  render();

  if (state.ticker) clearInterval(state.ticker);
  state.ticker = setInterval(tick, 1000);
}

$('#unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#unlock-error');
  error.hidden = true;
  const button = event.target.querySelector('button');
  button.disabled = true;
  button.textContent = 'Unlocking…';
  try {
    await vault.unlock($('#passphrase').value);
    await showMain();
    chrome.runtime.sendMessage({ type: 'otp:rebuildMenus' }).catch(() => {});
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    $('#passphrase').select();
  } finally {
    button.disabled = false;
    button.textContent = 'Unlock';
  }
});

$('#lock-btn').addEventListener('click', async () => {
  await vault.lock();
  clearInterval(state.ticker);
  showLock();
  chrome.runtime.sendMessage({ type: 'otp:rebuildMenus' }).catch(() => {});
});

$('#options-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#add-btn').addEventListener('click', () => openOptions('#add'));
$('#import-btn').addEventListener('click', () => openOptions('#import'));

function openOptions(hash) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/options/options.html${hash}`) });
  window.close();
}

$('#search').addEventListener('input', (event) => {
  state.query = event.target.value.trim().toLowerCase();
  render();
});

// ---------------------------------------------------------------- rendering

function visibleAccounts() {
  const scored = state.accounts.map((account) => ({
    account,
    score: scoreAccount(account, state.host),
  }));

  const filtered = state.query
    ? scored.filter(({ account }) =>
        `${account.issuer} ${account.account}`.toLowerCase().includes(state.query))
    : scored;

  const matched = filtered.filter((entry) => entry.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  const rest = filtered.filter((entry) => entry.score < MATCH_THRESHOLD)
    .sort((a, b) => (b.account.useCount || 0) - (a.account.useCount || 0)
      || displayName(a.account).localeCompare(displayName(b.account)));

  return { matched, rest };
}

function render() {
  const list = $('#list');
  const { matched, rest } = visibleAccounts();
  list.innerHTML = '';

  if (!state.accounts.length) {
    list.innerHTML = `<div class="row-empty">
      <p>No codes yet.</p>
      <button class="primary" id="empty-import">Import from Google Authenticator</button>
    </div>`;
    $('#empty-import').addEventListener('click', () => openOptions('#import'));
    return;
  }

  if (!matched.length && !rest.length) {
    list.innerHTML = '<div class="row-empty">Nothing matches that search.</div>';
    return;
  }

  if (matched.length) {
    list.append(groupLabel(`FOR ${state.host.toUpperCase()}`));
    for (const { account } of matched) list.append(accountRow(account, true));
  }
  if (rest.length) {
    if (matched.length) list.append(groupLabel('ALL CODES'));
    for (const { account } of rest) list.append(accountRow(account, false));
  }
  tick();
}

function groupLabel(text) {
  const el = document.createElement('div');
  el.className = 'group-label';
  el.textContent = text;
  return el;
}

function accountRow(account, matched) {
  const row = document.createElement('div');
  row.className = `account${matched ? ' matched' : ''}`;
  row.dataset.id = account.id;
  row.innerHTML = `
    <span class="mark"></span>
    <span class="info">
      <div class="issuer"></div>
      <div class="sub"></div>
    </span>
    <span class="code">••• •••</span>
    <svg class="ring" viewBox="0 0 20 20" aria-hidden="true">
      <circle class="track" cx="10" cy="10" r="8"></circle>
      <circle class="value" cx="10" cy="10" r="8" stroke-dasharray="50.27" stroke-dashoffset="0"></circle>
    </svg>
    <button class="fill-btn" title="Fill this code into the page">Fill</button>`;

  const mark = row.querySelector('.mark');
  mark.textContent = initials(account.issuer || account.account);
  mark.style.background = colorFor(displayName(account));
  row.querySelector('.issuer').textContent = account.issuer || account.account || 'Unnamed';
  row.querySelector('.sub').textContent = account.issuer ? account.account : '';

  row.addEventListener('click', (event) => {
    if (event.target.closest('.fill-btn')) return;
    copyCode(account, row);
  });
  row.querySelector('.fill-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    fillIntoPage(account);
  });

  return row;
}

/** One pass over the visible rows, refreshing codes and countdown rings. */
async function tick() {
  const now = Date.now();
  const rows = [...document.querySelectorAll('.account')];

  await Promise.all(rows.map(async (row) => {
    const account = state.accounts.find((a) => a.id === row.dataset.id);
    if (!account) return;

    const codeEl = row.querySelector('.code');
    try {
      codeEl.textContent = formatCode(await generateCode(account, now));
      codeEl.classList.remove('stale');
    } catch {
      codeEl.textContent = 'error';
      codeEl.classList.add('stale');
      return;
    }

    const ring = row.querySelector('.ring');
    if (account.type === 'hotp') {
      ring.style.visibility = 'hidden';
      return;
    }
    const period = account.period || 30;
    const left = secondsRemaining(account, now);
    const circumference = 2 * Math.PI * 8;
    ring.querySelector('.value').style.strokeDashoffset = String(circumference * (1 - left / period));
    ring.classList.toggle('warn', left <= 5);
  }));
}

// ---------------------------------------------------------------- actions

async function copyCode(account, row) {
  const code = await generateCode(account);
  try {
    await navigator.clipboard.writeText(code);
    toast(`Copied ${formatCode(code)}`);
  } catch {
    toast('Could not copy', 'error');
    return;
  }
  await vault.recordUse(account.id);
  if (account.type === 'hotp') {
    state.accounts = await vault.loadAccounts();
    tick();
  }
  row.animate([{ background: 'var(--accent-soft)' }, {}], { duration: 400 });
}

async function fillIntoPage(account) {
  if (state.tabId == null) return toast('No page to fill', 'error');
  const response = await chrome.runtime.sendMessage({
    type: 'otp:fillTab',
    tabId: state.tabId,
    id: account.id,
  });
  if (response?.ok) window.close();
  else toast(response?.error || 'Could not fill', 'error');
}

init().catch((err) => {
  document.body.innerHTML = `<div class="row-empty">Something went wrong: ${err.message}</div>`;
});
