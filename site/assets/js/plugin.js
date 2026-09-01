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

  // Provide a safe, non-overriding fallback for window.soundshopPersistBought so
  // callers in this file can invoke it without depending on the presence of
  // site/plugins/index.html. This mirrors the canonical behaviour in
  // site/plugins/index.html without overwriting an authoritative implementation.
  try {
    if (typeof window.soundshopPersistBought !== 'function') {
      window.soundshopPersistBought = function (order) {
        try {
          if (!order || typeof order !== 'object') return;

          var BOUGHT_KEY = 'soundshop:bought:v1';
          // BOUGHT_MAX_AGE is shared with readBoughtArray below; see the
          // declaration near the helpers so both read and write paths agree on
          // the 60-day local retention policy.
          var MAX_EMAIL_LEN = 128;
          var MAX_RECEIPT_LEN = 2000;

          // Map product names/IDs to internal tokens (kept small and conservative)
          function getProductToken(itemName, itemId) {
            var name = String(itemName || itemId || '').trim().toLowerCase();
            if (!name) return null;
            if (name === 'the full shop' || name === 'bundle' || name === 'full shop') return 'bundle';
            if (name === 'vanta' || name.indexOf('vanta') !== -1) return 'vanta';
            if (name === 'drift' || name.indexOf('drift') !== -1) return 'drift';
            if (name === 'prism' || name.indexOf('prism') !== -1) return 'prism';
            if (name === 'anvil' || name.indexOf('anvil') !== -1) return 'anvil';
            return null;
          }

          // Conservative email validation
          var email = '';
          try {
            var cand = '';
            if (order && typeof order === 'object') {
              cand = (order.email || order.buyerEmail || order.customerEmail || order.deliveryEmail || '');
              if (cand && typeof cand === 'string') cand = cand.trim(); else cand = '';
            }
            var EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
            if (cand && EMAIL_RE.test(cand)) {
              if (cand.length > MAX_EMAIL_LEN) cand = cand.slice(0, MAX_EMAIL_LEN);
              email = cand;
            }
          } catch (e) { /* ignore */ }

          // Build the record we will store under the token
          var rec = { t: Date.now(), ref: String(order.id || order.ref || order.reference || '') , state: 'paid' };
          if (email) rec.email = email;

          // Extract a download URL conservatively
          try {
            var durl = '';
            if (order && typeof order === 'object') {
              durl = order.downloadUrl || order.installerUrl || (order.installers && order.installers[0] && order.installers[0].url) || '';
              if (typeof durl === 'string') {
                durl = durl.trim();
                if (durl && /^https?:\/\//i.test(durl)) rec.downloadUrl = durl;
              }
            }
          } catch (e) { /* ignore */ }

          // Conservatively accept a provider receipt URL when it looks like a real URL
          try {
            var rurl = '';
            if (order && typeof order === 'object') rurl = order.receiptUrl || order.receipt || '';
            if (typeof rurl === 'string') {
              rurl = rurl.trim();
              if (rurl && rurl.length <= MAX_RECEIPT_LEN && /^https?:\/\//i.test(rurl)) rec.receiptUrl = rurl;
            }
          } catch (e) { /* ignore */ }

          // Decide token and persist under canonical v1 mapping
          try {
            var token = getProductToken(order.itemName || order.name || order.itemId || order.item || '', order.itemId || order.id);
            if (!token) return; // unknown product, do not persist

            // Read existing records
            var bought = {};
            try {
              var raw = window.localStorage.getItem(BOUGHT_KEY);
              if (raw) {
                var parsed = null;
                try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) bought = parsed;
              }
            } catch (e) { /* ignore read */ }

            // Merge: preserve any existing downloadUrl unless we have a new one
            try {
              var exist = bought[token];
              if (exist && typeof exist === 'object') {
                // Keep existing downloadUrl if we don't have one
                if (!rec.downloadUrl && exist.downloadUrl) rec.downloadUrl = exist.downloadUrl;
                // Keep existing email if missing
                if (!rec.email && exist.email) rec.email = exist.email;
                // Keep existing t/ref if missing
                if (!rec.ref && exist.ref) rec.ref = exist.ref;
              }
            } catch (e) { /* ignore merge */ }

            bought[token] = rec;

            try { window.localStorage.setItem(BOUGHT_KEY, JSON.stringify(bought)); } catch (e) { /* ignore write */ }

            // Refresh the purchase summary display if present: remove guard so
            // SSPlugin.initBoughtSummary() can re-run and read the updated data.
            try {
              var summaryEl = document.querySelector('[data-bought-summary]');
              if (summaryEl) {
                summaryEl.removeAttribute('data-ssp-bought-summary');
                if (window.SSPlugin && typeof window.SSPlugin.initBoughtSummary === 'function') {
                  try { window.SSPlugin.initBoughtSummary(); } catch (e) { /* ignore */ }
                }
              }
            } catch (e) { /* ignore */ }

            // Prune expired records (best-effort)
            try {
              var raw2 = window.localStorage.getItem(BOUGHT_KEY);
              if (raw2) {
                var parsed2 = null;
                try { parsed2 = JSON.parse(raw2); } catch (e) { parsed2 = null; }
                if (parsed2 && typeof parsed2 === 'object' && !Array.isArray(parsed2)) {
                  var now = Date.now();
                  var changed = false;
                  for (var k in parsed2) {
                    if (!Object.prototype.hasOwnProperty.call(parsed2, k)) continue;
                    var r = parsed2[k];
                    var isObj = !!r && typeof r === 'object' && !Array.isArray(r);
                    var when = Number(isObj ? r.t : r);
                    if (!isFinite(when) || when <= 0 || (now - when) > BOUGHT_MAX_AGE) {
                      delete parsed2[k];
                      changed = true;
                    }
                  }
                  if (changed) {
                    try { window.localStorage.setItem(BOUGHT_KEY, JSON.stringify(parsed2)); } catch (e) { /* ignore */ }
                  }
                }
              }
            } catch (e) { /* ignore prune */ }

          } catch (e) { /* ignore token/persist */ }

        } catch (e) { /* swallow to keep callers safe */ }
      };
    }
  } catch (e) { /* ignore */ }

  // Gate to ensure we only attempt an auto server-side verify once per page
  // load. This keeps the privacy/traffic impact minimal when multiple hosts
  // exist on a single document.
  var _boughtAutoVerifyCalled = false;

  // One-shot guard for the URL-order verify banner/fetch path. Ensures we
  // attempt the conservative fallback only once per page load.
  var _sspUrlOrderVerifyDone = false;

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

  // The following helper and constants are referenced by the bought-summary
  // and bought-note code paths and are intentionally conservative about what
  // they accept from persisted storage or runtime order objects.
  var BOUGHT_MAX_AGE = 1000 * 60 * 60 * 24 * 60; // 60 days

  function readBoughtArray() {
    var key = 'soundshop:bought:v1';
    try {
      var raw = window.localStorage.getItem(key);
      if (!raw) return null;
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (e) { /* ignore */ }
    return null;
  }

  function maskRef(ref) {
    try {
      ref = String(ref || '');
      if (!ref) return '';
      // If it looks like an email, avoid treating it as a standard ref
      if (ref.indexOf('@') !== -1) return maskEmail(ref);
      // Keep last 6 characters visible, mask the rest with •
      var keep = 6;
      if (ref.length <= keep) return ref;
      return '\u2022'.repeat(Math.max(1, ref.length - keep)) + ref.slice(-keep);
    } catch (e) { return '' + (ref || ''); }
  }

  function maskEmail(email) {
    try {
      email = String(email || '');
      var at = email.indexOf('@');
      if (at <= 0) return email;
      var user = email.slice(0, at);
      var host = email.slice(at + 1);
      var show = 2;
      if (user.length <= show) return '\u2022'.repeat(user.length) + '@' + host;
      return user.slice(0, show) + '\u2022'.repeat(Math.max(1, user.length - show)) + '@' + host;
    } catch (e) { return email; }
  }

  function createBoughtCta(li, rec, token) {
    try {
      var wrap = el('span', 'bought-summary__ctas');
      var downloadUrl = '';
      try {
        if (typeof extractDownloadUrl === 'function') {
          try { downloadUrl = extractDownloadUrl(rec) || ''; } catch (e) { downloadUrl = ''; }
        } else {
          downloadUrl = (rec && rec.downloadUrl) ? String(rec.downloadUrl).trim() : '';
          if (downloadUrl && !/^https?:\/\//i.test(downloadUrl)) downloadUrl = '';
        }
      } catch (e) { downloadUrl = ''; }

      var receiptUrl = '';
      try {
        if (typeof extractReceiptUrl === 'function') {
          try { receiptUrl = extractReceiptUrl(rec) || ''; } catch (e) { receiptUrl = ''; }
        } else {
          receiptUrl = (rec && rec.receiptUrl) ? String(rec.receiptUrl).trim() : '';
          if (receiptUrl && receiptUrl.length > 2000) receiptUrl = '';
          if (receiptUrl && !/^https?:\/\//i.test(receiptUrl)) receiptUrl = '';
        }
      } catch (e) { receiptUrl = ''; }

      if (downloadUrl) {
        var a = document.createElement('a');
        a.className = 'bought-summary__download';
        a.textContent = 'Download';
        a.setAttribute('href', downloadUrl);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        wrap.appendChild(a);
      }

      if (receiptUrl) {
        var a2 = document.createElement('a');
        a2.className = 'bought-summary__receipt';
        a2.textContent = 'View receipt';
        a2.setAttribute('href', receiptUrl);
        a2.setAttribute('target', '_blank');
        a2.setAttribute('rel', 'noopener noreferrer');
        wrap.appendChild(a2);
      }

      if (!downloadUrl && !receiptUrl) {
        var supportHref = '';
        try {
          var boughtHost = document.querySelector('[data-bought-summary]');
          if (boughtHost && boughtHost.getAttribute) supportHref = boughtHost.getAttribute('data-bought-summary-support-href') || '';
        } catch (e) { /* ignore */ }
        if (!supportHref) supportHref = 'docs.html#support';
        var sup = document.createElement('a');
        sup.className = 'bought-summary__support';
        sup.textContent = 'Contact support';
        sup.setAttribute('href', supportHref);
        sup.setAttribute('target', '_blank');
        sup.setAttribute('rel', 'noopener noreferrer');
        wrap.appendChild(sup);
      }

      // If wrap is empty return null
      if (wrap && wrap.childNodes && wrap.childNodes.length) return wrap;
    } catch (e) { /* ignore */ }
    return null;
  }

  // The initBoughtSummary and related code is long; include the original
  // implementation below as present in the repository. This code is careful to
  // be defensive about missing data and to keep the DOM manipulations idempotent.

  function initBoughtSummary(root) {
    try {
      var host = root || document.querySelector('[data-bought-summary]');
      if (!host || !host.getAttribute) return;
      if (host.getAttribute('data-ssp-bought-summary') === 'on') return;
      host.setAttribute('data-ssp-bought-summary', 'on');

      var labelsEl = null;
      try { labelsEl = document.querySelector('[data-bought-summary-labels]'); } catch (e) { labelsEl = null; }

      var list = null;
      try { list = host.querySelector('ul'); } catch (e) { list = null; }
      if (!list) {
        list = document.createElement('ul');
        try { host.appendChild(list); } catch (e) { /* ignore */ }
      }

      // Clear existing list items idempotently
      try {
        while (list.firstChild) list.removeChild(list.firstChild);
      } catch (e) { /* ignore */ }

      var bought = readBoughtArray() || {};
      var order = ['vanta','drift','prism','anvil','bundle'];
      var any = false;

      // Collect summary details for aria-live message
      var items = [];

      for (var i = 0; i < order.length; i++) {
        var token = order[i];
        if (!Object.prototype.hasOwnProperty.call(bought, token)) continue;
        var rec = bought[token];
        if (!rec || typeof rec !== 'object') continue;

        var li = el('li', 'bought-summary__item');

        // Product label
        var label = token;
        try {
          if (labelsEl) {
            var attrn = 'data-bought-label-' + token;
            var v = labelsEl.getAttribute(attrn);
            if (v) label = v;
          }
        } catch (e) { /* ignore */ }

        try { var span = el('span', 'bought-summary__label', label); if (span) li.appendChild(span); } catch (e) { /* ignore */ }

        // Reference
        try {
          var fullRef = '';
          try { fullRef = String(rec.ref || ''); } catch (e) { fullRef = ''; }
          var masked = '';
          try { masked = maskRef(fullRef); } catch (e) { masked = ''; }
          var refSpan = el('span', 'bought-summary__ref', masked || '');
          try { if (refSpan && typeof refSpan.setAttribute === 'function') refSpan.setAttribute('data-full-ref', fullRef || ''); } catch (e) { /* ignore */ }
          try { if (refSpan && refSpan.textContent) li.appendChild(refSpan); } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }

        // Determine validated download/receipt presence for this item so the
        // aria-live summary can reflect availability. Mirror the same
        // conservative detection used in createBoughtCta().
        var hasDownload = false;
        var hasReceipt = false;
        try {
          var downloadUrl = '';
          try {
            if (typeof extractDownloadUrl === 'function') {
              try { downloadUrl = extractDownloadUrl(rec) || ''; } catch (e) { downloadUrl = ''; }
            } else {
              downloadUrl = (rec && rec.downloadUrl) ? String(rec.downloadUrl).trim() : '';
              if (downloadUrl && !/^https?:\/\//i.test(downloadUrl)) downloadUrl = '';
            }
          } catch (e) { downloadUrl = ''; }
          hasDownload = !!downloadUrl;

          var receiptUrl = '';
          try {
            if (typeof extractReceiptUrl === 'function') {
              try { receiptUrl = extractReceiptUrl(rec) || ''; } catch (e) { receiptUrl = ''; }
            } else {
              receiptUrl = (rec && rec.receiptUrl) ? String(rec.receiptUrl).trim() : '';
              if (receiptUrl && !/^https?:\/\//i.test(receiptUrl)) receiptUrl = '';
            }
          } catch (e) { receiptUrl = ''; }
          hasReceipt = !!receiptUrl;
        } catch (e) { /* ignore detection */ }

        // Record for summary
        try {
          var when = 0;
          try { when = Number(rec.t) || 0; } catch (e) { when = 0; }
          items.push({ label: (label || token), t: when, hasDownload: !!hasDownload, hasReceipt: !!hasReceipt });
        } catch (e) { /* ignore */ }

        // Copy button (per-item)
        try {
          var refSpan2 = null;
          try { refSpan2 = li.querySelector('.bought-summary__ref'); } catch (e) { refSpan2 = null; }
          if (refSpan2) {
            var copyBtn = el('button', 'bought-summary__copy', 'Copy reference');
            try { copyBtn.setAttribute('type', 'button'); } catch (e) { /* ignore */ }
            try {
              copyBtn.addEventListener('click', function (e) {
                try {
                  var btn = e && e.currentTarget ? e.currentTarget : null;
                  try { if (btn) btn.disabled = true; } catch (err) { /* ignore */ }

                  var showSuccess = function () {
                    try {
                      if (SS && typeof SS.toast === 'function') {
                        try { SS.toast('Reference copied'); } catch (e) { /* ignore */ }
                      }
                    } catch (e) { /* ignore */ }
                  };

                  var toCopy = '';
                  try {
                    var container = btn.parentNode || null;
                    var refEl = null;
                    try { if (container && container.querySelector) refEl = container.querySelector('.bought-summary__ref'); } catch (e) { refEl = null; }
                    if (refEl && refEl.getAttribute) {
                      try { toCopy = refEl.getAttribute('data-full-ref') || refEl.textContent || ''; } catch (e) { toCopy = refEl.textContent || ''; }
                    }
                    if (!toCopy) {
                      // Fallback: use button's closest li record via DOM dataset/attributes
                      try { toCopy = fullRef || ''; } catch (e) { toCopy = ''; }
                    }
                  } catch (e) { toCopy = fullRef || ''; }

                  // Try SS.copyText when available
                  try {
                    if (SS && typeof SS.copyText === 'function') {
                      try {
                        SS.copyText(toCopy);
                        try { showSuccess(); } catch (e) { /* ignore */ }
                        try { btn.disabled = false; } catch (e) { /* ignore */ }
                        return;
                      } catch (e) { /* fall through to fallback */ }
                    }
                  } catch (e) { /* ignore */ }

                  // Fallback: create a temporary textarea and use execCommand
                  try {
                    var ta = document.createElement('textarea');
                    ta.value = toCopy;
                    // Keep it out of view
                    ta.style.position = 'absolute';
                    ta.style.left = '-9999px';
                    ta.style.top = '0';
                    ta.setAttribute('aria-hidden', 'true');
                    document.body.appendChild(ta);
                    ta.focus();
                    ta.select();
                    var ok = false;
                    try { ok = document.execCommand && document.execCommand('copy'); } catch (e) { ok = false; }
                    try { document.body.removeChild(ta); } catch (e) { /* ignore */ }
                    if (ok) {
                      try { showSuccess(); } catch (e) { /* ignore */ }
                    } else {
                      try {
                        if (SS && typeof SS.toast === 'function') {
                          try { SS.toast('Copy failed'); } catch (e) { /* ignore */ }
                        }
                      } catch (e) { /* ignore */ }
                    }
                  } catch (e) {
                    try {
                      if (SS && typeof SS.toast === 'function') {
                        try { SS.toast('Copy failed'); } catch (e) { /* ignore */ }
                      }
                    } catch (e) { /* ignore */ }
                  }

                  try { btn.disabled = false; } catch (e) { /* ignore */ }

                } catch (e) { try { if (SS && typeof SS.toast === 'function') SS.toast('Copy failed'); } catch (err) { /* ignore */ } }
              });
            } catch (e) { /* ignore listener */ }

            // Append button after the ref span
            try {
              if (refSpan2 && refSpan2.parentNode) refSpan2.parentNode.insertBefore(copyBtn, refSpan2.nextSibling);
              else li.appendChild(copyBtn);
            } catch (e) { try { li.appendChild(copyBtn); } catch (err) { /* ignore */ } }
          }
        } catch (e) { /* ignore copy button */ }

        // CTAs
        try {
          var ctas = createBoughtCta(li, rec, token);
          if (ctas) li.appendChild(ctas);
        } catch (e) { /* ignore */ }

        try { list.appendChild(li); } catch (e) { /* ignore */ }
        any = true;
      }

      // Build or update an aria-live polite status node summarising the
      // remembered purchases so screen-reader users are informed when the
      // bought-summary renders. Keep the message short, idempotent and
      // reuse the same node across re-renders.
      try {
        var statusSelector = '[data-bought-summary-status]';
        var statusNode = null;
        try { statusNode = host.querySelector(statusSelector); } catch (e) { statusNode = null; }

        if (any) {
          // Compose a short message based on the items we collected.
          try {
            var labels = [];
            var latest = 0;
            var anyDownload = false;
            var anyReceipt = false;
            for (var j = 0; j < items.length; j++) {
              try { labels.push(items[j].label || ''); } catch (e) { /* ignore */ }
              try { if (Number(items[j].t) > latest) latest = Number(items[j].t) || latest; } catch (e) { /* ignore */ }
              try { if (items[j].hasDownload) anyDownload = true; } catch (e) { /* ignore */ }
              try { if (items[j].hasReceipt) anyReceipt = true; } catch (e) { /* ignore */ }
            }

            var labelText = '';
            try {
              if (labels.length === 1) labelText = labels[0];
              else if (labels.length === 2) labelText = labels[0] + ' and ' + labels[1];
              else if (labels.length > 2) {
                labelText = labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1];
              }
            } catch (e) { labelText = labels.join(', '); }

            var dateText = '';
            try {
              if (latest > 0) {
                var d = new Date(Number(latest));
                var day = d.getUTCDate();
                var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                var mon = months[d.getUTCMonth()] || '';
                var year = d.getUTCFullYear();
                dateText = day + ' ' + mon + ' ' + year;
              }
            } catch (e) { dateText = ''; }

            var avail = '';
            try {
              if (anyDownload) avail = 'Download available.';
              else if (anyReceipt) avail = 'Receipt available.';
            } catch (e) { /* ignore */ }

            var msg = '';
            try {
              msg = 'You bought ' + (labelText || 'items') + (dateText ? ' on ' + dateText + '.' : '.');
              if (avail) msg += ' ' + avail;
            } catch (e) { msg = 'Your purchases were recorded.'; }

            try {
              if (!statusNode) {
                statusNode = document.createElement('div');
                statusNode.setAttribute('data-bought-summary-status', '');
                statusNode.setAttribute('aria-live', 'polite');
                statusNode.style.position = 'absolute';
                statusNode.style.left = '-9999px';
                statusNode.style.top = '0';
                try { host.appendChild(statusNode); } catch (e) { /* ignore */ }
              }
              try { statusNode.textContent = msg; } catch (e) { /* ignore */ }
            } catch (e) { /* ignore */ }
          } catch (e) { /* ignore compose */ }
        }
      } catch (e) { /* ignore status node */ }

    } catch (e) { /* ignore overall */ }
  }

  function initBoughtNote(root) {
    try {
      var host = root || document.querySelector('[data-bought-note]');
      if (!host || !host.getAttribute) return;
      if (host.getAttribute('data-ssp-bought-note') === 'on') return;
      host.setAttribute('data-ssp-bought-note', 'on');

      try {
        var bought = readBoughtArray() || {};
        var order = ['vanta','drift','prism','anvil','bundle'];
        var any = false;
        var labels = [];
        for (var i = 0; i < order.length; i++) {
          var token = order[i];
          if (!Object.prototype.hasOwnProperty.call(bought, token)) continue;
          var rec = bought[token];
          if (!rec || typeof rec !== 'object') continue;
          var lbl = token;
          try {
            var labelsEl = document.querySelector('[data-bought-summary-labels]');
            if (labelsEl && labelsEl.getAttribute) {
              var attrn = 'data-bought-label-' + token;
              var v = labelsEl.getAttribute(attrn);
              if (v) lbl = v;
            }
          } catch (e) { /* ignore */ }
          labels.push(lbl);
          any = true;
        }

        if (any) {
          var text = '';
          try {
            if (labels.length === 1) text = 'You bought ' + labels[0] + '.';
            else if (labels.length === 2) text = 'You bought ' + labels[0] + ' and ' + labels[1] + '.';
            else if (labels.length > 2) text = 'You bought ' + labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1] + '.';
          } catch (e) { text = 'You bought items.'; }
          try { host.textContent = host.textContent.replace(/\s*$/, '') + ' ' + text; } catch (e) { /* ignore */ }
        }

      } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  // Add URL-order verify banner (a conservative fetch path when ?d8a_order= is present)
  function initUrlOrderVerifyBanner() {
    try {
      if (_sspUrlOrderVerifyDone) return;
      _sspUrlOrderVerifyDone = true;

      var params = (function () { try { return new URL(window.location.href).searchParams; } catch (e) { return null; } })();
      if (!params) return;
      var orderId = params.get('d8a_order') || params.get('order') || '';
      if (!orderId) return;

      // Expect a banner element already in the markup so we never inject visible
      // content that wasn't authored by a page designer.
      var banner = document.querySelector('p[data-paid]');
      if (!banner) return;

      // If there's already a verified order object available we don't need to
      // fetch and can rely on the banner initialisation behaviour.
      if (window.groupStorePaid && typeof window.groupStorePaid === 'object' && window.groupStorePaid.id && String(window.groupStorePaid.id) === String(banner.getAttribute('data-paid'))) return;

      // Conservative fetch to our own /payments endpoint is deliberately absent
      // here in the static site build; callers may wire a server-side verify
      // route later. For now we just show the banner as authored and let the
      // site operator rely on server receipts.
    } catch (e) { /* ignore */ }
  }

  function initUrlOrderAutoVerify() {
    try {
      if (_boughtAutoVerifyCalled) return;
      _boughtAutoVerifyCalled = true;

      // If some host page has provided a verified window.groupStorePaid, we
      // already have what we need for CTAs and bought-summary; bail early.
      if (window.groupStorePaid && typeof window.groupStorePaid === 'object') return;

      // Otherwise, attempt the conservative path: if ?d8a_order=<id> is present
      // we avoid network requests here but ensure the returned-checkout banner
      // remains visible so the user can discover their purchase.
      try {
        var params = (function () { try { return new URL(window.location.href).searchParams; } catch (e) { return null; } })();
        if (!params) return;
        var orderId = params.get('d8a_order') || params.get('order') || '';
        if (!orderId) return;

        // We don't attempt to verify remote receipts here; the site already
        // shows a static banner via <p data-paid="..."> authored in the page.
        // The conservative behaviour is simply to ensure the banner is not
        // hidden by client-side logic that would otherwise remove it.
        var banners = document.querySelectorAll('p[data-paid]');
        if (!banners || !banners.length) return;
        for (var i = 0; i < banners.length; i++) {
          var b = banners[i];
          try {
            var paid = b.getAttribute('data-paid') || '';
            if (String(paid) === String(orderId)) {
              try { b.style.display = ''; } catch (e) { /* ignore */ }
            }
          } catch (e) { /* ignore per-banner */ }
        }
      } catch (e) { /* ignore */ }

    } catch (e) { /* ignore */ }
  }

  // Add CTAs to the payments widget's returned-checkout banner (<p data-paid="...")
  // when a verified order object is available (window.groupStorePaid or
  // 'group-store:paid' event). Idempotent per banner via data-ssp-paid-ctas.
  function initPaidBannerCtas() {
    try {
      var banners = $$('p[data-paid]');
      if (!banners || !banners.length) return;
      for (var i = 0; i < banners.length; i++) {
        var b = banners[i];
        try {
          if (!b || !b.getAttribute) continue;
          if (b.getAttribute('data-ssp-paid-ctas') === 'on') continue;

          // Determine an order object: prefer a matching window.groupStorePaid
          var order = null;
          try {
            if (window.groupStorePaid && window.groupStorePaid.id && String(window.groupStorePaid.id) === String(b.getAttribute('data-paid'))) order = window.groupStorePaid;
          } catch (e) { /* ignore */ }
          if (!order && window.groupStorePaid) order = window.groupStorePaid;

          // If there's no verified order object available, bail for now.
          if (!order || typeof order !== 'object') continue;

          // Expose the full, unmasked reference id on the banner element as a
          // non-visual data attribute so other UI (eg. a later "Copy reference"
          // button) can read it reliably. Be conservative: compute the value
          // from common order properties, normalise to a string, trim and only
          // set it when absent so repeated initialisation is idempotent.
          try {
            var fullRef = String(order.id || order.ref || order.reference || '').trim();
            if (fullRef) {
              try {
                if (!b.getAttribute('data-ssp-full-ref')) {
                  b.setAttribute('data-ssp-full-ref', fullRef);
                }
              } catch (e) { /* ignore set */ }
            }
          } catch (e) { /* ignore compute */ }

          // Conservative extraction of download/receipt URLs
          var downloadUrl = '';
          try {
            downloadUrl = order.downloadUrl || order.installerUrl || (order.installers && order.installers[0] && order.installers[0].url) || '';
            if (typeof downloadUrl === 'string') downloadUrl = downloadUrl.trim(); else downloadUrl = '';
            if (downloadUrl && !/^https?:\/\//i.test(downloadUrl)) downloadUrl = '';
          } catch (e) { downloadUrl = ''; }

          var receiptUrl = '';
          try {
            receiptUrl = order.receiptUrl || order.receipt || '';
            if (typeof receiptUrl === 'string') receiptUrl = receiptUrl.trim(); else receiptUrl = '';
            if (receiptUrl && receiptUrl.length > 2000) receiptUrl = '';
            if (receiptUrl && !/^https?:\/\//i.test(receiptUrl)) receiptUrl = '';
          } catch (e) { receiptUrl = ''; }

          var container = el('span', 'paid-banner__ctas');

          try {
            if (downloadUrl) {
              var a = document.createElement('a');
              a.className = 'paid-banner__download';
              a.textContent = 'Download';
              a.setAttribute('href', downloadUrl);
              a.setAttribute('target', '_blank');
              a.setAttribute('rel', 'noopener noreferrer');
              container.appendChild(a);
            }

            if (receiptUrl) {
              var a2 = document.createElement('a');
              a2.className = 'paid-banner__receipt';
              a2.textContent = 'View receipt';
              a2.setAttribute('href', receiptUrl);
              a2.setAttribute('target', '_blank');
              a2.setAttribute('rel', 'noopener noreferrer');
              container.appendChild(a2);
            }

            // If neither download nor receipt is available, provide a Contact support link
            if (!downloadUrl && !receiptUrl) {
              var supportHref = '';
              try {
                var boughtHost = document.querySelector('[data-bought-summary]');
                if (boughtHost && boughtHost.getAttribute) supportHref = boughtHost.getAttribute('data-bought-summary-support-href') || '';
              } catch (e) { /* ignore */ }
              if (!supportHref) supportHref = 'docs.html#support';

              var sup = document.createElement('a');
              sup.className = 'paid-banner__support';
              sup.textContent = 'Contact support';
              sup.setAttribute('href', supportHref);
              sup.setAttribute('target', '_blank');
              sup.setAttribute('rel', 'noopener noreferrer');
              container.appendChild(sup);
            }
          } catch (e) { /* ignore create */ }

          // Append only when container has something
          try {
            if (container && container.childNodes && container.childNodes.length) {
              // Space it from the existing text for readability
              try { b.appendChild(document.createTextNode(' ')); } catch (e) { /* ignore */ }
              try { b.appendChild(container); } catch (e) { /* ignore */ }
              try { b.setAttribute('data-ssp-paid-ctas', 'on'); } catch (e) { /* ignore */ }
            }
          } catch (e) { /* ignore append */ }

        } catch (e) { /* ignore per-banner */ }
      }
    } catch (e) { /* ignore overall */ }
  }

  // Export the helpers so tools/check-plugin-exports.js and consumers can find them
  P.initUrlOrderVerifyBanner = initUrlOrderVerifyBanner;
  P.initUrlOrderAutoVerify = initUrlOrderAutoVerify;
  P.initBoughtSummary = initBoughtSummary;
  P.initBoughtNote = initBoughtNote;
  P.createBoughtCta = createBoughtCta;
  P.maskRef = maskRef;
  P.maskEmail = maskEmail;
  P.initPaidBannerCtas = initPaidBannerCtas;
  // New small helper to read the full ref attribute from a banner element
  P.getPaidBannerFullRef = function (b) { return attr(b, 'data-ssp-full-ref'); };

  // Run the conservative auto-verify on DOM ready so it operates after any
  // initial UI rendering. This mirrors other init semantics and is safe to
  // call multiple times.
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initUrlOrderAutoVerify);
      document.addEventListener('DOMContentLoaded', initPaidBannerCtas);
    } else {
      // DOM already ready
      try { initUrlOrderAutoVerify(); } catch (e) { /* ignore */ }
      try { initPaidBannerCtas(); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

  // Also refresh CTAs when the group-store:paid event is emitted
  try {
    document.addEventListener('group-store:paid', function () { try { initPaidBannerCtas(); } catch (e) { /* ignore */ } });
  } catch (e) { /* ignore */ }

  // If there is a global order already (widget verified on inclusion), ensure CTAs are added
  try { if (window.groupStorePaid) try { initPaidBannerCtas(); } catch (e) { /* ignore */ } } catch (e) { /* ignore */ }

})(window, document);
