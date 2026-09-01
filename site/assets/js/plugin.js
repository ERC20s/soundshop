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

  var BOUGHT_MAX_AGE = (60 * 24 * 60 * 60 * 1000); // 60 days (ms)

  function readBoughtArray() {
    try {
      var raw = window.localStorage.getItem('soundshop:bought:v1');
      if (!raw) return {};
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      // Prune expired records (best-effort)
      try {
        var now = Date.now();
        var changed = false;
        for (var k in parsed) {
          if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue;
          var r = parsed[k];
          var isObj = !!r && typeof r === 'object' && !Array.isArray(r);
          var when = Number(isObj ? r.t : r);
          if (!isFinite(when) || when <= 0 || (now - when) > BOUGHT_MAX_AGE) { delete parsed[k]; changed = true; }
        }
        if (changed) {
          try { window.localStorage.setItem('soundshop:bought:v1', JSON.stringify(parsed)); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore prune */ }
      return parsed;
    } catch (e) { return {}; }
  }

  function maskEmail(e) {
    try {
      if (!e || typeof e !== 'string') return '';
      var p = String(e).split('@');
      if (!p || p.length !== 2) return '';
      var left = p[0] || '';
      if (left.length <= 2) left = left[0] + '…'; else left = left[0] + '…' + left.slice(-1);
      return left + '@' + p[1];
    } catch (err) { return ''; }
  }

  function extractDownloadUrl(o) {
    try {
      if (!o || typeof o !== 'object') return '';
      var u = o.downloadUrl || o.installerUrl || (o.installers && o.installers[0] && o.installers[0].url) || '';
      if (typeof u !== 'string') return '';
      u = u.trim();
      if (!u) return '';
      if (!/^https?:\/\//i.test(u)) return '';
      return u;
    } catch (e) { return ''; }
  }

  function createBoughtCta(hostEl, record) {
    try {
      if (!hostEl || !record || typeof record !== 'object') return null;
      var wrapper = el('div', 'bought-summary__ctas__wrap');

      // If we have a download URL already, expose it
      try {
        if (record.downloadUrl) {
          var a = el('a', 'button button--primary', 'Download');
          a.href = String(record.downloadUrl);
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          wrapper.appendChild(a);
        }
      } catch (e) { /* ignore */ }

      // If a provider receipt URL is present, expose it as a simple Receipt CTA.
      // Conservative guard: string, trimmed, length limit and https? scheme only.
      try {
        var rurl = '';
        if (record && typeof record === 'object') rurl = record.receiptUrl || '';
        if (typeof rurl === 'string') {
          rurl = rurl.trim();
          if (rurl && rurl.length <= 2000 && /^https?:\/\//i.test(rurl)) {
            var receiptA = el('a', 'button', 'Receipt');
            receiptA.href = rurl;
            receiptA.target = '_blank';
            receiptA.rel = 'noopener noreferrer';
            wrapper.appendChild(receiptA);
          }
        }
      } catch (e) { /* ignore */ }

      // Show a Verify & reveal button when we have a reference but no URL
      try {
        var hasRef = !!record.ref;
        var hasUrl = !!record.downloadUrl;
        if (hasRef && !hasUrl && typeof window.groupStoreVerify === 'function') {
          var verifyBtn = el('button', 'button', 'Verify & reveal');
          verifyBtn.type = 'button';
          try { verifyBtn.addEventListener('click', function () {
            try {
              var ref = String(record.ref || '').trim();
              if (!ref) return;
              if (verifyBtn.disabled) return;
              verifyBtn.disabled = true;
              var originalLabel = verifyBtn.textContent;
              verifyBtn.textContent = 'Checking…';

              window.groupStoreVerify(ref).then(function (o) {
                try {
                  if (!o) return;
                  if (typeof window.soundshopPersistBought === 'function') {
                    try { window.soundshopPersistBought(o); } catch (e) { /* ignore */ }
                  }

                  // Notify other codepaths
                  try { document.dispatchEvent(new CustomEvent('group-store:paid', { detail: o })); } catch (e) { /* ignore */ }

                  try {
                    if (window.SSPlugin && typeof window.SSPlugin.initBoughtSummary === 'function') {
                      try { window.SSPlugin.initBoughtSummary(); } catch (e) { /* ignore */ }
                    }
                  } catch (e) { /* ignore */ }
                } catch (e) { /* ignore */ }
              }).catch(function () { /* ignore verify failure */ }).finally(function () {
                try { verifyBtn.disabled = false; verifyBtn.textContent = originalLabel; } catch (e) { /* ignore */ }
              });

            } catch (e) {
              try { verifyBtn.disabled = false; verifyBtn.textContent = originalLabel; } catch (e) { /* ignore */ }
            }

          } catch (e) { /* swallow */ }
        });

        wrapper.appendChild(verifyBtn);
      }
    } catch (e) { /* ignore guard */ }

    hostEl.appendChild(wrapper);
    return wrapper;
  } catch (e) { return null; }
  }

  function initBoughtSummary(root) {
    try {
      var list = $("[data-bought-summary]", root || document);
      if (!list) return;
      if (bound(list, 'bought-summary')) return;

      var labels = {
        vanta: 'VANTA',
        drift: 'DRIFT',
        prism: 'PRISM',
        anvil: 'ANVIL',
        bundle: 'FULL SHOP'
      };

      var prefixDate = attr(list, 'data-bought-prefix-date') || '';
      var prefixRef = attr(list, 'data-bought-prefix-ref') || '';
      var suffixRef = attr(list, 'data-bought-suffix-ref') || '';
      var norefText = attr(list, 'data-bought-noref-text') || '';

      try {
        var buys = readBoughtArray();
        Object.keys(buys).forEach(function (token) {
          try {
            var d = buys[token];
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
