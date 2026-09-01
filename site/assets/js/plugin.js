/* =========================================================================
   SOUNDSHOP — plugin.js
   Shared behaviour for product pages.

   NOTE: This file provides a small set of safe, idempotent helpers used by
   product pages and the static checks in tools/*. The implementation is
   intentionally conservative and defensive.
*/

(function (window, document) {
  'use strict';

  var SS = window.SS || null;
  var P = {};
  window.SSPlugin = P;

  // Fallback persister for remembered purchases. Non-overriding.
  try {
    if (typeof window.soundshopPersistBought !== 'function') {
      window.soundshopPersistBought = function (order) {
        try {
          if (!order || typeof order !== 'object') return;
          var BOUGHT_KEY = 'soundshop:bought:v1';
          function getProductToken(name) {
            try { if (!name) return null; name = String(name).toLowerCase(); } catch (e) { return null; }
            if (name.indexOf('vanta') !== -1) return 'vanta';
            if (name.indexOf('drift') !== -1) return 'drift';
            if (name.indexOf('prism') !== -1) return 'prism';
            if (name.indexOf('anvil') !== -1) return 'anvil';
            if (name.indexOf('bundle') !== -1 || name.indexOf('full shop') !== -1) return 'bundle';
            return null;
          }
          var token = getProductToken(order.itemName || order.name || order.item || '');
          if (!token) return;
          var rec = { t: Date.now(), ref: String(order.id || order.ref || order.reference || '') , state: 'paid' };
          try { var email = order.email || order.buyerEmail || order.customerEmail || ''; if (email) rec.email = String(email).trim().slice(0,128); } catch (e) { }
          try { var d = order.downloadUrl || order.installerUrl || ''; if (d && /^https?:\/\//i.test(d)) rec.downloadUrl = String(d).trim(); } catch (e) { }
          try {
            var raw = window.localStorage.getItem(BOUGHT_KEY);
            var store = {};
            if (raw) { try { store = JSON.parse(raw) || {}; } catch (e) { store = {}; } }
            var exist = store[token];
            if (exist && typeof exist === 'object') {
              if (!rec.downloadUrl && exist.downloadUrl) rec.downloadUrl = exist.downloadUrl;
              if (!rec.email && exist.email) rec.email = exist.email;
              if (!rec.ref && exist.ref) rec.ref = exist.ref;
            }
            store[token] = rec;
            try { window.localStorage.setItem(BOUGHT_KEY, JSON.stringify(store)); } catch (e) { }
          } catch (e) { }
        } catch (e) { /* ignore */ }
      };
    }
  } catch (e) { }

  // Small DOM helpers
  function $(sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }
  function el(tag, className, text) { var n = document.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = String(text); return n; }
  function attr(node, name) { try { if (!node) return ''; var v = node.getAttribute(name); return v == null ? '' : String(v).trim(); } catch (e) { return ''; } }

  // Extract a conservative https download URL from various order shapes
  function extractDownloadUrl(order) {
    try {
      if (!order || typeof order !== 'object') return '';
      var cand = order.downloadUrl || order.installerUrl || (order.installers && order.installers[0] && order.installers[0].url) || '';
      if (!cand || typeof cand !== 'string') return '';
      cand = cand.trim();
      if (!cand) return '';
      if (/^https?:\/\//i.test(cand)) return cand;
      return '';
    } catch (e) { return ''; }
  }

  // Read the bought array from localStorage; return list of records
  function readBoughtArray() {
    try {
      var raw = window.localStorage.getItem('soundshop:bought:v1');
      if (!raw) return [];
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!parsed || typeof parsed !== 'object') return [];
      var out = [];
      for (var k in parsed) {
        if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue;
        var r = parsed[k];
        if (!r) continue;
        r.tok = k; // token
        out.push(r);
      }
      return out;
    } catch (e) { return []; }
  }

  // Mask email helper
  function maskEmail(email) {
    try {
      if (!email || typeof email !== 'string') return '';
      var p = email.split('@');
      if (p.length !== 2) return email;
      var name = p[0];
      if (name.length <= 2) return '***@' + p[1];
      return name[0] + '***' + name[name.length-1] + '@' + p[1];
    } catch (e) { return ''; }
  }

  // Create a simple bought CTA element for a host and detail object
  function createBoughtCta(host, detail) {
    try {
      if (!host || !host.appendChild) return null;
      var a = document.createElement('a');
      a.className = 'bought__cta';
      var href = '';
      try { href = extractDownloadUrl(detail) || detail.downloadUrl || ''; } catch (e) { href = ''; }
      if (href) a.setAttribute('href', href);
      a.textContent = href ? 'Download' : 'View receipt';
      a.setAttribute('role', 'button');
      a.setAttribute('data-ssp-bought-cta', 'on');
      host.appendChild(a);
      return a;
    } catch (e) { return null; }
  }

  // Copy to clipboard (fallback textarea)
  function copyToClipboard(s) {
    try {
      return new Promise(function (resolve, reject) {
        try {
          if (!s || typeof s !== 'string') return reject(new Error('bad-input'));
          var ta = document.createElement('textarea'); ta.value = s;
          ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0'; ta.setAttribute('aria-hidden', 'true');
          document.body.appendChild(ta); ta.focus(); ta.select();
          var ok = false;
          try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
          try { document.body.removeChild(ta); } catch (e) { }
          if (ok) return resolve();
          return reject(new Error('copy-failed'));
        } catch (e) { return reject(e); }
      });
    } catch (e) { return Promise.reject(e); }
  }

  /* -----------------------------------------------------------------------
     Bought note/summary UI
  ----------------------------------------------------------------------- */
  function initBoughtNote(root) {
    try {
      var note = $( '[data-bought-note]', root );
      if (!note) return;
      if (note.getAttribute('data-ssp-bought-note') === 'on') return;
      note.setAttribute('data-ssp-bought-note', 'on');
      var token = attr(note, 'data-bought-note');
      if (!token) return;
      var arr = readBoughtArray();
      if (!arr || !arr.length) return;
      for (var i=0;i<arr.length;i++){
        var it = arr[i]; if (!it) continue;
        if (it.t && it.ref && it.state === 'paid') {
          if (token === (it.tok || '')) {
            try { note.className = note.className.replace(/(^|\s)is-hidden(\s|$)/, ' '); } catch (e) {}
            try { P.initBoughtSummary(); } catch (e) {}
            break;
          }
        }
      }
    } catch (e) { }
  }

  function initBoughtSummary(root) {
    try {
      var host = $( '[data-bought-summary]', root );
      if (!host) return;
      if (host.getAttribute('data-ssp-bought-summary') === 'on') return;
      host.setAttribute('data-ssp-bought-summary', 'on');
      var arr = readBoughtArray();
      if (!arr || !arr.length) return;
      var ul = document.createElement('ul'); ul.className = 'bought__list';
      for (var i=0;i<arr.length;i++){
        var it = arr[i]; if (!it) continue;
        var li = document.createElement('li'); li.className = 'bought__item';
        var span = document.createElement('span'); span.className = 'bought__label';
        span.textContent = maskEmail(it.email || '') || (it.ref || 'Purchased'); li.appendChild(span);
        // CTA
        try { createBoughtCta(li, it); } catch (e) { }
        ul.appendChild(li);
      }
      try { host.appendChild(ul); } catch (e) { }
    } catch (e) { }
  }

  // Conservative verify banner for ?d8a_order=<id>
  var _sspUrlOrderVerifyDone = false;
  function initUrlOrderVerifyBanner() {
    try {
      if (_sspUrlOrderVerifyDone) return;
      _sspUrlOrderVerifyDone = true;
      if (typeof window.groupStoreVerify === 'function') return;
      var m = (window.location && window.location.search) ? String(window.location.search) : '';
      var match = m.match(/[?&]d8a_order=([^&]+)/i);
      if (!match) return; var id = '';
      try { id = decodeURIComponent(match[1] || ''); } catch (e) { id = match[1] || ''; }
      if (!id) return;
      var mainEl = document.querySelector('main') || document.body;
      var banner = el('div', 'ssp-url-order-verify'); banner.setAttribute('role','status');
      banner.style.cssText = 'padding:12px;margin:12px 0;border:1px solid #e6e6e6;background:#fffefc;color:#111;font-size:14px;border-radius:6px;display:flex;align-items:center;justify-content:space-between;gap:12px';
      var text = el('div', 'ssp-url-order-verify__text', 'This page was returned from a completed checkout. You can verify the order from the URL and restore any remembered purchase in this browser.'); text.style.flex='1'; banner.appendChild(text);
      var controls = el('div', 'ssp-url-order-verify__controls'); var btn = el('button', 'btn btn-ghost', 'Verify purchase'); try { btn.setAttribute('type','button'); } catch (e) {}
      controls.appendChild(btn); banner.appendChild(controls);
      try { if (mainEl && mainEl.parentNode) mainEl.parentNode.insertBefore(banner, mainEl.nextSibling); else document.body.insertBefore(banner, document.body.firstChild); } catch (e) { try { document.body.insertBefore(banner, document.body.firstChild); } catch (e) { } }
      var oneClick = false;
      btn.addEventListener('click', function () {
        try {
          if (oneClick) return; oneClick = true; btn.textContent = 'Verifying…'; btn.disabled = true;
          var url = 'https://d8a.com/api/v1/store/orders/' + encodeURIComponent(id) + '?group=batch-synthshop';
          fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' }, credentials: 'omit' }).then(function (res) {
            if (!res || !res.ok) throw new Error('fetch-failed'); return res.json();
          }).then(function (json) {
            try {
              if (!json) throw new Error('no-json');
              var order = null;
              if (typeof json === 'object' && json.paid === true) order = json;
              else if (json && typeof json === 'object' && json.order && typeof json.order === 'object' && json.order.paid === true) order = json.order;
              if (!order) throw new Error('not-paid-or-no-order');
              try { if (typeof window.soundshopPersistBought === 'function') window.soundshopPersistBought(order); } catch (e) { }
              try { document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: order })); } catch (e) { }
              try { if (banner && banner.parentNode) banner.parentNode.removeChild(banner); } catch (e) { }
              try { var d = extractDownloadUrl(order); if (d) { var cand = document.querySelector('.bought__cta[href]') || null; if (cand && cand.getAttribute && String(cand.getAttribute('href')).trim() === d) { try { cand.focus && cand.focus(); cand.style.display='inline-block'; } catch (e) {} } } } catch (e) { }
            } catch (e) {
              try { var hint = el('div', 'ssp-url-order-verify__hint'); hint.style.cssText = 'margin-top:8px;font-size:13px;color:#6b7280'; var a = document.createElement('a'); a.setAttribute('href', 'docs.html#support'); a.style.color = '#7c5cff'; a.textContent = 'Verify failed — Contact Support'; hint.appendChild(a); try { banner.appendChild(hint); } catch (e) { } } catch (e) { }
              try { btn.textContent = 'Verify purchase'; btn.disabled = false; } catch (e) { }
            }
          }).catch(function () { try { var hint = el('div', 'ssp-url-order-verify__hint'); hint.style.cssText = 'margin-top:8px;font-size:13px;color:#6b7280'; var a = document.createElement('a'); a.setAttribute('href', 'docs.html#support'); a.style.color = '#7c5cff'; a.textContent = 'Verify failed — Contact Support'; hint.appendChild(a); try { banner.appendChild(hint); } catch (e) { } } catch (e) { } try { btn.textContent = 'Verify purchase'; btn.disabled = false; } catch (e) { } });
        } catch (e) { }
      });
    } catch (e) { }
  }

  // Export public helpers that may be used externally
  P.extractDownloadUrl = extractDownloadUrl;
  P.readBoughtArray = readBoughtArray;
  P.maskEmail = maskEmail;
  P.createBoughtCta = createBoughtCta;
  P.copyToClipboard = copyToClipboard;
  // Newly-exported helpers requested in approved proposal #605
  P.initBoughtSummary = initBoughtSummary;
  P.initBoughtNote = initBoughtNote;
  P.initUrlOrderVerifyBanner = initUrlOrderVerifyBanner;

}(window, document));
