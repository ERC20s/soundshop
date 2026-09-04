/*!
 * SOUNDSHOP — VANTA browser voice engine
 * "Instruments for the deep end."
 *
 * A self-contained, dependency-free Web Audio emulation of VANTA, the SOUNDSHOP
 * flagship 8-voice virtual-analog polysynth. Plain script, no modules, no build
 * step, no network access. Exposes exactly one global: window.SSSynth.
 *
 * Signal flow
 * -----------
 *   per voice (fixed pool of 8, oscillators run continuously, gated by the VCA)
 *     osc1 ─┐
 *     osc2 ─┼─> mix ─> biquad filter ─> tremolo ─> VCA ─┐
 *     sub  ─┘        (filter ADSR on .detune)           │
 *                                                       v
 *   voice bus ─> drive pre-gain ─> waveshaper ─> post-gain ─> fx bus
 *     fx bus ─> dry ────────────────────────────────────────> master
 *     fx bus ─> delay send ─> ping-pong delay (damped fb) ───> master
 *     fx bus ─> reverb send ─> convolver (generated IR) ─────> master
 *   master ─> limiter (DynamicsCompressor) ─> destination
 *                       └─> analyser (tap)
 *
 * Everything is a safe no-op before SSSynth.start() has been called, and if the
 * browser has no AudioContext at all SSSynth.supported is false and every
 * method still returns harmlessly.
 */
