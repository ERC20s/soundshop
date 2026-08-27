/* =========================================================================
   SOUNDSHOP — home.js
   Page script for site/index.html only. Two jobs:

     1  the hero canvas — an amber scope trace, a cyan spectrum comb, a slow
        particle field and a scan sweep. When VANTA is running it is driven by
        SSSynth.getWaveform() / getSpectrum() / getLevel(); when it is silent
        it runs a self-contained idle animation that still looks alive.
     2  the inline mini-instrument — a playable .keybed wired to SSSynth with
        pointer + computer-keyboard input, four inline presets, an octave
        control, an output meter and an eight-voice activity strip.

   Plus a small count-up for the [data-countup] figures in the numbers band.

   No modules, no fetch, no external assets, no path literals. Every entry
   point is guarded: on a page without these elements nothing runs and nothing
   throws. Depends on assets/js/synth.js (window.SSSynth) when present, and
   degrades to a silent, still-correct page when it is not.
   ========================================================================= */
(function (window, document) {
  'use strict';

  var S = window.SSSynth || null;
  var HOME = {};

  /* =======================================================================
     01  SMALL HELPERS
     ======================================================================= */

  function $(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }
  function $$(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
    catch (e) { return []; }
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }

  function now() {
    try { return window.performance && window.performance.now ? window.performance.now() : Date.now(); }
    catch (e) { return Date.now(); }
  }

  /* Colour tokens, read from the live cascade so the canvas follows the theme. */
  var PALETTE = {
    accent: '#F2A93B',
    accent2: '#4FD5D6',
    line: '#262B30',
    lineStrong: '#363D44',
    mute: '#8A939B',
    text: '#EDF1F3'
  };

  function readPalette() {
    try {
      var cs = window.getComputedStyle(document.documentElement);
      function tok(name, fallback) {
        var v = cs.getPropertyValue(name);
        v = v ? v.trim() : '';
        return v || fallback;
      }
      PALETTE.accent = tok('--accent', PALETTE.accent);
      PALETTE.accent2 = tok('--accent-2', PALETTE.accent2);
      PALETTE.line = tok('--line', PALETTE.line);
      PALETTE.lineStrong = tok('--line-strong', PALETTE.lineStrong);
      PALETTE.mute = tok('--text-mute', PALETTE.mute);
      PALETTE.text = tok('--text', PALETTE.text);
    } catch (e) { /* keep the fallbacks */ }
  }

  /* #RGB / #RRGGBB -> rgba(). Anything else is returned untouched. */
  function rgba(color, alpha) {
    var hex = String(color || '').trim();
    if (hex.charAt(0) !== '#') return hex;
    hex = hex.slice(1);
    if (hex.length === 3) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    if (hex.length !== 6) return color;
    var n = parseInt(hex, 16);
    if (isNaN(n)) return color;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  /* =======================================================================
     02  ONE SHARED rAF LOOP
     Consumers declare when they want to run and how often. The loop stops
     itself completely when nothing is active, so a hidden tab costs nothing.
     ======================================================================= */

  var consumers = [];
  var frame = 0;
  var lastFrameTime = 0;
  var pageVisible = true;

  function pump(stamp) {
    frame = 0;
    var dt = lastFrameTime ? Math.min(stamp - lastFrameTime, 100) : 16.7;
    lastFrameTime = stamp;

    var wanted = false;
    for (var i = 0; i < consumers.length; i++) {
      var c = consumers[i];
      var active = false;
      try { active = !!c.active(); } catch (e) { active = false; }
      if (!active) { c.acc = 0; continue; }
      wanted = true;
      c.acc += dt;
      var step = c.interval();
      if (c.acc + 0.5 >= step) {
        c.acc = c.acc > step * 2 ? 0 : c.acc - step;
        try { c.tick(stamp, dt); } catch (e) { /* a bad frame must never kill the loop */ }
      }
    }

    if (wanted && window.requestAnimationFrame) frame = window.requestAnimationFrame(pump);
    else lastFrameTime = 0;
  }

  function kick() {
    if (frame || !window.requestAnimationFrame) return;
    lastFrameTime = 0;
    frame = window.requestAnimationFrame(pump);
  }

  function addConsumer(active, interval, tick) {
    consumers.push({ active: active, interval: interval, tick: tick, acc: 0 });
    kick();
  }

  try {
    document.addEventListener('visibilitychange', function () {
      pageVisible = document.visibilityState !== 'hidden';
      if (pageVisible) kick();
    });
  } catch (e) { /* ignore */ }

  /* =======================================================================
     03  HERO CANVAS
     ======================================================================= */

  function initHero() {
    var canvas = $('[data-hero-canvas]');
    if (!canvas || typeof canvas.getContext !== 'function') return;

    var ctx = null;
    try { ctx = canvas.getContext('2d'); } catch (e) { ctx = null; }
    if (!ctx) return;

    var still = reducedMotion();
    var onScreen = true;
    var w = 0, h = 0, dpr = 1;
    var particles = [];
    var combGrad = null;

    /* Analyser buffers, sized from the engine's own contract. */
    var fftSize = 2048, binCount = 1024;
    if (S && typeof S.getAnalyserInfo === 'function') {
      try {
        var info = S.getAnalyserInfo();
        if (info && info.fftSize) fftSize = info.fftSize;
        if (info && info.frequencyBinCount) binCount = info.frequencyBinCount;
      } catch (e) { /* keep defaults */ }
    }
    var waveBuf = null, specBuf = null;
    try {
      waveBuf = new Float32Array(fftSize);
      specBuf = new Uint8Array(binCount);
    } catch (e) { waveBuf = null; specBuf = null; }

    var liveBlend = 0;      // 0 = idle animation, 1 = audio-driven
    var combSmooth = [];    // per-bar smoothing for the spectrum comb
    var COMB_BARS = 64;
    for (var b = 0; b < COMB_BARS; b++) combSmooth.push(0);

    function seed() {
      var count = Math.round(clamp(w / 24, 18, 74));
      particles.length = 0;
      for (var i = 0; i < count; i++) {
        var z = 0.25 + Math.random() * 0.75;
        particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          z: z,
          r: 0.5 + z * 1.2,
          vx: (6 + z * 22) / 1000,
          phase: Math.random() * Math.PI * 2
        });
      }
    }

    function measure() {
      var rect;
      try { rect = canvas.getBoundingClientRect(); } catch (e) { return false; }
      var nw = Math.max(1, Math.round(rect.width));
      var nh = Math.max(1, Math.round(rect.height));
      var ndpr = clamp(window.devicePixelRatio || 1, 1, 2);
      if (nw === w && nh === h && ndpr === dpr) return false;
      w = nw; h = nh; dpr = ndpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      try { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); } catch (e) { /* ignore */ }
      combGrad = null;
      seed();
      return true;
    }

    function comb() {
      if (combGrad) return combGrad;
      try {
        combGrad = ctx.createLinearGradient(0, h, 0, h * 0.52);
        combGrad.addColorStop(0, rgba(PALETTE.accent2, 0.42));
        combGrad.addColorStop(1, rgba(PALETTE.accent2, 0));
      } catch (e) { combGrad = rgba(PALETTE.accent2, 0.3); }
      return combGrad;
    }

    /* ---- the individual layers ------------------------------------------ */

    function drawGrid(t) {
      var step = clamp(w / 12, 64, 132);
      var drift = still ? 0 : (t * 5) % step;
      ctx.save();
      ctx.strokeStyle = rgba(PALETTE.line, 0.85);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var x = -drift; x < w + step; x += step) {
        var px = Math.round(x) + 0.5;
        ctx.moveTo(px, h * 0.12);
        ctx.lineTo(px, h * 0.88);
      }
      ctx.stroke();
      ctx.beginPath();
      var mid = Math.round(h * 0.5) + 0.5;
      ctx.moveTo(0, mid); ctx.lineTo(w, mid);
      ctx.moveTo(0, Math.round(h * 0.5 - h * 0.22) + 0.5); ctx.lineTo(w, Math.round(h * 0.5 - h * 0.22) + 0.5);
      ctx.moveTo(0, Math.round(h * 0.5 + h * 0.22) + 0.5); ctx.lineTo(w, Math.round(h * 0.5 + h * 0.22) + 0.5);
      ctx.strokeStyle = rgba(PALETTE.line, 0.55);
      ctx.stroke();
      ctx.restore();
    }

    function drawParticles(t, dt) {
      ctx.save();
      ctx.fillStyle = rgba(PALETTE.lineStrong, 0.85);
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        if (!still) {
          p.x += p.vx * dt;
          if (p.x > w + 4) { p.x = -4; p.y = Math.random() * h; }
        }
        var tw = still ? 0.55 : 0.4 + 0.35 * Math.sin(t * 0.9 + p.phase);
        ctx.globalAlpha = clamp(tw * p.z, 0, 1);
        ctx.beginPath();
        ctx.arc(p.x, p.y + (still ? 0 : Math.sin(t * 0.25 + p.phase) * 4 * p.z), p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    function drawComb(t, live) {
      var base = h;
      var maxH = h * 0.34;
      var barW = Math.max(1.5, (w / COMB_BARS) * 0.42);
      ctx.save();
      ctx.fillStyle = comb();
      for (var i = 0; i < COMB_BARS; i++) {
        var v;
        if (live && specBuf) {
          /* log-spaced bin window, so the low end is not one fat bar */
          var lo = Math.floor(Math.pow(i / COMB_BARS, 2.1) * (binCount - 2));
          var hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / COMB_BARS, 2.1) * (binCount - 1)));
          var peak = 0;
          for (var k = lo; k < hi && k < binCount; k++) if (specBuf[k] > peak) peak = specBuf[k];
          v = peak / 255;
        } else {
          v = 0.10 + 0.075 * Math.sin(t * 0.55 + i * 0.34) + 0.05 * Math.sin(t * 0.21 + i * 0.11) +
              0.035 * Math.sin(t * 1.13 + i * 0.71);
          v = clamp(v, 0.012, 1);
        }
        combSmooth[i] += (v - combSmooth[i]) * (still ? 1 : 0.28);
        var bh = clamp(combSmooth[i], 0, 1) * maxH;
        if (bh < 1) continue;
        var x = (i + 0.5) * (w / COMB_BARS) - barW / 2;
        ctx.fillRect(x, base - bh, barW, bh);
      }
      ctx.restore();
    }

    function drawTrace(t, live, level) {
      var points = Math.round(clamp(w / 2.2, 90, 460));
      var cy = h * 0.5;
      var idleAmp = h * 0.15;
      var liveAmp = h * 0.20 * (0.55 + clamp(level * 3.4, 0, 1.6));
      var useWave = live && waveBuf;
      var wlen = waveBuf ? waveBuf.length : 1;

      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      /* a soft amber bloom under the trace, then the trace itself */
      ctx.beginPath();
      for (var i = 0; i < points; i++) {
        var frac = i / (points - 1);
        var x = frac * w;
        var idle =
          0.58 * Math.sin(x * 0.0075 + t * 0.62) +
          0.27 * Math.sin(x * 0.0193 - t * 0.94 + 1.7) +
          0.15 * Math.sin(x * 0.0402 + t * 1.37);
        var breathe = 0.55 + 0.45 * Math.sin(t * 0.24 + x * 0.0016);
        var y = cy + idle * breathe * idleAmp;
        if (liveBlend > 0.001) {
          var yLive = cy;
          if (useWave) {
            var idx = Math.min(wlen - 1, Math.floor(frac * wlen));
            yLive = cy - clamp(waveBuf[idx], -1.6, 1.6) * liveAmp;
          }
          y += (yLive - y) * liveBlend;
        }
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = rgba(PALETTE.accent, 0.16);
      ctx.lineWidth = 9;
      ctx.stroke();

      ctx.strokeStyle = rgba(PALETTE.accent, 0.92);
      ctx.lineWidth = 1.75;
      ctx.stroke();
      ctx.restore();
    }

    function drawSweep(t) {
      if (still) return;
      var span = w + 240;
      var x = ((t * 0.055) % 1) * span - 120;
      var grd;
      try {
        grd = ctx.createLinearGradient(x - 120, 0, x, 0);
        grd.addColorStop(0, rgba(PALETTE.accent, 0));
        grd.addColorStop(1, rgba(PALETTE.accent, 0.07));
      } catch (e) { return; }
      ctx.save();
      ctx.fillStyle = grd;
      ctx.fillRect(x - 120, 0, 120, h);
      ctx.fillStyle = rgba(PALETTE.accent, 0.20);
      ctx.fillRect(x, h * 0.08, 1, h * 0.84);
      ctx.restore();
    }

    function fadeEdges() {
      var g;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      try {
        g = ctx.createLinearGradient(0, 0, 0, h * 0.24);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h * 0.24);

        g = ctx.createLinearGradient(w, 0, w - Math.min(160, w * 0.16), 0);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(w - Math.min(160, w * 0.16), 0, Math.min(160, w * 0.16), h);
      } catch (e) { /* ignore */ }
      ctx.restore();
    }

    function render(stamp, dt) {
      if (!w || !h) { measure(); }
      if (!w || !h) return;

      var t = stamp / 1000;
      var live = !!(S && S.ready && S.running);
      var level = 0;
      if (live) {
        try { level = S.getLevel() || 0; } catch (e) { level = 0; }
        try { if (waveBuf) S.getWaveform(waveBuf); } catch (e) { /* ignore */ }
        try { if (specBuf) S.getSpectrum(specBuf); } catch (e) { /* ignore */ }
      }
      var wantBlend = live && level > 0.0025 ? 1 : 0;
      liveBlend += (wantBlend - liveBlend) * (still ? 1 : 0.05);
      var driven = live && liveBlend > 0.02;

      ctx.clearRect(0, 0, w, h);
      drawGrid(t);
      drawParticles(t, dt);
      drawComb(t, driven);
      drawTrace(t, live, level);
      drawSweep(t);
      fadeEdges();
    }

    function paintOnce() {
      measure();
      render(still ? 4200 : now(), 16.7);
    }

    /* ---- lifecycle ------------------------------------------------------ */

    if (window.ResizeObserver) {
      try {
        var ro = new window.ResizeObserver(function () {
          if (measure() && still) paintOnce();
        });
        ro.observe(canvas);
      } catch (e) { /* fall back to the resize event below */ }
    }
    try {
      window.addEventListener('resize', function () {
        if (measure() && still) paintOnce();
      }, { passive: true });
    } catch (e2) { /* ignore */ }

    if (window.IntersectionObserver) {
      try {
        var io = new window.IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) onScreen = entries[i].isIntersecting;
          if (onScreen) kick();
        }, { threshold: 0 });
        io.observe(canvas);
      } catch (e3) { onScreen = true; }
    }

    try {
      document.addEventListener('ss:themechange', function () {
        readPalette();
        combGrad = null;
        if (still) paintOnce();
      });
    } catch (e4) { /* ignore */ }

    paintOnce();
    HOME.repaintHero = paintOnce;

    if (still) return;   /* reduced motion: one static frame, no loop */

    addConsumer(
      function () { return pageVisible && onScreen; },
      function () { return (S && S.ready && S.running) ? 1000 / 60 : 1000 / 40; },
      render
    );
  }

  /* =======================================================================
     04  INLINE MINI-INSTRUMENT
     ======================================================================= */

  var NOTE_NAMES = 'C C# D D# E F F# G G# A A# B'.split(' ');

  /* Four starting points, defined here on purpose: the home page never reads
     the preset library JSON, it only demonstrates the engine. */
  var PRESETS = [
    {
      id: 'keys',
      name: 'Soft keys',
      params: {
        osc1wave: 'triangle', osc1Level: 0.9, osc2wave: 'sawtooth', osc2Level: 0.34,
        osc2Oct: 0, detune: 9, subWave: 'sine', subLevel: 0.3, glide: 0,
        filtType: 'lowpass', cutoff: 1600, reso: 2.2, fegAmt: 1800, keyTrack: 0.45,
        fegA: 0.01, fegD: 0.5, fegS: 0.18, fegR: 0.5,
        ampA: 0.008, ampD: 1.2, ampS: 0.45, ampR: 0.55,
        lfoWave: 'triangle', lfoRate: 4.6, lfoDepth: 0.05, lfoTarget: 'cutoff',
        drive: 0.12, delayTime: 0.28, delayFb: 0.24, delayDamp: 3800, delayMix: 0.14,
        revSize: 0.5, revMix: 0.24,
        arpOn: 'off', volume: 0.75
      }
    },
    {
      id: 'pad',
      name: 'Glass pad',
      params: {
        osc1wave: 'sawtooth', osc1Level: 0.8, osc2wave: 'triangle', osc2Level: 0.75,
        osc2Oct: 1, detune: 26, subWave: 'sine', subLevel: 0.24, glide: 0,
        filtType: 'lowpass', cutoff: 900, reso: 4.5, fegAmt: 2600, keyTrack: 0.3,
        fegA: 1.2, fegD: 2.4, fegS: 0.5, fegR: 2.6,
        ampA: 0.85, ampD: 2, ampS: 0.8, ampR: 2.4,
        lfoWave: 'sine', lfoRate: 0.22, lfoDepth: 0.18, lfoTarget: 'cutoff',
        drive: 0.1, delayTime: 0.48, delayFb: 0.4, delayDamp: 3200, delayMix: 0.28,
        revSize: 0.95, revMix: 0.5,
        arpOn: 'off', volume: 0.72
      }
    },
    {
      id: 'lead',
      name: 'Acid lead',
      params: {
        osc1wave: 'sawtooth', osc1Level: 1, osc2wave: 'square', osc2Level: 0.4,
        osc2Oct: 0, detune: 5, subWave: 'square', subLevel: 0.34, glide: 0.06,
        filtType: 'lowpass', cutoff: 340, reso: 16, fegAmt: 3600, keyTrack: 0.6,
        fegA: 0.004, fegD: 0.22, fegS: 0.05, fegR: 0.18,
        ampA: 0.004, ampD: 0.35, ampS: 0.55, ampR: 0.22,
        lfoWave: 'triangle', lfoRate: 5.5, lfoDepth: 0.04, lfoTarget: 'pitch',
        drive: 0.5, delayTime: 0.22, delayFb: 0.35, delayDamp: 5200, delayMix: 0.2,
        revSize: 0.35, revMix: 0.12,
        arpOn: 'off', volume: 0.7
      }
    },
    {
      id: 'broken',
      name: 'Broken arp',
      params: {
        osc1wave: 'square', osc1Level: 0.8, osc2wave: 'sawtooth', osc2Level: 0.6,
        osc2Oct: -1, detune: 18, subWave: 'triangle', subLevel: 0.28, glide: 0,
        filtType: 'lowpass', cutoff: 1800, reso: 8, fegAmt: 2400, keyTrack: 0.4,
        fegA: 0.002, fegD: 0.18, fegS: 0.1, fegR: 0.3,
        ampA: 0.002, ampD: 0.22, ampS: 0.3, ampR: 0.28,
        lfoWave: 'sh', lfoRate: 7.5, lfoDepth: 0.25, lfoTarget: 'cutoff',
        drive: 0.34, delayTime: 0.3, delayFb: 0.48, delayDamp: 4200, delayMix: 0.3,
        revSize: 0.6, revMix: 0.26,
        arpOn: 'on', arpMode: 'updown', arpRate: '16', arpBpm: 112, arpOct: 2, arpGate: 0.45,
        volume: 0.72
      }
    }
  ];

  /* White keys of the two-octave-ish span the computer keyboard covers, and
     the white key each black key hangs off (a black key is a child of the
     white key immediately above it, so it straddles the correct edge). */
  var WHITE_SEMIS = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16];
  var BLACK_UNDER = { 2: 1, 4: 3, 7: 6, 9: 8, 11: 10, 14: 13, 16: 15 };

  function initPlay() {
    var section = $('[data-play-section]');
    if (!section) return;

    var keybed = $('[data-keybed]', section);
    var keysHost = $('[data-keybed-keys]', section);
    var presetRow = $('[data-preset-row]', section);
    var statusEl = $('[data-play-status]', section);
    var ledEl = $('[data-play-led]', section);
    var meterBar = $('[data-play-meter]', section);
    var clipEl = $('[data-play-clip]', section);
    var levelEl = $('[data-play-level]', section);
    var octaveEl = $('[data-play-octave]', section);
    var voiceLeds = $$('[data-voice-leds] .led', section);

    var supported = !!(S && S.supported);
    var keymap = (S && S.KEYMAP) || {
      a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
      k: 12, o: 13, l: 14, p: 15, ';': 16
    };
    var octaveKeys = (S && S.OCTAVE_KEYS) || { down: 'z', up: 'x' };

    var hints = {};
    for (var kk in keymap) {
      if (!Object.prototype.hasOwnProperty.call(keymap, kk)) continue;
      var semi = keymap[kk];
      if (typeof semi === 'number' && hints[semi] === undefined) hints[semi] = kk.toUpperCase();
    }

    var stillUI = reducedMotion();
    var octave = 4;
    if (S && typeof S.getOctave === 'function') {
      try { octave = S.getOctave(); } catch (e) { octave = 4; }
    }

    var keyEls = {};
    var held = {};      // semitone -> press count (pointer + computer key)
    var sounding = {};  // semitone -> the MIDI note actually sent
    var starting = false;
    var current = PRESETS[0];

    function midiFor(semi) { return (octave + 1) * 12 + semi; }
    function noteName(midi) {
      if (S && typeof S.midiToName === 'function') {
        try { var n = S.midiToName(midi); if (n) return n; } catch (e) { /* fall through */ }
      }
      return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
    }

    /* ---- build the keybed ---------------------------------------------- */

    function makeKey(semi, black) {
      var el = document.createElement('div');
      el.className = 'keybed__key ' + (black ? 'keybed__key--black' : 'keybed__key--white');
      el.setAttribute('data-semi', String(semi));
      var name = document.createElement('span');
      name.className = 'keybed__key-name';
      name.textContent = hints[semi] || '';
      el.appendChild(name);
      keyEls[semi] = el;
      return el;
    }

    function buildKeys() {
      if (!keysHost) return;
      keysHost.textContent = '';
      for (var i = 0; i < WHITE_SEMIS.length; i++) {
        var semi = WHITE_SEMIS[i];
        var white = makeKey(semi, false);
        var blackSemi = BLACK_UNDER[semi];
        if (blackSemi !== undefined && i > 0) white.appendChild(makeKey(blackSemi, true));
        keysHost.appendChild(white);
      }
      syncLabels();
    }

    function syncLabels() {
      for (var semi in keyEls) {
        if (!Object.prototype.hasOwnProperty.call(keyEls, semi)) continue;
        keyEls[semi].setAttribute('title', noteName(midiFor(Number(semi))));
      }
      if (octaveEl) octaveEl.textContent = noteName(midiFor(0));
    }

    /* ---- audio ---------------------------------------------------------- */

    function audioReady() { return !!(S && S.ready && S.running); }

    /* Under prefers-reduced-motion nothing loops, so the meter and the voice
       strip are refreshed once per interaction instead — a static frame that
       still tells the truth. */
    function snapshot() {
      if (!stillUI) return;
      try { window.setTimeout(readouts, 40); } catch (e) { /* ignore */ }
    }

    function setStatus(text, on) {
      if (statusEl) statusEl.textContent = text;
      if (ledEl) {
        if (on) ledEl.classList.add('is-on');
        else ledEl.classList.remove('is-on');
      }
    }

    function ensureAudio() {
      if (!supported || starting || audioReady()) return;
      starting = true;
      setStatus('Starting audio…', false);
      var p = null;
      try { p = S.start(); } catch (e) { p = null; }
      if (!p || typeof p.then !== 'function') { starting = false; setStatus('Audio asleep — press a key', false); return; }
      p.then(function (ok) {
        starting = false;
        if (!ok) { setStatus('Audio unavailable in this browser', false); return; }
        var rate = 0;
        try { rate = S.sampleRate || 0; } catch (e) { rate = 0; }
        setStatus('Running — ' + (rate ? Math.round(rate / 100) / 10 + ' kHz' : 'live') + ' — ' + current.name, true);
        kick();
        snapshot();
        if (typeof HOME.repaintHero === 'function' && reducedMotion()) HOME.repaintHero();
        for (var semi in sounding) {
          if (Object.prototype.hasOwnProperty.call(sounding, semi)) {
            try { S.noteOn(sounding[semi], 0.86); } catch (e2) { /* ignore */ }
          }
        }
      }, function () {
        starting = false;
        setStatus('Audio could not start', false);
      });
    }

    function press(semi) {
      if (keyEls[semi] === undefined) return;
      if (held[semi]) { held[semi]++; return; }
      held[semi] = 1;
      keyEls[semi].classList.add('is-down');
      var midi = midiFor(semi);
      sounding[semi] = midi;
      if (audioReady()) { try { S.noteOn(midi, 0.86); } catch (e) { /* ignore */ } }
      else ensureAudio();
      snapshot();
    }

    function release(semi) {
      if (!held[semi]) return;
      held[semi]--;
      if (held[semi] > 0) return;
      delete held[semi];
      if (keyEls[semi]) keyEls[semi].classList.remove('is-down');
      var midi = sounding[semi];
      delete sounding[semi];
      if (audioReady() && typeof midi === 'number') {
        try { S.noteOff(midi); } catch (e) { /* ignore */ }
      }
      snapshot();
    }

    function releaseAll() {
      for (var semi in held) {
        if (!Object.prototype.hasOwnProperty.call(held, semi)) continue;
        held[semi] = 1;
        release(Number(semi));
      }
      held = {};
      sounding = {};
      for (var k in keyEls) {
        if (Object.prototype.hasOwnProperty.call(keyEls, k)) keyEls[k].classList.remove('is-down');
      }
    }

    /* ---- pointer input --------------------------------------------------- */

    function semiFromPoint(x, y) {
      var el = null;
      try { el = document.elementFromPoint(x, y); } catch (e) { return null; }
      while (el && el !== keybed) {
        if (el.getAttribute && el.getAttribute('data-semi') !== null) {
          var n = parseInt(el.getAttribute('data-semi'), 10);
          return isNaN(n) ? null : n;
        }
        el = el.parentNode;
      }
      return null;
    }

    var pointers = {};

    function onPointerDown(ev) {
      var semi = semiFromPoint(ev.clientX, ev.clientY);
      if (semi === null) return;
      ev.preventDefault();
      try { keybed.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      pointers[ev.pointerId] = semi;
      press(semi);
    }

    function onPointerMove(ev) {
      if (!(ev.pointerId in pointers)) return;
      var next = semiFromPoint(ev.clientX, ev.clientY);
      var prev = pointers[ev.pointerId];
      if (next === prev) return;
      if (prev !== null) release(prev);
      pointers[ev.pointerId] = next;
      if (next !== null) press(next);
    }

    function onPointerUp(ev) {
      if (!(ev.pointerId in pointers)) return;
      var prev = pointers[ev.pointerId];
      delete pointers[ev.pointerId];
      if (prev !== null) release(prev);
      try { keybed.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    }

    if (keybed && window.PointerEvent) {
      keybed.addEventListener('pointerdown', onPointerDown);
      keybed.addEventListener('pointermove', onPointerMove);
      keybed.addEventListener('pointerup', onPointerUp);
      keybed.addEventListener('pointercancel', onPointerUp);
      keybed.addEventListener('lostpointercapture', onPointerUp);
      keybed.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    }

    /* ---- computer keyboard ---------------------------------------------- */

    var armed = true;
    var panel = $('[data-play-panel]', section) || section;
    if (window.IntersectionObserver) {
      armed = false;
      try {
        var io = new window.IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            armed = entries[i].isIntersecting;
            if (!armed) releaseAll();
          }
        }, { threshold: 0.2 });
        io.observe(panel);
      } catch (e) { armed = true; }
    }

    function typingTarget(node) {
      if (!node || !node.tagName) return false;
      if (node.isContentEditable) return true;
      return /^(input|textarea|select)$/i.test(node.tagName);
    }

    document.addEventListener('keydown', function (ev) {
      if (!armed || ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (typingTarget(ev.target)) return;
      var k = String(ev.key || '').toLowerCase();
      if (k === octaveKeys.down) { ev.preventDefault(); shiftOctave(-1); return; }
      if (k === octaveKeys.up) { ev.preventDefault(); shiftOctave(1); return; }
      var semi = keymap[k];
      if (typeof semi !== 'number' || keyEls[semi] === undefined) return;
      ev.preventDefault();
      press(semi);
    });

    document.addEventListener('keyup', function (ev) {
      var k = String(ev.key || '').toLowerCase();
      var semi = keymap[k];
      if (typeof semi === 'number') release(semi);
    });

    try {
      window.addEventListener('blur', releaseAll);
      window.addEventListener('pagehide', function () {
        releaseAll();
        if (audioReady()) { try { S.panic(); } catch (e) { /* ignore */ } }
      });
    } catch (e) { /* ignore */ }

    /* ---- octave + panic + presets --------------------------------------- */

    function shiftOctave(delta) {
      releaseAll();
      if (S && typeof S.shiftOctave === 'function') {
        try { octave = S.shiftOctave(delta); } catch (e) { octave = clamp(octave + delta, 1, 6); }
      } else {
        octave = clamp(octave + delta, 1, 6);
      }
      octave = clamp(octave, 1, 6);
      if (S && typeof S.setOctave === 'function') { try { S.setOctave(octave); } catch (e2) { /* ignore */ } }
      syncLabels();
    }

    $$('[data-octave]', section).forEach(function (btn) {
      btn.addEventListener('click', function () {
        shiftOctave(parseInt(btn.getAttribute('data-octave'), 10) < 0 ? -1 : 1);
      });
    });

    var panicBtn = $('[data-panic]', section);
    if (panicBtn) {
      panicBtn.addEventListener('click', function () {
        releaseAll();
        if (S && typeof S.panic === 'function') { try { S.panic(); } catch (e) { /* ignore */ } }
      });
    }

    function applyPreset(preset, buttons) {
      current = preset;
      if (S && typeof S.loadPreset === 'function') {
        try { S.loadPreset(preset.params); } catch (e) { /* ignore */ }
      }
      if (buttons) {
        buttons.forEach(function (b) {
          var on = b.getAttribute('data-preset') === preset.id;
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      }
      if (audioReady()) {
        var rate = 0;
        try { rate = S.sampleRate || 0; } catch (e2) { rate = 0; }
        setStatus('Running — ' + (rate ? Math.round(rate / 100) / 10 + ' kHz' : 'live') + ' — ' + preset.name, true);
      }
    }

    var presetButtons = [];
    if (presetRow) {
      presetRow.textContent = '';
      PRESETS.forEach(function (preset) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tag';
        btn.setAttribute('data-preset', preset.id);
        btn.setAttribute('aria-pressed', 'false');
        btn.textContent = preset.name;
        btn.addEventListener('click', function () {
          applyPreset(preset, presetButtons);
          ensureAudio();
        });
        presetRow.appendChild(btn);
        presetButtons.push(btn);
      });
    }

    /* ---- readouts -------------------------------------------------------- */

    var peak = 0;

    function readouts() {
      var level = 0;
      if (audioReady()) { try { level = S.getLevel() || 0; } catch (e) { level = 0; } }

      var pct = clamp(Math.sqrt(level) * 118, 0, 100);
      if (meterBar) meterBar.style.width = pct.toFixed(1) + '%';

      peak = Math.max(level, peak * 0.94);
      if (clipEl) {
        if (peak > 0.62) clipEl.classList.add('is-active');
        else clipEl.classList.remove('is-active');
      }

      if (levelEl) {
        levelEl.textContent = level > 0.0006
          ? (Math.round(20 * Math.log10(level) * 10) / 10).toFixed(1) + ' dB'
          : '−∞ dB';
      }

      if (voiceLeds.length && S && typeof S.getVoiceStates === 'function') {
        var states = null;
        try { states = S.getVoiceStates(); } catch (e2) { states = null; }
        if (states) {
          for (var i = 0; i < voiceLeds.length; i++) {
            var st = states[i];
            if (st && st.active) voiceLeds[i].classList.add('is-on');
            else voiceLeds[i].classList.remove('is-on');
          }
        }
      }
    }

    /* ---- go -------------------------------------------------------------- */

    buildKeys();
    applyPreset(PRESETS[0], presetButtons);

    if (!supported) {
      setStatus('Web Audio is unavailable in this browser', false);
      if (keybed) keybed.style.opacity = '0.55';
    } else {
      setStatus('Audio asleep — press a key', false);
      if (!reducedMotion()) {
        var visibleSection = true;
        if (window.IntersectionObserver) {
          visibleSection = false;
          try {
            var io2 = new window.IntersectionObserver(function (entries) {
              for (var i = 0; i < entries.length; i++) visibleSection = entries[i].isIntersecting;
              if (visibleSection) kick();
            }, { threshold: 0 });
            io2.observe(section);
          } catch (e) { visibleSection = true; }
        }
        addConsumer(
          function () { return pageVisible && visibleSection && audioReady(); },
          function () { return 1000 / 30; },
          readouts
        );
      }
    }

    HOME.play = { press: press, release: release, releaseAll: releaseAll };
  }

  /* =======================================================================
     05  COUNT-UP FIGURES
     ======================================================================= */

  function initCountUp() {
    var nodes = $$('[data-countup]');
    if (!nodes.length) return;

    function target(el) {
      var n = parseFloat(el.getAttribute('data-countup'));
      return isNaN(n) ? 0 : n;
    }
    function render(el, value) {
      var suffix = el.getAttribute('data-countup-suffix') || '';
      var prefix = el.getAttribute('data-countup-prefix') || '';
      el.textContent = prefix + String(Math.round(value)) + suffix;
    }
    function finish(el) { render(el, target(el)); }

    if (reducedMotion() || !window.IntersectionObserver || !window.requestAnimationFrame) {
      nodes.forEach(finish);
      return;
    }

    function run(el) {
      var to = target(el);
      var start = now();
      var dur = 900;
      function step() {
        var p = clamp((now() - start) / dur, 0, 1);
        var eased = 1 - Math.pow(1 - p, 3);
        render(el, to * eased);
        if (p < 1) window.requestAnimationFrame(step);
        else finish(el);
      }
      window.requestAnimationFrame(step);
    }

    var io;
    try {
      io = new window.IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var en = entries[i];
          if (!en.isIntersecting) continue;
          io.unobserve(en.target);
          run(en.target);
        }
      }, { threshold: 0.35 });
    } catch (e) {
      nodes.forEach(finish);
      return;
    }

    nodes.forEach(function (el) {
      render(el, 0);
      io.observe(el);
    });
  }

  /* =======================================================================
     06  BOOT
     ======================================================================= */

  function boot() {
    readPalette();
    try { initHero(); } catch (e) { /* never block the page */ }
    try { initPlay(); } catch (e) { /* never block the page */ }
    try { initCountUp(); } catch (e) { /* never block the page */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.SSHome = HOME;
})(window, document);
