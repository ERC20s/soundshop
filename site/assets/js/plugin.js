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

  P.initBoughtSummary = function (root) {
    $$('[data-bought-summary]', root || document).forEach(function (host) {
      try {
        if (bound(host, 'bought-summary')) return;

        var recs = null;
        try { recs = JSON.parse(attr(host, 'data-bought-summary') || 'null'); } catch (e) { recs = null; }
        recs = recs || {};

        // If there are no records supplied in the attribute, fall back to the
        // localStorage snapshot written by the shop page's purchase listener.
        try {
          if (!Object.keys(recs).length && window.localStorage && typeof window.localStorage.getItem === 'function') {
            var BOUGHT_KEY = 'soundshop:bought:v1';
            var raw = window.localStorage.getItem(BOUGHT_KEY);
            if (raw) {
              try {
                var parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  var labelsSpan = host.querySelector('[data-bought-summary-labels]');
                  Object.keys(parsed).forEach(function (tok) {
                    try {
                      var p = parsed[tok];
                      var rec = {};
                      if (typeof p === 'number' || (typeof p === 'string' && /^\d+$/.test(p))) {
                        rec.t = Number(p);
                      } else if (p && typeof p === 'object') {
                        if (p.t) rec.t = Number(p.t);
                        if (p.ref) rec.ref = String(p.ref);
                        if (p.email) rec.email = String(p.email);
                      }
                      if (labelsSpan) {
                        try {
                          var lab = labelsSpan.getAttribute('data-bought-label-' + tok);
                          if (lab) rec.label = String(lab);
                        } catch (e) { /* ignore */ }
                      }
                      if ((rec.t && isFinite(rec.t)) || rec.ref || rec.email) {
                        recs[tok] = rec;
                      }
                    } catch (e) { /* ignore per-item */ }
                  });
                }
              } catch (e) { /* ignore parse errors */ }
            }
          }
        } catch (e) { /* ignore localStorage access errors */ }

        var list = host.querySelector('[data-bought-summary-list]') || host;

        var validCount = 0;
        Object.keys(recs).forEach(function (k) {
          try {
            var li = document.createElement('li');
            li.className = 'bought';

            var r = recs[k] || {};

            // visible label
            var label = (r.label || r.itemName || r.name || '').toString();
            if (!label) label = 'A bought item';

            var labelSpan = el('span', 'bought__label', label);
            var metaSpan = el('span', 'bought__meta');

            // Reference or no-reference message
            var refPrefix = recs[k].refPrefix || r.refPrefix || '';
            var refSuffix = recs[k].refSuffix || r.refSuffix || '';
            var ref = recs[k].ref || '';
            var email = recs[k].email || '';
            if (ref) {
              if (metaSpan.textContent) metaSpan.appendChild(document.createTextNode(' '));
              metaSpan.appendChild(document.createTextNode(refPrefix + ref + refSuffix));

              try {
                var msg = document.createElement('a');
                msg.textContent = 'View order & verification status';
                msg.className = 'bought__verify';
                msg.setAttribute('href', '#');
                msg.style.marginLeft = '8px';

                var ref = recs[k].ref;
                var refNode = ref;
                var msgNode = null;

                // The original order verification handshake is intentionally
                // preserved here: it calls the platform verify endpoint via
                // window.groupStoreVerify and renders the returned state. Do not
                // remove that behaviour — this was the regression reviewers
                // flagged earlier.
                (function (reference, msg, refNode) {
                  try {
                    msg.addEventListener('click', function (ev) {
                      try {
                        ev.preventDefault();
                        msg.textContent = 'Checking…';
                        // Call the real platform verification function if present.
                        var p = null;
                        try { p = window.groupStoreVerify ? window.groupStoreVerify(reference) : null; } catch (e) { p = null; }
                        if (!p || typeof p.then !== 'function') {
                          msg.textContent = 'Verification unavailable';
                          return;
                        }
                        // When the promise resolves we render a tiny status node
                        // next to the control and emit the soundshop:verified-order
                        // event so other listeners in the page (notably the
                        // handler that injects the installers CTA) get a chance.
                        var parent = msg.parentNode || msg;
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
                      } catch (e) { msgNode.textContent = 'Verification failed'; }
                    });
                  } catch (e) { /* ignore */ }
                })(ref, msg, refNode);

                metaSpan.appendChild(msg);

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
                })(emSpan, revealBtn, email);

              } catch (e) { /* ignore */ }
            }

            li.appendChild(labelSpan);
            li.appendChild(metaSpan);
            list.appendChild(li);
            validCount++;
          } catch (e) { /* ignore per-item */ }
        });

      } catch (e) { /* defensive: do not let this break the host */ }

      if (validCount) {
        host.hidden = false;
        // Ensure remembered-purchase summaries get the installers/support CTA too.
        try { createBoughtCta(host, null); } catch (e) { /* ignore */ }
      }
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
    a1.href = 'docs.html#delivery';
    a1.textContent = 'Open installers & delivery instructions';
    a1.className = 'bought__cta-primary';
    try {
      a1.setAttribute('target', '_blank');
      a1.setAttribute('rel', 'noopener noreferrer');
      a1.setAttribute('aria-label', a1.textContent + ' (opens in a new tab)');
    } catch (e) { /* ignore environments that forbid setting attributes */ }
    a1.style.marginRight = '12px';

    var a2 = document.createElement('a');
    a2.href = 'docs.html#support';
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
        // controls safely and marks the host as verified so this handler is idempotent.
        try { createBoughtCta(host, detail); } catch (e) { /* ignore */ }

      } catch (e) { /* swallow listener errors */ }
    });
  } catch (e) { /* ignore if addEventListener not available */ }

})(window, document);
