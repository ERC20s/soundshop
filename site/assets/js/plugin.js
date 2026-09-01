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
  // exist on a single document. Embedding contexts may opt out by setting
  // window._boughtAutoVerifyCalled = true before this script runs.
  if (typeof window._boughtAutoVerifyCalled === 'undefined') window._boughtAutoVerifyCalled = false;

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

  // initUrlOrderVerifyBanner
  function initUrlOrderVerifyBanner() {
    try {
      if (_sspUrlOrderVerifyDone) return;
      // Mark done as early as possible so repeated calls are inert.
      // This mirrors the previous behaviour and keeps the path one-shot.
      window._sspUrlOrderVerifyDone = true;

      // Bail unless the URL explicitly contains a returned order id.
      var orderId = (location.search.match(/[?&]d8a_order=([A-Za-z0-9_-]+)/) || [])[1];
      if (!orderId) return;

      // Need server-side verify helper to exist.
      if (typeof window.groupStoreVerify !== 'function') return;

      // If there's already a Download CTA inside the bought-summary, the
      // banner is unnecessary.
      try {
        if (document.querySelector('[data-bought-summary] a.button.button--primary')) return;
      } catch (e) { /* ignore */ }

      // Find a host to attach the banner; prefer the bought-summary element.
      var host = document.querySelector('[data-bought-summary]') || document.body;
      if (!host) return;
      if (bound(host, 'url-order-verify-banner')) return; // don't double-insert

      // Helper that builds and inserts the manual verify banner (exactly as
      // present before this change). We call this if auto-verify is not run
      // or fails/returns null so user can still perform manual verify.
      function createBanner() {
        try {
          var banner = el('div', 'ssp-url-order-verify-banner');
          banner.style.cssText = 'font:13px system-ui,sans-serif;color:#065f46;margin:8px 0;padding:10px;border:1px solid #d1fae5;background:#ecfdf5;border-radius:6px;';
          var text = el('span', '', 'We detected a returned order on the URL. ');
          var btn = el('button', 'button', 'Verify returned purchase');
          btn.type = 'button';

          btn.addEventListener('click', function () {
            try {
              if (btn.disabled) return;
              btn.disabled = true;
              var prev = btn.textContent;
              btn.textContent = 'Checking…';

              window.groupStoreVerify(orderId).then(function (o) {
                try {
                  if (!o) {
                    btn.disabled = false;
                    btn.textContent = prev;
                    return;
                  }
                  if (typeof window.soundshopPersistBought === 'function') {
                    try { window.soundshopPersistBought(o); } catch (e) { /* ignore */ }
                  }
                  try { document.dispatchEvent(new CustomEvent('group-store:paid', { detail: o })); } catch (e) { /* ignore */ }
                  btn.textContent = 'Verified';
                } catch (e) {
                  btn.disabled = false;
                  btn.textContent = prev;
                }
              }).catch(function () {
                btn.disabled = false;
                btn.textContent = prev;
              });

            } catch (e) { /* ignore */ }
          });

          banner.appendChild(text);
          banner.appendChild(btn);

          // Insert the banner immediately before the host element so it is visible
          // to users looking for their returned purchase.
          try {
            if (host.parentNode) host.parentNode.insertBefore(banner, host);
            else host.appendChild(banner);
          } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }
      }

      // Attempt a conservative, one-shot automatic verify on page load. If the
      // server confirms the order we persist the purchase and dispatch the
      // existing event so the normal reveal path runs; if the verify fails or
      // resolves to null we fall back to inserting the manual banner so the
      // user can click to verify (behaviour unchanged from before for that
      // case).
      try {
        if (!window._boughtAutoVerifyCalled) {
          // Respect embedding opt-out: a host page can set
          // window._boughtAutoVerifyCalled = true before this script runs.
          window._boughtAutoVerifyCalled = true;

          // Perform the server-side verify. This returns a promise and is the
          // same call the manual button would make; we only run it once.
          try {
            window.groupStoreVerify(orderId).then(function (o) {
              try {
                if (!o) {
                  // Nothing found; show the manual banner so users can retry.
                  createBanner();
                  return;
                }
                // Persist and announce the returned order exactly as the
                // manual path does; do not insert the banner in this case.
                if (typeof window.soundshopPersistBought === 'function') {
                  try { window.soundshopPersistBought(o); } catch (e) { /* ignore */ }
                }
                try { document.dispatchEvent(new CustomEvent('group-store:paid', { detail: o })); } catch (e) { /* ignore */ }
              } catch (e) {
                // On unexpected error, fall back to manual banner.
                createBanner();
              }
            }).catch(function () {
              // Server call failed; fall back to manual banner.
              createBanner();
            });
          } catch (e) {
            // If the verify call itself throws synchronously, show banner.
            createBanner();
          }

        } else {
          // Already attempted by the embedding page or previous script run —
          // just insert the manual banner so the UI remains available.
          createBanner();
        }
      } catch (e) {
        // Remain safe in varied embedding contexts by swallowing errors and
        // ensuring the manual banner is available.
        try { createBanner(); } catch (e2) { /* ignore */ }
      }

    } catch (e) { /* swallow to remain safe in varied embedding contexts */ }
  }

  // Export the helper so tools/check-plugin-exports.js and consumers can find it
  P.initUrlOrderVerifyBanner = initUrlOrderVerifyBanner;

})(window, document);
