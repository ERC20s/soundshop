#!/usr/bin/env node
'use strict';
/*
 * tools/test-plugin-init.js — site/assets/js/plugin.js must do its job on a
 * page by itself.
 *
 * Why this exists: no page calls SSPlugin.init(); the script is expected to
 * run its entry points on DOM ready. Commit b0a18c9 rewrote the tail of the
 * file and dropped that boot, and from then on every page loaded plugin.js
 * for nothing — the bought notes stayed hidden, the purchase summary never
 * rendered, a ?d8a_order= return was never remembered. Every other guard for
 * this file greps its source, which is how that shipped.
 *
 * This runs the real file in a vm sandbox against a small DOM stub (only the
 * handful of DOM calls plugin.js makes) with a purchase remembered in
 * localStorage, fires DOMContentLoaded, and asserts what a visitor would see:
 *
 *   1. the product's bought note is unhidden and carries the purchase date;
 *   2. the purchase summary is unhidden, lists the product under the label the
 *      page declares (data-bought-label-<item id>), and its "Contact support"
 *      link is the page's own data-bought-summary-support-href — no request
 *      for contact.json is made when the page declares one;
 *   3. a page that declares no support href still falls back to contact.json;
 *   4. "Re-verify purchases" appears only when something needs re-verifying.
 *
 * Zero dependencies, Node 18+. Exit 0 when every assertion holds, 2 otherwise.
 */

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var TARGET = path.join(__dirname, '..', 'site', 'assets', 'js', 'plugin.js');

var errors = [];
function ok(msg) { console.log('OK: ' + msg); }
function bad(msg) { errors.push(msg); console.log('FAIL: ' + msg); }

if (!fs.existsSync(TARGET)) {
  console.error('ERROR: site/assets/js/plugin.js not found at ' + TARGET);
  process.exit(2);
}
var source = fs.readFileSync(TARGET, 'utf8');

/* ================================================================== *
 * A minimal DOM: elements with attributes, children and a selector
 * matcher that understands tag, .class, [attr] and [attr="value"],
 * optionally comma-separated. That is every selector plugin.js uses.
 * ================================================================== */

function Elem(tag) {
  this.tagName = String(tag).toUpperCase();
  this.attrs = {};
  this.children = [];
  this.parentNode = null;
  this.style = {};
  this.listeners = {};
  this._text = '';
  this.disabled = false;
}
Elem.prototype.getAttribute = function (n) {
  return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null;
};
Elem.prototype.setAttribute = function (n, v) { this.attrs[n] = String(v); };
Elem.prototype.removeAttribute = function (n) { delete this.attrs[n]; };
Elem.prototype.hasAttribute = function (n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); };
Object.defineProperty(Elem.prototype, 'className', {
  get: function () { return this.attrs['class'] || ''; },
  set: function (v) { this.attrs['class'] = String(v); }
});
Object.defineProperty(Elem.prototype, 'hidden', {
  get: function () { return this.hasAttribute('hidden'); },
  set: function (v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
});
Object.defineProperty(Elem.prototype, 'textContent', {
  get: function () {
    var t = this._text;
    for (var i = 0; i < this.children.length; i++) t += this.children[i].textContent;
    return t;
  },
  set: function (v) { this._text = String(v); this.children.length = 0; }
});
Object.defineProperty(Elem.prototype, 'firstChild', {
  get: function () { return this.children[0] || null; }
});
Object.defineProperty(Elem.prototype, 'nextSibling', {
  get: function () {
    if (!this.parentNode) return null;
    var i = this.parentNode.children.indexOf(this);
    return this.parentNode.children[i + 1] || null;
  }
});
Elem.prototype.appendChild = function (c) {
  if (c.parentNode) c.parentNode.removeChild(c);
  c.parentNode = this; this.children.push(c); return c;
};
Elem.prototype.removeChild = function (c) {
  var i = this.children.indexOf(c);
  if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; }
  return c;
};
Elem.prototype.insertBefore = function (c, ref) {
  if (c.parentNode) c.parentNode.removeChild(c);
  var i = ref ? this.children.indexOf(ref) : -1;
  c.parentNode = this;
  if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
  return c;
};
Elem.prototype.addEventListener = function (type, fn) {
  (this.listeners[type] = this.listeners[type] || []).push(fn);
};
Elem.prototype.dispatch = function (type, ev) {
  (this.listeners[type] || []).slice().forEach(function (fn) { fn(ev || { type: type }); });
};
Elem.prototype.matches = function (selector) {
  var self = this;
  return selector.split(',').some(function (one) {
    var s = one.trim();
    var m = /^([a-z0-9]*)((?:\.[\w-]+|\[[^\]]+\])*)$/i.exec(s);
    if (!m) throw new Error('test DOM: unsupported selector "' + s + '"');
    if (m[1] && m[1].toUpperCase() !== self.tagName) return false;
    var rest = m[2];
    var re = /\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
    var p;
    while ((p = re.exec(rest)) !== null) {
      if (p[1] !== undefined) {
        if ((' ' + self.className + ' ').indexOf(' ' + p[1] + ' ') < 0) return false;
      } else {
        if (!self.hasAttribute(p[2])) return false;
        if (p[3] !== undefined && self.getAttribute(p[2]) !== p[3]) return false;
      }
    }
    return true;
  });
};
Elem.prototype.querySelectorAll = function (selector) {
  var out = [];
  (function walk(n) {
    for (var i = 0; i < n.children.length; i++) {
      if (n.children[i].matches(selector)) out.push(n.children[i]);
      walk(n.children[i]);
    }
  })(this);
  return out;
};
Elem.prototype.querySelector = function (selector) {
  return this.querySelectorAll(selector)[0] || null;
};

