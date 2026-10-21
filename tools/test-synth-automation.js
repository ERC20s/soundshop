#!/usr/bin/env node
'use strict';
/*
 * tools/test-synth-automation.js — the VANTA engine must not click, leak or
 * stay silent on iOS.
 *
 * Runs site/assets/js/synth.js in a vm sandbox against a stub AudioContext
 * whose AudioParams RECORD every automation call, and renders those recorded
 * timelines with a reference evaluator written here, independently of the
 * engine. Checks:
 *
 *   1. No gain jumps. Each voice's VCA gain, rendered at 48 kHz across note-on,
 *      legato retrigger, voice stealing, release and panic, never moves more
 *      than MAX_STEP between two samples. Rendering is done the way an audio
 *      thread does it: each sample is computed from the timeline as it stood
 *      when that sample was rendered, and a call made at currentTime takes
 *      effect one render quantum later — so an event scheduled "now" has
 *      already partly passed. cancelAndHoldAtTime() is modelled the
 *      way Chromium behaved when measured with an OfflineAudioContext: it
 *      cancels, but pins no value when nothing is automating the param at t,
 *      so a linear attack after it interpolates from an older event and the
 *      gain jumps. An engine that relies on it fails here, as it clicked there.
 *   2. Parameter changes ramp. Moving every continuous parameter while a note
 *      sounds schedules no setValueAtTime that changes a value; discrete
 *      switches (oscillator shape, filter type) happen only while the voice bus
 *      is ducked to silence, and every switch requested under one duck (a
 *      preset changing shapes and filter type together) lands on every voice.
 *   3. No voice leaks. Hundreds of notes, the arpeggiator and start/stop cycles
 *      create no audio nodes beyond the fixed graph, except one-shot unlock
 *      sources that disconnect themselves when they end; never more than
 *      MAX_VOICES voices are active, and none once every note is released.
 *   4. iOS Safari. The context is resumed and the unlock buffer started
 *      synchronously inside the gesture that calls start(); a context the OS
 *      'interrupted' is resumed by the next gesture; stop() does not suspend
 *      the clock before panic's fade has reached silence.
 *
 * Zero dependencies, Node 18+. Exit 0 when every assertion holds, 2 otherwise.
 */

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var TARGET = path.join(__dirname, '..', 'site', 'assets', 'js', 'synth.js');
var SR = 48000;
var QUANTUM = 128 / SR;   // a main-thread call lands on the next render quantum
var MAX_STEP = 0.01;   // per-sample gain change; the gentlest click is far above it

var errors = [];
function ok(msg) { console.log('OK: ' + msg); }
function bad(msg) { errors.push(msg); console.log('FAIL: ' + msg); }

if (!fs.existsSync(TARGET)) {
  console.error('ERROR: site/assets/js/synth.js not found at ' + TARGET);
  process.exit(2);
}
var source = fs.readFileSync(TARGET, 'utf8');

/* ================================================================== *
 * Reference automation evaluator (Web Audio rules for set / linear ramp /
 * setTarget, plus cancel). Deliberately independent of the engine's code.
 * ================================================================== */

