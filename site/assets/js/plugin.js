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

      function fail(text) {
        host.setAttribute('data-presets-state', 'error');
        if (status) {
          status.hidden = false;
          status.textContent = text;
        }
      }

      if (isFileProtocol()) {
        fail('Preset previews are loaded from a JSON file, and browsers block that read ' +
             'for pages opened straight from disk. Serve the folder over http, or open the ' +
             'full preset library where every patch is listed.');
        return;
      }

      if (typeof window.fetch !== 'function') {
        fail('This browser cannot load the preset index. The full library is one link away.');
        return;
      }

      host.setAttribute('data-presets-state', 'loading');
      if (status) status.textContent = 'Loading presets…';

      window.fetch(src, { cache: 'no-store' })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('preset index unavailable');
          return res.json();
        })
        .then(function (data) {
          var presets = normalisePresets(data);
          if (!presets.length) throw new Error('preset index empty');

          var frag = document.createDocumentFragment();
          presets.slice(0, limit).forEach(function (p) {
            try { frag.appendChild(presetRow(p)); } catch (e) { /* skip one bad row */ }
          });
          if (!frag.childNodes.length) throw new Error('nothing renderable');

          while (list.firstChild) list.removeChild(list.firstChild);
          list.appendChild(frag);
          host.setAttribute('data-presets-state', 'ready');

          if (status) {
            var total = presets.length;
            var shown = Math.min(limit, total);
            status.hidden = false;
            status.textContent = 'Showing ' + shown + ' of ' + total + ' presets in this index.';
          }
        })
        .catch(function () {
          fail('The preset index could not be read from here. Everything we ship is still ' +
               'listed in the full preset library.');
        });
    });
  };

  /* =======================================================================
     03  IN-PAGE SECTION NAV + SCROLL SPY
     <nav data-section-nav data-section-offset="120">
       <a href="#specs">Specs</a> ...
     </nav>
     Marks the link for the section currently under the header with
     aria-current="true" and .is-active. Pure read-only observation: it never
     touches scroll position or the URL.
     ======================================================================= */

  P.initSectionNav = function (root) {
    $$('[data-section-nav]', root || document).forEach(function (nav) {
      if (bound(nav, 'sectionnav')) return;

      var links = $$('a', nav).filter(function (a) {
        var h = a.getAttribute('href') || '';
        return h.charAt(0) === '#' && h.length > 1;
      });
      if (!links.length) return;

      var pairs = [];
      links.forEach(function (a) {
        var id = (a.getAttribute('href') || '').slice(1);
        var target = null;
        try { target = document.getElementById(decodeURIComponent(id)); } catch (e) { target = null; }
        if (target) pairs.push({ link: a, target: target });
      });
      if (!pairs.length) return;

      var offset = intAttr(nav, 'data-section-offset', 140);
      var current = null;

      function mark(link) {
        if (link === current) return;
        current = link;
        pairs.forEach(function (p) {
          var on = p.link === link;
          p.link.classList.toggle('is-active', on);
          if (on) p.link.setAttribute('aria-current', 'true');
          else p.link.removeAttribute('aria-current');
        });
      }

      var ticking = false;
      function update() {
        ticking = false;
        var best = pairs[0].link;
        var y = window.pageYOffset || document.documentElement.scrollTop || 0;
        for (var i = 0; i < pairs.length; i++) {
          var top = pairs[i].target.getBoundingClientRect().top + y;
          if (top - offset <= y + 1) best = pairs[i].link;
        }
        // At the very bottom of the document the last section wins outright.
        var docH = document.documentElement.scrollHeight;
        if (y + window.innerHeight >= docH - 4) best = pairs[pairs.length - 1].link;
        mark(best);
      }

      function onScroll() {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(update);
      }

      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });
      window.addEventListener('load', onScroll);
      update();
    });
  };

  /* =======================================================================
     04  TABS  (used for the spec sheet)
     <div data-tabs>
       <div role="tablist"><button role="tab" aria-controls="panel-id" ...>
       <div role="tabpanel" id="panel-id" ...>
     Progressive: with no JS every panel is simply visible, which is a
     perfectly good spec sheet.
     ======================================================================= */

  function selectTab(tabs, panels, index, focus) {
    tabs.forEach(function (tab, i) {
      var on = i === index;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.setAttribute('tabindex', on ? '0' : '-1');
      tab.classList.toggle('is-active', on);
    });
    panels.forEach(function (panel, i) {
      if (!panel) return;
      panel.hidden = i !== index;
    });
    if (focus && tabs[index]) {
      try { tabs[index].focus(); } catch (e) { /* ignore */ }
    }
  }

  P.initTabs = function (root) {
    $$('[data-tabs]', root || document).forEach(function (group) {
      if (bound(group, 'tabs')) return;

      var tabs = $$('[role="tab"]', group);
      if (tabs.length < 2) return;

      var panels = tabs.map(function (tab) {
        var id = attr(tab, 'aria-controls');
        return id ? document.getElementById(id) : null;
      });
      if (!panels.some(Boolean)) return;

      var start = 0;
      tabs.forEach(function (tab, i) {
        if (tab.getAttribute('aria-selected') === 'true') start = i;
      });

      selectTab(tabs, panels, start, false);

      tabs.forEach(function (tab, i) {
        tab.addEventListener('click', function (ev) {
          ev.preventDefault();
          selectTab(tabs, panels, i, false);
        });
        tab.addEventListener('keydown', function (ev) {
          var key = ev.key;
          var next = -1;
          if (key === 'ArrowRight' || key === 'ArrowDown') next = (i + 1) % tabs.length;
          else if (key === 'ArrowLeft' || key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length;
          else if (key === 'Home') next = 0;
          else if (key === 'End') next = tabs.length - 1;
          if (next < 0) return;
          ev.preventDefault();
          selectTab(tabs, panels, next, true);
        });
      });
    });
  };

  /* =======================================================================
     05  COUNT-UP FIGURES
     <span class="num" data-count-to="149" data-count-prefix="$">$149</span>
     The markup already contains the final value, so this only ever animates
     from zero to something the reader would have seen anyway.
     ======================================================================= */

  function formatCount(value, decimals, prefix, suffix) {
    var n = decimals > 0 ? value.toFixed(decimals) : String(Math.round(value));
    if (decimals === 0) n = n.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return prefix + n + suffix;
  }

  function runCount(node) {
    var to = parseFloat(attr(node, 'data-count-to'));
    if (!isFinite(to)) return;
    var decimals = intAttr(node, 'data-count-decimals', 0);
    var prefix = attr(node, 'data-count-prefix');
    var suffix = attr(node, 'data-count-suffix');
    var final = formatCount(to, decimals, prefix, suffix);

    if (reducedMotion() || typeof window.requestAnimationFrame !== 'function') {
      node.textContent = final;
      return;
    }

    var duration = intAttr(node, 'data-count-duration', 900);
    var startTime = 0;

    function step(now) {
      if (!startTime) startTime = now;
      var t = Math.min(1, (now - startTime) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      node.textContent = formatCount(to * eased, decimals, prefix, suffix);
      if (t < 1) window.requestAnimationFrame(step);
      else node.textContent = final;
    }
    window.requestAnimationFrame(step);
  }

  P.initCounters = function (root) {
    var nodes = $$('[data-count-to]', root || document).filter(function (n) {
      return !bound(n, 'count');
    });
    if (!nodes.length) return;

    if (reducedMotion() || typeof window.IntersectionObserver !== 'function') {
      nodes.forEach(runCount);
      return;
    }

    var io = new window.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        io.unobserve(entry.target);
        runCount(entry.target);
      });
    }, { threshold: 0.4 });

    nodes.forEach(function (n) { io.observe(n); });
  };

  /* =======================================================================
     06  ALREADY-BOUGHT NOTE
     A buyer who pays on the plugins page has that return written into this
     browser under one namespaced key, token -> timestamp:

       localStorage["soundshop:bought:v1"] = {"drift": 1756233600000}

     The product pages knew nothing about it, so someone who had just bought
     DRIFT could land back on drift.html and see nothing but "Buy DRIFT" and
     no route to the delivery instructions. This reads that same key back and
     unhides a note the page already ships, hidden:

       <div class="note note--good" hidden
            data-bought-note data-bought-item="drift" data-bought-covered-by="bundle">
         <p class="note__title">Already bought on this device</p>
         <p>...<span data-bought-cover hidden>...</span>
            <span data-bought-date data-bought-date-prefix=", bought "></span>...</p>
       </div>

     Rules kept deliberately:
       - Every token, every word and every link lives in the markup. This file
         holds no item name, no wording and no URL — only the storage key and
         the same 60-day cut-off the plugins page uses.
       - data-bought-covered-by names a token that also covers this one (the
         Full Shop bundle covers all four plugins), matching the plugins page,
         where a remembered "bundle" marks every other token as covered. The
         item's own purchase wins, and then [data-bought-cover] stays hidden.
       - Read-only. Nothing is written or deleted here, so a product page can
         never disturb what the shop remembers; expired entries are simply
         ignored on read and the plugins page prunes them.
       - Storage blocked, unreadable or corrupt is a silent no-op: the note
         stays hidden and the page is exactly what shipped in the HTML.
       - Nothing is disabled or hidden by this: a second licence is still one
         click away on the same Buy link. A note in a browser is never proof
         of ownership, which is why the wording says "on this device".
     ======================================================================= */

  var BOUGHT_KEY = 'soundshop:bought:v1';
  var BOUGHT_MAX_AGE = 60 * 24 * 60 * 60 * 1000;   // 60 days, as on the plugins page

  /** Everything this browser remembers buying, normalised and unexpired. */
  function boughtItems() {
    var out = {};
    var raw = null;
    try { raw = window.localStorage.getItem(BOUGHT_KEY); } catch (e) { return out; }
    if (!raw) return out;

    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return out; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;

    var now = Date.now();
    for (var key in parsed) {
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
      var token = String(key == null ? '' : key).trim().toLowerCase();
      var when = Number(parsed[key]);
      if (!token || !isFinite(when) || when <= 0) continue;
      if ((now - when) > BOUGHT_MAX_AGE) continue;   // too old to speak for: ignore
      out[token] = when;
    }
    return out;
  }

  function boughtDate(ms) {
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return d.toDateString(); }
  }

  P.initBoughtNote = function (root) {
    var notes = $$('[data-bought-note]', root || document);
    if (!notes.length) return;                       // e.g. the plugins page: untouched

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
      if (!state) return;                            // not bought here: leave it hidden

      var dateNode = $('[data-bought-date]', note);
      if (dateNode) {
        var text = boughtDate(when);
        // The wording around the date is the page's, not this file's.
        dateNode.textContent = text ? (attr(dateNode, 'data-bought-date-prefix') + text) : '';
      }

      var coverNode = $('[data-bought-cover]', note);
      if (coverNode) coverNode.hidden = state === 'own' ? true : false;

      note.setAttribute('data-bought-state', state);
      note.hidden = false;
    });
  };

  /* =======================================================================
     07  BOOT
     ======================================================================= */

  P.init = function (root) {
    try { P.initDemoSlot(root); } catch (e) { /* never block the page */ }
    try { P.initPresetTeaser(root); } catch (e) { /* never block the page */ }
    try { P.initSectionNav(root); } catch (e) { /* never block the page */ }
    try { P.initTabs(root); } catch (e) { /* never block the page */ }
    try { P.initCounters(root); } catch (e) { /* never block the page */ }
    try { P.initBoughtNote(root); } catch (e) { /* never block the page */ }
  };

  function ready(fn) {
    if (SS && typeof SS.ready === 'function') { SS.ready(fn); return; }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  ready(function () { P.init(); });
})(window, document);