function make(tag, attrs, children) {
  var e = new Elem(tag);
  if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
  (children || []).forEach(function (c) { e.appendChild(c); });
  return e;
}

/* The markup the product pages ship (site/plugins/flagship.html, trimmed to
   the hooks plugin.js reads). */
function productPage(opts) {
  var summaryAttrs = {
    'data-bought-summary': '',
    'data-bought-summary-date-prefix': 'bought on this device on ',
    'data-bought-summary-ref-prefix': 'Payment reference: ',
    'data-bought-summary-ref-suffix': ' — quote this when you write to us.',
    'data-bought-summary-noref': 'No payment reference was stored with this one.',
    hidden: ''
  };
  if (opts.supportHref) summaryAttrs['data-bought-summary-support-href'] = opts.supportHref;
  var note = make('p', { 'data-bought-note': '', 'data-bought-item': 'vanta', hidden: '' }, [
    make('span', { 'data-bought-cover': '' }),
    make('span', { 'data-bought-date': '' })
  ]);
  note.children[0].textContent = 'VANTA';
  var summary = make('div', summaryAttrs, [
    make('ul', { 'data-bought-summary-list': '' }),
    make('span', {
      hidden: '', 'data-bought-summary-labels': '',
      'data-bought-label-vanta': 'VANTA', 'data-bought-label-drift': 'DRIFT',
      'data-bought-label-prism': 'PRISM', 'data-bought-label-anvil': 'ANVIL',
      'data-bought-label-bundle': 'Full Shop bundle'
    })
  ]);
  var body = make('body', {}, [make('main', { id: 'main' }, [summary, note])]);
  return { body: body, summary: summary, note: note };
}

/* ================================================================== *
 * Run plugin.js against one page and one localStorage, fire DOM ready.
 * ================================================================== */

