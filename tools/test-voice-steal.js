#!/usr/bin/env node
'use strict';
/*
 * tools/test-voice-steal.js — every 'noteon' the engine emits must be closed by
 * exactly one 'noteoff'.
 *
 * Why this exists: the demo keybed counts EVENTS, not voices —
 *
 *   site/assets/js/demo.js:1541  S.on('noteon',  function (e) { markNote(e.midi,  1); ... });
 *   site/assets/js/demo.js:1546  S.on('noteoff', function (e) { markNote(e.midi, -1); });
 *   site/assets/js/demo.js:655   soundingCount[key] = Math.max(0, (soundingCount[key] || 0) + delta);
 *
 * VANTA has a fixed pool of eight voices (MAX_VOICES) while the keybed spans 30
 * semitones and the arpeggiator can run three octaves of held notes, so voices
 * ARE stolen in normal use. A stolen voice used to be re-assigned without ever
 * emitting the 'noteoff' for the note it was playing (the v.gen++ in
 * triggerVoice also cancels the pending timer releaseVoice scheduled), so the
 * key stayed lit until the visitor hit panic or reloaded the page.
 *
 * This test runs site/assets/js/synth.js in a vm sandbox against a minimal stub
 * AudioContext (every node and AudioParam the engine touches, all no-ops), plays
 * more notes than there are voices, then runs the arpeggiator hard, and asserts
 * the per-MIDI noteon/noteoff tally ends at zero — nothing left "sounding".
 *
 * Zero dependencies, Node 18+. Exit 0 when every assertion holds, 2 otherwise.
 */

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var TARGET = path.join(__dirname, '..', 'site', 'assets', 'js', 'synth.js');

var errors = [];
function ok(msg) { console.log('OK: ' + msg); }
function bad(msg) { errors.push(msg); console.log('FAIL: ' + msg); }

if (!fs.existsSync(TARGET)) {
  console.error('ERROR: site/assets/js/synth.js not found at ' + TARGET);
  process.exit(2);
}
var source = fs.readFileSync(TARGET, 'utf8');

/* ================================================================== *
 * A minimal stub Web Audio API — enough for synth.js to build its graph.
 * Nothing renders audio; every AudioParam method is a no-op that records
 * the last value, which is all the engine ever reads back.
 * ================================================================== */

function StubParam(value) {
  this.value = typeof value === 'number' ? value : 0;
}
StubParam.prototype.setValueAtTime = function (v) { this.value = v; return this; };
StubParam.prototype.setTargetAtTime = function (v) { this.value = v; return this; };
StubParam.prototype.linearRampToValueAtTime = function (v) { this.value = v; return this; };
StubParam.prototype.exponentialRampToValueAtTime = function (v) { this.value = v; return this; };
StubParam.prototype.cancelScheduledValues = function () { return this; };
StubParam.prototype.cancelAndHoldAtTime = function () { return this; };

function StubNode(extra) {
  this.connect = function () { return this; };
  this.disconnect = function () { return this; };
  this.start = function () { return this; };
  this.stop = function () { return this; };
  if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) this[k] = extra[k];
}

function StubBuffer(channels, length, sampleRate) {
  this.numberOfChannels = channels;
  this.length = length;
  this.sampleRate = sampleRate;
  this.duration = length / sampleRate;
  this._data = [];
  for (var i = 0; i < channels; i++) this._data.push(new Float32Array(length));
}
StubBuffer.prototype.getChannelData = function (i) { return this._data[i]; };

