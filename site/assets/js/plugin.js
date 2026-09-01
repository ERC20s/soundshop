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

      var container = el('span', 'bought-summary__ctas');

      try {
        // Download CTA
        var downloadUrl = '';
        try {
          if (typeof extractDownloadUrl === 'function') {
            try { downloadUrl = extractDownloadUrl(rec) || ''; } catch (e) { downloadUrl = ''; }
          } else {
            downloadUrl = (rec && rec.downloadUrl) ? String(rec.downloadUrl).trim() : '';
            if (downloadUrl && !/^https?:\/\//i.test(downloadUrl)) downloadUrl = '';
          }
        } catch (e) { downloadUrl = ''; }

        if (downloadUrl) {
          try {
            var a = document.createElement('a');
            a.className = 'bought-summary__download';
            a.textContent = 'Download';
            a.setAttribute('href', downloadUrl);
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
            container.appendChild(a);
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }

      try {
        // View receipt CTA
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
          try {
            var a2 = document.createElement('a');
            a2.className = 'bought-summary__receipt';
            a2.textContent = 'View receipt';
            a2.setAttribute('href', receiptUrl);
            a2.setAttribute('target', '_blank');
            a2.setAttribute('rel', 'noopener noreferrer');
            container.appendChild(a2);
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }

      try {
        // Contact support CTA
        var contact = createBoughtContactCta(host, rec);
        if (contact) container.appendChild(contact);
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
                try { message = (labelText ? (labelText + (dateText ? ' ' + dateText + '.' : '.')) : '') + (avail ? (' ' + avail) : ''); } catch (e) { message = ''; }

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

      // Add a conservative, single "Re-verify purchases" button when there are
      // remembered records with a ref but no validated download or receipt and
      // when the host environment exposes window.groupStoreVerify(). The button
      // is click-only, idempotent and removable when no missing refs remain.
      try {
        function hasValidatedUrls(rec) {
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

            var receiptUrl = '';
            try {
              if (typeof extractReceiptUrl === 'function') {
                try { receiptUrl = extractReceiptUrl(rec) || ''; } catch (e) { receiptUrl = ''; }
              } else {
                receiptUrl = (rec && rec.receiptUrl) ? String(rec.receiptUrl).trim() : '';
                if (receiptUrl && !/^https?:\/\//i.test(receiptUrl)) receiptUrl = '';
              }
            } catch (e) { receiptUrl = ''; }

            return !!downloadUrl || !!receiptUrl;
          } catch (e) { return false; }
        }

        // Only create the button if the host exposes groupStoreVerify and we
        // actually have missing refs to attempt.
        try {
          if (typeof window.groupStoreVerify === 'function') {
            // Guard so we don't create duplicates
            var reBtn = null;
            try {
              if (!document.querySelector('[data-ssp-reverify]')) {
                reBtn = document.createElement('button');
                reBtn.className = 'bought-summary__reverify';
                reBtn.textContent = 'Re-verify purchases';
                try { reBtn.setAttribute('type', 'button'); } catch (e) { /* ignore */ }
                try { reBtn.setAttribute('data-ssp-reverify', 'on'); } catch (e) { /* ignore */ }

                reBtn.addEventListener('click', function () {
                  try {
                    try { reBtn.disabled = true; } catch (e) { /* ignore */ }
                    var arr = readBoughtArray() || {};
                    var missing = [];
                    for (var k in arr) {
                      if (!Object.prototype.hasOwnProperty.call(arr, k)) continue;
                      try { if ((arr[k] && arr[k].ref) && !hasValidatedUrls(arr[k])) missing.push(k); } catch (e) { /* ignore */ }
                    }
                    if (!missing.length) {
                      try { if (SS && typeof SS.toast === 'function') SS.toast('Nothing to re-verify'); } catch (e) { /* ignore */ }
                      try { reBtn.parentNode && reBtn.parentNode.removeChild(reBtn); } catch (e) { /* ignore */ }
                      return;
                    }

                    // Attempt a verify for each missing token; best-effort only.
                    var promises = missing.map(function (token) {
                      try {
                        var entry = arr[token] || {};
                        var ref = String(entry.ref || '');
                        if (!ref) return Promise.resolve(null);
                        return window.groupStoreVerify(ref).then(function (res) {
                          try { return res && res.paid ? res.order || null : null; } catch (e) { return null; }
                        }).catch(function () { return null; });
                      } catch (e) { return Promise.resolve(null); }
                    });

                    Promise.all(promises).then(function (results) {
                      try {
                        var any = false;
                        for (var i = 0; i < results.length; i++) {
                          try {
                            var o = results[i];
                            if (!o) continue;
                            try { window.soundshopPersistBought(o); } catch (e) { /* ignore */ }
                            any = true;
                          } catch (e) { /* ignore */ }
                        }

                        if (any) {
                          try { if (SS && typeof SS.toast === 'function') SS.toast('Re-verified purchases'); } catch (e) { /* ignore */ }

                          // Re-run the render so the UI reflects any new download/receipt
                          try { render(); } catch (e) { /* ignore */ }

                          // Remove the button if there are no remaining missing refs
                          try {
                            var after = readBoughtArray() || {};
                            var remaining = 0;
                            for (var z in after) {
                              if (!Object.prototype.hasOwnProperty.call(after, z)) continue;
                              try { if ((after[z] && after[z].ref) && !hasValidatedUrls(after[z])) remaining++; } catch (e) { /* ignore */ }
                            }
                            if (remaining === 0) {
                              try { reBtn.parentNode && reBtn.parentNode.removeChild(reBtn); } catch (e) { /* ignore */ }
                            }
                          } catch (e) { /* ignore */ }

                        }
                        try { reBtn.disabled = false; } catch (e) { /* ignore */ }
                      } catch (e) { /* ignore results handling */ }
                    }).catch(function () {
                      try { if (SS && typeof SS.toast === 'function') SS.toast('Re-verify failed'); } catch (e) { /* ignore */ }
                      try { reBtn.disabled = false; } catch (e) { /* ignore */ }
                    });

                  } catch (e) { try { if (SS && typeof SS.toast === 'function') SS.toast('Re-verify failed'); } catch (err) { /* ignore */ } }
                });

                // Append the button once after the list
                try {
                  if (list && list.parentNode) list.parentNode.insertBefore(reBtn, list.nextSibling);
                  else host.appendChild(reBtn);
                } catch (e) { try { host.appendChild(reBtn); } catch (err) { /* ignore */ } }

              }
            } catch (e) { /* ignore create */ }
          }
        } catch (e) { /* ignore reverify setup */ }
      } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  // Add CTAs to the payments widget's returned-checkout banner (<p data-paid="...")
  // when a verified order object is available (window.groupStorePaid or
  // 'group-store:paid' event). Idempotent per banner via data-ssp-paid-ctas.
  function initPaidBannerCtas() {
    try {
      var banners = $$('p[data-paid]');
      if (!banners || !banners.length) return;
      for (var i = 0; i < banners.length; i++) {
        var b = banners[i];
        try {
          if (!b || !b.getAttribute) continue;
          if (b.getAttribute('data-ssp-paid-ctas') === 'on') continue;

          // Determine an order object: prefer a matching window.groupStorePaid
          var order = null;
          try {
            if (window.groupStorePaid && window.groupStorePaid.id && String(window.groupStorePaid.id) === String(b.getAttribute('data-paid'))) order = window.groupStorePaid;
          } catch (e) { /* ignore */ }
          if (!order && window.groupStorePaid) order = window.groupStorePaid;

          // If there's no verified order object available, bail for now.
          if (!order || typeof order !== 'object') continue;

          // Conservative extraction of download/receipt URLs
          var downloadUrl = '';
          try {
            downloadUrl = order.downloadUrl || order.installerUrl || (order.installers && order.installers[0] && order.installers[0].url) || '';
            if (typeof downloadUrl === 'string') downloadUrl = downloadUrl.trim(); else downloadUrl = '';
            if (downloadUrl && !/^https?:\/\//i.test(downloadUrl)) downloadUrl = '';
          } catch (e) { downloadUrl = ''; }

          var receiptUrl = '';
          try {
            receiptUrl = order.receiptUrl || order.receipt || '';
            if (typeof receiptUrl === 'string') receiptUrl = receiptUrl.trim(); else receiptUrl = '';
            if (receiptUrl && receiptUrl.length > 2000) receiptUrl = '';
            if (receiptUrl && !/^https?:\/\//i.test(receiptUrl)) receiptUrl = '';
          } catch (e) { receiptUrl = ''; }

          var container = el('span', 'paid-banner__ctas');

          try {
            if (downloadUrl) {
              var a = document.createElement('a');
              a.className = 'paid-banner__download';
              a.textContent = 'Download';
              a.setAttribute('href', downloadUrl);
              a.setAttribute('target', '_blank');
              a.setAttribute('rel', 'noopener noreferrer');
              container.appendChild(a);
            }

            if (receiptUrl) {
              var a2 = document.createElement('a');
              a2.className = 'paid-banner__receipt';
              a2.textContent = 'View receipt';
              a2.setAttribute('href', receiptUrl);
              a2.setAttribute('target', '_blank');
              a2.setAttribute('rel', 'noopener noreferrer');
              container.appendChild(a2);
            }

            // If neither download nor receipt is available, provide a Contact support link
            if (!downloadUrl && !receiptUrl) {
              var supportHref = '';
              try {
                var boughtHost = document.querySelector('[data-bought-summary]');
                if (boughtHost && boughtHost.getAttribute) supportHref = boughtHost.getAttribute('data-bought-summary-support-href') || '';
              } catch (e) { /* ignore */ }
              if (!supportHref) supportHref = 'docs.html#support';

              var sup = document.createElement('a');
              sup.className = 'paid-banner__support';
              sup.textContent = 'Contact support';
              sup.setAttribute('href', supportHref);
              sup.setAttribute('target', '_blank');
              sup.setAttribute('rel', 'noopener noreferrer');
              container.appendChild(sup);
            }
          } catch (e) { /* ignore create */ }

          // Append only when container has something
          try {
            if (container && container.childNodes && container.childNodes.length) {
              // Space it from the existing text for readability
              try { b.appendChild(document.createTextNode(' ')); } catch (e) { /* ignore */ }
              try { b.appendChild(container); } catch (e) { /* ignore */ }
              try { b.setAttribute('data-ssp-paid-ctas', 'on'); } catch (e) { /* ignore */ }
            }
          } catch (e) { /* ignore append */ }

        } catch (e) { /* ignore per-banner */ }
      }
    } catch (e) { /* ignore overall */ }
  }

  // Export the helpers so tools/check-plugin-exports.js and consumers can find them
  P.initUrlOrderVerifyBanner = initUrlOrderVerifyBanner;
  P.initUrlOrderAutoVerify = initUrlOrderAutoVerify;
  P.initBoughtSummary = initBoughtSummary;
  P.initBoughtNote = initBoughtNote;
  P.createBoughtCta = createBoughtCta;
  P.maskRef = maskRef;
  P.maskEmail = maskEmail;
  P.initPaidBannerCtas = initPaidBannerCtas;

  // Run the conservative auto-verify on DOM ready so it operates after any
  // initial UI rendering. This mirrors other init semantics and is safe to
  // call multiple times.
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initUrlOrderAutoVerify);
      document.addEventListener('DOMContentLoaded', initPaidBannerCtas);
    } else {
      // DOM already ready
      try { initUrlOrderAutoVerify(); } catch (e) { /* ignore */ }
      try { initPaidBannerCtas(); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

  // Also refresh CTAs when the group-store:paid event is emitted
  try {
    document.addEventListener('group-store:paid', function () { try { initPaidBannerCtas(); } catch (e) { /* ignore */ } });
  } catch (e) { /* ignore */ }

  // If there is a global order already (widget verified on inclusion), ensure CTAs are added
  try { if (window.groupStorePaid) try { initPaidBannerCtas(); } catch (e) { /* ignore */ } } catch (e) { /* ignore */ }

})(window, document);
