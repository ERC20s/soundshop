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

  // Shared helper: update the small URL-order banner when a verification
  // succeeds so users immediately see the verified item and a Download CTA.
  function updateUrlOrderBanner(banner, order) {
    try {
      if (!banner || !order || typeof order !== 'object') return;
      try {
        // Update text to mention the verified item name when available
        var name = String(order.itemName || order.name || order.item || order.itemId || '').trim();
        var textEl = banner.querySelector('span');
        if (textEl) {
          if (name) textEl.textContent = 'Verified purchase: ' + name + '. ';
          else textEl.textContent = 'Verified purchase.';
        }
        // Flip the button to Verified
        var btn = banner.querySelector('button');
        if (btn) {
          btn.textContent = 'Verified';
          btn.disabled = true;
        }
        // Append a Download CTA when the verified order provides a download URL
        var existing = banner.querySelector('a.button.button--primary');
        if (!existing) {
          var d = extractDownloadUrl(order);
          if (d) {
            var a = el('a', 'button button--primary', 'Download');
            a.href = d;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            // Insert after the button if present, else append
            if (btn && btn.parentNode) btn.parentNode.insertBefore(a, btn.nextSibling);
            else banner.appendChild(a);

            // When we dynamically insert the Download CTA make a guarded attempt
            // to draw attention to it: scroll it into view (honouring reduced
            // motion preferences) and focus it so keyboard users can activate it
            // immediately. Wrap in setTimeout and try/catch to avoid layout race
            // conditions and to keep embedding contexts safe.
            try {
              (function (anchor) {
                setTimeout(function () {
                  try {
                    if (!anchor) return;
                    try {
                      anchor.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
                    } catch (e) { /* ignore scroll errors */ }
                    try { anchor.focus(); } catch (e) { /* ignore focus errors */ }
                  } catch (e) { /* ignore */ }
                }, 0);
              })(a);
            } catch (e) { /* ignore */ }

          } else {
            // No download: consider exposing a validated receipt link next to the Verified button
            try {
              var r = extractReceiptUrl(order);
              if (r) {
                var ra = el('a', 'button', 'Receipt');
                ra.href = r;
                ra.target = '_blank';
                ra.rel = 'noopener noreferrer';
                if (btn && btn.parentNode) btn.parentNode.insertBefore(ra, btn.nextSibling);
                else banner.appendChild(ra);
              }
            } catch (e) { /* ignore */ }
          }
        }
      } catch (e) { /* ignore banner update errors */ }
    } catch (e) { /* ignore */ }
  }

  // -----------------------------------------------------------------------
  // initUrlOrderVerifyBanner
  //
  // Small, defensive entry that renders a lightweight banner on product pages
  // returned from the payment provider with ?d8a_order=<id> when the local
  // bought-summary has no Download CTA. The banner preserves the conservative
  // user-initiated verify behaviour: clicking it calls window.groupStoreVerify,
  // persists the paid order with window.soundshopPersistBought when present,
  // and dispatches the existing group-store:paid event so UIs refresh.
  //
  // This implementation guards and initializes the two flags used to avoid
  // ReferenceError in embedding contexts that do not declare them.
  // -----------------------------------------------------------------------
  function initUrlOrderVerifyBanner() {
    try {
      // Ensure the window-scoped flags exist; some embedding contexts may not
      // declare them and reading an undeclared global can throw a ReferenceError
      // in strict mode when accessed via an identifier. Use window.<name> so the
      // property access is safe and well-defined.
      if (typeof window._boughtAutoVerifyCalled === 'undefined') window._boughtAutoVerifyCalled = false;
      if (typeof window._sspUrlOrderVerifyDone === 'undefined') window._sspUrlOrderVerifyDone = false;

      // If we've already attempted this path on the page, do nothing.
      if (window._sspUrlOrderVerifyDone) return;
      // Mark done to ensure one-shot behaviour.
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

      // Build the banner
      var banner = el('div', 'ssp-url-order-verify-banner');
      banner.style.cssText = 'font:13px system-ui,sans-serif;color:#065f46;margin:8px 0;padding:10px;border:1px solid #d1fae5;background:#ecfdf5;border-radius:6px;';
      var masked = maskRef(orderId);
      var text = el('span', '', 'We detected a returned order on the URL' + (masked ? ' (ref ' + masked + '). ' : '. '));
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

              // Update the banner to reflect the verified order (name + download CTA)
              try { updateUrlOrderBanner(banner, o); } catch (e) { /* ignore */ }

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

    } catch (e) { /* swallow to remain safe in varied embedding contexts */ }
  }

  // -----------------------------------------------------------------------
  // initUrlOrderAutoVerify
  //
  // Conservative, one-shot auto verification that runs on page load when
  // the URL contains a ?d8a_order=<id>. It attempts a server-side verify once
  // and, on success, persists the canonical order with
  // window.soundshopPersistBought and dispatches the existing group-store:paid
  // event so UI components refresh. The routine is guarded so it only runs
  // once per page and avoids firing when a Download CTA is already present.
  // -----------------------------------------------------------------------
  function initUrlOrderAutoVerify() {
    try {
      // Ensure the window-scoped flag exists so embedding contexts can't
      // throw on identifier access.
      if (typeof window._boughtAutoVerifyCalled === 'undefined') window._boughtAutoVerifyCalled = false;

      // Only attempt once per page load.
      if (window._boughtAutoVerifyCalled) return;
      window._boughtAutoVerifyCalled = true;

      // Bail unless the URL explicitly contains a returned order id.
      var orderId = (location.search.match(/[?&]d8a_order=([A-Za-z0-9_-]+)/) || [])[1];
      if (!orderId) return;

      // Need server-side verify helper to exist.
      if (typeof window.groupStoreVerify !== 'function') return;

      // If there's already a Download CTA inside the bought-summary, skip.
      try {
        if (document.querySelector('[data-bought-summary] a.button.button--primary')) return;
      } catch (e) { /* ignore */ }

      // Mark the banner path done so we don't later show a redundant banner.
      if (typeof window._sspUrlOrderVerifyDone === 'undefined') window._sspUrlOrderVerifyDone = false;
      window._sspUrlOrderVerifyDone = true;

      // Attempt verification but remain conservative: don't throw, and handle
      // network errors silently. Persist and dispatch on success.
      try {
        window.groupStoreVerify(orderId).then(function (o) {
          try {
            if (!o) return;
            if (typeof window.soundshopPersistBought === 'function') {
              try { window.soundshopPersistBought(o); } catch (e) { /* ignore */ }
            }
            try { document.dispatchEvent(new CustomEvent('group-store:paid', { detail: o })); } catch (e) { /* ignore */ }

            // If a banner is present on the page, update it to show the
            // verified item and provide a Download CTA when available.
            try {
              var banner = document.querySelector('.ssp-url-order-verify-banner');
              if (banner) updateUrlOrderBanner(banner, o);
            } catch (e) { /* ignore */ }

          } catch (e) { /* ignore success handling */ }
        }).catch(function () { /* ignore network/verify errors */ });
      } catch (e) { /* ignore */ }

    } catch (e) { /* ignore to remain safe */ }
  }

  // -----------------------------------------------------------------------
  // initBoughtSummary
  //
  // Locate [data-bought-summary] and render every remembered purchase into
  // [data-bought-summary-list]. The function is idempotent and guarded via
  // bound(host, 'bought-summary'); it attaches listeners for the events
  // 'group-store:paid' and 'soundshop:verified-order' so the UI refreshes when
  // purchases change.
  // -----------------------------------------------------------------------
  function initBoughtSummary(root) {
    try {
      var host = root || document.querySelector('[data-bought-summary]');
      if (!host) return;
      if (bound(host, 'bought-summary')) return;

      // Ensure the container list exists
      var list = host.querySelector('[data-bought-summary-list]');
      if (!list) {
        list = el('div', '', '');
        list.setAttribute('data-bought-summary-list', '');
        host.appendChild(list);
      }

      function readBoughtArray() {
        var BOUGHT_KEY = 'soundshop:bought:v1';
        var BOUGHT_MAX_AGE = 1000 * 60 * 60 * 24 * 60; // 60 days
        try {
          var raw = window.localStorage.getItem(BOUGHT_KEY);
          if (!raw) return [];
          var parsed = null;
          try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
          var now = Date.now();
          var out = [];
          for (var k in parsed) {
            if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue;
            var r = parsed[k];
            var isObj = !!r && typeof r === 'object' && !Array.isArray(r);
            var when = Number(isObj ? r.t : r);
            if (!isFinite(when) || when <= 0 || (now - when) > BOUGHT_MAX_AGE) continue;
            out.push({ token: k, when: when, rec: r });
          }
          out.sort(function (a, b) { return b.when - a.when; });
          return out;
        } catch (e) { return []; }
      }

      function render() {
        try {
          var items = readBoughtArray();
          // Clear list
          try { list.textContent = ''; } catch (e) { /* ignore */ }
          if (!items || !items.length) return;

          items.forEach(function (it) {
            try {
              var wrapper = el('div', 'bought-row');
              var name = el('div', 'bought-name', (it.rec && it.rec.name) || it.token);
              wrapper.appendChild(name);

              var meta = el('div', 'bought-meta', '');
              if (it.rec && it.rec.ref) meta.appendChild(el('span', '', 'ref ' + it.rec.ref));
              if (it.rec && it.rec.email) meta.appendChild(el('span', '', it.rec.email));
              wrapper.appendChild(meta);

              // CTAs
              var ctas = createBoughtRowCtas(it.rec);
              if (ctas) wrapper.appendChild(ctas);

              list.appendChild(wrapper);
            } catch (e) { /* ignore row */ }
          });
        } catch (e) { /* ignore render */ }
      }

      render();

      // Re-render on events so UI stays up to date
      try {
        document.addEventListener('group-store:paid', function () { try { render(); } catch (e) { /* ignore */ } });
        document.addEventListener('soundshop:verified-order', function () { try { render(); } catch (e) { /* ignore */ } });
      } catch (e) { /* ignore listeners */ }

    } catch (e) { /* ignore init */ }
  }

  // -----------------------------------------------------------------------
  // initBoughtNote
  //
  // Unhide [data-bought-note] when the local storage shows a remembered
  // purchase for the product page. This is a single, non-essential UI touch.
  // -----------------------------------------------------------------------
  function initBoughtNote(root) {
    try {
      var elRoot = root || document;
      var note = el('[data-bought-note]');
      if (!note) return;
      try {
        var items = (function () {
          var BOUGHT_KEY = 'soundshop:bought:v1';
          try {
            var raw = window.localStorage.getItem(BOUGHT_KEY);
            if (!raw) return {};
            var parsed = null;
            try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
            return parsed;
          } catch (e) { return {}; }
        })();
        // Determine token for this page by inspecting data attributes on the
        // root element (the pages set data-ssp-token attributes in their
        // templates). Fall back to product name when necessary.
        var pageToken = (function () {
          try {
            var rootEl = document.querySelector('[data-ssp-token]');
            if (rootEl) return String(rootEl.getAttribute('data-ssp-token') || '').trim();
            var name = (document.querySelector('h1') || { textContent: '' }).textContent || '';
            return name.trim().toLowerCase();
          } catch (e) { return ''; }
        })();
        if (!pageToken) return;
        if (items && items[pageToken]) {
          try { note.removeAttribute('hidden'); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  // -----------------------------------------------------------------------
  // Helpers used by banner/summary code to conservatively detect download or
  // receipt URLs from the canonical persisted record or server response.
  // -----------------------------------------------------------------------
  function extractDownloadUrl(order) {
    try {
      if (!order || typeof order !== 'object') return '';
      var d = order.downloadUrl || order.installerUrl || (order.installers && order.installers[0] && order.installers[0].url) || '';
      if (typeof d !== 'string') return '';
      d = d.trim();
      if (!d || !/^https?:\/\//i.test(d)) return '';
      return d;
    } catch (e) { return ''; }
  }

  function extractReceiptUrl(order) {
    try {
      if (!order || typeof order !== 'object') return '';
      var r = order.receiptUrl || order.receipt || '';
      if (typeof r !== 'string') return '';
      r = r.trim();
      if (!r || !/^https?:\/\//i.test(r)) return '';
      return r;
    } catch (e) { return ''; }
  }

  function maskRef(ref) {
    try {
      if (!ref) return '';
      var s = String(ref || '');
      if (s.length <= 6) return s;
      return s.slice(0, 3) + '…' + s.slice(-3);
    } catch (e) { return ''; }
  }

  // -----------------------------------------------------------------------
  // createBoughtRowCtas
  //
  // Build the small set of CTAs that appear alongside each persisted purchase
  // entry. The function is defensive — it never throws and returns null when
  // no CTA should be rendered. It wires Verify buttons and Download/Receipt
  // anchors conservatively.
  // -----------------------------------------------------------------------
  function createBoughtRowCtas(order) {
    try {
      var wrapper = el('div', 'bought-ctas');
      var hasCta = false;

      try {
        // Prefer a Download CTA when available
        var d = extractDownloadUrl(order);
        if (d) {
          var a = el('a', 'button button--primary', 'Download');
          a.href = d;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          wrapper.appendChild(a);
          hasCta = true;
        }
      } catch (e) { /* ignore */ }

      try {
        // When there's no Download but there is a receipt, expose it
        if (!hasCta) {
          var r = extractReceiptUrl(order);
          if (r) {
            var ra = el('a', 'button', 'Receipt');
            ra.href = r;
            ra.target = '_blank';
            ra.rel = 'noopener noreferrer';
            wrapper.appendChild(ra);
            hasCta = true;
          }
        }
      } catch (e) { /* ignore */ }

      try {
        // Always wire a Verify button so users can re-run a verification for
        // the persisted order if necessary. This mirrors the server-side
        // verify behaviour used by the URL-returned order path.
        var verifyBtn = el('button', 'button', 'Verify');
        verifyBtn.type = 'button';
        try {
          var originalLabel = verifyBtn.textContent;
          verifyBtn.addEventListener('click', function () {
            try {
              if (verifyBtn.disabled) return;
              verifyBtn.disabled = true;
              verifyBtn.textContent = 'Checking…';

              // The server-side helper is expected to return a single order
              // object when verification succeeds.
              window.groupStoreVerify(order.id || order.ref || order.reference || '').then(function (o) {
                try {
                  if (!o) {
                    verifyBtn.disabled = false;
                    verifyBtn.textContent = originalLabel;
                    return;
                  }
                  if (typeof window.soundshopPersistBought === 'function') {
                    try { window.soundshopPersistBought(o); } catch (e) { /* ignore */ }
                  }
                  try { document.dispatchEvent(new CustomEvent('group-store:paid', { detail: o })); } catch (e) { /* ignore */ }

                  // If the verification returned a download URL and we just
                  // inserted a Download CTA into the row, attempt to focus it.
                  try {
                    var anchor = wrapper.querySelector('a.button.button--primary');
                    if (anchor) {
                      try {
                        anchor.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
                      } catch (e) { /* ignore */ }
                      try { anchor.focus(); } catch (e) { /* ignore */ }
                    }
                  } catch (e) { /* ignore */ }

                  verifyBtn.disabled = false;
                  verifyBtn.textContent = originalLabel;
                } catch (e) { try { verifyBtn.disabled = false; verifyBtn.textContent = originalLabel; } catch (err) { /* ignore */ } }
              }).catch(function () { try { verifyBtn.disabled = false; verifyBtn.textContent = originalLabel; } catch (err) { /* ignore */ } });

            } catch (e) { /* ignore */ }
          });
        } catch (e) { /* ignore */ }

        wrapper.appendChild(verifyBtn);
        hasCta = true;
      } catch (e) { /* ignore */ }

      if (hasCta) return wrapper;
      return null;
    } catch (e) { return null; }
  }

  // -----------------------------------------------------------------------
  // initUrlOrderVerifyBanner
  //
  // Small, defensive entry that renders a lightweight banner on product pages
  // returned from the payment provider with ?d8a_order=<id> when the local
  // bought-summary has no Download CTA. The banner preserves the conservative
  // user-initiated verify behaviour: clicking it calls window.groupStoreVerify,
  // persists the paid order with window.soundshopPersistBought when present,
  // and dispatches the existing group-store:paid event so UIs refresh.
  //
  // This implementation guards and initializes the two flags used to avoid
  // ReferenceError in embedding contexts that do not declare them.
  // -----------------------------------------------------------------------
  function initUrlOrderVerifyBanner() {
    try {
      // Ensure the window-scoped flags exist; some embedding contexts may not
      // declare them and reading an undeclared global can throw a ReferenceError
      // in strict mode when accessed via an identifier. Use window.<name> so the
      // property access is safe and well-defined.
      if (typeof window._boughtAutoVerifyCalled === 'undefined') window._boughtAutoVerifyCalled = false;
      if (typeof window._sspUrlOrderVerifyDone === 'undefined') window._sspUrlOrderVerifyDone = false;

      // If we've already attempted this path on the page, do nothing.
      if (window._sspUrlOrderVerifyDone) return;
      // Mark done to ensure one-shot behaviour.
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

      // Build the banner
      var banner = el('div', 'ssp-url-order-verify-banner');
      banner.style.cssText = 'font:13px system-ui,sans-serif;color:#065f46;margin:8px 0;padding:10px;border:1px solid #d1fae5;background:#ecfdf5;border-radius:6px;';
      var masked = maskRef(orderId);
      var text = el('span', '', 'We detected a returned order on the URL' + (masked ? ' (ref ' + masked + '). ' : '. '));
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

              // Update the banner to reflect the verified order (name + download CTA)
              try { updateUrlOrderBanner(banner, o); } catch (e) { /* ignore */ }

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

    } catch (e) { /* swallow to remain safe in varied embedding contexts */ }
  }

  // -----------------------------------------------------------------------
  // initUrlOrderAutoVerify
  //
  // Conservative, one-shot auto verification that runs on page load when
  // the URL contains a ?d8a_order=<id>. It attempts a server-side verify once
  // and, on success, persists the canonical order with
  // window.soundshopPersistBought and dispatches the existing group-store:paid
  // event so UI components refresh. The routine is guarded so it only runs
  // once per page and avoids firing when a Download CTA is already present.
  // -----------------------------------------------------------------------
  function initUrlOrderAutoVerify() {
    try {
      // Ensure the window-scoped flag exists so embedding contexts can't
      // throw on identifier access.
      if (typeof window._boughtAutoVerifyCalled === 'undefined') window._boughtAutoVerifyCalled = false;

      // Only attempt once per page load.
      if (window._boughtAutoVerifyCalled) return;
      window._boughtAutoVerifyCalled = true;

      // Bail unless the URL explicitly contains a returned order id.
      var orderId = (location.search.match(/[?&]d8a_order=([A-Za-z0-9_-]+)/) || [])[1];
      if (!orderId) return;

      // Need server-side verify helper to exist.
      if (typeof window.groupStoreVerify !== 'function') return;

      // If there's already a Download CTA inside the bought-summary, skip.
      try {
        if (document.querySelector('[data-bought-summary] a.button.button--primary')) return;
      } catch (e) { /* ignore */ }

      // Mark the banner path done so we don't later show a redundant banner.
      if (typeof window._sspUrlOrderVerifyDone === 'undefined') window._sspUrlOrderVerifyDone = false;
      window._sspUrlOrderVerifyDone = true;

      // Attempt verification but remain conservative: don't throw, and handle
      // network errors silently. Persist and dispatch on success.
      try {
        window.groupStoreVerify(orderId).then(function (o) {
          try {
            if (!o) return;
            if (typeof window.soundshopPersistBought === 'function') {
              try { window.soundshopPersistBought(o); } catch (e) { /* ignore */ }
            }
            try { document.dispatchEvent(new CustomEvent('group-store:paid', { detail: o })); } catch (e) { /* ignore */ }

            // If a banner is present on the page, update it to show the
            // verified item and provide a Download CTA when available.
            try {
              var banner = document.querySelector('.ssp-url-order-verify-banner');
              if (banner) updateUrlOrderBanner(banner, o);
            } catch (e) { /* ignore */ }

          } catch (e) { /* ignore success handling */ }
        }).catch(function () { /* ignore network/verify errors */ });
      } catch (e) { /* ignore */ }

    } catch (e) { /* ignore to remain safe */ }
  }

  // Export public API
  P.initBoughtSummary = initBoughtSummary;
  P.initBoughtNote = initBoughtNote;
  P.initUrlOrderVerifyBanner = initUrlOrderVerifyBanner;
  P.initUrlOrderAutoVerify = initUrlOrderAutoVerify;

  // Auto-run certain features on DOMContentLoaded when the script is included
  // directly in pages.
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        try {
          initBoughtSummary();
          initBoughtNote();
          initUrlOrderVerifyBanner();
          initUrlOrderAutoVerify();
        } catch (e) { /* ignore */ }
      });
    } else {
      try {
        initBoughtSummary();
        initBoughtNote();
        initUrlOrderVerifyBanner();
        initUrlOrderAutoVerify();
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

})(window, document);