function StubAudioContext() {
  var t0 = Date.now();
  this.sampleRate = 8000;          // small: buildIR() renders a real buffer
  this.state = 'running';
  this.destination = new StubNode();
  Object.defineProperty(this, 'currentTime', {
    get: function () { return (Date.now() - t0) / 1000; }
  });
  StubAudioContext.last = this;
}
StubAudioContext.prototype.resume = function () { this.state = 'running'; return Promise.resolve(); };
StubAudioContext.prototype.suspend = function () { this.state = 'suspended'; return Promise.resolve(); };
StubAudioContext.prototype.close = function () { return Promise.resolve(); };
StubAudioContext.prototype.createGain = function () {
  return new StubNode({ gain: new StubParam(1) });
};
StubAudioContext.prototype.createOscillator = function () {
  return new StubNode({ type: 'sine', frequency: new StubParam(440), detune: new StubParam(0) });
};
StubAudioContext.prototype.createBiquadFilter = function () {
  return new StubNode({
    type: 'lowpass', frequency: new StubParam(350), Q: new StubParam(1),
    detune: new StubParam(0), gain: new StubParam(0)
  });
};
StubAudioContext.prototype.createWaveShaper = function () {
  return new StubNode({ curve: null, oversample: 'none' });
};
StubAudioContext.prototype.createDelay = function (max) {
  return new StubNode({ delayTime: new StubParam(0), maxDelayTime: max || 1 });
};
StubAudioContext.prototype.createDynamicsCompressor = function () {
  return new StubNode({
    threshold: new StubParam(-24), knee: new StubParam(30), ratio: new StubParam(12),
    attack: new StubParam(0.003), release: new StubParam(0.25), reduction: 0
  });
};
StubAudioContext.prototype.createAnalyser = function () {
  return new StubNode({
    fftSize: 2048,
    frequencyBinCount: 1024,
    smoothingTimeConstant: 0.8,
    getFloatTimeDomainData: function (a) { if (a && a.fill) a.fill(0); },
    getByteFrequencyData: function (a) { if (a && a.fill) a.fill(0); }
  });
};
StubAudioContext.prototype.createConvolver = function () {
  return new StubNode({ normalize: true, buffer: null });
};
StubAudioContext.prototype.createStereoPanner = function () {
  return new StubNode({ pan: new StubParam(0) });
};
StubAudioContext.prototype.createConstantSource = function () {
  return new StubNode({ offset: new StubParam(0) });
};
StubAudioContext.prototype.createBufferSource = function () {
  return new StubNode({ buffer: null, loop: false });
};
StubAudioContext.prototype.createBuffer = function (ch, len, sr) {
  return new StubBuffer(ch, len, sr || this.sampleRate);
};

/* ================================================================== *
 * A fresh engine per case — no state leaks between them.
 * ================================================================== */

function fresh() {
  var sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Promise: Promise,
    AudioContext: StubAudioContext
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  try {
    vm.runInContext(source, sandbox, { filename: 'site/assets/js/synth.js' });
  } catch (e) {
    console.error('ERROR: site/assets/js/synth.js does not evaluate: ' + (e && e.message));
    process.exit(2);
  }
  var S = sandbox.SSSynth;
  if (!S || typeof S.noteOn !== 'function' || typeof S.start !== 'function') {
    console.error('ERROR: evaluating synth.js did not expose a usable SSSynth');
    process.exit(2);
  }
  if (!S.supported) {
    console.error('ERROR: SSSynth.supported is false — the stub AudioContext was not picked up');
    process.exit(2);
  }
  return S;
}

/* A per-MIDI tally of the events a listener would see. */
function watch(S) {
  var w = { count: {}, on: 0, off: 0, sources: {} };
  S.on('noteon', function (e) {
    w.count[e.midi] = (w.count[e.midi] || 0) + 1;
    w.on++;
  });
  S.on('noteoff', function (e) {
    w.count[e.midi] = (w.count[e.midi] || 0) - 1;
    w.off++;
    w.sources[e.source] = (w.sources[e.source] || 0) + 1;
  });
  w.stuck = function () {
    var out = [];
    for (var m in w.count) {
      if (Object.prototype.hasOwnProperty.call(w.count, m) && w.count[m] !== 0) {
        out.push(m + ':' + w.count[m]);
      }
    }
    return out;
  };
  return w;
}

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* ================================================================== *
 * 1. More notes than voices: the stolen note must be released.
 * ================================================================== */
function caseSteal() {
  var S = fresh();
  var w = watch(S);
  var N = S.MAX_VOICES;
  var first = 60;
  var notes = [];
  for (var i = 0; i <= N; i++) notes.push(first + i);   // N + 1 notes, N voices

  return S.start().then(function (started) {
    if (!started) { bad('SSSynth.start() did not resolve true against the stub AudioContext'); return; }
    ok('the engine starts headless against a stub AudioContext (' + N + ' voices)');

    for (var i = 0; i < notes.length; i++) S.noteOn(notes[i], 0.9);

    if (w.on !== notes.length) {
      bad("'noteon' fired " + w.on + ' time(s) for ' + notes.length + ' keys pressed');
    }
    if ((w.count[first] || 0) !== 0) {
      bad('pressing ' + notes.length + ' keys with ' + N + ' voices left MIDI ' + first +
          " counted as still sounding (no 'noteoff' for the stolen voice) — this is the stuck-key bug");
    } else {
      ok('the note whose voice was stolen got its ' + "'noteoff'" + ' immediately (MIDI ' + first + ')');
    }
    if (!w.sources.steal) {
      bad("no 'noteoff' carried source 'steal' after a voice was taken");
    } else {
      ok("the stolen note's 'noteoff' is tagged source 'steal' (" + w.sources.steal + ')');
    }

    return wait(30).then(function () {
      for (var j = 0; j < notes.length; j++) S.noteOff(notes[j]);
      return wait(120);
    }).then(function () {
      var stuck = w.stuck();
      if (stuck.length) {
        bad('after releasing every key, these MIDI notes are still counted as sounding: ' + stuck.join(', '));
      } else {
        ok('releasing every key leaves the tally at zero (' + w.on + ' noteon / ' + w.off + ' noteoff)');
      }
    });
  });
}

