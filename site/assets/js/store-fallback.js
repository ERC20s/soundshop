(function () {
  'use strict';

  function esc(s) { return String(s || ''); }

  function onReady(fn) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') return fn();
    document.addEventListener('DOMContentLoaded', fn);
  }

  function renderFallback(el, items, contactInfo) {
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

        var contactLink = document.createElement('a');
        var subj = 'Buy ' + (it.name || 'product');
        contactLink.textContent = 'Contact to buy';
        contactLink.style.color = '#7c5cff';
        contactLink.style.textDecoration = 'none';

        // Build href from provided contactInfo, prefer a supportHref, then supportEmail, then mailto fallback
        try {
          if (contactInfo && typeof contactInfo === 'object') {
            if (contactInfo.supportHref && String(contactInfo.supportHref).trim()) {
              contactLink.href = String(contactInfo.supportHref).trim();
            } else if (contactInfo.supportEmail && String(contactInfo.supportEmail).trim()) {
              contactLink.href = 'mailto:' + String(contactInfo.supportEmail).trim() + '?subject=' + encodeURIComponent(subj);
            } else {
              contactLink.href = 'mailto:support@soundshop.example?subject=' + encodeURIComponent(subj);
            }
          } else {
            contactLink.href = 'mailto:support@soundshop.example?subject=' + encodeURIComponent(subj);
          }
        } catch (e) {
          try { contactLink.href = 'mailto:support@soundshop.example?subject=' + encodeURIComponent(subj); } catch (err) { /* ignore */ }
        }

        actions.appendChild(view);
        actions.appendChild(contactLink);

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

        // Try multiple candidate locations for the local items and contact files.
        // Rationale: this fallback script may be included from pages at different
        // path depths (for example /plugins/, /plugins/sub/, or the site root). A
        // single hardcoded relative path can fail when the nesting changes. We try
        // a short ordered list of likely locations and use the first one that
        // returns a JSON array successfully.
        var itemCandidates = [
          '../data/items.json',
          './data/items.json',
          '/data/items.json',
          'data/items.json',
          (window.location && window.location.origin ? window.location.origin + '/data/items.json' : '/data/items.json')
        ];

        function tryFetchJSON(candidates) {
          return new Promise(function (resolve) {
            var i = 0;
            function next() {
              if (i >= candidates.length) return resolve(null);
              var url = candidates[i++];
              try {
                fetch(url).then(function (r) {
                  if (!r || !r.ok) return next();
                  r.json().then(function (j) { resolve(j); }).catch(function () { next(); });
                }).catch(function () { next(); });
              } catch (e) { next(); }
            }
            next();
          });
        }

        tryFetchJSON(itemCandidates).then(function (json) {
          if (!json || !Array.isArray(json)) return;
          var contactCandidates = [
            '../data/contact.json',
            './data/contact.json',
            '/data/contact.json',
            'data/contact.json',
            (window.location && window.location.origin ? window.location.origin + '/data/contact.json' : '/data/contact.json')
          ];

          // Try contact.json in parallel; if none succeed we render without contact info.
          tryFetchJSON(contactCandidates).then(function (cjson) {
            try { renderFallback(el, json, cjson || null); } catch (e) { renderFallback(el, json, null); }
          }).catch(function () { try { renderFallback(el, json, null); } catch (e) { /* ignore */ } });
        }).catch(function () { /* ignore */ });
      } catch (e) { /* ignore */ }
    }, 1500);
  });
})();
