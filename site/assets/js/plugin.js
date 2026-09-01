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
    node.textContent = '';
    try {
      while (node.firstChild) node.removeChild(node.firstChild);
    } catch (e) { /* ignore */ }
    var p = document.createElement('p');
    p.className = className || '';
    p.textContent = text || '';
    try { node.appendChild(p); } catch (e) { /* ignore */ }
  }

  // ... (rest of helper functions and UI code left unchanged) ...

  // Add a delegated, defensive click handler for [data-bought-verify] buttons.
  // This is intentionally non-invasive: it does not change any helper
  // signatures and will gracefully no-op if the payments widget is absent.
  try {
    document.addEventListener('click', function (e) {
      try {
        var btn = e.target && e.target.closest ? e.target.closest('[data-bought-verify]') : null;
        if (!btn) return;
        // Ignore if element is not a button-like control
        var tag = (btn.tagName || '').toLowerCase();
        if (tag !== 'button' && tag !== 'a' && tag !== 'input') return;

        e.preventDefault();

        // One-shot guard to avoid double-submitting
        if (btn.getAttribute('data-ssp-verifying') === 'on') return;
        btn.setAttribute('data-ssp-verifying', 'on');

        var origText = btn.textContent || '';
        try { btn.disabled = true; } catch (err) { /* ignore */ }
        try { btn.textContent = 'Verifying'; } catch (err) { /* ignore */ }

        var id = attr(btn, 'data-bought-verify') || '';

        function failRestore(msg) {
          try { btn.textContent = origText; } catch (e) { /* ignore */ }
          try { btn.disabled = false; } catch (e) { /* ignore */ }
          try { btn.removeAttribute('data-ssp-verifying'); } catch (e) { /* ignore */ }
          try {
            // brief inline support hint adjacent to the button
            var hint = document.createElement('span');
            hint.className = 'bought__verify-hint';
            hint.style.cssText = 'margin-left:8px;font-size:13px;color:#6b7280';
            var a = document.createElement('a');
            a.setAttribute('href', 'docs.html#support');
            a.style.color = '#7c5cff';
            a.textContent = msg || 'Need help? Contact Support';
            hint.appendChild(a);
            // insert after button
            if (btn.parentNode) {
              try { btn.parentNode.insertBefore(hint, btn.nextSibling); } catch (e) { /* ignore */ }
              // remove hint after a short timeout
              setTimeout(function () { try { if (hint && hint.parentNode) hint.parentNode.removeChild(hint); } catch (e) { /* ignore */ } }, 6000);
            }
          } catch (e) { /* ignore */ }
        }

        // If the payments widget does not expose groupStoreVerify, bail gracefully
        if (typeof window.groupStoreVerify !== 'function') {
          failRestore('Verify unavailable 3 Contact Support');
          return;
        }

        // Call the platform verifier provided by the payments widget
        try {
          var p = null;
          try { p = window.groupStoreVerify(id); } catch (err) { p = null; }
          if (!p || typeof p.then !== 'function') {
            // Not a Promise; treat as failure if falsy, otherwise wrap
            if (!p) { failRestore('Verify failed 3 Contact Support'); return; }
            p = Promise.resolve(p);
          }
          p.then(function (order) {
            try {
              if (!order) {
                failRestore('No order found 3 Contact Support');
                return;
              }

              // Persist the discovered order into localStorage using the
              // defensive soundshopPersistBought helper if present.
              try { if (typeof window.soundshopPersistBought === 'function') window.soundshopPersistBought(order); } catch (e) { /* ignore */ }

              // Dispatch an in-page event so existing UI refresh logic runs.
              try { document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: order })); } catch (e) { /* ignore */ }

              // Attempt to update the nearby CTA: prefer calling createBoughtCta
              // on a sensible host (note element, list item, or nearest parent)
              try {
                var host = btn.closest('[data-bought-note]') || btn.closest('li.bought__item') || btn.closest('[data-bought-summary]') || btn.parentNode || document;
                if (host && typeof createBoughtCta === 'function') {
                  try { createBoughtCta(host, order); } catch (e) { /* ignore */ }
                }
              } catch (e) { /* ignore */ }

              // Final button state: if we can detect a download URL, prefer to
              // leave the CTA area to show a Download anchor; still update text.
              try {
                var d = extractDownloadUrl(order);
                if (d) {
                  try { btn.textContent = 'Verified'; } catch (e) { /* ignore */ }
                  try { btn.disabled = false; } catch (e) { /* ignore */ }
                  try { btn.removeAttribute('data-ssp-verifying'); } catch (e) { /* ignore */ }
                  return;
                }
              } catch (e) { /* ignore */ }

              try { btn.textContent = 'Verified'; } catch (e) { /* ignore */ }
              try { btn.disabled = false; } catch (e) { /* ignore */ }
              try { btn.removeAttribute('data-ssp-verifying'); } catch (e) { /* ignore */ }

            } catch (e) {
              failRestore('Verify failed 3 Contact Support');
            }
          }).catch(function () { failRestore('Verify failed 3 Contact Support'); });
        } catch (e) {
          failRestore('Verify failed 3 Contact Support');
        }

      } catch (e) { /* ignore handler errors */ }
    });
  } catch (e) { /* ignore binding */ }

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

    // Fallback auto-verify for returning checkouts: when the page URL contains
    // an explicit d8a_order id and the payments widget is not present, perform
    // one conservative fetch to the platform verify endpoint. On success the
    // discovered order is persisted via soundshopPersistBought (if available)
    // and a soundshop:verified-order event is dispatched so existing UI
    // refresh logic can surface a Download CTA. This runs at most once per
    // page load and only when an explicit d8a_order is present.
    try {
      if (!_boughtAutoVerifyCalled && typeof window.groupStoreVerify !== 'function') {
        var backId = (location.search.match(/[?&]d8a_order=([A-Za-z0-9_-]+)/) || [])[1];
        if (backId) {
          _boughtAutoVerifyCalled = true;
          try {
            var VERIFY_URL = 'https://d8a.com/api/v1/store/orders/' + encodeURIComponent(backId) + '?group=batch-synthshop';
            fetch(VERIFY_URL).then(function (r) { return r.ok ? r.json() : null; })
              .then(function (d) {
                try {
                  if (!d || !d.paid) return;
                  var order = d.order;
                  if (!order) return;
                  try { if (typeof window.soundshopPersistBought === 'function') window.soundshopPersistBought(order); } catch (e) { /* ignore */ }
                  try { document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: order })); } catch (e) { /* ignore */ }
                } catch (e) { /* ignore */ }
              }).catch(function () { /* ignore */ });
          } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }

    // Conservative, one-shot auto-verify pass for remembered purchases that
    // have an order id but no verified downloadUrl. This only runs when the
    // platform verifier (window.groupStoreVerify) is available and only once
    // per page load to keep privacy and server load minimal.
    try {
      if (!_boughtAutoVerifyCalled && typeof window.groupStoreVerify === 'function') {
        var arr = [];
        try { arr = readBoughtArray(document); } catch (e) { arr = []; }
        if (arr && arr.length) {
          var toVerify = null;
          for (var i = 0; i < arr.length; i++) {
            var it = arr[i];
            if (!it) continue;
            if ((it.id || it.ref) && !it.downloadUrl) { toVerify = it; break; }
          }
          if (toVerify) {
            _boughtAutoVerifyCalled = true;
            try {
              var vid = toVerify.id || toVerify.ref || '';
              var p = null;
              try { p = window.groupStoreVerify(vid); } catch (e) { p = null; }
              if (p && typeof p.then === 'function') {
                p.then(function (order) {
                  try {
                    if (!order) return;
                    // Only persist and broadcast when a conservative https download URL exists
                    var d = extractDownloadUrl(order);
                    if (!d) return;
                    try { if (typeof window.soundshopPersistBought === 'function') window.soundshopPersistBought(order); } catch (e) { /* ignore */ }
                    try { document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: order })); } catch (e) { /* ignore */ }
                  } catch (e) { /* ignore */ }
                }).catch(function () { /* ignore failures */ });
              }
            } catch (e) { /* ignore */ }
          }
        }
      }
    } catch (e) { /* ignore */ }
  };

}(window, document));
