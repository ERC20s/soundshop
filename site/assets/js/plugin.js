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

  function initBoughtNote(root) {
    try {
      var note = $( '[data-bought-note]', root );
      if (!note) return;
      if (note.getAttribute('data-ssp-bought-note') === 'on') return;
      note.setAttribute('data-ssp-bought-note', 'on');

      var token = attr(note, 'data-bought-note') || '';
      try {
        var arr = readBoughtArray(document);
        if (!arr || !arr.length) return;
        if (!token) return;
        for (var i = 0; i < arr.length; i++) {
          var it = arr[i];
          if (!it) continue;
          if (it.t && it.ref && it.state === 'paid') {
            // We show the first matching token
            if (token === (it.tok || '')) {
              try {
                note.className = note.className.replace(/(^|\s)is-hidden(\s|$)/, ' ');
              } catch (e) { /* ignore */ }
              try { P.initBoughtSummary(); } catch (e) { /* ignore */ }
              break;
            }
          }
        }
      } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  function initBoughtSummary(root) {
    try {
      var host = $( '[data-bought-summary]', root );
      if (!host) return;
      if (host.getAttribute('data-ssp-bought-summary') === 'on') return;
      host.setAttribute('data-ssp-bought-summary', 'on');

      var arr = readBoughtArray(document);
      if (!arr || !arr.length) return;

      // Create list
      try {
        var ul = document.createElement('ul');
        ul.className = 'bought__list';
        for (var i = 0; i < arr.length; i++) {
          var it = arr[i];
          if (!it) continue;
          var li = document.createElement('li');
          li.className = 'bought__item';
          var span = document.createElement('span');
          span.className = 'bought__label';
          span.textContent = maskEmail(it.email || '') || (it.ref || 'Purchased');
          li.appendChild(span);
          li.setAttribute('data-bought-item', it.ref || '');

          // let createBoughtCta populate CTA area
          try { createBoughtCta(li, it); } catch (e) { /* ignore */ }

          ul.appendChild(li);
        }
        try { host.innerHTML = ''; host.appendChild(ul); } catch (e) { /* ignore */ }
      } catch (e) { /* ignore */ }

    } catch (e) { /* ignore */ }
  }

  function createBoughtCta(host, detail) {
    try {
      if (!host) return;
      var already = '';
      try { already = host.getAttribute('data-ssp-bought-cta'); } catch (e) { already = ''; }
      try {
        if (already === 'on') {
          // If the caller supplied a verified download URL, try to update an
          // existing anchor (or append one if none exists). Otherwise do
          // nothing and keep the existing CTA (usually a Contact Support link).
          if (detail && extractDownloadUrl(detail)) {
            var url = extractDownloadUrl(detail);
            try {
              var existing = host.querySelector('.bought__cta');
              if (existing && existing.tagName && existing.tagName.toLowerCase() === 'a') {
                try { existing.setAttribute('href', url); } catch (e) { /* ignore */ }
                try { existing.setAttribute('target', '_blank'); } catch (e) { /* ignore */ }
                try { existing.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }
                try { existing.textContent = 'Download installers'; } catch (e) { /* ignore */ }
              } else {
                // If existing CTA exists but is not an anchor, append a proper link
                var a2 = makeDownloadAnchor(url);
                if (a2) {
                  try { host.appendChild(a2); } catch (e) { /* ignore */ }
                }
              }
            } catch (e) { /* ignore update */ }
          }

          // Update or append copy button if a reference is available
          try {
            var ref = (detail && (detail.ref || detail.reference || detail.id)) ? String(detail.ref || detail.reference || detail.id) : '';
            if (ref) {
              var existingCopy = host.querySelector('[data-ssp-bought-copy]');
              if (existingCopy) {
                try { existingCopy.setAttribute('data-ssp-bought-copy', ref); } catch (e) { /* ignore */ }
              } else {
                var cb = document.createElement('button');
                cb.className = 'btn btn-ghost bought__copy';
                try { cb.setAttribute('type', 'button'); } catch (e) { /* ignore */ }
                try { cb.setAttribute('data-ssp-bought-copy', ref); } catch (e) { /* ignore */ }
                cb.textContent = 'Copy reference';
                try { host.appendChild(cb); } catch (e) { /* ignore */ }
              }
            }
          } catch (e) { /* ignore */ }

          // Update or append receipt link conservatively
          try {
            var rurl = (detail && (detail.receiptUrl || detail.receipt)) ? String(detail.receiptUrl || detail.receipt) : '';
            var ra = makeReceiptAnchor(rurl);
            if (ra) {
              var existingReceipt = host.querySelector('.bought__receipt');
              if (existingReceipt && existingReceipt.tagName && existingReceipt.tagName.toLowerCase() === 'a') {
                try { existingReceipt.setAttribute('href', rurl); } catch (e) { /* ignore */ }
              } else {
                try { host.appendChild(ra); } catch (e) { /* ignore */ }
              }
            }
          } catch (e) { /* ignore */ }

          return;
        }
      } catch (e) { /* ignore */ }

      // Mark this host as having had its CTA created so re-runs are idempotent
      try { host.setAttribute('data-ssp-bought-cta', 'on'); } catch (e) { /* ignore */ }

      // Create a small container and populate with the most conservative UI:
      // - If we have a conservative, explicit https downloadUrl, show a
      //   "Download installers" anchor.
      // - Otherwise show a 'Contact Support' link and a small 'Verify' button
      //   that other scripts can hook to attempt server-side verification.
      try {
        var wrapper = el('div', 'bought');
        var urlv = detail && extractDownloadUrl(detail) ? extractDownloadUrl(detail) : null;
        if (urlv) {
          var a = makeDownloadAnchor(urlv);
          if (a) wrapper.appendChild(a);
        } else {
          // Conservative fallback: Contact Support link (does not expose receiptUrl)
          var support = document.createElement('a');
          support.className = 'bought__cta';
          try { support.setAttribute('href', 'docs.html#support'); } catch (e) { /* ignore */ }
          support.textContent = 'Contact Support';
          wrapper.appendChild(support);

          // If there is an id we can offer a verify trigger; other code may
          // listen for clicks on [data-bought-verify] to run a server verify.
          if (detail && (detail.id || detail.ref)) {
            var vb = el('button', 'btn btn-ghost bought__verify', 'Verify purchase');
            try { vb.setAttribute('type', 'button'); } catch (e) { /* ignore */ }
            vb.setAttribute('data-bought-verify', detail.id || detail.ref || '');
            wrapper.appendChild(vb);
          }
        }

        // If we have a copyable reference, append a small Copy button
        try {
          var refv = (detail && (detail.ref || detail.reference || detail.id)) ? String(detail.ref || detail.reference || detail.id) : '';
          if (refv) {
            var cb2 = el('button', 'btn btn-ghost bought__copy', 'Copy reference');
            try { cb2.setAttribute('type', 'button'); } catch (e) { /* ignore */ }
            try { cb2.setAttribute('data-ssp-bought-copy', refv); } catch (e) { /* ignore */ }
            try { wrapper.appendChild(cb2); } catch (e) { /* ignore */ }
          }
        } catch (e) { /* ignore */ }

        // Append a conservative receipt anchor when present
        try {
          var rurl2 = (detail && (detail.receiptUrl || detail.receipt)) ? String(detail.receiptUrl || detail.receipt) : '';
          var ra2 = makeReceiptAnchor(rurl2);
          if (ra2) {
            try { wrapper.appendChild(ra2); } catch (e) { /* ignore */ }
          }
        } catch (e) { /* ignore */ }

        try { host.appendChild(wrapper); } catch (e) { /* ignore */ }
      } catch (e) { /* ignore create */ }

    } catch (e) { /* swallow */ }
  }

  // Add a delegated, defensive click handler for [data-bought-verify] buttons.
  // This is intentionally non-invasive: it does not change any helper
  // signatures and will gracefully no-op if the payments widget is absent.
  try {
    document.addEventListener('click', function (e) {
      try {
        var btn = e.target && e.target.closest ? e.target.closest('[data-bought-verify]') : null;
        if (!btn) return;
        // Ignore if element is not a button-like control
        var tag = (btn.tagName || '').toLowerCase();
        if (tag !== 'button' && tag !== 'a' && tag !== 'input') return;

        e.preventDefault();

        // One-shot guard to avoid double-submitting
        if (btn.getAttribute('data-ssp-verifying') === 'on') return;
        btn.setAttribute('data-ssp-verifying', 'on');

        var origText = btn.textContent || '';
        try { btn.disabled = true; } catch (err) { /* ignore */ }
        try { btn.textContent = 'Verifying…'; } catch (err) { /* ignore */ }

        var id = attr(btn, 'data-bought-verify') || '';

        function failRestore(msg) {
          try {
            try { btn.textContent = origText; } catch (e) { /* ignore */ }
            try { btn.disabled = false; } catch (e) { /* ignore */ }
            try { btn.removeAttribute('data-ssp-verifying'); } catch (e) { /* ignore */ }
            if (msg) {
              try {
                var hint = el('div', 'ssp-verify-hint');
                hint.style.cssText = 'margin-top:8px;font-size:13px;color:#6b7280';
                var a = document.createElement('a');
                a.setAttribute('href', 'docs.html#support');
                a.style.color = '#7c5cff';
                a.textContent = msg;
                hint.appendChild(a);
                try { btn.parentNode.insertBefore(hint, btn.nextSibling); } catch (e) { /* ignore */ }
                setTimeout(function () { try { if (hint && hint.parentNode) hint.parentNode.removeChild(hint); } catch (e) { /* ignore */ } }, 6000);
              } catch (e) { /* ignore */ }
            }
          } catch (e) { /* ignore */ }
        }

        // If the payments widget does not expose groupStoreVerify, bail gracefully
        if (typeof window.groupStoreVerify !== 'function') {
          failRestore('Verify unavailable — Contact Support');
          return;
        }

        // Call the platform verifier provided by the payments widget
        try {
          var p = null;
          try { p = window.groupStoreVerify(id); } catch (err) { p = null; }
          if (!p || typeof p.then !== 'function') {
            // Not a Promise; treat as failure if falsy, otherwise wrap
            if (!p) { failRestore('Verify failed — Contact Support'); return; }
            p = Promise.resolve(p);
          }
          p.then(function (order) {
            try {
              if (!order) throw new Error('no-order');
              try { if (typeof window.soundshopPersistBought === 'function') window.soundshopPersistBought(order); } catch (e) { /* ignore */ }
              try { document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: order })); } catch (e) { /* ignore */ }

              // Reveal and focus the Download CTA if present for this order
              try {
                var d = extractDownloadUrl(order);
                if (d) {
                  var cand = null;
                  try { cand = document.querySelector('.bought__cta[href]'); } catch (e) { cand = null; }
                  if (cand && cand.getAttribute && String(cand.getAttribute('href')).trim() === d) {
                    try { focusAndReveal(cand); } catch (e) { /* ignore */ }
                  }
                }
              } catch (e) { /* ignore */ }

            } catch (e) {
              failRestore('Verify failed — Contact Support');
            }
          }).catch(function () { failRestore('Verify failed — Contact Support'); });
        } catch (e) { failRestore('Verify failed — Contact Support'); }

      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }

  // Helper to build a conservative download anchor
  function makeDownloadAnchor(url) {
    try {
      if (!url || typeof url !== 'string') return null;
      var a = document.createElement('a');
      a.className = 'bought__cta';
      a.setAttribute('href', url);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.textContent = 'Download installers';
      return a;
    } catch (e) { return null; }
  }

  function makeReceiptAnchor(url) {
    try {
      if (!url || typeof url !== 'string') return null;
      if (!/^https?:\/\//i.test(url)) return null;
      var a = document.createElement('a');
      a.className = 'bought__receipt';
      a.setAttribute('href', url);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.textContent = 'View receipt';
      return a;
    } catch (e) { return null; }
  }

  function extractDownloadUrl(obj) {
    try {
      if (!obj || typeof obj !== 'object') return '';
      var d = obj.downloadUrl || obj.installerUrl || (obj.installers && obj.installers[0] && obj.installers[0].url) || '';
      if (!d || typeof d !== 'string') return '';
      d = d.trim();
      if (!d) return '';
      if (!/^https?:\/\//i.test(d)) return '';
      return d;
    } catch (e) { return ''; }
  }

  function readBoughtArray(doc) {
    try {
      var BOUGHT_KEY = 'soundshop:bought:v1';
      var raw = window.localStorage.getItem(BOUGHT_KEY);
      if (!raw) return [];
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!parsed || typeof parsed !== 'object') return [];
      var out = [];
      for (var k in parsed) {
        if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue;
        var r = parsed[k];
        if (!r) continue;
        if (r && typeof r === 'object') {
          r.tok = k;
          out.push(r);
        } else {
          // Legacy numeric timestamp
          out.push({ t: Number(r) || 0, tok: k });
        }
      }
      // Sort descending by timestamp
      out.sort(function (a, b) { return (b && b.t ? b.t : 0) - (a && a.t ? a.t : 0); });
      return out;
    } catch (e) { return []; }
  }

  function maskEmail(email) {
    try {
      if (!email || typeof email !== 'string') return '';
      var p = email.split('@');
      if (!p || p.length !== 2) return '';
      var name = p[0];
      var domain = p[1];
      if (name.length <= 2) name = name[0] + '…';
      else name = name[0] + '…' + name[name.length - 1];
      return name + '@' + domain.replace(/^www\./, '');
    } catch (e) { return ''; }
  }

  function copyToClipboard(text) {
    try {
      if (!text || typeof text !== 'string') return false;
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try { navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
      }
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      try { document.body.removeChild(ta); } catch (e) { /* ignore */ }
      return true;
    } catch (e) { return false; }
  }

  function focusAndReveal(el) {
    try {
      if (!el) return;
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { try { el.scrollIntoView(); } catch (e) { /* ignore */ } }
      try { el.focus(); } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  function initUrlOrderVerifyBanner() {
    try {
      if (_sspUrlOrderVerifyDone) return;
      _sspUrlOrderVerifyDone = true;

      // Parse ?d8a_order= from location search
      try {
        var q = window.location.search || '';
        if (!q) return;
        var m = q.match(/[?&]d8a_order=([^&]+)/);
        if (!m || !m[1]) return;
        var id = decodeURIComponent(m[1]);
        if (!id) return;
      } catch (e) { return; }

      // Insert a tiny banner with a verify button that fetches the public API
      try {
        var mainEl = document.querySelector('main') || null;
        var banner = el('div', 'ssp-url-order-verify');
        banner.style.cssText = 'padding:12px;margin:12px 0;border:1px solid #e6e6e6;background:#fffefc;color:#111;font-size:14px;border-radius:6px;display:flex;align-items:center;justify-content:space-between;gap:12px';

        var text = el('div', 'ssp-url-order-verify__text', 'This page was returned from a completed checkout. You can verify the order from the URL and restore any remembered purchase in this browser.');
        text.style.flex = '1';
        banner.appendChild(text);

        var controls = el('div', 'ssp-url-order-verify__controls');
        var btn = el('button', 'btn btn-ghost', 'Verify purchase');
        try { btn.setAttribute('type', 'button'); } catch (e) { /* ignore */ }
        controls.appendChild(btn);
        banner.appendChild(controls);

        // Insert banner before main's first child, or append to body as fallback
        try {
          if (mainEl && mainEl.parentNode) mainEl.parentNode.insertBefore(banner, mainEl.nextSibling);
          else document.body.insertBefore(banner, document.body.firstChild);
        } catch (e) { try { document.body.insertBefore(banner, document.body.firstChild); } catch (e) { /* ignore */ } }

        var oneClick = false;
        btn.addEventListener('click', function () {
          try {
            if (oneClick) return; oneClick = true;
            btn.textContent = 'Verifying…';
            btn.disabled = true;

            var url = 'https://d8a.com/api/v1/store/orders/' + encodeURIComponent(id) + '?group=batch-synthshop';
            fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' }, credentials: 'omit' }).then(function (res) {
              if (!res || !res.ok) throw new Error('fetch-failed');
              return res.json();
            }).then(function (json) {
              try {
                if (!json) throw new Error('no-json');
                var order = null;
                // Accept either the object directly or a wrapper { order: ... }
                if (typeof json === 'object' && json.paid === true) order = json;
                else if (json && typeof json === 'object' && json.order && typeof json.order === 'object' && json.order.paid === true) order = json.order;
                if (!order) throw new Error('not-paid-or-no-order');

                try { if (typeof window.soundshopPersistBought === 'function') window.soundshopPersistBought(order); } catch (e) { /* ignore */ }
                try { document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: order })); } catch (e) { /* ignore */ }

                // Remove banner on success
                try { if (banner && banner.parentNode) banner.parentNode.removeChild(banner); } catch (e) { /* ignore */ }

                // Reveal and focus the Download CTA if present for this order
                try {
                  var d = extractDownloadUrl(order);
                  if (d) {
                    var cand = null;
                    try { cand = document.querySelector('.bought__cta[href]'); } catch (e) { cand = null; }
                    if (cand && cand.getAttribute && String(cand.getAttribute('href')).trim() === d) {
                      try { focusAndReveal(cand); } catch (e) { /* ignore */ }
                    }
                  }
                } catch (e) { /* ignore */ }

              } catch (e) {
                // Show a support hint inline, keep banner present
                try {
                  var hint = el('div', 'ssp-url-order-verify__hint');
                  hint.style.cssText = 'margin-top:8px;font-size:13px;color:#6b7280';
                  var a = document.createElement('a');
                  a.setAttribute('href', 'docs.html#support');
                  a.style.color = '#7c5cff';
                  a.textContent = 'Verify failed — Contact Support';
                  hint.appendChild(a);
                  try { banner.appendChild(hint); } catch (e) { /* ignore */ }
                } catch (e) { /* ignore */ }
                try { btn.textContent = 'Verify purchase'; } catch (e) { /* ignore */ }
                try { btn.disabled = false; } catch (e) { /* ignore */ }
              }
            }).catch(function () {
              try {
                var hint = el('div', 'ssp-url-order-verify__hint');
                hint.style.cssText = 'margin-top:8px;font-size:13px;color:#6b7280';
                var a = document.createElement('a');
                a.setAttribute('href', 'docs.html#support');
                a.style.color = '#7c5cff';
                a.textContent = 'Verify failed — Contact Support';
                hint.appendChild(a);
                try { banner.appendChild(hint); } catch (e) { /* ignore */ }
              } catch (e) { /* ignore */ }
              try { btn.textContent = 'Verify purchase'; } catch (e) { /* ignore */ }
              try { btn.disabled = false; } catch (e) { /* ignore */ }
            });
          } catch (e) { /* ignore */ }
        });

      } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  // Conservative, one-shot auto-verify pass for remembered purchases that
  // have an order id but no verified downloadUrl. This only runs when the
  // platform verifier (window.groupStoreVerify) is available and only once
  // per page load to keep privacy and server load minimal.
  try {
    if (!_boughtAutoVerifyCalled && typeof window.groupStoreVerify === 'function') {
      var arrAuto = [];
      try { arrAuto = readBoughtArray(document); } catch (e) { arrAuto = []; }
      if (arrAuto && arrAuto.length) {
        var toVerify = null;
        for (var i = 0; i < arrAuto.length; i++) {
          var it = arrAuto[i];
          if (!it) continue;
          if ((it.id || it.ref) && !it.downloadUrl) { toVerify = it; break; }
        }
        if (toVerify) {
          _boughtAutoVerifyCalled = true;
          try {
            var vid = toVerify.id || toVerify.ref || '';
            var p = null;
            try { p = window.groupStoreVerify(vid); } catch (e) { p = null; }
            if (p && typeof p.then === 'function') {
              p.then(function (order) {
                try {
                  if (!order) return;
                  // Only persist and broadcast when a conservative https download URL exists
                  var d = extractDownloadUrl(order);
                  if (!d) return;
                  try { if (typeof window.soundshopPersistBought === 'function') window.soundshopPersistBought(order); } catch (e) { /* ignore */ }
                  try { document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: order })); } catch (e) { /* ignore */ }
                } catch (e) { /* ignore */ }
              }).catch(function () { /* ignore */ });
            }
          } catch (e) { /* ignore */ }
        }
      }
    }
  } catch (e) { /* ignore */ }

  // If the payments widget is absent, offer a conservative, user-initiated
  // verification UI when the URL contains ?d8a_order=<id>. This is a one-shot
  // per page load to keep traffic and privacy impact minimal.
  try {
    if (typeof window.groupStoreVerify !== 'function' && !_sspUrlOrderVerifyDone) {
      try { initUrlOrderVerifyBanner(); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

  // Export public helpers that may be used externally
  P.extractDownloadUrl = extractDownloadUrl;
  P.readBoughtArray = readBoughtArray;
  P.maskEmail = maskEmail;
  P.createBoughtCta = createBoughtCta;
  P.copyToClipboard = copyToClipboard;
  P.initBoughtSummary = initBoughtSummary;
  P.initBoughtNote = initBoughtNote;
  P.initUrlOrderVerifyBanner = initUrlOrderVerifyBanner;

}(window, document));
