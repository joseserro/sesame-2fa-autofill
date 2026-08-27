// Runs in every frame. Finds the field a code belongs in, puts it there in a way
// React and friends actually notice, and hosts the picker/chip/toast UI in a
// shadow root so page CSS cannot touch it.
(() => {
  if (window.__otpAutofillLoaded) return;
  window.__otpAutofillLoaded = true;

  const OTP_HINT = /(otp|2fa|mfa|totp|one[\s._-]?time|two[\s._-]?factor|auth(entication)?[\s._-]?code|security[\s._-]?code|verif(y|ication)?|passcode|pin[\s._-]?code|token)/i;
  const SUBMIT_HINT = /(verify|submit|continue|confirm|sign[\s._-]?in|log[\s._-]?in|next|authenticate)/i;
  const FILLABLE_TYPES = new Set(['text', 'tel', 'number', 'password', 'email', '']);
  const Z = 2147483647;

  let lastRightClicked = null;
  let lastRightClickedAt = 0;

  // ------------------------------------------------------------ element helpers

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function isFillable(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.tagName === 'TEXTAREA') return isVisible(el);
    if (el.tagName !== 'INPUT') return false;
    return FILLABLE_TYPES.has((el.type || '').toLowerCase()) && isVisible(el);
  }

  function isEditable(el) {
    return Boolean(el) && (isFillable(el) || el.isContentEditable);
  }

  function describe(input) {
    return [
      input.getAttribute('autocomplete'), input.name, input.id, input.placeholder,
      input.getAttribute('aria-label'), input.getAttribute('data-testid'), input.className,
    ].filter(Boolean).join(' ');
  }

  /** How likely is this input the one-time-code box? */
  function otpScore(input) {
    if (!isFillable(input)) return 0;
    const haystack = describe(input);
    let score = 0;
    if (/one-time-code/i.test(input.getAttribute('autocomplete') || '')) score += 100;
    if (OTP_HINT.test(haystack)) score += 60;
    if (input.inputMode === 'numeric' || input.type === 'tel' || input.type === 'number') score += 10;
    if (input.maxLength >= 4 && input.maxLength <= 8) score += 20;
    if (input.maxLength === 1) score += 15; // one box of a split widget
    if (input.type === 'password') score -= 10;
    if (/user|email|name|search|phone|card|address|zip/i.test(haystack)) score -= 40;
    if (input === document.activeElement) score += 25;
    if (input.value) score -= 5;
    return score;
  }

  /** Every input on the page, including ones web components hide in shadow roots. */
  function allInputs() {
    const found = [];
    let budget = 20000; // pathological pages should not freeze the tab

    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (budget-- <= 0) return;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') found.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    try {
      walk(document);
    } catch {
      // Ignore anything the page throws at us mid-walk.
    }
    return found;
  }

  function bestOtpField() {
    let best = null;
    let bestScore = 25; // never guess on a weak signal
    for (const input of allInputs()) {
      let score = otpScore(input);
      // A row of single-character boxes is an OTP widget even when nothing is
      // named helpfully, which is the common case for these components.
      if (score > 0 && input.maxLength === 1 && splitGroupFor(input)) score += 45;
      if (score > bestScore) {
        best = input;
        bestScore = score;
      }
    }
    return best;
  }

  /** Six little one-character boxes are one field wearing a costume. */
  function splitGroupFor(input) {
    if (!input || input.tagName !== 'INPUT' || input.maxLength !== 1) return null;
    let container = input.parentElement;
    for (let depth = 0; container && depth < 5; depth++) {
      const group = [...container.querySelectorAll('input')].filter(
        (el) => isFillable(el) && el.maxLength === 1,
      );
      if (group.length >= 4 && group.includes(input)) return group;
      container = container.parentElement;
    }
    return null;
  }

  function resolveTarget() {
    if (lastRightClicked && lastRightClicked.isConnected && isEditable(lastRightClicked)
        && Date.now() - lastRightClickedAt < 60000) {
      return lastRightClicked;
    }
    const active = document.activeElement;
    if (isEditable(active) && active !== document.body) return active;
    return bestOtpField();
  }

  // ------------------------------------------------------------ value setting

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const ownSetter = Object.getOwnPropertyDescriptor(el, 'value')?.set;
    // React installs its own value setter; going through the prototype one keeps
    // its change tracker honest so the onChange handler actually fires.
    if (nativeSetter && ownSetter !== nativeSetter) nativeSetter.call(el, value);
    else el.value = value;
  }

  function fireInput(el, data) {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function fireKeys(el, char) {
    const init = { bubbles: true, composed: true, key: char, code: `Digit${char}`, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function fillSingle(el, code) {
    el.focus({ preventScroll: true });
    if (el.isContentEditable) {
      el.textContent = code;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: code }));
      return true;
    }
    setNativeValue(el, '');
    fireInput(el, '');
    setNativeValue(el, code);
    fireInput(el, code);
    try {
      el.setSelectionRange(code.length, code.length);
    } catch {
      // Not all input types support selection.
    }
    return true;
  }

  function fillSplit(group, code) {
    const digits = code.split('');
    group.forEach((input, index) => {
      const char = digits[index] ?? '';
      input.focus({ preventScroll: true });
      setNativeValue(input, '');
      fireInput(input, '');
      if (!char) return;
      fireKeys(input, char);
      setNativeValue(input, char);
      fireInput(input, char);
    });
    const last = group[Math.min(digits.length, group.length) - 1];
    if (last) last.focus({ preventScroll: true });
    return true;
  }

  function findSubmitButton(from) {
    const form = from.closest('form');
    if (form) {
      const button = form.querySelector('button[type=submit], input[type=submit], button:not([type=button]):not([type=reset])');
      if (button && isVisible(button)) return button;
    }
    const scope = form || document;
    const buttons = [...scope.querySelectorAll('button, input[type=submit], [role=button]')];
    return buttons.find((el) => isVisible(el) && !el.disabled
      && SUBMIT_HINT.test(`${el.innerText || ''} ${el.value || ''} ${el.getAttribute('aria-label') || ''}`)) || null;
  }

  function submitAfterFill(target) {
    const button = findSubmitButton(target);
    if (button) {
      button.click();
      return;
    }
    const form = target.closest('form');
    if (form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    }
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  function fillCode(code, options = {}) {
    const target = resolveTarget();
    if (!target) return { filled: false, reason: 'no-field' };

    const group = splitGroupFor(target);
    if (group) fillSplit(group, code);
    else fillSingle(target, code);

    if (options.copyOnFill) copyToClipboard(code);
    if (options.autoSubmit) setTimeout(() => submitAfterFill(target), 120);
    return { filled: true, split: Boolean(group) };
  }

  // ------------------------------------------------------------ shadow-root UI

  let uiHost = null;
  let uiRoot = null;

  function ui() {
    if (uiRoot) return uiRoot;
    uiHost = document.createElement('div');
    uiHost.style.cssText = `all: initial; position: fixed; inset: 0 auto auto 0; width: 0; height: 0; z-index: ${Z};`;
    uiHost.setAttribute('data-otp-autofill', '');
    uiRoot = uiHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    uiRoot.append(style);
    (document.body || document.documentElement).append(uiHost);
    return uiRoot;
  }

  const UI_CSS = `
    :host, * { box-sizing: border-box; }
    .chip, .toast, .modal {
      position: fixed; font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #0f172a; z-index: ${Z};
    }
    .chip {
      display: flex; align-items: center; gap: 10px; padding: 8px 10px;
      background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
      box-shadow: 0 8px 24px rgba(15,23,42,.16); cursor: pointer; max-width: 320px;
      animation: pop .12s ease-out;
    }
    .chip:hover { border-color: #6366f1; }
    .chip .mark { width: 22px; height: 22px; border-radius: 6px; background: #4f46e5; color: #fff;
      display: grid; place-items: center; font-size: 11px; font-weight: 700; flex: none; }
    /* label above code: both are spans, so they need to be told to stack */
    .chip .text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .chip .label { display: block; font-size: 11px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chip .code { display: block; font: 700 15px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; white-space: nowrap; }
    .chip .more { flex: none; font-size: 11px; color: #6366f1; border-left: 1px solid #e2e8f0; padding-left: 10px; white-space: nowrap; }
    .chip .close { border: 0; background: transparent; color: #94a3b8; cursor: pointer; font-size: 14px; padding: 0 2px; }

    .backdrop { position: fixed; inset: 0; background: rgba(15,23,42,.35); z-index: ${Z}; animation: fade .12s ease-out; }
    .modal { top: 12vh; left: 50%; transform: translateX(-50%); width: min(440px, 92vw);
      background: #fff; border-radius: 14px; box-shadow: 0 24px 64px rgba(15,23,42,.3); overflow: hidden;
      animation: pop .14s ease-out; }
    .modal header { padding: 12px 14px; border-bottom: 1px solid #eef2f7; display: flex; align-items: center; gap: 8px; }
    .modal input {
      flex: 1; border: 0; outline: 0; font: 500 14px/1.4 inherit; color: #0f172a; background: transparent;
    }
    .modal .hint { font-size: 11px; color: #94a3b8; }
    .list { max-height: 46vh; overflow-y: auto; padding: 6px; }
    .row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
    .row[aria-selected=true] { background: #eef2ff; }
    .row .mark { width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center;
      color: #fff; font-size: 11px; font-weight: 700; flex: none; }
    .row .issuer { font-weight: 600; }
    .row .sub { font-size: 11px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row .tag { margin-left: auto; font-size: 10px; font-weight: 700; color: #4f46e5;
      background: #eef2ff; padding: 2px 6px; border-radius: 999px; flex: none; }
    .empty { padding: 24px 14px; text-align: center; color: #94a3b8; font-size: 12px; }

    .toast { bottom: 20px; right: 20px; padding: 10px 14px; border-radius: 10px; background: #0f172a;
      color: #f8fafc; box-shadow: 0 12px 32px rgba(15,23,42,.28); max-width: 320px; animation: pop .12s ease-out; }
    .toast.error { background: #b91c1c; }

    @keyframes pop { from { opacity: 0; transform: translateY(4px) scale(.98); } }
    @keyframes fade { from { opacity: 0; } }

    @media (prefers-color-scheme: dark) {
      .chip, .modal { background: #1e293b; border-color: #334155; color: #e2e8f0; }
      .modal header { border-color: #334155; }
      .modal input { color: #e2e8f0; }
      .row[aria-selected=true] { background: #334155; }
      .chip .label, .row .sub, .modal .hint, .empty { color: #94a3b8; }
    }
  `;

  const PALETTE = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#0284c7'];
  function colorFor(text) {
    let hash = 0;
    for (const ch of String(text)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[hash % PALETTE.length];
  }
  const initials = (text) => String(text || '?').trim().slice(0, 2).toUpperCase();
  const spaced = (code) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

  function toast(message, tone = 'info') {
    const root = ui();
    root.querySelectorAll('.toast').forEach((el) => el.remove());
    const el = document.createElement('div');
    el.className = `toast ${tone === 'error' ? 'error' : ''}`;
    el.textContent = message;
    root.append(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ------------------------------------------------------------ suggestion chip

  let chipEl = null;
  let chipField = null;
  let chipTimer = null;

  function hideChip() {
    if (chipTimer) clearInterval(chipTimer);
    chipTimer = null;
    chipEl?.remove();
    chipEl = null;
    chipField = null;
  }

  function positionChip() {
    if (!chipEl || !chipField?.isConnected) return hideChip();
    const rect = chipField.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) return hideChip();
    chipEl.style.top = `${Math.min(rect.bottom + 6, innerHeight - 60)}px`;
    chipEl.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 330))}px`;
  }

  async function showChip(field) {
    if (chipField === field) return;
    hideChip();

    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'otp:suggest', href: location.href });
    } catch {
      return; // extension reloaded out from under us
    }
    if (!response?.ok || !response.suggestion || document.activeElement !== field) return;

    const { id, label, code, alternatives } = response.suggestion;
    chipField = field;
    chipEl = document.createElement('div');
    chipEl.className = 'chip';
    chipEl.innerHTML = `
      <span class="mark"></span>
      <span class="text">
        <span class="label"></span>
        <span class="code"></span>
      </span>
      ${alternatives > 0 ? `<span class="more">+${alternatives} more</span>` : ''}
      <button class="close" title="Dismiss">&times;</button>`;
    chipEl.querySelector('.mark').textContent = initials(label);
    chipEl.querySelector('.mark').style.background = colorFor(label);
    chipEl.querySelector('.label').textContent = label;
    chipEl.querySelector('.code').textContent = spaced(code);

    chipEl.querySelector('.close').addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideChip();
    });
    chipEl.querySelector('.more')?.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideChip();
      openPicker();
    });
    chipEl.addEventListener('mousedown', async (event) => {
      event.preventDefault();
      const target = chipField;
      hideChip();
      const fresh = await chrome.runtime.sendMessage({ type: 'otp:code', id });
      if (!fresh?.ok) return toast(fresh?.error || 'Could not generate code', 'error');
      lastRightClicked = target;
      lastRightClickedAt = Date.now();
      const result = fillCode(fresh.code, fresh);
      if (result.filled) toast(`Filled code for ${fresh.label}`);
    });

    ui().append(chipEl);
    positionChip();
    // The code rotates while the chip sits there; keep it current.
    chipTimer = setInterval(() => {
      if (!chipField?.isConnected) return hideChip();
      chrome.runtime.sendMessage({ type: 'otp:suggest', href: location.href })
        .then((next) => {
          if (next?.ok && next.suggestion && chipEl) {
            chipEl.querySelector('.code').textContent = spaced(next.suggestion.code);
          }
        })
        .catch(() => hideChip());
    }, 5000);
  }

  // ------------------------------------------------------------ picker overlay

  let pickerOpen = false;

  async function openPicker() {
    if (pickerOpen) return;
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'otp:list', href: location.href });
    } catch {
      return;
    }
    if (!response?.ok) {
      toast(response?.locked ? 'Vault is locked — click the toolbar icon' : (response?.error || 'Could not read vault'), 'error');
      return;
    }

    pickerOpen = true;
    const root = ui();
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <header>
        <input type="text" placeholder="Search codes…" spellcheck="false" autocomplete="off">
        <span class="hint">&uarr;&darr; Enter</span>
      </header>
      <div class="list"></div>`;

    const search = modal.querySelector('input');
    const list = modal.querySelector('.list');
    // Sort site matches first, then alphabetically.
    const all = response.accounts.sort(
      (a, b) => Number(b.matches) - Number(a.matches) || a.label.localeCompare(b.label),
    );
    let visible = all;
    let cursor = 0;

    function render() {
      const query = search.value.trim().toLowerCase();
      visible = query
        ? all.filter((item) => item.label.toLowerCase().includes(query))
        : all;
      cursor = Math.min(cursor, Math.max(0, visible.length - 1));

      if (!visible.length) {
        list.innerHTML = `<div class="empty">${all.length ? 'No codes match that search' : 'No codes saved yet'}</div>`;
        return;
      }
      list.innerHTML = '';
      visible.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'row';
        row.setAttribute('aria-selected', String(index === cursor));
        row.innerHTML = `
          <span class="mark"></span>
          <span style="min-width:0">
            <div class="issuer"></div>
            <div class="sub"></div>
          </span>
          ${item.matches ? '<span class="tag">THIS SITE</span>' : ''}`;
        row.querySelector('.mark').textContent = initials(item.issuer || item.label);
        row.querySelector('.mark').style.background = colorFor(item.label);
        row.querySelector('.issuer').textContent = item.issuer || item.label;
        row.querySelector('.sub').textContent = item.account || '';
        row.addEventListener('mousedown', (event) => {
          event.preventDefault();
          choose(item);
        });
        list.append(row);
      });
      list.children[cursor]?.scrollIntoView({ block: 'nearest' });
    }

    async function choose(item) {
      close();
      const fresh = await chrome.runtime.sendMessage({ type: 'otp:code', id: item.id });
      if (!fresh?.ok) return toast(fresh?.error || 'Could not generate code', 'error');
      const result = fillCode(fresh.code, fresh);
      toast(result.filled
        ? `Filled code for ${fresh.label}`
        : `No code field found — code for ${fresh.label} is ${spaced(fresh.code)}`,
        result.filled ? 'info' : 'error');
    }

    function close() {
      pickerOpen = false;
      backdrop.remove();
      modal.remove();
      document.removeEventListener('keydown', onKey, true);
    }

    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        cursor = Math.min(cursor + 1, visible.length - 1);
        render();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        cursor = Math.max(cursor - 1, 0);
        render();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (visible[cursor]) choose(visible[cursor]);
      }
    }

    // Remember where to type before the search box steals focus.
    lastRightClicked = resolveTarget();
    lastRightClickedAt = Date.now();

    backdrop.addEventListener('mousedown', close);
    search.addEventListener('input', () => {
      cursor = 0;
      render();
    });
    document.addEventListener('keydown', onKey, true);

    root.append(backdrop, modal);
    render();
    search.focus();
  }

  // ------------------------------------------------------------ wiring

  document.addEventListener('contextmenu', (event) => {
    const path = event.composedPath?.() || [event.target];
    lastRightClicked = path.find(isEditable) || event.target;
    lastRightClickedAt = Date.now();
  }, true);

  document.addEventListener('focusin', (event) => {
    const el = event.target;
    if (!isFillable(el)) return hideChip();
    if (otpScore(el) < 60) return hideChip();
    showChip(el);
  }, true);

  document.addEventListener('focusout', () => {
    // Let a click on the chip land before it disappears.
    setTimeout(() => {
      if (chipField && document.activeElement !== chipField) hideChip();
    }, 180);
  }, true);

  addEventListener('scroll', positionChip, true);
  addEventListener('resize', positionChip);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'otp:ping':
        sendResponse({ ok: true });
        return false;
      case 'otp:fill': {
        const result = fillCode(message.code, message);
        if (result.filled) toast(`Filled code for ${message.label}`);
        else toast(`No code field found here — ${message.label}: ${spaced(message.code)}`, 'error');
        sendResponse(result);
        return false;
      }
      case 'otp:picker':
        openPicker();
        sendResponse({ ok: true });
        return false;
      case 'otp:toast':
        toast(message.message, message.tone);
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });
})();
