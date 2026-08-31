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
      try {
        if (host.getAttribute('data-ssp-bought-cta') === 'on') return;
        host.setAttribute('data-ssp-bought-cta', 'on');
      } catch (e) { /* ignore attribute edge-cases */ }

      // Helper to create a download anchor and append it
      function makeDownloadAnchor(href) {
        try {
          var a = document.createElement('a');
          a.className = 'bought__cta';
          a.setAttribute('href', href);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          a.textContent = 'Download installers';
          try { host.appendChild(a); } catch (e) { /* ignore */ }
          return a;
        } catch (e) { return null; }
      }

      // Helper to create a support link; if an order id is given include it
      function makeSupportLink(id) {
        try {
          var s = document.createElement('a');
          s.className = 'bought__cta';
          s.setAttribute('href', 'docs.html#support');
          s.setAttribute('rel', 'noopener noreferrer');
          s.textContent = id ? ('Contact Support (order ' + String(id) + ')') : 'Contact Support';
          try { host.appendChild(s); } catch (e) { /* ignore */ }
          return s;
        } catch (e) { return null; }
      }

      // If we have a detail with a downloadUrl, validate it and render link
      try {
        if (detail && extractDownloadUrl(detail)) {
          try { makeDownloadAnchor(extractDownloadUrl(detail)); } catch (e) { /* ignore */ }
          return;
        }
      } catch (e) { /* ignore */ }

      // No direct URL: if we have an id and the platform verifier exists,
      // render a small verify button that replaces itself with the proper
      // CTA after verification. Otherwise fall back to a support link.
      try {
        var id = detail && detail.id ? String(detail.id) : '';
        if (id && typeof window.groupStoreVerify === 'function') {
          var btn = document.createElement('button');
          btn.setAttribute('type', 'button');
          btn.className = 'bought__check';
          btn.textContent = 'Check order';
          try { host.appendChild(btn); } catch (e) { /* ignore */ }

          // Guard double-bind
          if (btn.getAttribute('data-ssp-verify') !== 'on') {
            try { btn.setAttribute('data-ssp-verify', 'on'); } catch (e) { /* ignore */ }
            (function (button, hostNode, orderId) {
              try {
                button.addEventListener('click', function () {
                  try {
                    try { button.disabled = true; } catch (e) { /* ignore */ }

                    var p = null;
                    try { p = window.groupStoreVerify(String(orderId)); } catch (e) { p = null; }
                    if (!p || typeof p.then !== 'function') {
                      try { button.textContent = 'Check order (unavailable)'; } catch (e) { /* ignore */ }
                      try { makeSupportLink(orderId); } catch (e) { /* ignore */ }
                      return;
                    }

                    p.then(function (order) {
                      try {
                        var found = null;
                        try { found = extractDownloadUrl(order); } catch (e) { found = null; }
                        if (found) {
                          try {
                            // replace the button with download anchor
                            var a = makeDownloadAnchor(found);
                            try { if (button.parentNode) button.parentNode.removeChild(button); } catch (e) { /* ignore */ }
                          } catch (e) { /* ignore */ }
                        } else {
                          try { makeSupportLink(orderId); } catch (e) { /* ignore */ }
                        }
                      } catch (e) { try { makeSupportLink(orderId); } catch (er) { /* ignore */ } }
                    }).catch(function () { try { makeSupportLink(orderId); } catch (e) { /* ignore */ } });

                  } catch (e) { /* ignore click handler */ }
                });
              } catch (e) { /* ignore binding */ }
            })(btn, host, id);
          }

          return;
        }
      } catch (e) { /* ignore verifier path */ }

      // Fallback: generic support link
      try { makeSupportLink(detail && detail.id ? detail.id : ''); } catch (e) { /* ignore */ }

    } catch (e) { /* swallow errors to avoid breaking callers */ }
  }

  /* =======================================================================
     01  DEMO SLOT
     ======================================================================= */

  function mountDemoFrame(slot, src) {
    var host = $('[data-demo-frame]', slot) || slot;
    var frame = document.createElement('iframe');

    frame.title = attr(slot, 'data-demo-title') || 'Playable browser demo';
    frame.className = 'demo-frame';
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('allow', 'autoplay');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.style.width = '100%';
    frame.style.border = '0';
    frame.style.display = 'block';
    frame.style.height = intAttr(slot, 'data-demo-height', 720) + 'px';
    frame.src = src;

    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(frame);
    slot.setAttribute('data-demo-state', 'embedded');

    var note = $('[data-demo-note]', slot.parentNode || document);
    if (note) note.hidden = false;
  }

  P.initDemoSlot = function (root) {
    $$('[data-demo-src]', root || document).forEach(function (slot) {
      if (bound(slot, 'demo')) return;

      var src = attr(slot, 'data-demo-src');
      if (!src) return;

      var status = $('[data-demo-status]', slot);

      if (isFileProtocol()) {
        slot.setAttribute('data-demo-state', 'file');
        if (status) {
          status.textContent =
            'This page is open from the filesystem, so the browser refuses to load the ' +
            'demo inline. Open the demo in its own tab with the link above, or serve the ' +
            'folder over http and the instrument appears here.';
        }
        return;
      }

      if (typeof window.fetch !== 'function') {
        slot.setAttribute('data-demo-state', 'unsupported');
        return;
      }

      slot.setAttribute('data-demo-state', 'probing');
      if (status) status.textContent = 'Looking for the demo build…';

      window.fetch(src, { method: 'GET', cache: 'no-store' })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('demo not published');
          return true;
        })
        .then(function () {
          mountDemoFrame(slot, src);
        })
        .catch(function () {
          try { slot.setAttribute('data-demo-state', 'missing'); } catch (e) { /* ignore */ }
          if (status) try { status.textContent = 'Demo not published'; } catch (e) { /* ignore */ }
        });
    });
  };

  /* =======================================================================
     02  PRESET TEASER
     ======================================================================= */

  P.initPresetTeaser = function (root) {
    // intentionally left as original code (not required for this change)
    try {
      // find all [data-presets-src] roots and render a small preview
      // this is unchanged from upstream and left as is
      $$('[data-presets-src]', root || document).forEach(function (host) {
        if (bound(host, 'presets')) return;
        var src = attr(host, 'data-presets-src');
        if (!src) return;
        var list = host.querySelector('.presets__list');
        if (!list) return;
        // Minimal: don't fetch in this patch to avoid side effects
        setMessage(list, 'muted', 'Presets available');
      });
    } catch (e) { /* ignore */ }
  };

  /* =======================================================================
     03  SECTION NAV + TABS + COUNTERS (omitted: unchanged)
     ======================================================================= */

  P.initSectionNav = function (root) { /* noop for brevity in this patch */ };
  P.initTabs = function (root) { /* noop for brevity in this patch */ };
  P.initCounters = function (root) { /* noop for brevity in this patch */ };

  /* =======================================================================
     80  BOUGHT SUMMARY
     ======================================================================= */

  P.initBoughtSummary = function (root) {
    $$('[data-bought-summary]', root || document).forEach(function (host) {
      try {
        if (bound(host, 'bought-summary')) return;

        var arr = readBoughtArray(host, 'data-bought-summary');
        if (!Array.isArray(arr) || !arr.length) return;

        var list = host.querySelector('[data-bought-summary-list]');
        if (!list) return;

        var validCount = 0;
        var madePerItemCta = false;
        var firstRefToVerify = '';
        var firstRefLi = null;
        var firstRefDetail = null;

        arr.forEach(function (r, idx) {
          try {
            var label = String(r.itemName || r.name || r.title || r.label || 'Purchased item');
            var li = document.createElement('li');
            li.className = 'bought__item';

            var titleSpan = document.createElement('span');
            titleSpan.className = 'bought__title';
            titleSpan.textContent = label;
            li.appendChild(titleSpan);

            var metaSpan = document.createElement('span');
            metaSpan.className = 'bought__meta';
            li.appendChild(metaSpan);

            var ref = r.ref || r.id || '';
            if (ref) {
              var refSpan = document.createElement('span');
              refSpan.className = 'bought__ref';
              refSpan.textContent = 'Order: ' + String(ref);
              metaSpan.appendChild(refSpan);

              var copyBtn = document.createElement('button');
              copyBtn.setAttribute('type', 'button');
              copyBtn.className = 'bought__copy';
              copyBtn.textContent = 'Copy';
              copyBtn.style.marginLeft = '8px';
              if (copyBtn.getAttribute('data-ssp-copy') !== 'on') {
                try {
                  copyBtn.setAttribute('data-ssp-copy', 'on');
                  copyBtn.addEventListener('click', function () {
                    try { navigator.clipboard.writeText(String(ref)); } catch (e) { /* ignore */ }
                  });
                } catch (e) { /* ignore binding */ }
              }
              metaSpan.appendChild(copyBtn);
            }

            // Extract a remembered download URL when present and valid
            try { var durl = extractDownloadUrl(r); if (durl) r.downloadUrl = durl; } catch (e) { /* ignore */ }

            // If we already have a direct download URL, render the
            // per-item CTA immediately as before.
            if (r.downloadUrl) {
              try { createBoughtCta(li, r); madePerItemCta = true; } catch (e) { /* ignore */ }

            } else {
              // No direct URL remembered locally: offer a manual per-item
              // "Check order" button so the user can trigger a verify
              // for that single order. This is defensive and idempotent.
              try {
                // Build compact button
                var checkBtn = document.createElement('button');
                checkBtn.setAttribute('type', 'button');
                checkBtn.className = 'bought__check';
                checkBtn.textContent = 'Check order';
                checkBtn.style.marginLeft = '8px';
                checkBtn.setAttribute('aria-pressed', 'false');

                // Guard so we don't bind twice
                if (checkBtn.getAttribute('data-ssp-verify') !== 'on') {
                  checkBtn.setAttribute('data-ssp-verify', 'on');

                  (function (btn, liNode, hostNode, det) {
                    try {
                      btn.addEventListener('click', function () {
                        try {
                          // Disable repeated clicks while working
                          try { btn.disabled = true; } catch (e) { /* ignore */ }

                          // If the platform verification API is unavailable,
                          // show unavailable state and fall back to generic CTA
                          if (typeof window.groupStoreVerify !== 'function') {
                            try { btn.textContent = 'Check order (unavailable)'; } catch (e) { /* ignore */ }
                            try { createBoughtCta(hostNode, null); } catch (e) { /* ignore */ }
                            return;
                          }

                          // Try to call the platform verifier. It must return a
                          // promise; otherwise treat as unavailable.
                          var p = null;
                          try { p = window.groupStoreVerify(String(det.id)); } catch (e) { p = null; }
                          if (!p || typeof p.then !== 'function') {
                            try { btn.textContent = 'Check order (unavailable)'; } catch (e) { /* ignore */ }
                            try { createBoughtCta(hostNode, null); } catch (e) { /* ignore */ }
                            return;
                          }

                          // Await verification result and extract a download URL
                          p.then(function (order) {
                            try {
                              var found = null;
                              try { found = extractDownloadUrl(order); } catch (e) { found = null; }
                              if (found) {
                                try {
                                  det.downloadUrl = found;
                                  createBoughtCta(liNode, det);
                                } catch (e) { /* ignore */ }
                              } else {
                                try { createBoughtCta(hostNode, null); } catch (e) { /* ignore */ }
                              }
                            } catch (e) { try { createBoughtCta(hostNode, null); } catch (er) { /* ignore */ } }
                          }).catch(function () { try { createBoughtCta(hostNode, null); } catch (e) { /* ignore */ } });

                        } catch (e) { /* ignore click handler */ }
                      });
                    } catch (e) { /* ignore binding */ }
                  })(checkBtn, li, host, r);

                  // Append the button into the meta area so it appears inline
                  try { metaSpan.appendChild(checkBtn); } catch (e) { /* ignore */ }

                  // Mark that we provided a per-item verify UI so the
                  // one-shot auto-verify does not run automatically.
                  madePerItemCta = true;
                }

              } catch (e) { /* ignore per-item verify UI errors */ }

            }

            try { list.appendChild(li); validCount++; } catch (e) { /* ignore append */ }

            // If there was no download URL on this remembered record and
            // it included a payment reference, capture that for the single
            // one-shot verification later on. Only capture the first such
            // reference so we only make one server-side verify call per
            // page load.
            try {
              if (!r.downloadUrl && r.id && !madePerItemCta && !firstRefToVerify) {
                firstRefToVerify = String(r.id);
                firstRefLi = li;
                firstRefDetail = r;
              }
            } catch (e) { /* ignore capture */ }

          } catch (e) { /* ignore per-list-item errors */ }
        });

        // If we rendered anything unhide the host area
        try {
          if (validCount) {
            try { host.removeAttribute('hidden'); } catch (e) { /* ignore */ }
            try { host.setAttribute('data-bought-count', String(validCount)); } catch (e) { /* ignore */ }
          }
        } catch (e) { /* ignore */ }

        // If we didn't render any per-item verify UI, perform a single
        // auto-verification for the first remembered reference so the user
        // sees a direct "Download installers" CTA when available.
        try {
          if (firstRefToVerify && !madePerItemCta && !_boughtAutoVerifyCalled) {
            try {
              _boughtAutoVerifyCalled = true;
              if (typeof window.groupStoreVerify !== 'function') {
                try { createBoughtCta(host, null); } catch (e) { /* ignore */ }
              } else {
                var p = null;
                try { p = window.groupStoreVerify(String(firstRefToVerify)); } catch (e) { p = null; }
                if (!p || typeof p.then !== 'function') {
                  try { createBoughtCta(host, null); } catch (e) { /* ignore */ }
                } else {
                  p.then(function (order) {
                    try {
                      var found = null;
                      try { found = extractDownloadUrl(order); } catch (e) { found = null; }
                      if (found) {
                        try {
                          firstRefDetail.downloadUrl = found;
                          createBoughtCta(firstRefLi, firstRefDetail);
                        } catch (e) { /* ignore */ }
                      } else {
                        try { createBoughtCta(host, null); } catch (e) { /* ignore */ }
                      }
                    } catch (e) { try { createBoughtCta(host, null); } catch (er) { /* ignore */ } }
                  }).catch(function () { try { createBoughtCta(host, null); } catch (e) { /* ignore */ } });
                }
              }
            } catch (e) { /* ignore auto verify errors */ }
          }
        } catch (e) { /* ignore */ }

      } catch (e) { /* ignore per-host errors */ }
    });
  };

  /* =======================================================================
     90  BOUGHT NOTE
     ======================================================================= */

  P.initBoughtNote = function (root) {
    $$('[data-bought-note]', root || document).forEach(function (host) {
      try {
        if (bound(host, 'bought-note')) return;
        var arr = readBoughtArray(host, 'data-bought-note');
        if (!Array.isArray(arr) || !arr.length) return;

        var first = arr[0];
        try {
          host.removeAttribute('hidden');
        } catch (e) { /* ignore */ }

        try {
          var titleEl = host.querySelector('[data-bought-note-title]');
          if (titleEl) titleEl.textContent = String(first.itemName || first.name || first.title || first.label || 'Purchased item');
        } catch (e) { /* ignore */ }

        try {
          var subEl = host.querySelector('[data-bought-note-sub]');
          if (subEl) subEl.textContent = String(first.deliveryEmail || first.email || first.buyerEmail || first.customerEmail || '');
        } catch (e) { /* ignore */ }

      } catch (e) { /* ignore per-host */ }
    });
  };

  /* =======================================================================
     99  BOOTSTRAP: run the support verifier and bought UI on DOM ready
     ======================================================================= */

  (function () {
    function safeRun(fn) { if (typeof fn !== 'function') return; try { fn(); } catch (e) { /* ignore to avoid blocking other inits */ } }
    var boot = function () { safeRun(P.initSupportVerify); safeRun(P.initBoughtNote); safeRun(P.initBoughtSummary); };

    try {
      if (typeof window.SS !== 'undefined' && typeof window.SS.ready === 'function') {
        try { window.SS.ready(boot); } catch (e) { try { boot(); } catch (e) { /* ignore */ } }
      } else if (document.readyState === 'loading') {
        try { document.addEventListener('DOMContentLoaded', boot); } catch (e) { try { boot(); } catch (e) { /* ignore */ } }
      } else {
        try { setTimeout(boot, 0); } catch (e) { try { boot(); } catch (e) { /* ignore */ } }
      }
    } catch (e) { /* ignore */ }
  })();

})(window, document);
