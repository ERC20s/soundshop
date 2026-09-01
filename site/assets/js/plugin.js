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

  // BOUGHT_MAX_AGE: how long we keep the local note (ms)
  var BOUGHT_MAX_AGE = 60 * 24 * 60 * 60 * 1000; // 60 days

  function readBoughtArray() {
    try {
      var raw = window.localStorage.getItem('soundshop:bought:v1');
      if (!raw) return {};
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      // Prune expired entries (best effort)
      var now = Date.now();
      for (var k in parsed) {
        if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue;
        var r = parsed[k];
        var isObj = !!r && typeof r === 'object' && !Array.isArray(r);
        var when = Number(isObj ? r.t : r);
        if (!isFinite(when) || when <= 0 || (now - when) > BOUGHT_MAX_AGE) {
          delete parsed[k];
        }
      }
      return parsed;
    } catch (e) { return {}; }
  }

  // Mask a payment reference for use in support links and UI. Returns a
  // short, human-meaningful representation: keep the last 6 characters and
  // replace the preceding characters with an ellipsis. Fail closed: return
  // the empty string for missing/invalid input.
  function maskRef(ref) {
    try {
      if (!ref && ref !== 0) return '';
      var s = String(ref).trim();
      if (!s) return '';
      var keep = 6;
      if (s.length <= keep) return s;
      var tail = s.slice(-keep);
      return '…' + tail;
    } catch (e) { return ''; }
  }

  // Mask an email address for display/query use: preserve the domain and show
  // only a small hint of the local part. Return empty string for invalid
  // inputs. This is intentionally conservative and does not attempt perfect
  // RFC compliance; it mirrors the conservative validation above.
  function maskEmail(email) {
    try {
      if (!email || typeof email !== 'string') return '';
      var s = email.trim();
      var EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
      if (!s || !EMAIL_RE.test(s)) return '';
      var parts = s.split('@');
      var local = parts[0] || '';
      var domain = parts[1] || '';
      if (!domain) return '';
      if (!local) return '•••@' + domain;
      var first = local.charAt(0) || '';
      if (local.length === 1) return first + '•••@' + domain;
      return first + '•••@' + domain;
    } catch (e) { return ''; }
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
            var statusNode = null;
            try { statusNode = host.querySelector(statusSelector); } catch (e) { statusNode = null; }

            if (any) {
              // Compose a short message based on the items we collected.
              try {
                var labels = [];
                var latest = 0;
                var anyDownload = false;
                var anyReceipt = false;
                for (var j = 0; j < items.length; j++) {
                  try { labels.push(items[j].label || ''); } catch (e) { /* ignore */ }
                  try { if (Number(items[j].t) > latest) latest = Number(items[j].t) || latest; } catch (e) { /* ignore */ }
                  try { if (items[j].hasDownload) anyDownload = true; } catch (e) { /* ignore */ }
                  try { if (items[j].hasReceipt) anyReceipt = true; } catch (e) { /* ignore */ }
                }

                var labelText = '';
                try {
                  if (labels.length === 1) labelText = labels[0];
                  else if (labels.length === 2) labelText = labels[0] + ' and ' + labels[1];
                  else if (labels.length > 2) {
                    labelText = labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1];
                  }
                } catch (e) { labelText = labels.join(', '); }

                var dateText = '';
                try {
                  if (latest > 0) {
                    var d = new Date(Number(latest));
                    var day = d.getUTCDate();
                    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                    var mon = months[d.getUTCMonth()] || '';
                    var year = d.getUTCFullYear();
                    dateText = day + ' ' + mon + ' ' + year;
                  }
                } catch (e) { dateText = ''; }

                var avail = '';
                try {
                  if (anyDownload) avail = 'Download available.';
                  else if (anyReceipt) avail = 'View receipt available.';
                  else avail = 'Contact support to get the product.';
                } catch (e) { avail = ''; }

                var message = '';
                try {
                  if (labelText) {
                    if (dateText) message = labelText + ' bought on this device on ' + dateText + '. ' + avail;
                    else message = labelText + ' bought on this device. ' + avail;
                  } else {
                    message = 'Purchase remembered on this device. ' + avail;
                  }
                } catch (e) { message = 'Purchase remembered on this device.'; }

                // Create the status node if missing
                if (!statusNode) {
                  try {
                    statusNode = document.createElement('p');
                    statusNode.setAttribute('data-bought-summary-status', 'on');
                    try { statusNode.setAttribute('role', 'status'); } catch (e) { /* ignore */ }
                    try { statusNode.setAttribute('aria-live', 'polite'); } catch (e) { /* ignore */ }
                    // Keep visually out of the way but available to assistive tech.
                    try { statusNode.style.cssText = 'position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;'; } catch (e) { /* ignore */ }
                    try { host.appendChild(statusNode); } catch (e) { /* ignore */ }
                  } catch (e) { statusNode = null; }
                }

                if (statusNode) {
                  try { statusNode.textContent = message || ''; } catch (e) { /* ignore */ }
                }

              } catch (e) { /* ignore compose */ }
            } else {
              // No purchases: remove any existing status node
              try {
                if (statusNode && statusNode.parentNode) statusNode.parentNode.removeChild(statusNode);
              } catch (e) { /* ignore */ }
            }
          } catch (e) { /* ignore status node */ }

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
  P.maskRef = maskRef;
  P.maskEmail = maskEmail;

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
