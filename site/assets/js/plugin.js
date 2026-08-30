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
     ... (unchanged below) ...
  ======================================================================= */

  function mountDemoFrame(slot, src) {
    var host = $('[data-demo-frame]', slot) || slot;
    var frame = document.createElement('iframe');

    frame.title = attr(slot, 'data-demo-title') || 'Playable browser demo';
    frame.className = 'demo-frame';
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('allow', 'autoplay');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.style.width = '100%';
    frame.style.border = '0';
    frame.style.display = 'block';
    frame.style.height = intAttr(slot, 'data-demo-height', 720) + 'px';
    // The path came from the DOM, never from a literal in this file.
    frame.src = src;

    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(frame);
    slot.setAttribute('data-demo-state', 'embedded');

    var note = $('[data-demo-note]', slot.parentNode || document);
    if (note) note.hidden = false;
  }

  P.initDemoSlot = function (root) {
    $$('[data-demo-src]', root || document).forEach(function (slot) {
      if (bound(slot, 'demo')) return;

      var src = attr(slot, 'data-demo-src');
      if (!src) return;

      var status = $('[data-demo-status]', slot);

      if (isFileProtocol()) {
        slot.setAttribute('data-demo-state', 'file');
        if (status) {
          status.textContent =
            'This page is open from the filesystem, so the browser refuses to load the ' +
            'demo inline. Open the demo in its own tab with the link above, or serve the ' +
            'folder over http and the instrument appears here.';
        }
        return;
      }

      if (typeof window.fetch !== 'function') {
        slot.setAttribute('data-demo-state', 'unsupported');
        return;
      }

      slot.setAttribute('data-demo-state', 'probing');
      if (status) status.textContent = 'Looking for the demo build…';

      window.fetch(src, { method: 'GET', cache: 'no-store' })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('demo not published');
          return true;
        })
        .then(function () {
          mountDemoFrame(slot, src);
        })
        .catch(function () {
          slot.setAttribute('data-demo-state', 'absent');
          if (status) {
            status.textContent =
              'The inline demo could not be loaded in this context. The full instrument ' +
              'still runs in its own tab — use the link above.';
          }
        });
    });
  };

  /* =======================================================================
     02  PRESET TEASER
     ... (unchanged) ...
  ======================================================================= */

  function pick(obj, names) {
    for (var i = 0; i < names.length; i++) {
      var v = obj[names[i]];
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
    }
    return '';
  }

  function normalisePresets(data) {
    var arr = null;
    if (Array.isArray(data)) arr = data;
    else if (data && typeof data === 'object') {
      if (Array.isArray(data.presets)) arr = data.presets;
      else if (Array.isArray(data.items)) arr = data.items;
      else if (Array.isArray(data.list)) arr = data.list;
    }
    if (!arr) return [];
    return arr.filter(function (p) { return p && typeof p === 'object'; });
  }

  function presetTags(preset) {
    var raw = preset.tags || preset.categories || preset.category || preset.tag;
    return Array.isArray(raw) ? raw.join(', ') : (typeof raw === 'string' ? raw : '');
  }

  /* =======================================================================
     06  ALREADY-BOUGHT NOTE
     ...
     Change here: boughtRecords should continue to accept legacy shapes
     (bare number and {t,ref}) but must ignore stored objects that carry a
     state field unless the state explicitly equals 'paid'. This keeps
     'pending' entries out of the product pages' "Already bought on this
     device" note while allowing the plugins page to display them.
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
   * Important compatibility rule: objects that carry a 'state' field are
   * considered explicit new-shape records. They are ignored here unless
   * state === 'paid' (product pages must not treat 'pending' as ownership).
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
      // when the checkout return carried a reference. Newer entries may carry
      // a 'state' field (e.g. 'pending' or 'paid'). Product pages must only
      // treat 'paid' as ownership, so skip anything with state != 'paid'.
      var rec = parsed[key];
      var isObj = !!rec && typeof rec === 'object' && !Array.isArray(rec);

      // If this is the new shape and it declares a state we only accept 'paid'.
      if (isObj && Object.prototype.hasOwnProperty.call(rec, 'state')) {
        if (String(rec.state || '').trim().toLowerCase() !== 'paid') continue;
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
     ... (unchanged) ...
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
    if (SS && typeof SS.ready === 'function') { SS.ready(fn); return; }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  ready(function () { P.init(); });
})();
