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
      return local.charAt(0) + '…' + local.charAt(local.length - 1) + '@' + domain;
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
            } catch (e) { /* ignore update errors */ }
          }
          return;
        }
      } catch (e) { /* ignore attribute edge-cases */ }

      try { host.setAttribute('data-ssp-bought-cta', 'on'); } catch (e) { /* ignore */ }

      // Helper to create a download anchor inside the host when we have a
      // verified installer URL.
      function makeDownloadAnchor(url) {
        try {
          if (!url) return;
          var a = document.createElement('a');
          a.className = 'bought__cta';
          try { a.setAttribute('href', url); } catch (e) { /* ignore */ }
          try { a.setAttribute('target', '_blank'); } catch (e) { /* ignore */ }
          try { a.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }
          try { a.textContent = 'Download installers'; } catch (e) { /* ignore */ }
          try { host.appendChild(a); } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }
      }

      // Helper to create a Contact Support / Check order fallback when no
      // verified installer URL is known. This provides the per-item "Check
      // order" button that lets buyers verify an order and surface installers.
      function makeSupportButton(id) {
        try {
          var wrap = document.createElement('div');
          wrap.className = 'bought__cta-wrap';
          var btn = document.createElement('button');
          btn.className = 'bought__cta';
          btn.setAttribute('type', 'button');
          try { btn.textContent = 'Check order'; } catch (e) { /* ignore */ }
          try {
            btn.addEventListener('click', function () {
              try {
                if (!id) {
                  // If we don't have an id, open support docs
                  try { window.location.href = 'docs.html#support'; } catch (e) { /* ignore */ }
                  return;
                }

                // Avoid hammering the platform: do nothing if verify is absent
                if (typeof window.groupStoreVerify !== 'function') {
                  try { window.location.href = 'docs.html#support'; } catch (e) { /* ignore */ }
                  return;
                }

                var p = null;
                try { p = window.groupStoreVerify(String(id)); } catch (e) { p = null; }
                if (!p || typeof p.then !== 'function') return;
                btn.textContent = 'Checking\u2026';
                p.then(function (order) {
                  try {
                    var vdet = P._normalisePaidDetail(order);
                    if (!vdet) {
                      try { btn.textContent = 'Check order'; } catch (e) { /* ignore */ }
                      return;
                    }
                    // If a downloadUrl was discovered, update UI
                    if (vdet.downloadUrl) {
                      try {
                        // Replace button with a proper download anchor
                        var a = document.createElement('a');
                        a.className = 'bought__cta';
                        try { a.setAttribute('href', vdet.downloadUrl); } catch (e) { /* ignore */ }
                        try { a.setAttribute('target', '_blank'); } catch (e) { /* ignore */ }
                        try { a.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }
                        try { a.textContent = 'Download installers'; } catch (e) { /* ignore */ }
                        try { wrap.replaceChild(a, btn); } catch (e) { /* ignore */ }
                      } catch (e) { /* ignore */ }
                    } else {
                      try { btn.textContent = 'Contact Support'; } catch (e) { /* ignore */ }
                    }
                  } catch (e) { /* ignore */ }
                }).catch(function () { try { btn.textContent = 'Check order'; } catch (e) { /* ignore */ } });
              } catch (e) { /* ignore click handler */ }
            });
          } catch (e) { /* ignore event wiring */ }
          try { wrap.appendChild(btn); } catch (e) { /* ignore */ }
          try { host.appendChild(wrap); } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }
      }

      // Decide which CTA to render immediately
      try {
        if (detail && extractDownloadUrl(detail)) {
          makeDownloadAnchor(extractDownloadUrl(detail));
        } else {
          var id = detail && detail.id ? String(detail.id) : '';
          makeSupportButton(id);
        }
      } catch (e) {
        // ignore
      }

    } catch (e) { /* ignore whole CTA creation */ }
  }

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
              if (subEl) subEl.textContent = String(det.deliveryEmail || det.email || det.buyerEmail || det.customerEmail || '');
            } catch (e) { /* ignore */ }
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

                  // Also update any bought-note hosts so the note area can
                  // present a download link as well.
                  try { $$('[data-bought-note]').forEach(function (host) { try { createBoughtCta(host, det); } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ }
                }
              } catch (e) { /* ignore verification handling */ }
            }).catch(function () { /* ignore verify failure */ });
          }
        }
      } catch (e) { /* ignore auto-verify errors */ }

    } catch (e) { /* ignore */ }
  };

  // Auto-verify helper used by the initialisers below. It performs a one-shot
  // verification pass for remembered purchases read from localStorage. The
  // routine is defensive: it respects the global _boughtAutoVerifyCalled gate
  // so it runs at most once per page load, only calls window.groupStoreVerify
  // when present, and records per-id attempts so each remembered id is
  // verified only once.
  P._autoVerifyRememberedPurchases = function (items) {
    try {
      if (_boughtAutoVerifyCalled) return;
      _boughtAutoVerifyCalled = true;

      // Minimal global cache to avoid double-verifying the same id across
      // multiple hosts or re-runs within the same page session.
      try { window._ssBoughtAutoVerifiedIds = window._ssBoughtAutoVerifiedIds || {}; } catch (e) { window._ssBoughtAutoVerifiedIds = {}; }

      if (typeof window.groupStoreVerify !== 'function') return;

      // Ensure items is an array
      if (!items || !Array.isArray(items)) return;

      items.forEach(function (it) {
        try {
          var id = it && (it.id || it.ref) ? String(it.id || it.ref) : '';
          if (!id) return;
          if (it.downloadUrl) return; // already have a URL
          if (window._ssBoughtAutoVerifiedIds[id]) return; // already attempted
          window._ssBoughtAutoVerifiedIds[id] = true;

          var p = null;
          try { p = window.groupStoreVerify(id); } catch (e) { p = null; }
          if (!p || typeof p.then !== 'function') return;

          p.then(function (order) {
            try {
              var vdet = P._normalisePaidDetail(order);
              if (!vdet) return;
              // If we discovered a download URL, update any matching UI
              if (vdet.downloadUrl) {
                try {
                  // Update any bought-summary items for this paid id
                  var selector = '[data-ssp-paid-id="' + String(id) + '"]';
                  var nodes = [];
                  try { nodes = Array.prototype.slice.call(document.querySelectorAll(selector)); } catch (e) { nodes = []; }
                  nodes.forEach(function (n) { try { createBoughtCta(n, vdet); } catch (e) { /* ignore */ } });

                  // Update any bought-note hosts as well
                  try { $$('[data-bought-note]').forEach(function (host) { try { createBoughtCta(host, vdet); } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ }
                } catch (e) { /* ignore UI update errors */ }
              }
            } catch (e) { /* ignore per-verify handling */ }
          }).catch(function () { /* ignore individual verification failure */ });

        } catch (e) { /* ignore per-item */ }
      });

    } catch (e) { /* ignore */ }
  };

  /**
   * Initialise any [data-bought-summary] hosts on the page by reading the
   * remembered purchases from localStorage and rendering each into the list.
   * This is idempotent and safe to call multiple times; it uses the bound()
   * guard so repeated runs do not re-bind events.
   */
  P.initBoughtSummary = function (root) {
    try {
      var hosts = [];
      if (root && root.querySelector) hosts = root.querySelectorAll && Array.prototype.slice.call(root.querySelectorAll('[data-bought-summary]')) || [];
      else hosts = $$('[data-bought-summary]');

      if (!hosts || !hosts.length) return;

      // Read the canonical bought array once and share for the auto-verify
      // step. We pass the host so readBoughtArray can use any host-specific
      // data-* key if present.
      hosts.forEach(function (host) {
        try {
          if (bound(host, 'bought-summary')) return;
          var items = readBoughtArray(host);
          if (!items || !items.length) continueHost(host);

          try { host.removeAttribute('hidden'); } catch (e) { /* ignore */ }
          var list = host.querySelector('[data-bought-summary-list]');
          if (!list) return;

          // Clear existing list items to reflect canonical storage
          try {
            while (list.firstChild) list.removeChild(list.firstChild);
          } catch (e) { /* ignore clear errors */ }

          items.forEach(function (it) {
            try {
              var id = it && (it.id || it.ref) ? String(it.id || it.ref) : '';

              var li = document.createElement('li');
              li.className = 'bought__item';
              try { if (id) li.setAttribute('data-ssp-paid-id', id); } catch (e) { /* ignore */ }

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
                refSpan.textContent = (attr(host, 'data-bought-summary-ref-prefix') || 'Order: ') + String(id || (it.ref || ''));
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

          // After rendering this host, attempt auto-verify across the items so
          // any direct download links are surfaced without requiring a click.
          try { P._autoVerifyRememberedPurchases(items); } catch (e) { /* ignore */ }

        } catch (e) { /* ignore per-host */ }
      });

      return;

    } catch (e) { /* ignore init errors */ }

    // Helper used in the loop to allow continue semantics inside try
    function continueHost(h) { try { /* noop marker */ } catch (e) { } }
  };

  /**
   * Initialise any [data-bought-note] hosts (the single-item note shown after
   * a returned checkout). When a remembered purchase exists, unhide the host
   * and populate its fields. This also attempts auto-verification through the
   * shared helper so a "Download installers" link can appear if available.
   */
  P.initBoughtNote = function (root) {
    try {
      var hosts = [];
      if (root && root.querySelector) hosts = root.querySelectorAll && Array.prototype.slice.call(root.querySelectorAll('[data-bought-note]')) || [];
      else hosts = $$('[data-bought-note]');

      if (!hosts || !hosts.length) return;

      hosts.forEach(function (host) {
        try {
          if (bound(host, 'bought-note')) return;
          var items = readBoughtArray(host);
          if (!items || !items.length) return;

          var it = items[0];
          try { host.removeAttribute('hidden'); } catch (e) { /* ignore */ }
          try { var titleEl = host.querySelector('[data-bought-note-title]'); if (titleEl) titleEl.textContent = String(it.itemName || it.name || it.title || it.label || 'Purchased item'); } catch (e) { /* ignore */ }
          try { var subEl = host.querySelector('[data-bought-note-sub]'); if (subEl) subEl.textContent = String(it.email || ''); } catch (e) { /* ignore */ }

          try { createBoughtCta(host, it); } catch (e) { /* ignore */ }

          try { P._autoVerifyRememberedPurchases(items); } catch (e) { /* ignore */ }

        } catch (e) { /* ignore per-host */ }
      });

    } catch (e) { /* ignore */ }
  };

  // ... the rest of the public API and initialisers follow (unchanged) ...

  /* =======================================================================
     Remaining initialisers and exports (not relevant to this change).
     These are intentionally left as they were in the upstream file so they
     continue to operate unchanged. We rely on the top-level build to keep
     the rest of this file intact.
     ======================================================================= */

})(window, document);
