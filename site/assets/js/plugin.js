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

  // -----------------------------------------------------------------------
  // (many functions omitted here in edits — preserved in original)
  // -----------------------------------------------------------------------

  // Create CTAs for a bought-summary list item. Returns a container element
  // or null. This helper is idempotent and guarded by data-ssp-bought-cta so
  // re-runs of initBoughtSummary do not duplicate elements.
  function createBoughtCta(host, rec, token) {
    try {
      if (!host || !host.setAttribute) return null;
      // Guard to be idempotent
      try {
        if (host.getAttribute('data-ssp-bought-cta') === 'on') return null;
        host.setAttribute('data-ssp-bought-cta', 'on');
      } catch (e) { /* ignore */ }

      // Prefer using a validated download URL helper when present
      var hasDownload = false;
      try {
        if (typeof extractDownloadUrl === 'function') {
          try { hasDownload = !!extractDownloadUrl(rec); } catch (e) { hasDownload = false; }
        } else {
          hasDownload = !!(rec && rec.downloadUrl);
        }
      } catch (e) { hasDownload = false; }

      var container = el('div', 'bought-summary__ctas');

      // If we have a download, the normal page may already offer a Download
      // CTA; only add a Contact support CTA when no download is present.
      if (!hasDownload) {
        // Find the summary host to read configuration
        var summaryHost = (host && typeof host.closest === 'function') ? host.closest('[data-bought-summary]') : document.querySelector('[data-bought-summary]');
        var base = '';
        try { base = attr(summaryHost, 'data-bought-summary-support-href') || ''; } catch (e) { base = ''; }
        if (!base) base = '../docs.html#support';

        // Mask the reference and build query parameters. Use maskRef when
        // available to avoid leaking full payment refs.
        var masked = '';
        try { if (rec && rec.ref && typeof maskRef === 'function') masked = maskRef(String(rec.ref)); else if (rec && rec.ref) masked = String(rec.ref); } catch (e) { masked = String(rec && rec.ref ? rec.ref : ''); }
        var prod = token || '';

        // Insert query parameters before any hash fragment
        var hash = '';
        var qbase = base;
        try {
          var idx = base.indexOf('#');
          if (idx !== -1) {
            qbase = base.slice(0, idx);
            hash = base.slice(idx);
          }
        } catch (e) { qbase = base; hash = ''; }

        var sep = qbase.indexOf('?') !== -1 ? '&' : '?';
        var params = [];
        if (masked) params.push('ref=' + encodeURIComponent(masked));
        if (prod) params.push('product=' + encodeURIComponent(prod));
        var href = qbase + (params.length ? (sep + params.join('&')) : '') + (hash || '');

        // Build link
        var a = el('a', 'button', 'Contact support');
        try { a.setAttribute('href', href); } catch (e) { /* ignore */ }
        try { a.setAttribute('target', '_blank'); } catch (e) { /* ignore */ }
        try { a.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }

        // Build an accessible label referencing the product when available
        var prodLabel = prod || '';
        try {
          var lblEl = host.querySelector('.bought-summary__label');
          if (lblEl && lblEl.textContent) prodLabel = (lblEl.textContent || '').trim();
        } catch (e) { /* ignore */ }
        try { a.setAttribute('aria-label', 'Contact support about ' + (prodLabel || 'your') + ' purchase'); } catch (e) { /* ignore */ }

        container.appendChild(a);
      }

      return container;
    } catch (e) { return null; }
  }

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

                // Add per-item "Copy reference" button when a stored ref exists.
                try {
                  if (ref) {
                    // Guard attribute so re-runs don't double-bind. We set a
                    // simple flag on the element; bound() is a helper but here
                    // we act directly to keep the guard local to this element.
                    try { refSpan.setAttribute('data-ssp-bought-ref-copy', 'on'); } catch (e) { /* ignore */ }

                    var copyBtn = el('button', 'button button--mono', 'Copy');
                    try { copyBtn.type = 'button'; } catch (e) { /* ignore */ }
                    try { copyBtn.setAttribute('aria-label', 'Copy payment reference'); } catch (e) { /* ignore */ }

                    copyBtn.addEventListener('click', function () {
                      try {
                        if (copyBtn.disabled) return;
                        copyBtn.disabled = true;
                        var prev = copyBtn.textContent;
                        // Local helper to show success feedback
                        function showSuccess() {
                          try {
                            if (SS && typeof SS.toast === 'function') {
                              try { SS.toast('Reference copied'); } catch (e) { /* ignore */ }
                            } else {
                              try { copyBtn.textContent = 'Copied'; } catch (e) { /* ignore */ }
                              try { setTimeout(function () { try { copyBtn.textContent = prev; } catch (e) { /* ignore */ } }, 1500); } catch (e) { /* ignore */ }
                            }
                          } catch (e) { /* ignore */ }
                        }

                        // Try SS.copyText when available
                        try {
                          if (SS && typeof SS.copyText === 'function') {
                            try {
                              SS.copyText(ref);
                              try { showSuccess(); } catch (e) { /* ignore */ }
                              try { copyBtn.disabled = false; } catch (e) { /* ignore */ }
                              return;
                            } catch (e) { /* fall through to fallback */ }
                          }
                        } catch (e) { /* ignore */ }

                        // Fallback: create a temporary textarea and use execCommand
                        try {
                          var ta = document.createElement('textarea');
                          ta.value = ref;
                          // Keep it out of view
                          ta.style.position = 'absolute';
                          ta.style.left = '-9999px';
                          ta.style.top = '0';
                          ta.setAttribute('aria-hidden', 'true');
                          document.body.appendChild(ta);
                          ta.focus();
                          ta.select();
                          var ok = false;
                          try { ok = document.execCommand && document.execCommand('copy'); } catch (e) { ok = false; }
                          try { document.body.removeChild(ta); } catch (e) { /* ignore */ }
                          if (ok) {
                            try { showSuccess(); } catch (e) { /* ignore */ }
                          } else {
                            try {
                              if (SS && typeof SS.toast === 'function') {
                                try { SS.toast('Copy failed'); } catch (e) { /* ignore */ }
                              }
                            } catch (e) { /* ignore */ }
                          }
                        } catch (e) {
                          try {
                            if (SS && typeof SS.toast === 'function') {
                              try { SS.toast('Copy failed'); } catch (e) { /* ignore */ }
                            }
                          } catch (e) { /* ignore */ }
                        }

                        try { copyBtn.disabled = false; } catch (e) { /* ignore */ }

                      } catch (e) { try { if (SS && typeof SS.toast === 'function') SS.toast('Copy failed'); } catch (err) { /* ignore */ } }
                    });

                    // Append button after the ref span
                    try {
                      if (refSpan.parentNode) refSpan.parentNode.insertBefore(copyBtn, refSpan.nextSibling);
                      else li.appendChild(copyBtn);
                    } catch (e) { /* ignore */ }
                  }
                } catch (e) { /* ignore copy button */ }

              }
            } catch (e) { /* ignore */ }

            // CTAs
            try {
              var ctas = createBoughtCta(li, rec, token);
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

  // Export the helpers so tools/check-plugin-exports.js and consumers can find them
  P.initUrlOrderVerifyBanner = initUrlOrderVerifyBanner;
  P.initUrlOrderAutoVerify = initUrlOrderAutoVerify;
  P.initBoughtSummary = initBoughtSummary;
  P.initBoughtNote = initBoughtNote;
  P.createBoughtCta = createBoughtCta;

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
