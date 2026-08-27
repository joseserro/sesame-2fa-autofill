// Service worker: builds the right-click menu for whatever site you are on,
// generates codes, and hands them to the content script in the correct frame.

import { generateCode } from './lib/totp.js';
import { hostFromUrl, matchAccounts, displayName } from './lib/match.js';
import * as vault from './lib/vault.js';

const MENU_ROOT = 'otp-root';
const MENU_PICKER = 'otp-picker';
const MENU_STATUS = 'otp-status';
const MENU_FILL_PREFIX = 'otp-fill:';
const MAX_MENU_ITEMS = 12;

// ---------------------------------------------------------------- menu building

let rebuildTimer = null;
let rebuildChain = Promise.resolve();

function scheduleRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    // Rebuilds await storage in the middle; overlapping runs would try to
    // create menu items that already exist. Keep them strictly in sequence.
    rebuildChain = rebuildChain
      .then(rebuildMenus)
      .catch((err) => console.warn('[otp] menu rebuild failed', err));
  }, 120);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function rebuildMenus() {
  const tab = await activeTab();
  const host = tab ? hostFromUrl(tab.url) : '';

  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ROOT,
    title: 'Use OTP code',
    contexts: ['editable', 'page'],
  });

  if (await vault.isEncrypted() && !(await vault.isUnlocked())) {
    chrome.contextMenus.create({
      id: MENU_STATUS,
      parentId: MENU_ROOT,
      title: 'Locked — click the toolbar icon to unlock',
      enabled: false,
      contexts: ['editable', 'page'],
    });
    await setBadge(tab, '');
    return;
  }

  let matches = [];
  try {
    const accounts = await vault.loadAccounts();
    matches = matchAccounts(accounts, host);
  } catch {
    matches = [];
  }

  if (matches.length) {
    for (const { account } of matches.slice(0, MAX_MENU_ITEMS)) {
      chrome.contextMenus.create({
        id: MENU_FILL_PREFIX + account.id,
        parentId: MENU_ROOT,
        title: displayName(account),
        contexts: ['editable', 'page'],
      });
    }
    if (matches.length > MAX_MENU_ITEMS) {
      chrome.contextMenus.create({
        id: `${MENU_STATUS}-more`,
        parentId: MENU_ROOT,
        title: `+${matches.length - MAX_MENU_ITEMS} more…`,
        enabled: false,
        contexts: ['editable', 'page'],
      });
    }
    chrome.contextMenus.create({
      id: `${MENU_ROOT}-sep`,
      parentId: MENU_ROOT,
      type: 'separator',
      contexts: ['editable', 'page'],
    });
  } else {
    chrome.contextMenus.create({
      id: MENU_STATUS,
      parentId: MENU_ROOT,
      title: host ? `No codes saved for ${host}` : 'No codes for this page',
      enabled: false,
      contexts: ['editable', 'page'],
    });
  }

  chrome.contextMenus.create({
    id: MENU_PICKER,
    parentId: MENU_ROOT,
    title: 'Search all codes…',
    contexts: ['editable', 'page'],
  });

  await setBadge(tab, matches.length ? String(matches.length) : '');
}

async function setBadge(tab, text) {
  if (!tab?.id) return;
  try {
    await chrome.action.setBadgeText({ tabId: tab.id, text });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#4f46e5' });
  } catch {
    // Tab went away between query and update; nothing to do.
  }
}

// ---------------------------------------------------------------- code delivery

async function codeFor(accountId) {
  const accounts = await vault.loadAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('Account not found');
  const code = await generateCode(account);
  return { code, account };
}

/** Content scripts are not in pages that were already open at install time. */
async function ensureContentScript(tabId, frameId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'otp:ping' }, frameId != null ? { frameId } : {});
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: frameId != null ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true },
        files: ['src/content.js'],
      });
      return true;
    } catch (err) {
      console.warn('[otp] cannot inject into tab', tabId, err);
      return false;
    }
  }
}

async function sendToFrame(tabId, frameId, message) {
  await ensureContentScript(tabId, frameId);
  return chrome.tabs.sendMessage(tabId, message, frameId != null ? { frameId } : {});
}

async function fillInFrame(tabId, frameId, accountId) {
  const { code, account } = await codeFor(accountId);
  const settings = await vault.getSettings();
  const result = await sendToFrame(tabId, frameId, {
    type: 'otp:fill',
    code,
    label: displayName(account),
    autoSubmit: settings.autoSubmit,
    copyOnFill: settings.copyOnFill,
  });
  if (result?.filled) await vault.recordUse(accountId);
  return result;
}

/**
 * Ask every frame how well it can accept a code, then fill the best one.
 * Used by the keyboard shortcut, where there is no right-clicked element.
 */
async function fillBestFrame(tabId, accountId) {
  let frames = [];
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: probeForOtpField,
    });
  } catch {
    frames = [];
  }

  const ranked = frames
    .filter((f) => f.result && f.result.score > 0)
    .sort((a, b) => b.result.score - a.result.score);

  const frameId = ranked.length ? ranked[0].frameId : 0;
  return fillInFrame(tabId, frameId, accountId);
}

