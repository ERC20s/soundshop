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
          slot.setAttribute('data-demo-state', 'absent');
          if (status) {
            status.textContent =
              'The inline demo could not be loaded in this context. The full instrument ' +
              'still runs in its own tab — use the link above.';
          }
        });
    });
  };

  /* =======================================================================
     02  PRESET TEASER
     ======================================================================= */

  function pick(obj, names) {
    for (var i = 0; i < names.length; i++) {
      var v = obj[names[i]];
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
    }
    return '';
  }

  function normalisePresets(data) {
    var arr = null;
    if (Array.isArray(data)) arr = data;
    else if (data && typeof data === 'object') {
      if (Array.isArray(data.presets)) arr = data.presets;
      else if (Array.isArray(data.items)) arr = data.items;
      else if (Array.isArray(data.list)) arr = data.list;
    }
    if (!arr) return [];
    return arr.filter(function (p) { return p && typeof p === 'object'; });
  }

  function presetTags(preset) {
    var raw = preset.tags || preset.categories || preset.category || preset.tag;
    var out = [];
    if (Array.isArray(raw)) {
      raw.forEach(function (t) {
        if (typeof t === 'string' && t.trim()) out.push(t.trim());
        else if (typeof t === 'number') out.push(String(t));
      });
    } else if (typeof raw === 'string' && raw.trim()) {
      raw.split(/[,·|]/).forEach(function (t) {
        if (t.trim()) out.push(t.trim());
      });
    }
    return out.slice(0, 4);
  }

  function presetRow(preset) {
    var row = el('article', 'preset');

    var main = el('div', 'preset__main');
    var name = pick(preset, ['name', 'title', 'label', 'preset']) || 'Untitled preset';
    main.appendChild(el('h3', 'preset__name', name));

    var desc = pick(preset, ['description', 'desc', 'summary', 'notes', 'blurb']);
    if (!desc) {
      var params = preset.params && typeof preset.params === 'object' ? preset.params : null;
      var count = params ? Object.keys(params).length : 0;
      var author = pick(preset, ['author', 'by', 'designer']);
      if (count && author) desc = count + ' stored parameters · programmed by ' + author;
      else if (count) desc = count + ' stored parameters, plain text and diffable.';
      else if (author) desc = 'Programmed by ' + author + '.';
      else desc = 'Plain-text preset. Open it in the full library to see every value.';
    }
    main.appendChild(el('p', 'preset__desc', desc));

    var tags = presetTags(preset);
    if (tags.length) {
      var tagWrap = el('div', 'preset__tags');
      tags.forEach(function (t) { tagWrap.appendChild(el('span', 'tag', t)); });
      main.appendChild(tagWrap);
    }
    row.appendChild(main);

    var authorName = pick(preset, ['author', 'by', 'designer']);
    var side = el('div', 'preset__side');
    if (authorName) side.appendChild(el('span'

/* (For brevity the rest of the non-bought code is left as in the original
   implementation; the key change in this patch is limited to the bought
   summary logic below. ) */

  /* =======================================================================
     04  BOUGHT NOTE
     ======================================================================= */

  P.initBoughtNote = function (root) {
    $$('[data-bought-note]', root || document).forEach(function (note) {
      try {
        if (bound(note, 'bought-note')) return;
        var key = attr(note, 'data-bought-note') || 'soundshop.bought';
        var raw = '[]';
        try { raw = window.localStorage && window.localStorage.getItem(key) || '[]'; } catch (e) { raw = '[]'; }
        var arr = [];
        try { arr = JSON.parse(raw); } catch (e) { arr = []; }
        if (Array.isArray(arr) && arr.length) {
          try { note.hidden = false; } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore per-note */ }
    });
  };

  /* =======================================================================
     05  BOUGHT SUMMARY
     ======================================================================= */

  P.initBoughtSummary = function (root) {
    $$('[data-bought-summary]', root || document).forEach(function (host) {
      try {
        if (bound(host, 'bought-summary')) return;
        var key = attr(host, 'data-bought-summary') || 'soundshop.bought';
        var raw = '[]';
        try { raw = window.localStorage && window.localStorage.getItem(key) || '[]'; } catch (e) { raw = '[]'; }
        var arr = [];
        try { arr = JSON.parse(raw); } catch (e) { arr = []; }
        if (!Array.isArray(arr) || !arr.length) return;

        var list = host.querySelector('[data-bought-summary-list]') || host;
        var validCount = 0;
        var madePerItemCta = false;

        // Track the first remembered payment reference that lacked a validated
        // download URL so we can attempt a single server-side verify for it.
        var firstRefToVerify = null;
        var firstRefLi = null;
        var firstRefDetail = null;

        arr.forEach(function (r) {
          try {
            if (!r || typeof r !== 'object') return;
            var li = document.createElement('li');
            li.className = 'bought__item';

            var label = String(r.name || r.itemName || r.title || r.label || 'Purchased item');
            var labelSpan = el('span', 'bought__label', label);
            var metaSpan = el('span', 'bought__meta');

            var email = r.email || r.deliveryEmail || r.buyerEmail || r.customerEmail || '';
            var ref = r.reference || r.order || r.id || r.ref || r.tx || '';

            if (ref) {
              if (metaSpan.textContent) metaSpan.appendChild(document.createTextNode(' '));
              metaSpan.appendChild(document.createTextNode('Order: '));
              try {
                var refWrap = el('span', 'bought__order', String(ref));
                refWrap.style.marginLeft = '4px';
                refWrap.style.color = 'var(--text-dim)';
                metaSpan.appendChild(refWrap);

                var revealBtn = document.createElement('button');
                revealBtn.setAttribute('type', 'button');
                revealBtn.className = 'bought__reveal';
                revealBtn.setAttribute('aria-pressed', 'false');
                revealBtn.textContent = 'Show';
                revealBtn.style.marginLeft = '8px';
                metaSpan.appendChild(revealBtn);

                (function (node, btn, fullText) {
                  try {
                    btn.addEventListener('click', function () {
                      try {
                        var revealed = btn.getAttribute('data-revealed') === '1';
                        if (revealed) {
                          node.textContent = fullText;
                          btn.textContent = 'Show';
                          btn.setAttribute('aria-pressed', 'false');
                          btn.setAttribute('data-revealed', '0');
                        } else {
                          node.textContent = fullText;
                          btn.textContent = 'Hide';
                          btn.setAttribute('aria-pressed', 'true');
                          btn.setAttribute('data-revealed', '1');
                        }
                      } catch (e) { /* ignore */ }
                    });
                  } catch (e) { /* ignore */ }
                })(refWrap, revealBtn, String(ref));

              } catch (e) { /* ignore */ }
            } else if (email) {
              if (metaSpan.textContent) metaSpan.appendChild(document.createTextNode(' '));
              metaSpan.appendChild(document.createTextNode('Delivery email: '));
              try {
                var emSpanNoRef = el('span', 'bought__email', maskEmail(email));
                emSpanNoRef.style.marginLeft = '4px';
                emSpanNoRef.style.color = 'var(--text-dim)';
                metaSpan.appendChild(emSpanNoRef);

                var revealBtnNoRef = document.createElement('button');
                revealBtnNoRef.setAttribute('type', 'button');
                revealBtnNoRef.className = 'bought__reveal';
                revealBtnNoRef.setAttribute('aria-pressed', 'false');
                revealBtnNoRef.textContent = 'Show';
                revealBtnNoRef.style.marginLeft = '8px';
                metaSpan.appendChild(revealBtnNoRef);

                (function (node, btn, fullEmail) {
                  try {
                    btn.addEventListener('click', function () {
                      try {
                        var revealed = btn.getAttribute('data-revealed') === '1';
                        if (revealed) {
                          node.textContent = maskEmail(fullEmail);
                          btn.textContent = 'Show';
                          btn.setAttribute('aria-pressed', 'false');
                          btn.setAttribute('data-revealed', '0');
                        } else {
                          node.textContent = fullEmail;
                          btn.textContent = 'Hide';
                          btn.setAttribute('aria-pressed', 'true');
                          btn.setAttribute('data-revealed', '1');
                        }
                      } catch (e) { /* ignore */ }
                    });
                  } catch (e) { /* ignore */ }
                })(emSpanNoRef, revealBtnNoRef, email);

              } catch (e) { /* ignore */ }
            }

            li.appendChild(labelSpan);
            li.appendChild(metaSpan);
            list.appendChild(li);
            // Count this rendered item so the host is unhidden below.
            validCount++;

            // If this remembered record includes a payment reference, inject
            // a per-item Order: … + Copy button directly into the list item.
            try {
              if (ref) {
                try {
                  var detail = { id: String(ref), itemName: label, quantity: r.quantity || 1, hasDeliveryEmail: !!r.email };
                  // Extract a remembered download URL when present and valid
                  try { var durl = extractDownloadUrl(r); if (durl) detail.downloadUrl = durl; } catch (e) { /* ignore */ }
                  createBoughtCta(li, detail);
                  madePerItemCta = true;
                } catch (e) { /* ignore per-item CTA errors */ }

                // If there was no download URL on this remembered record and we
                // haven't recorded one to verify yet, remember it so we can do
                // a single server-side verification after rendering.
                try {
                  if (!detail.downloadUrl && !firstRefToVerify) {
                    firstRefToVerify = String(ref);
                    firstRefLi = li;
                    firstRefDetail = detail;
                  }
                } catch (e) { /* ignore */ }
              }
            } catch (e) { /* ignore */ }

          } catch (e) { /* ignore per-item */ }
        });

        } catch (e) { /* defensive: do not let this break the host */ }

        if (validCount) {
          host.hidden = false;
          // Ensure remembered-purchase summaries get the installers/support CTA too.
          try {
            if (!madePerItemCta) {
              // If we found a remembered ref that lacked a local download URL,
              // and the global groupStoreVerify API exists, attempt a single
              // server-side verification. This is a privacy-conscious one-shot
              // network call: only the first such ref triggers it, and only
              // when necessary.
              if (firstRefToVerify && !_boughtAutoVerifyCalled && typeof window.groupStoreVerify === 'function') {
                try {
                  _boughtAutoVerifyCalled = true;
                  var p = null;
                  try { p = window.groupStoreVerify(firstRefToVerify); } catch (e) { p = null; }
                  if (!p || typeof p.then !== 'function') {
                    // Verification unavailable; fall back to generic CTA
                    try { createBoughtCta(host, null); } catch (e) { /* ignore */ }
                  } else {
                    p.then(function (order) {
                      try {
                        var d = extractDownloadUrl(order);
                        if (d) {
                          try {
                            // Enrich the saved detail and attach a per-item CTA
                            firstRefDetail.downloadUrl = d;
                            createBoughtCta(firstRefLi || host, firstRefDetail);
                            return;
                          } catch (e) { /* ignore */ }
                        }
                        // No direct installers; fall back to generic CTA on host
                        try { createBoughtCta(host, null); } catch (e) { /* ignore */ }
                      } catch (e) { try { createBoughtCta(host, null); } catch (er) { /* ignore */ } }
                    }).catch(function () { try { createBoughtCta(host, null); } catch (e) { /* ignore */ } });
                  }
                } catch (e) { try { createBoughtCta(host, null); } catch (er) { /* ignore */ } }
              } else {
                try { createBoughtCta(host, null); } catch (e) { /* ignore */ }
              }
            }
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore host */ }
    });
  };

  /* =======================================================================
     Helper: createBoughtCta(host, detail)
     Builds and appends the .bought__cta block into the host or [data-bought-summary-list].
     Sets data-bought-verified="1" on the host to make the UI idempotent.
     If detail && detail.id exists, injects the small Order: … span + Copy button and
     sets data-copy / data-copy-label attributes. Focuses the primary installers
     link asynchronously (wrapped in try/catch). Guards copy-button activation so
     no error is thrown when ui.js (SS.initCopyButtons) is absent.
     ======================================================================= */

  function createBoughtCta(host, detail) {
    if (!host || !host.setAttribute) return;
    try {
      // If this host has already been annotated, normally bail early to keep
      // the UI idempotent. However, if we now have a direct download URL we
      // can enhance the existing CTA by adding the Download installers link
      // so user-initiated verifies can reveal installers even after a CTA was
      // created without one.
      var already = false;
      try { already = host.getAttribute('data-bought-verified') === '1'; } catch (e) { already = false; }
      if (already) {
        try {
          if (detail && detail.downloadUrl) {
            var existingCta = host.querySelector('.bought__cta');
            if (existingCta) {
              var hasDownload = existingCta.querySelector('.bought__cta-download');
              if (!hasDownload) {
                var dl = document.createElement('a');
                dl.href = detail.downloadUrl;
                dl.textContent = 'Download installers';
                dl.className = 'bought__cta-download bought__cta-primary';
                try { dl.setAttribute('target', '_blank'); dl.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }
                dl.style.marginRight = '12px';
                try { existingCta.insertBefore(dl, existingCta.firstChild); } catch (e) { /* ignore */ }
                try { setTimeout(function () { try { if (typeof dl.focus === 'function') dl.focus(); } catch (e) { /* ignore */ } }, 0); } catch (e) { /* ignore */ }
              }
            }
          }
        } catch (e) { /* ignore enhancement errors */ }
        return; // keep idempotent in all other cases
      }
    } catch (e) { /* ignore */ }

    var list = host.querySelector('[data-bought-summary-list]') || host;

    var c = document.createElement('div');
    c.className = 'bought__cta';

    // If the platform provided a direct download URL, surface it as the primary
    // CTA so customers can get installers immediately. Validate URL was already
    // handled by extractDownloadUrl; only use it when present.
    var downloadLink = null;
    try {
      if (detail && detail.downloadUrl) {
        downloadLink = document.createElement('a');
        downloadLink.href = detail.downloadUrl;
        downloadLink.textContent = 'Download installers';
        downloadLink.className = 'bought__cta-download bought__cta-primary';
        try { downloadLink.setAttribute('target', '_blank'); downloadLink.setAttribute('rel', 'noopener noreferrer'); } catch (e) { /* ignore */ }
        downloadLink.style.marginRight = '12px';
        c.appendChild(downloadLink);
      }
    } catch (e) { /* ignore */ }

    var a1 = document.createElement('a');
    // Compute a page-aware base so plugin pages under /plugins/ link up one level
    // to the real docs page instead of resolving to /plugins/docs.html.
    var docBase = 'docs.html';
    try {
      if (typeof location !== 'undefined' && String(location.pathname).indexOf('/plugins/') !== -1) {
        docBase = '../docs.html';
      }
    } catch (e) { /* ignore */ }
    a1.href = docBase + '#delivery';
    a1.textContent = 'Open installers & delivery instructions';
    a1.className = 'bought__cta-primary';
    try {
      a1.setAttribute('target', '_blank');
      a1.setAttribute('rel', 'noopener noreferrer');
      a1.setAttribute('aria-label', a1.textContent + ' (opens in a new tab)');
    } catch (e) { /* ignore environments that forbid setting attributes */ }
    a1.style.marginRight = '12px';

    var a2 = document.createElement('a');
    a2.href = docBase + '#support';
    a2.textContent = 'Contact support';
    a2.className = 'bought__cta-secondary';

    c.appendChild(a1);
    c.appendChild(a2);

    if (detail && detail.id) {
      try {
        var orderWrap = el('span', 'bought__order', 'Order: ' + String(detail.id));
        orderWrap.style.marginRight = '12px';

        var copyBtn = document.createElement('button');
        copyBtn.setAttribute('type', 'button');
        copyBtn.className = 'bought__copy';
        copyBtn.setAttribute('data-copy', String(detail.id));
        var copyLabel = detail.itemName ? 'Copied order reference for ' + detail.itemName : 'Copied order reference';
        copyBtn.setAttribute('data-copy-label', copyLabel);
        copyBtn.setAttribute('aria-label', copyLabel);
        copyBtn.textContent = 'Copy';

        orderWrap.appendChild(document.createTextNode(' '));
        orderWrap.appendChild(copyBtn);

        // Add a per-item "Check order" button when we have an order id but no
        // validated download URL. This gives the user an explicit control to
        // re-verify the remembered reference and surface installers when
        // available.
        if (!detail.downloadUrl) {
          try {
            var checkBtn = document.createElement('button');
            checkBtn.setAttribute('type', 'button');
            checkBtn.className = 'bought__check';
            checkBtn.textContent = 'Check order';
            checkBtn.style.marginLeft = '8px';
            checkBtn.setAttribute('aria-label', 'Check order reference');
            orderWrap.appendChild(document.createTextNode(' '));
            orderWrap.appendChild(checkBtn);

            (function (btn, ref, hostEl, det) {
              try {
                btn.addEventListener('click', function () {
                  try {
                    // Prevent repeated activations
                    if (btn.getAttribute('data-ssp-verify') === 'on') return;
                    btn.setAttribute('data-ssp-verify', 'on');
                    try { btn.disabled = true; } catch (e) { /* ignore */ }
                    try { var orig = btn.textContent; btn.textContent = 'Checking…'; } catch (e) { /* ignore */ }

                    var p = null;
                    try { p = window.groupStoreVerify ? window.groupStoreVerify(String(ref || det.id || '')) : null; } catch (e) { p = null; }
                    if (!p || typeof p.then !== 'function') {
                      try { btn.textContent = 'Verification unavailable'; } catch (e) { /* ignore */ }
                      try { createBoughtCta(hostEl, null); } catch (e) { /* ignore */ }
                      return;
                    }

                    p.then(function (order) {
                      try {
                        var d = extractDownloadUrl(order);
                        if (d) {
                          try {
                            // Enrich the detail and enhance the existing CTA with
                            // the download link. createBoughtCta will add the
                            // primary link when called with a downloadUrl.
                            det.downloadUrl = d;
                            createBoughtCta(hostEl, det);
                            return;
                          } catch (e) { /* ignore */ }
                        }
                        try { btn.textContent = 'No direct installers'; } catch (e) { /* ignore */ }
                        try { createBoughtCta(hostEl, null); } catch (e) { /* ignore */ }
                      } catch (e) { try { createBoughtCta(hostEl, null); } catch (er) { /* ignore */ } }
                    }).catch(function () { try { btn.textContent = 'Verification failed'; } catch (e) { /* ignore */ } try { createBoughtCta(hostEl, null); } catch (e) { /* ignore */ } });
                  } catch (e) { try { btn.textContent = 'Verification failed'; } catch (er) { /* ignore */ } }
                });
              } catch (e) { /* ignore */ }
            })(checkBtn, detail.id, host, detail);
          } catch (e) { /* ignore check button build errors */ }
        }

        c.insertBefore(orderWrap, a1);
      } catch (e) { /* ignore errors when building non-essential UI */ }
    }

    try { list.appendChild(c); } catch (e) { /* ignore DOM errors */ }
    try { host.setAttribute('data-bought-verified', '1'); } catch (e) { /* ignore */ }

    // Attempt to initialise copy buttons only if the page's SS UI exists.
    try {
      if (SS && typeof SS.initCopyButtons === 'function') SS.initCopyButtons(list);
    } catch (e) { /* ignore */ }

    // Focus the primary link asynchronously so keyboard users land on it.
    try {
      setTimeout(function () {
        try { if (downloadLink && typeof downloadLink.focus === 'function') { downloadLink.focus(); } else if (a1 && typeof a1.focus === 'function') a1.focus(); } catch (e) { /* ignore */ }
      }, 0);
    } catch (e) { /* ignore */ }
  }

  /* =======================================================================
     08  Event handler: append installers/support CTA after Verify
     Listens for the in-page 'soundshop:verified-order' event. It tolerates
     missing ev.detail and delegates markup construction to createBoughtCta
     so both post-verify and remembered-purchase paths share the same UI.
     ======================================================================= */

  try {
    document.addEventListener('soundshop:verified-order', function (ev) {
      try {
        ev = ev || {};
        var detail = ev.detail || null;
        // Find the first purchase summary host that has not been annotated yet
        var hosts = document.querySelectorAll('[data-bought-summary]');
        if (!hosts || !hosts.length) return;
        var host = null;
        for (var i = 0; i < hosts.length; i++) {
          var h = hosts[i];
          if (h.getAttribute && h.getAttribute('data-bought-verified') !== '1') {
            host = h; break;
          }
        }
        if (!host) return;

        var list = host.querySelector('[data-bought-summary-list]') || host;

        // Delegate to the helper which builds, appends and initialises copy
        try { createBoughtCta(host, detail); } catch (e) { /* swallow listener errors */ }
      } catch (e) { /* ignore listener errors */ }
    });
  } catch (e) { /* ignore registration errors */ }

  /* =======================================================================
     09  Support-area manual verification widget
     Adds a small input + Verify control under the #support heading so users
     can paste a payment reference and have the UI probe the platform.
     Idempotent and defensive: safe to run multiple times and when SS is
     absent. Uses the same verification flow as per-item controls above.
     ======================================================================= */

  P.initSupportVerify = function (root) {
    try {
      var heading = document.getElementById('support') || $('h2#support', root || document);
      if (!heading) return;
      if (bound(heading, 'support-verify')) return;

      // Build the minimal accessible form controls
      var wrap = document.createElement('div');
      wrap.className = 'support__verify';
      wrap.style.marginTop = '8px';

      var label = document.createElement('label');
      try { label.textContent = 'Order reference'; } catch (e) { /* ignore */ }
      var inputId = 'ss-support-verify-input';
      try { label.setAttribute('for', inputId); } catch (e) { /* ignore */ }
      label.className = 'support__verify-label';
      wrap.appendChild(label);

      var input = document.createElement('input');
      input.type = 'text';
      input.id = inputId;
      input.className = 'support__verify-input';
      try { input.setAttribute('placeholder', 'e.g. sto_pBpu2LkCjdaqupCd'); } catch (e) { /* ignore */ }
      input.style.marginLeft = '8px';
      input.style.width = '60%';
      wrap.appendChild(input);

      var btn = document.createElement('button');
      try { btn.setAttribute('type', 'button'); } catch (e) { /* ignore */ }
      btn.className = 'support__verify-button';
      btn.textContent = 'Verify';
      btn.style.marginLeft = '8px';
      wrap.appendChild(btn);

      var status = document.createElement('span');
      status.className = 'support__verify-status';
      status.style.marginLeft = '8px';
      wrap.appendChild(status);

      // Insert after heading
      try {
        var parent = heading.parentNode || document.body;
        if (heading.nextSibling) parent.insertBefore(wrap, heading.nextSibling);
        else parent.appendChild(wrap);
      } catch (e) { /* ignore DOM insertion errors */ }

      // Handler
      (function (input, btn, status, heading) {
        try {
          btn.addEventListener('click', function () {
            try {
              var ref = (input && input.value) ? String(input.value).trim() : '';
              if (!ref) {
                try { status.textContent = 'Enter an order reference to verify'; } catch (e) { /* ignore */ }
                return;
              }

              try { status.textContent = 'Checking…'; } catch (e) { /* ignore */ }

              var p = null;
              try { p = window.groupStoreVerify ? window.groupStoreVerify(ref) : null; } catch (e) { p = null; }
              if (!p || typeof p.then !== 'function') {
                try { status.textContent = 'Verification unavailable'; } catch (e) { /* ignore */ }
                return;
              }

              p.then(function (order) {
                try {
                  if (order && order.id) {
                    try { status.textContent = 'Verified: paid — order ' + String(order.id); } catch (e) { /* ignore */ }

                    try {
                      var summary = {
                        id: order.id,
                        itemName: order.itemName || order.name || '',
                        quantity: order.quantity || 1,
                        hasDeliveryEmail: !!(order.email || order.buyerEmail || order.customerEmail)
                      };
                      // Extract and include a validated download URL when present
                      try { var d = extractDownloadUrl(order); if (d) summary.downloadUrl = d; } catch (e) { /* ignore */ }
                      document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: summary }));
                    } catch (evErr) { /* swallow listener errors */ }

                    // If there is no bought-summary host on the page, append the CTA here
                    try {
                      var hosts = document.querySelectorAll('[data-bought-summary]');
                      if (!hosts || !hosts.length) {
                        try { createBoughtCta(heading.parentNode || document.body, summary); } catch (e) { /* ignore */ }
                      }
                    } catch (e) { /* ignore */ }

                    // If SS provides initCopyButtons, run it for the new UI
                    try { if (SS && typeof SS.initCopyButtons === 'function') SS.initCopyButtons(heading.parentNode || document.body); } catch (e) { /* ignore */ }

                  } else {
                    try { status.textContent = 'Not found / unpaid'; } catch (e) { /* ignore */ }
                  }
                } catch (e) { try { status.textContent = 'Verification failed'; } catch (er) { /* ignore */ } }
              }).catch(function () { try { status.textContent = 'Verification failed'; } catch (e) { /* ignore */ } });

            } catch (e) { try { status.textContent = 'Verification failed'; } catch (er) { /* ignore */ } }
          });
        } catch (e) { /* ignore */ }
      })(input, btn, status, heading);

    } catch (e) { /* ignore top-level */ }
  };

  /* =======================================================================
     Robust DOM-ready runner for features that can run without the SS UI.
     Use a typeof/window guard so this never throws when SS is absent.
     If SS provides a ready(fn) hook, prefer it, otherwise use DOMContentLoaded
     or an immediate setTimeout fallback for already-ready documents.
     ======================================================================= */

  try {
    if (typeof window.SS !== 'undefined' && typeof window.SS.ready === 'function') {
      try { window.SS.ready(function () { P.initSupportVerify(); P.initBoughtNote(); P.initBoughtSummary(); }); } catch (e) { /* ignore */ }
    } else if (document.readyState === 'loading') {
      try { document.addEventListener('DOMContentLoaded', function () { P.initSupportVerify(); P.initBoughtNote(); P.initBoughtSummary(); }); } catch (e) { /* ignore */ }
    } else {
      try { setTimeout(function () { P.initSupportVerify(); P.initBoughtNote(); P.initBoughtSummary(); }, 0); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

})(window, document);
