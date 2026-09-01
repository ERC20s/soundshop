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
          // BOUGHT_MAX_AGE is shared with readBoughtArray below; see the
          // declaration near the helpers so both read and write paths agree on
          // the 60-day local retention policy.
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

  // One-shot guard for the URL-order verify banner/fetch path. Ensures we
  // attempt the conservative fallback only once per page load.
  var _sspUrlOrderVerifyDone = false;

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

  // BOUGHT_MAX_AGE: 60 days in milliseconds. Hoisted so both the read and
  // write paths in this file share the same retention policy and pruning logic.
  var BOUGHT_MAX_AGE = 60 * 24 * 60 * 60 * 1000;

  function readBoughtArray() {
    try {
      var raw = '';
      try { raw = window.localStorage.getItem('soundshop:bought:v1') || ''; } catch (e) { raw = ''; }
      if (!raw) return {};
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

      var now = Date.now();
      var changed = false;
      for (var k in parsed) {
        if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue;
        var r = parsed[k];
        var isObj = !!r && typeof r === 'object' && !Array.isArray(r);
        var when = Number(isObj ? r.t : r);
        if (!isFinite(when) || when <= 0 || (now - when) > BOUGHT_MAX_AGE) {
          delete parsed[k];
          changed = true;
        }
      }
      if (changed) {
        try { window.localStorage.setItem('soundshop:bought:v1', JSON.stringify(parsed)); } catch (e) { }
      }
      return parsed;
    } catch (e) { return {}; }
  }

  function maskEmail(e) {
    try {
      if (!e || typeof e !== 'string') return '';
      var p = String(e).split('@');
      if (!p || p.length !== 2) return '';
      var left = p[0] || '';
      if (left.length <= 2) left = left[0] + '…'; else left = left[0] + '…' + left.slice(-1);
      return left + '@' + p[1];
    } catch (err) { return ''; }
  }

  function extractDownloadUrl(o) {
    try {
      if (!o || typeof o !== 'object') return '';
      var u = o.downloadUrl || o.installerUrl || (o.installers && o.installers[0] && o.installers[0].url) || '';
      if (typeof u !== 'string') return '';
      u = u.trim();
      if (!u) return '';
      if (!/^https?:\/\//i.test(u)) return '';
      return u;
    } catch (e) { return ''; }
  }

  function createBoughtCta(hostEl, record) {
    try {
      if (!hostEl || !record || typeof record !== 'object') return null;

      // One-shot guard: avoid appending duplicate CTA markup when callers
      // may invoke createBoughtCta multiple times against the same hostEl.
      if (bound(hostEl, 'bought-cta')) return null;

      var wrapper = el('div', 'bought-summary__ctas__wrap');
      var hasCta = false;

      // If we have a download URL already, expose it
      try {
        if (record.downloadUrl) {
          var a = el('a', 'button button--primary', 'Download');
          a.href = String(record.downloadUrl);
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          wrapper.appendChild(a);
          hasCta = true;
        }
      } catch (e) { /* ignore */ }

      // If we have a provider receipt URL, expose it as a muted CTA
      try {
        var r = record.receiptUrl || record.receipt || '';
        if (typeof r === 'string') {
          r = r.trim();
          if (r && /^https?:\/\//i.test(r)) {
            var receiptA = el('a', 'button button--muted', 'Receipt');
            receiptA.href = String(r);
            receiptA.target = '_blank';
            receiptA.rel = 'noopener noreferrer';
            wrapper.appendChild(receiptA);
            hasCta = true;
          }
        }
      } catch (e) { /* ignore */ }

      // Show a Verify & reveal button when we have a reference but no URL
      try {
        var hasRef = !!record.ref;
        var hasUrl = !!record.downloadUrl;
        if (hasRef && !hasUrl && typeof window.groupStoreVerify === 'function') {
          var verifyBtn = el('button', 'button', 'Verify & reveal');
          verifyBtn.type = 'button';
          try { verifyBtn.addEventListener('click', function () {
            try {
              var ref = String(record.ref || '').trim();
              if (!ref) return;
              if (verifyBtn.disabled) return;
              verifyBtn.disabled = true;
              var originalLabel = verifyBtn.textContent;
              verifyBtn.textContent = 'Checking…';

              window.groupStoreVerify(ref).then(function (o) {
                try {
                  if (!o) return;
                  if (typeof window.soundshopPersistBought === 'function') {
                    try { window.soundshopPersistBought(o); } catch (e) { /* ignore */ }
                  }

                  // Notify other codepaths
                  try { document.dispatchEvent(new CustomEvent('group-store:paid', { detail: o })); } catch (e) { /* ignore */ }
                } catch (e) { /* ignore result handling */ }
              }).catch(function () { /* ignore network errors */ });

            } catch (e) { /* ignore click handler */ }
          }); } catch (e) { /* ignore event binding */ }
        }
      } catch (e) { /* ignore */ }

      return wrapper;
    } catch (e) { return null; }
  }

  // New public helper: show a small, conservative banner when the page URL
  // contains ?d8a_order=<id> and the bought-summary UI currently lacks a
  // download link. The banner offers the user a single "Verify & reveal"
  // button that runs window.groupStoreVerify(id) and, on a paid response,
  // persists the returned order via window.soundshopPersistBought and
  // dispatches the existing group-store:paid event so the UI can refresh.
  function initUrlOrderVerifyBanner() {
    try {
      // If we've already inserted or attempted this path on this page load,
      // don't insert another banner.
      // Note: bound(host, ...) will guard per-host; the _sspUrlOrderVerifyDone
      // flag prevents repeated network calls once the user clicks.

      var m = (location.search || '').match(/[?&]d8a_order=([A-Za-z0-9_-]+)/);
      var orderId = m && m[1];
      if (!orderId) return;

      var host = document.querySelector('[data-bought-summary]');
      if (!host) host = document.querySelector('main') || document.body;
      if (!host) return;

      // Avoid adding the banner twice against the same host
      if (bound(host, 'url-order-verify-banner')) return;

      // Build banner
      var banner = el('div', 'ssp-url-order-verify');
      banner.style.cssText = 'border:1px solid #e6e6e6;padding:10px;margin:0 0 12px;background:#fff;font:13px system-ui,sans-serif;display:flex;align-items:center;gap:12px';
      var text = el('div', '', 'We detected an order reference in the URL. Click to verify and reveal any downloads.');
      text.style.flex = '1';
      var btn = el('button', 'button', 'Verify & reveal');
      btn.type = 'button';

      // If no verifier is present, disable the control
      if (typeof window.groupStoreVerify !== 'function') {
        btn.disabled = true;
        btn.title = 'Verification unavailable';
      }

      btn.addEventListener('click', function () {
        try {
          if (!orderId) return;
          if (btn.disabled) return;
          if (_boughtAutoVerifyCalled || _sspUrlOrderVerifyDone) return;
          _boughtAutoVerifyCalled = true;
          _sspUrlOrderVerifyDone = true;

          btn.disabled = true;
          var orig = btn.textContent;
          btn.textContent = 'Checking…';

          window.groupStoreVerify(orderId).then(function (o) {
            try {
              if (!o) {
                btn.textContent = 'Not found';
                setTimeout(function () { try { btn.textContent = orig; btn.disabled = false; _sspUrlOrderVerifyDone = false; _boughtAutoVerifyCalled = false; } catch (e) {} }, 2500);
                return;
              }

              if (typeof window.soundshopPersistBought === 'function') {
                try { window.soundshopPersistBought(o); } catch (e) { /* ignore */ }
              }

              try { document.dispatchEvent(new CustomEvent('group-store:paid', { detail: o })); } catch (e) { /* ignore */ }

              // Indicate success and remove the banner after a moment
              btn.textContent = 'Verified';
              setTimeout(function () { try { if (banner && banner.parentNode) banner.parentNode.removeChild(banner); } catch (e) {} }, 800);

            } catch (e) {
              // On unexpected error, re-enable so user may retry
              try { btn.textContent = orig; btn.disabled = false; _sspUrlOrderVerifyDone = false; _boughtAutoVerifyCalled = false; } catch (ee) {}
            }
          }).catch(function () {
            try { btn.textContent = 'Try again'; btn.disabled = false; _sspUrlOrderVerifyDone = false; _boughtAutoVerifyCalled = false; } catch (e) {}
          });

        } catch (e) { /* ignore click */ }
      });

      banner.appendChild(text);
      banner.appendChild(btn);

      // Insert the banner at the start of the host
      try {
        if (host.firstChild) host.insertBefore(banner, host.firstChild); else host.appendChild(banner);
      } catch (e) { /* ignore DOM insertion */ }

    } catch (e) { /* safe no-op */ }
  }

  // Export the helper
  P.initUrlOrderVerifyBanner = initUrlOrderVerifyBanner;

  // Expose helpers used elsewhere
  P.extractDownloadUrl = extractDownloadUrl;
  P.readBoughtArray = readBoughtArray;
  P.maskEmail = maskEmail;
  P.createBoughtCta = createBoughtCta;

})(window, document);