/** Injected into each frame; must stay self-contained. */
function probeForOtpField() {
  const OTP_HINT = /(otp|2fa|mfa|totp|one[\s._-]?time|two[\s._-]?factor|auth(entication)?[\s._-]?code|security[\s._-]?code|verif|passcode|token)/i;
  let score = 0;

  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
    score = 50;
    if (document.hasFocus()) score += 30;
  }

  for (const input of document.querySelectorAll('input')) {
    const haystack = [
      input.autocomplete, input.name, input.id, input.placeholder,
      input.getAttribute('aria-label'), input.className,
    ].join(' ');
    if (/one-time-code/i.test(input.autocomplete || '')) score = Math.max(score, 90);
    else if (OTP_HINT.test(haystack)) score = Math.max(score, 70);
  }

  if (score && document.hasFocus()) score += 5;
  return { score, href: location.href };
}

// ---------------------------------------------------------------- events

chrome.runtime.onInstalled.addListener((details) => {
  scheduleRebuild();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#welcome') });
  }
});

chrome.runtime.onStartup.addListener(scheduleRebuild);
chrome.tabs.onActivated.addListener(scheduleRebuild);
chrome.windows.onFocusChanged.addListener(scheduleRebuild);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') scheduleRebuild();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('accounts' in changes || 'blob' in changes || 'meta' in changes)) scheduleRebuild();
  if (area === 'session' && 'vaultKey' in changes) scheduleRebuild();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    if (info.menuItemId === MENU_PICKER) {
      await sendToFrame(tab.id, info.frameId ?? 0, { type: 'otp:picker' });
      return;
    }
    if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith(MENU_FILL_PREFIX)) {
      await fillInFrame(tab.id, info.frameId ?? 0, info.menuItemId.slice(MENU_FILL_PREFIX.length));
    }
  } catch (err) {
    console.warn('[otp] context menu action failed', err);
    notifyFailure(tab.id, info.frameId ?? 0, err);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'fill-otp') return;
  const tab = await activeTab();
  if (!tab?.id) return;

  try {
    const host = hostFromUrl(tab.url);
    const accounts = await vault.loadAccounts();
    const matches = matchAccounts(accounts, host);

    if (matches.length === 1) await fillBestFrame(tab.id, matches[0].account.id);
    else await sendToFrame(tab.id, 0, { type: 'otp:picker' });
  } catch (err) {
    if (err instanceof vault.VaultLockedError) notifyFailure(tab.id, 0, err);
    else console.warn('[otp] shortcut failed', err);
  }
});

function notifyFailure(tabId, frameId, err) {
  const message = err instanceof vault.VaultLockedError
    ? 'OTP vault is locked — click the toolbar icon'
    : `Could not fill code: ${err.message}`;
  chrome.tabs.sendMessage(tabId, { type: 'otp:toast', message, tone: 'error' }, { frameId }).catch(() => {});
}

// ---------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: err.message, locked: err instanceof vault.VaultLockedError }));
  return true; // keep the channel open for the async reply
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    // Content script asks whether this page has a code worth offering.
    case 'otp:suggest': {
      const settings = await vault.getSettings();
      if (!settings.showChip) return { suggestion: null };
      const host = hostFromUrl(sender.tab?.url || message.href || '');
      if (!host) return { suggestion: null };
      if (!(await vault.isUnlocked())) return { suggestion: null, locked: true };

      const matches = matchAccounts(await vault.loadAccounts(), host);
      if (!matches.length) return { suggestion: null };

      const best = matches[0].account;
      return {
        suggestion: {
          id: best.id,
          label: displayName(best),
          code: await generateCode(best),
          alternatives: matches.length - 1,
        },
      };
    }

    // Picker overlay: labels only, never codes.
    case 'otp:list': {
      const host = hostFromUrl(sender.tab?.url || message.href || '');
      const accounts = await vault.loadAccounts();
      const matched = new Set(matchAccounts(accounts, host).map((m) => m.account.id));
      return {
        host,
        accounts: accounts.map((account) => ({
          id: account.id,
          label: displayName(account),
          issuer: account.issuer,
          account: account.account,
          matches: matched.has(account.id),
        })),
      };
    }

    // Picker/chip asks for one specific code.
    case 'otp:code': {
      const { code, account } = await codeFor(message.id);
      await vault.recordUse(message.id);
      const settings = await vault.getSettings();
      return { code, label: displayName(account), autoSubmit: settings.autoSubmit, copyOnFill: settings.copyOnFill };
    }

    // Popup asks us to fill the page it is sitting on top of.
    case 'otp:fillTab': {
      await fillBestFrame(message.tabId, message.id);
      return {};
    }

    case 'otp:rebuildMenus':
      await rebuildMenus();
      return {};

    default:
      throw new Error(`Unknown message ${message?.type}`);
  }
}

// ---------------------------------------------------------------- auto-lock

chrome.alarms.create('otp-autolock', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'otp-autolock') return;
  const { autoLockMinutes } = await vault.getSettings();
  if (autoLockMinutes > 0) await vault.isUnlocked(); // the check itself locks when stale
});
