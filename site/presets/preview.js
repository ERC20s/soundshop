/* Per-preset audio preview for the presets gallery.
 *
 * Deliberately a standalone file: the whole audio graph — node creation,
 * the timer, and the cleanup path — is readable top to bottom in one diff.
 *
 * Public API (window.PresetPreview):
 *   supported()   -> true when the browser has Web Audio at all
 *   play(button)  -> start one voice described by the button's data- attributes
 *   stop()        -> stop and tear down whatever is sounding (safe to call any time)
 *
 * One voice only: play() always stops the previous one first, so no amount of
 * clicking can leave nodes running. This approximates the plugin; it is not
 * the plugin.
 */
(function (global) {
  'use strict';

  var Ctx = global.AudioContext || global.webkitAudioContext;

  // Shared, lazily created context (browsers cap how many you may open) and
  // the single voice currently sounding, if any.
  var ctx = null;
  var voice = null;   // { osc, filter, gain, button }
  var timer = null;

  var TONE_HZ = 220;      // A3 — low enough to hear the filter working
  var PEAK_GAIN = 0.15;   // conservative: previews should never be loud
  var ATTACK = 0.02;
  var RELEASE = 0.08;
  var DURATION = 1.2;     // seconds of steady tone before the auto-release

  var WAVES = { saw: 'sawtooth', sawtooth: 'sawtooth', sine: 'sine', square: 'square', triangle: 'triangle' };

  function supported() {
    return !!Ctx;
  }

  // 'saw' -> 'sawtooth'; anything unknown or missing -> 'sawtooth'.
  function waveOf(name) {
    return WAVES[String(name == null ? '' : name).trim().toLowerCase()] || 'sawtooth';
  }

  // Cutoff in Hz, clamped into audible range; anything unparseable -> 2000.
  function cutoffOf(value) {
    var hz = parseFloat(value);
    if (!isFinite(hz)) return 2000;
    if (hz < 20) return 20;
    if (hz > 20000) return 20000;
    return hz;
  }

  function markButton(button, playing) {
    if (!button) return;
    if (playing) {
      button.setAttribute('data-playing', 'true');
      button.textContent = 'Stop';
    } else {
      button.removeAttribute('data-playing');
      button.textContent = 'Preview';
    }
  }

  // Tear down the sounding voice. Always safe: called by play(), by a second
  // click, by the auto-stop timer, and by the gallery filter.
  function stop() {
    if (timer !== null) {
      global.clearTimeout(timer);
      timer = null;
    }
    var v = voice;
    voice = null;
    if (!v) return;
    markButton(v.button, false);

    var now = ctx ? ctx.currentTime : 0;
    try {
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(v.gain.gain.value, now);
      v.gain.gain.linearRampToValueAtTime(0, now + RELEASE);
    } catch (e) { /* older engines: fall through to stop() below */ }

    // Disconnect only once the oscillator has actually finished, so the
    // release ramp is heard and nothing is left connected afterwards.
    v.osc.onended = function () {
      try { v.osc.disconnect(); } catch (e) {}
      try { v.filter.disconnect(); } catch (e) {}
      try { v.gain.disconnect(); } catch (e) {}
    };
    try { v.osc.stop(now + RELEASE); } catch (e) {
      try { v.osc.disconnect(); v.filter.disconnect(); v.gain.disconnect(); } catch (e2) {}
    }
  }

  function play(button) {
    if (!supported()) return;
    stop();                       // one voice at a time, always
    if (!ctx) ctx = new Ctx();
    // Some browsers start the context suspended until a user gesture.
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume();

    var wave = waveOf(button && button.getAttribute('data-osc'));
    var cutoff = cutoffOf(button && button.getAttribute('data-cutoff'));

    var osc = ctx.createOscillator();
    var filter = ctx.createBiquadFilter();
    var gain = ctx.createGain();

    osc.type = wave;
    osc.frequency.value = TONE_HZ;
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    var now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + ATTACK);
    gain.gain.setValueAtTime(PEAK_GAIN, now + DURATION);
    gain.gain.linearRampToValueAtTime(0.0001, now + DURATION + RELEASE);

    voice = { osc: osc, filter: filter, gain: gain, button: button };
    markButton(button, true);

    osc.start(now);
    // The timer is the single owner of the automatic teardown; stop() clears it.
    timer = global.setTimeout(function () { timer = null; stop(); }, (DURATION + RELEASE) * 1000);
  }

  // Never leave a voice running behind a closed/hidden page.
  if (global.addEventListener) {
    global.addEventListener('pagehide', function () { stop(); });
  }

  global.PresetPreview = { supported: supported, play: play, stop: stop };
})(window);