function run(opts) {
  var page = productPage(opts);
  var storage = {};
  if (opts.bought) storage['soundshop:bought:v1'] = JSON.stringify(opts.bought);
  var fetches = [];
  var doc = new Elem('#document');
  doc.appendChild(page.body);
  doc.body = page.body;
  doc.readyState = 'loading';
  doc.createElement = function (tag) { return new Elem(tag); };
  doc.dispatchEvent = function (ev) { doc.dispatch(ev.type, ev); };

  var sandbox = {
    console: console,
    document: doc,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; },
      setItem: function (k, v) { storage[k] = String(v); },
      removeItem: function (k) { delete storage[k]; }
    },
    location: { search: opts.search || '', href: 'http://example.test/plugins/flagship.html' },
    navigator: {},
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    Promise: Promise, Date: Date, JSON: JSON, Math: Math, Number: Number, String: String, Object: Object, Array: Array, RegExp: RegExp,
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    fetch: function (url) {
      fetches.push(url);
      return Promise.resolve({ ok: false, json: function () { return Promise.resolve(null); } });
    }
  };
  if (opts.groupStoreVerify) sandbox.groupStoreVerify = opts.groupStoreVerify;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  try {
    vm.runInContext(source, sandbox, { filename: 'site/assets/js/plugin.js' });
  } catch (e) {
    console.error('ERROR: site/assets/js/plugin.js does not evaluate: ' + (e && e.message));
    process.exit(2);
  }
  if (!sandbox.SSPlugin || typeof sandbox.SSPlugin.init !== 'function') {
    console.error('ERROR: evaluating plugin.js did not expose SSPlugin.init');
    process.exit(2);
  }
  // The page finishes parsing. Nothing calls SSPlugin.init() by hand.
  doc.readyState = 'interactive';
  doc.dispatch('DOMContentLoaded');
  return { page: page, doc: doc, storage: storage, fetches: fetches, SSPlugin: sandbox.SSPlugin };
}

// Yesterday, so the record never ages past the 60-day retention plugin.js
// applies; the expected date text is derived from the same timestamp.
var BOUGHT_AT = Date.now() - 24 * 60 * 60 * 1000;
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var BOUGHT_DATE = (function (d) { return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); })(new Date(BOUGHT_AT));
var REMEMBERED = { vanta: { t: BOUGHT_AT, ref: 'ord_abcdef123456', state: 'paid' } };

/* ------------------------------------------------------------------ *
 * 1 + 2. A product page with a remembered purchase, on DOM ready.
 * ------------------------------------------------------------------ */
(function () {
  var r = run({ bought: REMEMBERED, supportHref: '../docs.html#support' });
  var note = r.page.note;
  var summary = r.page.summary;

  if (note.hidden) {
    bad('the bought note is still hidden on DOM ready — plugin.js never ran initBoughtNote (no boot)');
  } else {
    ok('the bought note is unhidden on DOM ready without any page calling SSPlugin.init()');
    var date = note.querySelector('[data-bought-date]').textContent;
    if (date !== BOUGHT_DATE) bad('the bought note date reads "' + date + '", expected "' + BOUGHT_DATE + '"');
    else ok('the bought note carries the purchase date (' + BOUGHT_DATE + ')');
  }

  if (summary.hidden) {
    bad('the purchase summary is still hidden on DOM ready — initBoughtSummary never rendered');
    return;
  }
  ok('the purchase summary is unhidden on DOM ready');

  var items = summary.querySelectorAll('li');
  if (items.length !== 1) { bad('the summary lists ' + items.length + ' item(s), expected 1'); return; }
  var label = summary.querySelector('.bought-summary__label');
  var labelText = label ? label.textContent : '';
  if (labelText !== 'VANTA') bad('the product is listed as "' + labelText + '", expected the declared label "VANTA"');
  else ok('the product is listed under the label the page declares ("VANTA")');

  var ref = summary.querySelector('.bought-summary__ref');
  if (!ref || ref.textContent !== 'ord_…3456') bad('the payment reference reads "' + (ref ? ref.textContent : '') + '", expected the masked "ord_…3456"');
  else ok('the payment reference is shown masked (ord_…3456)');

  var support = summary.querySelector('.bought-summary__support');
  var href = support ? support.getAttribute('href') : null;
  if (href !== '../docs.html#support') {
    bad('the Contact support link is ' + JSON.stringify(href) + ', expected the page\'s own data-bought-summary-support-href "../docs.html#support"');
  } else {
    ok('the Contact support link is the page\'s own data-bought-summary-support-href');
  }
  if (r.fetches.length) bad('plugin.js fetched ' + JSON.stringify(r.fetches) + ' although the page declares where support lives');
  else ok('no request is made for contact.json when the page declares its support href');

  // The docs page declares a same-page target.
  var d = run({ bought: REMEMBERED, supportHref: '#support' });
  var ds = d.page.summary.querySelector('.bought-summary__support');
  if (!ds || ds.getAttribute('href') !== '#support') bad('on a page declaring "#support" the Contact support link is ' + JSON.stringify(ds && ds.getAttribute('href')));
  else ok('a page declaring "#support" gets exactly that link');
})();

