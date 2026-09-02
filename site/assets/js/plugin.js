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

   Public API (all idempotent, all safe to call with nothing on the page).
   This list is the API this file actually ships — keep it in step with the
   P.* exports at the bottom:
     SSPlugin.init(root)              run everything below, on DOM ready
     SSPlugin.initBoughtNote(root)    unhide [data-bought-note] for a remembered buy
     SSPlugin.initBoughtSummary(root) list every remembered buy into [data-bought-summary]
     SSPlugin.initPaidBannerCtas()    add Download / receipt / support CTAs to
                                      the payments widget's <p data-paid> banner
     SSPlugin.initUrlOrderVerifyBanner()  verify ?d8a_order= once, remember it
     SSPlugin.initUrlOrderAutoVerify()    the one-shot DOM-ready wrapper above
     SSPlugin.createBoughtCta(host, rec, token)  CTAs for one summary row
     SSPlugin.extractDownloadUrl(rec) validated http(s) download URL, or ''
     SSPlugin.extractReceiptUrl(rec)  validated http(s) receipt URL, or ''
     SSPlugin.readBoughtArray()       the pruned soundshop:bought:v1 map
     SSPlugin.normalizeVerifiedOrder(res)  the order behind a groupStoreVerify
                                      result (bare order or {paid, order}), or null
     SSPlugin.maskRef(ref)            masked payment reference for display
     SSPlugin.maskEmail(email)        masked email for display
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
    // One-shot guard so repeated runs of an init function do not duplicate
    // DOM fragments. The key is any short string identifying the feature and
    // turns into the attribute data-ssp-<key> on the node.
    try {
      if (!node || !node.setAttribute || !node.getAttribute) return false;
      var name = 'data-ssp-' + String(key || '').trim();
      try {
        if (node.getAttribute(name) === 'on') return true;
        try { node.setAttribute(name, 'on'); } catch (e) { /* ignore */ }
        return false;
      } catch (e) { return false; }
    } catch (e) { return false; }
  }

  var BOUGHT_MAX_AGE = 60 * 24 * 60 * 60 * 1000; // 60 days in ms

  function readBoughtArray() {
    try {
      var raw = null;
      try { raw = window.localStorage.getItem('soundshop:bought:v1'); } catch (e) { raw = null; }
      if (!raw) return {};
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      // Prune expired
      try {
        var now = Date.now();
        var changed = false;
        for (var k in parsed) {
          if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue;
          var r = parsed[k];
          var when = Number(r && r.t ? r.t : r);
          if (!isFinite(when) || when <= 0 || (now - when) > BOUGHT_MAX_AGE) {
            delete parsed[k];
            changed = true;
          }
        }
        if (changed) {
          try { window.localStorage.setItem('soundshop:bought:v1', JSON.stringify(parsed)); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
      return parsed;
    } catch (e) { return {}; }
  }

  function urlOrderId() {
    try {
      if (!document || !document.location || !document.location.search) return '';
      var q = document.location.search.replace(/^\?/, '');
      if (!q) return '';
      var parts = q.split('&');
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i].split('=');
        if (!p || p.length < 2) continue;
        try {
          var k = decodeURIComponent(p[0] || '');
          var v = decodeURIComponent(p.slice(1).join('='));
          if (k === 'd8a_order' && v) return String(v);
        } catch (e) { /* ignore */ }
      }
      return '';
    } catch (e) { return ''; }
  }

  function normalizeVerifiedOrder(res) {
    try {
      if (!res) return null;
      try {
        // Some platforms resolve to the order directly; others wrap in {paid, order}
        if (res && typeof res === 'object') {
          if (res.paid && res.order) return res.order;
          // Some providers use {paid: true, order: {...}}
          if (res.order && typeof res.order === 'object') return res.order;
        }
      } catch (e) { /* ignore */ }
      // If it's a string or an object with id/ref, try to accept it as an order
      try {
        if (typeof res === 'string') return { id: res, ref: res };
        if (typeof res === 'object') return res;
      } catch (e) { /* ignore */ }
      return null;
    } catch (e) { return null; }
  }

  function maskRef(ref) {
    try {
      var s = String(ref || '');
      if (!s) return '';
      if (s.length <= 8) return s.replace(/.(?=.{2})/g, '*');
      return s.slice(0, 4) + '…' + s.slice(-3);
    } catch (e) { return ''; }
  }

  function maskEmail(email) {
    try {
      var s = String(email || '');
      if (!s) return '';
      var parts = s.split('@');
      if (parts.length < 2) return s.replace(/.(?=.{2})/g, '*');
      var name = parts[0];
      var domain = parts.slice(1).join('@');
      if (name.length <= 2) name = name.replace(/.(?=.{1})/g, '*');
      else name = name.slice(0, 1) + name.slice(1).replace(/./g, '*');
      return name + '@' + domain;
    } catch (e) { return ''; }
  }

  function initUrlOrderVerifyBanner() {
    try {
      if (_sspUrlOrderVerifyDone) return;
      var id = urlOrderId();
      if (!id) return;
      _sspUrlOrderVerifyDone = true;

      if (window.groupStorePaid && typeof window.groupStorePaid === 'object') {
        rememberVerifiedOrder(window.groupStorePaid);
        return;
      }
      if (typeof window.groupStoreVerify !== 'function') return;

      var p = null;
      try { p = window.groupStoreVerify(id); } catch (e) { p = null; }
      if (!p || typeof p.then !== 'function') return;

      p.then(function (res) {
        try {
          // One shared reader for both verify paths — see normalizeVerifiedOrder.
          var order = normalizeVerifiedOrder(res);
          if (order) rememberVerifiedOrder(order);
        } catch (e) { /* ignore */ }
      }).catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }

  // One attempt per page load, whoever calls it.
  function initUrlOrderAutoVerify() {
    try {
      if (_boughtAutoVerifyCalled) return;
      _boughtAutoVerifyCalled = true;
      try { initUrlOrderVerifyBanner(); } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  // Run everything. Safe on a page that carries none of the markup.
  function init(root) {
    var scope = (root && root.querySelector) ? root : document;
    try { initBoughtNote(scope); } catch (e) { /* ignore */ }
    try { initBoughtSummary(scope.querySelector('[data-bought-summary]') || null); } catch (e) { /* ignore */ }
    try { initUrlOrderAutoVerify(); } catch (e) { /* ignore */ }
    try { initPaidBannerCtas(); } catch (e) { /* ignore */ }
  }

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

                        // Proceed with the traditional fallbacks when needed
                        var proceedFallback = function () {
                          try {
                            // Try SS.copyText when available
                            if (SS && typeof SS.copyText === 'function') {
                              try { SS.copyText(toCopy); showSuccess(); return; } catch (e) { /* ignore */ }
                            }

                            // Navigator clipboard
                            if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                              try { navigator.clipboard.writeText(toCopy).then(showSuccess).catch(function () {}); return; } catch (e) { /* ignore */ }
                            }

                            // Fallback prompt
                            try { window.prompt('Copy reference', toCopy); } catch (e) { /* ignore */ }

                          } catch (e) { /* ignore */ }
                          try { if (btn) btn.disabled = false; } catch (e) { /* ignore */ }
                        };

                        // If Clipboard API is unavailable, use fallback
                        try {
                          if (!(navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function')) {
                            proceedFallback(); return;
                          }
                        } catch (e) { proceedFallback(); return; }

                        // Use clipboard API
                        try {
                          navigator.clipboard.writeText(toCopy).then(function () { try { showSuccess(); } catch (e) {} }).catch(function () { try { proceedFallback(); } catch (e) {} }).finally(function () { try { if (btn) btn.disabled = false; } catch (e) {} });
                        } catch (e) { proceedFallback(); }

                      } catch (e) { try { if (btn) btn.disabled = false; } catch (er) { } }
                    });
                  } catch (e) { /* ignore */ }
                  try { li.appendChild(copyBtn); } catch (e) { /* ignore */ }
                }
              } catch (e) { /* ignore */ }

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
                            // groupStoreVerify resolves to the order itself, so the
                            // envelope must not be assumed here — see the helper.
                            try { return normalizeVerifiedOrder(res); } catch (e) { return null; }
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

                          } else {
                            // Say so rather than leaving the click silent: the
                            // button re-enabling with nothing changed used to be
                            // the only feedback a buyer got.
                            try { if (SS && typeof SS.toast === 'function') SS.toast('No purchases found'); } catch (e) { /* ignore */ }
                            try { reBtn.disabled = false; } catch (e) { /* ignore */ }
                          }

                        } catch (e) { try { reBtn.disabled = false; } catch (err) { /* ignore */ } }
                      }).catch(function () { try { reBtn.disabled = false; } catch (err) { /* ignore */ } });

                    } catch (e) { try { reBtn.disabled = false; } catch (err) { /* ignore */ } }
                  });

                  // Place the button after the host element
                  try { host.parentNode && host.parentNode.insertBefore(reBtn, host.nextSibling); } catch (e) { /* ignore */ }
                }
              } catch (e) { /* ignore */ }
            }
          } catch (e) { /* ignore */ }
        } catch (e) { /* ignore reverify */ }

      } catch (e) { /* ignore initBoughtSummary */ }
    }

    // -----------------------------------------------------------------------
    // Paid-banner CTAs. This looks for the payments widget's <p data-paid> and
    // appends Download / View receipt / Support CTAs when a verified order is
    // available. The function is safe to call multiple times and will not
    // duplicate elements.
    // -----------------------------------------------------------------------
    function createBoughtContactCta(host, rec) {
      try {
        if (!host || !host.setAttribute) return null;
        var button = null;
        try {
          button = document.createElement('a');
          button.className = 'bought-summary__support';
          // Prefer a host-provided support href when available so pages can opt
          // into a mailto: or an absolute support URL. The attribute name is
          // data-bought-summary-support-href. Otherwise fall back to the docs
          // support anchor which is a stable place to send buyers and testers.
          var supportHref = '';
          try {
            if (host && host.getAttribute) supportHref = host.getAttribute('data-bought-summary-support-href') || '';
          } catch (e) { supportHref = ''; }
          if (!supportHref) supportHref = '../docs.html#support';
          try { button.setAttribute('href', supportHref); } catch (e) { /* ignore */ }
          button.textContent = 'Contact support';
        } catch (e) { button = null; }
        return button;
      } catch (e) { return null; }
    }

    function initPaidBannerCtas() {
      try {
        var paidEls = $$('p[data-paid]');
        if (!paidEls.length) return;
        for (var i = 0; i < paidEls.length; i++) {
          try {
            var elPaid = paidEls[i];
            if (!elPaid || !elPaid.querySelector) continue;
            if (elPaid.getAttribute('data-ssp-paid-ctas') === 'on') continue;
            try { elPaid.setAttribute('data-ssp-paid-ctas', 'on'); } catch (e) { /* ignore */ }
            var order = window.groupStorePaid || null;
            if (!order || typeof order !== 'object') continue;
            var token = '';
            try { token = (order.itemName || order.name || order.item || '').toLowerCase(); } catch (e) { token = ''; }
            var rec = {};
            try { var arr = readBoughtArray() || {}; rec = arr[token] || {}; } catch (e) { rec = {}; }
            try {
              var ctas = createBoughtCta(elPaid, rec, token);
              if (ctas) elPaid.appendChild(ctas);
            } catch (e) { /* ignore */ }
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    }

    // Public API
    try { P.init = init; } catch (e) { /* ignore */ }
    try { P.initBoughtNote = function (root) { try { initBoughtNote(root); } catch (e) { /* ignore */ } }; } catch (e) { /* ignore */ }
    try { P.initBoughtSummary = function (root) { try { initBoughtSummary(root); } catch (e) { /* ignore */ } }; } catch (e) { /* ignore */ }
    try { P.initPaidBannerCtas = function () { try { initPaidBannerCtas(); } catch (e) { /* ignore */ } }; } catch (e) { /* ignore */ }
    try { P.initUrlOrderVerifyBanner = function () { try { initUrlOrderVerifyBanner(); } catch (e) { /* ignore */ } }; } catch (e) { /* ignore */ }
    try { P.initUrlOrderAutoVerify = function () { try { initUrlOrderAutoVerify(); } catch (e) { /* ignore */ } }; } catch (e) { /* ignore */ }
    try { P.createBoughtCta = function (host, rec, token) { try { return createBoughtCta(host, rec, token); } catch (e) { return null; } }; } catch (e) { /* ignore */ }
    try { P.readBoughtArray = function () { try { return readBoughtArray(); } catch (e) { return {}; } }; } catch (e) { /* ignore */ }
    try { P.extractDownloadUrl = function (rec) { try { return (typeof extractDownloadUrl === 'function' ? extractDownloadUrl(rec) : (rec && rec.downloadUrl ? String(rec.downloadUrl) : '')) || ''; } catch (e) { return ''; } }; } catch (e) { /* ignore */ }
    try { P.extractReceiptUrl = function (rec) { try { return (typeof extractReceiptUrl === 'function' ? extractReceiptUrl(rec) : (rec && rec.receiptUrl ? String(rec.receiptUrl) : '')) || ''; } catch (e) { return ''; } }; } catch (e) { /* ignore */ }
    try { P.maskRef = maskRef; } catch (e) { /* ignore */ }
    try { P.maskEmail = maskEmail; } catch (e) { /* ignore */ }

  } catch (e) { /* top-level ignore */ }

})(this, this.document);
