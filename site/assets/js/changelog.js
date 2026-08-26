/* =========================================================================
   changelog.js — renders site/data/changelog.json into site/changelog.html
   -------------------------------------------------------------------------
   No modules, no dependencies, no build step. Plain <script src>.

   Root-agnostic by design: the data file lives inside site/, so the first
   candidate below resolves whether the repository root or site/ is served as
   the web root. A second candidate covers the legacy repo-root copy.
   tools/check-links.js understands the two-element array below as a fallback
   list and passes if either candidate exists.

   Everything is built with createElement + textContent — no innerHTML, so
   nothing in the data file can inject markup into the page.
   ========================================================================= */
(function () {
  'use strict';

  /* Fallback list, resolved against the PAGE (site/changelog.html), not this
     script. The data ships inside site/ at site/data/changelog.json, so the
     first path resolves under both mandated web roots: serving the repo root
     it is /site/data/changelog.json, serving site/ it is /data/changelog.json.
     The second path is a fallback for a repo-root deploy behind a rewrite
     that strips the site/ prefix. Keep the two-entry shape: check-links.js
     treats an array of 2+ literals as a fallback list. */
  var JSON_PATHS = ['data/changelog.json', 'site/data/changelog.json'];

  var PRODUCTS = ['VANTA', 'DRIFT', 'PRISM', 'ANVIL', 'Soundshop'];

  var TYPE_LABEL = {
    release: 'Release',
    feature: 'Feature',
    fix: 'Fix',
    beta: 'Beta'
  };

  /* Type badge uses the shipped badge modifiers from assets/style.css. */
  var TYPE_BADGE = {
    release: 'badge--bundle',
    feature: 'badge--new',
    fix: 'badge--version',
    beta: 'badge--beta'
  };

  var MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  var state = {
    entries: [],
    product: 'all',
    type: 'all'
  };

  var els = {};

  /* ---------------------------------------------------------------- utils */

  function q(sel) {
    try { return document.querySelector(sel); } catch (e) { return null; }
  }

  function qa(sel) {
    try { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
    catch (e) { return []; }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /* Parse a YYYY-MM-DD date to a timestamp. Anything unparseable -> null,
     which sinks the entry to the bottom of the list rather than throwing. */
  function stamp(entry) {
    if (!entry || typeof entry.date !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(entry.date.trim());
    if (!m) return null;
    var t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isFinite(t) ? t : null;
  }

  function formatDate(entry) {
    var t = stamp(entry);
    if (t === null) return 'UNDATED';
    if (window.SS && window.SS.fmt && typeof window.SS.fmt.date === 'function') {
      var out = window.SS.fmt.date(entry.date);
      if (out) return out;
    }
    var d = new Date(t);
    var day = d.getUTCDate();
    return (day < 10 ? '0' + day : String(day)) + ' ' +
           MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  /* Newest first. Ties broken by original file order (stable), undated last. */
  function sortEntries(list) {
    var indexed = list.map(function (entry, i) {
      return { entry: entry, i: i, t: stamp(entry) };
    });
    indexed.sort(function (a, b) {
      if (a.t === null && b.t === null) return a.i - b.i;
      if (a.t === null) return 1;
      if (b.t === null) return -1;
      if (b.t !== a.t) return b.t - a.t;
      return a.i - b.i;
    });
    return indexed.map(function (row) { return row.entry; });
  }

  function normaliseType(entry) {
    var t = entry && typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
    return Object.prototype.hasOwnProperty.call(TYPE_LABEL, t) ? t : 'release';
  }

  function normaliseProduct(entry) {
    var p = entry && typeof entry.product === 'string' ? entry.product.trim() : '';
    for (var i = 0; i < PRODUCTS.length; i++) {
      if (PRODUCTS[i].toLowerCase() === p.toLowerCase()) return PRODUCTS[i];
    }
    return p || 'Soundshop';
  }

  /* ------------------------------------------------------------ rendering */

  function buildEntry(entry) {
    var product = normaliseProduct(entry);
    var type = normaliseType(entry);

    var article = el('article', 'entry cl-entry');
    article.setAttribute('data-product', product);
    article.setAttribute('data-type', type);

    /* --- meta column --- */
    var meta = el('div', 'entry__meta');
    meta.appendChild(el('span', 'entry__version num', entry.version || '—'));
    meta.appendChild(el('span', 'entry__date', formatDate(entry)));

    var badges = el('div', 'cluster cluster--sm cl-badges');
    badges.appendChild(el('span', 'badge cl-product', product));
    badges.appendChild(el('span', 'badge ' + (TYPE_BADGE[type] || 'badge--version'), TYPE_LABEL[type]));
    meta.appendChild(badges);

    article.appendChild(meta);

    /* --- body column --- */
    var body = el('div', 'cl-body');
    body.appendChild(el('h3', 'entry__title', entry.title || 'Release notes'));

    var notes = Array.isArray(entry.notes) ? entry.notes : [];
    if (notes.length) {
      var list = el('ul', 'entry__notes cl-notes');
      for (var i = 0; i < notes.length; i++) {
        if (typeof notes[i] !== 'string' || !notes[i].trim()) continue;
        list.appendChild(el('li', null, notes[i]));
      }
      if (list.childNodes.length) body.appendChild(list);
    }

    var links = entry.links;
    if (links && typeof links === 'object' && !Array.isArray(links)) {
      var keys = Object.keys(links);
      var row = el('div', 'cluster cluster--sm cl-links');
      var added = 0;
      for (var k = 0; k < keys.length; k++) {
        var href = links[keys[k]];
        if (typeof href !== 'string' || !href.trim()) continue;
        var a = el('a', 'cl-link', keys[k]);
        a.setAttribute('href', resolveLink(href.trim()));
        row.appendChild(a);
        added++;
      }
      if (added) body.appendChild(row);
    }

    article.appendChild(body);
    return article;
  }

  /* Link values in the JSON use a leading "/" to mean "relative to site/".
     This page lives at site/changelog.html, so when the repository root is
     the web root a leading "/" would escape to the server root — rewrite it
     to a path relative to this page instead. */
  function resolveLink(href) {
    if (href.charAt(0) !== '/') return href;
    if (/^\/\//.test(href)) return href;
    return href.slice(1);
  }

  function apply() {
    var visible = 0;
    var nodes = qa('[data-cl-list] .cl-entry');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var okProduct = state.product === 'all' || node.getAttribute('data-product') === state.product;
      var okType = state.type === 'all' || node.getAttribute('data-type') === state.type;
      if (okProduct && okType) {
        node.hidden = false;
        visible++;
      } else {
        node.hidden = true;
      }
    }

    if (els.empty) els.empty.hidden = visible !== 0;
    if (els.count) {
      els.count.textContent = visible === state.entries.length
        ? String(state.entries.length) + ' releases'
        : String(visible) + ' of ' + String(state.entries.length) + ' releases';
    }
  }

  function render(entries) {
    var list = els.list;
    if (!list) return;

    while (list.firstChild) list.removeChild(list.firstChild);

    var sorted = sortEntries(entries);
    state.entries = sorted;

    var counts = {};
    for (var i = 0; i < sorted.length; i++) {
      list.appendChild(buildEntry(sorted[i]));
      var p = normaliseProduct(sorted[i]);
      counts[p] = (counts[p] || 0) + 1;
    }

    var badges = qa('[data-cl-count-for]');
    for (var b = 0; b < badges.length; b++) {
      var key = badges[b].getAttribute('data-cl-count-for');
      var n = key === 'all' ? sorted.length : (counts[key] || 0);
      badges[b].textContent = String(n);
    }

    if (els.status) els.status.hidden = true;
    if (els.filters) els.filters.hidden = false;
    apply();
  }

  function fail(message, detail) {
    if (els.filters) els.filters.hidden = true;
    if (els.count) els.count.textContent = '';
    if (els.empty) els.empty.hidden = true;
    if (!els.status) return;

    els.status.hidden = false;
    while (els.status.firstChild) els.status.removeChild(els.status.firstChild);
    els.status.className = 'empty-state';
    els.status.appendChild(el('p', 'empty-state__title', 'Release history unavailable'));
    els.status.appendChild(el('p', null, message));
    if (detail) els.status.appendChild(el('p', 'cl-detail', detail));
  }

  /* ------------------------------------------------------------- loading */

  function loadFrom(paths, index) {
    if (index >= paths.length) {
      fail(
        'The release data could not be loaded from either location this page knows about.',
        'Tried: ' + paths.join('  ·  ') + ' — opening the page straight from the filesystem ' +
        'also blocks this request, so serve the folder over http and reload.'
      );
      return;
    }

    var url = paths[index];
    var next = function () { loadFrom(paths, index + 1); };

    if (typeof window.fetch !== 'function') {
      fail('This browser cannot fetch the release data.', 'window.fetch is unavailable.');
      return;
    }

    window.fetch(url, { cache: 'no-cache' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        var entries = Array.isArray(data) ? data
          : (data && Array.isArray(data.entries) ? data.entries : null);
        if (!entries) throw new Error('unexpected shape');
        if (!entries.length) {
          fail('The release history is empty.', 'The data file parsed cleanly but contained no entries.');
          return;
        }
        try {
          render(entries);
        } catch (e) {
          fail('The release history could not be rendered.', String(e && e.message ? e.message : e));
        }
      })
      .catch(function () { next(); });
  }

  /* -------------------------------------------------------------- filters */

  function wireFilters() {
    var group = function (attr, key) {
      var buttons = qa('[' + attr + ']');
      for (var i = 0; i < buttons.length; i++) {
        (function (button) {
          button.addEventListener('click', function () {
            state[key] = button.getAttribute(attr) || 'all';
            for (var j = 0; j < buttons.length; j++) {
              var on = buttons[j] === button;
              buttons[j].setAttribute('aria-pressed', on ? 'true' : 'false');
              if (on) buttons[j].classList.add('is-active');
              else buttons[j].classList.remove('is-active');
            }
            apply();
          });
        }(buttons[i]));
      }
    };

    group('data-cl-product', 'product');
    group('data-cl-type', 'type');
  }

  /* ----------------------------------------------------------------- boot */

  function init() {
    els.list = q('[data-cl-list]');
    els.status = q('[data-cl-status]');
    els.empty = q('[data-cl-empty]');
    els.count = q('[data-cl-count]');
    els.filters = q('[data-cl-filters]');

    if (!els.list) return;
    if (els.empty) els.empty.hidden = true;
    if (els.filters) els.filters.hidden = true;

    wireFilters();
    loadFrom(JSON_PATHS, 0);
  }

  try {
    if (window.SS && typeof window.SS.ready === 'function') window.SS.ready(init);
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  } catch (e) {
    /* Never let a rendering problem take the rest of the page down. */
  }
})();
