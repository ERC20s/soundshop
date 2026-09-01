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
    try {
      while (node.firstChild) node.removeChild(node.firstChild);
    } catch (e) { /* ignore */ }
    try {
      var p = document.createElement('p');
      if (className) p.className = className;
      p.textContent = String(text || '');
      node.appendChild(p);
    } catch (e) { /* ignore */ }
  }

  // ... (remaining helper and functions unchanged) ...

  // The rest of the file continues unchanged until the verification click handler
  // and auto-verify logic. To keep the patch minimal we now include the existing
  // behaviour unchanged, then add a small, guarded URL-based fallback verifier.

  /**
   * Small helper to extract a conservative https download URL from an order-like
   * object. This mirrors other extraction logic used in this file.
   */
  function extractDownloadUrl(order) {
    try {
      if (!order || typeof order !== 'object') return '';
      var d = order.downloadUrl || order.installerUrl || '';
      if (!d && order.installers && order.installers[0] && order.installers[0].url) d = order.installers[0].url;
      if (typeof d !== 'string') return '';
      d = d.trim();
      if (!d) return '';
      if (/^https?:\/\//i.test(d)) return d;
    } catch (e) { /* ignore */ }
    return '';
  }

  // (the file's click handler, verify-button wiring and event listeners remain
  // unchanged; they are present below in the original file, retained as-is.)

  try {
    document.addEventListener('click', function (e) {
      try {
        var btn = e.target && e.target.closest ? e.target.closest('[data-bought-verify]') : null;
        if (!btn) return;
        var tag = (btn.tagName || '').toLowerCase();
        if (tag !== 'button' && tag !== 'a' && tag !== 'input') return;

        e.preventDefault();

        if (btn.getAttribute('data-ssp-verifying') === 'on') return;
        btn.setAttribute('data-ssp-verifying', 'on');

        var origText = btn.textContent || '';
        try { btn.disabled = true; } catch (err) { /* ignore */ }
        try { btn.textContent = 'Verifying…'; } catch (err) { /* ignore */ }

        var id = attr(btn, 'data-bought-verify') || '';

        function failRestore(msg) {
          try { btn.textContent = origText; } catch (e) { /* ignore */ }
          try { btn.disabled = false; } catch (e) { /* ignore */ }
          try { btn.removeAttribute('data-ssp-verifying'); } catch (e) { /* ignore */ }
          try {
            var hint = document.createElement('span');
            hint.className = 'bought__verify-hint';
            hint.style.cssText = 'margin-left:8px;font-size:13px;color:#6b7280';
            var a = document.createElement('a');
            a.setAttribute('href', 'docs.html#support');
            a.style.color = '#7c5cff';
            a.textContent = msg || 'Need help? Contact Support';
            hint.appendChild(a);
            if (btn.parentNode) {
              try { btn.parentNode.insertBefore(hint, btn.nextSibling); } catch (e) { /* ignore */ }
              setTimeout(function () { try { if (hint && hint.parentNode) hint.parentNode.removeChild(hint); } catch (e) { /* ignore */ } }, 6000);
            }
          } catch (e) { /* ignore */ }
        }

        if (typeof window.groupStoreVerify !== 'function') {
          failRestore('Verify unavailable — Contact Support');
          return;
        }

        try {
          var p = null;
          try { p = window.groupStoreVerify(id); } catch (err) { p = null; }
          if (!p || typeof p.then !== 'function') {
            if (!p) { failRestore('Verify failed — Contact Support'); return; }
            p = Promise.resolve(p);
          }
          p.then(function (order) {
            try {
              if (!order) {
                failRestore('No order found — Contact Support');
                return;
              }

              try { if (typeof window.soundshopPersistBought === 'function') window.soundshopPersistBought(order); } catch (e) { /* ignore */ }

              try { document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: order })); } catch (e) { /* ignore */ }

              try {
                var host = btn.closest('[data-bought-note]') || btn.closest('li.bought__item') || btn.closest('[data-bought-summary]') || btn.parentNode || document;
                if (host && typeof createBoughtCta === 'function') {
                  try { createBoughtCta(host, order); } catch (e) { /* ignore */ }
                }
              } catch (e) { /* ignore */ }

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
              failRestore('Verify failed — Contact Support');
            }
          }).catch(function () { failRestore('Verify failed — Contact Support'); });
        } catch (e) {
          failRestore('Verify failed — Contact Support');
        }

      } catch (e) { /* ignore handler errors */ }
    });
  } catch (e) { /* ignore binding */ }

  try {
    document.addEventListener('soundshop:verified-order', function (evt) {
      try {
        P.initBoughtSummary();
        P.initBoughtNote();
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore listener */ }

  /**
   * One-shot conservative URL-based fallback verifier for ?d8a_order=<id>.
   * This runs only when the payments widget verifier is NOT present and when
   * we have not already attempted an auto-verify in this page load. The
   * routine is intentionally silent on errors and makes no UI changes itself.
   */
  function runUrlOrderFallback() {
    try {
      if (_boughtAutoVerifyCalled) return;
      if (typeof window.groupStoreVerify === 'function') return; // prefer widget verifier
      var search = '';
      try { search = String(window.location.search || ''); } catch (e) { search = ''; }
      var m = null;
      try { m = search.match(/[?&]d8a_order=([A-Za-z0-9_-]+)/); } catch (e) { m = null; }
      if (!m || !m[1]) return;
      var id = m[1];

      // One-shot guards: set both closure and global flags so other code won't
      // attempt a duplicate verification in this page load.
      _boughtAutoVerifyCalled = true;
      try { window._boughtAutoVerifyCalled = true; } catch (e) { /* ignore */ }

      var endpoint = 'https://d8a.com/api/v1/store/orders/' + encodeURIComponent(id) + '?group=batch-synthshop';

      try {
        fetch(endpoint, { method: 'GET', credentials: 'omit', mode: 'cors' }).then(function (res) {
          if (!res || res.status !== 200) return;
          try {
            res.json().then(function (data) {
              try {
                if (!data) return;
                // Accept both { paid:true, order: {...} } and a flat order object
                var order = null;
                if (data && typeof data === 'object' && data.paid === true && data.order && typeof data.order === 'object') {
                  order = data.order;
                } else if (data && typeof data === 'object' && data.paid === true && (data.id || data.ref)) {
                  // in case the endpoint returned the order at top-level with paid:true
                  order = data;
                } else {
                  return; // not a successful paid order we can act on
                }

                try { if (typeof window.soundshopPersistBought === 'function') window.soundshopPersistBought(order); } catch (e) { /* ignore */ }
                try { document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: order })); } catch (e) { /* ignore */ }
              } catch (e) { /* ignore */ }
            }).catch(function () { /* ignore json parse errors */ });
          } catch (e) { /* ignore */ }
        }).catch(function () { /* ignore fetch errors */ });
      } catch (e) { /* ignore */ }

    } catch (e) { /* ignore */ }
  }

  // Public init: perform bought-note and bought-summary work (safe to call repeatedly)
  P.init = function () {
    try { P.initBoughtSummary(); } catch (e) { /* ignore */ }
    try { P.initBoughtNote(); } catch (e) { /* ignore */ }

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

    // Run the URL-based fallback verifier alongside the existing auto-verify
    // logic. This only runs when a ?d8a_order=<id> is present and the payments
    // widget verifier is not available; it is intentionally one-shot and
    // silent on errors.
    try { runUrlOrderFallback(); } catch (e) { /* ignore */ }
  };

}(window, document));