function RecParam(value, owner, name) {
  this.initial = typeof value === 'number' ? value : 0;
  this.events = [];      // { kind, v, t, tau, seq }
  this.calls = [];       // every call, in order, for inspection
  this.owner = owner;
  this.name = name;
  this.seq = 0;
  this._value = this.initial;
  this.history = [];     // { until, events, initial }: what was rendered before `until`
}
// Freeze the timeline the audio thread has been rendering, up to the quantum
// this call can first affect.
RecParam.prototype._snap = function () {
  this.history.push({ until: clock.now() + QUANTUM, events: this.events.slice(), initial: this.initial });
};
Object.defineProperty(RecParam.prototype, 'value', {
  get: function () { return this._value; },
  set: function (v) { this._snap(); this._value = v; this.initial = v; }
});
RecParam.prototype._add = function (kind, v, t, tau) {
  this._snap();
  this.calls.push({ kind: kind, v: v, t: t, tau: tau, at: clock.now() });
  this.events.push({ kind: kind, v: v, t: t, tau: tau, seq: this.seq++ });
  this.events.sort(function (a, b) { return a.t - b.t || a.seq - b.seq; });
  return this;
};
RecParam.prototype.setValueAtTime = function (v, t) { return this._add('set', v, t); };
RecParam.prototype.linearRampToValueAtTime = function (v, t) { return this._add('ramp', v, t); };
RecParam.prototype.setTargetAtTime = function (v, t, tau) { return this._add('target', v, t, tau); };
RecParam.prototype.exponentialRampToValueAtTime = function (v, t) { return this._add('ramp', v, t); };
RecParam.prototype.cancelScheduledValues = function (t) {
  this._snap();
  this.calls.push({ kind: 'cancel', t: t, at: clock.now() });
  this.events = this.events.filter(function (e) { return e.t < t; });
  return this;
};
// Chromium-observed: cancels, pins nothing (see header).
RecParam.prototype.cancelAndHoldAtTime = function (t) {
  this._snap();
  this.calls.push({ kind: 'hold', t: t, at: clock.now() });
  this.events = this.events.filter(function (e) { return e.t < t; });
  return this;
};
RecParam.prototype.valueAt = function (x) { return evaluate(this.events, this.initial, x); };
function evaluate(events, initial, x) {
  var t0 = 0, v0 = initial, tgt = null, tau = 0;
  function cur(at) { return tgt === null ? v0 : tgt + (v0 - tgt) * Math.exp(-(at - t0) / tau); }
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (e.kind === 'ramp') {
      if (x < e.t) {
        var start = cur(t0);
        return x <= t0 ? cur(x) : start + (e.v - start) * (x - t0) / (e.t - t0);
      }
      t0 = e.t; v0 = e.v; tgt = null;
    } else {
      if (x < e.t) break;
      if (e.kind === 'set') { v0 = e.v; tgt = null; }
      else { v0 = cur(e.t); tgt = e.v; tau = e.tau; }
      t0 = e.t;
    }
  }
  return cur(x);
}
// Largest sample-to-sample change in what was actually rendered between
// `from` and `to` (seconds): each sample uses the timeline in force then.
RecParam.prototype.maxStep = function (from, to) {
  var self = this;
  var h = 0;
  function rendered(x) {
    while (h < self.history.length && self.history[h].until <= x) h++;
    var snap = self.history[h];
    return snap ? evaluate(snap.events, snap.initial, x) : self.valueAt(x);
  }
  var worst = { step: 0, at: 0 };
  var prev = rendered(from);
  for (var n = Math.floor(from * SR) + 1; n <= Math.ceil(to * SR); n++) {
    var v = rendered(n / SR);
    var d = Math.abs(v - prev);
    if (d > worst.step) { worst.step = d; worst.at = n / SR; }
    prev = v;
  }
  return worst;
};

/* ================================================================== *
 * A controllable clock: audio time only moves when the test advances it,
 * and setTimeout callbacks fire in audio-time order as it does.
 * ================================================================== */

var clock = {
  t: 0,
  timers: [],
  id: 0,
  now: function () { return clock.t; },
  setTimeout: function (fn, ms) {
    var id = ++clock.id;
    clock.timers.push({ id: id, fn: fn, due: clock.t + Math.max(0, Number(ms) || 0) / 1000, every: 0 });
    return id;
  },
  setInterval: function (fn, ms) {
    var id = ++clock.id;
    var every = Math.max(1, Number(ms) || 0) / 1000;
    clock.timers.push({ id: id, fn: fn, due: clock.t + every, every: every });
    return id;
  },
  clear: function (id) {
    clock.timers = clock.timers.filter(function (x) { return x.id !== id; });
  },
  advance: function (sec) {
    var end = clock.t + sec;
    for (;;) {
      var next = null;
      for (var i = 0; i < clock.timers.length; i++) {
        if (clock.timers[i].due <= end && (!next || clock.timers[i].due < next.due)) next = clock.timers[i];
      }
      if (!next) break;
      clock.t = Math.max(clock.t, next.due);
      if (next.every) next.due += next.every; else clock.clear(next.id);
      next.fn();
    }
    clock.t = end;
  },
  reset: function () { clock.t = 0; clock.timers = []; }
};

/* ================================================================== *
 * Stub Web Audio graph that records connections and node creation.
 * ================================================================== */

var created = [];   // { kind, node, at }

