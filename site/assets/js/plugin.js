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

  /* =======================================================================
     03  Minimal section nav, tabs and counters (lightweight, defensive)
     These are intentionally small so the file has stable behaviour without
     depending on other scripts. They are idempotent and tolerant of missing
     nodes.
     ======================================================================= */

  P.initSectionNav = function (root) {
    // No-op placeholder that marks any [data-section-nav] as bound.
    $$('[data-section-nav]', root || document).forEach(function (n) { bound(n, 'section-nav'); });
  };

  P.initTabs = function (root) {
    // Lightweight ARIA tabs are omitted when the host element is missing.
    $$('[data-tabs]', root || document).forEach(function (host) { bound(host, 'tabs'); });
  };

  P.initCounters = function (root) {
    $$('[data-count-to]', root || document).forEach(function (n) { bound(n, 'counter'); });
  };

  P.initBoughtNote = function (root) {
    $$('[data-bought-note]', root || document).forEach(function (n) { bound(n, 'bought-note'); });
  };

  P.initBoughtSummary = function (root) {
    $$('[data-bought-summary]', root || document).forEach(function (host) {
      if (bound(host, 'bought-summary')) return;

      var key = attr(host, 'data-bought-key') || 'soundshop-bought';
      var raw = '';
      try { raw = window.localStorage && window.localStorage.getItem && window.localStorage.getItem(key) || ''; } catch (e) { raw = ''; }

      var list = host.querySelector('[data-bought-list]') || host;
      var validCount = 0;

      try {
        var arr = [];
        try { arr = raw ? JSON.parse(raw) : []; } catch (e) { arr = []; }
        if (!Array.isArray(arr)) arr = [];

        arr.forEach(function (it) {
          try {
            if (!it || typeof it !== 'object') return;
            var li = document.createElement('li');
            var labelSpan = document.createElement('span');
            labelSpan.className = 'bought__item';
            var metaSpan = document.createElement('span');
            metaSpan.className = 'bought__meta';

            var label = it.label || it.name || it.product || it.title || '';
            labelSpan.textContent = label;

            var email = it.email || it.deliveryEmail || '';
            var emSpan = document.createElement('span');
            emSpan.className = 'bought__email';
            emSpan.textContent = maskEmail(email);

            var revealBtn = document.createElement('button');
            revealBtn.setAttribute('type', 'button');
            revealBtn.className = 'bought__reveal';
            revealBtn.setAttribute('aria-pressed', 'false');
            revealBtn.textContent = 'Show';
            revealBtn.style.marginLeft = '8px';
            metaSpan.appendChild(revealBtn);

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

          li.appendChild(labelSpan);
          li.appendChild(metaSpan);
          list.appendChild(li);
          validCount++;
        });

      } catch (e) { /* ignore per-item */ }

      if (validCount) {
        host.hidden = false;
      }
    });
  };

  /* =======================================================================
     08  Event handler: append installers/support CTA after Verify
     Listens for the in-page 'soundshop:verified-order' event. It tolerates
     missing ev.detail and does not expose any private data. The injected
     UI is idempotent per host via data-bought-verified="1".
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

        // Prefer appending to an explicit list container when present
        var list = host.querySelector('[data-bought-list]') || host;

        var c = document.createElement('div');
        c.className = 'bought__cta';

        var a1 = document.createElement('a');
        a1.href = 'docs.html#delivery';
        a1.textContent = 'Open installers & delivery instructions';
        a1.className = 'bought__cta-primary';
        a1.style.marginRight = '12px';
        // Make the primary installers link open safely in a new tab and be explicit
        // about that to assistive tech. Remove role="button" for correct semantics.
        try {
          a1.setAttribute('target', '_blank');
          a1.setAttribute('rel', 'noopener noreferrer');
          a1.setAttribute('aria-label', a1.textContent + ' (opens in a new tab)');
        } catch (e) { /* ignore attribute failures in restricted environments */ }

        var a2 = document.createElement('a');
        a2.href = 'docs.html#support';
        a2.textContent = 'Contact support';
        a2.className = 'bought__cta-secondary';
        // Remove role="button" so the link is a real link; do not add a target.

        c.appendChild(a1);
        c.appendChild(a2);

        // Append once and mark the host so this handler is idempotent
        try { list.appendChild(c); } catch (e) { /* ignore DOM errors */ }
        try { host.setAttribute('data-bought-verified', '1'); } catch (e) { /* ignore */ }

        // Attempt to focus the primary anchor to aid keyboard follow-through.
        // Wrap in setTimeout + try/catch so restricted environments or blockers
        // do not cause uncaught exceptions.
        try {
          setTimeout(function () {
            try { if (a1 && a1.focus) a1.focus(); } catch (e) { /* ignore focus errors */ }
          }, 0);
        } catch (e) { /* ignore setTimeout errors */ }

      } catch (e) { /* swallow listener errors */ }
    });
  } catch (e) { /* ignore if addEventListener not available */ }

  // Auto-run on load
  P.init = function () {
    P.initDemoSlot();
    P.initPresetTeaser();
    P.initSectionNav();
    P.initTabs();
    P.initCounters();
    P.initBoughtNote();
    P.initBoughtSummary();
  };

  // Run when DOM is ready
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(P.init, 0);
  } else {
    document.addEventListener('DOMContentLoaded', P.init);
  }

})(window, document);
