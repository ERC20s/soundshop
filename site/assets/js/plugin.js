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
      
      function load() {
        if (typeof window.fetch !== 'function') { if (status) status.textContent = 'Presets not available'; return; }
        status && (status.textContent = 'Loading presets…');
        window.fetch(src, { method: 'GET', cache: 'no-store' })
          .then(function (r) { return r && r.ok ? r.json() : null; })
          .then(function (j) {
            try {
              var items = normalisePresets(j || []);
              if (!items.length) { if (status) status.textContent = 'No presets'; return; }
              while (list.firstChild) list.removeChild(list.firstChild);
              items.slice(0, limit).forEach(function (it) { list.appendChild(presetRow(it)); });
              if (status) status.hidden = true;
            } catch (e) { if (status) status.textContent = 'Presets not available'; }
          }).catch(function () { if (status) status.textContent = 'Presets not available'; });
      }

      load();
    });
  };

  /* =======================================================================
     03  SECTION NAV
     Sticky nav for long specification pages.
     ======================================================================= */

  P.initSectionNav = function (root) {
    $$('[data-section-nav]', root || document).forEach(function (host) {
      if (bound(host, 'section-nav')) return;
      var links = $$('a[data-section-nav-link]', host);
      if (!links.length) return;

      function onScroll() {
        var top = window.scrollY || window.pageYOffset || 0;
        var best = null;
        links.forEach(function (a) {
          try {
            var target = document.getElementById(a.getAttribute('href').replace(/^#/, ''));
            if (!target) return;
            var r = target.getBoundingClientRect();
            var off = Math.abs(r.top - 80);
            if (best == null || off < best[0]) best = [off, a];
          } catch (e) { /* ignore */ }
        });
        if (best && best[1]) {
          links.forEach(function (a) { a.classList.remove('active'); });
          try { best[1].classList.add('active'); } catch (e) { /* ignore */ }
        }
      }

      window.addEventListener('scroll', onScroll);
      setTimeout(onScroll, 200);
    });
  };

  /* =======================================================================
     04  TABS
     Simple ARIA tabs behaviour for spec sheets.
     ======================================================================= */

  P.initTabs = function (root) {
    $$('[data-tabs]', root || document).forEach(function (host) {
      if (bound(host, 'tabs')) return;
      var tabs = $$('[role="tab"]', host);
      var panels = $$('[role="tabpanel"]', host);
      if (!tabs.length || !panels.length) return;
      tabs.forEach(function (t, i) {
        t.setAttribute('aria-selected', 'false');
        t.setAttribute('tabindex', '-1');
        t.addEventListener('click', function () {
          tabs.forEach(function (x) { x.setAttribute('aria-selected', 'false'); x.setAttribute('tabindex', '-1'); });
          panels.forEach(function (p) { p.hidden = true; });
          t.setAttribute('aria-selected', 'true');
          t.setAttribute('tabindex', '0');
          panels[i].hidden = false;
        });
      });
      // Activate first
      tabs[0].setAttribute('aria-selected', 'true');
      tabs[0].setAttribute('tabindex', '0');
      panels.forEach(function (p, i) { p.hidden = i !== 0; });
    });
  };

  /* =======================================================================
     05  COUNT-UP
     Numeric counters animated from 0 to N on view.
     ======================================================================= */

  P.initCounters = function (root) {
    $$('[data-count-to]', root || document).forEach(function (host) {
      if (bound(host, 'counters')) return;
      var to = intAttr(host, 'data-count-to', 0);
      host.textContent = '0';
      if (to <= 0) return;
      var started = false;
      function tick() {
        if (started) return;
        var v = 0; started = true;
        var start = Date.now();
        var dur = 800;
        var t = setInterval(function () {
          var p = Math.min(1, (Date.now() - start) / dur);
          var cur = Math.floor(p * to);
          host.textContent = String(cur);
          if (p === 1) clearInterval(t);
        }, 30);
      }
      window.addEventListener('scroll', tick);
      setTimeout(tick, 200);
    });
  };

  /* =======================================================================
     06  BOUGHT NOTE
     Reveal a data-bought-note when the site remembers a recent buy on this
     device. The remembered token lives in localStorage under "bought_note".
     ======================================================================= */

  P.initBoughtNote = function (root) {
    $$('[data-bought-note]', root || document).forEach(function (host) {
      if (bound(host, 'bought-note')) return;
      var key = attr(host, 'data-bought-token') || 'bought_note';
      try {
        var token = window.localStorage && window.localStorage.getItem ? window.localStorage.getItem(key) : null;
        if (!token) return;
        host.hidden = false;
        var msg = $('[data-bought-note-message]', host);
        if (msg) msg.textContent = token;
      } catch (e) { /* ignore */ }
    });
  };

  /* =======================================================================
     07  BOUGHT SUMMARY
     Render an in-browser summary of every purchase this device remembers.
     The input is a JSON array held in an element's data-bought-summary attribute
     (see tools/check-bought-summary). This code is defensive about the shape
     of that data and only renders plain text.
     ======================================================================= */

  P.initBoughtSummary = function (root) {
    $$('[data-bought-summary]', root || document).forEach(function (host) {
      if (bound(host, 'bought-summary')) return;

      var list = $('[data-bought-list]', host) || host;
      var raw = attr(host, 'data-bought-summary');
      if (!raw) return;
      var arr = null;
      try { arr = JSON.parse(raw); } catch (e) { return; }
      if (!Array.isArray(arr) || !arr.length) return;

      var validCount = 0;
      arr.forEach(function (r) {
        try { if (!r || typeof r !== 'object') return; } catch (e) { return; }

        var li = el('li', 'bought');
        var label = (r.label || r.itemName || r.name || '').toString();
        if (!label) label = 'A bought item';

        var labelSpan = el('span', 'bought__label', label);
        var metaSpan = el('span', 'bought__meta');

        // date
        if (r.date) {
          try { metaSpan.appendChild(document.createTextNode(String(r.date))); } catch (e) { /* ignore */ }
        }

        var recs = r.records || (Array.isArray(r.bought) ? r.bought : []);
        var norefMsg = r.norefMessage || r.norefMsg || '';
        var maskEmail = function (e) {
          try {
            if (!e || typeof e !== 'string') return '';
            var parts = e.split('@');
            if (parts.length !== 2) return e;
            var name = parts[0];
            if (name.length <= 2) name = name[0] + '\u2026';
            else name = name.substring(0, 2) + '\u2026';
            return name + '@' + parts[1];
          } catch (ex) { return '' }
        };

        recs = Array.isArray(recs) ? recs : [];
        Object.keys(recs).forEach(function (k) {
          try {
            var ref = recs[k].ref || '';
            var email = recs[k].email || '';
            // space between date and ref if needed - this is handled earlier for r.date
          } catch (e) { /* ignore */ }
        });

        // Render each record
        Object.keys(recs).forEach(function (k) {
          try {
            var ref = recs[k].ref || '';
            var email = recs[k].email || '';
            // Keep a consistent label for this item
            var label = (r.label || r.itemName || r.name || '').toString();
            if (!label) label = 'A bought item';

            // visible label
            var labelSpan = el('span', 'bought__label', label);
            var metaSpan = el('span', 'bought__meta');

            // Reference or no-reference message
            var refPrefix = recs[k].refPrefix || r.refPrefix || '';
            var refSuffix = recs[k].refSuffix || r.refSuffix || '';
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

                              // Dispatch a minimal, non-sensitive in-page event so other
                              // scripts can react to a verified order without learning
                              // private data. Keep the summary intentionally small.
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
                  } catch (e) { /* swallow */ }
                })(ref, msg);

              } catch (e) { /* defensive: do not let this break the host */ }
            } else if (email) {
              // No reference but we have a delivery email — show a masked delivery hint
              if (metaSpan.textContent) metaSpan.appendChild(document.createTextNode(' '));
              metaSpan.appendChild(document.createTextNode('Delivery email: '));
              try {
                var emSpanNoRef = el('span', 'bought__email', maskEmail(email));
                emSpanNoRef.style.marginLeft = '4px';
                emSpanNoRef.style.color = 'var(--text-dim)';
                metaSpan.appendChild(emSpanNoRef);

                // Add a reveal button that toggles the email in-memory only.
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

              } catch (e) { metaSpan.appendChild(document.createTextNode('Delivery email: ' + maskEmail(email))); }
            } else if (norefMsg) {
              if (metaSpan.textContent) metaSpan.appendChild(document.createTextNode(' '));
              metaSpan.appendChild(document.createTextNode(norefMsg));
            }

            // If we had a reference and an email, also show a small masked email after the controls
            if (ref && email) {
              try {
                metaSpan.appendChild(document.createTextNode(' '));
                var emSpan = el('span', 'bought__email', maskEmail(email));
                emSpan.style.marginLeft = '8px';
                emSpan.style.color = 'var(--text-dim)';
                metaSpan.appendChild(emSpan);

                // Reveal button for the small email next to ref controls
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
            }

            li.appendChild(labelSpan);
            li.appendChild(metaSpan);
            list.appendChild(li);
            validCount++;
          } catch (e) { /* ignore per-item */ }
        });

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