function Node(kind, extra) {
  var self = this;
  this.kind = kind;
  this.outs = [];
  this.connect = function (dst) { self.outs.push(dst); return dst; };
  this.disconnect = function () { self.disconnected = true; self.outs = []; };
  this.start = function (t) { self.startedAt = clock.now(); self.startedInGesture = gesture.active; };
  this.stop = function () {};
  if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) this[k] = extra[k];
}

var gesture = { active: false };

function Ctx() {
  this.sampleRate = SR;
  this.state = 'suspended';            // iOS: a fresh context starts suspended
  this.destination = new Node('destination');
  this.resumeCalls = [];
  this.suspendCalls = [];
  this.listeners = {};
  Ctx.last = this;
}
Object.defineProperty(Ctx.prototype, 'currentTime', { get: function () { return clock.now(); } });
Ctx.prototype.addEventListener = function (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); };
Ctx.prototype.setState = function (s) {
  this.state = s;
  (this.listeners.statechange || []).forEach(function (fn) { fn(); });
};
// iOS: resume() succeeds only when called synchronously inside a gesture.
Ctx.prototype.resume = function () {
  var self = this;
  this.resumeCalls.push({ at: clock.now(), inGesture: gesture.active });
  if (gesture.active) { self.setState('running'); return Promise.resolve(); }
  return new Promise(function () { /* never settles: iOS ignores it */ });
};
Ctx.prototype.suspend = function () {
  this.suspendCalls.push({ at: clock.now() });
  this.setState('suspended');
  return Promise.resolve();
};
function make(kind, ctx, extra) {
  var n = new Node(kind, extra);
  created.push({ kind: kind, node: n, at: clock.now() });
  return n;
}
function P(v, owner, name) { return new RecParam(v, owner, name); }
Ctx.prototype.createGain = function () { var n = make('gain', this); n.gain = P(1, n, 'gain'); return n; };
Ctx.prototype.createOscillator = function () {
  var n = make('osc', this);
  n.frequency = P(440, n, 'frequency'); n.detune = P(0, n, 'detune');
  var type = 'sine';
  n.typeChanges = [];
  Object.defineProperty(n, 'type', {
    get: function () { return type; },
    set: function (v) { if (v !== type) n.typeChanges.push({ to: v, at: clock.now() }); type = v; }
  });
  return n;
};
Ctx.prototype.createBiquadFilter = function () {
  var n = make('biquad', this);
  n.frequency = P(350, n, 'frequency'); n.Q = P(1, n, 'Q'); n.detune = P(0, n, 'detune'); n.gain = P(0, n, 'gain');
  var type = 'lowpass';
  n.typeChanges = [];
  Object.defineProperty(n, 'type', {
    get: function () { return type; },
    set: function (v) { if (v !== type) n.typeChanges.push({ to: v, at: clock.now() }); type = v; }
  });
  return n;
};
Ctx.prototype.createWaveShaper = function () { return make('shaper', this, { curve: null, oversample: 'none' }); };
Ctx.prototype.createDelay = function () { var n = make('delay', this); n.delayTime = P(0, n, 'delayTime'); return n; };
Ctx.prototype.createDynamicsCompressor = function () {
  var n = make('comp', this);
  ['threshold', 'knee', 'ratio', 'attack', 'release'].forEach(function (k) { n[k] = P(0, n, k); });
  return n;
};
Ctx.prototype.createAnalyser = function () {
  return make('analyser', this, {
    fftSize: 2048, frequencyBinCount: 1024, smoothingTimeConstant: 0.8,
    getFloatTimeDomainData: function (a) { a.fill(0); }, getByteFrequencyData: function (a) { a.fill(0); }
  });
};
Ctx.prototype.createConvolver = function () { return make('convolver', this, { normalize: true, buffer: null }); };
Ctx.prototype.createStereoPanner = function () { var n = make('panner', this); n.pan = P(0, n, 'pan'); return n; };
Ctx.prototype.createConstantSource = function () { var n = make('const', this); n.offset = P(0, n, 'offset'); return n; };
Ctx.prototype.createBufferSource = function () { return make('buffersource', this, { buffer: null, onended: null }); };
Ctx.prototype.createBuffer = function (ch, len, sr) {
  var data = []; for (var i = 0; i < ch; i++) data.push(new Float32Array(len));
  return { numberOfChannels: ch, length: len, sampleRate: sr, getChannelData: function (i) { return data[i]; } };
};

/* ================================================================== *
 * A fresh engine per case.
 * ================================================================== */

