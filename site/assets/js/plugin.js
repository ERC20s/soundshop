/* =========================================================================
   SOUNDSHOP — plugin.js
   Shared behaviour for the four product pages (VANTA / DRIFT / PRISM / ANVIL).

   Design rules this file obeys, deliberately:
     - No modules, no imports, no build step. Plain <script src>.
     - Exactly one global: window.SSPlugin.
     - No path or URL literal appears anywhere in this file. Every path the
       page wants fetched or embedded is read from a data-* attribute on the
       markup that owns it, so tools/check-links.js never has to guess and a
       page can point at a file that does not exist yet without breaking.
     - Nothing here is required for the page to be readable. Every feature
       degrades to the static markup already in the document, and every entry
       point is wrapped so a missing element can never throw.
     - Fetched data is written with textContent only. Never innerHTML.

   Public API (all idempotent, all safe to call with nothing on the page):
     SSPlugin.init()               run everything below, on DOM ready
     SSPlugin.initDemoSlot(root)   probe [data-demo-src], embed on 200 OK
     SSPlugin.initPresetTeaser(r)  load [data-presets-src], render preset rows
     SSPlugin.initSectionNav(root) sticky in-page nav + scroll spy
     SSPlugin.initTabs(root)       ARIA tablist panels (spec sheets)
     SSPlugin.initCounters(root)   count-up for [data-count-to] figures
     SSPlugin.initBoughtNote(r)    unhide [data-bought-note] for a remembered buy
     SSPlugin.initBoughtSummary(r) list every remembered buy into [data-bought-summary]
   ========================================================================= */

