// Smoke test: home -> a plugin page -> play a note -> the Buy button exists,
// plus every plugin page rendering cleanly at desktop and phone width.
'use strict';

const { test, expect } = require('@playwright/test');

const PLUGIN_PAGES = [
  { path: 'plugins/index.html', h1: 'Plugins', buy: null },
  { path: 'plugins/flagship.html', h1: 'VANTA', buy: 'vanta' },
  { path: 'plugins/drift.html', h1: 'DRIFT', buy: 'drift' },
  { path: 'plugins/prism.html', h1: 'PRISM', buy: 'prism' },
  { path: 'plugins/anvil.html', h1: 'ANVIL', buy: 'anvil' }
];

// Record every AudioContext the page creates, before any page script runs.
function trackAudioContexts() {
  window.__audioContexts = [];
  ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
    var Native = window[name];
    if (typeof Native !== 'function') return;
    var Tracked = function () {
      var ctx = new (Function.prototype.bind.apply(Native, [null].concat([].slice.call(arguments))))();
      window.__audioContexts.push(ctx);
      return ctx;
    };
    Tracked.prototype = Native.prototype;
    window[name] = Tracked;
  });
}

// Collect anything that would show up red in the console.
function watchErrors(page, baseURL) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + ((r.failure() || {}).errorText || '')));
  page.on('response', (r) => {
    // Only this site's own files: a third-party request is not a site asset.
    if (r.status() >= 400 && r.url().startsWith(baseURL)) errors.push('HTTP ' + r.status() + ' ' + r.url());
  });
  return errors;
}

test('home -> VANTA page -> play a note -> Buy button', async ({ page, baseURL }) => {
  const errors = watchErrors(page, baseURL);
  await page.addInitScript(trackAudioContexts);

  await page.goto('index.html');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'VANTA in detail' }).click();
  await expect(page).toHaveURL(/plugins\/flagship\.html$/);
  await expect(page.getByRole('heading', { level: 1, name: 'VANTA' })).toBeVisible();

  // Nothing makes sound before a gesture.
  expect(await page.evaluate(() => window.__audioContexts.length)).toBe(0);

  const keyboard = page.getByRole('group', { name: 'VANTA keyboard' });
  const c4 = keyboard.getByRole('button', { name: 'C4', exact: true });
  await c4.scrollIntoViewIfNeeded();
  await c4.hover();
  await page.mouse.down();

  await expect.poll(() => page.evaluate(() => window.__audioContexts.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__audioContexts[0].state)).toBe('running');
  await expect.poll(() => page.evaluate(() =>
    window.SSSynth.getVoiceStates().filter((v) => v.active && v.gate).map((v) => v.midi))).toEqual([60]);
  await expect(page.locator('[data-play-status]')).toContainText('Running');
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() =>
    window.SSSynth.getVoiceStates().filter((v) => v.gate).length)).toBe(0);

  const buy = page.getByRole('link', { name: /^Buy VANTA/ });
  await expect(buy).toBeVisible();
  await expect(buy).toHaveAttribute('href', 'index.html#group-store');

  // The Buy link lands on the shop, where the group-store widget lives.
  await buy.click();
  await expect(page).toHaveURL(/plugins\/index\.html#group-store$/);
  await expect(page.locator('#group-store')).toHaveCount(1);

  expect(errors).toEqual([]);
});

