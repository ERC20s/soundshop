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

      // Prefer using a validated download URL helper when present. Compute the
      // actual validated URL (not just a boolean) so we can create a safe link.
      var downloadUrl = '';
      try {
        if (typeof extractDownloadUrl === 'function') {
          try { downloadUrl = extractDownloadUrl(rec) || ''; } catch (e) { downloadUrl = ''; }
        } else {
          downloadUrl = (rec && rec.downloadUrl) ? String(rec.downloadUrl).trim() : '';
          if (downloadUrl && !/^https?:\/\//i.test(downloadUrl)) downloadUrl = '';
        }
      } catch (e) { downloadUrl = ''; }
      var hasDownload = !!downloadUrl;

      var container = el('div', 'bought-summary__ctas');

      // If a download URL is present, surface a 'Download' button first so the
      // buyer can open the installer directly. Use an accessible label that
      // references the product when available.
      try {
        if (hasDownload) {
          var da = el('a', 'button', 'Download');
          try { da.setAttribute('href', downloadUrl); } catch (e) { /* ignore */ }
          try { da.setAttribute('target', '_blank'); } catch (e) { /* ignore */ }
          try { da.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }
          try {
            var prodLabel = token || '';
            try {
              var lblEl = host.querySelector('.bought-summary__label');
              if (lblEl && lblEl.textContent) prodLabel = (lblEl.textContent || '').trim();
            } catch (e) { /* ignore */ }
            try { da.setAttribute('aria-label', 'Download your ' + (prodLabel || 'purchase') + ' installer'); } catch (e) { /* ignore */ }
          } catch (e) { /* ignore */ }
          container.appendChild(da);
        }
      } catch (e) { /* ignore download anchor */ }

      // If a provider receipt URL is present, surface a 'View receipt' button
      // before adding the Contact support CTA so users can quickly open the
      // payment provider's receipt page. Use extractReceiptUrl when available
      // for validation; otherwise fall back to rec.receiptUrl. 
      try {
        var receiptUrl = '';
        try {
          if (typeof extractReceiptUrl === 'function') {
            try { receiptUrl = extractReceiptUrl(rec) || ''; } catch (e) { receiptUrl = ''; }
          } else {
            receiptUrl = (rec && rec.receiptUrl) ? String(rec.receiptUrl).trim() : '';
            if (receiptUrl && !/^https?:\/\//i.test(receiptUrl)) receiptUrl = '';
          }
        } catch (e) { receiptUrl = ''; }
        if (receiptUrl) {
          var ra = el('a', 'button', 'View receipt');
          try { ra.setAttribute('href', receiptUrl); } catch (e) { /* ignore */ }
          try { ra.setAttribute('target', '_blank'); } catch (e) { /* ignore */ }
          try { ra.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }
          try {
            var prodLabel2 = token || '';
            try {
              var lblEl2 = host.querySelector('.bought-summary__label');
              if (lblEl2 && lblEl2.textContent) prodLabel2 = (lblEl2.textContent || '').trim();
            } catch (e) { /* ignore */ }
            try { ra.setAttribute('aria-label', 'View receipt for ' + (prodLabel2 || 'your') + ' purchase'); } catch (e) { /* ignore */ }
          } catch (e) { /* ignore */ }
          container.appendChild(ra);
        }
      } catch (e) { /* ignore receipt anchor */ }

      // Contact support CTA (always available)
      try {
        var masked = '';
        try { masked = maskRef(rec.ref); } catch (e) { masked = ''; }
        var prod = token || '';
        try {
          var a = el('a', 'button', 'Contact support');
          var base = attr(document.querySelector('[data-bought-support-url]') || document.body, 'data-bought-support-url') || '';
          var qbase = base;
          var hash = '';
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

          try { a.setAttribute('href', href); } catch (e) { /* ignore */ }
          try { a.setAttribute('target', '_blank'); } catch (e) { /* ignore */ }
          try { a.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }

          var prodLabel = prod || '';
          try {
            var lblEl = host.querySelector('.bought-summary__label');
            if (lblEl && lblEl.textContent) prodLabel = (lblEl.textContent || '').trim();
          } catch (e) { /* ignore */ }
          try { a.setAttribute('aria-label', 'Contact support about ' + (prodLabel || 'your') + ' purchase'); } catch (e) { /* ignore */ }

          container.appendChild(a);
        } catch (e) { /* ignore */ }
      } catch (e) { /* ignore */ }

      // Re-verify purchase CTA: only when no validated download or receipt is
      // present, the recorded ref exists, and a verifier function is provided
      // by the host page as window.groupStoreVerify. The handler accepts a
      // synchronous or Promise return and calls the safe local persist helper
      // when an order object is returned.
      try {
        var hasReceipt = false;
        try { hasReceipt = !!(receiptUrl); } catch (e) { hasReceipt = false; }
        if (!hasDownload && !hasReceipt && rec && rec.ref && typeof window.groupStoreVerify === 'function') {
          var revBtn = el('button', 'button', 'Re-verify purchase');
          try { revBtn.setAttribute('type', 'button'); } catch (e) { /* ignore */ }
          try {
            revBtn.addEventListener('click', function (e) {
              try {
                var btn = e && e.currentTarget ? e.currentTarget : null;
                try { if (btn) btn.disabled = true; } catch (err) { /* ignore */ }

                var show = function (msg) {
                  try { if (SS && typeof SS.toast === 'function') SS.toast(msg); } catch (e) { /* ignore */ }
                };

                var handleOrder = function (order) {
                  try {
                    if (order && typeof order === 'object') {
                      try { if (typeof window.soundshopPersistBought === 'function') window.soundshopPersistBought(order); } catch (e) { /* ignore */ }
                      try { show('Purchase verified'); } catch (e) { /* ignore */ }
                    } else {
                      try { show('Verification failed'); } catch (e) { /* ignore */ }
                    }
                  } catch (e) { try { show('Verification failed'); } catch (err) { /* ignore */ } }
                  try { if (btn) btn.disabled = false; } catch (e) { /* ignore */ }
                };

                var res;
                try { res = window.groupStoreVerify(rec.ref); } catch (err) { try { show('Verification failed'); } catch (e) { /* ignore */ } try { if (btn) btn.disabled = false; } catch (e) { /* ignore */ } return; }

                try {
                  if (res && typeof res.then === 'function') {
                    res.then(function (order) { handleOrder(order); }, function () { try { show('Verification failed'); } catch (e) { /* ignore */ } try { if (btn) btn.disabled = false; } catch (e) { /* ignore */ } });
                  } else {
                    handleOrder(res);
                  }
                } catch (e) {
                  try { show('Verification failed'); } catch (err) { /* ignore */ }
                  try { if (btn) btn.disabled = false; } catch (e) { /* ignore */ }
                }

              } catch (e) { try { if (SS && typeof SS.toast === 'function') SS.toast('Verification failed'); } catch (err) { /* ignore */ } }
            });
          } catch (e) { /* ignore listener */ }
          try { container.appendChild(revBtn); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore re-verify */ }

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

          // Collect summary details for aria-live message
          var items = [];

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

            try { var span = el('span', 'bought-summary__label', label); if (span) li.appendChild(span); } catch (e) { /* ignore */ }

            // Reference
            try {
              var fullRef = '';
              try { fullRef = String(rec.ref || ''); } catch (e) { fullRef = ''; }
              var masked = '';
              try { masked = maskRef(fullRef); } catch (e) { masked = ''; }
              var refSpan = el('span', 'bought-summary__ref', masked || '');
              try { if (refSpan && typeof refSpan.setAttribute === 'function') refSpan.setAttribute('data-full-ref', fullRef || ''); } catch (e) { /* ignore */ }
              try { if (refSpan && refSpan.textContent) li.appendChild(refSpan); } catch (e) { /* ignore */ }
            } catch (e) { /* ignore */ }

            // Determine validated download/receipt presence for this item so the
            // aria-live summary can reflect availability. Mirror the same
            // conservative detection used in createBoughtCta().
            var hasDownload = false;
            var hasReceipt = false;
            try {
              var downloadUrl = '';
              try {
                if (typeof extractDownloadUrl === 'function') {
                  try { downloadUrl = extractDownloadUrl(rec) || ''; } catch (e) { downloadUrl = ''; }
                } else {
                  downloadUrl = (rec && rec.downloadUrl) ? String(rec.downloadUrl).trim() : '';
                  if (downloadUrl && !/^https?:\/\//i.test(downloadUrl)) downloadUrl = '';
                }
              } catch (e) { downloadUrl = ''; }
              hasDownload = !!downloadUrl;

              var receiptUrl = '';
              try {
                if (typeof extractReceiptUrl === 'function') {
                  try { receiptUrl = extractReceiptUrl(rec) || ''; } catch (e) { receiptUrl = ''; }
                } else {
                  receiptUrl = (rec && rec.receiptUrl) ? String(rec.receiptUrl).trim() : '';
                  if (receiptUrl && !/^https?:\/\//i.test(receiptUrl)) receiptUrl = '';
                }
              } catch (e) { receiptUrl = ''; }
              hasReceipt = !!receiptUrl;
            } catch (e) { /* ignore detection */ }

            // Record for summary
            try {
              var when = 0;
              try { when = Number(rec.t) || 0; } catch (e) { when = 0; }
              items.push({ label: (label || token), t: when, hasDownload: !!hasDownload, hasReceipt: !!hasReceipt });
            } catch (e) { /* ignore */ }

            // Copy button (per-item)
            try {
              var refSpan2 = null;
              try { refSpan2 = li.querySelector('.bought-summary__ref'); } catch (e) { refSpan2 = null; }
              if (refSpan2) {
                var copyBtn = el('button', 'bought-summary__copy', 'Copy reference');
                try { copyBtn.setAttribute('type', 'button'); } catch (e) { /* ignore */ }
                try {
                  copyBtn.addEventListener('click', function (e) {
                    try {
                      var btn = e && e.currentTarget ? e.currentTarget : null;
                      try { if (btn) btn.disabled = true; } catch (err) { /* ignore */ }

                      var showSuccess = function () {
                        try {
                          if (SS && typeof SS.toast === 'function') {
                            try { SS.toast('Reference copied'); } catch (e) { /* ignore */ }
                          }
                        } catch (e) { /* ignore */ }
                      };

                      var toCopy = '';
                      try {
                        var container = btn.parentNode || null;
                        var refEl = null;
                        try { if (container && container.querySelector) refEl = container.querySelector('.bought-summary__ref'); } catch (e) { refEl = null; }
                        if (refEl && refEl.getAttribute) {
                          try { toCopy = refEl.getAttribute('data-full-ref') || refEl.textContent || ''; } catch (e) { toCopy = refEl.textContent || ''; }
                        }
                        if (!toCopy) {
                          // Fallback: use button's closest li record via DOM dataset/attributes
                          try { toCopy = fullRef || ''; } catch (e) { toCopy = ''; }
                        }
                      } catch (e) { toCopy = fullRef || ''; }

                      // Try SS.copyText when available
                      try {
                        if (SS && typeof SS.copyText === 'function') {
                          try {
                            SS.copyText(toCopy);
                            try { showSuccess(); } catch (e) { /* ignore */ }
                            try { btn.disabled = false; } catch (e) { /* ignore */ }
                            return;
                          } catch (e) { /* fall through to fallback */ }
                        }
                      } catch (e) { /* ignore */ }

                      // Fallback: create a temporary textarea and use execCommand
                      try {
                        var ta = document.createElement('textarea');
                        ta.value = toCopy;
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

                      try { btn.disabled = false; } catch (e) { /* ignore */ }

                    } catch (e) { try { if (SS && typeof SS.toast === 'function') SS.toast('Copy failed'); } catch (err) { /* ignore */ } }
                  });
                } catch (e) { /* ignore listener */ }

                // Append button after the ref span
                try {
                  if (refSpan2 && refSpan2.parentNode) refSpan2.parentNode.insertBefore(copyBtn, refSpan2.nextSibling);
                  else li.appendChild(copyBtn);
                } catch (e) { try { li.appendChild(copyBtn); } catch (err) { /* ignore */ } }
              }
            } catch (e) { /* ignore copy button */ }

            // CTAs
            try {
              var ctas = createBoughtCta(li, rec, token);
              if (ctas) li.appendChild(ctas);
            } catch (e) { /* ignore */ }

            list.appendChild(li);
            any = true;
          }

          // Build or update an aria-live polite status node summarising the
          // remembered purchases so screen-reader users are informed when the
          // bought-summary renders. Keep the message short, idempotent and
          // reuse the same node across re-renders.
          try {
            var statusSelector = '[data-bought-summary-status]';
            var statu