/* =========================================================================
   SOUNDSHOP — buy.js
   Wires the price CTAs on the catalogue page (the four product cards and the
   bundle figure) to the group's real store checkout.

   Design rules this file obeys, the same ones plugin.js states for itself:
     - No modules, no imports, no build step. Plain <script src>.
     - Exactly one global: window.SSBuy.
     - No path or URL literal appears anywhere in this file. The items
       endpoint and the group name are read from data-* attributes on the
       markup that owns them; the checkout URL and the per-item pay URL come
       back inside the store response.
     - Nothing here is required for the page to be readable. Every Buy button
       ships hidden and is only revealed when a matching item really exists,
       so with the network blocked the page renders exactly as it does today.
     - Fetched data is written with textContent only. Never innerHTML.

   Markup contract:

     <main data-store-items="…items endpoint…" data-store-group="…group…">
       …
       <button class="btn btn-primary btn--sm" type="button"
               data-store-item="vanta" hidden>Buy</button>

   The token in data-store-item ("vanta", "drift", "prism", "anvil",
   "bundle") is matched case-insensitively against each item's id and name.

   Public API (idempotent, safe to call with nothing on the page):
     SSBuy.init(root)   find the store host, fetch items once, wire buttons
   ========================================================================= */

(function (window, document) {
  'use strict';

  var SS = window.SS || null;
  var B = {};
  window.SSBuy = B;

  /* -----------------------------------------------------------------------
     00  HELPERS
     ----------------------------------------------------------------------- */

  function $(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }

  function $$(sel, root) {
    try {
      return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    } catch (e) { return []; }
  }

  function attr(node, name) {
    if (!node || !node.getAttribute) return '';
    var v = node.getAttribute(name);
    return v == null ? '' : String(v).trim();
  }

  function bound(node, key) {
    // One-shot guard, same shape as plugin.js: re-running init() never
    // double-binds a button.
    if (!node) return true;
    var name = 'data-ssb-' + key;
    if (node.getAttribute(name) === 'on') return true;
    node.setAttribute(name, 'on');
    return false;
  }

  function isFileProtocol() {
    try { return window.location.protocol === 'file:'; } catch (e) { return false; }
  }

  /** Lower-case, strip everything that is not a letter or a digit. */
  function norm(value) {
    if (value == null) return '';
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  /** A price we are willing to print. Numbers become plain text, nothing else. */
  function priceText(item) {
    var p = item.price;
    if (typeof p === 'number' && isFinite(p)) return String(p);
    if (typeof p === 'string' && p.trim() !== '') return p.trim();
    return '';
  }

  /** Only ordinary web links are ever followed as a fallback. */
  function safeUrl(value) {
    if (typeof value !== 'string' || value.trim() === '') return '';
    var url = value.trim();
    if (!/^https?:/i.test(url)) return '';
    return url;
  }

  /* -----------------------------------------------------------------------
     01  MATCHING
     The store's items are named by whoever set them up on the group's Admin
     tab, so matching is deliberately forgiving but never creative: exact id
     or name first, then the token as a whole word inside the name. Anything
     less certain leaves the button hidden and the card looks as it does now.
     ----------------------------------------------------------------------- */

  function itemMatches(item, token) {
    if (!item || typeof item !== 'object' || !token) return false;
    var id = norm(item.id);
    var name = norm(item.name);
    if (id && id === token) return true;
    if (name && name === token) return true;
    return false;
  }

  function itemContains(item, token) {
    if (!item || typeof item !== 'object' || !token) return false;
    var name = norm(item.name);
    return !!(name && name.indexOf(token) !== -1);
  }

  function findItem(items, rawToken) {
    var token = norm(rawToken);
    if (!token) return null;
    var i;
    for (i = 0; i < items.length; i++) {
      if (itemMatches(items[i], token)) return items[i];
    }
    for (i = 0; i < items.length; i++) {
      if (itemContains(items[i], token)) return items[i];
    }
    return null;
  }

  function normaliseItems(store) {
    if (!store || typeof store !== 'object') return [];
    if (!Array.isArray(store.items)) return [];
    return store.items.filter(function (it) {
      return it && typeof it === 'object' && (it.id != null || it.name != null);
    });
  }

  /* -----------------------------------------------------------------------
     02  ONE BUTTON
     ----------------------------------------------------------------------- */

  function label(button, text) {
    button.textContent = text;
  }

  function wireButton(button, item, store, group) {
    var id = item.id == null ? '' : String(item.id);
    var price = priceText(item);
    var payUrl = safeUrl(item.payUrl);
    var checkout = store && store.checkout && typeof store.checkout === 'object' ? store.checkout : null;
    var checkoutUrl = checkout && checkout.enabled ? safeUrl(checkout.url) : '';
    var busy = false;

    if (!id && !payUrl) return;

    label(button, price ? 'Buy ' + price : 'Buy');
    button.setAttribute('title', item.name ? 'Buy ' + String(item.name) : 'Buy');
    button.removeAttribute('hidden');

    button.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (busy) return;

      function fallback() {
        if (payUrl) { window.location.href = payUrl; return; }
        busy = false;
        button.classList.remove('is-loading');
        label(button, price ? 'Buy ' + price : 'Buy');
      }

      if (!checkoutUrl || !id || typeof window.fetch !== 'function') { fallback(); return; }

      busy = true;
      button.classList.add('is-loading');
      label(button, 'Opening…');

      window.fetch(checkoutUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group: group,
          item: id,
          quantity: 1,
          returnUrl: window.location.href
        })
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var next = data ? safeUrl(data.url) : '';
          if (next) { window.location.href = next; return; }
          fallback();
        })
        .catch(fallback);
    });
  }

  /* -----------------------------------------------------------------------
     03  BOOT
     ----------------------------------------------------------------------- */

  B.init = function (root) {
    var scope = root || document;
    var host = $('[data-store-items]', scope) ||
               (scope.getAttribute && scope.getAttribute('data-store-items') ? scope : null);
    if (!host) return;

    var endpoint = attr(host, 'data-store-items');
    var group = attr(host, 'data-store-group');
    if (!endpoint || !group) return;

    var buttons = $$('[data-store-item]', host).filter(function (b) {
      return !bound(b, 'buy');
    });
    if (!buttons.length) return;

    // Opened straight from disk, or on a browser without fetch: leave every
    // button hidden. The static prices and the product links still work.
    if (isFileProtocol() || typeof window.fetch !== 'function') return;

    host.setAttribute('data-store-state', 'loading');

    window.fetch(endpoint, { cache: 'no-store' })
      .then(function (res) {
        if (!res || !res.ok) throw new Error('store unavailable');
        return res.json();
      })
      .then(function (store) {
        var items = normaliseItems(store);
        if (!items.length) throw new Error('nothing on sale');

        var wired = 0;
        buttons.forEach(function (button) {
          var item = findItem(items, attr(button, 'data-store-item'));
          if (!item) return;
          try { wireButton(button, item, store, group); wired++; } catch (e) { /* skip one */ }
        });

        host.setAttribute('data-store-state', wired ? 'ready' : 'unmatched');
      })
      .catch(function () {
        host.setAttribute('data-store-state', 'absent');
      });
  };

  function ready(fn) {
    if (SS && typeof SS.ready === 'function') { SS.ready(fn); return; }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  ready(function () {
    try { B.init(); } catch (e) { /* never block the page */ }
  });
})(window, document);
