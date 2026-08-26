// Flagship Synth — playable demo logic. Loaded by flagship-demo.html.
// One AudioContext, one voice per held note, shared ADSR/filter helpers
// so noteOn/noteOff stay short instead of repeating per-voice setup.
(function () {
  'use strict';

  var NOTES = [
    { note: 'C4', freq: 261.63, key: 'a' },
    { note: 'D4', freq: 293.66, key: 's' },
    { note: 'E4', freq: 329.63, key: 'd' },
    { note: 'F4', freq: 349.23, key: 'f' },
    { note: 'G4', freq: 392.00, key: 'g' },
    { note: 'A4', freq: 440.00, key: 'h' },
    { note: 'B4', freq: 493.88, key: 'j' },
    { note: 'C5', freq: 523.25, key: 'k' }
  ];

  var ctx = null;
  var voices = {}; // note -> { osc, gain }

  function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function readADSR() {
    return {
      attack: parseFloat(document.getElementById('attack').value) || 0,
      decay: parseFloat(document.getElementById('decay').value) || 0,
      sustain: parseFloat(document.getElementById('sustain').value) || 0,
      release: parseFloat(document.getElementById('release').value) || 0
    };
  }

  function setKeyVisual(note, active) {
    var el = document.querySelector('.key[data-note="' + note + '"]');
    if (el) el.classList.toggle('active', active);
  }

  function createVoice(freq) {
    var c = ensureCtx();
    var osc = c.createOscillator();
    osc.type = document.getElementById('wave').value;
    osc.frequency.value = freq;
    var filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = parseFloat(document.getElementById('cutoff').value) || 4000;
    filter.Q.value = 1;
    var gain = c.createGain();
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(c.destination);
    return { osc: osc, gain: gain };
  }

  function noteOn(note, freq) {
    if (voices[note]) return;
    var c = ensureCtx();
    var voice = createVoice(freq);
    var env = readADSR();
    var now = c.currentTime;
    voice.gain.gain.setValueAtTime(0, now);
    voice.gain.gain.linearRampToValueAtTime(1, now + env.attack);
    voice.gain.gain.linearRampToValueAtTime(env.sustain, now + env.attack + env.decay);
    voice.osc.start(now);
    voices[note] = voice;
    setKeyVisual(note, true);
  }

  function noteOff(note) {
    var voice = voices[note];
    if (!voice) return;
    var c = ensureCtx();
    var env = readADSR();
    var now = c.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + env.release);
    voice.osc.stop(now + env.release + 0.05);
    delete voices[note];
    setKeyVisual(note, false);
  }

  function buildKeys() {
    var wrap = document.getElementById('keys');
    NOTES.forEach(function (n) {
      var el = document.createElement('div');
      el.className = 'key';
      el.setAttribute('data-note', n.note);
      el.textContent = n.note + ' (' + n.key.toUpperCase() + ')';
      el.addEventListener('mousedown', function () { noteOn(n.note, n.freq); });
      el.addEventListener('mouseup', function () { noteOff(n.note); });
      el.addEventListener('mouseleave', function () { noteOff(n.note); });
      wrap.appendChild(el);
    });
  }

  function setupComputerKeyboard() {
    var byKey = {};
    NOTES.forEach(function (n) { byKey[n.key] = n; });
    var held = {};
    document.addEventListener('keydown', function (e) {
      var n = byKey[e.key.toLowerCase()];
      if (!n || held[n.key]) return;
      held[n.key] = true;
      noteOn(n.note, n.freq);
    });
    document.addEventListener('keyup', function (e) {
      var n = byKey[e.key.toLowerCase()];
      if (!n) return;
      held[n.key] = false;
      noteOff(n.note);
    });
  }

  function applyPreset(p) {
    if (!p || !p.params) return;
    if (p.params.osc1) document.getElementById('wave').value = p.params.osc1;
    if (p.params.filter) document.getElementById('cutoff').value = p.params.filter;
  }

  function loadPresets() {
    var select = document.getElementById('preset');
    fetch('../presets/flagship-presets.json')
      .then(function (r) { if (!r.ok) throw new Error('fetch failed'); return r.json(); })
      .then(function (data) {
        select.innerHTML = '<option value="">— choose —</option>';
        if (!Array.isArray(data)) return;
        data.forEach(function (p, i) {
          var opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = p.name || 'Untitled';
          select.appendChild(opt);
        });
        select.addEventListener('change', function () {
          if (select.value === '') return;
          applyPreset(data[parseInt(select.value, 10)]);
        });
      })
      .catch(function () {
        select.innerHTML = '<option value="">Presets unavailable</option>';
      });
  }

  buildKeys();
  setupComputerKeyboard();
  loadPresets();
})();
