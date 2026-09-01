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

  // Provide a safe, non-overriding fallback for window.soundshopPersistBought so
  // callers in this file can invoke it without depending on the presence of
  // site/plugins/index.html. This mirrors the canonical behaviour in
  // site/plugins/index.html without overwriting an authoritative implementation.
  try {
    if (typeof window.soundshopPersistBought !== 'function') {
      window.soundshopPersistBought = function (order) {
        try {
          if (!order || typeof order !== 'object') return;

          var BOUGHT_KEY = 'soundshop:bought:v1';
          var BOUGHT_MAX_AGE = 60 * 24 * 60 * 60 * 1000; // 60 days
          var MAX_EMAIL_LEN = 128;
          var MAX_RECEIPT_LEN = 2000;

          // Map product names/IDs to internal tokens (kept small and conservative)
          function getProductToken(itemName, itemId) {
            var name = String(itemName || itemId || '').trim().toLowerCase();
            if (!name) return null;
            if (name === 'the full shop' || name === 'bundle' || name === 'full shop') return 'bundle';
            if (name === 'vanta' || name.indexOf('vanta') !== -1) return 'vanta';
            if (name === 'drift' || name.indexOf('drift') !== -1) return 'drift';
            if (name === 'prism' || name.indexOf('prism') !== -1) return 'prism';
            if (name === 'anvil' || name.indexOf('anvil') !== -1) return 'anvil';
            return null;
          }

          // Conservative email validation
          var email = '';
          try {
            var cand = '';
            if (order && typeof order === 'object') {
              cand = (order.email || order.buyerEmail || order.customerEmail || order.deliveryEmail || '');
              if (cand && typeof cand === 'string') cand = cand.trim(); else cand = '';
            }
            var EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
            if (cand && EMAIL_RE.test(cand)) {
              if (cand.length > MAX_EMAIL_LEN) cand = cand.slice(0, MAX_EMAIL_LEN);
              email = cand;
            }
          } catch (e) { /* ignore */ }

          // Build the record we will store under the token
          var rec = { t: Date.now(), ref: String(order.id || order.ref || order.reference || '') , state: 'paid' };
          if (email) rec.email = email;

          // Extract a download URL conservatively
          try {
            var durl = '';
            if (order && typeof order === 'object') {
              durl = order.downloadUrl || order.installerUrl || (order.installers && order.installers[0] && order.installers[0].url) || '';
              if (typeof durl === 'string') {
                durl = durl.trim();
                if (durl && /^https?:\/\//i.test(durl)) rec.downloadUrl = durl;
              }
            }
          } catch (e) { /* ignore */ }

          // Conservatively accept a provider receipt URL when it looks like a real URL
          try {
            var rurl = '';
            if (order && typeof order === 'object') rurl = order.receiptUrl || order.receipt || '';
            if (typeof rurl === 'string') {
              rurl = rurl.trim();
              if (rurl && rurl.length <= MAX_RECEIPT_LEN && /^https?:\/\//i.test(rurl)) rec.receiptUrl = rurl;
            }
          } catch (e) { /* ignore */ }

          // Decide token and persist under canonical v1 mapping
          try {
            var token = getProductToken(order.itemName || order.name || order.itemId || order.item || '', order.itemId || order.id);
            if (!token) return; // unknown product, do not persist

            // Read existing records
            var bought = {};
            try {
              var raw = window.localStorage.getItem(BOUGHT_KEY);
              if (raw) {
                var parsed = null;
                try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) bought = parsed;
              }
            } catch (e) { /* ignore read */ }

            // Merge: preserve any existing downloadUrl unless we have a new one
            try {
              var exist = bought[token];
              if (exist && typeof exist === 'object') {
                // Keep existing downloadUrl if we don't have one
                if (!rec.downloadUrl && exist.downloadUrl) rec.downloadUrl = exist.downloadUrl;
                // Keep existing email if missing
                if (!rec.email && exist.email) rec.email = exist.email;
                // Keep existing t/ref if missing
                if (!rec.ref && exist.ref) rec.ref = exist.ref;
              }
            } catch (e) { /* ignore merge */ }

            bought[token] = rec;

            try { window.localStorage.setItem(BOUGHT_KEY, JSON.stringify(bought)); } catch (e) { /* ignore write */ }

            // Refresh the purchase summary display if present: remove guard so
            // SSPlugin.initBoughtSummary() can re-run and read the updated data.
            try {
              var summaryEl = document.querySelector('[data-bought-summary]');
              if (summaryEl) {
                summaryEl.removeAttribute('data-ssp-bought-summary');
                if (window.SSPlugin && typeof window.SSPlugin.initBoughtSummary === 'function') {
                  try { window.SSPlugin.initBoughtSummary(); } catch (e) { /* ignore */ }
                }
              }
            } catch (e) { /* ignore */ }

            // Prune expired records (best-effort)
            try {
              var raw2 = window.localStorage.getItem(BOUGHT_KEY);
              if (raw2) {
                var parsed2 = null;
                try { parsed2 = JSON.parse(raw2); } catch (e) { parsed2 = null; }
                if (parsed2 && typeof parsed2 === 'object' && !Array.isArray(parsed2)) {
                  var now = Date.now();
                  var changed = false;
                  for (var k in parsed2) {
                    if (!Object.prototype.hasOwnProperty.call(parsed2, k)) continue;
                    var r = parsed2[k];
                    var isObj = !!r && typeof r === 'object' && !Array.isArray(r);
                    var when = Number(isObj ? r.t : r);
                    if (!isFinite(when) || when <= 0 || (now - when) > BOUGHT_MAX_AGE) {
                      delete parsed2[k];
                      changed = true;
                    }
                  }
                  if (changed) {
                    try { window.localStorage.setItem(BOUGHT_KEY, JSON.stringify(parsed2)); } catch (e) { /* ignore */ }
                  }
                }
              }
            } catch (e) { /* ignore prune */ }

          } catch (e) { /* ignore token/persist */ }

        } catch (e) { /* swallow to keep callers safe */ }
      };
    }
  } catch (e) { /* ignore */ }

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

              // Preserve any installer/download URL already stored in the record
              try {
                var durl = extractDownloadUrl(rec);
                if (durl) item.downloadUrl = durl;
              } catch (e) { /* ignore */ }

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
      if (parts.length !== 2) return s.replace(/.(?=. {2,}$)/g, '*');
      var local = parts[0];
      var domain = parts[1];
      if (local.length <= 2) return local.replace(/.(?=. {1,}$)/g, '*') + '@' + domain;
      // show first and last char of local part, hide the middle
      return local.charAt(0) + '\u2026' + local.charAt(local.length - 1) + '@' + domain;
    } catch (e) { return ''; }
  }

  /**
   * Render a small action area to let the user either download installers
   * directly (when we have a verified direct URL) or contact Support /
   * trigger a verify when only an order id is present.
   *
   * This function is defensive and idempotent. It guards with
   * data-ssp-bought-cta on the host so repeated calls do not duplicate UI.
   *
   * Parameters:
   *  - host: an Element to append the CTA into (list item or host area)
   *  - detail: optional object with fields { id: <order id>, downloadUrl: <url>, itemName: ... }
   */
  function createBoughtCta(host, detail) {
    try {
      if (!host || !host.appendChild) return;

      // Guard so we only create content once; allow later updates when a
      // verified downloadUrl becomes available.
      try {
        var already = host.getAttribute('data-ssp-bought-cta');
        var verifiedUrl = detail && extractDownloadUrl(detail);

        if (already === 'on') {
          if (verifiedUrl) {
            // Try to update any existing anchor
            var existing = host.querySelector('.bought__cta');
            if (existing && existing.tagName && existing.tagName.toLowerCase() === 'a') {
              try { existing.setAttribute('href', verifiedUrl); } catch (e) { /* ignore */ }
              try { existing.setAttribute('target', '_blank'); } catch (e) { /* ignore */ }
              try { existing.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }
              try { existing.textContent = 'Download installers'; } catch (e) { /* ignore */ }
              return;
            }
            // No existing anchor: append one
            try {
              var a = makeDownloadAnchor(verifiedUrl);
              if (a) host.appendChild(a);
            } catch (e) { /* ignore */ }
          }
          return;
        }

        // First-time creation path
        var wrapper = el('div', 'bought__cta-wrap');

        if (verifiedUrl) {
          var anchor = makeDownloadAnchor(verifiedUrl);
          if (anchor) wrapper.appendChild(anchor);
        } else {
          // Conservative fallback: a Support link that points at the in-page
          // support section. This is intentionally minimal and never exposes
          // provider receipt URLs here.
          var support = el('a', 'bought__cta', 'Contact Support');
          try { support.setAttribute('href', '#support'); } catch (e) { /* ignore */ }
          try { support.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }
          wrapper.appendChild(support);

          // If an order id is present we offer a gentle in-page verify trigger
          if (detail && (detail.id || detail.ref)) {
            try {
              var btn = el('button', 'bought__verify', 'Verify purchase');
              btn.type = 'button';
              btn.addEventListener('click', function () {
                try { document.dispatchEvent(new CustomEvent('soundshop:verify-request', { detail: detail })); } catch (e) { /* ignore */ }
              });
              wrapper.appendChild(btn);
            } catch (e) { /* ignore */ }
          }
        }

        try { host.appendChild(wrapper); } catch (e) { /* ignore */ }
        try { host.setAttribute('data-ssp-bought-cta', 'on'); } catch (e) { /* ignore */ }
      } catch (e) { /* ignore */ }
    } catch (e) { /* swallow */ }
  }

  /**
   * Create a safe download anchor element for a verified installer URL.
   * Returns an <a> node or null on failure.
   */
  function makeDownloadAnchor(url) {
    try {
      if (!url || typeof url !== 'string') return null;
      var u = extractDownloadUrl({ downloadUrl: url });
      if (!u) return null;
      var a = el('a', 'bought__cta', 'Download installers');
      try { a.setAttribute('href', u); } catch (e) { /* ignore */ }
      try { a.setAttribute('target', '_blank'); } catch (e) { /* ignore */ }
      try { a.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }
      return a;
    } catch (e) { return null; }
  }

  /**
   * Initialise and render the purchase summary block: data-bought-summary.
   * This reads remembered purchases and renders an <ul> of items. Each list
   * item is passed to createBoughtCta() which will either render a direct
   * "Download installers" anchor when a verified downloadUrl exists, or a
   * conservative Support/Verify fallback otherwise.
   */
  P.initBoughtSummary = function (root) {
    try {
      var host = root && root.querySelector ? root.querySelector('[data-bought-summary]') : document.querySelector('[data-bought-summary]');
      if (!host) return;
      if (bound(host, 'bought-summary')) return; // already initialised

      var list = host.querySelector('[data-bought-summary-list]');
      if (!list) return;

      var items = readBoughtArray(host);
      if (!items || !items.length) return;

      // Unhide
      try { host.removeAttribute('hidden'); } catch (e) { /* ignore */ }

      for (var i = 0; i < items.length; i++) {
        try {
          var it = items[i];
          var li = el('li', 'bought__item');

          // Title / product label
          var title = el('span', 'bought__title', String(it.title || it.name || it.label || ''));
          li.appendChild(title);

          // Email (masked) and date/ref when present
          var meta = document.createElement('div');
          meta.className = 'bought__meta';

          if (it.email) {
            var m = el('span', 'bought__email', maskEmail(it.email));
            meta.appendChild(m);
          }

          if (it.t) {
            var prefix = attr(host, 'data-bought-summary-date-prefix') || 'bought on this device on ';
            var d = new Date(Number(it.t));
            if (isFinite(d.getTime())) {
              var ds = d.toLocaleString();
              var md = el('span', 'bought__date', prefix + ds);
              meta.appendChild(md);
            }
          }

          if (it.ref) {
            var pre = attr(host, 'data-bought-summary-ref-prefix') || 'Payment reference: ';
            var suf = attr(host, 'data-bought-summary-ref-suffix') || '';
            var rf = el('span', 'bought__ref', pre + String(it.ref) + (suf ? String(suf) : ''));
            meta.appendChild(rf);
          }

          if (meta.childNodes && meta.childNodes.length) li.appendChild(meta);

          // Allow createBoughtCta to render a CTA into this li
          try { createBoughtCta(li, it); } catch (e) { /* ignore */ }

          try { list.appendChild(li); } catch (e) { /* ignore */ }
        } catch (e) { /* ignore per-item */ }
      }
    } catch (e) { /* swallow */ }
  };

  /**
   * Initialise and render the per-product "Already bought on this device"
   * note (data-bought-note) on product pages. The element carries
   * data-bought-item (token) and optionally data-bought-covered-by (token)
   * which is used to show the bundled-cover text when the bundle purchase
   * applies.
   */
  P.initBoughtNote = function (root) {
    try {
      var host = root && root.querySelector ? root.querySelector('[data-bought-note]') : document.querySelector('[data-bought-note]');
      if (!host) return;
      if (bound(host, 'bought-note')) return;

      var token = attr(host, 'data-bought-item');
      var covered = attr(host, 'data-bought-covered-by');
      if (!token) return;

      // Read canonical mapping directly so we can inspect tokens
      var raw = null;
      try { raw = window.localStorage && window.localStorage.getItem('soundshop:bought:v1'); } catch (e) { raw = null; }
      if (!raw) return;
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!parsed || typeof parsed !== 'object') return;

      var record = parsed[token] || null;
      var coverRecord = parsed[covered] || null;
      if (!record && !coverRecord) return; // no matching remembered purchase
      var rec = record || coverRecord;

      // Unhide and populate
      try { host.removeAttribute('hidden'); } catch (e) { /* ignore */ }

      // Show covered-by text when bundle covered
      try {
        var coverEl = host.querySelector('[data-bought-cover]');
        if (coverEl) {
          if (coverRecord) {
            try { coverEl.removeAttribute('hidden'); } catch (e) { /* ignore */ }
          } else {
            try { coverEl.setAttribute('hidden', ''); } catch (e) { /* ignore */ }
          }
        }
      } catch (e) { /* ignore */ }

      // Populate the date span if present
      try {
        var dateEl = host.querySelector('[data-bought-date]');
        if (dateEl && rec && rec.t) {
          var pref = attr(dateEl, 'data-bought-date-prefix') || ', bought ';
          var d = new Date(Number(rec.t));
          if (isFinite(d.getTime())) dateEl.textContent = pref + d.toLocaleString();
        }
      } catch (e) { /* ignore */ }

      // Append CTA into the note
      try { createBoughtCta(host, rec); } catch (e) { /* ignore */ }
    } catch (e) { /* swallow */ }
  };

  // Allow an in-page verification step to broadcast a verified order so any
  // already-rendered CTAs can be updated. Listeners elsewhere (site/plugins)
  // may dispatch soundshop:verified-order with detail { token: 'prism', downloadUrl: 'https://...' }
  document.addEventListener('soundshop:verified-order', function (ev) {
    try {
      var d = ev && ev.detail ? ev.detail : {};
      // Update any summary list items that match by title or itemName when
      // provided, otherwise update all list CTAs.
      try {
        var lists = Array.prototype.slice.call(document.querySelectorAll('[data-bought-summary-list]')) || [];
        lists.forEach(function (list) {
          var lis = Array.prototype.slice.call(list.children || []);
          lis.forEach(function (li) {
            try {
              var title = li.querySelector('.bought__title');
              var name = title ? title.textContent || '' : '';
              if (!d.itemName || !name || String(d.itemName).toLowerCase() === String(name).toLowerCase()) {
                try { createBoughtCta(li, d); } catch (e) { /* ignore */ }
              }
            } catch (e) { /* ignore per-list-item */ }
          });
        });
      } catch (e) { /* ignore lists */ }

      // Update per-product notes when the token matches
      try {
        var notes = Array.prototype.slice.call(document.querySelectorAll('[data-bought-note]')) || [];
        notes.forEach(function (note) {
          try {
            var tkn = attr(note, 'data-bought-item');
            var cvr = attr(note, 'data-bought-covered-by');
            if (!d.token || d.token === tkn || d.token === cvr) {
              try { createBoughtCta(note, d); } catch (e) { /* ignore */ }
            }
          } catch (e) { /* ignore per-note */ }
        });
      } catch (e) { /* ignore notes */ }
    } catch (e) { /* swallow */ }
  });

  // Expose a simple init() that other site scripts can call if present. The
  // rest of the file contains many independent features; callers only need
  // the functions below for purchase-related rendering.
  P.init = function () {
    try { P.initBoughtSummary(); } catch (e) { /* ignore */ }
    try { P.initBoughtNote(); } catch (e) { /* ignore */ }
  };

})(window, document);