// A purchase this browser remembers (what the plugins page writes on a paid
// checkout return) must show up on the product page and on the docs page.
// plugin.js has to boot by itself for that: no page calls SSPlugin.init().
// Bought yesterday, so the record never ages past the 60-day retention
// plugin.js applies; the date the note must show is derived from it.
const BOUGHT_AT = Date.now() - 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BOUGHT_DATE = ((d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`)(new Date(BOUGHT_AT));
const REMEMBERED = { vanta: { t: BOUGHT_AT, ref: 'ord_abcdef123456', state: 'paid' } };

test('a remembered purchase shows on the VANTA page and in the docs', async ({ page, baseURL }) => {
  const errors = watchErrors(page, baseURL);
  await page.addInitScript((rec) => {
    window.localStorage.setItem('soundshop:bought:v1', JSON.stringify(rec));
  }, REMEMBERED);

  await page.goto('plugins/flagship.html');
  const note = page.locator('[data-bought-note][data-bought-item="vanta"]');
  await expect(note).toBeVisible();
  await expect(note).toHaveText(new RegExp('VANTA was bought on this device on\\s+' + BOUGHT_DATE + '\\.'));
  const summary = page.locator('[data-bought-summary]');
  await expect(summary).toBeVisible();
  await expect(summary.locator('.bought-summary__label')).toHaveText(['VANTA']);
  await expect(summary.locator('.bought-summary__ref')).toHaveText('ord_…3456');
  await expect(summary.locator('.bought-summary__support')).toHaveAttribute('href', '../docs.html#support');

  await page.goto('docs.html');
  const docSummary = page.locator('[data-bought-summary]');
  await expect(docSummary).toBeVisible();
  await expect(docSummary.locator('.bought-summary__label')).toHaveText(['VANTA']);
  await expect(docSummary.locator('.bought-summary__support')).toHaveAttribute('href', '#support');

  // The shop page defines groupStoreVerify, and this purchase has a reference
  // but no download link yet, so it is the one place a re-verify is offered.
  await page.goto('plugins/index.html');
  await expect(page.locator('[data-bought-summary]')).toBeVisible();
  await expect(page.locator('[data-ssp-reverify]')).toHaveText('Re-verify purchases');

  expect(errors).toEqual([]);
});

test('with nothing remembered the shop page offers nothing to re-verify', async ({ page }) => {
  await page.goto('plugins/index.html');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[data-bought-summary]')).toBeHidden();
  await expect(page.locator('[data-ssp-reverify]')).toHaveCount(0);
});

const KEYBEDS = [
  { path: 'index.html', group: 'VANTA keyboard' },
  { path: 'plugins/flagship.html', group: 'VANTA keyboard' },
  { path: 'demo/flagship-demo.html', group: /^Two and a half octave keybed/, power: true }
];

for (const kb of KEYBEDS) {
  test(`the keybed on ${kb.path} plays from the keyboard alone`, async ({ page }) => {
    await page.addInitScript(trackAudioContexts);
    await page.goto(kb.path);
    if (kb.power) {
      // The full demo opens behind a power-on dialog; it is a button too.
      const power = page.locator('[data-power-btn]');
      await power.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-overlay]')).toBeHidden();
    }
    const keyboard = page.getByRole('group', { name: kb.group });

    // One tab stop for the whole keybed, named keys inside it.
    const tabbable = keyboard.locator('[role="button"][tabindex="0"]');
    await expect(tabbable).toHaveCount(1);
    await tabbable.focus();
    await expect(tabbable).toHaveAccessibleName('C4');

    await page.keyboard.press('ArrowRight');
    const focused = keyboard.locator('[role="button"]:focus');
    await expect(focused).toHaveAccessibleName('C♯4');

    await page.keyboard.down('Space');
    await expect.poll(() => page.evaluate(() => window.__audioContexts[0] && window.__audioContexts[0].state)).toBe('running');
    await expect.poll(() => page.evaluate(() =>
      window.SSSynth.getVoiceStates().filter((v) => v.gate).map((v) => v.midi))).toEqual([61]);
    await page.keyboard.up('Space');
    await expect.poll(() => page.evaluate(() =>
      window.SSSynth.getVoiceStates().filter((v) => v.gate).length)).toBe(0);
  });
}

for (const width of [1280, 390]) {
  for (const p of PLUGIN_PAGES) {
    test(`${p.path} renders cleanly at ${width}px`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height: 844 });
      const errors = watchErrors(page, baseURL);
      await page.goto(p.path);
      await page.waitForLoadState('networkidle');

      await expect(page.getByRole('heading', { level: 1, name: p.h1 })).toBeVisible();
      const text = await page.locator('main').innerText();
      expect(text.trim().length).toBeGreaterThan(150);

      if (p.buy) {
        const buy = page.locator(`a[data-buy="${p.buy}"]`);
        await expect(buy).toBeVisible();
        await expect(buy).toHaveText(/^Buy /);
        const box = await buy.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'page scrolls sideways').toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    });
  }
}

// Every control on a page with a synth must be reachable and named.
for (const path of ['index.html', 'plugins/flagship.html', 'demo/flagship-demo.html']) {
  test(`synth controls on ${path} are labelled and keyboard-reachable`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const bad = await page.evaluate(() => {
      const out = [];
      const sel = 'button, a[href], select, input, textarea, [role="button"], [role="slider"], [role="radio"], [role="checkbox"]';
      document.querySelectorAll(sel).forEach((el) => {
        if (el.closest('[hidden], [aria-hidden="true"]') || el.getAttribute('aria-disabled') === 'true') return;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return;
        let name = el.getAttribute('aria-label') || '';
        const by = el.getAttribute('aria-labelledby');
        if (!name && by) name = by.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ');
        if (!name && el.id) { const l = document.querySelector('label[for="' + el.id + '"]'); if (l) name = l.textContent; }
        if (!name) name = el.textContent || el.getAttribute('title') || '';
        const native = /^(BUTTON|A|SELECT|INPUT|TEXTAREA)$/.test(el.tagName);
        const focusable = native || el.hasAttribute('tabindex');
        if (!name.trim()) out.push('unnamed ' + el.outerHTML.slice(0, 90));
        if (!focusable) out.push('not focusable ' + el.outerHTML.slice(0, 90));
      });
      return out;
    });
    expect(bad).toEqual([]);
  });
}
