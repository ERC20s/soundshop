/* Per-preset audio preview for the presets gallery.
 *
 * Kept in its own file (rather than inline in index.html) so the gallery's
 * render/filter script stays small and this audio code is reviewable on its
 * own. Exposes exactly one global, window.PresetPreview, with two methods:
 *
 *   supported()      -> true when this browser has Web Audio
 *   toggle(button)   -> plays a ~1.2 s one-shot for that button's preset,
 *                       or stops it if it is the one currently sounding
 *
 * The preset's sound is read off the button itself (data-osc, data-cutoff),
 * so this file never fetches or parses flagship-presets.json.
 */
(function(){
  'use strict';

  var Ctx = typeof window !== 'undefined'
    ? (window.AudioContext || window.webkitAudioContext)
    : null;

  var ctx = null;      // created lazily on the first click (autoplay policy)
  var voice = null;    // { osc: OscillatorNode, button: HTMLElement }

  function supported(){ return !!Ctx; }

  // 'saw' is what flagship-presets.json says; Web Audio calls it 'sawtooth'.
  // Anything unrecognised falls back to sawtooth rather than throwing.
  function waveOf(name){
    var w = String(name == null ? '' : name).trim().toLowerCase();
    if(w === 'saw' || w === 'sawtooth') return 'sawtooth';
    if(w === 'sine' || w === 'square' || w === 'triangle') return w;
    return 'sawtooth';
  }

  // Cutoff in Hz, clamped to something audible. Non-numeric -> 2000.
  function cutoffOf(value){
    var n = parseFloat(value);
    if(!isFinite(n)) n = 2000;
    if(n < 20) n = 20;
    if(n > 20000) n = 20000;
    return n;
  }

  function label(button, playing){
    if(!button) return;
    button.textContent = playing ? 'stop' : 'preview';
    button.setAttribute('aria-pressed', playing ? 'true' : 'false');
  }

  // Stop whatever is sounding right now and put its button back to 'preview'.
  function stop(){
    if(!voice) return;
    var v = voice;
    voice = null;
    try { v.osc.onended = null; v.osc.stop(); } catch(e){ /* already stopped */ }
    label(v.button, false);
  }

  function toggle(button){
    if(!supported() || !button) return;
    var wasPlaying = voice && voice.button === button;
    stop();                       // only ever one voice at a time
    if(wasPlaying) return;        // second click on the same button = stop

    try {
      if(!ctx) ctx = new Ctx();
      if(ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume();

      var now = ctx.currentTime;
      var dur = 1.2;

      var osc = ctx.createOscillator();
      osc.type = waveOf(button.getAttribute('data-osc'));
      osc.frequency.value = 220;                       // fixed A3 for every preset

      var filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoffOf(button.getAttribute('data-cutoff'));

      var gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.15, now + 0.02);       // short attack
      gain.gain.setValueAtTime(0.15, now + dur - 0.15);
      gain.gain.linearRampToValueAtTime(0.0001, now + dur);      // short release

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc.onended = function(){
        try { osc.disconnect(); filter.disconnect(); gain.disconnect(); } catch(e){}
        if(voice && voice.osc === osc){ voice = null; label(button, false); }
      };

      osc.start(now);
      osc.stop(now + dur);

      voice = { osc: osc, button: button };
      label(button, true);
    } catch(e){
      // A failed preview must never break the gallery: reset and stay silent.
      voice = null;
      label(button, false);
    }
  }

  window.PresetPreview = { supported: supported, toggle: toggle, stop: stop };
})();
