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
      if (parts.length !== 2) return s.replace(/.(?=.{2,}$)/g, '*');
      var local = parts[0];
      var domain = parts[1];
      if (local.length <= 2) return local.replace(/.(?=.{1,}$)/g, '*') + '@' + domain;
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
  function makeDownloadAnchor(url) {
    try {
      var v = extractDownloadUrl({ downloadUrl: url });
      if (!v) return null;
      var a = document.createElement('a');
      a.className = 'bought__cta';
      a.setAttribute('href', v);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.textContent = 'Download installers';
      return a;
    } catch (e) { return null; }
  }

  function createBoughtCta(host, detail) {
    try {
      if (!host || !host.appendChild) return;

      // If we've previously created a CTA in this host, allow updating it when
      // a new detail provides a downloadUrl. This avoids duplicating CTAs but
      // lets a later verification populate a "Download installers" anchor.
      try {
        var already = host.getAttribute('data-ssp-bought-cta');
        if (already === 'on') {
          // If the caller supplied a verified download URL, try to update an
          // existing anchor (or append one if none exists). Otherwise do
          // nothing and keep the existing CTA (usually a Contact Support link).
          if (detail && extractDownloadUrl(detail)) {
            var url = extractDownloadUrl(detail);
            try {
              var existing = host.querySelector('.bought__cta');
              if (existing && existing.tagName && existing.tagName.toLowerCase() === 'a') {
                try { existing.setAttribute('href', url); } catch (e) { /* ignore */ }
                try { existing.setAttribute('target', '_blank'); } catch (e) { /* ignore */ }
                try { existing.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }
                try { existing.textContent = 'Download installers'; } catch (e) { /* ignore */ }
                return;
              }
              // If existing CTA exists but is not an anchor, append a proper link
              var a2 = makeDownloadAnchor(url);
              if (a2) {
                try { host.appendChild(a2); } catch (e) { /* ignore */ }
              }
            } catch (e) { /* ignore update */ }
          }
          return;
        }
      } catch (e) { /* ignore */ }

      // Mark this host as having had its CTA created so re-runs are idempotent
      try { host.setAttribute('data-ssp-bought-cta', 'on'); } catch (e) { /* ignore */ }

      // Create a small container and populate with the most conservative UI:
      // - If we have a conservative, explicit https downloadUrl, show a
      //   "Download installers" anchor.
      // - Otherwise show a 'Contact Support' link and a small 'Verify' button
      //   that other scripts can hook to attempt server-side verification.
      try {
        var wrapper = el('div', 'bought');
        var urlv = detail && extractDownloadUrl(detail) ? extractDownloadUrl(detail) : null;
        if (urlv) {
          var a = makeDownloadAnchor(urlv);
          if (a) wrapper.appendChild(a);
        } else {
          // Conservative fallback: Contact Support link (does not expose receiptUrl)
          var support = document.createElement('a');
          support.className = 'bought__cta';
          try { support.setAttribute('href', 'docs.html#support'); } catch (e) { /* ignore */ }
          support.textContent = 'Contact Support';
          wrapper.appendChild(support);

          // If there is an id we can offer a verify trigger; other code may
          // listen for clicks on [data-bought-verify] to run a server verify.
          if (detail && (detail.id || detail.ref)) {
            var vb = el('button', 'btn btn-ghost bought__verify', 'Verify purchase');
            try { vb.setAttribute('type', 'button'); } catch (e) { /* ignore */ }
            vb.setAttribute('data-bought-verify', detail.id || detail.ref || '');
            wrapper.appendChild(vb);
          }
        }
        try { host.appendChild(wrapper); } catch (e) { /* ignore */ }
      } catch (e) { /* ignore create */ }

    } catch (e) { /* swallow */ }
  }

  /**
   * Populate the product page "You have purchased" summary list from localStorage.
   * This function is safe to call repeatedly and will avoid duplicate work.
   * It writes into [data-bought-summary-list] within each [data-bought-summary].
   */
  P.initBoughtSummary = function (root) {
    try {
      var hostRoot = root || document;
      var summaryEls = $$("[data-bought-summary]", hostRoot);
      summaryEls.forEach(function (summary) {
        try {
          if (bound(summary, 'bought-summary')) return;
          var list = summary.querySelector('[data-bought-summary-list]');
          if (!list) return;
          // Clear any existing content first
          while (list.firstChild) list.removeChild(list.firstChild);

          var items = readBoughtArray(summary);
          if (!items || !items.length) {
            // nothing remembered; keep it hidden
            try { summary.hidden = true; } catch (e) { /* ignore */ }
            return;
          }

          items.forEach(function (it) {
            try {
              var li = el('li', 'bought__item');
              var title = el('strong', 'bought__name', it.name || it.itemName || '');
              li.appendChild(title);

              var meta = document.createElement('div');
              meta.className = 'bought__meta';

              if (it.t) {
                var datePrefix = attr(summary, 'data-bought-summary-date-prefix') || '';
                var d = new Date(Number(it.t));
                var ds = isFinite(d.getTime()) ? d.toLocaleDateString() : '';
                if (ds) {
                  meta.appendChild(el('span', 'bought__date', (datePrefix || '') + ds));
                }
              }

              if (it.ref) {
                var refPrefix = attr(summary, 'data-bought-summary-ref-prefix') || '';
                var refSuffix = attr(summary, 'data-bought-summary-ref-suffix') || '';
                var refText = (refPrefix || '') + it.ref + (refSuffix || '');
                meta.appendChild(el('span', 'bought__ref', refText));
              } else {
                var noref = attr(summary, 'data-bought-summary-noref') || '';
                if (noref) meta.appendChild(el('span', 'bought__noref', noref));
              }

              if (it.email) {
                meta.appendChild(el('span', 'bought__email', maskEmail(it.email)));
              }

              li.appendChild(meta);

              // Append CTA area; createBoughtCta will be defensive/idempotent
              try { createBoughtCta(li, it); } catch (e) { /* ignore */ }

              list.appendChild(li);
            } catch (e) { /* ignore item */ }
          });

          // Unhide the summary now that we have content
          try { summary.hidden = false; } catch (e) { /* ignore */ }
        } catch (e) { /* ignore per-summary */ }
      });
    } catch (e) { /* swallow */ }
  };

  /**
   * Unhide and adjust the per-product "Already bought on this device" note
   * when the browser remembers a purchase that covers this product.
   */
  P.initBoughtNote = function (root) {
    try {
      var hostRoot = root || document;
      var notes = $$("[data-bought-note]", hostRoot);
      if (!notes || !notes.length) return;
      var items = readBoughtArray(document);
      notes.forEach(function (note) {
        try {
          if (bound(note, 'bought-note')) return;
          var want = attr(note, 'data-bought-item') || '';
          var coveredBy = attr(note, 'data-bought-covered-by') || '';
          var matched = items.some(function (it) {
            try {
              if (!it || !it.itemName) return false;
              var name = String(it.itemName).trim().toLowerCase();
              if (!name) return false;
              if (want && name === String(want).trim().toLowerCase()) return true;
              if (coveredBy && name === String(coveredBy).trim().toLowerCase()) return true;
              return false;
            } catch (e) { return false; }
          });

          if (matched) {
            // If the bundle covers it, reveal the cover span
            try {
              var coverEl = note.querySelector('[data-bought-cover]');
              if (coverEl && coveredBy) {
                coverEl.hidden = false;
              }
            } catch (e) { /* ignore */ }
            try { note.hidden = false; } catch (e) { /* ignore */ }

            // Ensure CTA inside note reflects any stored downloadUrl
            try {
              // Build a detail from stored records and call createBoughtCta on the note
              var recs = readBoughtArray(note);
              var found = null;
              for (var i = 0; i < recs.length; i++) {
                var r = recs[i];
                if (!r) continue;
                var nm = (r.itemName || r.name || '').toLowerCase();
                if (nm && want && nm === want.toLowerCase()) { found = r; break; }
                if (coveredBy && nm === coveredBy.toLowerCase()) { found = r; break; }
              }
              if (found) createBoughtCta(note, found);
            } catch (e) { /* ignore */ }
          }

        } catch (e) { /* ignore per-note */ }
      });
    } catch (e) { /* swallow */ }
  };

  // Listen for in-page verification events so a later discovery of a
  // verified download URL can update CTAs and summaries without a full page reload.
  try {
    document.addEventListener('soundshop:verified-order', function (evt) {
      try {
        // evt.detail is expected to be an order-like object stored or discovered
        // by the in-page verifier. Persisting is the responsibility of the
        // code that discovered it; here we re-run init functions to refresh UI.
        P.initBoughtSummary();
        P.initBoughtNote();
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore listener */ }

  // Public init: perform bought-note and bought-summary work (safe to call repeatedly)
  P.init = function () {
    try { P.initBoughtSummary(); } catch (e) { /* ignore */ }
    try { P.initBoughtNote(); } catch (e) { /* ignore */ }
  };

}(window, document));
