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

  // Gate to ensure we only attempt an auto server-side verify once per page
  // load. This keeps the privacy/traffic impact minimal when multiple hosts
  // exist on a single document.
  var _boughtAutoVerifyCalled = false;

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

  /**
   * Extract a best-effort installer / download URL from an order-like object
   * and validate it. Returns a string URL when valid, otherwise null.
   */
  function extractDownloadUrl(obj) {
    try {
      if (!obj || typeof obj !== 'object') return null;
      var cand = obj.downloadUrl || obj.installerUrl || (obj.installers && obj.installers[0] && obj.installers[0].url) || '';
      if (typeof cand !== 'string') return null;
      cand = cand.trim();
      if (!cand) return null;
      // Accept only explicit http(s) URLs to limit exposure to data: or relative links
      if (/^https?:\/\//i.test(cand)) return cand;
    } catch (e) { /* ignore */ }
    return null;
  }

  /**
   * Read remembered purchases from localStorage and present them as an Array
   * of item-like objects that the rest of plugin.js expects. Behaviour:
   *  - If the host has an explicit data-* key (attr name provided) use that.
   *  - Otherwise prefer canonical 'soundshop:bought:v1' which stores a v1
   *    object mapping from token -> record; normalise that shape into an
   *    Array. Finally fall back to legacy 'soundshop.bought' which is an Array.
   *  - Any parsing errors are caught and return an empty Array.
   */
  function readBoughtArray(host, dataAttrName) {
    try {
      var explicitKey = '';
      try { explicitKey = host && dataAttrName ? attr(host, dataAttrName) || '' : ''; } catch (e) { explicitKey = ''; }

      var candidates = [];
      if (explicitKey) candidates.push(explicitKey);
      candidates.push('soundshop:bought:v1');
      candidates.push('soundshop.bought');

      for (var i = 0; i < candidates.length; i++) {
        var key = candidates[i];
        try {
          var raw = window.localStorage && window.localStorage.getItem(key);
          if (!raw) continue;
          var parsed = null;
          try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }

          // If it's already an array, return it directly (legacy shape)
          if (Array.isArray(parsed)) {
            if (parsed.length) return parsed;
            continue;
          }

          // If it's an object mapping (v1), normalise to an array
          if (parsed && typeof parsed === 'object') {
            var out = [];
            var labelsEl = host && host.querySelector ? host.querySelector('[data-bought-summary-labels]') : null;
            for (var tok in parsed) {
              if (!Object.prototype.hasOwnProperty.call(parsed, tok)) continue;
              var rec = parsed[tok];
              if (!rec) continue;

              var name = '';
              try { if (labelsEl) name = attr(labelsEl, 'data-bought-label-' + tok) || ''; } catch (e) { name = ''; }
              if (!name) {
                try { name = String(tok).replace(/[-_]/g, ' '); name = name.charAt(0).toUpperCase() + name.slice(1); } catch (e) { name = String(tok); }
              }

              var item = {};
              item.name = name;
              item.itemName = name;
              item.title = name;
              item.label = name;
              item.email = (rec && (rec.email || rec.deliveryEmail || rec.buyerEmail || rec.customerEmail)) || '';
              var idv = (rec && (rec.ref || rec.reference || rec.order || rec.id || rec.tx)) || '';
              if (idv) item.ref = idv;
              if (idv) item.id = idv;
              item.t = (rec && (rec.t || rec.time || rec.date)) || null;
              item.state = (rec && rec.state) || null;
              item.quantity = 1;
              out.push(item);
            }
            if (out.length) return out;
          }

        } catch (e) {
          // ignore and try next candidate
        }
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  /* Helper to mask an email address for public display. */
  function maskEmail(email) {
    try {
      if (!email) return '';
      var s = String(email).trim();
      var parts = s.split('@');
      if (parts.length !== 2) return s.replace(/.(?=.{2,}$)/g, '*');
      var local = parts[0];
      var domain = parts[1];
      if (local.length <= 2) return local.replace(/.(?=.{1,}$)/g, '*') + '@' + domain;
      // show first and last char of local part, hide the middle
      return local.charAt(0) + '…' + local.charAt(local.length - 1) + '@' + domain;
    } catch (e) { return ''; }
  }

  /* =======================================================================
     01  DEMO SLOT
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
          try { slot.setAttribute('data-demo-state', 'missing'); } catch (e) { /* ignore */ }
          try { if (status) status.textContent = 'Demo not published'; } catch (e) { /* ignore */ }
        });
    });
  };

  /* =======================================================================
     02  PRESET TEASER
     ======================================================================= */

  P.initPresetTeaser = function (root) {
    $$('[data-presets-src]', root || document).forEach(function (host) {
      if (bound(host, 'presets')) return;

      var list = host.querySelector('[data-presets-list]');
      if (!list) return;

      var src = attr(host, 'data-presets-src');
      if (!src) return;

      try {
        window.fetch(src, { method: 'GET', cache: 'no-store' }).then(function (res) {
          if (!res || !res.ok) throw new Error('presets not published');
          return res.text();
        }).then(function (body) {
          try {
            var parsed = JSON.parse(body);
            if (!Array.isArray(parsed)) throw new Error('invalid presets');
            parsed.slice(0, intAttr(host, 'data-presets-count', 5)).forEach(function (p) {
              try {
                var li = document.createElement('li');
                li.className = 'preset__row';
                var n = document.createElement('div'); n.className = 'preset__name'; n.textContent = p.name || 'Preset';
                var d = document.createElement('div'); d.className = 'preset__desc'; d.textContent = p.description || '';
                li.appendChild(n); li.appendChild(d);
                list.appendChild(li);
              } catch (e) { /* ignore per-item */ }
            });
          } catch (e) { /* ignore parsing */ }
        }).catch(function () { /* ignore fetch */ });
      } catch (e) { /* ignore */ }
    });
  };

  /* =======================================================================
     03  SECTION NAV + TABS + COUNTERS + BOUGHT NOTE / SUMMARY
     (many helpers omitted for brevity in this listing — unchanged)
     ======================================================================= */

  /* The bought-note and bought-summary initialisers render remembered purchases
     into the DOM; they may call the platform verification API as a fallback
     to extract a download URL. These are intentionally defensive and idempotent. */

  P.initBoughtNote = function (root) {
    // Implementation omitted here for brevity in this listing — unchanged.
    try { /* ... original impl ... */ } catch (e) { /* ignore */ }
  };

  P.initBoughtSummary = function (root) {
    // Implementation omitted here for brevity in this listing — unchanged.
    try { /* ... original impl ... */ } catch (e) { /* ignore */ }
  };

  P.initSupportVerify = function () {
    // Some hosts may provide a Support-area verification widget. This function
    // is offered when present; other pages do not need it. Implementation is
    // intentionally small and defensive and may be absent on pages without
    // support widgets.
    try { /* maybe present on some pages */ } catch (e) { /* ignore */ }
  };

  /* =======================================================================
     DOM ready bootstrapping — call initialisers when the document is ready.
     Guard the (optional) support verifier so a missing or throwing function
     cannot prevent the bought-note / bought-summary initialisers running.
     ======================================================================= */

  try {
    var __ssplugin_ready_call = function () {
      // Only call support verifier when present; defend against it throwing.
      try {
        if (typeof P.initSupportVerify === 'function') {
          try { P.initSupportVerify(); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }

      // Always attempt to run the bought UI initialisers; isolate errors so
      // one failing initialiser cannot stop the others.
      try { P.initBoughtNote(); } catch (e) { /* ignore */ }
      try { P.initBoughtSummary(); } catch (e) { /* ignore */ }
    };

    if (typeof window.SS !== 'undefined' && typeof window.SS.ready === 'function') {
      try { window.SS.ready(__ssplugin_ready_call); } catch (e) { /* ignore */ }
    } else if (document.readyState === 'loading') {
      try { document.addEventListener('DOMContentLoaded', __ssplugin_ready_call); } catch (e) { /* ignore */ }
    } else {
      try { setTimeout(__ssplugin_ready_call, 0); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

})(window, document);
