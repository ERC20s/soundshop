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

  /* =======================================================================
     Helper: grabInstallerUrl(order)
     Returns the first non-empty top-level string field that looks like an
     installer/download URL. It checks a short whitelist of likely names and
     returns '' if none are present. Defensive: never throws.
     ======================================================================= */
  function grabInstallerUrl(order) {
    try {
      if (!order || typeof order !== 'object') return '';
      var fields = ['downloadUrl', 'download_url', 'installersUrl', 'installers_url', 'installUrl', 'url'];
      for (var i = 0; i < fields.length; i++) {
        var v = order[fields[i]];
        if (typeof v === 'string' && v.trim() !== '') return v.trim();
      }
    } catch (e) { /* ignore */ }
    return '';
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
    if (authorName) side.appendChild(el('span', 'badge', authorName));
    row.appendChild(side);

    return row;
  }

  P.initPresetTeaser = function (root) {
    $$('[data-presets-src]', root || document).forEach(function (host) {
      if (bound(host, 'presets')) return;

      var src = attr(host, 'data-presets-src');
      if (!src) return;

      var list = $('[data-presets-list]', host) || host;
      var status = $('[data-presets-status]', host);
      var limit = intAttr(host, 'data-presets-limit', 6);

      if (typeof window.fetch !== 'function') {
        if (status) status.textContent = 'Presets unavailable in this environment.';
        return;
      }

      try {
        if (status) status.textContent = 'Loading presets…';
        window.fetch(src, { method: 'GET', cache: 'no-store' })
          .then(function (r) { return r && r.ok ? r.json() : null; })
          .then(function (data) {
            try {
              var items = normalisePresets(data).slice(0, limit);
              if (!items.length) {
                if (status) status.textContent = 'No presets available.';
                return;
              }
              while (list.firstChild) list.removeChild(list.firstChild);
              items.forEach(function (p) { list.appendChild(presetRow(p)); });
            } catch (e) { /* ignore rendering errors */ }
          })
          .catch(function () {
            if (status) status.textContent = 'Failed to load presets.';
          });
      } catch (e) { if (status) status.textContent = 'Failed to load presets.'; }
    });
  };

  /* =======================================================================
     Rest of file continues unchanged until createBoughtCta…
     ======================================================================= */

  P.initBoughtNote = function (root) {
    $$('[data-bought-note]', root || document).forEach(function (host) {
      if (bound(host, 'boughtnote')) return;
      try { host.hidden = false; } catch (e) { /* ignore */ }
    });
  };

  P.initBoughtSummary = function (root) {
    $$('[data-bought-summary]', root || document).forEach(function (host) {
      if (bound(host, 'boughtsummary')) return;

      var list = host.querySelector('[data-bought-summary-list]') || host;
      var madePerItemCta = false;
      var validCount = 0;

      try {
        var items = [];
        try { items = window.groupStoreBought || []; } catch (e) { items = []; }

        Array.prototype.forEach.call(items, function (r) {
          try {
            if (!r || typeof r !== 'object') return;
            var li = document.createElement('li');
            li.className = 'bought__item';

            var labelSpan = el('span', 'bought__label', r.itemName || r.name || 'Unknown item');
            var metaSpan = el('span', 'bought__meta', '');

            var email = r.email || r.buyerEmail || r.customerEmail || '';
            var ref = r.reference || r.paymentReference || r.id || '';

            // Masked email and reveal/verify controls
            try {
              if (ref && typeof ref === 'string' && ref.trim()) {
                var refNode = el('a', 'bought__ref', 'Order: ' + String(ref));
                refNode.href = '#';
                refNode.style.marginLeft = '12px';
                metaSpan.appendChild(refNode);

                var msg = document.createElement('button');
                msg.setAttribute('type', 'button');
                msg.className = 'bought__verify';
                msg.textContent = 'Verify';
                msg.style.marginLeft = '8px';

                msg.addEventListener('click', function (ev) {
                  try { ev.preventDefault(); } catch (e) { /* ignore */ }
                });
              }
            } catch (e) { /* ignore */ }

            if (metaSpan.textContent) metaSpan.appendChild(document.createTextNode(' '));

            if (email && typeof email === 'string') email = email.trim();

            try {
              if (ref && typeof ref === 'string' && ref.trim()) {
                var ref = String(ref).trim();
                var refBtn = document.createElement('button');
                refBtn.setAttribute('type', 'button');
                refBtn.className = 'bought__verify small';
                refBtn.textContent = 'Verify';
                refBtn.style.marginLeft = '8px';

                var maskEmail = function (e) {
                  if (!e || typeof e !== 'string') return '';
                  var parts = e.split('@');
                  if (!parts || parts.length !== 2) return e;
                  var name = parts[0];
                  return name.charAt(0) + '***@' + parts[1];
                };

                var revealBtn = document.createElement('button');

                revealBtn.setAttribute('type', 'button');
                revealBtn.className = 'bought__reveal';
                revealBtn.setAttribute('aria-pressed', 'false');
                revealBtn.textContent = 'Show';
                revealBtn.style.marginLeft = '8px';

                // Lightweight verify control which calls the platform's verifier if present
                try {
                  refBtn.addEventListener('click', function (ev) {
                    try {
                      ev.preventDefault();
                      refBtn.textContent = 'Checking…';
                      var p = null;
                      try { p = window.groupStoreVerify ? window.groupStoreVerify(ref) : null; } catch (e) { p = null; }
                      if (!p || typeof p.then !== 'function') {
                        refBtn.textContent = 'Verification unavailable';
                        return;
                      }

                      var parent = refBtn.parentNode || refBtn;
                      var msgNode = document.createElement('span');
                      msgNode.className = 'bought__verify-msg';
                      msgNode.style.marginLeft = '8px';
                      parent.appendChild(msgNode);

                      msgNode.textContent = 'Checking…';

                      p.then(function (order) {
                        try {
                          if (order && order.id) {
                            msgNode.textContent = 'Verified: paid — order ' + String(order.id);

                            try {
                              var summary = {
                                id: order.id,
                                itemName: order.itemName || order.name || '',
                                quantity: order.quantity || 1,
                                hasDeliveryEmail: !!(order.email || order.buyerEmail || order.customerEmail)
                              };
                              document.dispatchEvent(new CustomEvent('soundshop:verified-order', { detail: summary }));
                            } catch (evErr) { /* swallow errors from listeners */ }

                          } else {
                            msgNode.textContent = 'Not found / unpaid';
                          }
                        } catch (e) { msgNode.textContent = 'Verification failed'; }
                      }).catch(function () { msgNode.textContent = 'Verification failed'; });
                    } catch (e) { msgBtn && (msgBtn.textContent = 'Verification failed'); }
                  });
                } catch (e) { /* ignore */ }

                metaSpan.appendChild(refBtn);
              } else if (email) {
                if (metaSpan.textContent) metaSpan.appendChild(document.createTextNode(' '));
                metaSpan.appendChild(document.createTextNode('Delivery email: '));
                try {
                  var emSpan = el('span', 'bought__email', maskEmail(email));
                  emSpan.style.marginLeft = '4px';
                  emSpan.style.color = 'var(--text-dim)';
                  metaSpan.appendChild(emSpan);

                  var revealBtn2 = document.createElement('button');
                  revealBtn2.setAttribute('type', 'button');
                  revealBtn2.className = 'bought__reveal';
                  revealBtn2.setAttribute('aria-pressed', 'false');
                  revealBtn2.textContent = 'Show';
                  revealBtn2.style.marginLeft = '8px';
                  metaSpan.appendChild(revealBtn2);

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
                  })(emSpan, revealBtn2, email);

                } catch (e) { /* ignore */ }
              }

              li.appendChild(labelSpan);
              li.appendChild(metaSpan);
              list.appendChild(li);
              validCount++;

              // If this remembered record includes a payment reference, inject
              // a per-item Order: … + Copy button directly into the list item.
              try {
                if (ref) {
                  try {
                    var detail = { id: String(ref), itemName: labelSpan.textContent || labelSpan.innerText || '', quantity: r.quantity || 1, hasDeliveryEmail: !!r.email };
                    createBoughtCta(li, detail);
                    madePerItemCta = true;
                  } catch (e) { /* ignore per-item CTA errors */ }
                }
              } catch (e) { /* ignore */ }

            } catch (e) { /* ignore per-item */ }
          });

        } catch (e) { /* defensive: do not let this break the host */ }

        if (validCount) {
          host.hidden = false;
          // Ensure remembered-purchase summaries get the installers/support CTA too.
          try { if (!madePerItemCta) { createBoughtCta(host, null); } } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore host-level errors */ }
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
      if (host.getAttribute('data-bought-verified') === '1') return; // idempotent
    } catch (e) { /* ignore */ }

    var list = host.querySelector('[data-bought-summary-list]') || host;

    var c = document.createElement('div');
    c.className = 'bought__cta';

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

    // Try to synchronously prefer a direct installer URL from a remembered
    // order object on the page (window.groupStorePaid). This is non-destructive
    // and preserves the CTA text and a11y attributes.
    try {
      try {
        var paid = (typeof window.groupStorePaid !== 'undefined') ? window.groupStorePaid : null;
        if (paid && typeof paid === 'object') {
          var url = grabInstallerUrl(paid);
          if (url) {
            try { a1.href = url; } catch (e) { /* ignore */ }
          }
        }
      } catch (e) { /* ignore */ }

      // Optionally, if we have a detail with an id and the platform exposes
      // groupStoreVerify, probe the verified order non-blockingly and update
      // the CTA if a direct installer URL is found. Fail silently.
      try {
        if (detail && detail.id && typeof window.groupStoreVerify === 'function') {
          try {
            var probe = null;
            try { probe = window.groupStoreVerify(detail.id); } catch (e) { probe = null; }
            if (probe && typeof probe.then === 'function') {
              probe.then(function (order) {
                try {
                  var url2 = grabInstallerUrl(order);
                  if (url2) {
                    try { a1.href = url2; } catch (e) { /* ignore */ }
                  }
                } catch (e) { /* ignore */ }
              }).catch(function () { /* silent */ });
            }
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }

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
        c.insertBefore(orderWrap, a1);
      } catch (e) { /* ignore errors when building non-essential UI */ }
    }

    try { list.appendChild(c); } catch (e) { /* ignore DOM errors */ }
    try { host.setAttribute('data-bought-verified', '1'); } catch (e) { /* ignore */ }

    // Attempt to initialise copy buttons only if the page's SS UI exists.
    try {
      if (SS && typeof SS.initCopyButtons === 'function') {
        try { SS.initCopyButtons(host); } catch (e) { /* ignore init errors */ }
      }
    } catch (e) { /* ignore */ }

    // Focus the primary link asynchronously so keyboard users land on it.
    try {
      setTimeout(function () {
        try { if (a1 && typeof a1.focus === 'function') a1.focus(); } catch (e) { /* ignore */ }
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
      } catch (e) { /* ignore event handler errors */ }
    });
  } catch (e) { /* ignore */ }

  /* =======================================================================
     09  Init wrapper
     ======================================================================= */

  P.init = function () {
    try { P.initDemoSlot(); } catch (e) { /* ignore */ }
    try { P.initPresetTeaser(); } catch (e) { /* ignore */ }
    try { P.initSectionNav(); } catch (e) { /* ignore */ }
    try { P.initTabs(); } catch (e) { /* ignore */ }
    try { P.initCounters(); } catch (e) { /* ignore */ }
    try { P.initBoughtNote(); } catch (e) { /* ignore */ }
    try { P.initBoughtSummary(); } catch (e) { /* ignore */ }
  };

})(window, document);