function fresh() {
  clock.reset();
  created = [];
  Ctx.last = null;
  var winListeners = {};
  var sandbox = {
    console: console,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clear,
    setInterval: clock.setInterval,
    clearInterval: clock.clear,
    Promise: Promise,
    Math: Math,
    AudioContext: Ctx,
    addEventListener: function (type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'site/assets/js/synth.js' });
  var S = sandbox.SSSynth;
  if (!S || !S.supported) {
    console.error('ERROR: synth.js did not expose a supported SSSynth against the stub');
    process.exit(2);
  }
  return {
    S: S,
    fire: function (type) {
      gesture.active = true;
      try { (winListeners[type] || []).forEach(function (fn) { fn({ type: type }); }); }
      finally { gesture.active = false; }
    }
  };
}

// start() from inside a simulated user gesture, then let promises settle.
function startInGesture(S) {
  gesture.active = true;
  var p;
  try { p = S.start(); } finally { gesture.active = false; }
  return p;
}

function flush() { return new Promise(function (r) { setImmediate(r); }); }

function voicesOf() {
  // A voice is osc -> gain -> mix ...; its VCA is the gain that feeds the voice bus.
  var gains = created.filter(function (c) { return c.kind === 'gain'; }).map(function (c) { return c.node; });
  var biquads = created.filter(function (c) { return c.kind === 'biquad'; }).map(function (c) { return c.node; });
  var trems = gains.filter(function (g) { return g.outs.length === 1 && g.outs[0].kind === 'gain' && biquads.some(function (b) { return b.outs.indexOf(g) >= 0; }); });
  return trems.map(function (trem) {
    var vca = trem.outs[0];
    return { vca: vca, bus: vca.outs[0] };
  });
}

var PATCH = {
  osc1wave: 'sawtooth', osc2wave: 'sawtooth', ampA: 0.005, ampD: 0.2, ampS: 0.7, ampR: 0.1,
  fegA: 0.005, fegD: 0.2, fegS: 0.3, fegR: 0.1, lfoDepth: 0, arpOn: 'off'
};

/* ================================================================== *
 * 1. No gain jumps on note-on, retrigger, steal, release, panic.
 * ================================================================== */
function caseNoJumps() {
  var E = fresh(), S = E.S;
  return startInGesture(S).then(flush).then(function () {
    S.loadPreset(PATCH);
    clock.advance(0.05);
    var t0 = clock.now();
    S.noteOn(60, 1); clock.advance(0.15);            // note-on
    S.noteOn(60, 1); clock.advance(0.10);            // legato retrigger
    S.noteOff(60); clock.advance(0.02);               // release ...
    S.noteOn(62, 1); clock.advance(0.05);            // ... and a new note mid-release
    for (var i = 0; i < 12; i++) { S.noteOn(64 + i, 0.9); clock.advance(0.03); }   // steal 4+
    S.panic(); clock.advance(0.3);
    var t1 = clock.now();

    var vs = voicesOf();
    if (vs.length !== S.MAX_VOICES) { bad('expected ' + S.MAX_VOICES + ' voices in the graph, found ' + vs.length); return; }
    var worst = { step: 0, at: 0, v: -1 };
    vs.forEach(function (v, idx) {
      var w = v.vca.gain.maxStep(t0, t1);
      if (w.step > worst.step) worst = { step: w.step, at: w.at, v: idx };
    });
    if (worst.step > MAX_STEP) {
      bad('voice ' + worst.v + ' VCA gain jumps by ' + worst.step.toFixed(3) + ' in one sample at t=' +
          worst.at.toFixed(4) + 's — an audible click (limit ' + MAX_STEP + ')');
    } else {
      ok('VCA gain is continuous through note-on, retrigger, steal, release and panic (worst step ' +
         worst.step.toFixed(4) + ')');
    }
    var holds = 0;
    vs.forEach(function (v) { holds += v.vca.gain.calls.filter(function (c) { return c.kind === 'hold'; }).length; });
    if (holds) bad('the engine still anchors with cancelAndHoldAtTime (' + holds + ' call(s)), which Chromium resolves wrongly');
    else ok('no envelope depends on cancelAndHoldAtTime');
  });
}

/* ================================================================== *
 * 2. Parameter changes ramp; discrete switches happen under a duck.
 * ================================================================== */