/* ================================================================== *
 * 2. Legato retrigger: re-triggering a held note must not double-count.
 * ================================================================== */
function caseRetrigger() {
  var S = fresh();
  var w = watch(S);
  return S.start().then(function () {
    S.noteOn(64, 0.9);
    S.noteOn(64, 0.9);      // same key again while it is still gated
    S.noteOn(64, 0.9);
    if ((w.count[64] || 0) !== 1) {
      bad('re-triggering a held note left MIDI 64 counted ' + (w.count[64] || 0) +
          ' time(s); a legato retrigger must close the note it re-uses');
    } else {
      ok('a legato retrigger closes the note it re-uses (MIDI 64 counted once)');
    }
    S.noteOff(64);
    return wait(120);
  }).then(function () {
    var stuck = w.stuck();
    if (stuck.length) bad('after a retrigger and release, still sounding: ' + stuck.join(', '));
    else ok('retrigger then release ends at zero');
  });
}

/* ================================================================== *
 * 3. The arpeggiator hammering the voice pool, then panic.
 * ================================================================== */
function caseArp() {
  var S = fresh();
  var w = watch(S);
  var held = [55, 58, 62, 65];
  return S.start().then(function () {
    S.setParam('arpOn', 'on');
    S.setParam('arpMode', 'up');
    S.setParam('arpRate', '32');
    S.setParam('arpBpm', 220);
    S.setParam('arpOct', 3);       // 12 notes cycling through 8 voices
    S.setParam('ampR', 0.05);
    for (var i = 0; i < held.length; i++) S.noteOn(held[i], 0.9);
    return wait(600);
  }).then(function () {
    if (w.on < 4) {
      bad('the arpeggiator produced only ' + w.on + " 'noteon' event(s) in 600ms — it did not run");
    } else {
      ok('the arpeggiator ran (' + w.on + ' noteon / ' + w.off + ' noteoff across 8 voices)');
    }
    for (var i = 0; i < held.length; i++) S.noteOff(held[i]);
    return wait(300);
  }).then(function () {
    S.panic();
    return wait(200);
  }).then(function () {
    var stuck = w.stuck();
    if (stuck.length) {
      bad('after the arpeggiator stopped and panic ran, these notes are still counted as sounding: ' +
          stuck.join(', '));
    } else {
      ok('an arpeggiator burst plus panic ends with every note released (' +
         w.on + ' noteon / ' + w.off + ' noteoff)');
    }
    var states = S.getVoiceStates();
    var live = states.filter(function (v) { return v.active; });
    if (live.length) bad('panic left ' + live.length + ' voice(s) active');
    else ok('panic leaves no active voice');
  });
}

/* ================================================================== *
 * 4. Guard the shape so the missing emit cannot come back.
 * ================================================================== */
function caseShape() {
  if (!/closeVoiceNote\s*\(/.test(source)) {
    bad('synth.js no longer closes the note of a re-used voice (closeVoiceNote is gone)');
  } else {
    ok('triggerVoice still closes the note of the voice it re-uses');
  }
  if (!/offEmitted/.test(source)) {
    bad('the offEmitted bookkeeping that keeps noteon/noteoff paired is gone');
  }
  return Promise.resolve();
}

/* ------------------------------------------------------------------ */
caseSteal()
  .then(caseRetrigger)
  .then(caseArp)
  .then(caseShape)
  .then(function () {
    if (errors.length) {
      console.error('\nVoice-steal note-event check failed with ' + errors.length + ' problem(s):\n');
      errors.forEach(function (e) { console.error(' - ' + e + '\n'); });
      console.error('Please inspect triggerVoice()/releaseVoice()/panic() in site/assets/js/synth.js');
      process.exit(2);
    }
    console.log('\nEvery noteon the engine emits is closed by exactly one noteoff: no stuck keys');
    process.exit(0);
  })
  ['catch'](function (e) {
    console.error('ERROR: the voice-steal test threw — ' + (e && e.stack ? e.stack : e));
    process.exit(2);
  });
