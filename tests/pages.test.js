// Checks that elements marked `hidden` in the HTML actually stay hidden.
//
// This is not a theoretical concern: `.gate { display: grid }` was enough to
// paint the "Vault locked" screen above the settings page on a fresh install.
// The `hidden` attribute is only a user-agent rule, and in the real cascade an
// author rule setting `display` beats it no matter how weak its selector is.
//
// jsdom's own cascade gets this wrong (it lets specificity decide across
// origins), so the rules are read out of the CSSOM and the cascade is applied
// here instead of trusting getComputedStyle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

function loadPage(htmlPath, { patchShared } = {}) {
  const dir = path.dirname(htmlPath);
  let html = readFileSync(htmlPath, 'utf8');
  html = html.replace(/<link[^>]*href="([^"]+\.css)"[^>]*>/g, (_match, href) => {
    let css = readFileSync(path.join(dir, href), 'utf8');
    if (patchShared && href.includes('style.css')) css = patchShared(css);
    return `<style data-from="${href}">${css}</style>`;
  });
  return new JSDOM(html, { url: 'https://example.invalid/', pretendToBeVisual: true });
}

/** Every author rule that sets `display`, flattened out of any @media wrappers. */
function displayRules(window) {
  const rules = [];
  const walk = (list) => {
    for (const rule of list) {
      if (rule.cssRules) walk(rule.cssRules);
      const value = rule.style?.getPropertyValue?.('display');
      if (!value || !rule.selectorText) continue;
      rules.push({
        selector: rule.selectorText,
        value,
        important: rule.style.getPropertyPriority('display') === 'important',
      });
    }
  };
  for (const sheet of window.document.styleSheets) walk(sheet.cssRules);
  return rules;
}

/**
 * Would this element render, given the real cascade?
 * Author `display` beats the user-agent `[hidden]` rule; author `!important`
 * beats plain author declarations.
 */
function rendersDespiteHidden(element, rules) {
  const matching = rules.filter((rule) => {
    try {
      return element.matches(rule.selector);
    } catch {
      return false; // selector jsdom cannot parse; not our concern here
    }
  });

  const important = matching.filter((rule) => rule.important);
  if (important.length) return important[important.length - 1].value !== 'none';

  const normal = matching.filter((rule) => rule.value !== 'none');
  return normal.length > 0; // author display beats the UA [hidden] rule
}

const PAGES = [
  ['popup', 'src/popup/popup.html'],
  ['options', 'src/options/options.html'],
];

for (const [name, htmlPath] of PAGES) {
  test(`${name}: elements marked hidden really stay hidden`, () => {
    const dom = loadPage(htmlPath);
    const rules = displayRules(dom.window);
    assert.ok(rules.length > 5, 'display rules were read out of the stylesheets');

    const hidden = [...dom.window.document.querySelectorAll('[hidden]')];
    assert.ok(hidden.length > 0, 'the page has elements that start hidden');

    const leaking = hidden
      .filter((el) => rendersDespiteHidden(el, rules))
      .map((el) => el.id || el.tagName.toLowerCase());

    assert.deepEqual(leaking, [], 'these start hidden but an author rule re-shows them');
    dom.window.close();
  });

  test(`${name}: the check itself catches a missing guard`, () => {
    // Remove the guard and confirm the model reports the elements that broke.
    const dom = loadPage(htmlPath, {
      patchShared: (css) => css.replace('[hidden] { display: none !important; }', ''),
    });
    const rules = displayRules(dom.window);
    const leaking = [...dom.window.document.querySelectorAll('[hidden]')]
      .filter((el) => rendersDespiteHidden(el, rules))
      .map((el) => el.id);

    assert.ok(leaking.length > 0, 'without the guard, this page would leak hidden elements');
    dom.window.close();
  });
}

test('the specific elements that were rendering are covered', () => {
  const affected = {
    'src/popup/popup.html': ['site-bar'],
    'src/options/options.html': ['lock-gate', 'page', 'export-actions'],
  };

  for (const [htmlPath, ids] of Object.entries(affected)) {
    const broken = loadPage(htmlPath, {
      patchShared: (css) => css.replace('[hidden] { display: none !important; }', ''),
    });
    const brokenRules = displayRules(broken.window);
    for (const id of ids) {
      const el = broken.window.document.querySelector(`#${id}`);
      assert.ok(el, `${htmlPath} has #${id}`);
      assert.equal(rendersDespiteHidden(el, brokenRules), true,
        `#${id} is one of the elements the missing guard exposed`);
    }
    broken.window.close();

    const fixed = loadPage(htmlPath);
    const fixedRules = displayRules(fixed.window);
    for (const id of ids) {
      const el = fixed.window.document.querySelector(`#${id}`);
      assert.equal(rendersDespiteHidden(el, fixedRules), false, `#${id} is hidden now`);
    }
    fixed.window.close();
  }
});

test('the lock screen and the main view are never both visible', () => {
  for (const [, htmlPath] of PAGES) {
    const dom = loadPage(htmlPath);
    const rules = displayRules(dom.window);
    const shows = (selector) => {
      const el = dom.window.document.querySelector(selector);
      if (!el) return false;
      return el.hasAttribute('hidden') ? rendersDespiteHidden(el, rules) : true;
    };
    const lock = shows('#lock-gate') || shows('#lock-screen');
    const main = shows('#page') || shows('#main');
    assert.equal(lock && main, false, `${htmlPath}: lock screen and page both rendering`);
    dom.window.close();
  }
});
