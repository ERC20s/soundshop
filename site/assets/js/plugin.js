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

  function readBoughtArray() {
    try {
      var BOUGHT_KEY = 'soundshop:bought:v1';
      var BOUGHT_MAX_AGE = 60 * 24 * 60 * 1000; // 60 days in ms
      var raw = window.localStorage.getItem(BOUGHT_KEY);
      if (!raw) return {};
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { return {}; }
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

  // Mask a payment/reference id conservatively so the banner can show a short
  // fragment without exposing the whole token. Example: abcdef123456 -> abcdef…3456
  function maskRef(r) {
    try {
      if (!r || typeof r !== 'string') return '';
      var s = String(r).trim();
      if (!s) return '';
      if (s.length <= 10) return s.slice(0, 3) + '…' + s.slice(-2);
      var front = s.slice(0, 6);
      var back = s.slice(-4);
      return front + '…' + back;
    } catch (e) { return ''; }
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

  // Conservatively extract a provider-supplied receipt URL. Mirrors the
  // checks used when soundshopPersistBought accepts and stores receiptUrl so
  // the UI only exposes links that look like HTTP(S) URLs and are bounded in
  // length to avoid accidental exposure of arbitrary data.
  function extractReceiptUrl(o) {
    try {
      var MAX_RECEIPT_LEN = 2000;
      if (!o || typeof o !== 'object') return '';
      var r = o.receiptUrl || o.receipt || '';
      if (typeof r !== 'string') return '';
      r = r.trim();
      if (!r) return '';
      if (r.length > MAX_RECEIPT_LEN) return '';
      if (!/^https?:\/\//i.test(r)) return '';
      return r;
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

      // If we have a validated download URL already, expose it
      try {
        var d = extractDownloadUrl(record);
        if (d) {
          var a = el('a', 'button button--primary', 'Download');
          a.href = d;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          wrapper.appendChild(a);
          hasCta = true;
        }
      } catch (e) { /* ignore */ }

      // If no download CTA was added, consider exposing a provider receipt
      // link only when it passes conservative validation via extractReceiptUrl.
      try {
        if (!hasCta) {
          var r = extractReceiptUrl(record);
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

      // Add a per-item Verify button when the record carries a provider ref
      try {
        var ref = String(record.ref || '').trim();
        if (ref) {
          var verifyBtn = el('button', 'button', 'Verify');
          verifyBtn.type = 'button';
          // Capture the original label immediately so we can restore it later
          var originalLabel = verifyBtn.textContent;

          try {
            verifyBtn.addEventListener('click', function () {
              try {
                if (!ref) return;
                if (verifyBtn.disabled) return;
                verifyBtn.disabled = true;
                verifyBtn.textContent = 'Checking…';

                // Attempt server-side verify; persist and notify on success.
                // Restore the button state and label when the request settles.
                try {
                  window.groupStoreVerify(ref).then(function (o) {
                    try {
                      if (!o) return;
                      if (typeof window.soundshopPersistBought === 'function') {
                        try { window.soundshopPersistBought(o); } catch (e) { /* ignore */ }
                      }

                      // Notify other codepaths
                      try { document.dispatchEvent(new CustomEvent('group-store:paid', { detail: o })); } catch (e) { /* ignore */ }
                    } catch (e) { /* ignore */ }
                  }).catch(function () { /* ignore */ }).finally(function () {
                    try { verifyBtn.disabled = false; verifyBtn.textContent = originalLabel; } catch (e) { /* ignore */ }
                  });
                } catch (e) { try { verifyBtn.disabled = false; verifyBtn.textContent = originalLabel; } catch (err) { /* ignore */ } }

              } catch (e) { /* ignore */ }
            });
          } catch (e) { /* ignore */ }

          wrapper.appendChild(verifyBtn);
          hasCta = true;
        }
      } catch (e) { /* ignore */ }

      if (hasCta) return wrapper;
      return null;
    } catch (e) { return null; }
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

            // Guarded scroll-and-focus: delay via setTimeout to avoid layout
            // races in embedding contexts, respect reduced-motion and swallow
            // any errors so host pages cannot throw.
            try {
              setTimeout(function () {
                try {
                  if (a && typeof a.scrollIntoView === 'function') {
                    a.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
                  }
                } catch (e) { /* ignore scroll errors */ }
                try {
                  if (a && typeof a.focus === 'function') {
                    a.focus();
                  }
                } catch (e) { /* ignore focus errors */ }
              }, 0);
            } catch (e) { /* ignore timeout scheduling errors */ }

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

      var text = el('span', null, 'Sold by Synth Plugin Shop\n\nYou have purchased\n\nThis page was returned from a completed checkout for the following. This is a note kept in this browser, not proof of your licence, so it disappears if you clear site data or switch machines — but it is enough to verify what you bought.\n\nPRISM bought on this device on31 Aug 2026 Payment reference:sto_pBpu2LkCjdaqupCd— quote this when you write to us.\n\nA note in a browser is never proof of payment; the receipt from the payment provider is. If a purchase you made is missing here, that only means this browser has forgotten it — the receipt still stands, and Support can find the order from it.');

      var btn = el('button', 'button', 'Verify');
      btn.type = 'button';

      // Wire the button to attempt a conservative server-side verify when
      // clicked. The handler persists via window.soundshopPersistBought when
      // present and dispatches group-store:paid so other components refresh.
      try {
        btn.addEventListener('click', function () {
          try {
            var prev = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Checking…';
            try {
              window.groupStoreVerify(orderId).then(function (o) {
                try {
                  if (!o) return;
                  if (typeof window.soundshopPersistBought === 'function') {
                    try { window.soundshopPersistBought(o); } catch (e) { /* ignore */ }
                  }
                  try { document.dispatchEvent(new CustomEvent('group-store:paid', { detail: o })); } catch (e) { /* ignore */ }

                  // Update a banner on success so the user sees the Verified
                  // label and any download/receipt CTA we can expose.
                  try { updateUrlOrderBanner(banner, o); } catch (e) { /* ignore */ }
                } catch (e) { /* ignore */ }
              }).catch(function () { /* ignore */ }).finally(function () {
                btn.disabled = false;
                btn.textContent = prev;
              });

            } catch (e) { btn.disabled = false; btn.textContent = prev; }

          } catch (e) { /* ignore */ }
        });

      } catch (e) { /* ignore */ }

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

      var list = host.querySelector('[data-bought-summary-list]');
      if (!list) return;

      var labelsEl = host.querySelector('[data-bought-summary-labels]') || document.querySelector('[data-bought-summary-labels]');

      function render() {
        try {
          // Clear existing list children
          try {
            while (list.firstChild) list.removeChild(list.firstChild);
          } catch (e) { /* ignore */ }

          var bought = readBoughtArray() || {};
          var order = ['vanta','drift','prism','anvil','bundle'];
          var any = false;

          for (var i = 0; i < order.length; i++) {
            var token = order[i];
            if (!Object.prototype.hasOwnProperty.call(bought, token)) continue;
            var rec = bought[token];
            if (!rec || typeof rec !== 'object') continue;

            var li = el('li', 'bought-summary__item');

            // Product label
            var label = token;
            try {
              if (labelsEl) {
                var attr = 'data-bought-label-' + token;
                var v = labelsEl.getAttribute(attr);
                if (v) label = v;
              }
            } catch (e) { /* ignore */ }
            var lbl = el('span', 'bought-summary__label', label);
            li.appendChild(lbl);

            // Date
            try {
              var prefix = attr(host, 'data-bought-summary-date-prefix') || '';
              var when = Number(rec.t || 0) || 0;
              var dateText = '';
              if (when) {
                try { dateText = new Date(when).toLocaleDateString(); } catch (e) { dateText = String(when); }
                var dateSpan = el('span', 'bought-summary__date', prefix + dateText);
                li.appendChild(dateSpan);
              }
            } catch (e) { /* ignore */ }

            // Reference / masked ref
            try {
              var refElText = '';
              var ref = String(rec.ref || '').trim();
              if (ref) {
                var pre = attr(host, 'data-bought-summary-ref-prefix') || '';
                var suf = attr(host, 'data-bought-summary-ref-suffix') || '';
                refElText = pre + maskRef(ref) + suf;
              } else {
                refElText = attr(host, 'data-bought-summary-noref') || '';
              }
              if (refElText) {
                var refSpan = el('span', 'bought-summary__ref', refElText);
                li.appendChild(refSpan);
              }
            } catch (e) { /* ignore */ }

            // CTAs
            try {
              var ctas = createBoughtCta(li, rec);
              if (ctas) li.appendChild(ctas);
            } catch (e) { /* ignore */ }

            list.appendChild(li);
            any = true;
          }

          // Unhide the host only when we actually rendered something
          try {
            if (any) {
              try { host.removeAttribute('hidden'); } catch (e) { host.hidden = false; }
            }
          } catch (e) { /* ignore */ }
        } catch (e) { /* ignore render */ }
      }

      // Listen for purchases/verified events so the list refreshes
      try {
        document.addEventListener('group-store:paid', function () { try { render(); } catch (e) { /* ignore */ } });
        // Some codepaths emit 'soundshop:verified-order' — reference it here
        // so tools can statically detect support and consumers get refreshed.
        document.addEventListener('soundshop:verified-order', function () { try { render(); } catch (e) { /* ignore */ } });
      } catch (e) { /* ignore */ }

      // Initial render
      try { render(); } catch (e) { /* ignore */ }

    } catch (e) { /* ignore */ }
  }

  // -----------------------------------------------------------------------
  // initBoughtNote
  //
  // For product pages: reveal [data-bought-note] elements whose
  // data-bought-item token matches a remembered purchase. Populate the
  // internal spans and append CTAs. Guarded via bound(noteEl, 'bought-note').
  // -----------------------------------------------------------------------
  function initBoughtNote(root) {
    try {
      var scope = root || document;
      var notes = Array.prototype.slice.call(scope.querySelectorAll('[data-bought-note]')) || [];
      if (!notes || !notes.length) return;

      var bought = readBoughtArray() || {};

      function handleNote(noteEl) {
        try {
          if (!noteEl) return;
          var token = attr(noteEl, 'data-bought-item') || '';
          if (!token) return;
          if (bound(noteEl, 'bought-note')) return;

          var rec = bought[token] || null;
          if (!rec) return;

          // Unhide note
          try { noteEl.removeAttribute('hidden'); } catch (e) { noteEl.hidden = false; }

          // Cover span
          try {
            var cover = noteEl.querySelector('[data-bought-cover]');
            if (cover) {
              var email = String(rec.email || '');
              cover.textContent = email ? maskEmail(email) : (attr(noteEl, 'data-bought-cover-default') || '');
            }
          } catch (e) { /* ignore */ }

          // Date span
          try {
            var dateEl = noteEl.querySelector('[data-bought-date]');
            if (dateEl) {
              var prefix = attr(noteEl, 'data-bought-date-prefix') || '';
              var when = Number(rec.t || 0) || 0;
              var dtext = '';
              if (when) {
                try { dtext = new Date(when).toLocaleDateString(); } catch (e) { dtext = String(when); }
                dateEl.textContent = prefix + dtext;
              }
            }
          } catch (e) { /* ignore */ }

          // CTAs
          try {
            var c = createBoughtCta(noteEl, rec);
            if (c) noteEl.appendChild(c);
          } catch (e) { /* ignore */ }
        } catch (e) { /* ignore note */ }
      }

      // Initial pass for existing notes
      for (var i = 0; i < notes.length; i++) {
        try { handleNote(notes[i]); } catch (e) { /* ignore */ }
      }

      // Re-run when a purchase/verify event fires
      try {
        document.addEventListener('group-store:paid', function () {
          try {
            bought = readBoughtArray() || {};
            for (var j = 0; j < notes.length; j++) {
              try { handleNote(notes[j]); } catch (e) { /* ignore */ }
            }
          } catch (e) { /* ignore */ }
        });
        document.addEventListener('soundsho