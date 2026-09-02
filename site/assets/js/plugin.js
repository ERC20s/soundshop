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
       point is wrapped so a missing element can never to throw.
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
    // One-shot guard so r
    try {
      if (!node || !node.setAttribute) return false;
      var k = 'data-ssp-bound-' + key;
      if (node.getAttribute && node.getAttribute(k) === 'on') return true;
      try { node.setAttribute(k, 'on'); } catch (e) { /* ignore */ }
      return false;
    } catch (e) { return false; }
  }

  // Helper that derives a sensible display name for a product token
  function displayNameForToken(token) {
    try {
      if (!token || typeof token !== 'string') return '';
      var t = token.trim().toLowerCase();
      if (!t) return '';
      if (t === 'vanta') return 'VANTA';
      if (t === 'drift') return 'DRIFT';
      if (t === 'prism') return 'PRISM';
      if (t === 'anvil') return 'ANVIL';
      if (t === 'bundle') return 'The Full Shop';
      // Fallback: titlecase a single-word token
      return t.charAt(0).toUpperCase() + t.slice(1);
    } catch (e) { return '' }
  }

  // Determine the support href using the order agreed in the proposal:
  // 1) host[data-bought-summary-support-href]
  // 2) [data-bought-summary] element's data-bought-summary-support-href
  // 3) <link rel="help">@href
  // 4) <meta name="soundshop-support">@content
  // 5) '/docs.html#support'
  function supportHrefFor(host) {
    try {
      var v = '';
      try { v = attr(host, 'data-bought-summary-support-href') || ''; } catch (e) { v = ''; }
      if (v) return v;
      try {
        var pageHost = document.querySelector('[data-bought-summary]');
        if (pageHost && pageHost.getAttribute) {
          v = pageHost.getAttribute('data-bought-summary-support-href') || '';
          if (v) return String(v).trim();
        }
      } catch (e) { /* ignore */ }
      try {
        var link = document.querySelector('link[rel="help"]');
        if (link && link.getAttribute) {
          v = link.getAttribute('href') || '';
          if (v) return String(v).trim();
        }
      } catch (e) { /* ignore */ }
      try {
        var meta = document.querySelector('meta[name="soundshop-support"]');
        if (meta && meta.getAttribute) {
          v = meta.getAttribute('content') || '';
          if (v) return String(v).trim();
        }
      } catch (e) { /* ignore */ }
      return '/docs.html#support';
    } catch (e) { return '/docs.html#support'; }
  }

  /* -----------------------------------------------------------------------
     Paid-banner CTAs. This looks for the payments widget's <p data-paid> and
     appends Download / View receipt / Support CTAs when a verified order is
     available. The function is safe to call multiple times and will not
     duplicate elements.
     ----------------------------------------------------------------------- */
  function createBoughtContactCta(host, rec, token) {
    try {
      if (!host || !host.setAttribute) return null;
      var button = null;
      try {
        var href = supportHrefFor(host);
        var subjName = '';
        try { subjName = displayNameForToken(token || ''); } catch (e) { subjName = ''; }
        if (!subjName) {
          // No token: try to derive a display name from the record or page
          try { if (rec && rec.itemName) subjName = String(rec.itemName).trim(); } catch (e) { /* ignore */ }
          try { if (!subjName && rec && rec.name) subjName = String(rec.name).trim(); } catch (e) { /* ignore */ }
        }
        var mailto = false;
        try { mailto = /^mailto:/i.test(String(href)); } catch (e) { mailto = false; }
        if (mailto) {
          try {
            var sep = href.indexOf('?') === -1 ? '?' : '&';
            var subj = 'Buy ' + (subjName || 'product');
            href = href + sep + 'subject=' + encodeURIComponent(subj);
          } catch (e) { /* ignore subject */ }
        }

        button = document.createElement('a');
        button.className = 'bought-summary__support';
        button.setAttribute('href', href || 'mailto:support@soundshop.example');
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
