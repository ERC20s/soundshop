(function () {
  'use strict';

  function esc(s) { return String(s || ''); }

  function onReady(fn) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') return fn();
    document.addEventListener('DOMContentLoaded', fn);
  }

  function renderFallback(el, items) {
    try {
      if (!el) return;
      el.innerHTML = '';
      var container = document.createElement('div');
      container.style.font = "14px system-ui,sans-serif";
      for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        var row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '12px';
        row.style.padding = '10px 0';
        row.style.borderTop = '1px solid #e5e7eb';

        var left = document.createElement('div');
        left.style.flex = '1';
        var b = document.createElement('b');
        b.textContent = esc(it.name);
        left.appendChild(b);
        if (it.description) {
          var d = document.createElement('div');
          d.style.fontSize = '12px';
          d.style.color = '#6b7280';
          d.textContent = esc(it.description);
          left.appendChild(d);
        }

        var price = document.createElement('span');
        price.textContent = esc(it.price || '');

        var actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.flexDirection = 'column';
        actions.style.gap = '6px';

        var view = document.createElement('a');
        view.textContent = 'View product';
        view.href = it.page || './';
        view.style.color = '#7c5cff';
        view.style.textDecoration = 'none';

        var contact = document.createElement('a');
        var subj = 'Buy ' + (it.name || 'product');
        // Compute support href using same lookup as plugin.js
        var href = (function () {
          try {
            var v = '';
            try { v = (el && el.getAttribute) ? (el.getAttribute('data-bought-summary-support-href') || '') : ''; } catch (e) { v = ''; }
            if (v) return v;
            try {
              var pageHost = document.querySelector('[data-bought-summary]');
              if (pageHost && pageHost.getAttribute) {
                v = pageHost.getAttribute('data-bought-summary-support-href') || '';
                if (v) return String(v).trim();
              }
            } catch (e) { /* ignore */ }
            try {
              var link = document.querySelector('link[rel="help"]');
              if (link && link.getAttribute) {
                v = link.getAttribute('href') || '';
                if (v) return String(v).trim();
              }
            } catch (e) { /* ignore */ }
            try {
              var meta = document.querySelector('meta[name="soundshop-support"]');
              if (meta && meta.getAttribute) {
                v = meta.getAttribute('content') || '';
                if (v) return String(v).trim();
              }
            } catch (e) { /* ignore */ }
            return '/docs.html#support';
          } catch (e) { return '/docs.html#support'; }
        }());

        var mailto = false;
        try { mailto = /^mailto:/i.test(String(href)); } catch (e) { mailto = false; }
        if (mailto) {
          try {
            var sep = href.indexOf('?') === -1 ? '?' : '&';
            href = href + sep + 'subject=' + encodeURIComponent(subj);
          } catch (e) { /* ignore */ }
        }

        contact.textContent = 'Contact to buy';
        contact.href = href || 'mailto:support@soundshop.example?subject=' + encodeURIComponent(subj);
        contact.style.color = '#7c5cff';
        contact.style.textDecoration = 'none';

        actions.appendChild(view);
        actions.appendChild(contact);

        row.appendChild(left);
        row.appendChild(price);
        row.appendChild(actions);

        container.appendChild(row);
      }
      var sold = document.createElement('p');
      sold.style.font = '11px system-ui,sans-serif';
      sold.style.color = '#9ca3af';
      sold.textContent = 'Sold by Soundshop';
      container.appendChild(sold);
      el.appendChild(container);
    } catch (e) { /* ignore */ }
  }

  onReady(function () {
    var el = document.getElementById('group-store');
    if (!el) return;

    // If the real widget appears to have rendered interactive links, do nothing.
    if (el.querySelector && el.querySelector('a[data-item], a[href][data-item]')) return;
    if (document.querySelector && document.querySelector('p[data-paid]')) return;

    // Delay slightly to let the real widget fill quickly when it can.
    setTimeout(function () {
      try {
        // If the widget has since rendered interactive content, bail out.
        if (el.querySelector && el.querySelector('a[data-item], a[href][data-item]')) return;
        if (document.querySelector && document.querySelector('p[data-paid]')) return;

        var text = (el.textContent || '').trim();
        var should = false;
        if (!text) should = true;
        else if (text.indexOf('The shop could not be reached') !== -1) should = true;
        else if (text.indexOf("Loading what's on sale") !== -1) should = true;

        if (!should) return;

        // Fetch the local items file (relative to /plugins/ this page is served from)
        fetch('../data/items.json').then(function (r) {
          if (!r.ok) return null;
          return r.json();
        }).then(function (json) {
          if (!json || !Array.isArray(json)) return;
          renderFallback(el, json);
        }).catch(function () { /* ignore */ });
      } catch (e) { /* ignore */ }
    }, 1500);
  });
})();
