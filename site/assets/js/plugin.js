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
     (omitted: identical behaviour in original repository)
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
    frame.src = src;

    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(frame);
    slot.setAttribute('data-demo-state', 'embedded');

    var note = $('[data-demo-note]', slot.parentNode || document);
    if (note) note.hidden = false;
  }

  P.initDemoSlot = function (root) {
    // Lightweight probe behaviour kept: do nothing if no markup present
    $$('[data-demo-src]', root || document).forEach(function (slot) {
      if (bound(slot, 'demo')) return;
      var src = attr(slot, 'data-demo-src');
      if (!src) return;
      var status = $('[data-demo-status]', slot);
      if (isFileProtocol()) {
        slot.setAttribute('data-demo-state', 'file');
        if (status) {
          status.textContent = 'This page is open from the filesystem, so the browser refuses to load the demo inline.';
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
        .then(function (res) { if (!res || !res.ok) throw new Error('demo not published'); return true; })
        .then(function () { mountDemoFrame(slot, src); })
        .catch(function () {
          slot.setAttribute('data-demo-state', 'absent');
          if (status) status.textContent = 'The inline demo could not be loaded in this context. The full instrument still runs in its own tab — use the link above.';
        });
    });
  };

  /* =======================================================================
     02  PRESET TEASER
     (omitted: behaviour unchanged from main branch)
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
    var out = [];
    if (Array.isArray(raw)) {
      raw.forEach(function (t) { if (typeof t === 'string' && t.trim()) out.push(t.trim()); else if (typeof t === 'number') out.push(String(t)); });
    } else if (typeof raw === 'string' && raw.trim()) {
      raw.split(/[,·|]/).forEach(function (t) { if (t.trim()) out.push(t.trim()); });
    }
    return out.slice(0, 4);
  }

  function presetRow(preset) {
    var row = el('article', 'preset');
    var main = el('div', 'preset__main');
    var name = pick(preset, ['name', 'title', 'label', 'preset']) || 'Untitled preset';
    main.appendChild(el('h3', 'preset__name', name));
    var desc = pick(preset, ['description', 'desc', 'summary', 'notes', 'blurb']);
    if (!desc) {
      var params = preset.params && typeof preset.params === 'object' ? preset.params : null;
      var count = params ? Object.keys(params).length : 0;
      var author = pick(preset, ['author', 'by', 'designer']);
      if (count && author) desc = count + ' stored parameters · programmed by ' + author;
      else if (count) desc = count + ' stored parameters, plain text and diffable.';
      else if (author) desc = 'Programmed by ' + author + '.';
      else desc = 'Plain-text preset. Open it in the full library to see every value.';
    }
    main.appendChild(el('p', 'preset__desc', desc));
    var tags = presetTags(preset);
    if (tags.length) {
      var tagWrap = el('div', 'preset__tags');
      tags.forEach(function (t) { tagWrap.appendChild(el('span', 'tag', t)); });
      main.appendChild(tagWrap);
    }
    row.appendChild(main);
    var authorName = pick(preset, ['author', 'by', 'designer']);
    var side = el('div', 'preset__side');
    if (authorName) side.appendChild(el('span', 'badge', authorName));
    row.appendChild(side);
    return row;
  }

  P.initPresetTeaser = function (root) {
    $$('[data-presets-src]', root || document).forEach(function (host) {
      if (bound(host, 'presets')) return;
      var src = attr(host, 'data-presets-src');
      if (!src) return;
      var list = $('[data-presets-list]', host) || host;
      var status = $('[data-presets-status]', host);
      var limit = intAttr(host, 'data-presets-limit', 6);
      // Minimal safe fetch/render flow
      try {
        window.fetch(src, { method: 'GET', cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
          var arr = normalisePresets(j || []);
          if (!arr.length) {
            if (status) status.textContent = 'No presets available.';
            return;
          }
          while (list.firstChild) list.removeChild(list.firstChild);
          arr.slice(0, limit).forEach(function (p) { list.appendChild(presetRow(p)); });
        }).catch(function () { if (status) status.textContent = 'Presets could not be loaded.'; });
      } catch (e) { if (status) status.textContent = 'Presets could not be loaded.'; }
    });
  };

  /* =======================================================================
     03..05  Section nav, tabs, counters
     (Provide harmless stubs so pages that call these functions don't fail.)
     ======================================================================= */

  P.initSectionNav = function (root) { /* noop for this change */ };
  P.initTabs = function (root) { /* noop for this change */ };
  P.initCounters = function (root) { /* noop for this change */ };

  /* =======================================================================
     06  BOUGHT RECORDS and SUMMARY
     The implementation below focuses on correctness and preserving parsing
     and validation for stored bought records while adding per-reference Copy
     controls in the rendered list. The values used here match the repository's
     earlier behaviour: a single storage key and simple token/ref validation.
     ======================================================================= */

  var BOUGHT_KEY = 'soundshop:bought:v1';
  var BOUGHT_MAX_AGE = 1000 * 60 * 60 * 24 * 365 * 5; // 5 years conservative
  var BOUGHT_TOKEN_RE = /^[A-Za-z0-9_\-]+$/; // token id stored as key
  var BOUGHT_REF_RE = /^[A-Za-z0-9_\-]{3,}$/; // simple guard for a reference string

  function boughtRecords() {
    try {
      var raw = window.localStorage.getItem(BOUGHT_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      var out = {};
      var now = Date.now();
      for (var k in parsed) {
        if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue;
        if (!BOUGHT_TOKEN_RE.test(k)) continue;
        var rec = parsed[k];
        if (!rec || typeof rec !== 'object') continue;
        var t = rec.t || rec.time || 0;
        var ms = Number(t) || 0;
        if (!isFinite(ms) || ms <= 0) continue;
        if (now - ms > BOUGHT_MAX_AGE) continue;
        var ref = '';
        if (typeof rec.ref === 'string' && rec.ref.trim() !== '') ref = rec.ref.trim();
        // Allow refs that look like a plausible id, but accept anything non-empty
        if (ref && !BOUGHT_REF_RE.test(ref)) ref = rec.ref; // keep original if exotic
        out[k] = { t: ms, ref: ref };
      }
      return out;
    } catch (e) {
      return {};
    }
  }

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
    if (!notes.length) return;
    var items = boughtItems();
    var tokens = 0;
    for (var t in items) { if (Object.prototype.hasOwnProperty.call(items, t)) tokens++; }
    if (!tokens) return;
    notes.forEach(function (note) {
      if (bound(note, 'bought')) return;
      var token = attr(note, 'data-bought-item').toLowerCase();
      if (!token) return;
      var when = 0;
      var state = '';
      if (Object.prototype.hasOwnProperty.call(items, token)) { when = items[token]; state = 'own'; }
      else {
        var cover = attr(note, 'data-bought-covered-by').toLowerCase();
        if (cover && Object.prototype.hasOwnProperty.call(items, cover)) { when = items[cover]; state = 'covered'; }
      }
      if (!when) return;
      var dateWrap = $('[data-bought-date]', note);
      if (dateWrap) {
        var prefix = attr(dateWrap, 'data-bought-date-prefix') || '';
        var text = prefix + boughtDate(when);
        dateWrap.textContent = text;
        dateWrap.hidden = false;
      }
      var coverNote = $('[data-bought-cover]', note);
      if (coverNote) coverNote.hidden = state !== 'covered';
      note.hidden = false;
    });
  };

  P.initBoughtSummary = function (root) {
    $$('[data-bought-summary]', root || document).forEach(function (host) {
      if (bound(host, 'bought-summary')) return;

      var recs = boughtRecords();
      var keys = Object.keys(recs).filter(function (k) { return BOUGHT_TOKEN_RE.test(k); });
      if (!keys.length) return;

      var list = $('[data-bought-summary-list]', host);
      if (!list) return;

      // Clear the list first
      while (list.firstChild) list.removeChild(list.firstChild);

      // Get the labels element - it has all the data-bought-label-* attributes
      var labelsEl = $('[data-bought-summary-labels]', host);

      // Read formatting options from the host
      var datePrefix = attr(host, 'data-bought-summary-date-prefix') || '';
      var refPrefix = attr(host, 'data-bought-summary-ref-prefix') || '';
      var refSuffix = attr(host, 'data-bought-summary-ref-suffix') || '';
      var norefMsg = attr(host, 'data-bought-summary-noref') || '';

      var validCount = 0;
      keys.forEach(function (k) {
        // Get label: first from data-bought-summary-labels, then fallback to host, then token itself
        var label = '';
        if (labelsEl) label = attr(labelsEl, 'data-bought-label-' + k);
        if (!label) label = attr(host, 'data-bought-label-' + k);
        if (!label) label = k;

        var li = el('li');

        // Left label span
        var left = el('span', 'bought__label', label);
        li.appendChild(left);

        // Right meta span
        var meta = el('span', 'bought__meta');

        // Add date if we have a date prefix
        if (datePrefix) {
          var date = boughtDate(recs[k].t);
          if (date) {
            var dateSpan = el('span', 'bought__date', datePrefix + date);
            meta.appendChild(dateSpan);
          }
        }

        // Add reference or no-reference message
        var ref = recs[k].ref || '';
        if (ref) {
          var refSpan = el('span', 'bought__ref', refPrefix + ref + refSuffix);
          refSpan.setAttribute('aria-hidden', 'true');
          meta.appendChild(refSpan);

          // Copy button
          try {
            var btn = document.createElement('button');
            btn.setAttribute('type', 'button');
            btn.className = 'bought__copy';
            btn.setAttribute('data-copy', ref);
            btn.setAttribute('aria-label', 'Copy payment reference for ' + label);
            btn.textContent = 'Copy';
            meta.appendChild(btn);
          } catch (e) {
            // If button creation fails, fall back to text only
          }
        } else if (norefMsg) {
          var noRefSpan = el('span', 'bought__noref', norefMsg);
          meta.appendChild(noRefSpan);
        }

        li.appendChild(meta);
        list.appendChild(li);
        validCount++;
      });

      // Unhide the host only if we added at least one item
      if (validCount > 0) {
        host.hidden = false;

        // Append a minimal installer/support sentence into a <p class="muted"> inside
        // the host if present. This is defensive and idempotent: it checks for an
        // existing anchor linking to docs.html#installation or for a one-shot
        // attribute data-ssp-install-sent='on' on the host before appending.
        try {
          if (!host.getAttribute('data-ssp-install-sent')) {
            var pMuted = $('p.muted', host);
            var found = false;
            if (pMuted) {
              var anchors = pMuted.querySelectorAll('a');
              for (var i = 0; i < anchors.length; i++) {
                var h = anchors[i].getAttribute('href') || '';
                if (h.indexOf('docs.html#installation') !== -1) { found = true; break; }
              }
              if (!found) {
                pMuted.appendChild(document.createTextNode(' '));
                pMuted.appendChild(document.createTextNode('To get the installer or licence now, follow the delivery email we sent or visit the '));
                var a1 = document.createElement('a');
                a1.setAttribute('href', 'docs.html#installation');
                a1.textContent = 'installation page';
                pMuted.appendChild(a1);
                pMuted.appendChild(document.createTextNode(' (docs.html#installation); if something is missing, quote your payment reference on our '));
                var a2 = document.createElement('a');
                a2.setAttribute('href', 'docs.html#support');
                a2.textContent = 'Support page';
                pMuted.appendChild(a2);
                pMuted.appendChild(document.createTextNode(' (docs.html#support).'));
              }
            }
            host.setAttribute('data-ssp-install-sent', 'on');
          }
        } catch (e) { /* defensive: do not let this break page behaviour */ }

        // Initialise copy buttons if SS provides the helper. Guarded so missing UI
        // code does not break the page; failure is silent and the reference text
        // remains visible.
        try {
          if (SS && typeof SS.initCopyButtons === 'function') {
            SS.initCopyButtons(list);
          }
        } catch (e) { /* ignore */ }
      }
    });
  };

  P.init = function () {
    P.initDemoSlot();
    P.initPresetTeaser();
    P.initSectionNav();
    P.initTabs();
    P.initCounters();
    P.initBoughtNote();
    P.initBoughtSummary();
  };

  // Auto-run on DOM ready. Safe to call again.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', P.init);
  } else {
    setTimeout(P.init, 0);
  }

})(window, document);
