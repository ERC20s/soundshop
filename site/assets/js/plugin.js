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
   * Extract a best-effort payment receipt URL from an order-like object
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

              // Preserve any stored receipt URL so the UI can show a fallback
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
          var d = extractDownloadUrl(detail);
          var r = extractReceiptUrl(detail);
          if (d) {
            var url = d;
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
          } else if (!d && r) {
            // No download URL, but we have a receipt URL — update or append a
            // 'View receipt' anchor as a sensible fallback.
            var rurl = r;
            try {
              var existing = host.querySelector('.bought__cta');
              if (existing && existing.tagName && existing.tagName.toLowerCase() === 'a') {
                try { existing.setAttribute('href', rurl); } catch (e) { /* ignore */ }
                try { existing.setAttribute('target', '_blank'); } catch (e) { /* ignore */ }
                try { existing.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }
                try { existing.textContent = 'View receipt'; } catch (e) { /* ignore */ }
                return;
              }
              try { makeReceiptAnchor(rurl); } catch (e) { /* ignore */ }
            } catch (e) { /* ignore */ }
          }
          return;
        }
      } catch (e) { /* ignore per-host */ }

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

      // If we already have a verified download URL, render it now. If not,
      // but we have a receipt URL, render that as a fallback. Otherwise render
      // the Check order button / Contact Support fallback.
      try {
        if (detail && extractDownloadUrl(detail)) {
          try { makeDownloadAnchor(extractDownloadUrl(detail)); } catch (e) { /* ignore */ }
        } else if (detail && extractReceiptUrl(detail)) {
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

                    } else if (v.receiptUrl && !v.downloadUrl) {
                      // If verify returned a receipt URL but no download, make sure
                      // the UI shows the receipt fallback.
                      try { detail.receiptUrl = v.receiptUrl; } catch (e) { /* ignore */ }

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
          if (p && typeof p.then === 'function') {
            p.then(function (order) {
              try {
                var v = P._normalisePaidDetail(order);
                if (v && v.downloadUrl) {
                  try { it.downloadUrl = v.downloadUrl; } catch (e) { /* ignore */ }
                  try { createBoughtCta(document.querySelector('[data-ssp-paid-id="' + String(id) + '"]'), it); } catch (e) { /* ignore */ }
                } else if (v && v.receiptUrl && !v.downloadUrl) {
                  try { it.receiptUrl = v.receiptUrl; } catch (e) { /* ignore */ }
                  try { createBoughtCta(document.querySelector('[data-ssp-paid-id="' + String(id) + '"]'), it); } catch (e) { /* ignore */ }
                }
              } catch (e) { /* ignore then */ }
            }).catch(function () { /* ignore */ });
          }
        } catch (e) { /* ignore per-item */ }
      });

    } catch (e) { /* ignore */ }
  };

  /**
   * Normalise a platform-supplied order object into the record shape used
   * by the rest of plugin.js. This is intentionally defensive and shallow.
   */
  P._normalisePaidDetail = function (o) {
    try {
      if (!o || typeof o !== 'object') return null;
      var out = {};
      out.id = o.id || o.ref || o.reference || o.order || o.tx || '';
      if (out.id) out.ref = out.id;
      out.itemName = o.itemName || o.name || o.label || '';
      out.email = o.email || o.deliveryEmail || o.buyerEmail || o.customerEmail || '';
      out.t = o.t || o.time || o.date || null;
      try { var d = extractDownloadUrl(o); if (d) out.downloadUrl = d; } catch (e) { /* ignore */ }
      try { var r = extractReceiptUrl(o); if (r) out.receiptUrl = r; } catch (e) { /* ignore */ }
      return out;
    } catch (e) { return null; }
  };

  /**
   * Handle a returned checkout object from the platform (window.groupStorePaid
   * or document 'group-store:paid' event). Reveal bought-note and bought-summary
   * UI immediately using the supplied object. This function is display-only
   * and does not persist anything to localStorage.
   */
  P.handleGroupStorePaid = function (order) {
    try {
      var det = P._normalisePaidDetail(order);
      if (!det) return;

      // Trigger the per-page persistence helper when available so callers that
      // only run the display logic here can still ensure the canonical
      // storage and immediate bought-summary refresh occurs. Fail silently.
      try {
        if (typeof window.soundshopPersistBought === 'function') {
          try { window.soundshopPersistBought(order); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }

      // Reveal and populate any [data-bought-note] hosts
      try {
        $$('[data-bought-note]').forEach(function (host) {
          try {
            // Populate first-item style as initBoughtNote does
            try { host.removeAttribute('hidden'); } catch (e) { /* ignore */ }
            try {
              var titleEl = host.querySelector('[data-bought-note-title]');
              if (titleEl) titleEl.textContent = String(det.itemName || det.name || det.title || det.label || 'Purchased item');
            } catch (e) { /* ignore */ }
            try {
              var subEl = host.querySelector('[data-bought-note-sub]');
              if (subEl) subEl.textContent = maskEmail(det.deliveryEmail || det.email || det.buyerEmail || det.customerEmail || '');
            } catch (e) { /* ignore */ }

            // Render payment reference + Copy control into the note area
            try { createBoughtNoteRef(host, det.id || det.ref || ''); } catch (e) { /* ignore */ }

            // Also append any CTA area into the note host
            try { createBoughtCta(host, det); } catch (e) { /* ignore */ }

            // Add Clear control so users can remove the remembered note locally
            try { createBoughtClear(host); } catch (e) { /* ignore */ }

          } catch (e) { /* ignore per-host */ }
        });
      } catch (e) { /* ignore */ }

      // Insert into any [data-bought-summary] lists, guarded by data-ssp-paid-id
      try {
        $$('[data-bought-summary]').forEach(function (host) {
          try {
            var list = host.querySelector('[data-bought-summary-list]');
            if (!list) return;

            var id = det.id || det.ref || '';
            if (!id) return;

            // Avoid duplicates: if an item with this paid id already exists, do nothing
            try {
              if (host.querySelector('[data-ssp-paid-id="' + String(id) + '"]')) return;
            } catch (e) { /* ignore selector errors */ }

            // Build a list item matching the bought-summary structure
            var li = document.createElement('li');
            li.className = 'bought__item';
            try { li.setAttribute('data-ssp-paid-id', String(id)); } catch (e) { /* ignore */ }

            var titleSpan = document.createElement('span');
            titleSpan.className = 'bought__title';
            titleSpan.textContent = String(det.itemName || det.name || det.title || det.label || 'Purchased item');
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

            // Finally try to insert a CTA area for this item. If the detail
            // already included a downloadUrl this will show a direct link; if
            // not the CTA will provide a Check order / Contact Support fallback.
            try { createBoughtCta(li, det); } catch (e) { /* ignore */ }

          } catch (e) { /* ignore per-host */ }
        });
      } catch (e) { /* ignore */ }

      // If the returned checkout did not include a direct download link but
      // the platform supports an on-demand verify, attempt one now so the
      // page can surface a "Download installers" link immediately for the
      // buyer without requiring them to click "Check order".
      try {
        var idToVerify = det && det.id ? String(det.id) : '';
        if (!det.downloadUrl && idToVerify && typeof window.groupStoreVerify === 'function') {
          var p = null;
          try { p = window.groupStoreVerify(idToVerify); } catch (e) { p = null; }
          if (p && typeof p.then === 'function') {
            p.then(function (order) {
              try {
                var vdet = P._normalisePaidDetail(order);
                if (vdet && vdet.downloadUrl) {
                  try { det.downloadUrl = vdet.downloadUrl; } catch (e) { /* ignore */ }

                  // Update any bought-summary list item for this paid id
                  try {
                    var paidEl = null;
                    try { paidEl = document.querySelector('[data-ssp-paid-id="' + String(idToVerify) + '"]'); } catch (e) { paidEl = null; }
                    if (paidEl) {
                      try { createBoughtCta(paidEl, det); } catch (e) { /* ignore */ }
                    }
                  } catch (e) { /* ignore */ }

                  // Update any visible bought-note hosts too
                  try {
                    $$('[data-bought-note]').forEach(function (host) {
                      try {
                        var ref = (det && (det.ref || det.id)) || '';
                        try { host.setAttribute('data-ssp-paid-ref', String(ref)); } catch (e) { /* ignore */ }
                        try { createBoughtCta(host, det); } catch (e) { /* ignore */ }
                      } catch (e) { /* ignore per-host */ }
                    });
                  } catch (e) { /* ignore */ }

                } else if (vdet && vdet.receiptUrl && !vdet.downloadUrl) {
                  try { det.receiptUrl = vdet.receiptUrl; } catch (e) { /* ignore */ }
                  try {
                    var paidEl = null;
                    try { paidEl = document.querySelector('[data-ssp-paid-id="' + String(idToVerify) + '"]'); } catch (e) { paidEl = null; }
                    if (paidEl) {
                      try { createBoughtCta(paidEl, det); } catch (e) { /* ignore */ }
                    }
                  } catch (e) { /* ignore */ }

                  try {
                    $$('[data-bought-note]').forEach(function (host) {
                      try {
                        var ref = (det && (det.ref || det.id)) || '';
                        try { host.setAttribute('data-ssp-paid-ref', String(ref)); } catch (e) { /* ignore */ }
                        try { createBoughtCta(host, det); } catch (e) { /* ignore */ }
                      } catch (e) { /* ignore per-host */ }
                    });
                  } catch (e) { /* ignore */ }
                }
              } catch (e) { /* ignore then */ }
            }).catch(function () { /* ignore */ });
          }
        }
      } catch (e) { /* ignore */ }

    } catch (e) { /* ignore */ }
  };

  // ... rest of file (init, other helpers) unchanged and intentionally omitted

})(window, document);
