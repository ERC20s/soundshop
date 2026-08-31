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

  // Gate to ensure we only attempt an auto server-side verify once per page
  // load. This keeps the privacy/traffic impact minimal when multiple hosts
  // exist on a single document.
  var _boughtAutoVerifyCalled = false;

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

  P.isFileProtocol = isFileProtocol;

  /** Replace the children of a node with a single message paragraph. */
  function setMessage(node, className, text) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
    node.appendChild(el('p', className, text));
  }

  /**
   * Extract a best-effort installer / download URL from an order-like object
   * and validate it. Returns a string URL when valid, otherwise null.
   */
  function extractDownloadUrl(obj) {
    try {
      if (!obj || typeof obj !== 'object') return null;
      var cand = obj.downloadUrl || obj.installerUrl || (obj.installers && obj.installers[0] && obj.installers[0].url) || '';
      if (typeof cand !== 'string') return null;
      cand = cand.trim();
      if (!cand) return null;
      // Accept only explicit http(s) URLs to limit exposure to data: or relative links
      if (/^https?:\/\//i.test(cand)) return cand;
    } catch (e) { /* ignore */ }
    return null;
  }

  /**
   * Extract a best-effort provider receipt URL from an order-like object
   * and validate it. Returns a string URL when valid, otherwise null.
   */
  function extractReceiptUrl(obj) {
    try {
      if (!obj || typeof obj !== 'object') return null;
      var cand = obj.receiptUrl || obj.receipt || obj.receipt_url || '';
      if (typeof cand !== 'string') return null;
      cand = cand.trim();
      if (!cand) return null;
      if (/^https?:\/\//i.test(cand)) return cand;
    } catch (e) { /* ignore */ }
    return null;
  }

  /**
   * Read remembered purchases from localStorage and present them as an Array
   * of item-like objects that the rest of plugin.js expects. Behaviour:
   *  - If the host has an explicit data-* key (attr name provided) use that.
   *  - Otherwise prefer canonical 'soundshop:bought:v1' which stores a v1
   *    object mapping from token -> record; normalise that shape into an
   *    Array. Finally fall back to legacy 'soundshop.bought' which is an Array.
   *  - Any parsing errors are caught and return an empty Array.
   */
  function readBoughtArray(host, dataAttrName) {
    try {
      var explicitKey = '';
      try { explicitKey = host && dataAttrName ? attr(host, dataAttrName) || '' : ''; } catch (e) { explicitKey = ''; }

      var candidates = [];
      if (explicitKey) candidates.push(explicitKey);
      candidates.push('soundshop:bought:v1');
      candidates.push('soundshop.bought');

      for (var i = 0; i < candidates.length; i++) {
        var key = candidates[i];
        try {
          var raw = window.localStorage && window.localStorage.getItem(key);
          if (!raw) continue;
          var parsed = null;
          try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }

          // If it's already an array, return it directly (legacy shape)
          if (Array.isArray(parsed)) {
            if (parsed.length) return parsed;
            continue;
          }

          // If it's an object mapping (v1), normalise to an array
          if (parsed && typeof parsed === 'object') {
            var out = [];
            var labelsEl = host && host.querySelector ? host.querySelector('[data-bought-summary-labels]') : null;
            for (var tok in parsed) {
              if (!Object.prototype.hasOwnProperty.call(parsed, tok)) continue;
              var rec = parsed[tok];
              if (!rec) continue;

              var name = '';
              try { if (labelsEl) name = attr(labelsEl, 'data-bought-label-' + tok) || ''; } catch (e) { name = ''; }
              if (!name) {
                try { name = String(tok).replace(/[-_]/g, ' '); name = name.charAt(0).toUpperCase() + name.slice(1); } catch (e) { name = String(tok); }
              }

              var item = {};
              item.name = name;
              item.itemName = name;
              item.title = name;
              item.label = name;
              item.email = (rec && (rec.email || rec.deliveryEmail || rec.buyerEmail || rec.customerEmail)) || '';
              var idv = (rec && (rec.ref || rec.reference || rec.order || rec.id || rec.tx)) || '';
              if (idv) item.ref = idv;
              if (idv) item.id = idv;
              item.t = (rec && (rec.t || rec.time || rec.date)) || null;
              item.state = (rec && rec.state) || null;
              item.quantity = 1;

              // Preserve any installer/download URL already stored in the record
              try {
                var durl = extractDownloadUrl(rec);
                if (durl) item.downloadUrl = durl;
              } catch (e) { /* ignore */ }

              // Preserve any provider receipt URL already stored in the record
              try {
                var rurl = extractReceiptUrl(rec);
                if (rurl) item.receiptUrl = rurl;
              } catch (e) { /* ignore */ }

              out.push(item);
            }
            if (out.length) return out;
          }

        } catch (e) {
          // ignore and try next candidate
        }
      }
    } catch (e) { /* ignore */ }
    return [];
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
      // show first and last char of local part, hide the middle
      return local.charAt(0) + '\u2026' + local.charAt(local.length - 1) + '@' + domain;
    } catch (e) { return ''; }
  }

  /**
   * Render a small action area to let the user either download installers
   * directly (when we have a verified direct URL) or contact Support /
   * trigger a verify when only an order id is present.
   *
   * This function is defensive and idempotent. It guards with
   * data-ssp-bought-cta on the host so repeated calls do not duplicate UI.
   *
   * Parameters:
   *  - host: an Element to append the CTA into (list item or host area)
   *  - detail: optional object with fields { id: <order id>, downloadUrl: <url>, itemName: ... }
   */
  function createBoughtCta(host, detail) {
    try {
      if (!host || !host.appendChild) return;

      // If we've previously created a CTA in this host, allow updating it when
      // a new detail provides a downloadUrl. This avoids duplicating CTAs but
      // lets a later verification populate a "Download installers" anchor.
      try {
        var already = host.getAttribute('data-ssp-bought-cta');
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
                return;
              }
              // If existing CTA exists but is not an anchor, append a proper link
              try { makeDownloadAnchor(url); } catch (e) { /* ignore */ }
            } catch (e) { /* ignore */ }
          }

          // If a receipt URL has been discovered and no downloadUrl exists,
          // update the existing anchor to point at the receipt as a conservative
          // fallback. Download URL always takes precedence.
          if (detail && !extractDownloadUrl(detail)) {
            var r = extractReceiptUrl(detail);
            if (r) {
              try {
                var existing2 = host.querySelector('.bought__cta');
                if (existing2 && existing2.tagName && existing2.tagName.toLowerCase() === 'a') {
                  try { existing2.setAttribute('href', r); } catch (e) { /* ignore */ }
                  try { existing2.setAttribute('target', '_blank'); } catch (e) { /* ignore */ }
                  try { existing2.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }
                  try { existing2.textContent = 'View receipt'; } catch (e) { /* ignore */ }
                  return;
                }
                try { makeReceiptAnchor(r); } catch (e) { /* ignore */ }
              } catch (e) { /* ignore */ }
            }
          }

          return;
        }
      } catch (e) { /* ignore */ }

      try { host.setAttribute('data-ssp-bought-cta', 'on'); } catch (e) { /* ignore */ }

      var wrapper = document.createElement('span');
      wrapper.className = 'bought__cta-wrapper';

      function makeDownloadAnchor(url) {
        try {
          var a = document.createElement('a');
          a.className = 'bought__cta';
          try { a.setAttribute('href', url); } catch (e) { /* ignore */ }
          try { a.setAttribute('target', '_blank'); } catch (e) { /* ignore */ }
          try { a.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }
          try { a.textContent = 'Download installers'; } catch (e) { /* ignore */ }
          try { wrapper.appendChild(a); } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }
      }

      function makeReceiptAnchor(url) {
        try {
          var a = document.createElement('a');
          a.className = 'bought__cta';
          try { a.setAttribute('href', url); } catch (e) { /* ignore */ }
          try { a.setAttribute('target', '_blank'); } catch (e) { /* ignore */ }
          try { a.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }
          try { a.textContent = 'View receipt'; } catch (e) { /* ignore */ }
          try { wrapper.appendChild(a); } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }
      }

      // If we already have a verified download URL, render it now.
      try {
        if (detail && extractDownloadUrl(detail)) {
          try { makeDownloadAnchor(extractDownloadUrl(detail)); } catch (e) { /* ignore */ }
        } else if (detail && extractReceiptUrl(detail)) {
          // No download URL but a receipt URL exists: render a conservative
          // "View receipt" anchor as a fallback so buyers can reach their
          // payment provider's receipt page quickly.
          try { makeReceiptAnchor(extractReceiptUrl(detail)); } catch (e) { /* ignore */ }
        } else {
          // Otherwise render the fallback controls: Check order / Contact Support
          var btn = document.createElement('button');
          try { btn.setAttribute('type', 'button'); } catch (e) { /* ignore */ }
          btn.className = 'bought__cta';
          btn.textContent = 'Check order';
          try { btn.setAttribute('title', 'Check order'); } catch (e) { /* ignore */ }

          try {
            btn.addEventListener('click', function () {
              try {
                var id = (detail && (detail.id || detail.ref)) || '';
                if (!id) return;
                // If platform supports verify, call it and update in-place
                if (typeof window.groupStoreVerify !== 'function') return;
                var p = null;
                try { p = window.groupStoreVerify(String(id)); } catch (e) { p = null; }
                if (!p || typeof p.then !== 'function') return;
                p.then(function (order) {
                  try {
                    var v = P._normalisePaidDetail(order);
                    if (!v) return;
                    if (v.downloadUrl) {
                      try { detail.downloadUrl = v.downloadUrl; } catch (e) { /* ignore */ }

                      // Update any bought-summary list item for this paid id
                      try {
                        var paidEl = null;
                        try { paidEl = document.querySelector('[data-ssp-paid-id="' + String(id) + '"]'); } catch (e) { paidEl = null; }
                        if (paidEl) {
                          try { createBoughtCta(paidEl, detail); } catch (e) { /* ignore */ }
                        }
                      } catch (e) { /* ignore */ }

                      // Update any visible bought-note hosts too
                      try {
                        $$('[data-bought-note]').forEach(function (host) {
                          try {
                            var ref = (detail && (detail.ref || detail.id)) || '';
                            try { host.setAttribute('data-ssp-paid-ref', String(ref)); } catch (e) { /* ignore */ }
                            try { createBoughtCta(host, detail); } catch (e) { /* ignore */ }
                          } catch (e) { /* ignore per-host */ }
                        });
                      } catch (e) { /* ignore */ }

                      // Persist canonical storage so remembered purchases keep the
                      // verified installer URL and other pages can reflect it too.
                      try {
                        if (typeof window.soundshopPersistBought === 'function') {
                          try { window.soundshopPersistBought(order); } catch (e) { /* ignore */ }
                        }
                      } catch (e) { /* ignore */ }

                    } else if (v.receiptUrl) {
                      // No download URL but we discovered a receipt link. Persist
                      // it into canonical storage so the bought-summary/note show
                      // a safe "View receipt" fallback.
                      try { detail.receiptUrl = v.receiptUrl; } catch (e) { /* ignore */ }

                      try {
                        if (typeof window.soundshopPersistBought === 'function') {
                          try { window.soundshopPersistBought(order); } catch (e) { /* ignore */ }
                        }
                      } catch (e) { /* ignore */ }

                      // Update UI hosts in-place
                      try {
                        var paidEl2 = null;
                        try { paidEl2 = document.querySelector('[data-ssp-paid-id="' + String(id) + '"]'); } catch (e) { paidEl2 = null; }
                        if (paidEl2) {
                          try { createBoughtCta(paidEl2, detail); } catch (e) { /* ignore */ }
                        }
                      } catch (e) { /* ignore */ }

                      try {
                        $$('[data-bought-note]').forEach(function (host) {
                          try {
                            var ref = (detail && (detail.ref || detail.id)) || '';
                            try { host.setAttribute('data-ssp-paid-ref', String(ref)); } catch (e) { /* ignore */ }
                            try { createBoughtCta(host, detail); } catch (e) { /* ignore */ }
                          } catch (e) { /* ignore per-host */ }
                        });
                      } catch (e) { /* ignore */ }
                    }

                  } catch (e) { /* ignore then */ }
                }).catch(function () { /* ignore */ });
              } catch (e) { /* ignore click */ }
            });
          } catch (e) { /* ignore */ }

          try { wrapper.appendChild(btn); } catch (e) { /* ignore append */ }
        }
      } catch (e) { /* ignore */ }

      try { host.appendChild(wrapper); } catch (e) { /* ignore append */ }
    } catch (e) { /* ignore */ }
  }

  // Expose a small helper that reads the canonical bought storage and returns
  // the normalised array shape. This is used by bought-note and bought-summary
  // initialisers elsewhere in this file.
  P._readBoughtArray = readBoughtArray;

  /**
   * Initialise any [data-bought-note] hosts to show the first remembered
   * purchase. This function is defensive and idempotent and will not throw
   * when run on documents that do not include the markup.
   */
  P.initBoughtNote = function (root) {
    try {
      var hosts = (root && root.querySelectorAll) ? root.querySelectorAll('[data-bought-note]') : document.querySelectorAll('[data-bought-note]');
      if (!hosts || !hosts.length) return;

      Array.prototype.slice.call(hosts).forEach(function (host) {
        try {
          if (bound(host, 'bought-note')) return;

          var dataKey = attr(host, 'data-bought-key');
          var arr = readBoughtArray(host, 'data-bought-key');
          if (!arr || !arr.length) return;

          var first = arr[0];
          try { host.removeAttribute('hidden'); } catch (e) { /* ignore */ }

          try {
            var titleEl = host.querySelector('[data-bought-note-title]');
            if (titleEl) titleEl.textContent = String(first.itemName || first.name || first.title || first.label || 'Purchased item');
          } catch (e) { /* ignore */ }

          try {
            var subEl = host.querySelector('[data-bought-note-sub]');
            if (subEl) subEl.textContent = maskEmail(first.email || '');
          } catch (e) { /* ignore */ }

          try { createBoughtNoteRef(host, first.ref || first.id || ''); } catch (e) { /* ignore */ }

          try { createBoughtCta(host, first); } catch (e) { /* ignore */ }

          try { createBoughtClear(host); } catch (e) { /* ignore */ }

          try { host.setAttribute('data-ssp-paid-ref', String(first.ref || first.id || '')); } catch (e) { /* ignore */ }

        } catch (e) { /* ignore per-host */ }
      });

    } catch (e) { /* ignore */ }
  };

  /**
   * Initialise any [data-bought-summary] hosts by listing every remembered
   * purchase. This function is defensive and idempotent and will be called
   * on DOM ready by SSPlugin.init().
   */
  P.initBoughtSummary = function (root) {
    try {
      var hosts = (root && root.querySelectorAll) ? root.querySelectorAll('[data-bought-summary]') : document.querySelectorAll('[data-bought-summary]');
      if (!hosts || !hosts.length) return;

      Array.prototype.slice.call(hosts).forEach(function (host) {
        try {
          if (bound(host, 'bought-summary')) return;

          var list = host.querySelector('[data-bought-summary-list]');
          if (!list) return;

          var arr = readBoughtArray(host, 'data-bought-key');
          if (!arr || !arr.length) return;

          arr.forEach(function (it) {
            try {
              var id = it.ref || it.id || '';
              if (!id) return;
              try { if (host.querySelector('[data-ssp-paid-id="' + String(id) + '"]')) return; } catch (e) { /* ignore */ }

              var li = document.createElement('li');
              li.className = 'bought__item';
              try { li.setAttribute('data-ssp-paid-id', String(id)); } catch (e) { /* ignore */ }

              var titleSpan = document.createElement('span');
              titleSpan.className = 'bought__title';
              titleSpan.textContent = String(it.itemName || it.name || it.title || it.label || 'Purchased item');
              li.appendChild(titleSpan);

              var metaSpan = document.createElement('span');
              metaSpan.className = 'bought__meta';
              li.appendChild(metaSpan);

              try {
                var refSpan = document.createElement('span');
                refSpan.className = 'bought__ref';
                refSpan.textContent = 'Order: ' + String(id);
                metaSpan.appendChild(refSpan);

                var copyBtn = document.createElement('button');
                copyBtn.setAttribute('type', 'button');
                copyBtn.className = 'bought__copy';
                copyBtn.textContent = 'Copy';
                copyBtn.style.marginLeft = '8px';
                try {
                  copyBtn.setAttribute('data-ssp-copy', 'on');
                  copyBtn.addEventListener('click', function () { try { navigator.clipboard.writeText(String(id || '')); } catch (e) { /* ignore */ } });
                } catch (e) { /* ignore */ }
                metaSpan.appendChild(copyBtn);

              } catch (e) { /* ignore */ }

              try { list.appendChild(li); } catch (e) { /* ignore append */ }

              try { createBoughtCta(li, it); } catch (e) { /* ignore */ }

            } catch (e) { /* ignore per-item */ }
          });

        } catch (e) { /* ignore per-host */ }
      });

    } catch (e) { /* ignore */ }
  };

  /**
   * Auto-verify remembered purchases when possible so the page can surface a
   * "Download installers" link without a user click. This is guarded so it
   * only runs once per page load and only when groupStoreVerify is available.
   */
  P._autoVerifyRememberedPurchases = function () {
    try {
      if (_boughtAutoVerifyCalled) return;
      _boughtAutoVerifyCalled = true;

      var arr = readBoughtArray(null, null);
      if (!arr || !arr.length) return;

      arr.forEach(function (it) {
        try {
          if (it.downloadUrl) return; // already have a URL, nothing to verify
          var id = it.ref || it.id || '';
          if (!id) return;
          if (typeof window.groupStoreVerify !== 'function') return;
          var p = null;
          try { p = window.groupStoreVerify(String(id)); } catch (e) { p = null; }
          if (!p || typeof p.then !== 'function') return;
          p.then(function (order) {
            try {
              var v = P._normalisePaidDetail(order);
              if (!v) return;
              if (v.downloadUrl) {
                try { it.downloadUrl = v.downloadUrl; } catch (e) { /* ignore */ }

                // Persist canonical storage so remembered purchases keep the
                // verified installer URL and other pages can reflect it too.
                try {
                  if (typeof window.soundshopPersistBought === 'function') {
                    try { window.soundshopPersistBought(order); } catch (e) { /* ignore */ }
                  }
                } catch (e) { /* ignore */ }

                // Update any bought-summary list item for this paid id (in-place)
                try {
                  var paidEl = null;
                  try { paidEl = document.querySelector('[data-ssp-paid-id="' + String(id) + '"]'); } catch (e) { paidEl = null; }
                  if (paidEl) {
                    try { createBoughtCta(paidEl, it); } catch (e) { /* ignore */ }
                  }
                } catch (e) { /* ignore */ }

                // Update any visible bought-note hosts too
                try {
                  $$('[data-bought-note]').forEach(function (host) {
                    try {
                      var ref = (it && (it.ref || it.id)) || '';
                      try { host.setAttribute('data-ssp-paid-ref', String(ref)); } catch (e) { /* ignore */ }
                      try { createBoughtCta(host, it); } catch (e) { /* ignore */ }
                    } catch (e) { /* ignore per-host */ }
                  });
                } catch (e) { /* ignore */ }

                // Clear per-host guard attributes so initialisers can re-run
                try {
                  $$('[data-bought-summary]').forEach(function (h) {
                    try {
                      var items = h.querySelectorAll('[data-ssp-paid-id]');
                      Array.prototype.slice.call(items).forEach(function (itm) { try { itm.removeAttribute('data-ssp-paid-id'); } catch (e) { /* ignore */ } });
                      try { h.removeAttribute('data-ssp-bought-cta'); } catch (e) { /* ignore */ }
                      try { h.removeAttribute('data-ssp-bought-summary'); } catch (e) { /* ignore */ }
                    } catch (e) { /* ignore per-host */ }
                  });
                  $$('[data-bought-note]').forEach(function (h) {
                    try { h.removeAttribute('data-ssp-bought-cta'); } catch (e) { /* ignore */ }
                    try { h.removeAttribute('data-ssp-paid-ref'); } catch (e) { /* ignore */ }
                  });
                } catch (e) { /* ignore */ }

                // Re-run initialisers where available to refresh UI immediately
                try { if (typeof P.initBoughtSummary === 'function') { try { P.initBoughtSummary(); } catch (e) { /* ignore */ } } } catch (e) { /* ignore */ }
                try { if (typeof P.initBoughtNote === 'function') { try { P.initBoughtNote(); } catch (e) { /* ignore */ } } } catch (e) { /* ignore */ }

              } else if (v.receiptUrl) {
                // No download URL but we discovered a receipt link. Persist it
                // into canonical storage so the bought-summary/note show a safe
                // "View receipt" fallback.
                try { it.receiptUrl = v.receiptUrl; } catch (e) { /* ignore */ }

                try {
                  if (typeof window.soundshopPersistBought === 'function') {
                    try { window.soundshopPersistBought(order); } catch (e) { /* ignore */ }
                  }
                } catch (e) { /* ignore */ }

                // Update any bought-summary list item for this paid id (in-place)
                try {
                  var paidElR = null;
                  try { paidElR = document.querySelector('[data-ssp-paid-id="' + String(id) + '"]'); } catch (e) { paidElR = null; }
                  if (paidElR) {
                    try { createBoughtCta(paidElR, it); } catch (e) { /* ignore */ }
                  }
                } catch (e) { /* ignore */ }

                // Update any visible bought-note hosts too
                try {
                  $$('[data-bought-note]').forEach(function (host) {
                    try {
                      var ref = (it && (it.ref || it.id)) || '';
                      try { host.setAttribute('data-ssp-paid-ref', String(ref)); } catch (e) { /* ignore */ }
                      try { createBoughtCta(host, it); } catch (e) { /* ignore */ }
                    } catch (e) { /* ignore per-host */ }
                  });
                } catch (e) { /* ignore */ }

                // Clear per-host guard attributes so initialisers can re-run
                try {
                  $$('[data-bought-summary]').forEach(function (h) {
                    try {
                      var items = h.querySelectorAll('[data-ssp-paid-id]');
                      Array.prototype.slice.call(items).forEach(function (itm) { try { itm.removeAttribute('data-ssp-paid-id'); } catch (e) { /* ignore */ } });
                      try { h.removeAttribute('data-ssp-bought-cta'); } catch (e) { /* ignore */ }
                      try { h.removeAttribute('data-ssp-bought-summary'); } catch (e) { /* ignore */ }
                    } catch (e) { /* ignore per-host */ }
                  });
                  $$('[data-bought-note]').forEach(function (h) {
                    try { h.removeAttribute('data-ssp-bought-cta'); } catch (e) { /* ignore */ }
                    try { h.removeAttribute('data-ssp-paid-ref'); } catch (e) { /* ignore */ }
                  });
                } catch (e) { /* ignore */ }

                // Re-run initialisers where available to refresh UI immediately
                try { if (typeof P.initBoughtSummary === 'function') { try { P.initBoughtSummary(); } catch (e) { /* ignore */ } } } catch (e) { /* ignore */ }
                try { if (typeof P.initBoughtNote === 'function') { try { P.initBoughtNote(); } catch (e) { /* ignore */ } } } catch (e) { /* ignore */ }

              }
            } catch (e) { /* ignore then */ }
          }).catch(function () { /* ignore */ });
        } catch (e) { /* ignore per-item */ }
      });

    } catch (e) { /* ignore */ }
  };

  // Wrap initialiser binding so we can call the auto-verify after initBoughtNote
  try {
    var orig = P.initBoughtNote;
    if (typeof orig === 'function') {
      (function (orig) {
        P.initBoughtNote = function (root) {
          try { orig(root); } catch (e) { /* ignore */ }
          try { if (typeof P._autoVerifyRememberedPurchases === 'function') P._autoVerifyRememberedPurchases(); } catch (e) { /* ignore */ }
        };
      })(orig);
    }
  } catch (e) { /* ignore */ }

})(window, document);
