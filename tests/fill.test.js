// Drives the real content script inside jsdom and checks that codes land in the
// right box. The content script's public surface is its message listener, so the
// tests go through that, exactly as the background service worker does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SOURCE = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');

function setup(bodyHtml, { url = 'https://example.com/login' } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${bodyHtml}</body>`, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // jsdom has no layout, so every element measures zero and would look hidden.
  const zero = { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
  window.Element.prototype.getBoundingClientRect = function () {
    const style = window.getComputedStyle(this);
    if (style.display === 'none' || style.visibility === 'hidden') return { ...zero };
    return { width: 180, height: 32, top: 40, left: 20, bottom: 72, right: 200 };
  };

  const listeners = [];
  window.chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async () => ({ ok: true, suggestion: null }),
    },
  };

  window.eval(SOURCE);

  const send = (message) => {
    let response;
    for (const fn of listeners) fn(message, {}, (value) => { response = value; });
    return response;
  };

  return {
    dom,
    window,
    document: window.document,
    send,
    fill: (code, options = {}) => send({ type: 'otp:fill', code, label: 'Test Account', ...options }),
    rightClick(element) {
      element.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, composed: true }));
    },
  };
}

test('fills a single one-time-code input', () => {
  const ctx = setup('<form><input id="otp" autocomplete="one-time-code"></form>');
  const result = ctx.fill('123456');
  assert.equal(result.filled, true);
  assert.equal(ctx.document.querySelector('#otp').value, '123456');
  ctx.dom.window.close();
});

test('recognises an OTP field by its name when there is no autocomplete hint', () => {
  const ctx = setup(`
    <input id="user" name="username">
    <input id="code" name="twoFactorCode" maxlength="6">`);
  assert.equal(ctx.fill('654321').filled, true);
  assert.equal(ctx.document.querySelector('#code').value, '654321');
  assert.equal(ctx.document.querySelector('#user').value, '', 'the username box is left alone');
  ctx.dom.window.close();
});

test('spreads the code across split single-character boxes', () => {
  const ctx = setup(`
    <div class="otp-group">
      ${[0, 1, 2, 3, 4, 5].map((i) => `<input id="d${i}" maxlength="1" inputmode="numeric">`).join('')}
    </div>`);
  const result = ctx.fill('987654');
  assert.equal(result.filled, true);
  assert.equal(result.split, true);
  assert.deepEqual(
    [...ctx.document.querySelectorAll('.otp-group input')].map((el) => el.value),
    ['9', '8', '7', '6', '5', '4'],
  );
  ctx.dom.window.close();
});

test('an 8-digit code fills an 8-box widget', () => {
  const ctx = setup(`<div>${Array.from({ length: 8 }, (_, i) => `<input id="d${i}" maxlength="1">`).join('')}</div>`);
  ctx.fill('12345678');
  assert.deepEqual(
    [...ctx.document.querySelectorAll('input')].map((el) => el.value),
    ['1', '2', '3', '4', '5', '6', '7', '8'],
  );
  ctx.dom.window.close();
});

test('the right-clicked field wins over the automatic guess', () => {
  const ctx = setup(`
    <input id="guess" autocomplete="one-time-code">
    <input id="clicked" name="backup-code">`);
  const clicked = ctx.document.querySelector('#clicked');
  ctx.rightClick(clicked);
  ctx.fill('111222');

  assert.equal(clicked.value, '111222');
  assert.equal(ctx.document.querySelector('#guess').value, '', 'the guess is not touched');
  ctx.dom.window.close();
});

test('right-clicking a non-editable area still finds the code box', () => {
  const ctx = setup('<p id="text">Enter your code</p><input id="otp" autocomplete="one-time-code">');
  ctx.rightClick(ctx.document.querySelector('#text'));
  assert.equal(ctx.fill('424242').filled, true);
  assert.equal(ctx.document.querySelector('#otp').value, '424242');
  ctx.dom.window.close();
});

test('fires the events a framework needs to see the change', () => {
  const ctx = setup('<input id="otp" autocomplete="one-time-code">');
  const input = ctx.document.querySelector('#otp');
  const seen = [];
  for (const type of ['input', 'change']) {
    input.addEventListener(type, (event) => seen.push({ type, bubbles: event.bubbles }));
  }
  ctx.fill('135790');

  assert.ok(seen.some((e) => e.type === 'input' && e.bubbles), 'a bubbling input event');
  assert.ok(seen.some((e) => e.type === 'change'), 'a change event');
  ctx.dom.window.close();
});

test('bypasses a React-style value tracker so onChange actually fires', () => {
  const ctx = setup('<input id="otp" autocomplete="one-time-code">');
  const input = ctx.document.querySelector('#otp');
  const native = Object.getOwnPropertyDescriptor(ctx.window.HTMLInputElement.prototype, 'value');

  // React installs its own value setter on the element and uses it to decide
  // whether a change is "new". Writing through it makes React swallow the event.
  let ownSetterCalls = 0;
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() { return native.get.call(this); },
    set(v) { ownSetterCalls++; native.set.call(this, v); },
  });

  ctx.fill('246800');
  assert.equal(input.value, '246800');
  assert.equal(ownSetterCalls, 0, 'wrote through the prototype setter, not the element one');
  ctx.dom.window.close();
});

test('fills a contenteditable box', () => {
  const ctx = setup('<div id="editor" contenteditable="true"></div>');
  const editor = ctx.document.querySelector('#editor');
  // jsdom does not implement contentEditable, so stand it up by hand.
  Object.defineProperty(editor, 'isContentEditable', { value: true });
  ctx.rightClick(editor);
  assert.equal(ctx.fill('778899').filled, true);
  assert.equal(editor.textContent, '778899');
  ctx.dom.window.close();
});

test('skips hidden, disabled and read-only fields', () => {
  const ctx = setup(`
    <input id="hidden" autocomplete="one-time-code" style="display:none">
    <input id="disabled" autocomplete="one-time-code" disabled>
    <input id="readonly" autocomplete="one-time-code" readonly>
    <input id="real" autocomplete="one-time-code">`);
  ctx.fill('333444');
  assert.equal(ctx.document.querySelector('#real').value, '333444');
  for (const id of ['hidden', 'disabled', 'readonly']) {
    assert.equal(ctx.document.querySelector(`#${id}`).value, '', id);
  }
  ctx.dom.window.close();
});

