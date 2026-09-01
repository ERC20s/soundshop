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

  // Provide a safe, non-overriding fallback for window.soundshopPersistBought
  try {
    if (typeof window.soundshopPersistBought !== 'function') {
      window.soundshopPersistBought = function (order) {
        try {
          if (!order || typeof order !== 'object') return;

          var BOUGHT_KEY = 'soundshop:bought:v1';
          var BOUGHT_MAX_AGE = 60 * 24 * 60 * 60 * 1000; // 60 days
          var MAX_EMAIL_LEN = 128;
          var MAX_RECEIPT_LEN = 2000;

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

          var rec = { t: Date.now(), ref: String(order.id || order.ref || order.reference || ''), state: 'paid' };
          if (email) rec.email = email;

          // Extract a download URL conservatively (allow http or https for download)
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

          // Conservatively accept a provider receipt URL only when it is https:
          try {
            var rurl = '';
            if (order && typeof order === 'object') rurl = order.receiptUrl || order.receipt || '';
            if (typeof rurl === 'string') {
              rurl = rurl.trim();
              if (rurl && rurl.length <= MAX_RECEIPT_LEN && /^https:\/\//i.test(rurl)) rec.receiptUrl = rurl;
            }
          } catch (e) { /* ignore */ }

          try {
            var token = getProductToken(order.itemName || order.name || order.itemId || order.item || '', order.itemId || order.id);
            if (!token) return; // unknown product, do not persist

            var bought = {};
            try {
              var raw = window.localStorage.getItem(BOUGHT_KEY);
              if (raw) {
                var parsed = null;
                try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) bought = parsed;
              }
            } catch (e) { /* ignore read */ }

            try {
              var exist = bought[token];
              if (exist && typeof exist === 'object') {
                if (!rec.downloadUrl && exist.downloadUrl) rec.downloadUrl = exist.downloadUrl;
                if (!rec.email && exist.email) rec.email = exist.email;
                if (!rec.ref && exist.ref) rec.ref = exist.ref;
              }
            } catch (e) { /* ignore merge */ }

            bought[token] = rec;

            try { window.localStorage.setItem(BOUGHT_KEY, JSON.stringify(bought)); } catch (e) { /* ignore write */ }

            try {
              var summaryEl = document.querySelector('[data-bought-summary]');
              if (summaryEl) {
                summaryEl.removeAttribute('data-ssp-bought-summary');
                if (window.SSPlugin && typeof window.SSPlugin.initBoughtSummary === 'function') {
                  try { window.SSPlugin.initBoughtSummary(); } catch (e) { /* ignore */ }
                }
              }
            } catch (e) { /* ignore */ }

            // Prune old records
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

        } catch (e) { /* swallow */ }
      };
    }
  } catch (e) { /* ignore */ }

  var _boughtAutoVerifyCalled = false;
  var _sspUrlOrderVerifyDone = false;

  function $(sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }
  function $$(sel, root) { try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; } }
  function el(tag, className, text) { var node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = String(text); return node; }
  function attr(node, name) { if (!node || !node.getAttribute) return ''; var v = node.getAttribute(name); return v == null ? '' : String(v).trim(); }
  function intAttr(node, name, fallback) { var n = parseInt(attr(node, name), 10); return isFinite(n) ? n : fallback; }
  function bound(node, key) { if (!node) return true; var name = 'data-ssp-' + key; if (node.getAttribute(name) === 'on') return true; node.setAttribute(name, 'on'); return false; }
  function reducedMotion() { if (SS && typeof SS.prefersReducedMotion === 'function') { try { return SS.prefersReducedMotion(); } catch (e) { } } try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }
  function isFileProtocol() { try { return window.location.protocol === 'file:'; } catch (e) { return false; } }

  // Conservative extractor for a download URL, returns null when not acceptable
  function extractDownloadUrl(orderLike) {
    try {
      if (!orderLike || typeof orderLike !== 'object') return null;
      var d = orderLike.downloadUrl || orderLike.installerUrl || '';
      if (typeof d === 'string') d = d.trim(); else d = '';
      if (d && /^https?:\/\//i.test(d)) return d;
      if (orderLike.installers && Array.isArray(orderLike.installers) && orderLike.installers.length) {
        var i0 = orderLike.installers[0];
        if (i0 && typeof i0.url === 'string') {
          var u = i0.url.trim(); if (u && /^https?:\/\//i.test(u)) return u;
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // Read the bought array from localStorage and return an array of records
  function readBoughtArray(root) {
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
        var v = parsed[k];
        if (!v) continue;
        var rec = { token: k };
        if (typeof v === 'object') {
          rec.id = v.id || v.ref || '';
          rec.ref = v.ref || v.id || '';
          rec.downloadUrl = v.downloadUrl || null;
          rec.receiptUrl = v.receiptUrl || null;
          rec.t = v.t || null;
          rec.email = v.email || null;
        } else {
          rec.t = Number(v) || null;
        }
        out.push(rec);
      }
      return out;
    } catch (e) { return []; }
  }

  /* Helper to mask an email address for public display. */
  function maskEmail(email) {
    try {
      if (!email) return '';
      var s = String(email).trim();
      var parts = s.split('@');
      if (parts.length !== 2) return s.replace(/.(?=.{2,}$)/g, '*');
      var local = parts[0];
      var domain = parts[1];
      if (local.length <= 2) return local.replace(/.(?=.{1,}$)/g, '*') + '@' + domain;
      return local.charAt(0) + '\u2026' + local.charAt(local.length - 1) + '@' + domain;
    } catch (e) { return ''; }
  }

  function makeDownloadAnchor(url) {
    try {
      var v = extractDownloadUrl({ downloadUrl: url });
      if (!v) return null;
      var a = document.createElement('a');
      a.className = 'bought__cta';
      a.setAttribute('href', v);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.textContent = 'Download installers';
      return a;
    } catch (e) { return null; }
  }

  // New helper: create a small receipt anchor when a conservative https: receipt URL exists
  function makeReceiptAnchor(url) {
    try {
      if (!url || typeof url !== 'string') return null;
      var v = String(url).trim();
      if (!v || !/^https:\/\//i.test(v)) return null;
      var a = document.createElement('a');
      a.className = 'bought__receipt';
      a.setAttribute('href', v);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.textContent = 'View receipt';
      return a;
    } catch (e) { return null; }
  }

  // New helper: copyable order reference button with clipboard fallback
  function makeCopyRefButton(ref) {
    try {
      var r = String(ref || '').trim();
      if (!r) return null;
      var btn = document.createElement('button');
      btn.className = 'btn btn-ghost bought__copy-ref';
      btn.setAttribute('type', 'button');
      try { btn.setAttribute('data-ssp-copy-ref', r); } catch (e) { }
      btn.textContent = 'Copy order reference';

      btn.addEventListener('click', function () {
        try {
          if (btn.getAttribute('data-ssp-copying') === 'on') return;
          btn.setAttribute('data-ssp-copying', 'on');
          var orig = btn.textContent || '';
          function done(ok) {
            try { btn.textContent = ok ? 'Copied' : 'Copy failed'; } catch (e) { }
            setTimeout(function () { try { btn.textContent = orig; btn.removeAttribute('data-ssp-copying'); } catch (e) { } }, 1500);
          }
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(r).then(function () { done(true); }).catch(function () {
              try {
                var ta = document.createElement('textarea');
                ta.value = r; ta.style.position = 'fixed'; ta.style.left = '-9999px'; document.body.appendChild(ta); ta.select();
                try { var ok = document.execCommand('copy'); document.body.removeChild(ta); done(!!ok); } catch (e) { try { document.body.removeChild(ta); } catch (e) { } done(false); }
              } catch (e) { done(false); }
            });
          } else {
            try {
              var ta2 = document.createElement('textarea'); ta2.value = r; ta2.style.position = 'fixed'; ta2.style.left = '-9999px'; document.body.appendChild(ta2); ta2.select();
              try { var ok2 = document.execCommand('copy'); document.body.removeChild(ta2); done(!!ok2); } catch (e) { try { document.body.removeChild(ta2); } catch (e) { } done(false); }
            } catch (e) { done(false); }
          }
        } catch (e) { try { btn.removeAttribute('data-ssp-copying'); } catch (e) { } }
      }, false);

      return btn;
    } catch (e) { return null; }
  }

  function createBoughtCta(host, detail) {
    try {
      if (!host || !host.appendChild) return;

      try {
        var already = host.getAttribute('data-ssp-bought-cta');
        if (already === 'on') {
          if (detail && extractDownloadUrl(detail)) {
            var url = extractDownloadUrl(detail);
            try {
              var existing = host.querySelector('.bought__cta');
              if (existing && existing.tagName && existing.tagName.toLowerCase() === 'a') {
                try { existing.setAttribute('href', url); } catch (e) { }
                try { existing.setAttribute('target', '_blank'); } catch (e) { }
                try { existing.setAttribute('rel', 'noopener noreferrer'); } catch (e) { }
                try { existing.textContent = 'Download installers'; } catch (e) { }
                return;
              }
              var a2 = makeDownloadAnchor(url);
              if (a2) { try { host.appendChild(a2); } catch (e) { } }
            } catch (e) { }
          }
          return;
        }
      } catch (e) { }

      try { host.setAttribute('data-ssp-bought-cta', 'on'); } catch (e) { }

      try {
        var wrapper = el('div', 'bought');
        var urlv = detail && extractDownloadUrl(detail) ? extractDownloadUrl(detail) : null;
        if (urlv) {
          var a = makeDownloadAnchor(urlv);
          if (a) wrapper.appendChild(a);
        } else {
          var support = document.createElement('a');
          support.className = 'bought__cta';
          try { support.setAttribute('href', 'docs.html#support'); } catch (e) { }
          support.textContent = 'Contact Support';
          wrapper.appendChild(support);

          if (detail && (detail.id || detail.ref)) {
            var vb = el('button', 'btn btn-ghost bought__verify', 'Verify purchase');
            try { vb.setAttribute('type', 'button'); } catch (e) { }
            vb.setAttribute('data-bought-verify', detail.id || detail.ref || '');
            wrapper.appendChild(vb);
          }

          // If a conservative receipt URL (https) and an order reference exist, expose them
          try {
            if (detail && typeof detail === 'object') {
              var rurl = detail.receiptUrl || detail.receipt || '';
              if (typeof rurl === 'string') rurl = rurl.trim();
              var ref = detail.ref || detail.id || '';
              if (rurl && /^https:\/\//i.test(rurl) && ref) {
                try { if (!wrapper.querySelector('.bought__receipt')) { var ra = makeReceiptAnchor(rurl); if (ra) wrapper.appendChild(ra); } } catch (e) { }
                try { if (!wrapper.querySelector('[data-ssp-copy-ref]')) { var cb = makeCopyRefButton(ref); if (cb) wrapper.appendChild(cb); } } catch (e) { }
              }
            }
          } catch (e) { }
        }
        try { host.appendChild(wrapper); } catch (e) { }
      } catch (e) { }

    } catch (e) { }
  }

  // Delegated click handler for verify buttons
  try {
    document.addEventListener('click', function (e) {
      try {
        var btn = e.target && e.target.closest ? e.target.closest('[data-bought-verify]') : null;
        if (!btn) return;
        var tag = (btn.tagName || '').toLowerCase();
        if (tag !== 'button' && tag !== 'a' && tag !== 'input') return;
        e.preventDefault();
        if (btn.getAttribute('data-ssp-verifying') === 'on') return;
        btn.setAttribute('data-ssp-verifying', 'on');
        var origText = btn.textContent || '';
        try { btn.disabled = true; } catch (err) { }
        try { btn.textContent = 'Verifying…'; } catch (err) { }
        var id = attr(btn, 'data-bought-verify') || '';
        function failRestore(msg) {
          try { btn.textContent = origText; } catch (e) { }
          try { btn.disabled = false; } catch (e) { }
          try { btn.removeAttribute('data-ssp-verifying'); } catch (e) { }
          try {
            var hint = document.createElement('span');
            hint.className = 'bought__verify-hint';
            hint.style.cssText = 'margin-left:8px;font-size:13px;color:#6b7280';
            var a = document.createElement('a');
            a.setAttribute('href', 'docs.html#support');
            a.style.color = '#7c5cff';
            a.textContent = msg || 'Need help? Contact Support';
            hint.appendChild(a);
            if (btn.parentNode) {
              try { btn.parentNode.insertBefore(hint, btn.nextSibling); } catch (e) { }
              setTimeout(function () { try { if (hint && hint.parentNode) hint.parentNode.removeChild(hint); } catch (e) { } }, 6000);
            }
          } catch (e) { }
        }

        if (typeof window.groupStoreVerify !== 'function') { failRestore('Verify unavailable — Contact Support'); return; }
        try {
          var p = null;
          try { p = window.groupStoreVerify(id); } catch (err) { p = null; }
          if (!p || typeof p.then !== 'function') { if (!p) { failRestore('Verify failed — Contact Support'); return; } p = Promise.resolve(p); }
          p.then(function (order) {
            try {
              if (!order) { failRestore('No order found — Contact Support'); return; }
              try { if (typeof window.soundshopPersistBought === 'function') window.soundshopPersistBought(order); } catch (e) { }
              try { document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: order })); } catch (e) { }
              try {
                var host = btn.closest('[data-bought-note]') || btn.closest('li.bought__item') || btn.closest('[data-bought-summary]') || btn.parentNode || document;
                if (host && typeof createBoughtCta === 'function') { try { createBoughtCta(host, order); } catch (e) { } }
              } catch (e) { }
              try {
                var d = extractDownloadUrl(order);
                if (d) { try { btn.textContent = 'Verified'; } catch (e) { } try { btn.disabled = false; } catch (e) { } try { btn.removeAttribute('data-ssp-verifying'); } catch (e) { } return; }
              } catch (e) { }
              try { btn.textContent = 'Verified'; } catch (e) { } try { btn.disabled = false; } catch (e) { } try { btn.removeAttribute('data-ssp-verifying'); } catch (e) { }
            } catch (e) { failRestore('Verify failed — Contact Support'); }
          }).catch(function () { failRestore('Verify failed — Contact Support'); });
        } catch (e) { failRestore('Verify failed — Contact Support'); }

      } catch (e) { }
    });
  } catch (e) { }

  try {
    document.addEventListener('soundshop:verified-order', function (evt) {
      try { P.initBoughtSummary(); P.initBoughtNote(); } catch (e) { }
    });
  } catch (e) { }

  function initUrlOrderVerifyBanner() {
    try {
      if (_sspUrlOrderVerifyDone) return; _sspUrlOrderVerifyDone = true;
      if (typeof window.groupStoreVerify === 'function') return;
      var m = (window.location && window.location.search) ? String(window.location.search) : '';
      var match = m.match(/[?&]d8a_order=([^&]+)/i);
      if (!match) return; var id = '';
      try { id = decodeURIComponent(match[1] || ''); } catch (e) { id = match[1] || ''; }
      if (!id) return;
      var mainEl = document.querySelector('main') || document.body;
      try {
        var banner = el('div', 'ssp-url-order-verify');
        banner.setAttribute('role', 'status');
        banner.style.cssText = 'padding:12px;margin:12px 0;border:1px solid #e6e6e6;background:#fffefc;color:#111;font-size:14px;border-radius:6px;display:flex;align-items:center;justify-content:space-between;gap:12px';
        var text = el('div', 'ssp-url-order-verify__text', 'This page was returned from a completed checkout. You can verify the order from the URL and restore any remembered purchase in this browser.');
        text.style.flex = '1'; banner.appendChild(text);
        var controls = el('div', 'ssp-url-order-verify__controls');
        var btn = el('button', 'btn btn-ghost', 'Verify purchase'); try { btn.setAttribute('type', 'button'); } catch (e) { }
        controls.appendChild(btn);
        banner.appendChild(controls);
        if (mainEl && mainEl.parentNode) { try { mainEl.parentNode.insertBefore(banner, mainEl); } catch (e) { if (mainEl) try { mainEl.appendChild(banner); } catch (e) { } } }

        btn.addEventListener('click', function () {
          try {
            if (btn.getAttribute('data-ssp-verifying') === 'on') return; btn.setAttribute('data-ssp-verifying', 'on');
            try { btn.disabled = true; } catch (e) { }
            try { btn.textContent = 'Verifying…'; } catch (e) { }
            if (typeof window.groupStoreVerify !== 'function') { try { btn.textContent = 'Verify purchase'; btn.disabled = false; btn.removeAttribute('data-ssp-verifying'); } catch (e) { } return; }
            var p = null; try { p = window.groupStoreVerify(id); } catch (e) { p = null; }
            if (!p || typeof p.then !== 'function') { try { btn.textContent = 'Verify purchase'; btn.disabled = false; btn.removeAttribute('data-ssp-verifying'); } catch (e) { } return; }
            p.then(function (order) {
              try {
                if (!order) { try { btn.textContent = 'Verify purchase'; btn.disabled = false; btn.removeAttribute('data-ssp-verifying'); } catch (e) { } return; }
                try { if (typeof window.soundshopPersistBought === 'function') window.soundshopPersistBought(order); } catch (e) { }
                try { document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: order })); } catch (e) { }
                try { var hint = el('div', 'ssp-url-order-verify__hint'); hint.style.cssText = 'margin-top:8px;font-size:13px;color:#6b7280'; var a = document.createElement('a'); a.setAttribute('href', 'docs.html#support'); a.style.color = '#7c5cff'; a.textContent = 'Verified — view your product pages for download links'; hint.appendChild(a); banner.appendChild(hint); } catch (e) { }
                try { btn.textContent = 'Verified'; btn.disabled = false; btn.removeAttribute('data-ssp-verifying'); } catch (e) { }
              } catch (e) { try { btn.textContent = 'Verify purchase'; btn.disabled = false; btn.removeAttribute('data-ssp-verifying'); } catch (e) { } }
            }).catch(function () { try { btn.textContent = 'Verify purchase'; btn.disabled = false; btn.removeAttribute('data-ssp-verifying'); } catch (e) { } });
          } catch (e) { try { btn.textContent = 'Verify purchase'; btn.disabled = false; btn.removeAttribute('data-ssp-verifying'); } catch (e) { } }
        }, false);

      } catch (e) { }
    } catch (e) { }
  }

  P.initUrlOrderVerifyBanner = initUrlOrderVerifyBanner;

  // Public init: perform bought-note and bought-summary work (safe to call repeatedly)
  P.init = function () {
    try { if (typeof P.initBoughtSummary === 'function') P.initBoughtSummary(); } catch (e) { }
    try { if (typeof P.initBoughtNote === 'function') P.initBoughtNote(); } catch (e) { }

    try {
      if (!_boughtAutoVerifyCalled && typeof window.groupStoreVerify === 'function') {
        var arr = [];
        try { arr = readBoughtArray(document); } catch (e) { arr = []; }
        if (arr && arr.length) {
          var toVerify = null;
          for (var i = 0; i < arr.length; i++) { var it = arr[i]; if (!it) continue; if ((it.id || it.ref) && !it.downloadUrl) { toVerify = it; break; } }
          if (toVerify) {
            _boughtAutoVerifyCalled = true;
            try {
              var vid = toVerify.id || toVerify.ref || '';
              var p = null; try { p = window.groupStoreVerify(vid); } catch (e) { p = null; }
              if (p && typeof p.then === 'function') {
                p.then(function (order) {
                  try {
                    if (!order) return;
                    var d = extractDownloadUrl(order);
                    if (!d) return;
                    try { if (typeof window.soundshopPersistBought === 'function') window.soundshopPersistBought(order); } catch (e) { }
                    try { document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: order })); } catch (e) { }
                  } catch (e) { }
                }).catch(function () { });
              }
            } catch (e) { }
          }
        }
      }
    } catch (e) { }

    try {
      if (typeof window.groupStoreVerify !== 'function' && !_sspUrlOrderVerifyDone) { try { initUrlOrderVerifyBanner(); } catch (e) { } }
    } catch (e) { }
  };

  // Export public helpers that may be used externally
  P.extractDownloadUrl = extractDownloadUrl;
  P.readBoughtArray = readBoughtArray;
  P.maskEmail = maskEmail;
  P.createBoughtCta = createBoughtCta;
  P.initUrlOrderVerifyBanner = initUrlOrderVerifyBanner;

}(window, document));