(function (window, document) {
  'use strict';

  var SS = window.SS || null;
  var P = {};
  window.SSPlugin = P;

  /* =======================================================================
     00  SMALL HELPERS  (mirrors SS.* when ui.js is present, works without it)
     ======================================================================= */

  function $(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }

  function $$(sel, root) {
    try {
      return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    } catch (e) { return []; }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function attr(node, name) {
    if (!node || !node.getAttribute) return '';
    var v = node.getAttribute(name);
    return v == null ? '' : String(v).trim();
  }

  function intAttr(node, name, fallback) {
    var n = parseInt(attr(node, name), 10);
    return isFinite(n) ? n : fallback;
  }

  function bound(node, key) {
    // One-shot guard so re-running init() never double-binds anything.
    // Keyed per feature, so one element can safely carry two behaviours.
    if (!node) return true;
    var name = 'data-ssp-' + key;
    if (node.getAttribute(name) === 'on') return true;
    node.setAttribute(name, 'on');
    return false;
  }

  function reducedMotion() {
    if (SS && typeof SS.prefersReducedMotion === 'function') {
      try { return SS.prefersReducedMotion(); } catch (e) { /* fall through */ }
    }
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  function isFileProtocol() {
    try { return window.location.protocol === 'file:'; } catch (e) { return false; }
  }

  P.isFileProtocol = isFileProtocol;

  /** Replace the children of a node with a single message paragraph. */
  function setMessage(node, className, text) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
    node.appendChild(el('p', className, text));
  }

  /* =======================================================================
     01  DEMO SLOT
     ... (file unchanged until boughtRecords) ...
  ======================================================================= */

  var BOUGHT_KEY = 'soundshop:bought:v1';
  var BOUGHT_MAX_AGE = 60 * 24 * 60 * 60 * 1000;   // 60 days, as on the plugins page

  // A payment reference is quoted back to the buyer verbatim, so it is held to
  // exactly the shape the plugins page accepted off the return URL before it
  // ever reached storage. Anything else is treated as "no reference stored".
  var BOUGHT_REF_RE = /^[A-Za-z0-9_-]{1,128}$/;
  // A token is only ever printed when the page has no label for it, so it is
  // held to the same shape the plugins page allows itself to write.
  var BOUGHT_TOKEN_RE = /^[a-z0-9][a-z0-9 ._-]{0,63}$/;

  /**
   * Everything this browser remembers buying, normalised and unexpired, as
   * token -> { t: <ms>, ref: '<payment reference>' | '' }. One parser for the
   * whole file: initBoughtNote wants only the time, initBoughtSummary wants
   * the reference too, and neither should re-read or re-validate the key.
   *
   * New behaviour: historic shapes are accepted (bare number, or {t,ref}) but
   * objects that carry an explicit state field are ignored here unless state
   * === 'paid'. In other words, pending/processing entries do not count as
   * owned for the product pages and the docs summary.
   */
  function boughtRecords() {
    var out = {};
    var raw = null;
    try { raw = window.localStorage.getItem(BOUGHT_KEY); } catch (e) { return out; }
    if (!raw) return out;

    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return out; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;

    var now = Date.now();
    for (var key in parsed) {
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
      var token = String(key == null ? '' : key).trim().toLowerCase();
      // Two stored shapes, both valid: a bare timestamp, and
      // { t: <time>, ref: '<payment reference>' } as written by the plugins page
      // when the checkout return carried a reference. Reading only the number
      // here would make Number({...}) NaN and silently hide this note for every
      // purchase made after that change.
      var rec = parsed[key];
      var isObj = !!rec && typeof rec === 'object' && !Array.isArray(rec);

      // If this stored value is an object that carries a state field, only
      // accept it as a remembered paid purchase when state === 'paid'. Any
      // other explicit state (e.g. 'pending') is ignored for ownership.
      if (isObj && Object.prototype.hasOwnProperty.call(rec, 'state')) {
        try {
          var st = String(rec.state == null ? '' : rec.state).trim().toLowerCase();
          if (st !== 'paid') continue;
        } catch (e) { continue; }
      }

      var when = Number(isObj ? rec.t : rec);
      if (!token || !isFinite(when) || when <= 0) continue;
      if ((now - when) > BOUGHT_MAX_AGE) continue;   // too old to speak for: ignore

      var ref = isObj && typeof rec.ref === 'string' ? rec.ref.trim() : '';
      if (!BOUGHT_REF_RE.test(ref)) ref = '';
      out[token] = { t: when, ref: ref };
    }
    return out;
  }

  /** The same set, flattened to token -> timestamp for callers that want only that. */
  function boughtItems() {
    var recs = boughtRecords();
    var out = {};
    for (var token in recs) {
      if (!Object.prototype.hasOwnProperty.call(recs, token)) continue;
      out[token] = recs[token].t;
    }
    return out;
  }

  function boughtDate(ms) {
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return d.toDateString(); }
  }

  P.initBoughtNote = function (root) {
    var notes = $$('[data-bought-note]', root || document);
    if (!notes.length) return;                       // e.g. the plugins page: untouched

    var items = boughtItems();
    var tokens = 0;
    for (var t in items) { if (Object.prototype.hasOwnProperty.call(items, t)) tokens++; }
    if (!tokens) return;                             // nothing remembered, nothing to say

    notes.forEach(function (note) {
      if (bound(note, 'bought')) return;

      var token = attr(note, 'data-bought-item').toLowerCase();
      if (!token) return;

      var when = 0;
      var state = '';
      if (Object.prototype.hasOwnProperty.call(items, token)) {
        when = items[token];
        state = 'own';
      } else {
        var cover = attr(note, 'data-bought-covered-by').toLowerCase();
        if (cover && Object.prototype.hasOwnProperty.call(items, cover)) {
          when = items[cover];
          state = 'covered';
        }
      }
      if (!state) return;                            // not bought here: leave it hidden

      var dateNode = $('[data-bought-date]', note);
      if (dateNode) {
        var text = boughtDate(when);
        // The wording around the date is the page's, not this file's.
        dateNode.textContent = text ? (attr(dateNode, 'data-bought-date-prefix') + text) : '';
      }

      var coverNode = $('[data-bought-cover]', note);
      if (coverNode) coverNode.hidden = state === 'own' ? true : false;

      note.setAttribute('data-bought-state', state);
      note.hidden = false;
    });
  };

  /* =======================================================================
     07  BOUGHT SUMMARY  (docs.html, "Nothing has arrived")
     ... unchanged ...
  ======================================================================= */

  var BOUGHT_SUMMARY_MAX = 12;

  function boughtLabel(map, token) {
    var label = map ? attr(map, 'data-bought-label-' + token) : '';
    if (label) return label;
    return BOUGHT_TOKEN_RE.test(token) ? token : '';
  }

  function boughtSummaryRow(host, map, entry) {
    var label = boughtLabel(map, entry.token);
    if (!label) return null;                         // unlabelled and unprintable: skip

    var row = el('li', 'bought-summary__item');
    row.appendChild(el('strong', null, label));

    var dated = boughtDate(entry.t);
    if (dated) {
      row.appendChild(
        document.createTextNode(' — ' + attr(host, 'data-bought-summary-date-prefix') + dated + '.')
      );
    }

    if (entry.ref) {
      var refLine = el('span', 'bought-summary__ref');
      refLine.appendChild(document.createTextNode(' ' + attr(host, 'data-bought-summary-ref-prefix')));
      refLine.appendChild(el('code', null, entry.ref));
      refLine.appendChild(document.createTextNode(attr(host, 'data-bought-summary-ref-suffix')));
      row.appendChild(refLine);
    } else {
      var noRef = attr(host, 'data-bought-summary-noref');
      if (noRef) row.appendChild(el('span', 'bought-summary__ref muted', ' ' + noRef));
    }

    return row;
  }

  P.initBoughtSummary = function (root) {
    var hosts = $$('[data-bought-summary]', root || document);
    if (!hosts.length) return;                       // every page but the docs: untouched

    var recs = boughtRecords();
    var entries = [];
    for (var token in recs) {
      if (!Object.prototype.hasOwnProperty.call(recs, token)) continue;
      entries.push({ token: token, t: recs[token].t, ref: recs[token].ref });
    }
    if (!entries.length) return;                     // nothing remembered, nothing to say

    entries.sort(function (a, b) { return b.t - a.t; });   // newest purchase first
    entries = entries.slice(0, BOUGHT_SUMMARY_MAX);

    hosts.forEach(function (host) {
      if (bound(host, 'boughtsummary')) return;

      var list = $('[data-bought-summary-list]', host);
      if (!list) return;
      var map = $('[data-bought-summary-labels]', host);

      var frag = document.createDocumentFragment();
      var rows = 0;
      entries.forEach(function (entry) {
        var row = null;
        try { row = boughtSummaryRow(host, map, entry); } catch (e) { row = null; }
        if (row) { frag.appendChild(row); rows++; }
      });
      if (!rows) return;                             // nothing printable: stay hidden

      while (list.firstChild) list.removeChild(list.firstChild);
      list.appendChild(frag);

      host.setAttribute('data-bought-summary-state', 'ready');
      host.hidden = false;
    });
  };

  /* =======================================================================
     08  BOOT
     ======================================================================= */

  P.init = function (root) {
    try { P.initDemoSlot(root); } catch (e) { /* never block the page */ }
    try { P.initPresetTeaser(root); } catch (e) { /* never block the page */ }
    try { P.initSectionNav(root); } catch (e) { /* never block the page */ }
    try { P.initTabs(root); } catch (e) { /* never block the page */ }
    try { P.initCounters(root); } catch (e) { /* never block the page */ }
    try { P.initBoughtNote(root); } catch (e) { /* never block the page */ }
    try { P.initBoughtSummary(root); } catch (e) { /* never block the page */ }
  };

  function ready(fn) {
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', fn); }
    else { setTimeout(fn, 0); }
  }
  ready(function () { try { P.init(); } catch (e) { /* never block */ } });

})(window, document);
