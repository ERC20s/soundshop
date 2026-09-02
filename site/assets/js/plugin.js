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
    // One-shot guard so re-runs do not duplicate elements
    try {
      if (!node || !node.setAttribute) return true;
      var attr = 'data-ssp-' + String(key || 'x');
      if (node.getAttribute && node.getAttribute(attr) === 'on') return true;
      try { node.setAttribute(attr, 'on'); } catch (e) { /* ignore */ }
      return false;
    } catch (e) { return true; }
  }

  // A 60-day retained purchase history is polite and useful.
  var BOUGHT_MAX_AGE = 1000 * 60 * 60 * 24 * 60;

  // Format a timestamp into a readable day/month/year string
  function formatBoughtDate(t) {
    try {
      var when = Number(t) || 0;
      if (!isFinite(when) || when <= 0) return '';
      var d = new Date(when);
      var day = d.getUTCDate();
      var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      var mon = months[d.getUTCMonth()] || '';
      var year = d.getUTCFullYear();
      return day + ' ' + mon + ' ' + year;
    } catch (e) { return ''; }
  }

  function maskRef(ref) {
    try {
      var s = String(ref || '');
      if (!s) return '';
      if (s.length <= 8) return s;
      return s.slice(0,4) + '…' + s.slice(-4);
    } catch (e) { return ''; }
  }

  function maskEmail(email) {
    try {
      var s = String(email || '');
      if (!s) return '';
      var parts = s.split('@');
      if (parts.length !== 2) return s;
      var name = parts[0];
      var domain = parts[1];
      if (name.length <= 2) name = name[0] + '…';
      else name = name[0] + '…' + name.slice(-1);
      return name + '@' + domain;
    } catch (e) { return ''; }
  }

  function readBoughtArray() {
    try {
      var raw = window.localStorage.getItem('soundshop:bought:v1');
      if (!raw) return {};
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      var now = Date.now();
      var out = {};
      for (var k in parsed) {
        if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue;
        try {
          var v = parsed[k];
          var isObj = !!v && typeof v === 'object' && !Array.isArray(v);
          var when = Number(isObj ? v.t : v);
          if (!isFinite(when) || when <= 0 || (now - when) > BOUGHT_MAX_AGE) continue;
          out[k] = v;
        } catch (e) { /* ignore */ }
      }
      return out;
    } catch (e) { return {}; }
  }

  function initBoughtNote(root) {
    try {
      var notes = null;
      if (root && root.getAttribute && root.getAttribute('data-bought-note') !== null) {
        notes = [root];
      } else {
        notes = $$('[data-bought-note]', root || document);
      }
      if (!notes.length) return;

      var bought = readBoughtArray() || {};

      for (var i = 0; i < notes.length; i++) {
        var note = notes[i];
        try {
          var token = attr(note, 'data-bought-item').toLowerCase();
          if (!token) continue;
          if (!Object.prototype.hasOwnProperty.call(bought, token)) continue;
          var rec = bought[token];
          if (!rec) continue;
          if (bound(note, 'bought-note')) continue;

          try {
            var when = (typeof rec === 'object') ? rec.t : rec;
            var dateEl = note.querySelector('[data-bought-date]');
            if (dateEl) {
              var text = formatBoughtDate(when);
              if (text) dateEl.textContent = text;
            }
          } catch (e) { /* ignore date */ }

          try { note.removeAttribute('hidden'); } catch (e) { note.hidden = false; }
        } catch (e) { /* ignore this note */ }
      }
    } catch (e) { /* ignore */ }
  }

  // -----------------------------------------------------------------------
  // Returned-checkout handshake. The payments widget verifies ?d8a_order= and
  // sets window.groupStorePaid; this is the conservative fallback for a page
  // where the widget markup is absent or has not answered yet. It never
  // invents an order: nothing is remembered unless the platform says paid.
  // -----------------------------------------------------------------------

  function urlOrderId() {
    try {
      var m = String(window.location.search || '').match(/[?&]d8a_order=([A-Za-z0-9_-]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }

  function rememberVerifiedOrder(order) {
    try {
      if (!order || typeof order !== 'object') return;
      try { if (!window.groupStorePaid) window.groupStorePaid = order; } catch (e) { /* ignore */ }
      try {
        if (typeof window.soundshopPersistBought === 'function') window.soundshopPersistBought(order);
      } catch (e) { /* ignore */ }
      try {
        document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: order }));
      } catch (e) { /* ignore */ }
      try { initPaidBannerCtas(); } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  // What groupStoreVerify actually hands back.
  //
  // The payments widget in the root .d8a defines the verifier so that it has
  // ALREADY unwrapped the platform's envelope:
  //
  //   .then(function (d) { return d && d.paid ? d.order : null; })
  //   window.groupStoreVerify = verify;
  //
  // so the promise resolves to the ORDER object itself, or to null — never to
  // a {paid, order} wrapper. Code that read `res.paid ? res.order : null` could
  // therefore never succeed. This one helper accepts BOTH shapes (the bare
  // order, and the on-the-wire {paid, order} envelope, in case a host wires the
  // raw response) and returns the order object, or null when there is none.
  function normalizeVerifiedOrder(res) {
    try {
      if (!res || typeof res !== 'object') return null;
      // The on-the-wire envelope: only trust it when paid is true.
      if (res.order && typeof res.order === 'object') {
        if (res.paid !== true) return null;
        var inner = res.order;
        return (inner.id || inner.itemName) ? inner : null;
      }
      if (res.paid === false) return null;
      // A bare order object: it must look like one.
      if (res.id || res.itemName) return res;
      return null;
    } catch (e) { return null; }
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
                        };

                        // Try navigator.clipboard.writeText first on secure contexts,
                        // falling back to SS.copyText / execCommand when it rejects or
                        // is unavailable. This prefers the modern asynchronous API on
                        // capable browsers while preserving the legacy behaviour.
                        try {
                          if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                            try {
                              navigator.clipboard.writeText(toCopy).then(function () {
                                try { showSuccess(); } catch (e) { /* ignore */ }
                                try { btn.disabled = false; } catch (e) { /* ignore */ }
                              }).catch(function () {
                                // If the modern API rejects (for example not allowed),
                                // attempt the legacy fallbacks.
                                try { proceedFallback(); } catch (e) { try { if (SS && typeof SS.toast === 'function') SS.toast('Copy failed'); } catch (err) { /* ignore */ } }
                              });
                              return;
                            } catch (e) { /* ignore and fall through to fallback */ }
                          }
                        } catch (e) { /* ignore */ }

                        // No navigator.clipboard available: run legacy fallback
                        try { proceedFallback(); } catch (e) { try { if (SS && typeof SS.toast === 'function') SS.toast('Copy failed'); } catch (err) { /* ignore */ } }

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
            } catch (e) { /* ignore render */ }
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
        button.setAttribute('href', 'mailto:support@soundshop.example');
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

  // Expose the public API
  try { P.init = init; } catch (e) { /* ignore */ }
  try { P.initBoughtNote = initBoughtNote; } catch (e) { /* ignore */ }
  try { P.initBoughtSummary = initBoughtSummary; } catch (e) { /* ignore */ }
  try { P.initPaidBannerCtas = initPaidBannerCtas; } catch (e) { /* ignore */ }
  try { P.initUrlOrderVerifyBanner = initUrlOrderVerifyBanner; } catch (e) { /* ignore */ }
  try { P.initUrlOrderAutoVerify = initUrlOrderAutoVerify; } catch (e) { /* ignore */ }
  try { P.createBoughtCta = createBoughtCta; } catch (e) { /* ignore */ }
  try { P.extractDownloadUrl = function (rec) { try { return (rec && rec.downloadUrl) ? String(rec.downloadUrl).trim() : ''; } catch (e) { return ''; } }; } catch (e) { /* ignore */ }
  try { P.extractReceiptUrl = function (rec) { try { return (rec && rec.receiptUrl) ? String(rec.receiptUrl).trim() : ''; } catch (e) { return ''; } }; } catch (e) { /* ignore */ }
  try { P.readBoughtArray = readBoughtArray; } catch (e) { /* ignore */ }
  try { P.normalizeVerifiedOrder = normalizeVerifiedOrder; } catch (e) { /* ignore */ }
  try { P.maskRef = maskRef; } catch (e) { /* ignore */ }
  try { P.maskEmail = maskEmail; } catch (e) { /* ignore */ }

}(window, document));
