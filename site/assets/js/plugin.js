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

      function

  // ---------- bought records and purchase summary (plugins page) ----------

  var BOUGHT_MAX_AGE = 60 * 24 * 60 * 60 * 1000;   // 60 days, as on the plugins page

  // A payment reference is quoted back to the buyer verbatim, so it is held to
  // exactly the shape the plugins page accepted off the return URL before it
  // ever reached storage. Anything else is treated as "no reference stored".
  var BOUGHT_REF_RE = /^[A-Za-z0-9_-]{1,128}$/;
  // A token is only ever printed when the page has no label for it, so it is
  // held to the same shape the plugins page allows itself to write.
  var BOUGHT_TOKEN_RE = /^[a-z0-9][a-z0-9 ._-]{0,63}$/;

  // A conservative email shape check for delivery addresses we may display.
  var BOUGHT_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

  function maskEmail(email) {
    if (!email || typeof email !== 'string') return '';
    var at = email.indexOf('@');
    if (at <= 0) return email;
    var local = email.slice(0, at);
    var domain = email.slice(at + 1);
    // Keep first letter of local, mask rest with stars (up to 6), show domain
    var first = local.charAt(0);
    var maskedLocal = first + Array(Math.min(Math.max(local.length - 1, 1), 6) + 1).join('*');
    // For domain, show the TLD and first label partially: keep last two labels
    var parts = domain.split('.');
    if (parts.length >= 2) {
      var tld = parts.pop();
      var left = parts.join('.');
      if (left.length > 12) left = left.slice(0, 9) + '...';
      return maskedLocal + '@' + left + '.' + tld;
    }
    return maskedLocal + '@' + domain;
  }

  /**
   * Everything this browser remembers buying, normalised and unexpired, as
   * token -> { t: <ms>, ref: '<payment reference>' | '' }. One parser for the
   * whole file: initBoughtNote wants only the time, initBoughtSummary wants
   * the reference too, and neither should re-read or re-validate the key.
   */
  function boughtRecords() {
    var out = {};
    var raw = null;
    try { raw = window.localStorage.getItem(BOUGHT_KEY); } catch (e) { return out; }
    if (!raw) return out;

    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return out; }

    if (!parsed || typeof parsed !== 'object') return out;

    var now = Date.now();
    try {
      Object.keys(parsed).forEach(function (k) {
        try {
          if (!BOUGHT_TOKEN_RE.test(k)) return;
          var v = parsed[k];
          if (!v || typeof v !== 'object') return;
          var t = parseInt(v.t, 10);
          if (!isFinite(t) || t <= 0) return;
          if (now - t > BOUGHT_MAX_AGE) return;
          var ref = '';
          if (typeof v.ref === 'string' && BOUGHT_REF_RE.test(v.ref)) ref = v.ref;
          var email = '';
          if (typeof v.email === 'string' && BOUGHT_EMAIL_RE.test(v.email)) email = v.email;
          out[k] = { t: t, ref: ref, email: email };
        } catch (e) { /* skip */ }
      });
    } catch (e) { return out; }

    return out;
  }

  function boughtDate(ms) {
    try {
      var d = new Date(ms);
      if (!isFinite(d.getTime())) return '';
      return d.toLocaleDateString();
    } catch (e) { return ''; }
  }

  P.initBoughtNote = function (root) {
    $$('[data-bought-note]', root || document).forEach(function (note) {
      if (bound(note, 'bought')) return;

      var items = boughtRecords();
      if (!items) return;

      if (!Object.keys(items).length) return;

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
        var email = recs[k].email || '';
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

            // Add a safe Verify button next to the Copy button. This button is only a
            // convenience to re-check the stored reference from this browser; it does
            // not alter any storage or change ownership state.
            var verifyBtn = document.createElement('button');
            verifyBtn.setAttribute('type', 'button');
            verifyBtn.className = 'bought__verify';
            verifyBtn.setAttribute('aria-label', 'Verify payment for ' + label);
            verifyBtn.setAttribute('title', 'Send this stored payment reference to the shop to confirm the order');
            verifyBtn.textContent = 'Verify';

            // Message span to show verification status next to the buttons.
            var msg = document.createElement('span');
            msg.className = 'bought__verify-msg';
            msg.setAttribute('aria-live', 'polite');
            msg.style.marginLeft = '8px';

            // Append a space and the verify button and the message node.
            metaSpan.appendChild(document.createTextNode(' '));
            metaSpan.appendChild(verifyBtn);
            metaSpan.appendChild(msg);

            // Click handler — defensive and inert if the platform verifier is absent.
            (function (refText, msgNode) {
              try {
                verifyBtn.addEventListener('click', function () {
                  try {
                    if (!window.groupStoreVerify || typeof window.groupStoreVerify !== 'function') {
                      msgNode.textContent = 'To confirm delivery, check your delivery email or contact Support.';
                      return;
                    }
                    msgNode.textContent = 'Verifying…';
                    var p = null;
                    try { p = window.groupStoreVerify(refText); } catch (e) { p = null; }
                    if (!p || typeof p.then !== 'function') {
                      msgNode.textContent = 'Verification failed';
                      return;
                    }
                    p.then(function (order) {
                      try {
                        if (order && order.id) {
                          msgNode.textContent = 'Verified: paid — order ' + String(order.id);
                        } else {
                          msgNode.textContent = 'Not found / unpaid';
                        }
                      } catch (e) { msgNode.textContent = 'Verification failed'; }
                    }).catch(function () { msgNode.textContent = 'Verification failed'; });
                  } catch (e) { msgNode.textContent = 'Verification failed'; }
                });
              } catch (e) { /* swallow */ }
            })(ref, msg);

          } catch (e) { /* defensive: do not let this break the host */ }
        } else if (email) {
          // No reference but we have a delivery email — show a masked delivery hint
          if (metaSpan.textContent) metaSpan.appendChild(document.createTextNode(' '));
          metaSpan.appendChild(document.createTextNode('Delivery email: ' + maskEmail(email)));
        } else if (norefMsg) {
          if (metaSpan.textContent) metaSpan.appendChild(document.createTextNode(' '));
          metaSpan.appendChild(document.createTextNode(norefMsg));
        }

        // If we had a reference and an email, also show a small masked email after the controls
        if (ref && email) {
          try {
            metaSpan.appendChild(document.createTextNode(' '));
            // Build a small click-to-reveal control instead of a plain masked span.
            var emSpan = null;
            var emWrap = null;

            emWrap = el('span', 'bought__email-wrap');

            // Masked text span (visible by default)
            emSpan = el('span', 'bought__email', maskEmail(email));
            emSpan.style.marginLeft = '8px';
            emSpan.style.color = 'var(--text-dim)';
            // Assign an id so the toggle button can reference it for aria-controls
            try { emSpan.id = 'bought-email-' + Math.random().toString(36).slice(2, 9); } catch (e) { emSpan.id = ''; }
            emSpan.setAttribute('aria-live', 'polite');

            // Toggle button
            var toggleBtn = document.createElement('button');
            toggleBtn.setAttribute('type', 'button');
            toggleBtn.className = 'bought__email-toggle';
            toggleBtn.textContent = 'Show';
            toggleBtn.setAttribute('aria-label', 'Show delivery email for ' + label);
            if (emSpan.id) toggleBtn.setAttribute('aria-controls', emSpan.id);
            toggleBtn.setAttribute('aria-expanded', 'false');
            // Minimal inline styling so no stylesheet edit is required
            toggleBtn.style.marginLeft = '8px';
            toggleBtn.style.padding = '0';
            toggleBtn.style.fontSize = '0.9em';

            // Defensive, in-memory only click handler that toggles the displayed text
            (function (btn, span, fullEmail) {
              try {
                var masked = maskEmail(fullEmail);
                btn.addEventListener('click', function () {
                  try {
                    if (!span) return;
                    var expanded = btn.getAttribute('aria-expanded') === 'true';
                    if (expanded) {
                      span.textContent = masked;
                      btn.textContent = 'Show';
                      btn.setAttribute('aria-expanded', 'false');
                      btn.setAttribute('aria-label', 'Show delivery email for ' + label);
                    } else {
                      span.textContent = fullEmail;
                      btn.textContent = 'Hide';
                      btn.setAttribute('aria-expanded', 'true');
                      btn.setAttribute('aria-label', 'Hide delivery email for ' + label);
                    }
                  } catch (e) { /* swallow to avoid breaking host */ }
                });
              } catch (e) { /* swallow */ }
            })(toggleBtn, emSpan, email);

            emWrap.appendChild(emSpan);
            emWrap.appendChild(toggleBtn);
            metaSpan.appendChild(emWrap);

          } catch (e) { /* ignore */ }
        }

        li.appendChild(labelSpan);
        li.appendChild(metaSpan);
        list.appendChild(li);
        validCount++;
      });

      if (validCount) {
        host.hidden = false;
      }
    });
  };

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
