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

  // Gate to ensure we only attempt an auto server-side verify once per page
  // load. This keeps the privacy/traffic impact minimal when multiple hosts
  // exist on a single document.
  var _boughtAutoVerifyCalled = false;

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

  /**
   * Extract a best-effort installer / download URL from an order-like object
   * and validate it. Returns a string URL when valid, otherwise null.
   */
  function extractDownloadUrl(obj) {
    try {
      if (!obj || typeof obj !== 'object') return null;
      var cand = obj.downloadUrl || obj.installerUrl || (obj.installers && obj.installers[0] && obj.installers[0].url) || '';
      if (typeof cand !== 'string') return null;
      cand = cand.trim();
      if (!cand) return null;
      // Accept only explicit http(s) URLs to limit exposure to data: or relative links
      if (/^https?:\/\//i.test(cand)) return cand;
    } catch (e) { /* ignore */ }
    return null;
  }

  /**
   * Read the persisted "bought" records and return an Array shape the rest of
   * plugin.js expects. This helper is conservative: it first honours a host
   * element's explicit data-* key (when provided and non-empty), then falls
   * back to the canonical localStorage key 'soundshop:bought:v1', and lastly
   * to the legacy 'soundshop.bought'. It accepts either the old Array form or
   * the v1 Object mapping and normalises the latter into an Array of records.
   */
  function readBoughtArray(host, dataAttrName) {
    try {
      // If the host supplied an explicit key, prefer it when non-empty.
      var hostKey = '';
      try { hostKey = host && dataAttrName ? attr(host, dataAttrName) || '' : ''; } catch (e) { hostKey = ''; }

      function parseMaybe(raw) {
        try {
          if (!raw) return null;
          var parsed = JSON.parse(raw);
          return parsed;
        } catch (e) { return null; }
      }

      function mapObjectToArray(obj) {
        var out = [];
        try {
          if (!obj || typeof obj !== 'object') return out;
          Object.keys(obj).forEach(function (k) {
            try {
              var r = obj[k];
              if (!r || typeof r !== 'object') return;
              var entry = {};
              entry.name = r.name || r.itemName || r.title || r.label || r.item || '';
              entry.ref = r.reference || r.order || r.id || r.ref || String(k || '');
              entry.email = r.email || r.deliveryEmail || r.buyerEmail || r.customerEmail || '';
              // quantity: accept numeric or numeric-string, otherwise default 1
              var q = null;
              try { q = typeof r.quantity === 'number' && isFinite(r.quantity) ? r.quantity : parseInt(r.quantity, 10); } catch (e) { q = null; }
              if (!isFinite(q)) {
                try { q = typeof r.qty === 'number' && isFinite(r.qty) ? r.qty : parseInt(r.qty, 10); } catch (e) { q = null; }
              }
              if (!isFinite(q)) q = 1;
              entry.quantity = q;
              // timestamp field when available
              entry.t = r.t || r.time || r.timestamp || null;
              // include a validated downloadUrl when present
              try { var d = extractDownloadUrl(r); if (d) entry.downloadUrl = d; } catch (e) { /* ignore */ }
              out.push(entry);
            } catch (e) { /* ignore individual entries */ }
          });
        } catch (e) { /* ignore mapping errors */ }
        return out;
      }

      // 1) Host-provided key
      if (hostKey) {
        try {
          var raw = '';
          try { raw = window.localStorage && window.localStorage.getItem(hostKey) || ''; } catch (e) { raw = ''; }
          var p = parseMaybe(raw);
          if (Array.isArray(p) && p.length) return p;
          if (p && typeof p === 'object' && !Array.isArray(p)) return mapObjectToArray(p);
        } catch (e) { /* ignore and continue */ }
      }

      // 2) Canonical v1 key
      try {
        var rawv1 = '';
        try { rawv1 = window.localStorage && window.localStorage.getItem('soundshop:bought:v1') || ''; } catch (e) { rawv1 = ''; }
        var pv1 = parseMaybe(rawv1);
        if (Array.isArray(pv1) && pv1.length) return pv1;
        if (pv1 && typeof pv1 === 'object' && !Array.isArray(pv1)) return mapObjectToArray(pv1);
      } catch (e) { /* ignore */ }

      // 3) Legacy key
      try {
        var fallbackKey = (host && dataAttrName) ? (attr(host, dataAttrName) || 'soundshop.bought') : 'soundshop.bought';
        var rawlegacy = '';
        try { rawlegacy = window.localStorage && window.localStorage.getItem(fallbackKey) || ''; } catch (e) { rawlegacy = ''; }
        var pleg = parseMaybe(rawlegacy);
        if (Array.isArray(pleg) && pleg.length) return pleg;
        if (pleg && typeof pleg === 'object' && !Array.isArray(pleg)) return mapObjectToArray(pleg);
      } catch (e) { /* ignore */ }

    } catch (e) { /* ignore helper errors */ }
    return [];
  }

  /* Helper to mask an email address for public display. */
  function maskEmail(email) {
    try {
      if (!email) return '';
      var s = String(email).trim();
      var parts = s.split('@');
      if (parts.length !== 2) return s.replace(/.(?=.{2,}$)/g, '*');
      var local = parts[0];
      var domain = parts[1];
      if (local.length <= 2) return local.replace(/.(?=.{1,}$)/g, '*') + '@' + domain;
      // show first and last char of local part, hide the middle
      return local.charAt(0) + '…' + local.charAt(local.length - 1) + '@' + domain;
    } catch (e) { return ''; }
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
    if (authorName) side.appendChild(el('span', 'preset__author', authorName));
    row.appendChild(side);

    return row;
  }

  P.initPresetTeaser = function (root) {
    $$('[data-presets-src]', root || document).forEach(function (host) {
      try {
        if (bound(host, 'presets')) return;

        var src = attr(host, 'data-presets-src');
        if (!src) return;

        var status = $('[data-presets-status]', host);
        var list = host.querySelector('[data-presets-list]') || host;

        host.setAttribute('data-presets-state', 'probing');
        if (status) status.textContent = 'Looking for presets…';

        window.fetch(src, { method: 'GET', cache: 'no-store' })
          .then(function (res) {
            if (!res || !res.ok) throw new Error('presets not published');
            return res.json();
          })
          .then(function (json) {
            try {
              var arr = normalisePresets(json);
              if (!arr.length) throw new Error('no presets');
              while (list.firstChild) list.removeChild(list.firstChild);
              arr.slice(0, intAttr(host, 'data-presets-count', 6)).forEach(function (p) { list.appendChild(presetRow(p)); });
              host.setAttribute('data-presets-state', 'loaded');
              if (status) status.textContent = '';
            } catch (e) {
              host.setAttribute('data-presets-state', 'absent');
              if (status) status.textContent = 'Preset library missing or malformed.';
            }
          })
          .catch(function () {
            host.setAttribute('data-presets-state', 'absent');
            if (status) status.textContent = 'Preset library missing or malformed.';
          });
      } catch (e) { /* ignore */ }
    });
  };

  /* =======================================================================
     04  BOUGHT NOTE
     ======================================================================= */

  P.initBoughtNote = function (root) {
    $$('[data-bought-note]', root || document).forEach(function (note) {
      try {
        if (bound(note, 'bought-note')) return;
        // Use the readBoughtArray helper which prefers an explicit host key,
        // then the canonical v1 key, then the legacy key, and returns an Array
        // shape the rest of plugin.js already expects.
        var arr = [];
        try { arr = readBoughtArray(note, 'data-bought-note') || []; } catch (e) { arr = []; }
        if (Array.isArray(arr) && arr.length) {
          try { note.hidden = false; } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore per-note */ }
    });
  };

  /* =======================================================================
     05  BOUGHT SUMMARY
     ======================================================================= */

  P.initBoughtSummary = function (root) {
    $$('[data-bought-summary]', root || document).forEach(function (host) {
      try {
        if (bound(host, 'bought-summary')) return;
        // Read persisted records using the helper. It returns an Array in the
        // legacy shape, or normalises a v1 object mapping into that Array shape.
        var arr = [];
        try { arr = readBoughtArray(host, 'data-bought-summary') || []; } catch (e) { arr = []; }
        if (!Array.isArray(arr) || !arr.length) return;

        var list = host.querySelector('[data-bought-summary-list]') || host;
        var validCount = 0;
        var madePerItemCta = false;

        // Track the first remembered payment reference that lacked a validated
        // download URL so we can attempt a single server-side verify for it.
        var firstRefToVerify = null;
        var firstRefLi = null;
        var firstRefDetail = null;

        arr.forEach(function (r) {
          try {
            if (!r || typeof r !== 'object') return;
            var li = document.createElement('li');
            li.className = 'bought__item';

            var label = String(r.name || r.itemName || r.title || r.label || 'Purchased item');
            var labelSpan = el('span', 'bought__label', label);
            var metaSpan = el('span', 'bought__meta');

            var email = r.email || r.deliveryEmail || r.buyerEmail || r.customerEmail || '';
            var ref = r.reference || r.order || r.id || r.ref || r.tx || '';

            if (ref) {
              if (metaSpan.textContent) metaSpan.appendChild(document.createTextNode(' '));
              metaSpan.appendChild(document.createTextNode('Order: '));
              try {
                var refWrap = el('span', 'bought__order', String(ref));
                refWrap.style.marginLeft = '4px';
                refWrap.style.color = 'var(--text-dim)';
                metaSpan.appendChild(refWrap);

                var revealBtn = document.createElement('button');
                revealBtn.setAttribute('type', 'button');
                revealBtn.className = 'bought__reveal';
                revealBtn.setAttribute('aria-pressed', 'false');
                revealBtn.textContent = 'Show';
                revealBtn.style.marginLeft = '8px';
                metaSpan.appendChild(revealBtn);

                (function (node, btn, fullText) {
                  try {
                    btn.addEventListener('click', function () {
                      try {
                        var revealed = btn.getAttribute('data-revealed') === '1';
                        if (revealed) {
                          node.textContent = fullText;
                          btn.textContent = 'Show';
                          btn.setAttribute('aria-pressed', 'false');
                          btn.setAttribute('data-revealed', '0');
                        } else {
                          node.textContent = fullText;
                          btn.textContent = 'Hide';
                          btn.setAttribute('aria-pressed', 'true');
                          btn.setAttribute('data-revealed', '1');
                        }
                      } catch (e) { /* ignore */ }
                    });
                  } catch (e) { /* ignore */ }
                })(refWrap, revealBtn, String(ref));

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
                })(emSpanNoRef, revealBtnNoRef, email);

              } catch (e) { /* ignore */ }
            }

            li.appendChild(labelSpan);
            li.appendChild(metaSpan);
            list.appendChild(li);
            // Count this rendered item so the host is unhidden below.
            validCount++;

            // If this remembered record includes a payment reference, inject
            // a per-item Order: … + Copy button directly into the list item.
            try {
              if (ref) {
                try {
                  var detail = { id: String(ref), itemName: label, quantity: r.quantity || 1, hasDeliveryEmail: !!r.email };
                  // Extract a remembered download URL when present and valid
                  try { var durl = extractDownloadUrl(r); if (durl) detail.downloadUrl = durl; } catch (e) { /* ignore */ }

                  // If we already have a direct download URL, render the
                  // per-item CTA immediately as before.
                  if (detail.downloadUrl) {
                    try { createBoughtCta(li, detail); madePerItemCta = true; } catch (e) { /* ignore */ }

                  } else {
                    // No direct URL remembered locally: offer a manual per-item
                    // "Check order" button so the user can trigger a verify
                    // for that single order. This is defensive and idempotent.
                    try {
                      // Build compact button
                      var checkBtn = document.createElement('button');
                      checkBtn.setAttribute('type', 'button');
                      checkBtn.className = 'bought__check';
                      checkBtn.textContent = 'Check order';
                      checkBtn.style.marginLeft = '8px';
                      checkBtn.setAttribute('aria-pressed', 'false');

                      // Guard so we don't bind twice
                      if (checkBtn.getAttribute('data-ssp-verify') !== 'on') {
                        checkBtn.setAttribute('data-ssp-verify', 'on');

                        (function (btn, liNode, hostNode, det) {
                          try {
                            btn.addEventListener('click', function () {
                              try {
                                // Disable repeated clicks while working
                                try { btn.disabled = true; } catch (e) { /* ignore */ }

                                // If the platform verification API is unavailable,
                                // show unavailable state and fall back to generic CTA
                                if (typeof window.groupStoreVerify !== 'function') {
                                  try { btn.textContent = 'Check order (unavailable)'; } catch (e) { /* ignore */ }
                                  try { createBoughtCta(hostNode, null); } catch (e) { /* ignore */ }
                                  return;
                                }

                                // Try to call the platform verifier. It must return a
                                // promise; otherwise treat as unavailable.
                                var p = null;
                                try { p = window.groupStoreVerify(String(det.id)); } catch (e) { p = null; }
                                if (!p || typeof p.then !== 'function') {
                                  try { btn.textContent = 'Check order (unavailable)'; } catch (e) { /* ignore */ }
                                  try { createBoughtCta(hostNode, null); } catch (e) { /* ignore */ }
                                  return;
                                }

                                // Await verification result and extract a download URL
                                p.then(function (order) {
                                  try {
                                    var found = null;
                                    try { found = extractDownloadUrl(order); } catch (e) { found = null; }
                                    if (found) {
                                      try {
                                        det.downloadUrl = found;
                                        createBoughtCta(liNode, det);
                                      } catch (e) { /* ignore */ }
                                    } else {
                                      try { createBoughtCta(hostNode, null); } catch (e) { /* ignore */ }
                                    }
                                  } catch (e) { try { createBoughtCta(hostNode, null); } catch (er) { /* ignore */ } }
                                }).catch(function () { try { createBoughtCta(hostNode, null); } catch (e) { /* ignore */ } });

                              } catch (e) { /* ignore click handler */ }
                            });
                          } catch (e) { /* ignore binding */ }
                        })(checkBtn, li, host, detail);

                        // Append the button into the meta area so it appears inline
                        try { metaSpan.appendChild(checkBtn); } catch (e) { /* ignore */ }

                        // Mark that we provided a per-item verify UI so the
                        // one-shot auto-verify does not run automatically.
                        madePerItemCta = true;
                      }

                    } catch (e) { /* ignore per-item verify UI errors */ }

                  }
                } catch (e) { /* ignore per-item CTA errors */ }

                // If there was no download URL on this remembered record and we
                // haven't recorded one to verify yet, remember it so we can do
                // a single server-side verification after rendering. Note that
                // if we inserted a manual per-item Check button above we set
                // madePerItemCta to avoid the auto-call; but we still capture
                // the first ref so that older pages or consumers can benefit.
                try {
                  if (!detail.downloadUrl && !firstRefToVerify) {
                    firstRefToVerify = String(ref);
                    firstRefLi = li;
                    firstRefDetail = detail;
                  }
                } catch (e) { /* ignore */ }
              }
            } catch (e) { /* ignore per-item */ }
          } catch (e) { /* ignore per-item */ }
        });

        } catch (e) { /* defensive: do not let this break the host */ }

        if (validCount) {
          host.hidden = false;
          // Ensure remembered-purchase summaries get the installers/support CTA too.
          try {
            if (!madePerItemCta) {
              // If we found a remembered ref that lacked a local download URL,
              // and the global groupStoreVerify API exists, attempt a single
              // server-side verification. This is a privacy-conscious one-shot
              // network call: only the first such ref triggers it, and only
              // when necessary.
              if (firstRefToVerify && !_boughtAutoVerifyCalled && typeof window.groupStoreVerify === 'function') {
                try {
                  _boughtAutoVerifyCalled = true;
                  var p = null;
                  try { p = window.groupStoreVerify(firstRefToVerify); } catch (e) { p = null; }
                  if (!p || typeof p.then !== 'function') {
                    // Verification unavailable; fall back to generic CTA
                    try { createBoughtCta(host, null); } catch (e) { /* ignore */ }
                  } else {
                    p.then(function (order) {
                      try {
                        var d = extractDownloadUrl(order);
                        if (d) {
                          try {
                            createBoughtCta(host, { downloadUrl: d });
                          } catch (e) { /* ignore */ }
                        } else {
                          try { createBoughtCta(host, null); } catch (e) { /* ignore */ }
                        }
                      } catch (e) { try { createBoughtCta(host, null); } catch (er) { /* ignore */ } }
                    }).catch(function () { try { createBoughtCta(host, null); } catch (e) { /* ignore */ } });
                  }
                } catch (e) { /* ignore */ }
              } else {
                try { createBoughtCta(host, null); } catch (e) { /* ignore */ }
              }
            }
          } catch (e) { /* ignore */ }
        }

      } catch (e) { /* ignore host */ }
    });
  };

  /* =======================================================================
     Remaining code: support verify initialiser bindings etc (unchanged)
     ======================================================================= */

  try { window.SS.ready(function () { P.initSupportVerify(); P.initBoughtNote(); P.initBoughtSummary(); }); } catch (e) { /* ignore */ }
  try { document.addEventListener('DOMContentLoaded', function () { P.initSupportVerify(); P.initBoughtNote(); P.initBoughtSummary(); }); } catch (e) { /* ignore */ }
  try { setTimeout(function () { P.initSupportVerify(); P.initBoughtNote(); P.initBoughtSummary(); }, 0); } catch (e) { /* ignore */ }

})(window, document);