function caseParamsRamp() {
  var E = fresh(), S = E.S;
  return startInGesture(S).then(flush).then(function () {
    S.loadPreset(PATCH);
    S.noteOn(57, 1);
    clock.advance(0.2);

    // Every param anywhere in the graph: note how many calls it had so far.
    var params = [];
    created.forEach(function (c) {
      for (var k in c.node) if (c.node[k] instanceof RecParam) params.push(c.node[k]);
    });
    var before = params.map(function (p) { return p.calls.length; });

    var moved = 0;
    S.PARAM_SPEC.forEach(function (spec) {
      if (spec.type !== 'range' || spec.group === 'arp' || /^(amp|feg)[ADSR]$/.test(spec.name) || spec.name === 'glide') return;
      var cur = S.getParam(spec.name);
      var to = cur === spec.max ? spec.min : spec.max;
      S.setParam(spec.name, to);
      moved++;
      params.forEach(function (p, i) {
        var calls = p.calls.slice(before[i]);
        calls.forEach(function (c) {
          if (c.kind !== 'set') return;
          var was = p.valueAt(c.t - 1e-9);
          if (Math.abs(was - c.v) > 1e-6 * Math.max(1, Math.abs(was))) {
            bad('setParam(' + spec.name + ') jumps ' + p.owner.kind + '.' + p.name + ' from ' + was.toFixed(4) +
                ' to ' + c.v + ' with setValueAtTime instead of a ramp');
          }
        });
        before[i] = p.calls.length;
      });
      clock.advance(0.03);
    });
    ok('moved ' + moved + ' continuous parameters under a sounding note');

    var vs = voicesOf();
    var bus = vs[0].bus;
    var oscs = created.filter(function (c) { return c.kind === 'osc'; }).map(function (c) { return c.node; });
    var filts = created.filter(function (c) { return c.kind === 'biquad'; }).map(function (c) { return c.node; });
    var mark = clock.now();
    S.setParam('osc1wave', 'square');
    S.setParam('filtType', 'highpass');
    clock.advance(0.2);
    var switches = [];
    oscs.concat(filts).forEach(function (n) { n.typeChanges.forEach(function (ch) { if (ch.at >= mark) switches.push(ch); }); });
    if (!switches.length) { bad('changing osc1wave / filtType switched no node'); return; }
    var loud = switches.filter(function (ch) { return bus.gain.valueAt(ch.at) > 1e-3; });
    if (loud.length) {
      bad(loud.length + ' oscillator/filter type switch(es) happened with the voice bus at gain ' +
          bus.gain.valueAt(loud[0].at).toFixed(3) + ' — a click');
    } else {
      ok('oscillator shape and filter type switch only while the voice bus is ducked (' + switches.length + ' switches)');
    }
    var after = bus.gain.valueAt(clock.now());
    if (Math.abs(after - bus.gain.initial) > 1e-3) bad('the voice bus did not come back after a duck (gain ' + after.toFixed(3) + ')');
    else ok('the voice bus returns to its level after the duck');
    // Some node switching is not enough: BOTH switches asked for under the
    // one duck must have landed on every voice.
    expectVoiceTypes(S, 'setParam(osc1wave) then setParam(filtType) under one duck');
  });
}

/* Every voice's oscillators and filter, found from the graph: osc -> gain ->
   mix -> filter -> trem -> vca. Oscillators are created o1, o2, sub. */
function voiceNodesOf() {
  var nodes = created.map(function (c) { return c.node; });
  return voicesOf().map(function (v) {
    var trem = nodes.filter(function (n) { return n.outs.indexOf(v.vca) >= 0; })[0];
    var filt = nodes.filter(function (n) { return n.kind === 'biquad' && n.outs.indexOf(trem) >= 0; })[0];
    var mix = nodes.filter(function (n) { return n.kind === 'gain' && n.outs.indexOf(filt) >= 0; })[0];
    var oscs = nodes.filter(function (n) {
      return n.kind === 'osc' && n.outs.some(function (g) { return g.outs.indexOf(mix) >= 0; });
    });
    return { o1: oscs[0], o2: oscs[1], sub: oscs[2], filt: filt };
  });
}