test('reports failure rather than guessing when there is no code field', () => {
  const ctx = setup('<input id="search" type="search" name="q"><p>Nothing to fill here</p>');
  const result = ctx.fill('555666');
  assert.equal(result.filled, false);
  assert.equal(result.reason, 'no-field');
  assert.equal(ctx.document.querySelector('#search').value, '');
  ctx.dom.window.close();
});

test('never fills a password or card field by mistake', () => {
  const ctx = setup(`
    <input id="pw" type="password" name="password" autocomplete="current-password">
    <input id="card" name="cardNumber" maxlength="16">`);
  const result = ctx.fill('999000');
  assert.equal(result.filled, false);
  assert.equal(ctx.document.querySelector('#pw').value, '');
  assert.equal(ctx.document.querySelector('#card').value, '');
  ctx.dom.window.close();
});

test('auto-submit presses the verify button when asked', async () => {
  const ctx = setup(`
    <form>
      <input id="otp" autocomplete="one-time-code">
      <button type="submit" id="go">Verify</button>
    </form>`);
  let clicked = 0;
  ctx.document.querySelector('#go').addEventListener('click', () => { clicked++; });

  ctx.fill('121212', { autoSubmit: true });
  assert.equal(clicked, 0, 'not before the value has settled');
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(clicked, 1);
  ctx.dom.window.close();
});

test('auto-submit stays out of the way when it is off', async () => {
  const ctx = setup(`
    <form><input id="otp" autocomplete="one-time-code"><button id="go">Verify</button></form>`);
  let clicked = 0;
  ctx.document.querySelector('#go').addEventListener('click', () => { clicked++; });
  ctx.fill('121212');
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(clicked, 0);
  ctx.dom.window.close();
});

test('the ping used for injection checks answers', () => {
  const ctx = setup('<input>');
  // The reply is built inside the jsdom realm, so compare the field, not the object.
  assert.equal(ctx.send({ type: 'otp:ping' }).ok, true);
  ctx.dom.window.close();
});

test('its own UI lives in a shadow root, out of the page DOM', () => {
  const ctx = setup('<input id="otp" autocomplete="one-time-code">');
  ctx.fill('123456');
  const host = ctx.document.querySelector('[data-otp-autofill]');
  assert.ok(host, 'a single host element is added');
  assert.equal(host.shadowRoot, null, 'the shadow root is closed to the page');
  assert.equal(ctx.document.body.textContent.includes('123456'), false, 'no code text leaks into the page DOM');
  ctx.dom.window.close();
});
