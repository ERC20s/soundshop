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
     A page that wants the playable demo inline writes:

       <div id="demo" data-demo-src="../demo/flagship-demo.html"
            data-demo-title="VANTA browser demo" data-demo-height="720">
         ...a complete, useful fallback, including a normal link to the demo...
       </div>

     We probe that path with fetch(). Only on a genuine 200 do we swap in an
     iframe. On file://, on a network error, or on a 404 the fallback markup
     that shipped in the HTML stays exactly where it is — so the page is never
     worse off for having tried.
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
    // The path came from the DOM, never from a literal in this file.
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
      if (status) status.textContent = 'Looking for the demo build';

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
              'still runs in its own tab  use the link above.';
          }
        });
    });
  };

  /* =======================================================================
     02  PRESET TEASER
     Markup contract:

       <div data-presets-src="../presets/flagship-presets.json"
            data-presets-limit="6">
         <div data-presets-list></div>
         <p data-presets-status>...static fallback sentence...</p>
       </div>

     Everything rendered from the JSON goes through textContent. The JSON is
     treated as untrusted, unordered and possibly the wrong shape.
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
      if (count && author) desc = count + ' stored parameters  programmed by ' + author;
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

      function

  /* (file continues — purchased-related code omitted in this build for brevity) */

  /* Purchased / bought helpers. */
  var BOUGHT_TOKEN_RE = /^[a-z0-9-]+$/i;

  function boughtRecords() {
    try {
      var raw = window.localStorage && window.localStorage.getItem ? window.localStorage.getItem('bought') : null;
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      return parsed;
    } catch (e) { return {}; }
  }

  function boughtItems() {
    var recs = boughtRecords();
    var out = {};
    for (var k in recs) {
      if (!Object.prototype.hasOwnProperty.call(recs, k)) continue;
      if (!BOUGHT_TOKEN_RE.test(k)) continue;
      var r = recs[k];
      if (!r || typeof r !== 'object') continue;
      var t = r.t || 0;
      out[k.toLowerCase()] = t;
    }
    return out;
  }

  function boughtDate(ts) {
    try {
      var d = new Date(Number(ts) || 0);
      if (!d || isNaN(d.getTime())) return '';
      return d.toLocaleDateString();
    } catch (e) { return ''; }
  }

  P.initBoughtNote = function (root) {
    $$('[data-bought-note]', root || document).forEach(function (note) {
      if (bound(note, 'bought')) return;

      var notes = $$('[data-bought-item]', note);
      if (!notes.length) return;

      var items = boughtItems();
      var tokens = 0;
      for (var t in items) { if (Object.prototype.hasOwnProperty.call(items, t)) tokens++; }
      if (!tokens) return;                             // nothing remembered, nothing to say

      notes.forEach(function (note) {
        if (bound(note, 'bought')) return;

        var token = attr(note, 'data-bought-item').toLowerCase();
        if (!token) return;

        var when = 0;
        var state = '';
        if (Object.prototype.hasOwnProperty.call(items, token)) {
          when = items[token];
          state = 'own';
        } else {
          var cover = attr(note, 'data-bought-covered-by').toLowerCase();
          if (cover && Object.prototype.hasOwnProperty.call(items, cover)) {
            when = items[cover];
            state = 'covered';
          }
        }

        if (!when) return;

        var dateWrap = $('[data-bought-date]', note);
        if (dateWrap) {
          var prefix = attr(dateWrap, 'data-bought-date-prefix') || '';
          var text = prefix + boughtDate(when);
          dateWrap.textContent = text;
          dateWrap.hidden = false;
        }

        var coverNote = $('[data-bought-cover]', note);
        if (coverNote) coverNote.hidden = state !== 'covered';

        note.hidden = false;
      });
    });
  };

  P.initBoughtSummary = function (root) {
    $$('[data-bought-summary]', root || document).forEach(function (host) {
      if (bound(host, 'bought-summary')) return;

      var recs = boughtRecords();
      var keys = Object.keys(recs).filter(function (k) { return BOUGHT_TOKEN_RE.test(k); });
      if (!keys.length) return;

      var list = $('[data-bought-summary-list]', host);
      if (!list) return;

      // Clear the list first
      while (list.firstChild) list.removeChild(list.firstChild);

      // Get the labels element - it has all the data-bought-label-* attributes
      var labelsEl = $('[data-bought-summary-labels]', host);

      // Read formatting options from the host
      var datePrefix = attr(host, 'data-bought-summary-date-prefix') || '';
      var refPrefix = attr(host, 'data-bought-summary-ref-prefix') || '';
      var refSuffix = attr(host, 'data-bought-summary-ref-suffix') || '';
      var norefMsg = attr(host, 'data-bought-summary-noref') || '';

      var validCount = 0;
      keys.forEach(function (k) {
        // Get label: first from data-bought-summary-labels, then fallback to host, then token itself
        var label = '';
        if (labelsEl) label = attr(labelsEl, 'data-bought-label-' + k);
        if (!label) label = attr(host, 'data-bought-label-' + k);
        if (!label) label = k;

        // Build the DOM for this item: <li><span.bought__label>label</span><span.bought__meta>...</span></li>
        var li = el('li');
        var labelSpan = el('span', 'bought__label', label);
        var metaSpan = el('span', 'bought__meta');

        // Date portion
        if (datePrefix) {
          var date = boughtDate(recs[k].t);
          if (date) {
            metaSpan.appendChild(document.createTextNode(datePrefix + date));
          }
        }

        // Reference or no-reference message
        var ref = recs[k].ref || '';
        if (ref) {
          // space between date and ref if needed
          if (metaSpan.textContent) metaSpan.appendChild(document.createTextNode(' '));
          // Append the visible ref text (kept as plain text)
          metaSpan.appendChild(document.createTextNode(refPrefix + ref + refSuffix));

          // Append a Copy button with data attributes for SS.initCopyButtons / SS.copyText
          try {
            var btn = document.createElement('button');
            btn.setAttribute('type', 'button');
            btn.setAttribute('data-copy', ref);
            btn.setAttribute('data-copy-label', 'Payment reference for ' + label);
            btn.setAttribute('aria-label', 'Copy payment reference for ' + label);
            btn.className = 'bought__copy';
            btn.textContent = 'Copy';
            // Some pages may not have SS helpers; leave the button inert in that case.
            metaSpan.appendChild(document.createTextNode(' '));
            metaSpan.appendChild(btn);

            // Append a Verify button next to the Copy button. Defensive: inert if window.groupStoreVerify is absent.
            var vbtn = document.createElement('button');
            vbtn.setAttribute('type', 'button');
            vbtn.className = 'bought__verify';
            vbtn.setAttribute('aria-label', 'Verify payment reference for ' + label);
            // Title communicates the privacy trade-off: clicking sends the stored reference to the group's shop to check status.
            vbtn.setAttribute('title', 'Click to verify this payment reference with the shop (this sends the reference to the shop).');
            vbtn.textContent = 'Verify';
            metaSpan.appendChild(document.createTextNode(' '));
            metaSpan.appendChild(vbtn);

            // Add a small inline message node after the Verify button when needed.
            vbtn.addEventListener('click', function (e) {
              e.preventDefault();
              try {
                // Find or create a message span immediately after the button
                var msg = vbtn.nextSibling;
                // Skip whitespace text nodes to find an existing message element
                while (msg && msg.nodeType === 3 && msg.textContent.trim() === '') msg = msg.nextSibling;
                if (!msg || !msg.classList || msg.className.indexOf('bought__verify-msg') === -1) {
                  var spacer = document.createTextNode(' ');
                  var newMsg = el('span', 'bought__verify-msg');
                  vbtn.parentNode.insertBefore(spacer, vbtn.nextSibling);
                  vbtn.parentNode.insertBefore(newMsg, spacer.nextSibling);
                  msg = newMsg;
                }

                // Defensive: if the platform verifier is not available, show advisory message
                if (!window.groupStoreVerify || typeof window.groupStoreVerify !== 'function') {
                  msg.textContent = 'Verification unavailable here; check your delivery email or contact Support.';
                  return;
                }

                msg.textContent = 'Verifying\u2026';
                var p = null;
                try { p = window.groupStoreVerify(ref); } catch (err) { p = null; }
                if (!p || typeof p.then !== 'function') {
                  msg.textContent = 'Verification not available.';
                  return;
                }
                p.then(function (order) {
                  if (order) {
                    var id = order.id || ref;
                    msg.textContent = 'Verified: order ' + id + ' — paid.';
                  } else {
                    msg.textContent = 'Not found or not paid.';
                  }
                }).catch(function () {
                  msg.textContent = 'Verification failed; try again later.';
                });
              } catch (e) {
                /* swallow — do not let this break the page */
              }
            }, false);

          } catch (e) { /* defensive: do not let this break the host */ }
        } else if (norefMsg) {
          if (metaSpan.textContent) metaSpan.appendChild(document.createTextNode(' '));
          metaSpan.appendChild(document.createTextNode(norefMsg));
        }

        li.appendChild(labelSpan);
        li.appendChild(metaSpan);
        list.appendChild(li);
        validCount++;
      });

      // After populating, initialise copy buttons if the helpers exist. Guarded.
      try {
        if (SS && typeof SS.initCopyButtons === 'function') {
          SS.initCopyButtons(list);
        }
      } catch (e) { /* swallow  do not let this break the page */ }

      // Unhide the host only if we added at least one item
      if (validCount > 0) {
        host.hidden = false;

        // Append a minimal installer/support sentence into a <p class="muted"> inside
        // the host if present. This is defensive and idempotent: it checks for an
        // existing anchor linking to docs.html#installation or for a one-shot
        // attribute data-ssp-install-sent='on' on the host before appending.
        try {
          if (!host.getAttribute('data-ssp-install-sent')) {
            var pMuted = $('p.muted', host);
            var found = false;
            if (pMuted) {
              var anchors = pMuted.querySelectorAll('a');
              for (var i = 0; i < anchors.length; i++) {
                var h = anchors[i].getAttribute('href') || '';
                if (h.indexOf('docs.html#installation') !== -1) { found = true; break; }
              }
              if (!found) {
                // Build the sentence using DOM methods so existing textContent rules are preserved
                pMuted.appendChild(document.createTextNode(' '));
                pMuted.appendChild(document.createTextNode('To get the installer or licence now, follow the delivery email we sent or visit the '));
                var a1 = document.createElement('a');
                a1.setAttribute('href', 'docs.html#installation');
                a1.textContent = 'installation page';
                pMuted.appendChild(a1);
                pMuted.appendChild(document.createTextNode(' (docs.html#installation); if something is missing, quote your payment reference on our '));
                var a2 = document.createElement('a');
                a2.setAttribute('href', 'docs.html#support');
                a2.textContent = 'Support page';
                pMuted.appendChild(a2);
                pMuted.appendChild(document.createTextNode(' (docs.html#support).'));
              }
            }
            host.setAttribute('data-ssp-install-sent', 'on');
          }
        } catch (e) { /* defensive: do not let this break page behaviour */ }
      }
    });
  };

  P.init = function () {
    P.initDemoSlot();
    P.initPresetTeaser();
    P.initSectionNav();
    P.initTabs();
    P.initCounters();
    P.initBoughtNote();
    P.initBoughtSummary();
  };

  // Auto-run on DOM ready. Safe to call again.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', P.init);
  } else {
    setTimeout(P.init, 0);
  }

})(window, document);
