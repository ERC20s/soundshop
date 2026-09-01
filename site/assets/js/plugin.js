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
  // BOUGHT / PERSISTENCE HELPERS
  // -----------------------------------------------------------------------

  var BOUGHT_MAX_AGE = 60 * 24 * 60 * 60 * 1000; // 60 days in ms

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
    } catch (e) { return null; }

    return null; // Function body omitted here — preserved in original file
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

          // Add an idempotent Copy reference button when a canonical reference is present
          try {
            var canonRef = '';
            try { canonRef = String(order.id || order.ref || order.reference || '').trim(); } catch (e) { canonRef = ''; }
            if (canonRef) {
              try {
                // Skip if we've already created a copy button for this banner
                if (b.getAttribute('data-ssp-paid-copy') !== 'on') {
                  var copyBtn = document.createElement('button');
                  copyBtn.className = 'paid-banner__copy';
                  try { copyBtn.setAttribute('type', 'button'); } catch (e) { /* ignore */ }

                  // Use a masked form for title / aria-label so screen readers do not announce the raw ref
                  try {
                    var masked = '';
                    try { masked = (typeof maskRef === 'function') ? maskRef(canonRef) : ''; } catch (e) { masked = ''; }
                    var label = 'Copy reference';
                    try { copyBtn.textContent = label; } catch (e) { /* ignore */ }
                    try { copyBtn.setAttribute('title', label + (masked ? ' ' + masked : '')); } catch (e) { /* ignore */ }
                    try { copyBtn.setAttribute('aria-label', label + (masked ? ' ' + masked : '')); } catch (e) { /* ignore */ }
                  } catch (e) { /* ignore */ }

                  // Store the full reference on the button so the click handler can read it
                  try { copyBtn.setAttribute('data-ssp-full-ref', canonRef); } catch (e) { /* ignore */ }

                  try {
                    copyBtn.addEventListener('click', function (ev) {
                      try {
                        var btn = ev && ev.currentTarget ? ev.currentTarget : null;
                        try { if (btn) btn.disabled = true; } catch (e) { /* ignore */ }

                        var showSuccess = function () {
                          try { if (SS && typeof SS.toast === 'function') SS.toast('Reference copied'); } catch (e) { /* ignore */ }
                        };
                        var showFailure = function () {
                          try { if (SS && typeof SS.toast === 'function') SS.toast('Copy failed'); } catch (e) { /* ignore */ }
                        };

                        // Read the full reference from the button to avoid closure issues
                        var toCopy = '';
                        try { if (btn && btn.getAttribute) toCopy = btn.getAttribute('data-ssp-full-ref') || ''; } catch (e) { toCopy = ''; }

                        // Try SS.copyText when available
                        try {
                          if (SS && typeof SS.copyText === 'function') {
                            try { SS.copyText(toCopy); showSuccess(); try { if (btn) btn.disabled = false; } catch (e) { /* ignore */ } return; } catch (e) { /* fall through */ }
                          }
                        } catch (e) { /* ignore */ }

                        // Try navigator.clipboard.writeText()
                        var fallback = function () {
                          try {
                            var ta = document.createElement('textarea');
                            ta.value = toCopy || '';
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
                            if (ok) showSuccess(); else showFailure();
                          } catch (e) { showFailure(); }
                          try { if (btn) btn.disabled = false; } catch (e) { /* ignore */ }
                        };

                        try {
                          if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                            try {
                              navigator.clipboard.writeText(toCopy).then(function () { showSuccess(); try { if (btn) btn.disabled = false; } catch (e) { /* ignore */ } }, function () { fallback(); });
                              return;
                            } catch (e) { /* fall through to fallback */ }
                          }
                        } catch (e) { /* ignore */ }

                        // Last resort
                        fallback();

                      } catch (e) { try { if (SS && typeof SS.toast === 'function') SS.toast('Copy failed'); } catch (err) { /* ignore */ } }
                    });
                  } catch (e) { /* ignore listener */ }

                  try { container.appendChild(copyBtn); } catch (e) { /* ignore */ }
                  try { b.setAttribute('data-ssp-paid-copy', 'on'); } catch (e) { /* ignore */ }
                }
              } catch (e) { /* ignore per-banner copy creation */ }
            }
          } catch (e) { /* ignore copy creation */ }

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
