/* =========================================================================
   SOUNDSHOP — demo.js
   Page script for site/demo/flagship-demo.html (the playable VANTA rack).

   Owns:
     - the knob / fader widget (pointer, wheel, keyboard, ARIA)
     - segmented enum controls (radiogroup semantics)
     - programmatic rendering of the whole rack from SSSynth.PARAM_SPEC
     - one rAF loop driving scope + spectrum + meter + voice LEDs
     - the keybed (pointer + computer keyboard), preset bar, transport

   Depends on: window.SSSynth (assets/js/synth.js) and, optionally,
   window.SS (assets/js/ui.js) for theme, clipboard and toasts.
   No modules, no network beyond the preset file named by a data-attribute.
   ========================================================================= */

(function () {
  'use strict';

  var S = window.SSSynth || null;
  var SS = window.SS || {};

  /* ================================================================== *
   * 0.  Small helpers
   * ================================================================== */

  function $(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }
  function $$(sel, root) {
    try {
      return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    } catch (e) { return []; }
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function on(node, type, fn, opts) {
    if (node && node.addEventListener) node.addEventListener(type, fn, opts);
  }
  function reducedMotion() {
    if (typeof SS.prefersReducedMotion === 'function') {
      try { return !!SS.prefersReducedMotion(); } catch (e) { /* fall through */ }
    }
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { return false; }
  }

  /* Read a colour token off :root. Cached; refreshed on theme change. */
  var tokenCache = {};
  function token(name, fallback) {
    if (tokenCache[name] !== undefined) return tokenCache[name];
    var v = '';
    try {
      v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch (e) { v = ''; }
    tokenCache[name] = v || fallback;
    return tokenCache[name];
  }
  function clearTokens() { tokenCache = {}; }

  function rgba(hex, alpha) {
    var h = String(hex).trim();
    if (h.charAt(0) !== '#') return h;
    if (h.length === 4) {
      h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    }
    var r = parseInt(h.substr(1, 2), 16);
    var g = parseInt(h.substr(3, 2), 16);
    var b = parseInt(h.substr(5, 2), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return h;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function toast(msg) {
    if (typeof SS.toast === 'function') { try { SS.toast(msg); return; } catch (e) { /* ignore */ } }
  }

  /* ================================================================== *
   * 1.  Value <-> position mapping and formatting
   * ================================================================== */

  function decimalsOf(step) {
    var s = String(step);
    var i = s.indexOf('.');
    return i < 0 ? 0 : (s.length - i - 1);
  }

  function quantise(spec, v) {
    if (!isFinite(v)) return spec['default'];
    var st = spec.step || 0;
    if (st > 0) {
      v = spec.min + Math.round((v - spec.min) / st) * st;
      v = parseFloat(v.toFixed(Math.min(6, decimalsOf(st) + 1)));
    }
    return clamp(v, spec.min, spec.max);
  }

  function isLog(spec) { return spec.curve === 'log' && spec.min > 0; }

  function toPos(spec, v) {
    if (isLog(spec)) {
      return clamp(Math.log(v / spec.min) / Math.log(spec.max / spec.min), 0, 1);
    }
    if (spec.max === spec.min) return 0;
    return clamp((v - spec.min) / (spec.max - spec.min), 0, 1);
  }

  function fromPos(spec, p) {
    p = clamp(p, 0, 1);
    var v = isLog(spec)
      ? spec.min * Math.pow(spec.max / spec.min, p)
      : spec.min + p * (spec.max - spec.min);
    return quantise(spec, v);
  }

  function isBipolar(spec) { return spec.min < 0 && spec.max > 0; }

  /* Human-readable value, used for both the readout and aria-valuetext. */
  function fmtValue(spec, v) {
    var u = spec.unit;
    if (u === 'Hz') {
      if (v >= 10000) return (v / 1000).toFixed(1) + ' kHz';
      if (v >= 1000) return (v / 1000).toFixed(2) + ' kHz';
      return (v < 10 ? v.toFixed(2) : Math.round(v)) + ' Hz';
    }
    if (u === 's') {
      if (v === 0) return '0 ms';
      return v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s';
    }
    if (u === 'cents') {
      var c = Math.round(v);
      return (isBipolar(spec) && c > 0 ? '+' : '') + c + ' ct';
    }
    if (u === 'oct') {
      return (isBipolar(spec) && v > 0 ? '+' : '') + Math.round(v) + ' oct';
    }
    if (u === 'BPM') return Math.round(v) + ' BPM';
    if (u === 'Q') return 'Q ' + v.toFixed(1);
    if (spec.min === 0 && spec.max === 1) return Math.round(v * 100) + '%';
    return String(parseFloat(v.toFixed(decimalsOf(spec.step || 0.01))));
  }

  /* Arrow-key / wheel increment. Log params step in position space. */
  function nudge(spec, v, dir, big, fine) {
    var mult = big ? 10 : 1;
    if (isLog(spec)) {
      var p = toPos(spec, v) + dir * (fine ? 0.0025 : 0.01) * mult;
      var next = fromPos(spec, p);
      /* At the bottom of a log curve one percent of the sweep can be smaller
         than the step, which would leave the control stuck. Fall back to a
         single step in value space so a key press always moves something. */
      if (next === v) next = quantise(spec, v + dir * (spec.step || (spec.max - spec.min) / 100));
      return next;
    }
    var st = spec.step || (spec.max - spec.min) / 100;
    var inc = fine ? st : Math.max(st, Math.round(((spec.max - spec.min) / 100) / st) * st);
    if (!(inc > 0)) inc = st;
    return quantise(spec, v + dir * inc * mult);
  }

  /* ================================================================== *
   * 2.  Parameter plumbing — one registry, two-way bound
   * ================================================================== */

  var controls = {};     // name -> { spec, set(value) }
  var specByName = {};
  var PARAMS = (S && S.PARAM_SPEC) ? S.PARAM_SPEC : [];

  for (var i = 0; i < PARAMS.length; i++) specByName[PARAMS[i].name] = PARAMS[i];

  function currentValue(spec) {
    if (S && typeof S.getParam === 'function') {
      var v = S.getParam(spec.name);
      if (v !== undefined) return v;
    }
    return spec['default'];
  }

  /* UI -> engine. The engine echoes a 'param' event which re-syncs the UI. */
  function pushParam(name, value) {
    if (S && typeof S.setParam === 'function') S.setParam(name, value);
  }

  /* engine -> UI */
  function syncControl(name, value) {
    var c = controls[name];
    if (c && typeof c.set === 'function') c.set(value, true);
  }

  /* ================================================================== *
   * 3.  Continuous control: knob + fader share one interaction core
   * ================================================================== */

  var ARC_LEN = 113.1;   /* 24px radius over 270deg */
  var ARC_D = 'M13.03 46.97 A24 24 0 1 1 46.97 46.97';

  function bindContinuous(node, spec, read, write) {
    /* read() -> current value; write(value, fromUser) -> commit + render */
    var dragging = false;
    var startY = 0;
    var startPos = 0;
    var lastFine = false;
    var pointer = null;

    function rebase(e) {
      startY = e.clientY;
      startPos = toPos(spec, read());
      lastFine = !!e.shiftKey;
    }

    on(node, 'pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging = true;
      pointer = e.pointerId;
      rebase(e);
      node.classList.add('is-dragging');
      try { node.setPointerCapture(pointer); } catch (err) { /* ignore */ }
      try { node.focus({ preventScroll: true }); } catch (err) { node.focus(); }
      e.preventDefault();
    });

    on(node, 'pointermove', function (e) {
      if (!dragging || e.pointerId !== pointer) return;
      if (!!e.shiftKey !== lastFine) rebase(e);
      var travel = e.shiftKey ? 900 : 190;
      write(fromPos(spec, startPos + (startY - e.clientY) / travel), true);
      e.preventDefault();
    });

    function endDrag(e) {
      if (!dragging || (e && e.pointerId != null && e.pointerId !== pointer)) return;
      dragging = false;
      node.classList.remove('is-dragging');
      try { if (pointer != null) node.releasePointerCapture(pointer); } catch (err) { /* ignore */ }
      pointer = null;
    }
    on(node, 'pointerup', endDrag);
    on(node, 'pointercancel', endDrag);
    on(node, 'lostpointercapture', endDrag);

    on(node, 'wheel', function (e) {
      var dir = (e.deltaY || e.deltaX) > 0 ? -1 : 1;
      if (!dir) return;
      e.preventDefault();
      write(nudge(spec, read(), dir, false, e.shiftKey), true);
    }, { passive: false });

    on(node, 'dblclick', function (e) {
      e.preventDefault();
      write(spec['default'], true);
      toast(spec.label + ' reset');
    });

    on(node, 'keydown', function (e) {
      var k = e.key;
      var v = read();
      var next = null;
      if (k === 'ArrowUp' || k === 'ArrowRight') next = nudge(spec, v, 1, false, e.shiftKey);
      else if (k === 'ArrowDown' || k === 'ArrowLeft') next = nudge(spec, v, -1, false, e.shiftKey);
      else if (k === 'PageUp') next = nudge(spec, v, 1, true, false);
      else if (k === 'PageDown') next = nudge(spec, v, -1, true, false);
      else if (k === 'Home') next = spec.min;
      else if (k === 'End') next = spec.max;
      else if (k === 'Backspace' || k === 'Delete') next = spec['default'];
      if (next == null) return;
      e.preventDefault();
      write(next, true);
    });
  }

  function applyAria(node, spec, value) {
    node.setAttribute('aria-valuenow', String(value));
    node.setAttribute('aria-valuetext', fmtValue(spec, value));
  }

  /* --- knob ---------------------------------------------------------- */

  function makeKnob(spec, small) {
    var root = el('div', 'knob' + (small ? ' knob--sm' : ''));
    root.setAttribute('role', 'slider');
    root.setAttribute('tabindex', '0');
    root.setAttribute('aria-label', spec.label);
    root.setAttribute('aria-valuemin', String(spec.min));
    root.setAttribute('aria-valuemax', String(spec.max));
    root.setAttribute('data-param', spec.name);
    root.title = spec.label + ' — drag, scroll or use the arrow keys. Shift for fine, double-click to reset.';

    var ring = el('span', 'knob__ring');
    ring.innerHTML =
      '<svg viewBox="0 0 60 60" aria-hidden="true" focusable="false">' +
      '<path class="knob__track" d="' + ARC_D + '"></path>' +
      '<path class="knob__arc" d="' + ARC_D + '"></path>' +
      '</svg>';
    var arc = ring.querySelector('.knob__arc');
    var cap = el('span', 'knob__cap');
    var ind = el('span', 'knob__indicator');
    ring.appendChild(cap);
    ring.appendChild(ind);

    var label = el('span', 'knob__label', shortLabel(spec));
    var readout = el('span', 'knob__value num');

    root.appendChild(ring);
    root.appendChild(label);
    root.appendChild(readout);

    var value = currentValue(spec);

    function render(v) {
      var p = toPos(spec, v);
      var base = isBipolar(spec) ? toPos(spec, 0) : 0;
      var a = Math.min(p, base) * ARC_LEN;
      var seg = Math.abs(p - base) * ARC_LEN;
      if (arc) {
        arc.setAttribute('stroke-dasharray', '0 ' + a.toFixed(2) + ' ' + seg.toFixed(2) + ' ' + ARC_LEN);
        arc.setAttribute('stroke-dashoffset', '0');
      }
      ind.style.transform = 'rotate(' + (-135 + p * 270).toFixed(2) + 'deg)';
      readout.textContent = fmtValue(spec, v);
      root.classList.toggle('is-default', v === spec['default']);
      applyAria(root, spec, v);
    }

    function write(v, fromUser) {
      v = quantise(spec, v);
      if (v === value && fromUser) { render(v); return; }
      value = v;
      render(v);
      if (fromUser) pushParam(spec.name, v);
    }

    bindContinuous(root, spec, function () { return value; }, write);
    render(value);

    controls[spec.name] = { spec: spec, set: function (v) { write(v, false); }, el: root };
    return root;
  }

  /* --- fader (used for the envelope banks) ---------------------------- */

  function makeFader(spec, shortName) {
    var root = el('div', 'fader');
    root.setAttribute('role', 'slider');
    root.setAttribute('tabindex', '0');
    root.setAttribute('aria-label', spec.label);
    root.setAttribute('aria-valuemin', String(spec.min));
    root.setAttribute('aria-valuemax', String(spec.max));
    root.setAttribute('data-param', spec.name);
    root.title = spec.label + ' — drag, scroll or use the arrow keys. Shift for fine, double-click to reset.';

    var track = el('span', 'fader__track');
    var ticks = el('span', 'fader__ticks');
    var fill = el('span', 'fader__fill');
    var cap = el('span', 'fader__cap');
    track.appendChild(ticks);
    track.appendChild(fill);
    track.appendChild(cap);

    var label = el('span', 'fader__label', shortName || shortLabel(spec));
    var readout = el('span', 'fader__value num');

    root.appendChild(track);
    root.appendChild(label);
    root.appendChild(readout);

    var value = currentValue(spec);

    function render(v) {
      var p = toPos(spec, v);
      cap.style.bottom = 'calc(' + p.toFixed(4) + ' * (100% - 14px))';
      fill.style.height = 'calc(' + p.toFixed(4) + ' * (100% - 14px) + 7px)';
      readout.textContent = fmtValue(spec, v);
      applyAria(root, spec, v);
    }

    function write(v, fromUser) {
      v = quantise(spec, v);
      if (v === value && fromUser) { render(v); return; }
      value = v;
      render(v);
      if (fromUser) pushParam(spec.name, v);
    }

    bindContinuous(root, spec, function () { return value; }, write);
    render(value);

    controls[spec.name] = { spec: spec, set: function (v) { write(v, false); }, el: root };
    return root;
  }

  /* --- segmented enum control (radiogroup) ---------------------------- */

  /* A few enums read better with instrument shorthand than with prose. */
  var SHORT_OPTIONS = {
    arpRate: { '4': '1/4', '8': '1/8', '8t': '1/8T', '16': '1/16', '16t': '1/16T', '32': '1/32' }
  };

  function makeSeg(spec) {
    var root = el('div', 'seg');
    root.setAttribute('data-param', spec.name);
    var label = el('span', 'seg__label', shortLabel(spec));
    var group = el('div', 'seg__opts');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', spec.label);

    var buttons = [];
    var value = currentValue(spec);

    function select(v, fromUser) {
      value = v;
      for (var b = 0; b < buttons.length; b++) {
        var isOn = buttons[b].getAttribute('data-value') === String(v);
        buttons[b].setAttribute('aria-checked', isOn ? 'true' : 'false');
        buttons[b].setAttribute('tabindex', isOn ? '0' : '-1');
      }
      if (fromUser) pushParam(spec.name, v);
    }

    spec.options.forEach(function (opt, idx) {
      var b = el('button', 'seg__btn');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('data-value', opt);
      b.setAttribute('aria-checked', 'false');
      b.setAttribute('tabindex', '-1');
      var shorthand = SHORT_OPTIONS[spec.name] && SHORT_OPTIONS[spec.name][opt];
      b.textContent = shorthand || (spec.optionLabels && spec.optionLabels[idx]) || opt;
      if (shorthand) b.setAttribute('aria-label', spec.optionLabels[idx] || opt);
      on(b, 'click', function () { select(opt, true); });
      on(b, 'keydown', function (e) {
        var dir = 0;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') dir = 1;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') dir = -1;
        else if (e.key === 'Home') dir = -999;
        else if (e.key === 'End') dir = 999;
        else return;
        e.preventDefault();
        var next = dir === -999 ? 0
          : dir === 999 ? spec.options.length - 1
            : (idx + dir + spec.options.length) % spec.options.length;
        select(spec.options[next], true);
        var target = buttons[next];
        if (target) target.focus();
      });
      buttons.push(b);
      group.appendChild(b);
    });

    root.appendChild(label);
    root.appendChild(group);
    select(value, false);

    controls[spec.name] = { spec: spec, set: function (v) { select(v, false); }, el: root };
    return root;
  }

  /* Trim the group word out of a label: "Osc 1 Wave" stays, "Filter Attack"
     becomes "Attack" inside the Filter Envelope bank. */
  function shortLabel(spec) {
    var l = spec.label;
    if (spec.group === 'feg') l = l.replace(/^Filter\s+/, '');
    if (spec.group === 'amp') l = l.replace(/^Amp\s+/, '');
    if (spec.group === 'arp') l = l.replace(/^Arp\s+/, '');
    if (spec.group === 'lfo') l = l.replace(/^LFO\s+/, '');
    if (spec.group === 'master') l = l.replace(/^Master\s+/, '');
    return l;
  }

  /* ================================================================== *
   * 4.  Rack rendering — straight off PARAM_SPEC
   * ================================================================== */

  var SECTIONS = [
    { id: 'osc', tag: 'OSC', title: 'Oscillators', groups: ['osc'],
      note: 'Two oscillators, a sub, and the spread that keeps eight voices from agreeing.' },
    { id: 'filter', tag: 'Filter', title: 'Filter', groups: ['filter'],
      note: 'Ladder-style low pass with self-oscillating resonance, plus key tracking.' },
    { id: 'env', tag: 'Env', title: 'Envelopes', groups: ['feg', 'amp'], faders: true,
      subLabels: { feg: 'Filter envelope', amp: 'Amp envelope' },
      note: 'Two four-stage envelopes. Drag a cap, or focus it and use the arrow keys.' },
    { id: 'lfo', tag: 'LFO', title: 'LFO', groups: ['lfo'],
      note: 'One routable LFO: pitch, filter or amplitude, sample-and-hold included.' },
    { id: 'fx', tag: 'FX', title: 'Effects', groups: ['fx'],
      note: 'Drive into a ping-pong delay and a procedurally generated reverb.' },
    { id: 'arp', tag: 'Arp', title: 'Arpeggiator', groups: ['arp'],
      note: 'Hold a chord. Rates are host-free here, so the tempo control drives it.' }
  ];

  var SHORT_ENV = { A: 'Attack', D: 'Decay', S: 'Sustain', R: 'Release' };

  function specsIn(group) {
    return PARAMS.filter(function (p) { return p.group === group; });
  }

  function renderRack(host) {
    if (!host) return;
    SECTIONS.forEach(function (sec) {
      var panel = el('section', 'panel rack-sec rack-sec--' + sec.id);
      panel.id = 'rack-' + sec.id;
      panel.setAttribute('aria-label', sec.title);

      var head = el('div', 'panel__head rack-sec__head');
      head.appendChild(el('span', 'rack__group-label', sec.tag));
      var h = el('h2', 'rack-sec__title', sec.title);
      head.appendChild(h);
      var led = el('span', 'led push');
      led.setAttribute('data-sec-led', sec.id);
      head.appendChild(led);
      panel.appendChild(head);

      var body = el('div', 'panel__body rack-sec__body');

      sec.groups.forEach(function (g) {
        var list = specsIn(g);
        if (!list.length) return;

        var wrap = el('div', 'rack__group rack-sec__group');
        if (sec.subLabels && sec.subLabels[g]) {
          wrap.appendChild(el('span', 'rack__group-label', sec.subLabels[g]));
        }

        var enums = list.filter(function (p) { return p.type === 'enum'; });
        var ranges = list.filter(function (p) { return p.type !== 'enum'; });

        if (enums.length) {
          var segRow = el('div', 'rack-sec__segs');
          enums.forEach(function (p) { segRow.appendChild(makeSeg(p)); });
          wrap.appendChild(segRow);
        }
        if (ranges.length) {
          var row = el('div', 'rack__row');
          ranges.forEach(function (p) {
            if (sec.faders) {
              var initial = p.label.replace(/^(Filter|Amp)\s+/, '').charAt(0).toUpperCase();
              row.appendChild(makeFader(p, SHORT_ENV[initial] ? initial : shortLabel(p)));
            } else {
              row.appendChild(makeKnob(p));
            }
          });
          wrap.appendChild(row);
        }
        body.appendChild(wrap);
      });

      if (sec.note) {
        var foot = el('p', 'rack-sec__note', sec.note);
        body.appendChild(foot);
      }

      panel.appendChild(body);
      host.appendChild(panel);
    });

    /* MASTER lives beside the meter, in the screen panel. */
    var masterSlot = $('[data-master-slot]');
    if (masterSlot) {
      specsIn('master').forEach(function (p) { masterSlot.appendChild(makeKnob(p, true)); });
    }
  }

  /* Light the section LED whose parameter just moved. */
  var ledTimers = {};
  function pulseSection(name) {
    var spec = specByName[name];
    if (!spec) return;
    var secId = null;
    for (var s = 0; s < SECTIONS.length; s++) {
      if (SECTIONS[s].groups.indexOf(spec.group) >= 0) { secId = SECTIONS[s].id; break; }
    }
    if (!secId) return;
    var led = $('[data-sec-led="' + secId + '"]');
    if (!led) return;
    led.classList.add('is-on');
    if (ledTimers[secId]) window.clearTimeout(ledTimers[secId]);
    ledTimers[secId] = window.setTimeout(function () { led.classList.remove('is-on'); }, 320);
  }

  /* ================================================================== *
   * 5.  Keybed — 2.5 octaves, pointer + computer keyboard
   * ================================================================== */

  var WHITE = [0, 2, 4, 5, 7, 9, 11];
  var KEY_SPAN = 30;              /* semitones: C .. F, two and a half octaves */
  var keyNodes = {};              /* midi -> element */
  var soundingCount = {};         /* midi -> number of active sources */
  var keybedHost = null;

  function isWhite(semi) { return WHITE.indexOf(((semi % 12) + 12) % 12) >= 0; }

  function letterFor(offset) {
    if (!S || !S.KEYMAP) return '';
    for (var k in S.KEYMAP) {
      if (Object.prototype.hasOwnProperty.call(S.KEYMAP, k) && S.KEYMAP[k] === offset) return k;
    }
    return '';
  }

  function baseMidi() {
    var oct = (S && typeof S.getOctave === 'function') ? S.getOctave() : 4;
    return oct * 12 + 12;
  }

  function buildKeybed() {
    var keys = $('[data-keys]');
    if (!keys) return;
    keys.textContent = '';
    keyNodes = {};
    var base = baseMidi();

    for (var semi = 0; semi < KEY_SPAN; semi++) {
      if (!isWhite(semi)) continue;
      var midi = base + semi;
      var white = makeKey(midi, semi, false);
      /* The black key one semitone below hangs off this white key's left edge. */
      if (semi > 0 && !isWhite(semi - 1)) {
        white.appendChild(makeKey(base + semi - 1, semi - 1, true));
      }
      keys.appendChild(white);
    }
    refreshKeyStates();
  }

  function makeKey(midi, semi, black) {
    var node = el('span', 'keybed__key ' + (black ? 'keybed__key--black' : 'keybed__key--white'));
    node.setAttribute('data-midi', String(midi));
    node.setAttribute('aria-hidden', 'true');
    if (midi > 127 || midi < 0) node.classList.add('is-oob');

    var letter = letterFor(semi);
    if (((midi % 12) + 12) % 12 === 0) {
      node.classList.add('is-c');
      var mark = el('span', 'keybed__octave-mark', S ? S.midiToName(midi) : '');
      node.appendChild(mark);
    }
    if (letter) {
      node.appendChild(el('span', 'keybed__key-name', letter.toUpperCase()));
    }
    keyNodes[midi] = node;
    return node;
  }

  function refreshKeyStates() {
    for (var m in keyNodes) {
      if (!Object.prototype.hasOwnProperty.call(keyNodes, m)) continue;
      keyNodes[m].classList.toggle('is-down', (soundingCount[m] || 0) > 0);
    }
  }

  function markNote(midi, delta) {
    var key = String(midi);
    soundingCount[key] = Math.max(0, (soundingCount[key] || 0) + delta);
    var node = keyNodes[key];
    if (node) node.classList.toggle('is-down', soundingCount[key] > 0);
  }

  function initKeybedPointer() {
    keybedHost = $('[data-keybed]');
    if (!keybedHost) return;
    var active = {};   /* pointerId -> midi */

    function midiAt(x, y) {
      var target = document.elementFromPoint(x, y);
      if (!target) return -1;
      var node = target.closest ? target.closest('[data-midi]') : null;
      if (!node || node.classList.contains('is-oob')) return -1;
      var m = parseInt(node.getAttribute('data-midi'), 10);
      return isNaN(m) ? -1 : m;
    }

    function release(id) {
      if (active[id] == null) return;
      if (S) S.noteOff(active[id]);
      delete active[id];
    }

    on(keybedHost, 'pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      ensurePower();
      var m = midiAt(e.clientX, e.clientY);
      if (m < 0) return;
      e.preventDefault();
      try { keybedHost.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      active[e.pointerId] = m;
      if (S) S.noteOn(m, 0.9);
    });

    on(keybedHost, 'pointermove', function (e) {
      if (active[e.pointerId] == null) return;
      var m = midiAt(e.clientX, e.clientY);
      if (m < 0 || m === active[e.pointerId]) return;
      if (S) { S.noteOff(active[e.pointerId]); S.noteOn(m, 0.9); }
      active[e.pointerId] = m;
    });

    on(keybedHost, 'pointerup', function (e) { release(e.pointerId); });
    on(keybedHost, 'pointercancel', function (e) { release(e.pointerId); });
    on(keybedHost, 'lostpointercapture', function (e) { release(e.pointerId); });
    on(window, 'blur', function () {
      for (var id in active) {
        if (Object.prototype.hasOwnProperty.call(active, id)) release(id);
      }
    });
  }

  /* --- computer keyboard --------------------------------------------- */

  var downKeys = Object.create(null);

  function isTypingTarget(node) {
    if (!node || !node.tagName) return false;
    var tag = node.tagName.toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      var t = (node.getAttribute('type') || 'text').toLowerCase();
      return ['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color'].indexOf(t) < 0;
    }
    return !!node.isContentEditable;
  }

  function releaseAllKeys() {
    for (var k in downKeys) {
      if (Object.prototype.hasOwnProperty.call(downKeys, k)) {
        if (S) S.noteOff(downKeys[k]);
        delete downKeys[k];
      }
    }
  }

  function initTypingKeys() {
    if (!S) return;
    on(document, 'keydown', function (e) {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      var k = String(e.key || '').toLowerCase();

      if (k === (S.OCTAVE_KEYS && S.OCTAVE_KEYS.down)) { e.preventDefault(); shiftOctave(-1); return; }
      if (k === (S.OCTAVE_KEYS && S.OCTAVE_KEYS.up)) { e.preventDefault(); shiftOctave(1); return; }

      var m = S.keyToMidi(k);
      if (m < 0) return;
      e.preventDefault();
      if (downKeys[k] != null) return;
      ensurePower();
      downKeys[k] = m;
      S.noteOn(m, 0.85);
    });

    on(document, 'keyup', function (e) {
      var k = String(e.key || '').toLowerCase();
      if (downKeys[k] == null) return;
      S.noteOff(downKeys[k]);
      delete downKeys[k];
    });

    on(window, 'blur', releaseAllKeys);
    on(window, 'pagehide', releaseAllKeys);
    on(document, 'visibilitychange', function () {
      if (document.hidden) releaseAllKeys();
    });
  }

  function shiftOctave(delta) {
    if (!S) return;
    releaseAllKeys();
    S.shiftOctave(delta);
    soundingCount = {};
    buildKeybed();
    updateOctaveDisplay();
  }

  function updateOctaveDisplay() {
    var out = $('[data-oct-display]');
    if (!out || !S) return;
    var base = baseMidi();
    out.textContent = S.midiToName(base) + '–' + S.midiToName(Math.min(127, base + KEY_SPAN - 1));
  }

  /* ================================================================== *
   * 6.  Scope, spectrum, meter — one rAF loop for all of it
   * ================================================================== */

  var FMIN = 30, FMAX = 18000;
  var LOG_SPAN = Math.log(FMAX / FMIN);

  var scopeHost = null;
  var gridCv = null, specCv = null, traceCv = null;
  var gridCtx = null, specCtx = null, traceCtx = null;
  var cssW = 0, cssH = 0, dpr = 1;

  var waveBuf = null, specBuf = null, colBuf = null;
  var rafId = null;
  var motionOn = true;
  var frame = 0;

  var meterBar = null, meterPeak = null, meterClip = null;
  var peakHold = 0, peakTime = 0, clipTime = 0;
  var readLevel = null, readVoices = null, readNote = null, readRate = null;
  var voiceLeds = [];
  var lastNoteName = '—';

  function initScope() {
    scopeHost = $('[data-scope]');
    if (!scopeHost) return;
    gridCv = $('[data-layer="grid"]', scopeHost);
    specCv = $('[data-layer="spectrum"]', scopeHost);
    traceCv = $('[data-layer="trace"]', scopeHost);
    if (!gridCv || !specCv || !traceCv) return;
    gridCtx = gridCv.getContext('2d');
    specCtx = specCv.getContext('2d');
    traceCtx = traceCv.getContext('2d');

    var info = (S && S.getAnalyserInfo) ? S.getAnalyserInfo() : { fftSize: 2048, frequencyBinCount: 1024 };
    waveBuf = new Float32Array(info.fftSize || 2048);
    specBuf = new Uint8Array(info.frequencyBinCount || 1024);

    resizeScope();
    if (window.ResizeObserver) {
      try { new ResizeObserver(resizeScope).observe(scopeHost); } catch (e) { /* ignore */ }
    }
    on(window, 'resize', resizeScope);
    on(document, 'ss:themechange', function () { clearTokens(); drawGrid(); });
  }

  function resizeScope() {
    if (!scopeHost || !gridCv) return;
    var rect = scopeHost.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === cssW && h === cssH) return;
    cssW = w; cssH = h;
    [gridCv, specCv, traceCv].forEach(function (cv) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      var c = cv.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    colBuf = new Float32Array(Math.max(1, Math.ceil(w / 4)));
    drawGrid();
    drawFrame(true);
  }

  function xForFreq(f) {
    return cssW * clamp(Math.log(f / FMIN) / LOG_SPAN, 0, 1);
  }

  function drawGrid() {
    if (!gridCtx || !cssW) return;
    var c = gridCtx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, cssW, cssH);

    var line = token('--line-soft', '#1B1F23');
    var strong = token('--line', '#262B30');
    var mute = token('--text-mute', '#8A939B');

    c.lineWidth = 1;
    c.strokeStyle = line;
    var v;
    for (v = 1; v < 8; v++) {
      var x = Math.round((cssW / 8) * v) + 0.5;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, cssH); c.stroke();
    }
    for (v = 1; v < 4; v++) {
      var y = Math.round((cssH / 4) * v) + 0.5;
      c.beginPath(); c.moveTo(0, y); c.lineTo(cssW, y); c.stroke();
    }
    c.strokeStyle = strong;
    var mid = Math.round(cssH / 2) + 0.5;
    c.beginPath(); c.moveTo(0, mid); c.lineTo(cssW, mid); c.stroke();

    /* Log-frequency ticks for the spectrum half. */
    c.fillStyle = rgba(mute, 0.55);
    c.font = '9px ui-monospace, SFMono-Regular, Consolas, monospace';
    c.textBaseline = 'bottom';
    [[100, '100'], [1000, '1k'], [10000, '10k']].forEach(function (pair) {
      var fx = Math.round(xForFreq(pair[0])) + 0.5;
      c.strokeStyle = rgba(mute, 0.22);
      c.beginPath(); c.moveTo(fx, cssH - 14); c.lineTo(fx, cssH); c.stroke();
      c.fillText(pair[1], fx + 4, cssH - 3);
    });
  }

  function drawSpectrum() {
    if (!specCtx || !cssW || !colBuf) return;
    var c = specCtx;
    c.clearRect(0, 0, cssW, cssH);
    if (!S || !S.getSpectrum) return;
    S.getSpectrum(specBuf);

    var bins = specBuf.length;
    var nyq = (S.sampleRate || 48000) / 2;
    var cols = colBuf.length;
    var colW = cssW / cols;
    var accent = token('--accent', '#F2A93B');

    var grad = c.createLinearGradient(0, cssH, 0, cssH * 0.25);
    grad.addColorStop(0, rgba(accent, 0.10));
    grad.addColorStop(1, rgba(accent, 0.55));

    c.beginPath();
    c.moveTo(0, cssH);
    for (var i = 0; i < cols; i++) {
      var f0 = FMIN * Math.exp((i / cols) * LOG_SPAN);
      var f1 = FMIN * Math.exp(((i + 1) / cols) * LOG_SPAN);
      var b0 = (f0 / nyq) * bins;
      var b1 = (f1 / nyq) * bins;
      var mag = 0;
      if (b1 - b0 < 1) {
        var lo = Math.floor(b0);
        var hi = Math.min(bins - 1, lo + 1);
        var t = b0 - lo;
        mag = (specBuf[Math.min(bins - 1, lo)] || 0) * (1 - t) + (specBuf[hi] || 0) * t;
      } else {
        var start = Math.min(bins - 1, Math.floor(b0));
        var end = Math.min(bins - 1, Math.ceil(b1));
        for (var b = start; b <= end; b++) if (specBuf[b] > mag) mag = specBuf[b];
      }
      var target = mag / 255;
      colBuf[i] = Math.max(target, colBuf[i] * 0.90);
      var y = cssH - Math.pow(colBuf[i], 1.25) * cssH * 0.92;
      c.lineTo(i * colW, y);
      c.lineTo((i + 1) * colW, y);
    }
    c.lineTo(cssW, cssH);
    c.closePath();
    c.fillStyle = grad;
    c.fill();
    c.strokeStyle = rgba(accent, 0.75);
    c.lineWidth = 1;
    c.stroke();
  }

  function drawTrace(fresh) {
    if (!traceCtx || !cssW) return;
    var c = traceCtx;
    /* Persistence: fade the previous frame toward transparent, never toward
       a colour, so the grid layer below stays crisp in both themes. */
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = 'rgba(0,0,0,' + (fresh ? 1 : 0.24) + ')';
    c.fillRect(0, 0, cssW, cssH);
    c.globalCompositeOperation = 'source-over';

    if (!S || !S.getWaveform) return;
    S.getWaveform(waveBuf);

    var n = waveBuf.length;
    var half = n >> 1;
    /* Trigger on the first rising zero crossing so the trace stands still. */
    var trig = 0;
    for (var t = 1; t < half; t++) {
      if (waveBuf[t - 1] <= 0 && waveBuf[t] > 0) { trig = t; break; }
    }

    var cyan = token('--accent-2', '#4FD5D6');
    var mid = cssH / 2;
    var amp = cssH * 0.40;
    var step = cssW / half;

    c.beginPath();
    for (var i = 0; i < half; i++) {
      var s = waveBuf[trig + i] || 0;
      var y = mid - clamp(s, -1.4, 1.4) * amp;
      if (i === 0) c.moveTo(0, y); else c.lineTo(i * step, y);
    }
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.strokeStyle = rgba(cyan, 0.18);
    c.lineWidth = 5;
    c.stroke();
    c.strokeStyle = rgba(cyan, 0.95);
    c.lineWidth = 1.6;
    c.stroke();
  }

  function initMeter() {
    meterBar = $('[data-meter-bar]');
    meterPeak = $('[data-meter-peak]');
    meterClip = $('[data-meter-clip]');
    readLevel = $('[data-read-level]');
    readVoices = $('[data-read-voices]');
    readNote = $('[data-read-note]');
    readRate = $('[data-read-rate]');
    var ledHost = $('[data-voices]');
    if (ledHost) {
      ledHost.textContent = '';
      for (var v = 0; v < (S ? S.MAX_VOICES : 8); v++) {
        var led = el('span', 'led');
        ledHost.appendChild(led);
        voiceLeds.push(led);
      }
    }
  }

  function levelToPct(level) {
    if (!(level > 0.00025)) return 0;
    var db = 20 * Math.log10(level);
    return clamp((db + 60) / 60, 0, 1) * 100;
  }

  function drawMeter(now) {
    if (!S || !S.getLevel) return;
    var level = S.getLevel();
    var pct = levelToPct(level);
    if (meterBar) meterBar.style.width = pct.toFixed(1) + '%';
    if (pct >= peakHold || now - peakTime > 900) { peakHold = pct; peakTime = now; }
    else peakHold = Math.max(pct, peakHold - 0.35);
    if (meterPeak) meterPeak.style.left = clamp(peakHold, 0, 99.6).toFixed(1) + '%';
    if (meterClip) {
      if (level > 0.97) { clipTime = now; meterClip.classList.add('is-active'); }
      else if (now - clipTime > 1200) meterClip.classList.remove('is-active');
    }
    if (readLevel) {
      readLevel.textContent = level > 0.00025
        ? (20 * Math.log10(level)).toFixed(1) + ' dB'
        : '-inf dB';
    }
  }

  function drawStatus() {
    if (!S) return;
    if (readVoices && S.getVoiceStates) {
      var states = S.getVoiceStates();
      var live = 0;
      for (var v = 0; v < states.length; v++) {
        if (states[v].active) live++;
        if (voiceLeds[v]) voiceLeds[v].classList.toggle('is-on', !!states[v].active);
      }
      readVoices.textContent = live + '/' + (S.MAX_VOICES || 8) + ' voices';
    }
    if (readNote) readNote.textContent = lastNoteName;
    if (readRate) {
      readRate.textContent = S.sampleRate
        ? (S.sampleRate / 1000).toFixed(1) + ' kHz'
        : 'standby';
    }
  }

  function drawFrame(fresh) {
    var now = (window.performance && window.performance.now)
      ? window.performance.now()
      : Date.now();
    drawSpectrum();
    drawTrace(fresh);
    drawMeter(now);
    if (fresh || (frame % 4 === 0)) drawStatus();
  }

  function loop() {
    rafId = null;
    if (!motionOn || document.hidden || !S || !S.running) return;
    frame++;
    drawFrame(false);
    rafId = window.requestAnimationFrame(loop);
  }

  function ensureLoop() {
    if (rafId != null) return;
    if (!motionOn || document.hidden || !S || !S.running) return;
    rafId = window.requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (rafId != null) { window.cancelAnimationFrame(rafId); rafId = null; }
  }

  /* ================================================================== *
   * 7.  Power, transport, patch copy
   * ================================================================== */

  var root = null;
  var powerLed = null, powerState = null, standbyBtn = null;
  var powering = false;

  function setPowerUI(onState) {
    if (root) {
      if (onState) root.setAttribute('data-on', '');
      else root.removeAttribute('data-on');
    }
    if (powerLed) powerLed.classList.toggle('is-on', !!onState);
    if (powerState) powerState.textContent = onState ? 'Running' : 'Standby';
    if (standbyBtn) {
      standbyBtn.setAttribute('aria-pressed', onState ? 'true' : 'false');
      standbyBtn.textContent = onState ? 'Standby' : 'Power on';
    }
  }

  function ensurePower() {
    if (!S || !S.supported) return;
    if (S.running) return;
    if (powering) return;
    powering = true;
    S.start().then(function (ok) {
      powering = false;
      setPowerUI(!!ok);
      if (ok) { resizeScope(); ensureLoop(); }
    }, function () { powering = false; });
  }

  function initTransport() {
    root = $('[data-demo]');
    powerLed = $('[data-power-led]');
    powerState = $('[data-power-state]');
    standbyBtn = $('[data-standby]');

    var overlayBtn = $('[data-power-btn]');
    on(overlayBtn, 'click', ensurePower);

    on(standbyBtn, 'click', function () {
      if (!S || !S.supported) return;
      if (S.running) {
        releaseAllKeys();
        S.stop();
        stopLoop();
        setPowerUI(false);
        drawFrame(true);
      } else {
        ensurePower();
      }
    });

    on($('[data-panic]'), 'click', function () {
      releaseAllKeys();
      if (S) S.panic();
      soundingCount = {};
      refreshKeyStates();
      toast('All notes off');
    });

    var copyBtn = $('[data-copy-patch]');
    var copyTimer = null;
    on(copyBtn, 'click', function () {
      if (!S || !S.getParams) return;
      var patch = {
        name: currentPresetName || 'VANTA patch',
        author: 'Browser demo',
        params: S.getParams()
      };
      var text = JSON.stringify(patch, null, 2);
      var done = function (ok) {
        copyBtn.classList.toggle('is-active', !!ok);
        copyBtn.textContent = ok ? 'Patch copied' : 'Copy failed';
        toast(ok ? 'Patch JSON copied to the clipboard' : 'Clipboard unavailable');
        if (copyTimer) window.clearTimeout(copyTimer);
        copyTimer = window.setTimeout(function () {
          copyBtn.classList.remove('is-active');
          copyBtn.textContent = 'Copy patch';
        }, 1800);
      };
      if (typeof SS.copyText === 'function') {
        SS.copyText(text).then(done, function () { done(false); });
      } else {
        done(legacyCopy(text));
      }
    });

    on($('[data-oct-down]'), 'click', function () { shiftOctave(-1); });
    on($('[data-oct-up]'), 'click', function () { shiftOctave(1); });

    /* Reduced motion: the scope holds a single frame until it is asked not to. */
    var motionBtn = $('[data-scope-motion]');
    motionOn = !reducedMotion();
    if (motionBtn) {
      if (motionOn) {
        motionBtn.hidden = true;
      } else {
        motionBtn.hidden = false;
        motionBtn.setAttribute('aria-pressed', 'false');
        on(motionBtn, 'click', function () {
          motionOn = !motionOn;
          motionBtn.setAttribute('aria-pressed', motionOn ? 'true' : 'false');
          motionBtn.textContent = motionOn ? 'Freeze scope' : 'Animate scope';
          if (motionOn) ensureLoop(); else { stopLoop(); drawFrame(true); }
        });
      }
    }

    on(document, 'visibilitychange', function () {
      if (document.hidden) stopLoop(); else ensureLoop();
    });
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  /* ================================================================== *
   * 8.  Presets
   * ================================================================== */

  /* Shipped with the page so the demo still has a patch bank when it is
     opened straight off the filesystem, where fetch() cannot read a file. */
  var FALLBACK_PRESETS = [
    {
      name: 'Cold Storage',
      desc: 'Wide eight-voice pad, slow filter swell, long tail.',
      tags: ['pad', 'wide'],
      params: {
        osc1wave: 'sawtooth', osc2wave: 'sawtooth', osc2Oct: 0, detune: 26,
        subWave: 'sine', subLevel: 0.28, glide: 0,
        filtType: 'lowpass', cutoff: 620, reso: 4.2, fegAmt: 1800, keyTrack: 0.4,
        fegA: 0.9, fegD: 2.4, fegS: 0.35, fegR: 3.2,
        ampA: 1.1, ampD: 2.4, ampS: 0.85, ampR: 3.4,
        lfoWave: 'triangle', lfoRate: 0.24, lfoDepth: 0.16, lfoTarget: 'cutoff',
        drive: 0.12, delayTime: 0.62, delayFb: 0.36, delayDamp: 3200, delayMix: 0.24,
        revSize: 0.9, revMix: 0.52, arpOn: 'off', volume: 0.7
      }
    },
    {
      name: 'Ladder Keys',
      desc: 'Short envelope, high resonance, the sound the ladder was built for.',
      tags: ['keys', 'classic'],
      params: {
        osc1wave: 'sawtooth', osc2wave: 'square', osc2Oct: 0, detune: 9,
        subWave: 'sine', subLevel: 0.34, glide: 0,
        filtType: 'lowpass', cutoff: 1450, reso: 7.5, fegAmt: 2800, keyTrack: 0.55,
        fegA: 0.005, fegD: 0.42, fegS: 0.12, fegR: 0.35,
        ampA: 0.004, ampD: 0.9, ampS: 0.32, ampR: 0.55,
        lfoDepth: 0.04, lfoTarget: 'cutoff', lfoRate: 5.1,
        drive: 0.26, delayTime: 0.28, delayFb: 0.28, delayMix: 0.16,
        revSize: 0.45, revMix: 0.2, arpOn: 'off', volume: 0.78
      }
    },
    {
      name: 'Rubber Bass',
      desc: 'Sub-heavy, glide on, filter closed down to the knuckles.',
      tags: ['bass', 'mono'],
      params: {
        osc1wave: 'sawtooth', osc2wave: 'square', osc2Oct: -1, detune: 4,
        subWave: 'square', subLevel: 0.8, glide: 0.055,
        filtType: 'lowpass', cutoff: 340, reso: 9.5, fegAmt: 2400, keyTrack: 0.7,
        fegA: 0.002, fegD: 0.22, fegS: 0.08, fegR: 0.2,
        ampA: 0.003, ampD: 0.5, ampS: 0.55, ampR: 0.28,
        lfoDepth: 0, lfoTarget: 'off',
        drive: 0.42, delayMix: 0.05, revMix: 0.08, arpOn: 'off', volume: 0.8
      }
    },
    {
      name: 'Sixteen Steps',
      desc: 'Arpeggiator up, tight gate, delay doing the rest of the work.',
      tags: ['arp', 'sequence'],
      params: {
        osc1wave: 'square', osc2wave: 'sawtooth', osc2Oct: 1, detune: 14,
        subWave: 'sine', subLevel: 0.22, glide: 0,
        filtType: 'lowpass', cutoff: 2100, reso: 6, fegAmt: 2600, keyTrack: 0.5,
        fegA: 0.002, fegD: 0.16, fegS: 0.05, fegR: 0.18,
        ampA: 0.002, ampD: 0.26, ampS: 0.2, ampR: 0.22,
        lfoDepth: 0.05, lfoTarget: 'cutoff', lfoRate: 0.9, lfoWave: 'triangle',
        drive: 0.3, delayTime: 0.24, delayFb: 0.46, delayDamp: 5200, delayMix: 0.32,
        revSize: 0.5, revMix: 0.22,
        arpOn: 'on', arpMode: 'up', arpRate: '16', arpBpm: 118, arpOct: 2, arpGate: 0.42,
        volume: 0.72
      }
    },
    {
      name: 'Broken Tape',
      desc: 'Slow pitch LFO and a feedback path that is only just holding on.',
      tags: ['broken', 'texture'],
      params: {
        osc1wave: 'triangle', osc2wave: 'sawtooth', osc2Oct: 0, detune: 42,
        subWave: 'triangle', subLevel: 0.4, glide: 0.12,
        filtType: 'lowpass', cutoff: 900, reso: 5, fegAmt: 900, keyTrack: 0.3,
        fegA: 0.4, fegD: 1.6, fegS: 0.4, fegR: 1.4,
        ampA: 0.25, ampD: 1.4, ampS: 0.6, ampR: 2.2,
        lfoWave: 'sine', lfoRate: 0.31, lfoDepth: 0.55, lfoTarget: 'pitch',
        drive: 0.55, delayTime: 0.78, delayFb: 0.74, delayDamp: 2200, delayMix: 0.38,
        revSize: 0.8, revMix: 0.4, arpOn: 'off', volume: 0.68
      }
    },
    {
      name: 'Glass Bell',
      desc: 'Sine and triangle, hard filter envelope, almost no sustain.',
      tags: ['bell', 'plucked'],
      params: {
        osc1wave: 'sine', osc2wave: 'triangle', osc2Oct: 1, detune: 6,
        subWave: 'sine', subLevel: 0.16, glide: 0,
        filtType: 'bandpass', cutoff: 2600, reso: 8, fegAmt: 3600, keyTrack: 0.85,
        fegA: 0.001, fegD: 0.9, fegS: 0.02, fegR: 0.9,
        ampA: 0.002, ampD: 1.5, ampS: 0.06, ampR: 1.6,
        lfoWave: 'sine', lfoRate: 6.5, lfoDepth: 0.06, lfoTarget: 'amp',
        drive: 0.1, delayTime: 0.44, delayFb: 0.42, delayDamp: 7000, delayMix: 0.3,
        revSize: 0.75, revMix: 0.45, arpOn: 'off', volume: 0.74
      }
    },
    {
      name: 'Bad Acoustics',
      desc: 'Sample-and-hold on the filter, band-pass, deliberately unstable.',
      tags: ['texture', 'random'],
      params: {
        osc1wave: 'square', osc2wave: 'square', osc2Oct: -1, detune: 34,
        subWave: 'square', subLevel: 0.3, glide: 0.02,
        filtType: 'bandpass', cutoff: 1100, reso: 14, fegAmt: 600, keyTrack: 0.2,
        fegA: 0.06, fegD: 0.7, fegS: 0.3, fegR: 0.7,
        ampA: 0.02, ampD: 0.9, ampS: 0.55, ampR: 0.9,
        lfoWave: 'sh', lfoRate: 7.4, lfoDepth: 0.62, lfoTarget: 'cutoff',
        drive: 0.48, delayTime: 0.33, delayFb: 0.55, delayDamp: 3000, delayMix: 0.3,
        revSize: 0.66, revMix: 0.34,
        arpOn: 'on', arpMode: 'random', arpRate: '16t', arpBpm: 96, arpOct: 2, arpGate: 0.7,
        volume: 0.66
      }
    },
    {
      name: 'Two In The Morning',
      desc: 'Detuned unison lead with just enough drift to sound tired.',
      tags: ['lead', 'drift'],
      params: {
        osc1wave: 'sawtooth', osc2wave: 'sawtooth', osc2Oct: 0, detune: 52,
        subWave: 'triangle', subLevel: 0.42, glide: 0.03,
        filtType: 'lowpass', cutoff: 2400, reso: 3.2, fegAmt: 1500, keyTrack: 0.6,
        fegA: 0.05, fegD: 1.1, fegS: 0.45, fegR: 0.8,
        ampA: 0.03, ampD: 1.2, ampS: 0.75, ampR: 0.9,
        lfoWave: 'triangle', lfoRate: 4.8, lfoDepth: 0.1, lfoTarget: 'pitch',
        drive: 0.38, delayTime: 0.4, delayFb: 0.4, delayDamp: 4600, delayMix: 0.26,
        revSize: 0.62, revMix: 0.3, arpOn: 'off', volume: 0.76
      }
    }
  ];

  var presets = [];
  var presetIndex = -1;
  var currentPresetName = '';
  var presetSelect = null, presetDesc = null, presetSource = null;

  function normalisePresets(raw) {
    var list = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw && Array.isArray(raw.presets)) list = raw.presets;
    else if (raw && Array.isArray(raw.items)) list = raw.items;
    else if (raw && typeof raw === 'object') {
      list = Object.keys(raw).map(function (k) {
        var v = raw[k];
        if (v && typeof v === 'object' && !v.name) v.name = k;
        return v;
      });
    }

    var out = [];
    list.forEach(function (entry) {
      if (!entry || typeof entry !== 'object') return;
      var params = (entry.params && typeof entry.params === 'object') ? entry.params : entry;
      var clean = {};
      var count = 0;
      for (var k in params) {
        if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
        if (!specByName[k]) continue;
        clean[k] = params[k];
        count++;
      }
      if (!count) return;
      var tags = Array.isArray(entry.tags) ? entry.tags.slice(0, 4) : [];
      out.push({
        name: String(entry.name || entry.title || 'Preset').trim(),
        desc: String(entry.desc || entry.description || entry.notes || '').trim(),
        category: String(entry.category || entry.group || '').trim(),
        tags: tags,
        params: clean
      });
    });
    return out;
  }

  function presetOption(idx, p) {
    var opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = p.name;
    return opt;
  }

  function fillPresetSelect() {
    if (!presetSelect) return;
    presetSelect.textContent = '';

    /* Group by category when the library provides one for every patch. */
    var cats = [];
    var grouped = presets.length > 0;
    presets.forEach(function (p) {
      if (!p.category) { grouped = false; return; }
      if (cats.indexOf(p.category) < 0) cats.push(p.category);
    });

    if (grouped && cats.length > 1) {
      cats.forEach(function (cat) {
        var g = document.createElement('optgroup');
        g.label = cat;
        presets.forEach(function (p, idx) {
          if (p.category === cat) g.appendChild(presetOption(idx, p));
        });
        presetSelect.appendChild(g);
      });
    } else {
      presets.forEach(function (p, idx) { presetSelect.appendChild(presetOption(idx, p)); });
    }
    presetSelect.disabled = presets.length === 0;
  }

  function loadPreset(idx, announce) {
    if (!presets.length) return;
    presetIndex = ((idx % presets.length) + presets.length) % presets.length;
    var p = presets[presetIndex];
    currentPresetName = p.name;
    if (presetSelect) presetSelect.value = String(presetIndex);
    if (presetDesc) {
      var body = p.desc || (p.tags.length ? p.tags.join(' · ') : '');
      presetDesc.textContent = (p.category ? p.category + ' · ' : '') + body;
    }
    if (S && S.loadPreset) S.loadPreset(p.params);
    if (announce) toast('Loaded “' + p.name + '”');
  }

  function initPresets() {
    var host = $('[data-presets]');
    if (!host) return;
    presetSelect = $('[data-preset-select]', host);
    presetDesc = $('[data-preset-desc]', host);
    presetSource = $('[data-preset-source]', host);

    function adopt(list, sourceLabel) {
      presets = list;
      fillPresetSelect();
      if (presetSource) presetSource.textContent = sourceLabel;
      if (presets.length) loadPreset(0, false);
    }

    var src = host.getAttribute('data-presets-src');
    var settled = false;
    function fallback(reason) {
      if (settled) return;
      settled = true;
      adopt(normalisePresets(FALLBACK_PRESETS), reason);
    }

    if (src && typeof window.fetch === 'function') {
      window.fetch(src, { cache: 'no-cache' }).then(function (res) {
        if (!res.ok) throw new Error('bad response');
        return res.json();
      }).then(function (json) {
        if (settled) return;
        var list = normalisePresets(json);
        if (!list.length) { fallback('Built-in bank · ' + FALLBACK_PRESETS.length + ' patches'); return; }
        settled = true;
        adopt(list, 'Preset library · ' + list.length + ' patches');
      }).catch(function () {
        fallback('Built-in bank · ' + FALLBACK_PRESETS.length + ' patches');
      });
    } else {
      fallback('Built-in bank · ' + FALLBACK_PRESETS.length + ' patches');
    }

    on(presetSelect, 'change', function () {
      loadPreset(parseInt(presetSelect.value, 10) || 0, true);
    });
    on($('[data-preset-prev]', host), 'click', function () { loadPreset(presetIndex - 1, true); });
    on($('[data-preset-next]', host), 'click', function () { loadPreset(presetIndex + 1, true); });
    on($('[data-preset-random]', host), 'click', function () {
      if (presets.length < 2) return loadPreset(0, true);
      var next = presetIndex;
      while (next === presetIndex) next = Math.floor(Math.random() * presets.length);
      loadPreset(next, true);
    });
    on($('[data-preset-init]', host), 'click', function () {
      if (!S || !S.getDefaults) return;
      currentPresetName = 'Init';
      if (presetDesc) presetDesc.textContent = 'Factory init — every parameter at its default.';
      S.loadPreset(S.getDefaults());
      toast('Init patch loaded');
    });
  }

  /* ================================================================== *
   * 9.  Framing, unsupported fallback, boot
   * ================================================================== */

  function initFraming() {
    var framed = true;
    try { framed = window.self !== window.top; } catch (e) { framed = true; }
    document.documentElement.setAttribute(framed ? 'data-framed' : 'data-standalone', '');
  }

  function showUnsupported() {
    var demo = $('[data-demo]');
    if (demo) demo.setAttribute('data-unsupported', '');
    var note = $('[data-power-note]');
    var title = $('[data-power-title]');
    var sub = $('[data-power-sub]');
    var btn = $('[data-power-btn]');
    if (title) title.textContent = 'No Web Audio in this browser';
    if (sub) {
      sub.textContent =
        'VANTA runs on the Web Audio API, and this browser does not provide it. ' +
        'The plugin itself has no such requirement — it is a native VST3, AU, AAX and CLAP.';
    }
    if (note) {
      note.textContent = 'Try the current version of Firefox, Chrome, Edge or Safari, ' +
        'or read the VANTA reference in the documentation.';
    }
    if (btn) btn.remove();
  }

  /* Run before first paint so the standalone-only chrome never flashes. */
  initFraming();

  function boot() {
    if (!S || !S.supported || !PARAMS.length) {
      showUnsupported();
      return;
    }

    renderRack($('[data-rack]'));
    initMeter();
    initScope();
    initTransport();
    buildKeybed();
    updateOctaveDisplay();
    initKeybedPointer();
    initTypingKeys();
    initPresets();
    setPowerUI(false);

    /* engine -> UI */
    S.on('param', function (e) {
      syncControl(e.name, e.value);
      pulseSection(e.name);
    });
    S.on('noteon', function (e) {
      markNote(e.midi, 1);
      lastNoteName = S.midiToName(e.midi) + (e.source === 'arp' ? ' · arp' : '');
      if (!motionOn) drawFrame(true);
    });
    S.on('noteoff', function (e) { markNote(e.midi, -1); });
    S.on('start', function () { setPowerUI(true); ensureLoop(); });
    S.on('stop', function () { setPowerUI(false); stopLoop(); });

    /* Any first gesture anywhere in the rack powers the engine up. */
    var rackRegion = $('[data-demo]');
    on(rackRegion, 'pointerdown', function () { ensurePower(); }, true);

    drawFrame(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.SSDemo = {
    controls: controls,
    reloadKeybed: buildKeybed,
    presets: function () { return presets.slice(); }
  };
})();