// Every voice's node types must match the engine's current parameters.
function expectVoiceTypes(S, what) {
  var want = { o1: S.getParam('osc1wave'), o2: S.getParam('osc2wave'), sub: S.getParam('subWave'), filt: S.getParam('filtType') };
  var vs = voiceNodesOf();
  if (vs.length !== S.MAX_VOICES || vs.some(function (v) { return !v.o1 || !v.o2 || !v.sub || !v.filt; })) {
    bad(what + ': could not find the oscillators and filter of all ' + S.MAX_VOICES + ' voices in the graph');
    return;
  }
  var wrong = [];
  vs.forEach(function (v, i) {
    Object.keys(want).forEach(function (k) {
      if (v[k].type !== want[k]) wrong.push('voice ' + i + ' ' + k + ' is ' + v[k].type + ', engine says ' + want[k]);
    });
  });
  if (wrong.length) bad(what + ': ' + wrong.length + ' node(s) never switched (' + wrong.slice(0, 3).join('; ') + ')');
  else ok(what + ': every voice runs the oscillator shapes and filter type the engine reports');
}

/* ================================================================== *
 * 2b. A preset that changes oscillator shapes AND filter type while a note
 *     rings applies all of them. Both switches duck the same voice bus; the
 *     second must join the pending duck, not replace the first.
 * ================================================================== */
function caseSwitchesLand() {
  var E = fresh(), S = E.S;
  return startInGesture(S).then(flush).then(function () {
    S.loadPreset(PATCH);
    S.noteOn(57, 1);
    clock.advance(0.2);
    function other(name) {
      var spec = S.PARAM_SPEC.filter(function (s) { return s.name === name; })[0];
      return spec.options.filter(function (o) { return o !== S.getParam(name); })[0];
    }
    var patch = {};
    for (var k in PATCH) if (Object.prototype.hasOwnProperty.call(PATCH, k)) patch[k] = PATCH[k];
    patch.osc1wave = other('osc1wave');
    patch.osc2wave = other('osc2wave');
    patch.subWave = other('subWave');
    patch.filtType = other('filtType');
    S.loadPreset(patch);
    clock.advance(0.2);
    expectVoiceTypes(S, 'loadPreset() with new shapes and filter type under a ringing note');
    S.noteOff(57);
    clock.advance(1);
  });
}

/* ================================================================== *
 * 3. No voice or node leaks.
 * ================================================================== */
function caseNoLeaks() {
  var E = fresh(), S = E.S;
  return startInGesture(S).then(flush).then(function () {
    S.loadPreset(PATCH);
    var graph = created.length;
    var maxActive = 0;
    function count() {
      var n = S.getVoiceStates().filter(function (v) { return v.active; }).length;
      if (n > maxActive) maxActive = n;
    }
    for (var i = 0; i < 300; i++) {
      S.noteOn(36 + (i * 7) % 48, 0.8); count();
      clock.advance(0.004);
      if (i % 3) S.noteOff(36 + (i * 7) % 48);
      count();
    }
    for (var j = 0; j < 128; j++) S.noteOff(j);
    S.setParam('arpOn', 'on'); S.setParam('arpRate', '32'); S.setParam('arpBpm', 240); S.setParam('arpOct', 3);
    [48, 52, 55, 59].forEach(function (m) { S.noteOn(m, 0.9); });
    for (var k = 0; k < 100; k++) { clock.advance(0.01); count(); }
    [48, 52, 55, 59].forEach(function (m) { S.noteOff(m); });
    S.setParam('arpOn', 'off');
    var cycles = [];
    for (var c = 0; c < 5; c++) { S.stop(); clock.advance(0.1); cycles.push(startInGesture(S)); }
    return Promise.all(cycles).then(flush).then(function () {
      clock.advance(2);
      count();
      if (maxActive > S.MAX_VOICES) bad(maxActive + ' voices were active at once; the pool is ' + S.MAX_VOICES);
      else ok('polyphony stays bounded: at most ' + maxActive + ' of ' + S.MAX_VOICES + ' voices active');
      var live = S.getVoiceStates().filter(function (v) { return v.active; }).length;
      if (live) bad(live + ' voice(s) still active two seconds after every note was released');
      else ok('every voice is freed after its release');

      var extra = created.slice(graph);
      var nonSource = extra.filter(function (c) { return c.kind !== 'buffersource'; });
      if (nonSource.length) {
        bad('playing created ' + nonSource.length + ' new audio node(s) (' +
            nonSource.slice(0, 4).map(function (c) { return c.kind; }).join(', ') + ') — the graph grows with use');
      } else {
        ok('no audio nodes created by playing (fixed graph of ' + graph + ' nodes)');
      }
      var leaky = extra.filter(function (c) {
        if (c.kind !== 'buffersource') return false;
        if (typeof c.node.onended !== 'function') return true;
        c.node.onended();
        return !c.node.disconnected;
      });
      if (leaky.length) bad(leaky.length + ' unlock buffer source(s) stay connected after they end');
      else ok('the ' + extra.length + ' one-shot unlock source(s) disconnect themselves when they end');
    });
  });
}

