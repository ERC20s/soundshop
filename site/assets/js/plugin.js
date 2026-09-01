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
          var BOUGHT_MAX_AGE = 60 * 24 * 60 * 60 * 1000; // 60 days
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

  function isFileProtocol() {
    try { return window.location.protocol === 'file:'; } catch (e) { return false; }
  }

  // E

  // Minimal, defensive helpers for bought-summary UI and URL-order verify.
  // These are intentionally small and conservative: no wording, no innerHTML,
  // only unprivileged DOM writes and guarded exports on P.

  var BOUGHT_KEY = 'soundshop:bought:v1';
  var BOUGHT_MAX_AGE = 60 * 24 * 60 * 60 * 1000; // 60 days
  var MAX_DOWNLOAD_URL_LEN = 2000;

  function readBoughtArray() {
    var out = {};
    try {
      var raw = null;
      try { raw = window.localStorage.getItem(BOUGHT_KEY); } catch (e) { raw = null; }
      if (!raw) return out;
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
      var now = Date.now();
      for (var k in parsed) {
        if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue;
        var r = parsed[k];
        if (!r || typeof r !== 'object') continue;
        var when = Number(r.t || 0);
        if (!isFinite(when) || when <= 0) continue;
        if ((now - when) > BOUGHT_MAX_AGE) continue; // expired
        // Shallow copy of accepted fields
        var rec = { t: when, ref: r.ref || '', state: r.state || 'paid' };
        if (r.email && typeof r.email === 'string') rec.email = String(r.email);
        if (r.downloadUrl && typeof r.downloadUrl === 'string') rec.downloadUrl = String(r.downloadUrl);
        if (r.receiptUrl && typeof r.receiptUrl === 'string') rec.receiptUrl = String(r.receiptUrl);
        out[k] = rec;
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function maskEmail(email) {
    try {
      if (!email || typeof email !== 'string') return '';
      var parts = email.split('@');
      if (parts.length !== 2) return email;
      var local = parts[0] || '';
      var domain = parts[1] || '';
      if (local.length <= 2) local = local.charAt(0) + '*';
      else if (local.length <= 4) local = local.charAt(0) + '***' ;
      else local = local.charAt(0) + '***' + local.charAt(local.length - 1);
      return local + '@' + domain;
    } catch (e) { return ''; }
  }

  function extractDownloadUrl(detail) {
    try {
      var d = '';
      if (!detail) return '';
      if (typeof detail === 'string') d = detail.trim();
      else if (detail && typeof detail === 'object') d = String(detail.downloadUrl || detail.installerUrl || (detail.installers && detail.installers[0] && detail.installers[0].url) || '').trim();
      if (!d) return '';
      // Only allow https
      if (!/^https:\/\//i.test(d)) return '';
      if (d.length > MAX_DOWNLOAD_URL_LEN) return '';
      return d;
    } catch (e) { return ''; }
  }

  function createBoughtCta(hostEl, detail) {
    try {
      if (!hostEl || !(hostEl instanceof Element)) return null;
      if (bound(hostEl, 'bought-cta')) return hostEl;

      var wrapper = el('div', 'bought-cta');

      // Copy reference button
      var ref = (detail && detail.ref) ? String(detail.ref) : '';
      if (ref) {
        var copyBtn = el('button', 'btn btn--sm', 'Copy reference');
        copyBtn.type = 'button';
        copyBtn.setAttribute('aria-label', 'Copy payment reference to clipboard');
        copyBtn.addEventListener('click', function () {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(ref);
            } else {
              // Fallback: create a temporary textarea
              var ta = document.createElement('textarea');
              ta.value = ref;
              ta.style.position = 'fixed'; ta.style.left = '-9999px';
              document.body.appendChild(ta);
              ta.select();
              try { document.execCommand('copy'); } catch (e) { /* ignore */ }
              document.body.removeChild(ta);
            }
          } catch (e) { /* ignore */ }
        });
        wrapper.appendChild(copyBtn);
      }

      // View receipt link
      var receipt = (detail && detail.receiptUrl) ? String(detail.receiptUrl) : '';
      if (receipt) {
        try {
          var a = el('a', 'btn btn-ghost btn--sm', 'View receipt');
          a.href = receipt;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.setAttribute('aria-label', 'Open receipt in a new tab');
          wrapper.appendChild(a);
        } catch (e) { /* ignore */ }
      }

      // Download link (very conservative)
      var durl = extractDownloadUrl(detail);
      if (durl) {
        try {
          var dl = el('a', 'btn btn-primary btn--sm', 'Download');
          dl.href = durl;
          dl.target = '_blank';
          dl.rel = 'noopener noreferrer';
          dl.setAttribute('aria-label', 'Open download in a new tab');
          wrapper.appendChild(dl);
        } catch (e) { /* ignore */ }
      } else {
        // Guarded "Verify & reveal" button: show only when a reference exists
        // and no download URL is present, and when a platform verify helper
        // (window.groupStoreVerify) is available. This is user-initiated and
        // intentionally conservative to avoid background network traffic.
        try {
          if (ref && typeof window.groupStoreVerify === 'function') {
            var verifyBtn = el('button', 'btn btn-primary btn--sm', 'Verify & reveal');
            verifyBtn.type = 'button';
            verifyBtn.setAttribute('aria-label', 'Verify payment reference and reveal download link');

            var origText = verifyBtn.textContent;
            var running = false;

            verifyBtn.addEventListener('click', function () {
              try {
                if (running) return;
                running = true;
                verifyBtn.disabled = true;
                verifyBtn.textContent = 'Checking\u2026';
                // Call the platform helper with the reference. It returns a
                // promise resolving to an order object on success.
                Promise.resolve().then(function () {
                  return window.groupStoreVerify(ref);
                }).then(function (order) {
                  try {
                    if (!order) return;
                    // Persist when a canonical helper exists
                    if (typeof window.soundshopPersistBought === 'function') {
                      try { window.soundshopPersistBought(order); } catch (e) { /* ignore */ }
                    }
                    // Notify listeners similarly to the payments widget
                    try { document.dispatchEvent(new CustomEvent('group-store:paid', { detail: order })); } catch (e) { /* ignore */ }
                    // Refresh the on-page bought UI if available
                    if (window.SSPlugin && typeof window.SSPlugin.initBoughtSummary === 'function') {
                      try { window.SSPlugin.initBoughtSummary(); } catch (e) { /* ignore */ }
                    }
                  } catch (e) { /* ignore */ }
                }).catch(function () { /* ignore */ }).finally(function () {
                  try { running = false; verifyBtn.disabled = false; verifyBtn.textContent = origText; } catch (e) { /* ignore */ }
                });

              } catch (e) { /* ignore */ }
            });

            wrapper.appendChild(verifyBtn);
          }
        } catch (e) { /* ignore */ }
      }

      hostEl.appendChild(wrapper);
      return wrapper;
    } catch (e) { return null; }
  }

  function initBoughtSummary(root) {
    try {
      var host = $("[data-bought-summary]", root || document);
      if (!host) return;
      if (bound(host, 'bought-summary')) return;
      // Find the list element
      var list = $("[data-bought-summary-list]", host) || host.querySelector('ul') || null;
      if (!list) return;

      // Labels
      var labContainer = $("[data-bought-summary-labels]", host) || $("[data-bought-summary-labels]", document) || null;
      var labels = {};
      if (labContainer) {
        var attrs = labContainer.attributes || [];
        for (var i = 0; i < attrs.length; i++) {
          var name = attrs[i].name;
          var m = name.match(/^data-bought-label-(.+)$/);
          if (m) labels[m[1]] = attrs[i].value;
        }
      }

      var prefixDate = attr(host, 'data-bought-summary-date-prefix') || '';
      var prefixRef = attr(host, 'data-bought-summary-ref-prefix') || '';
      var suffixRef = attr(host, 'data-bought-summary-ref-suffix') || '';
      var norefText = attr(host, 'data-bought-summary-noref') || '';

      // Clear existing items (idempotent)
      try { while (list.firstChild) list.removeChild(list.firstChild); } catch (e) { }

      var bought = readBoughtArray();
      var keys = Object.keys(bought);
      if (!keys.length) return;

      keys.forEach(function (token) {
        try {
          var d = bought[token];
          if (!d) return;
          var li = el('li', 'bought-summary__item');

          // Label for the product
          var labelText = (labels && labels[token]) ? labels[token] : token.toUpperCase();
          var labelEl = el('div', 'bought-summary__label', labelText);
          li.appendChild(labelEl);

          // Date
          if (d.t) {
            var when = new Date(Number(d.t));
            var dateEl = el('div', 'bought-summary__date', (prefixDate || '') + when.toLocaleString());
            li.appendChild(dateEl);
          }

          // Reference or fallback
          if (d.ref) {
            var refEl = el('div', 'bought-summary__ref', (prefixRef || '') + d.ref + (suffixRef || ''));
            li.appendChild(refEl);
          } else if (norefText) {
            var norefEl = el('div', 'bought-summary__noref', norefText);
            li.appendChild(norefEl);
          }

          // Masked email if present
          if (d.email) {
            var e = maskEmail(d.email);
            if (e) {
              var em = el('div', 'bought-summary__email', e);
              li.appendChild(em);
            }
          }

          // CTAs
          var ctnHost = el('div', 'bought-summary__ctas');
          createBoughtCta(ctnHost, d);
          li.appendChild(ctnHost);

          list.appendChild(li);
        } catch (e) { /* ignore per-record */ }
      });

    } catch (e) { /* ignore */ }
  }

  function initBoughtNote(root) {
    try {
      var note = $("[data-bought-note]", root || document);
      if (!note) return;
      if (bound(note, 'bought-note')) return;

      var item = attr(note, 'data-bought-item') || '';
      var covered = attr(note, 'data-bought-covered-by') || '';
      if (!item) return;

      var bought = readBoughtArray();
      if (bought[item] || (covered && bought[covered])) {
        try { note.hidden = false; } catch (e) { note.removeAttribute('hidden'); }
        // reveal spans if present
        var cover = $("[data-bought-cover]", note);
        if (cover) cover.hidden = false;
        var date = $("[data-bought-date]", note);
        if (date) date.hidden = false;
      }
    } catch (e) { /* ignore */ }
  }

  function initUrlOrderVerifyBanner(root) {
    try {
      if (_sspUrlOrderVerifyDone) return;
      _sspUrlOrderVerifyDone = true;
      // Conservative: only attempt when a d8a_order query is present and when
      // a platform helper is available. The canonical widget in .d8a already
      // performs this verification; this function is a harmless no-op fallback.
      try {
        var match = (location.search || '').match(/[?&]d8a_order=([A-Za-z0-9_-]+)/);
        var id = match && match[1] ? match[1] : '';
        if (!id) return;
        if (typeof window.groupStoreVerify === 'function') {
          try {
            window.groupStoreVerify(id).then(function (o) {
              try {
                if (!o) return;
                if (typeof window.soundshopPersistBought === 'function') {
                  try { window.soundshopPersistBought(o); } catch (e) { /* ignore */ }
                }
                // Notify other codepaths
                try { document.dispatchEvent(new CustomEvent('group-store:paid', { detail: o })); } catch (e) { /* ignore */ }
              } catch (e) { /* ignore */ }
            }).catch(function () { /* ignore */ });
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  // Export on the public object so other scripts (and tests) can call them.
  P.readBoughtArray = readBoughtArray;
  P.maskEmail = maskEmail;
  P.extractDownloadUrl = extractDownloadUrl;
  P.createBoughtCta = createBoughtCta;
  P.initBoughtSummary = initBoughtSummary;
  P.initBoughtNote = initBoughtNote;
  P.initUrlOrderVerifyBanner = initUrlOrderVerifyBanner;

  // Defensive listener: append-only addition to handle group-store:paid events
  // in pages that include the payments widget. This mirrors existing verify
  // flows but is intentionally small and guarded so it cannot break other code.
  try {
    document.addEventListener('group-store:paid', function (evt) {
      try {
        var order = (evt && evt.detail) ? evt.detail : (window.groupStorePaid || null);
        if (!order) return;

        // Persist the bought record when the canonical helper is present
        try {
          if (typeof window.soundshopPersistBought === 'function') {
            try { window.soundshopPersistBought(order); } catch (e) { /* ignore */ }
          }
        } catch (e) { /* ignore */ }

        // Re-emit the verified-order event so existing consumers keep working
        try { document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: order })); } catch (e) { /* ignore */ }

        // Refresh on-page bought UI helpers when available
        try {
          if (window.SSPlugin && typeof window.SSPlugin.initBoughtSummary === 'function') {
            try { window.SSPlugin.initBoughtSummary(); } catch (e) { /* ignore */ }
          }
          if (window.SSPlugin && typeof window.SSPlugin.initBoughtNote === 'function') {
            try { window.SSPlugin.initBoughtNote(); } catch (e) { /* ignore */ }
          }
        } catch (e) { /* ignore */ }

      } catch (e) { /* swallow to be defensive */ }
    });
  } catch (e) { /* ignore */ }

})(window, document);