/* ------------------------------------------------------------------ *
 * 3. A page that declares nothing still falls back to contact.json.
 * ------------------------------------------------------------------ */
(function () {
  var r = run({ bought: REMEMBERED });
  if (r.page.summary.hidden) { bad('summary hidden on a page with no support href'); return; }
  if (r.fetches.length !== 1 || !/contact\.json$/.test(String(r.fetches[0]))) {
    bad('a page with no declared support href fetched ' + JSON.stringify(r.fetches) + ', expected one request for contact.json');
  } else {
    ok('a page that declares no support href still asks contact.json (' + r.fetches[0] + ')');
  }
})();

/* ------------------------------------------------------------------ *
 * 4. Nothing remembered: everything stays as shipped.
 * ------------------------------------------------------------------ */
(function () {
  var r = run({ supportHref: '../docs.html#support' });
  if (!r.page.note.hidden || !r.page.summary.hidden) bad('with nothing remembered the note/summary came up anyway');
  else ok('with nothing remembered the note and the summary stay hidden');
  if (r.page.summary.querySelectorAll('li').length) bad('with nothing remembered the summary still lists an item');
})();

/* ------------------------------------------------------------------ *
 * 5. "Re-verify purchases" only when there is something to re-verify.
 * ------------------------------------------------------------------ */
(function () {
  var verify = function () { return Promise.resolve(null); };
  var none = run({ supportHref: '../docs.html#support', groupStoreVerify: verify });
  if (none.doc.querySelector('[data-ssp-reverify]')) {
    bad('a page that defines groupStoreVerify grew a "Re-verify purchases" button with nothing remembered');
  } else {
    ok('no "Re-verify purchases" button when nothing is remembered');
  }
  var done = run({
    supportHref: '../docs.html#support', groupStoreVerify: verify,
    bought: { vanta: { t: BOUGHT_AT, ref: 'ord_1', downloadUrl: 'https://downloads.example/vanta.zip' } }
  });
  if (done.doc.querySelector('[data-ssp-reverify]')) bad('a purchase that already has its download link still got a "Re-verify purchases" button');
  else ok('no "Re-verify purchases" button when every remembered purchase has its links');
  var pending = run({ supportHref: '../docs.html#support', groupStoreVerify: verify, bought: REMEMBERED });
  var btn = pending.doc.querySelector('[data-ssp-reverify]');
  if (!btn) bad('a remembered purchase with a reference and no links got no "Re-verify purchases" button');
  else if (btn.textContent !== 'Re-verify purchases') bad('the re-verify button reads "' + btn.textContent + '"');
  else ok('"Re-verify purchases" appears for a purchase with a reference and no links');
})();

/* ------------------------------------------------------------------ */
if (errors.length) {
  console.error('\nplugin.js init check failed with ' + errors.length + ' problem(s):\n');
  errors.forEach(function (e) { console.error(' - ' + e + '\n'); });
  console.error('Please inspect the boot at the end of site/assets/js/plugin.js, createBoughtContactCta() and initBoughtSummary()');
  process.exit(2);
}
console.log('\nplugin.js boots on DOM ready: bought notes, the purchase summary and its support link come up by themselves');
process.exit(0);