(function (global) {
  'use strict';

  var AC = global.AudioContext || global.webkitAudioContext || null;

  /* ================================================================== *
   * Constants & small helpers
   * ================================================================== */

  var MAX_VOICES = 8;
  var VERSION = '1.4.0';

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  var WAVES = ['sine', 'triangle', 'sawtooth', 'square'];
  var WAVE_LABELS = ['Sine', 'Triangle', 'Saw', 'Square'];
  var SUB_WAVES = ['sine', 'triangle', 'square'];
  var SUB_WAVE_LABELS = ['Sine', 'Triangle', 'Square'];
  var LFO_WAVES = ['sine', 'triangle', 'square', 'sh'];
  var LFO_WAVE_LABELS = ['Sine', 'Triangle', 'Square', 'Sample and Hold'];

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* ================================================================== *
   * PARAM_SPEC — the whole public parameter contract
   * ================================================================== */

  function R(name, label, group, min, max, step, def, unit, curve) {
    return {
      name: name, label: label, group: group, type: 'range',
      min: min, max: max, step: step, 'default': def,
      unit: unit || '', curve: curve || 'lin'
    };
  }

  function E(name, label, group, options, optionLabels, def) {
    return {
      name: name, label: label, group: group, type: 'enum',
      options: options.slice(), optionLabels: optionLabels.slice(),
      min: 0, max: options.length - 1, step: 1,
      'default': def, unit: '', curve: 'lin'
    };
  }

  var PARAM_SPEC = [
    /* ---- oscillators ---- */
    E('osc1wave', 'Osc 1 Wave', 'osc', WAVES, WAVE_LABELS, 'sawtooth'),
    R('osc1Level', 'Osc 1 Level', 'osc', 0, 1, 0.01, 0.9, ''),
    E('osc2wave', 'Osc 2 Wave', 'osc', WAVES, WAVE_LABELS, 'sawtooth'),
    R('osc2Level', 'Osc 2 Level', 'osc', 0, 1, 0.01, 0.7, ''),
    R('osc2Oct', 'Osc 2 Octave', 'osc', -2, 2, 1, 0, 'oct'),
    R('detune', 'Detune', 'osc', 0, 60, 0.5, 12, 'cents'),
    E('subWave', 'Sub Wave', 'osc', SUB_WAVES, SUB_WAVE_LABELS, 'sine'),
    R('subLevel', 'Sub Level', 'osc', 0, 1, 0.01, 0.4, ''),
    R('glide', 'Glide', 'osc', 0, 1, 0.005, 0, 's'),

    /* ---- filter ---- */
    E('filtType', 'Filter Type', 'filter',
      ['lowpass', 'highpass', 'bandpass'], ['Low Pass', 'High Pass', 'Band Pass'], 'lowpass'),
    R('cutoff', 'Cutoff', 'filter', 30, 18000, 1, 1200, 'Hz', 'log'),
    R('reso', 'Resonance', 'filter', 0.1, 24, 0.1, 3.5, 'Q'),
    R('fegAmt', 'Env Amount', 'filter', -4800, 4800, 10, 2200, 'cents'),
    R('keyTrack', 'Key Track', 'filter', 0, 1, 0.01, 0.35, ''),

    /* ---- filter envelope ---- */
    R('fegA', 'Filter Attack', 'feg', 0, 4, 0.001, 0.02, 's'),
    R('fegD', 'Filter Decay', 'feg', 0.001, 6, 0.001, 0.55, 's'),
    R('fegS', 'Filter Sustain', 'feg', 0, 1, 0.01, 0.25, ''),
    R('fegR', 'Filter Release', 'feg', 0.005, 8, 0.005, 0.6, 's'),

    /* ---- amplitude envelope ---- */
    R('ampA', 'Amp Attack', 'amp', 0, 4, 0.001, 0.02, 's'),
    R('ampD', 'Amp Decay', 'amp', 0.001, 6, 0.001, 0.6, 's'),
    R('ampS', 'Amp Sustain', 'amp', 0, 1, 0.01, 0.7, ''),
    R('ampR', 'Amp Release', 'amp', 0.005, 8, 0.005, 0.7, 's'),

    /* ---- LFO ---- */
    E('lfoWave', 'LFO Wave', 'lfo', LFO_WAVES, LFO_WAVE_LABELS, 'triangle'),
    R('lfoRate', 'LFO Rate', 'lfo', 0.02, 20, 0.01, 4.2, 'Hz', 'log'),
    R('lfoDepth', 'LFO Depth', 'lfo', 0, 1, 0.01, 0.08, ''),
    E('lfoTarget', 'LFO Target', 'lfo',
      ['off', 'pitch', 'cutoff', 'amp'], ['Off', 'Pitch', 'Filter', 'Amp'], 'cutoff'),

    /* ---- effects ---- */
    R('drive', 'Drive', 'fx', 0, 1, 0.01, 0.18, ''),
    R('delayTime', 'Delay Time', 'fx', 0.02, 1.5, 0.005, 0.36, 's'),
    R('delayFb', 'Delay Feedback', 'fx', 0, 0.92, 0.01, 0.34, ''),
    R('delayDamp', 'Delay Damping', 'fx', 400, 16000, 10, 4200, 'Hz', 'log'),
    R('delayMix', 'Delay Mix', 'fx', 0, 1, 0.01, 0.18, ''),
    R('revSize', 'Reverb Size', 'fx', 0.05, 1, 0.01, 0.6, ''),
    R('revMix', 'Reverb Mix', 'fx', 0, 1, 0.01, 0.28, ''),

    /* ---- arpeggiator ---- */
    E('arpOn', 'Arpeggiator', 'arp', ['off', 'on'], ['Off', 'On'], 'off'),
    E('arpMode', 'Arp Mode', 'arp',
      ['up', 'down', 'updown', 'random'], ['Up', 'Down', 'Up-Down', 'Random'], 'up'),
    E('arpRate', 'Arp Rate', 'arp',
      ['4', '8', '8t', '16', '16t', '32'],
      ['Quarter', 'Eighth', 'Eighth Triplet', 'Sixteenth', 'Sixteenth Triplet', 'Thirty-second'],
      '16'),
    R('arpBpm', 'Arp Tempo', 'arp', 40, 240, 1, 112, 'BPM'),
    R('arpOct', 'Arp Octaves', 'arp', 1, 3, 1, 1, 'oct'),
    R('arpGate', 'Arp Gate', 'arp', 0.05, 1, 0.01, 0.55, ''),

    /* ---- master ---- */
    R('volume', 'Master Volume', 'master', 0, 1, 0.01, 0.75, '')
  ];

  var SPEC_BY_NAME = {};
  var P = {};
  for (var si = 0; si < PARAM_SPEC.length; si++) {
    SPEC_BY_NAME[PARAM_SPEC[si].name] = PARAM_SPEC[si];
    P[PARAM_SPEC[si].name] = PARAM_SPEC[si]['default'];
  }

  var ARP_DIV = { '4': 1, '8': 0.5, '8t': 1 / 3, '16': 0.25, '16t': 1 / 6, '32': 0.125 };

  /* ================================================================== *
   * Events
   * ================================================================== */

  var listeners = {
    noteon: [], noteoff: [], param: [], start: [], stop: [], preset: []
  };

  function on(evt, fn) {
    var a = listeners[evt];
    if (a && typeof fn === 'function' && a.indexOf(fn) < 0) a.push(fn);
    return API;
  }
  function off(evt, fn) {
    var a = listeners[evt];
    if (a) { var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    return API;
  }
  function emit(evt, data) {
    var a = listeners[evt];
    if (!a) return;
    var copy = a.slice();
    for (var i = 0; i < copy.length; i++) {
      try { copy[i](data); } catch (e) { /* a listener must never break audio */ }
    }
  }

  /* ================================================================== *
   * Engine state
   * ================================================================== */

  var ctx = null;
  var ready = false;
  var built = false;

  var voiceBus = null, driveIn = null, shaper = null, driveOut = null, fxBus = null;
  var dryGain = null, master = null, limiter = null, analyser = null;
  var delayIn = null, dL = null, dR = null, fbL = null, fbR = null;
  var dampL = null, dampR = null, panL = null, panR = null, delayOut = null;
  var revIn = null, convolver = null, revOut = null;
  var lfoOsc = null, lfoOscGain = null, shSrc = null, shGain = null, lfoBus = null;
  var lfoPitchGain = null, lfoCutGain = null, lfoAmpGain = null;
  var shTimer = null;
  var irTimer = null;
  var irSizeCached = -1;

  var voices = [];
  var held = [];          // midi numbers, in press order
  var arpSounding = [];   // midi numbers currently sounded by the arpeggiator
  var arpTimer = null;
  var arpNextTime = 0;
  var arpStep = 0;
  var analysisScratch = null;

  var LOOKAHEAD_MS = 25;
  var SCHEDULE_AHEAD = 0.12;

  /* ------------------------------------------------------------------ *
   * AudioParam scheduling helpers — these never throw and never click.
   * ------------------------------------------------------------------ */

  function now() { return ctx ? ctx.currentTime : 0; }
  function at(t) { var c = now(); return (isNum(t) && t > c) ? t : c; }

  function anchor(param, t) {
    // Cancel everything from t onward while holding the value the parameter
    // actually has at t, so a retrigger never produces a discontinuity.
    try {
      if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(t);
        return;
      }
    } catch (e) { /* fall through */ }
    try { param.cancelScheduledValues(t); } catch (e) { /* ignore */ }
    try { param.setValueAtTime(param.value, t); } catch (e) { /* ignore */ }
  }

  function setSmooth(param, value, t, tau) {
    try { param.setTargetAtTime(value, at(t), tau || 0.02); } catch (e) { /* ignore */ }
  }

  function setNow(param, value, t) {
    try { param.setValueAtTime(value, at(t)); } catch (e) { /* ignore */ }
  }

  // Attack (linear ramp) + exponential-ish decay toward sustain.
  function attackDecay(param, t, peak, a, d, s) {
    var tt = at(t);
    anchor(param, tt);
    var atk = Math.max(a, 0.0015);
    try { param.linearRampToValueAtTime(peak, tt + atk); } catch (e) { /* ignore */ }
    var sus = peak * s;
    try { param.setTargetAtTime(sus, tt + atk, Math.max(d, 0.002) / 3.2); } catch (e) { /* ignore */ }
  }

  // Release toward a target, plus a guaranteed hard landing well past audibility.
  function releaseTo(param, t, target, r) {
    var tt = at(t);
    anchor(param, tt);
    var rr = Math.max(r, 0.005);
    try { param.setTargetAtTime(target, tt, rr / 4.6); } catch (e) { /* ignore */ }
    try { param.setValueAtTime(target, tt + rr * 1.6 + 0.02); } catch (e) { /* ignore */ }
    return tt + rr * 1.6 + 0.05;
  }

  /* ================================================================== *
   * Graph construction
   * ================================================================== */

  function makeDriveCurve() {
    var n = 2048;
    var curve = new Float32Array(n);
    var k = 1.5;
    var norm = Math.tanh(k);
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / norm;
    }
    return curve;
  }

  function buildIR(size) {
    var sr = ctx.sampleRate;
    var dur = 0.35 + size * 3.2;
    var len = Math.max(64, Math.floor(sr * dur));
    var pre = Math.floor(sr * (0.004 + size * 0.03));
    var buf = ctx.createBuffer(2, len, sr);
    var decay = 2.1 + (1 - size) * 2.6;
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      var i;
      for (i = 0; i < len; i++) {
        if (i < pre) { d[i] = 0; continue; }
        var x = (i - pre) / (len - pre);
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - x, decay);
      }
      // A couple of early reflections give the tail a room, not a hiss.
      var er = [0.013, 0.021, 0.037, 0.058];
      for (var e = 0; e < er.length; e++) {
        var idx = pre + Math.floor(er[e] * sr * (0.6 + size));
        if (idx < len) d[idx] += (ch === 0 ? 0.6 : -0.55) * (1 - e * 0.2);
      }
      // One-pole smoothing darkens the tail; then normalise.
      var z = 0, a = 0.32 - size * 0.12, peak = 0;
      for (i = 0; i < len; i++) {
        z = z + a * (d[i] - z);
        d[i] = z;
        var abs = z < 0 ? -z : z;
        if (abs > peak) peak = abs;
      }
      if (peak > 0) {
        var g = 0.85 / peak;
        for (i = 0; i < len; i++) d[i] *= g;
      }
      // Short fade-in so the IR itself cannot click.
      var fade = Math.min(len, Math.floor(sr * 0.002));
      for (i = 0; i < fade; i++) d[i] *= i / fade;
    }
    return buf;
  }

  function makeVoice(index) {
    var v = {
      index: index,
      midi: -1,
      vel: 0,
      gate: false,
      active: false,
      startTime: 0,
      offTime: 0,
      gen: 0,
      source: 'key',
      pendingOff: null,
      // Note-event bookkeeping: listeners count events, not voices, so every
      // 'noteon' this voice emitted must be closed by exactly one 'noteoff'.
      onEmitted: false,   // the 'noteon' for v.midi has actually been emitted
      offEmitted: true,   // ...and its 'noteoff' has been emitted (nothing owed)
      timer: null,
      lastFreq: 0,
      drift: (Math.random() * 2 - 1) * 3.2
    };

    v.o1 = ctx.createOscillator();
    v.o2 = ctx.createOscillator();
    v.sub = ctx.createOscillator();
    v.g1 = ctx.createGain();
    v.g2 = ctx.createGain();
    v.gs = ctx.createGain();
    v.mix = ctx.createGain();
    v.filt = ctx.createBiquadFilter();
    v.trem = ctx.createGain();
    v.vca = ctx.createGain();

    v.o1.type = P.osc1wave;
    v.o2.type = P.osc2wave;
    v.sub.type = P.subWave;

    v.g1.gain.value = 0;
    v.g2.gain.value = 0;
    v.gs.gain.value = 0;
    v.mix.gain.value = 1;
    v.filt.type = P.filtType;
    v.filt.frequency.value = 1200;
    v.filt.Q.value = P.reso;
    v.filt.detune.value = 0;
    v.trem.gain.value = 1;
    v.vca.gain.value = 0;

    v.o1.connect(v.g1); v.g1.connect(v.mix);
    v.o2.connect(v.g2); v.g2.connect(v.mix);
    v.sub.connect(v.gs); v.gs.connect(v.mix);
    v.mix.connect(v.filt);
    v.filt.connect(v.trem);
    v.trem.connect(v.vca);
    v.vca.connect(voiceBus);

    // Persistent LFO routing — depth gains decide what is actually heard.
    lfoPitchGain.connect(v.o1.detune);
    lfoPitchGain.connect(v.o2.detune);
    lfoPitchGain.connect(v.sub.detune);
    lfoCutGain.connect(v.filt.detune);
    lfoAmpGain.connect(v.trem.gain);

    var t0 = ctx.currentTime;
    try { v.o1.start(t0); v.o2.start(t0); v.sub.start(t0); } catch (e) { /* ignore */ }

    return v;
  }

  function build() {
    if (built) return;

    voiceBus = ctx.createGain();
    voiceBus.gain.value = 0.25;

    driveIn = ctx.createGain();
    shaper = ctx.createWaveShaper();
    shaper.curve = makeDriveCurve();
    try { shaper.oversample = '4x'; } catch (e) { /* ignore */ }
    driveOut = ctx.createGain();
    fxBus = ctx.createGain();

    dryGain = ctx.createGain();
    dryGain.gain.value = 1;

    master = ctx.createGain();
    master.gain.value = P.volume;

    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 3;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.7;
    analysisScratch = new Float32Array(analyser.fftSize);

    // Ping-pong delay with damped feedback.
    delayIn = ctx.createGain();
    delayIn.gain.value = P.delayMix;
    dL = ctx.createDelay(2.5);
    dR = ctx.createDelay(2.5);
    dL.delayTime.value = P.delayTime;
    dR.delayTime.value = P.delayTime;
    dampL = ctx.createBiquadFilter();
    dampR = ctx.createBiquadFilter();
    dampL.type = 'lowpass'; dampR.type = 'lowpass';
    dampL.frequency.value = P.delayDamp; dampR.frequency.value = P.delayDamp;
    dampL.Q.value = 0.4; dampR.Q.value = 0.4;
    fbL = ctx.createGain(); fbR = ctx.createGain();
    fbL.gain.value = P.delayFb; fbR.gain.value = P.delayFb;
    delayOut = ctx.createGain();
    delayOut.gain.value = 1;

    if (typeof ctx.createStereoPanner === 'function') {
      panL = ctx.createStereoPanner(); panL.pan.value = -0.8;
      panR = ctx.createStereoPanner(); panR.pan.value = 0.8;
    } else {
      panL = ctx.createGain();
      panR = ctx.createGain();
    }

    delayIn.connect(dL);
    dL.connect(dampL); dampL.connect(fbL); fbL.connect(dR);
    dR.connect(dampR); dampR.connect(fbR); fbR.connect(dL);
    dL.connect(panL); panL.connect(delayOut);
    dR.connect(panR); panR.connect(delayOut);

    // Reverb from a procedurally generated impulse response.
    revIn = ctx.createGain();
    revIn.gain.value = P.revMix;
    convolver = ctx.createConvolver();
    convolver.normalize = true;
    convolver.buffer = buildIR(P.revSize);
    irSizeCached = P.revSize;
    revOut = ctx.createGain();
    revOut.gain.value = 0.9;
    revIn.connect(convolver); convolver.connect(revOut);

    // LFO sources.
    lfoBus = ctx.createGain();
    lfoBus.gain.value = 1;
    lfoOsc = ctx.createOscillator();
    lfoOsc.type = (P.lfoWave === 'sh') ? 'triangle' : P.lfoWave;
    lfoOsc.frequency.value = P.lfoRate;
    lfoOscGain = ctx.createGain();
    lfoOscGain.gain.value = (P.lfoWave === 'sh') ? 0 : 1;
    lfoOsc.connect(lfoOscGain); lfoOscGain.connect(lfoBus);

    if (typeof ctx.createConstantSource === 'function') {
      shSrc = ctx.createConstantSource();
      shSrc.offset.value = 0;
      shGain = ctx.createGain();
      shGain.gain.value = (P.lfoWave === 'sh') ? 1 : 0;
      shSrc.connect(shGain); shGain.connect(lfoBus);
      try { shSrc.start(ctx.currentTime); } catch (e) { /* ignore */ }
    }

    lfoPitchGain = ctx.createGain(); lfoPitchGain.gain.value = 0;
    lfoCutGain = ctx.createGain(); lfoCutGain.gain.value = 0;
    lfoAmpGain = ctx.createGain(); lfoAmpGain.gain.value = 0;
    lfoBus.connect(lfoPitchGain);
    lfoBus.connect(lfoCutGain);
    lfoBus.connect(lfoAmpGain);

    try { lfoOsc.start(ctx.currentTime); } catch (e) { /* ignore */ }

    // Wire the master path.
    voiceBus.connect(driveIn);
    driveIn.connect(shaper);
    shaper.connect(driveOut);
    driveOut.connect(fxBus);

    fxBus.connect(dryGain); dryGain.connect(master);
    fxBus.connect(delayIn); delayOut.connect(master);
    fxBus.connect(revIn); revOut.connect(master);

    master.connect(limiter);
    limiter.connect(ctx.destination);
    limiter.connect(analyser);

    voices = [];
    for (var i = 0; i < MAX_VOICES; i++) voices.push(makeVoice(i));

    built = true;
    applyAll();
  }

  /* ================================================================== *
   * Parameter application
   * ================================================================== */

  function voiceCutoff(midi) {
    var k = P.keyTrack * ((midi - 60) / 12);
    return clamp(P.cutoff * Math.pow(2, k), 20, 18500);
  }

  function applyOscWaves() {
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      v.o1.type = P.osc1wave;
      v.o2.type = P.osc2wave;
      v.sub.type = P.subWave;
    }
  }

  function applyOscLevels() {
    var t = now();
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      setSmooth(v.g1.gain, P.osc1Level * 0.34, t, 0.02);
      setSmooth(v.g2.gain, P.osc2Level * 0.34, t, 0.02);
      setSmooth(v.gs.gain, P.subLevel * 0.34, t, 0.02);
    }
  }

  function applyDetune() {
    var t = now();
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      var d = P.detune * 0.5;
      setSmooth(v.o1.detune, -d + v.drift, t, 0.02);
      setSmooth(v.o2.detune, d - v.drift, t, 0.02);
      setSmooth(v.sub.detune, v.drift * 0.4, t, 0.02);
    }
  }

  function applyOscPitch() {
    var t = now();
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      if (!v.active || v.midi < 0) continue;
      var f = mtof(v.midi);
      setSmooth(v.o2.frequency, f * Math.pow(2, P.osc2Oct), t, 0.02);
      setSmooth(v.sub.frequency, f * 0.5, t, 0.02);
    }
  }

  function applyFilterStatic() {
    var t = now();
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      v.filt.type = P.filtType;
      setSmooth(v.filt.Q, P.reso, t, 0.02);
      if (v.active && v.midi >= 0) {
        try { v.filt.frequency.cancelScheduledValues(t); } catch (e) { /* ignore */ }
        setSmooth(v.filt.frequency, voiceCutoff(v.midi), t, 0.02);
      } else {
        setNow(v.filt.frequency, voiceCutoff(60), t);
      }
    }
  }

  function applyLfo() {
    var t = now();
    var sh = (P.lfoWave === 'sh');
    if (lfoOsc) {
      if (!sh) { try { lfoOsc.type = P.lfoWave; } catch (e) { /* ignore */ } }
      setSmooth(lfoOsc.frequency, P.lfoRate, t, 0.02);
    }
    if (lfoOscGain) setSmooth(lfoOscGain.gain, sh ? 0 : 1, t, 0.01);
    if (shGain) setSmooth(shGain.gain, sh ? 1 : 0, t, 0.01);

    if (shTimer) { clearInterval(shTimer); shTimer = null; }
    if (sh && shSrc) {
      var ms = Math.max(16, 1000 / Math.max(P.lfoRate, 0.02));
      shTimer = setInterval(function () {
        if (!ctx || !shSrc) return;
        setNow(shSrc.offset, Math.random() * 2 - 1, now());
      }, ms);
    }

    var tgt = P.lfoTarget;
    var d = P.lfoDepth;
    setSmooth(lfoPitchGain.gain, tgt === 'pitch' ? d * 120 : 0, t, 0.03);
    setSmooth(lfoCutGain.gain, tgt === 'cutoff' ? d * 3600 : 0, t, 0.03);
    setSmooth(lfoAmpGain.gain, tgt === 'amp' ? d * 0.6 : 0, t, 0.03);
  }

  function applyDrive() {
    var t = now();
    var pre = 1 + P.drive * 7;
    var post = 1 / Math.pow(pre, 0.7);
    setSmooth(driveIn.gain, pre, t, 0.03);
    setSmooth(driveOut.gain, post, t, 0.03);
  }

  function applyDelay() {
    var t = now();
    setSmooth(dL.delayTime, P.delayTime, t, 0.05);
    setSmooth(dR.delayTime, P.delayTime, t, 0.05);
    setSmooth(fbL.gain, P.delayFb, t, 0.03);
    setSmooth(fbR.gain, P.delayFb, t, 0.03);
    setSmooth(dampL.frequency, P.delayDamp, t, 0.03);
    setSmooth(dampR.frequency, P.delayDamp, t, 0.03);
    setSmooth(delayIn.gain, P.delayMix, t, 0.03);
  }

  function applyReverb() {
    var t = now();
    setSmooth(revIn.gain, P.revMix, t, 0.03);
    if (Math.abs(P.revSize - irSizeCached) > 0.02) {
      // Rendering the impulse response is the one expensive operation here, so
      // it is debounced: dragging the size slider must not stutter the UI.
      if (irTimer) clearTimeout(irTimer);
      irTimer = setTimeout(function () {
        irTimer = null;
        if (!ctx || !convolver) return;
        irSizeCached = P.revSize;
        try { convolver.buffer = buildIR(P.revSize); } catch (e) { /* ignore */ }
      }, 120);
    }
  }

  function applyVolume() {
    setSmooth(master.gain, P.volume, now(), 0.03);
  }

  function applyAll() {
    if (!built) return;
    applyOscWaves();
    applyOscLevels();
    applyDetune();
    applyOscPitch();
    applyFilterStatic();
    applyLfo();
    applyDrive();
    applyDelay();
    applyReverb();
    applyVolume();
    syncArp();
  }

  function applyParam(name) {
    if (!built) return;
    switch (name) {
      case 'osc1wave': case 'osc2wave': case 'subWave': applyOscWaves(); break;
      case 'osc1Level': case 'osc2Level': case 'subLevel': applyOscLevels(); break;
      case 'detune': applyDetune(); break;
      case 'osc2Oct': applyOscPitch(); break;
      case 'glide': break;
      case 'filtType': case 'reso': case 'cutoff': case 'keyTrack': applyFilterStatic(); break;
      case 'lfoWave': case 'lfoRate': case 'lfoDepth': case 'lfoTarget': applyLfo(); break;
      case 'drive': applyDrive(); break;
      case 'delayTime': case 'delayFb': case 'delayDamp': case 'delayMix': applyDelay(); break;
      case 'revSize': case 'revMix': applyReverb(); break;
      case 'volume': applyVolume(); break;
      case 'arpOn': syncArp(); break;
      default: break; /* envelope + remaining arp params are read at trigger time */
    }
  }

  /* ================================================================== *
   * Voice allocation
   * ================================================================== */

  function findByMidi(midi) {
    for (var i = 0; i < voices.length; i++) {
      if (voices[i].active && voices[i].midi === midi && voices[i].gate) return voices[i];
    }
    return null;
  }

  function allocate() {
    var i, v;
    for (i = 0; i < voices.length; i++) if (!voices[i].active) return voices[i];
    // Steal the oldest released voice first.
    var best = null;
    for (i = 0; i < voices.length; i++) {
      v = voices[i];
      if (!v.gate && (best === null || v.offTime < best.offTime)) best = v;
    }
    if (best) return best;
    // Otherwise the oldest held voice.
    best = voices[0];
    for (i = 1; i < voices.length; i++) if (voices[i].startTime < best.startTime) best = voices[i];
    return best;
  }

  function freeVoice(v) {
    v.active = false;
    v.gate = false;
    v.midi = -1;
    if (v.timer) { clearTimeout(v.timer); v.timer = null; }
  }

  function setVoicePitch(v, midi, t) {
    var f = mtof(midi);
    var f2 = f * Math.pow(2, P.osc2Oct);
    var fs = f * 0.5;
    if (P.glide > 0.001 && v.lastFreq > 0) {
      var tau = Math.max(P.glide, 0.005) / 3;
      anchor(v.o1.frequency, t); setSmooth(v.o1.frequency, f, t, tau);
      anchor(v.o2.frequency, t); setSmooth(v.o2.frequency, f2, t, tau);
      anchor(v.sub.frequency, t); setSmooth(v.sub.frequency, fs, t, tau);
    } else {
      anchor(v.o1.frequency, t); setNow(v.o1.frequency, f, t);
      anchor(v.o2.frequency, t); setNow(v.o2.frequency, f2, t);
      anchor(v.sub.frequency, t); setNow(v.sub.frequency, fs, t);
    }
    v.lastFreq = f;
  }

  // Fire an event at the moment the note is actually heard rather than when it
  // was scheduled: arpeggiator steps are queued up to SCHEDULE_AHEAD early.
  function emitAt(evt, data, t) {
    var lead = (t - now()) * 1000;
    if (lead > 5) setTimeout(function () { emit(evt, data); }, lead);
    else emit(evt, data);
  }

  /* Close the note a voice is still holding.
     A voice about to be re-used still owes a 'noteoff' for whatever it was
     playing: the pending timer scheduled in releaseVoice() is cancelled by the
     v.gen++ in triggerVoice(), and a stolen (still gated) voice never had one
     at all. Listeners count events, not voices — see markNote() in
     site/assets/js/demo.js — so without this the key stays lit until panic or
     a reload. Emitting here keeps every 'noteon' matched by one 'noteoff'.
     Nothing is emitted for a voice whose own 'noteon' has not fired yet: that
     pending emit is cancelled by the same generation bump. */
  function closeVoiceNote(v, t) {
    if (!v || !v.active || v.midi < 0) return;
    if (!v.onEmitted || v.offEmitted) return;
    var midi = v.midi;
    v.offEmitted = true;
    if (v.source === 'arp') {
      var ai = arpSounding.indexOf(midi);
      if (ai >= 0) arpSounding.splice(ai, 1);
    }
    emitAt('noteoff', { midi: midi, time: t, source: 'steal' }, t);
  }

  /* A note released before its own scheduled 'noteon' was reached (an
     arpeggiator step is queued up to SCHEDULE_AHEAD early, and stopArp() /
     noteOff() can release it in between) parks its 'noteoff' here so it is
     emitted right after the 'noteon' instead of ahead of it. Out of order, the
     UI counter would be left at +1 and the key would stick. */
  function flushPendingOff(v) {
    var p = v.pendingOff;
    if (!p) return;
    v.pendingOff = null;
    if (v.offEmitted) return;
    v.offEmitted = true;
    if (p.source === 'arp') {
      var i = arpSounding.indexOf(p.midi);
      if (i >= 0) arpSounding.splice(i, 1);
    }
    emit('noteoff', { midi: p.midi, time: p.time, source: p.source });
  }

  function triggerVoice(midi, vel, time, source) {
    var t = at(time);
    var src = source || 'key';
    // Live playing re-uses the voice already holding the note (legato
    // retrigger); arpeggiator steps are scheduled ahead of time and must
    // always take a fresh voice so the previous step can finish its tail.
    var v = (src === 'arp' ? null : findByMidi(midi)) || allocate();

    // Stolen voice, or a legato retrigger of a voice that is still gated:
    // release the note it was playing before the generation bump below drops
    // its pending 'noteoff'.
    closeVoiceNote(v, t);

    v.gen++;
    if (v.timer) { clearTimeout(v.timer); v.timer = null; }

    v.onEmitted = false;
    v.offEmitted = false;
    v.pendingOff = null;
    v.source = src;
    v.midi = midi;
    v.vel = vel;
    v.gate = true;
    v.active = true;
    v.startTime = t;

    setVoicePitch(v, midi, t);

    // Filter: static base from cutoff + key tracking, envelope on .detune (cents).
    var base = voiceCutoff(midi);
    anchor(v.filt.frequency, t);
    setNow(v.filt.frequency, base, t);
    v.filt.type = P.filtType;
    setNow(v.filt.Q, P.reso, t);
    attackDecay(v.filt.detune, t, P.fegAmt * (0.55 + 0.45 * vel), P.fegA, P.fegD, P.fegS);

    // Amplitude.
    var peak = 0.8 * Math.pow(clamp(vel, 0, 1), 1.1);
    attackDecay(v.vca.gain, t, peak, P.ampA, P.ampD, P.ampS);

    // Events fire when the note is actually heard, not when it is scheduled.
    var ev = { midi: midi, velocity: vel, time: t, source: src, voice: v.index };
    var lead = (t - now()) * 1000;
    if (lead > 5) {
      (function (voice, gen) {
        setTimeout(function () {
          if (voice.gen !== gen) return;   // stolen before it was ever heard
          voice.onEmitted = true;
          emit('noteon', ev);
          flushPendingOff(voice);
        }, lead);
      })(v, v.gen);
    } else {
      v.onEmitted = true;
      emit('noteon', ev);
      flushPendingOff(v);
    }
    return v;
  }

  function releaseVoice(v, time, source) {
    if (!v || !v.active || !v.gate) return;
    var t = at(time);
    var midi = v.midi;
    var src = source || 'key';
    var myGen = v.gen;

    // The slot is considered released immediately so voice stealing can see
    // it, while the audible release is scheduled at the exact time t.
    v.gate = false;
    v.offTime = t;

    var endAmp = releaseTo(v.vca.gain, t, 0, P.ampR);
    releaseTo(v.filt.detune, t, 0, P.fegR);

    if (v.timer) { clearTimeout(v.timer); v.timer = null; }

    setTimeout(function () {
      if (v.gen !== myGen) return;   // re-used: closeVoiceNote() already closed it
      if (v.offEmitted) return;
      if (!v.onEmitted) {
        // The 'noteon' for this note is still queued: park the 'noteoff' so it
        // cannot overtake it (flushPendingOff runs the moment the note sounds).
        v.pendingOff = { midi: midi, time: t, source: src };
        return;
      }
      v.offEmitted = true;
      if (src === 'arp') {
        var i = arpSounding.indexOf(midi);
        if (i >= 0) arpSounding.splice(i, 1);
      }
      emit('noteoff', { midi: midi, time: t, source: src });
    }, Math.max(0, (t - now()) * 1000));

    v.timer = setTimeout(function () {
      if (v.gen === myGen) freeVoice(v);
    }, Math.max(0, (endAmp - now()) * 1000));
  }

  function releaseMidi(midi, time, source) {
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      if (v.active && v.gate && v.midi === midi) releaseVoice(v, time, source);
    }
  }

  /* ================================================================== *
   * Arpeggiator — lookahead scheduler
   * ================================================================== */

  function stepDuration() {
    var beat = 60 / clamp(P.arpBpm, 20, 400);
    var div = ARP_DIV[P.arpRate];
    if (!isNum(div)) div = 0.25;
    return Math.max(0.02, beat * div);
  }

  function buildSequence() {
    if (!held.length) return [];
    var notes = held.slice().sort(function (a, b) { return a - b; });
    var octs = Math.round(clamp(P.arpOct, 1, 3));
    var base = [];
    for (var o = 0; o < octs; o++) {
      for (var i = 0; i < notes.length; i++) base.push(notes[i] + 12 * o);
    }
    var mode = P.arpMode;
    if (mode === 'down') return base.slice().reverse();
    if (mode === 'updown') {
      var seq = base.slice();
      for (var j = base.length - 2; j >= 1; j--) seq.push(base[j]);
      return seq;
    }
    return base; // 'up' and 'random' both index into the ascending set
  }

  function arpTick() {
    if (!ctx || !built) return;
    var c = now();
    if (arpNextTime < c) arpNextTime = c + 0.02;
    var guard = 0;
    while (arpNextTime < c + SCHEDULE_AHEAD && guard++ < 64) {
      var seq = buildSequence();
      var dur = stepDuration();
      if (seq.length) {
        var idx;
        if (P.arpMode === 'random') idx = Math.floor(Math.random() * seq.length);
        else idx = arpStep % seq.length;
        var midi = clamp(Math.round(seq[idx]), 0, 127);
        var onT = arpNextTime;
        var offT = onT + Math.max(0.02, dur * clamp(P.arpGate, 0.05, 1) * 0.98);
        var av = triggerVoice(midi, 0.92, onT, 'arp');
        if (arpSounding.indexOf(midi) < 0) arpSounding.push(midi);
        releaseVoice(av, offT, 'arp');
        arpStep++;
      } else {
        arpStep = 0;
      }
      arpNextTime += dur;
    }
  }

  function startArp() {
    if (arpTimer || !built) return;
    arpStep = 0;
    arpNextTime = now() + 0.05;
    arpTimer = setInterval(arpTick, LOOKAHEAD_MS);
  }

  function stopArp(retriggerHeld) {
    if (arpTimer) { clearInterval(arpTimer); arpTimer = null; }
    var pending = arpSounding.slice();
    arpSounding.length = 0;
    for (var i = 0; i < pending.length; i++) releaseMidi(pending[i], now(), 'arp');
    if (retriggerHeld) {
      for (var j = 0; j < held.length; j++) triggerVoice(held[j], 0.9, now(), 'key');
    }
  }

  function syncArp() {
    if (!built) return;
    if (P.arpOn === 'on') {
      // Held notes stop sounding directly; the arpeggiator drives them instead.
      for (var i = 0; i < held.length; i++) releaseMidi(held[i], now(), 'key');
      /* With nothing held there is nothing to schedule; noteOn starts the
         scheduler when the first note arrives. */
      if (held.length) startArp();
    } else if (arpTimer) {
      stopArp(true);
    }
  }

  /* ================================================================== *
   * Public API
   * ================================================================== */

  function coerce(spec, value) {
    if (!spec) return null;
    if (spec.type === 'enum') {
      var s = value;
      if (typeof s === 'boolean') s = s ? 'on' : 'off';
      if (typeof s === 'number' && spec.options[s] !== undefined) s = spec.options[s];
      if (typeof s !== 'string') return null;
      s = s.trim();
      return spec.options.indexOf(s) >= 0 ? s : null;
    }
    var n = (typeof value === 'string') ? parseFloat(value) : value;
    if (typeof n === 'boolean') n = n ? spec.max : spec.min;
    if (!isNum(n)) return null;
    return clamp(n, spec.min, spec.max);
  }

  function setParam(name, value) {
    var spec = SPEC_BY_NAME[name];
    if (!spec) return API;
    var val = coerce(spec, value);
    if (val === null) return API;
    if (P[name] === val) return API;
    P[name] = val;
    applyParam(name);
    emit('param', { name: name, value: val, spec: spec });
    return API;
  }

  function getParam(name) {
    return Object.prototype.hasOwnProperty.call(P, name) ? P[name] : undefined;
  }

  function getParams() {
    var out = {};
    for (var k in P) if (Object.prototype.hasOwnProperty.call(P, k)) out[k] = P[k];
    return out;
  }

  /* Total recall. A preset is a whole patch, not a diff: loading one starts
     from the factory defaults and overlays the values the patch names, so a
     parameter the patch does NOT name goes back to its default instead of
     keeping whatever the previous preset — or a knob the visitor moved — left
     behind. Without this, moving Osc 2 Level to zero and then choosing another
     preset leaves the oscillator silent, because most patches never mention it.

     loadPreset(obj, { merge: true }) keeps the old additive behaviour for a
     caller that really does want to overlay a partial patch on what is there.

     'param' fires only for parameters whose value actually changed, so the
     demo's control sync and section LEDs see exactly the moves that happened. */
  function loadPreset(obj, opts) {
    if (!obj || typeof obj !== 'object') return API;
    var merge = !!(opts && opts.merge);
    var src = obj.params && typeof obj.params === 'object' ? obj.params : obj;

    var next = merge ? getParams() : getDefaults();
    var applied = {};
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      var spec = SPEC_BY_NAME[k];
      if (!spec) continue;
      var val = coerce(spec, src[k]);
      if (val === null) continue;   // unknown or uncoercible: ignored, as before
      next[k] = val;
      applied[k] = val;
    }

    var changed = [];
    for (var n in next) {
      if (!Object.prototype.hasOwnProperty.call(next, n)) continue;
      if (!SPEC_BY_NAME[n]) continue;
      if (P[n] === next[n]) continue;
      P[n] = next[n];
      changed.push(n);
    }

    if (built) applyAll();
    emit('preset', { applied: applied, params: getParams(), merge: merge });
    for (var c = 0; c < changed.length; c++) {
      emit('param', { name: changed[c], value: P[changed[c]], spec: SPEC_BY_NAME[changed[c]] });
    }
    return API;
  }

  function getDefaults() {
    var out = {};
    for (var i = 0; i < PARAM_SPEC.length; i++) out[PARAM_SPEC[i].name] = PARAM_SPEC[i]['default'];
    return out;
  }

  function start() {
    if (!AC) return Promise.resolve(false);
    try {
      if (!ctx) {
        ctx = new AC();
        build();
      }
    } catch (e) {
      API.supported = false;
      return Promise.resolve(false);
    }
    var p;
    try {
      p = (ctx.state === 'suspended' && typeof ctx.resume === 'function')
        ? ctx.resume()
        : Promise.resolve();
    } catch (e2) {
      p = Promise.resolve();
    }
    if (!p || typeof p.then !== 'function') p = Promise.resolve();
    return p.then(function () {
      // A one-sample source unlocks stubborn mobile audio stacks.
      try {
        var b = ctx.createBuffer(1, 1, ctx.sampleRate);
        var s = ctx.createBufferSource();
        s.buffer = b;
        s.connect(ctx.destination);
        s.start(0);
      } catch (e3) { /* ignore */ }
      ready = true;
      API.ready = true;
      /* Resuming after stop(): rebuild the sample-and-hold interval that stop()
         cleared. Idempotent — a no-op for every other LFO wave. */
      try { if (built) applyLfo(); } catch (e4) { /* ignore */ }
      API.running = (ctx.state === 'running');
      API.sampleRate = ctx.sampleRate;
      emit('start', { sampleRate: ctx.sampleRate, state: ctx.state });
      return true;
    })['catch'](function () {
      API.running = false;
      return false;
    });
  }

  function stop() {
    if (!ctx || !built) return API;
    panic();
    /* The sample-and-hold LFO drives its offset from a plain interval; leaving
       it running would keep poking a suspended context. start() calls
       applyLfo() again, which recreates it when lfoWave is still 'sh'. */
    if (shTimer) { clearInterval(shTimer); shTimer = null; }
    try {
      if (typeof ctx.suspend === 'function') ctx.suspend();
    } catch (e) { /* ignore */ }
    API.running = false;
    emit('stop', {});
    return API;
  }

  function panic() {
    if (!built) return API;
    if (arpTimer) { clearInterval(arpTimer); arpTimer = null; }
    arpSounding.length = 0;
    held.length = 0;
    var t = now();
    var stopped = [];
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      /* One 'noteoff' per note that is still owed one — a voice whose release
         already emitted it is skipped, and a voice whose 'noteon' never fired
         (the generation bump below cancels it) needs none. */
      if (v.active && v.midi >= 0 && v.onEmitted && !v.offEmitted) {
        v.offEmitted = true;
        stopped.push(v.midi);
      }
      v.pendingOff = null;
      v.onEmitted = false;
      v.gen++;
      if (v.timer) { clearTimeout(v.timer); v.timer = null; }
      anchor(v.vca.gain, t);
      try { v.vca.gain.linearRampToValueAtTime(0, t + 0.015); } catch (e) { /* ignore */ }
      anchor(v.filt.detune, t);
      setSmooth(v.filt.detune, 0, t, 0.02);
      v.active = false;
      v.gate = false;
      v.midi = -1;
    }
    for (var k = 0; k < stopped.length; k++) {
      emit('noteoff', { midi: stopped[k], time: t, source: 'panic' });
    }
    return API;
  }

  function noteOn(midi, velocity) {
    if (!ready || !built) return API;
    var m = Math.round(Number(midi));
    if (!isNum(m) || m < 0 || m > 127) return API;
    var vel = isNum(velocity) ? clamp(velocity, 0, 1) : 0.85;
    if (held.indexOf(m) < 0) held.push(m);
    if (P.arpOn === 'on') {
      if (!arpTimer) startArp();
      return API;
    }
    triggerVoice(m, vel, now(), 'key');
    return API;
  }

  function noteOff(midi) {
    if (!ready || !built) return API;
    var m = Math.round(Number(midi));
    if (!isNum(m)) return API;
    var i = held.indexOf(m);
    if (i >= 0) held.splice(i, 1);
    if (P.arpOn === 'on') {
      if (!held.length) {
        var pending = arpSounding.slice();
        arpSounding.length = 0;
        for (var j = 0; j < pending.length; j++) releaseMidi(pending[j], now(), 'arp');
        arpStep = 0;
        /* Nothing is held, so the scheduler has nothing to schedule — park it
           rather than leaving a 25 ms interval waking the main thread. noteOn
           restarts it (and startArp re-seeds arpStep/arpNextTime). */
        if (arpTimer) { clearInterval(arpTimer); arpTimer = null; }
      }
      return API;
    }
    releaseMidi(m, now(), 'key');
    return API;
  }

  function setMasterVolume(v) {
    return setParam('volume', v);
  }

  /* ---- analysis ---- */

  function getWaveform(arr) {
    var n = analyser ? analyser.fftSize : 2048;
    var out = (arr && arr.length === n) ? arr : new Float32Array(n);
    if (!analyser) { out.fill(0); return out; }
    try {
      if (typeof analyser.getFloatTimeDomainData === 'function') {
        analyser.getFloatTimeDomainData(out);
      } else {
        out.fill(0);
      }
    } catch (e) { out.fill(0); }
    return out;
  }

  function getSpectrum(arr) {
    var n = analyser ? analyser.frequencyBinCount : 1024;
    var out = (arr && arr.length === n) ? arr : new Uint8Array(n);
    if (!analyser) { out.fill(0); return out; }
    try { analyser.getByteFrequencyData(out); } catch (e) { out.fill(0); }
    return out;
  }

  function getLevel() {
    if (!analyser || !analysisScratch) return 0;
    try {
      if (typeof analyser.getFloatTimeDomainData !== 'function') return 0;
      analyser.getFloatTimeDomainData(analysisScratch);
    } catch (e) { return 0; }
    var sum = 0;
    for (var i = 0; i < analysisScratch.length; i++) {
      var x = analysisScratch[i];
      sum += x * x;
    }
    return clamp(Math.sqrt(sum / analysisScratch.length), 0, 1);
  }

  function getAnalyserInfo() {
    return {
      fftSize: analyser ? analyser.fftSize : 2048,
      frequencyBinCount: analyser ? analyser.frequencyBinCount : 1024,
      sampleRate: ctx ? ctx.sampleRate : 0
    };
  }

  /* ---- note helpers ---- */

  function midiToName(midi) {
    var m = Math.round(Number(midi));
    if (!isNum(m)) return '';
    var name = NOTE_NAMES[((m % 12) + 12) % 12];
    var oct = Math.floor(m / 12) - 1;
    return name + oct;
  }

  function nameToMidi(name) {
    if (typeof name !== 'string') return -1;
    var m = name.trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
    if (!m) return -1;
    var base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
    if (base === undefined) return -1;
    if (m[2] === '#') base += 1;
    else if (m[2] === 'b') base -= 1;
    var midi = base + (parseInt(m[3], 10) + 1) * 12;
    return (midi >= 0 && midi <= 127) ? midi : -1;
  }

  /* ---- computer keyboard map ---- */

  var KEYMAP = {
    a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
    k: 12, o: 13, l: 14, p: 15, ';': 16
  };
  var OCTAVE_KEYS = { down: 'z', up: 'x' };
  var octave = 4;

  function getOctave() { return octave; }
  function setOctave(o) {
    var n = Math.round(Number(o));
    if (isNum(n)) octave = clamp(n, 0, 8);
    return octave;
  }
  function shiftOctave(delta) {
    return setOctave(octave + (isNum(delta) ? delta : 0));
  }
  function keyToMidi(key) {
    if (typeof key !== 'string') return -1;
    var k = key.length === 1 ? key.toLowerCase() : key;
    if (!Object.prototype.hasOwnProperty.call(KEYMAP, k)) return -1;
    var midi = 12 * (octave + 1) + KEYMAP[k];
    return (midi >= 0 && midi <= 127) ? midi : -1;
  }

  function getHeldNotes() { return held.slice(); }

  function getVoiceStates() {
    var out = [];
    for (var i = 0; i < voices.length; i++) {
      out.push({
        index: i,
        midi: voices[i].midi,
        active: voices[i].active,
        gate: voices[i].gate,
        velocity: voices[i].vel
      });
    }
    return out;
  }

  /* ================================================================== *
   * Export
   * ================================================================== */

  var API = {
    version: VERSION,
    supported: !!AC,
    ready: false,
    running: false,
    sampleRate: 0,
    MAX_VOICES: MAX_VOICES,
    PARAM_SPEC: PARAM_SPEC,
    NOTE_NAMES: NOTE_NAMES,
    KEYMAP: KEYMAP,
    OCTAVE_KEYS: OCTAVE_KEYS,

    start: start,
    stop: stop,
    panic: panic,
    noteOn: noteOn,
    noteOff: noteOff,
    setParam: setParam,
    getParam: getParam,
    getParams: getParams,
    getDefaults: getDefaults,
    loadPreset: loadPreset,
    setMasterVolume: setMasterVolume,
    on: on,
    off: off,

    getWaveform: getWaveform,
    getSpectrum: getSpectrum,
    getLevel: getLevel,
    getAnalyserInfo: getAnalyserInfo,

    midiToName: midiToName,
    nameToMidi: nameToMidi,
    keyToMidi: keyToMidi,
    getOctave: getOctave,
    setOctave: setOctave,
    shiftOctave: shiftOctave,
    getHeldNotes: getHeldNotes,
    getVoiceStates: getVoiceStates
  };

  if (!AC) {
    // Graceful degradation: keep the same shape, make every action inert.
    API.start = function () { return Promise.resolve(false); };
    API.stop = function () { return API; };
    API.panic = function () { return API; };
    API.noteOn = function () { return API; };
    API.noteOff = function () { return API; };
  }

  global.SSSynth = API;
})(typeof window !== 'undefined' ? window : this);