/* ================================================================== *
 * 4. iOS Safari: gesture-synchronous unlock, interruption, clean stop.
 * ================================================================== */
function caseIOS() {
  var E = fresh(), S = E.S;
  var p = startInGesture(S);
  var ctx = Ctx.last;
  if (!ctx) { bad('start() created no AudioContext'); return Promise.resolve(); }
  var inGesture = ctx.resumeCalls.filter(function (c) { return c.inGesture; }).length;
  if (!inGesture) bad('start() did not call resume() synchronously inside the user gesture');
  else ok('start() resumes the context synchronously inside the gesture');
  var unlocks = created.filter(function (c) { return c.kind === 'buffersource'; });
  if (!unlocks.length || !unlocks.some(function (c) { return c.node.startedInGesture; })) {
    bad('the iOS unlock buffer was not started synchronously inside the gesture' +
        (unlocks.length ? ' (it started later, from a promise callback)' : ''));
  } else {
    ok('the iOS unlock buffer starts inside the gesture');
  }
  return p.then(flush).then(function (r) {
    if (ctx.state !== 'running' || !S.running) { bad('the context is not running after start() in a gesture'); return; }
    ok('the context is running after start()');

    ctx.setState('interrupted');                     // a phone call, Siri, the lock screen
    if (S.running) bad('SSSynth.running still reads true while iOS has the context interrupted');
    else ok('SSSynth.running follows the context into the interrupted state');
    E.fire('touchend');
    return flush().then(function () {
      if (ctx.state !== 'running') bad('a gesture after an iOS interruption did not resume the context');
      else if (!S.running) bad('the context resumed but SSSynth.running did not come back');
      else ok('the next gesture resumes an interrupted context');

      S.noteOn(60, 1);
      clock.advance(0.2);
      var before = ctx.suspendCalls.length;
      var tStop = clock.now();
      S.stop();
      if (ctx.suspendCalls.length > before) {
        bad('stop() suspends the clock immediately, freezing panic\'s fade mid-ramp (a click)');
      }
      clock.advance(0.2);
      var vs = voicesOf();
      var sus = ctx.suspendCalls.slice(before)[0];
      if (!sus) { bad('stop() never suspended the context'); return; }
      var loud = vs.filter(function (v) { return v.vca.gain.valueAt(sus.at) > 1e-4; });
      if (loud.length) bad('the context was suspended ' + ((sus.at - tStop) * 1000).toFixed(1) + ' ms after stop(), with ' + loud.length + ' voice(s) still audible');
      else ok('stop() suspends only after every voice has faded to silence (' + ((sus.at - tStop) * 1000).toFixed(0) + ' ms)');

      // A gesture after stop() must NOT wake audio the page switched off.
      E.fire('pointerdown');
      if (ctx.state === 'running') bad('a gesture after stop() resumed audio the page had switched off');
      else ok('a gesture after stop() leaves the context suspended');
    });
  });
}

caseNoJumps()
  .then(caseParamsRamp)
  .then(caseSwitchesLand)
  .then(caseNoLeaks)
  .then(caseIOS)
  .then(function () {
    if (errors.length) {
      console.error('\nSynth automation check failed with ' + errors.length + ' problem(s):\n');
      errors.forEach(function (e) { console.error(' - ' + e + '\n'); });
      console.error('Please inspect the scheduling helpers, start()/stop() and triggerVoice() in site/assets/js/synth.js');
      process.exit(2);
    }
    console.log('\nNo clicks, no leaks, and audio starts and recovers inside user gestures');
    process.exit(0);
  })
  ['catch'](function (e) {
    console.error('ERROR: the synth automation test threw — ' + (e && e.stack ? e.stack : e));
    process.exit(2);
  });
