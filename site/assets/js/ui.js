/* =========================================================================
   SOUNDSHOP — ui.js
   Shared UI behaviour. Plain script, no modules, no dependencies.
   Safe to load on EVERY page: every feature no-ops when its markup is absent.

   Global namespace: window.SS

   CONTENTS
     01  Namespace & helpers  (SS.$, SS.$$, SS.on, SS.clamp, SS.fmt, SS.ready)
     02  Theme               (SS.initTheme, SS.getTheme, SS.setTheme)
     03  Mobile nav drawer   (SS.initNav)
     04  Header scrolled state (SS.initScrollState)
     05  Current-page nav marker (SS.initCurrentNav)
     06  Scroll reveal       (SS.initReveal)
     07  Clipboard + toast   (SS.copyText, SS.toast)
     08  Boot

   NOTE FOR MAINTAINERS: tools/check-links.js scans this file for
   href/src attributes, quoted network-request arguments, and arrays of two
   or more quoted strings. Never put a real relative file path in a string
   here, never assign a string literal to `.href`, and never write an array
   of two or more quoted strings. Runtime paths belong in data-* attributes.
   ========================================================================= */

(function (window, document) {
  'use strict';

  /* =======================================================================
     01  NAMESPACE & HELPERS
     ======================================================================= */

  var SS = (window.SS = window.SS || {});

  var THEME_KEY = 'ss-theme';
  var THEME_DARK = 'dark';
  var THEME_LIGHT = 'light';

  /** Query one element. SS.$(sel[, root]) -> Element|null */
  SS.$ = function (sel, root) {
    if (!sel) return null;
    try {
      return (root || document).querySelector(sel);
    } catch (e) {
      return null;
    }
  };

  /** Query many. SS.$$(sel[, root]) -> Array<Element> (always an array) */
  SS.$$ = function (sel, root) {
    if (!sel) return [];
    try {
      return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    } catch (e) {
      return [];
    }
  };

  /**
   * Add a listener. Accepts an Element, an array/NodeList of elements, or null.
   * Returns an off() function. SS.on(el, type, handler[, opts]) -> function
   */
  SS.on = function (target, type, handler, opts) {
    var list = [];
    if (!target || !type || typeof handler !== 'function') return function () {};
    if (target.nodeType || target === window || target === document) list = [target];
    else if (typeof target.length === 'number') list = Array.prototype.slice.call(target);
    else return function () {};

    list.forEach(function (el) {
      if (el && el.addEventListener) el.addEventListener(type, handler, opts);
    });

    return function off() {
      list.forEach(function (el) {
        if (el && el.removeEventListener) el.removeEventListener(type, handler, opts);
      });
    };
  };

  /** SS.clamp(value, min, max) -> number */
  SS.clamp = function (value, min, max) {
    var n = Number(value);
    var lo = Number(min);
    var hi = Number(max);
    if (!isFinite(n)) n = lo;
    if (lo > hi) { var t = lo; lo = hi; hi = t; }
    return n < lo ? lo : n > hi ? hi : n;
  };

  /** SS.lerp(a, b, t) -> number  (small extra, used by demo pages) */
  SS.lerp = function (a, b, t) {
    return Number(a) + (Number(b) - Number(a)) * Number(t);
  };

  /** SS.round(n, decimals) -> number */
  SS.round = function (n, decimals) {
    var d = Math.pow(10, decimals || 0);
    return Math.round(Number(n) * d) / d;
  };

  /**
   * SS.fmt(value[, decimals]) -> string
   * Grouped, fixed-decimal number formatting for .num readouts.
   * Sub-formatters: SS.fmt.money, SS.fmt.hz, SS.fmt.db, SS.fmt.ms,
   * SS.fmt.pct, SS.fmt.date.
   */
  SS.fmt = function (value, decimals) {
    var n = Number(value);
    var d = decimals == null ? 0 : Math.max(0, Math.min(6, decimals | 0));
    if (!isFinite(n)) return '--';
    try {
      return n.toLocaleString('en-US', {
        minimumFractionDigits: d,
        maximumFractionDigits: d
      });
    } catch (e) {
      return n.toFixed(d);
    }
  };

  SS.fmt.money = function (value, decimals) {
    var n = Number(value);
    if (!isFinite(n)) return '--';
    return '$' + SS.fmt(n, decimals == null ? 0 : decimals);
  };

  SS.fmt.hz = function (value) {
    var n = Number(value);
    if (!isFinite(n)) return '--';
    if (Math.abs(n) >= 1000) return SS.fmt(n / 1000, 2) + ' kHz';
    return SS.fmt(n, n < 100 ? 1 : 0) + ' Hz';
  };

  SS.fmt.db = function (value, decimals) {
    var n = Number(value);
    if (!isFinite(n)) return '--';
    var d = decimals == null ? 1 : decimals;
    return (n > 0 ? '+' : '') + SS.fmt(n, d) + ' dB';
  };

  SS.fmt.ms = function (value, decimals) {
    var n = Number(value);
    if (!isFinite(n)) return '--';
    if (Math.abs(n) >= 1000) return SS.fmt(n / 1000, decimals == null ? 2 : decimals) + ' s';
    return SS.fmt(n, decimals == null ? 0 : decimals) + ' ms';
  };

  SS.fmt.pct = function (value, decimals) {
    var n = Number(value);
    if (!isFinite(n)) return '--';
    return SS.fmt(n, decimals == null ? 0 : decimals) + '%';
  };

  /** SS.fmt.date('2026-08-01') -> '01 AUG 2026' (safe on bad input) */
  SS.fmt.date = function (value) {
    if (!value) return '';
    var d = value instanceof Date ? value : new Date(String(value));
    if (isNaN(d.getTime())) return String(value);
    var months = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ');
    var day = d.getUTCDate();
    return (day < 10 ? '0' + day : String(day)) + ' ' +
           months[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  };

  /** SS.ready(fn) — run now if the DOM is parsed, else on DOMContentLoaded. */
  SS.ready = function (fn) {
    if (typeof fn !== 'function') return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  };

  /** SS.prefersReducedMotion() -> boolean */
  SS.prefersReducedMotion = function () {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  };

  /* =======================================================================
     02  THEME
     localStorage can throw (private mode, blocked storage) — everything
     that touches it is wrapped.
     ======================================================================= */

  function readStoredTheme() {
    try {
      var v = window.localStorage.getItem(THEME_KEY);
      return v === THEME_LIGHT || v === THEME_DARK ? v : null;
    } catch (e) {
      return null;
    }
  }

  function writeStoredTheme(value) {
    try {
      window.localStorage.setItem(THEME_KEY, value);
    } catch (e) { /* storage unavailable — the page still works */ }
  }

  /* Set once the OS-preference listener below has been attached, so repeat
     calls to SS.initTheme() never stack listeners. */
  var osMediaBound = false;

  /* The OS preference, consulted only while no explicit choice is stamped on
     <html>. Falls back to dark when the browser cannot answer. */
  function osPrefersLight() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    } catch (e) {
      return false;
    }
  }

  /** SS.getTheme() -> 'dark' | 'light' (the theme actually applied) */
  SS.getTheme = function () {
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr === THEME_LIGHT) return THEME_LIGHT;
    if (attr === THEME_DARK) return THEME_DARK;
    /* No explicit choice — the stylesheet is following the OS. */
    return osPrefersLight() ? THEME_LIGHT : THEME_DARK;
  };

  /** SS.setTheme('light'|'dark'[, persist=true]) */
  SS.setTheme = function (theme, persist) {
    var next = theme === THEME_LIGHT ? THEME_LIGHT : THEME_DARK;
    document.documentElement.setAttribute('data-theme', next);
    if (persist !== false) writeStoredTheme(next);
    syncThemeToggles(next);
    try {
      document.dispatchEvent(new CustomEvent('ss:themechange', { detail: { theme: next } }));
    } catch (e) { /* CustomEvent unavailable — nothing depends on this */ }
    return next;
  };

  /** SS.toggleTheme() -> the theme now applied */
  SS.toggleTheme = function () {
    return SS.setTheme(SS.getTheme() === THEME_LIGHT ? THEME_DARK : THEME_LIGHT);
  };

  function syncThemeToggles(theme) {
    var isLight = theme === THEME_LIGHT;
    SS.$$('[data-theme-toggle]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', isLight ? 'true' : 'false');
      btn.setAttribute('aria-label', isLight ? 'Switch to dark theme' : 'Switch to light theme');
      btn.setAttribute('title', isLight ? 'Switch to dark theme' : 'Switch to light theme');
      var out = btn.querySelector('[data-theme-label]');
      if (out) out.textContent = isLight ? 'Light' : 'Dark';
    });
  }

  /**
   * SS.initTheme() — applies the stored theme and wires every
   * [data-theme-toggle] button. Safe to call more than once.
   *
   * With no stored choice the data-theme attribute is deliberately left OFF,
   * so the stylesheet's @media (prefers-color-scheme: light) block — which is
   * guarded as :root:not([data-theme="dark"]) — can follow the OS. Stamping
   * "dark" here would defeat it on every first visit.
   */
  SS.initTheme = function () {
    var stored = readStoredTheme();
    if (stored) {
      SS.setTheme(stored, false);
    } else {
      document.documentElement.removeAttribute('data-theme');
      syncThemeToggles(SS.getTheme());
      /* Keep the toggle's label/state honest if the OS flips mid-session. */
      try {
        var mq = osMediaBound ? null : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)'));
        if (mq) {
          osMediaBound = true;
          var onChange = function () {
            if (readStoredTheme()) return;
            syncThemeToggles(SS.getTheme());
          };
          if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
          else if (typeof mq.addListener === 'function') mq.addListener(onChange);
        }
      } catch (e) { /* matchMedia unavailable — nothing depends on this */ }
    }

    SS.$$('[data-theme-toggle]').forEach(function (btn) {
      if (btn.getAttribute('data-ss-bound') === 'theme') return;
      btn.setAttribute('data-ss-bound', 'theme');
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        SS.toggleTheme();
      });
    });

    syncThemeToggles(SS.getTheme());
  };

  /* =======================================================================
     03  MOBILE NAV DRAWER
     ======================================================================= */

  var navState = { open: false, toggle: null, nav: null, head: null };

  function setNavOpen(open) {
    if (!navState.toggle) return;
    navState.open = !!open;
    navState.toggle.setAttribute('aria-expanded', navState.open ? 'true' : 'false');
    document.documentElement.classList.toggle('nav-open', navState.open);
    if (navState.head) navState.head.classList.toggle('is-nav-open', navState.open);
  }

  /** SS.closeNav() / SS.openNav() / SS.toggleNav() */
  SS.closeNav = function () { setNavOpen(false); };
  SS.openNav = function () { setNavOpen(true); };
  SS.toggleNav = function () { setNavOpen(!navState.open); };

  SS.initNav = function () {
    var toggle = SS.$('[data-nav-toggle]');
    var nav = SS.$('.site-nav');
    if (!toggle || !nav) return;

    navState.toggle = toggle;
    navState.nav = nav;
    navState.head = SS.$('[data-head]') || SS.$('.site-head');

    toggle.setAttribute('aria-expanded', 'false');
    setNavOpen(false);

    toggle.addEventListener('click', function (ev) {
      ev.preventDefault();
      SS.toggleNav();
    });

    // Close on link activation inside the drawer.
    nav.addEventListener('click', function (ev) {
      var el = ev.target;
      while (el && el !== nav) {
        if (el.tagName === 'A') { SS.closeNav(); return; }
        el = el.parentNode;
      }
    });

    // Close on Escape, and return focus to the toggle.
    document.addEventListener('keydown', function (ev) {
      if (!navState.open) return;
      if (ev.key === 'Escape' || ev.key === 'Esc') {
        SS.closeNav();
        try { toggle.focus(); } catch (e) { /* ignore */ }
      }
    });

    // Close when the viewport grows past the drawer breakpoint.
    try {
      var mq = window.matchMedia('(min-width: 900px)');
      var onChange = function (e) { if (e.matches) SS.closeNav(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    } catch (e) { /* matchMedia unavailable */ }
  };

  /* =======================================================================
     04  HEADER SCROLLED STATE  — [data-scrolled] past ~8px
     ======================================================================= */

  SS.initScrollState = function () {
    var head = SS.$('[data-head]') || SS.$('.site-head');
    if (!head) return;

    var ticking = false;

    function apply() {
      ticking = false;
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;
      if (y > 8) {
        if (!head.hasAttribute('data-scrolled')) head.setAttribute('data-scrolled', '');
      } else if (head.hasAttribute('data-scrolled')) {
        head.removeAttribute('data-scrolled');
      }
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      if (window.requestAnimationFrame) window.requestAnimationFrame(apply);
      else apply();
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    apply();
  };

  /* =======================================================================
     05  CURRENT-PAGE NAV MARKER
     Works at any serve root: compares resolved pathnames, normalising a
     directory URL to its index document.
     ======================================================================= */

  function normalisePath(pathname) {
    var p = String(pathname || '');
    try { p = decodeURIComponent(p); } catch (e) { /* keep as is */ }
    p = p.replace(/\\/g, '/');
    if (p === '' || p.charAt(p.length - 1) === '/') p += 'index.html';
    return p.toLowerCase();
  }

  /** SS.initCurrentNav([root]) — sets aria-current="page" on the live link. */
  SS.initCurrentNav = function (root) {
    var scope = root || SS.$('.site-nav');
    if (!scope) return;

    var here = normalisePath(window.location.pathname);
    var links = SS.$$('a[href]', scope);
    var best = null;
    var bestLen = -1;

    links.forEach(function (link) {
      var raw = link.getAttribute('href');
      if (!raw || raw.charAt(0) === '#') return;
      var resolved;
      try {
        resolved = normalisePath(new URL(link.href, window.location.href).pathname);
      } catch (e) {
        return;
      }
      // Both paths are resolved against the same document base, so an exact
      // match is the reliable test at any serve root. A section link
      // (<dir>/index.html) additionally claims every page inside <dir>/, so
      // 'Plugins' stays lit on plugins/flagship.html. Matching on a bare
      // shared tail would be wrong: '/plugins/index.html' ends with
      // '/index.html', which would light Plugins on the home page.
      var section = resolved.replace(/index\.html$/, '');
      var isSection = section !== resolved && section.length > 1;
      var match = resolved === here ||
                  (isSection && here.indexOf(section) === 0);
      if (match && resolved.length > bestLen) {
        best = link;
        bestLen = resolved.length;
      }
    });

    links.forEach(function (link) { link.removeAttribute('aria-current'); });
    if (best) best.setAttribute('aria-current', 'page');
  };

  /* =======================================================================
     06  SCROLL REVEAL — [data-reveal] -> .is-visible
     ======================================================================= */

  function revealAll(nodes) {
    nodes.forEach(function (el) { el.classList.add('is-visible'); });
  }

  SS.initReveal = function (root) {
    var nodes = SS.$$('[data-reveal]', root || document);
    if (!nodes.length) return;

    if (!('IntersectionObserver' in window) || SS.prefersReducedMotion()) {
      revealAll(nodes);
      return;
    }

    // Stagger: an explicit data-reveal-delay (ms) wins; otherwise siblings
    // sharing a parent step by 60ms via the --i custom property.
    var counters = [];
    nodes.forEach(function (el) {
      var explicit = el.getAttribute('data-reveal-delay');
      if (explicit !== null && explicit !== '') {
        var ms = parseFloat(explicit);
        if (isFinite(ms)) {
          el.style.transitionDelay = ms + 'ms';
          return;
        }
      }
      var parent = el.parentNode;
      var slot = -1;
      for (var i = 0; i < counters.length; i++) {
        if (counters[i].parent === parent) { slot = i; break; }
      }
      if (slot === -1) {
        counters.push({ parent: parent, n: 0 });
        slot = counters.length - 1;
      }
      el.style.setProperty('--i', String(counters[slot].n));
      counters[slot].n += 1;
    });

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      });
    }, { threshold: 0.18, rootMargin: '0px 0px -4% 0px' });

    nodes.forEach(function (el) { io.observe(el); });

    // Anything already above the fold and untouched after load gets shown,
    // so nothing can be left permanently invisible.
    window.addEventListener('load', function () {
      nodes.forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.top < (window.innerHeight || 0) && r.bottom > 0) el.classList.add('is-visible');
      });
    }, { once: true });
  };

  /* =======================================================================
     07  CLIPBOARD + TOAST
     ======================================================================= */

  /** SS.copyText(text) -> Promise<boolean> */
  SS.copyText = function (text) {
    var value = text == null ? '' : String(text);

    function fallback() {
      return new Promise(function (resolve) {
        var ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.setAttribute('aria-hidden', 'true');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        var ok = false;
        try {
          ta.select();
          ta.setSelectionRange(0, ta.value.length);
          ok = document.execCommand('copy');
        } catch (e) {
          ok = false;
        }
        if (ta.parentNode) ta.parentNode.removeChild(ta);
        resolve(!!ok);
      });
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false) {
        return navigator.clipboard.writeText(value).then(function () { return true; }, fallback);
      }
    } catch (e) { /* fall through */ }

    return fallback();
  };

  /** SS.toast(message[, ms]) — transient confirmation, creates its own node. */
  var toastEl = null;
  var toastTimer = null;
  SS.toast = function (message, ms) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message == null ? '' : String(message);
    // Force a frame so the transition runs on repeat calls.
    void toastEl.offsetWidth;
    toastEl.classList.add('is-visible');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      if (toastEl) toastEl.classList.remove('is-visible');
    }, typeof ms === 'number' ? ms : 1800);
  };

  /**
   * Any element carrying data-copy="<text>" copies that text on click and
   * shows a toast. Optional data-copy-label overrides the toast message.
   */
  SS.initCopyButtons = function (root) {
    SS.$$('[data-copy]', root || document).forEach(function (el) {
      if (el.getAttribute('data-ss-bound') === 'copy') return;
      el.setAttribute('data-ss-bound', 'copy');
      el.addEventListener('click', function (ev) {
        ev.preventDefault();
        SS.copyText(el.getAttribute('data-copy')).then(function (ok) {
          SS.toast(ok ? (el.getAttribute('data-copy-label') || 'Copied') : 'Copy failed');
        });
      });
    });
  };

  /* =======================================================================
     08  BOOT
     ======================================================================= */

  // Theme is applied as early as possible to avoid a flash of the wrong
  // palette; it only needs <html>, which already exists.
  try { SS.initTheme(); } catch (e) { /* never block the page */ }

  SS.init = function () {
    try { SS.initTheme(); } catch (e) {}
    try { SS.initNav(); } catch (e) {}
    try { SS.initScrollState(); } catch (e) {}
    try { SS.initCurrentNav(); } catch (e) {}
    try { SS.initReveal(); } catch (e) {}
    try { SS.initCopyButtons(); } catch (e) {}
  };

  SS.ready(SS.init);
})(window, document);
