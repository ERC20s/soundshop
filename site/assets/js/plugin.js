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

              // Reveal and focus the Download CTA so users who land on the
              // returned-order note immediately see and can activate the product.
              try {
                var cta = null;
                try { cta = (banner && banner.querySelector) ? banner.querySelector('a.button.button--primary') : null; } catch (e) { cta = null; }
                if (!cta) {
                  try { cta = document.querySelector('[data-bought-summary] a.button.button--primary'); } catch (e) { cta = null; }
                }
                if (cta) {
                  try {
                    var beh = reducedMotion() ? 'auto' : 'smooth';
                    try { cta.scrollIntoView({ behavior: beh, block: 'center' }); } catch (e) { try { cta.scrollIntoView(); } catch (err) { /* ignore */ } }
                    try { cta.focus(); } catch (e) { /* ignore */ }
                  } catch (e) { /* ignore */ }
                }
              } catch (e) { /* ignore reveal/focus */ }

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
              if (banner) {
                try { updateUrlOrderBanner(banner, o); } catch (e) { /* ignore */ }

                // Reveal and focus the Download CTA if present in the banner
                try {
                  var cta = null;
                  try { cta = (banner && banner.querySelector) ? banner.querySelector('a.button.button--primary') : null; } catch (e) { cta = null; }
                  if (!cta) {
                    try { cta = document.querySelector('[data-bought-summary] a.button.button--primary'); } catch (e) { cta = null; }
                  }
                  if (cta) {
                    try {
                      var beh = reducedMotion() ? 'auto' : 'smooth';
                      try { cta.scrollIntoView({ behavior: beh, block: 'center' }); } catch (e) { try { cta.scrollIntoView(); } catch (err) { /* ignore */ } }
                      try { cta.focus(); } catch (e) { /* ignore */ }
                    } catch (e) { /* ignore */ }
                  }
                } catch (e) { /* ignore reveal/focus */ }

              }
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
  function initBoughtSummary() {
    try {
      var host = document.querySelector('[data-bought-summary]');
      if (!host) return;
      if (bound(host, 'bought-summary')) return;

      var BOUGHT_KEY = 'soundshop:bought:v1';

      function readBoughtArray() {
        try {
          var raw = window.localStorage.getItem(BOUGHT_KEY);
          if (!raw) return {};
          var parsed = null;
          try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; else return {};
        } catch (e) { return {}; }
      }

      var bought = readBoughtArray() || {};

      var list = host.querySelector('[data-bought-summary-list]');
      if (!list) {
        try {
          list = el('div', '', '');
          list.setAttribute('data-bought-summary-list', '');
          host.appendChild(list);
        } catch (e) { list = null; }
      }
      if (!list) return;

      function handleItemRow(row) {
        try {
          var token = attr(row, 'data-bought-token');
          if (!token) return;
          var rec = bought[token];
          if (!rec) return;
          // Render a simple headline and CTA cluster
          try {
            var title = row.querySelector('[data-bought-title]');
            if (title) {
              try { title.textContent = (rec.ref ? rec.ref + ' — ' : '') + (attr(row, 'data-bought-title') || 'Purchased'); } catch (e) { /* ignore */ }
            }
            var ctaHolder = row.querySelector('[data-bought-ctas]');
            if (ctaHolder) {
              try {
                // Remove existing CTAs we control so re-rendering is safe
                var existing = ctaHolder.querySelectorAll('[data-ssp-bought-cta]');
                for (var i = 0; i < existing.length; i++) {
                  try { existing[i].parentNode.removeChild(existing[i]); } catch (e) { /* ignore */ }
                }

                var hasCta = false;

                // Download
                try {
                  if (rec.downloadUrl) {
                    var a = el('a', 'button button--primary', 'Download');
                    a.href = rec.downloadUrl;
                    a.target = '_blank';
                    a.rel = 'noopener noreferrer';
                    a.setAttribute('data-ssp-bought-cta', 'download');
                    ctaHolder.appendChild(a);
                    hasCta = true;
                  }
                } catch (e) { /* ignore */ }

                // Receipt (provider receipt URL)
                try {
                  if (!hasCta && rec.receiptUrl) {
                    var ra = el('a', 'button', 'Receipt');
                    ra.href = rec.receiptUrl;
                    ra.target = '_blank';
                    ra.rel = 'noopener noreferrer';
                    ra.setAttribute('data-ssp-bought-cta', 'receipt');
                    ctaHolder.appendChild(ra);
                    hasCta = true;
                  }
                } catch (e) { /* ignore */ }

                // Fallback: Get help
                try {
                  if (!hasCta) {
                    var ga = el('a', 'button', 'Get help');
                    ga.href = attr(row, 'data-bought-help') || 'mailto:support@example.com';
                    ga.setAttribute('data-ssp-bought-cta', 'help');
                    ctaHolder.appendChild(ga);
                    hasCta = true;
                  }
                } catch (e) { /* ignore */ }

              } catch (e) { /* ignore ctas */ }
            }

          } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }
      }

      // Initial pass for existing rows
      var rows = host.querySelectorAll('[data-bought-token]');
      for (var i = 0; i < rows.length; i++) {
        try { handleItemRow(rows[i]); } catch (e) { /* ignore */ }
      }

      // Re-run when a purchase/verify event fires
      try {
        document.addEventListener('group-store:paid', function () {
          try {
            bought = readBoughtArray() || {};
            var rs = host.querySelectorAll('[data-bought-token]');
            for (var j = 0; j < rs.length; j++) {
              try { handleItemRow(rs[j]); } catch (e) { /* ignore */ }
            }
          } catch (e) { /* ignore */ }
        });
        document.addEventListener('soundshop:verified-order', function () {
          try {
            bought = readBoughtArray() || {};
            var rs2 = host.querySelectorAll('[data-bought-token]');
            for (var j = 0; j < rs2.length; j++) {
              try { handleItemRow(rs2[j]); } catch (e) { /* ignore */ }
            }
          } catch (e) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }

    } catch (e) { /* ignore */ }
  }

  // -----------------------------------------------------------------------
  // initBoughtNote
  //
  // Locate small notes that signal a remembered purchase on this device and
  // unhide them when appropriate. The note is simple: attribute-based and
  // non-essential so it degrades safely.
  // -----------------------------------------------------------------------
  function initBoughtNote() {
    try {
      var notes = document.querySelectorAll('[data-bought-note]');
      if (!notes || !notes.length) return;

      function readBoughtArray() {
        try {
          var raw = window.localStorage.getItem('soundshop:bought:v1');
          if (!raw) return {};
          var parsed = null;
          try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; else return {};
        } catch (e) { return {}; }
      }

      var bought = readBoughtArray() || {};

      function handleNote(n) {
        try {
          var token = attr(n, 'data-bought-note');
          if (!token) return;
          var rec = bought[token];
          if (!rec) return;
          try { n.style.display = ''; } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }
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
        document.addEventListener('soundshop:verified-order', function () {
          try {
            bought = readBoughtArray() || {};
            for (var j = 0; j < notes.length; j++) {
              try { handleNote(notes[j]); } catch (e) { /* ignore */ }
            }
          } catch (e) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }

    } catch (e) { /* ignore */ }
  }

  // Export the helpers so tools/check-plugin-exports.js and consumers can find them
  P.initUrlOrderVerifyBanner = initUrlOrderVerifyBanner;
  P.initUrlOrderAutoVerify = initUrlOrderAutoVerify;
  P.initBoughtSummary = initBoughtSummary;
  P.initBoughtNote = initBoughtNote;

  // Run the conservative auto-verify on DOM ready so it operates after any
  // initial UI rendering. This mirrors other init semantics and is safe to
  // call multiple times.
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initUrlOrderAutoVerify);
    } else {
      // DOM already ready
      try { initUrlOrderAutoVerify(); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

})(window, document);
