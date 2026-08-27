/* Playable one-octave Web Audio keyboard.
 *
 * Renders itself inside #demo-slot on whichever page loads it — today the home
 * page (site/index.html, which loads it as "plugins/demo-keys.js") and the
 * flagship page (site/plugins/flagship.html) — replacing the fallback text only
 * when this browser really has Web Audio. The script needs nothing but that id
 * and window.AudioContext: no fetches, no page-specific paths.
 * No new page, no iframe, no site/demo/ directory.
 *
 * The voice graph is the same one already merged in site/presets/preview.js:
 *   oscillator -> lowpass biquad -> gain -> destination
 * with the AudioContext created lazily on the first interaction (autoplay
 * policy). Anything that throws leaves the page silent, never broken.
 */
(function(){
  'use strict';

  var Ctx = window.AudioContext || window.webkitAudioContext;

  var MAX_VOICES = 8;               // matches the "Polyphony: 8 voices" spec
  var NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'C'];
  // Computer-keyboard row, the usual tracker/DAW layout: white keys on the home
  // row, black keys on the row above. Index = semitones above C4.
  var KEYMAP = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k'];

  var ctx = null;
  var voices = {};                  // id -> { osc, filter, gain, order, button }
  var voiceCount = 0;
  var order = 0;

  var waveSelect = null;
  var cutoffInput = null;

  // MIDI 60 (C4) upwards; 12 semitones later is C5.
  function freqOf(semitone){
    return 440 * Math.pow(2, (60 + semitone - 69) / 12);
  }

  // 'saw' is the word used on the plugin page; Web Audio calls it 'sawtooth'.
  function waveOf(name){
    var w = String(name == null ? '' : name).trim().toLowerCase();
    if(w === 'saw' || w === 'sawtooth') return 'sawtooth';
    if(w === 'sine' || w === 'square' || w === 'triangle') return w;
    return 'sawtooth';
  }

  function cutoffOf(value){
    var n = parseFloat(value);
    if(!isFinite(n)) n = 2000;
    if(n < 200) n = 200;
    if(n > 8000) n = 8000;
    return n;
  }

  function held(button, on){
    if(!button) return;
    if(on) button.classList.add('is-held');
    else button.classList.remove('is-held');
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // Release one voice with a short fade so nothing clicks, then free it.
  function noteOff(id){
    var v = voices[id];
    if(!v) return;
    delete voices[id];
    voiceCount--;
    held(v.button, false);
    try {
      var now = ctx.currentTime;
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(v.gain.gain.value, now);
      v.gain.gain.linearRampToValueAtTime(0.0001, now + 0.08);
      v.osc.stop(now + 0.1);
    } catch(e){ /* already stopped */ }
  }

  function allOff(){
    Object.keys(voices).forEach(noteOff);
  }

  // Oldest-first voice stealing, so the 9th key never fails silently.
  function steal(){
    var oldestId = null, oldest = Infinity;
    Object.keys(voices).forEach(function(id){
      if(voices[id].order < oldest){ oldest = voices[id].order; oldestId = id; }
    });
    if(oldestId !== null) noteOff(oldestId);
  }

  function noteOn(id, button){
    if(voices[id]) return;                       // already sounding: no retrigger
    try {
      if(!ctx) ctx = new Ctx();
      if(ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume();
      if(voiceCount >= MAX_VOICES) steal();

      var now = ctx.currentTime;
      var osc = ctx.createOscillator();
      osc.type = waveOf(waveSelect && waveSelect.value);
      osc.frequency.value = freqOf(Number(id));

      var filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoffOf(cutoffInput && cutoffInput.value);

      var gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.14, now + 0.02);   // attack
      gain.gain.linearRampToValueAtTime(0.10, now + 0.25);   // decay to sustain

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      osc.onended = function(){
        try { osc.disconnect(); filter.disconnect(); gain.disconnect(); } catch(e){}
      };
      osc.start(now);

      voices[id] = { osc: osc, filter: filter, gain: gain, order: order++, button: button };
      voiceCount++;
      held(button, true);
    } catch(e){
      // A failed note must never break the page.
      held(button, false);
    }
  }

  function build(slot){
    var wrap = document.createElement('div');
    wrap.className = 'demo-keys-wrap';

    var controls = document.createElement('div');
    controls.className = 'demo-controls';

    var waveId = 'demo-wave', cutId = 'demo-cutoff';

    var waveLabel = document.createElement('label');
    waveLabel.setAttribute('for', waveId);
    waveLabel.textContent = 'Waveform';
    waveSelect = document.createElement('select');
    waveSelect.id = waveId;
    ['sine', 'saw', 'square', 'triangle'].forEach(function(w){
      var o = document.createElement('option');
      o.value = w;
      o.textContent = w;
      if(w === 'saw') o.selected = true;
      waveSelect.appendChild(o);
    });

    var cutLabel = document.createElement('label');
    cutLabel.setAttribute('for', cutId);
    cutLabel.textContent = 'Cutoff';
    cutoffInput = document.createElement('input');
    cutoffInput.type = 'range';
    cutoffInput.id = cutId;
    cutoffInput.min = '200';
    cutoffInput.max = '8000';
    cutoffInput.step = '50';
    cutoffInput.value = '2400';

    var cutValue = document.createElement('span');
    cutValue.className = 'demo-cutoff-value';
    cutValue.textContent = '2400 Hz';

    // Parse query params for preset loading (simple ES5 splitter: no URLSearchParams)
    try {
      var qs = typeof location.search === 'string' ? String(location.search || '').replace(/^\?/, '') : '';
      if(qs){
        var parts = qs.split('&');
        for(var i=0;i<parts.length;i++){
          var kv = parts[i].split('=');
          if(kv.length < 2) continue;
          var k = decodeURIComponent(kv[0] || '').toLowerCase();
          var v = decodeURIComponent(kv.slice(1).join('=') || '');
          if(k === 'wave' && v){
            try { waveSelect.value = v; } catch(e){}
          } else if(k === 'cutoff' && v){
            try { cutoffInput.value = String(cutoffOf(v)); } catch(e){}
          } else if(k === 'preset' && v){
            // add a small note below controls after controls are built
            // trim to ~60 chars when showing
            var note = document.createElement('p');
            note.className = 'demo-loaded-note';
            var name = String(v || '').trim();
            if(name.length > 60) name = name.slice(0,57) + '…';
            note.textContent = 'Loaded from preset: ' + name;
            // insert later with controls
            controls._loadedNote = note;
          }
        }
      }
    } catch(e){ /* ignore query parsing errors */ }

    // Live cutoff: also moves the filter of every note still held down.
    cutoffInput.addEventListener('input', function(){
      var hz = cutoffOf(cutoffInput.value);
      cutValue.textContent = hz + ' Hz';
      Object.keys(voices).forEach(function(id){
        try { voices[id].filter.frequency.value = hz; } catch(e){}
      });
    });

    // If a cutoff was set via the URL parsing above, ensure the text reflects it
    try { cutValue.textContent = cutoffOf(cutoffInput.value) + ' Hz'; } catch(e){}

    controls.appendChild(waveLabel);
    controls.appendChild(waveSelect);
    controls.appendChild(cutLabel);
    controls.appendChild(cutoffInput);
    controls.appendChild(cutValue);

    // If a preset note was provided, append it now (after the control elements)
    if(controls._loadedNote){ controls.appendChild(controls._loadedNote); }

    var keys = document.createElement('div');
    keys.className = 'demo-keys';

    NOTES.forEach(function(name, i){
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'demo-key' + (name.indexOf('#') > -1 ? ' demo-key-sharp' : '');
      b.setAttribute('data-note', String(i));
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', name + (i === 12 ? '5' : '4'));
      b.appendChild(document.createTextNode(name));
      var hint = document.createElement('span');
      hint.className = 'demo-key-hint';
      hint.textContent = KEYMAP[i];
      b.appendChild(hint);

      b.addEventListener('pointerdown', function(ev){
        ev.preventDefault();
        noteOn(String(i), b);
      });
      b.addEventListener('pointerup', function(){ noteOff(String(i)); });
      b.addEventListener('pointerleave', function(){ noteOff(String(i)); });
      b.addEventListener('pointercancel', function(){ noteOff(String(i)); });
      // Space/Enter on a focused key: play a short blip so the keyboard is
      // usable without a pointer.
      b.addEventListener('keydown', function(ev){
        if(ev.key === ' ' || ev.key === 'Enter'){
          ev.preventDefault();
          noteOn(String(i), b);
        }
      });
      b.addEventListener('keyup', function(ev){
        if(ev.key === ' ' || ev.key === 'Enter') noteOff(String(i));
      });

      keys.appendChild(b);
    });

    var hint = document.createElement('p');
    hint.className = 'demo-hint';
    hint.textContent = 'Click the keys or use a w s e d f t g y h u j k on your keyboard. '
      + 'Eight voices, like the real thing.';

    wrap.appendChild(controls);
    wrap.appendChild(keys);
    wrap.appendChild(hint);

    slot.textContent = '';
    slot.appendChild(wrap);

    // If the URL had a #demo hash, browsers scroll there before JS runs; make
    // sure the rebuilt slot is visible.
    try { if(location.hash === '#demo' && typeof slot.scrollIntoView === 'function') slot.scrollIntoView(); } catch(e){}

    return keys;
  }

  function keyIndex(ev){
    if(ev.ctrlKey || ev.metaKey || ev.altKey) return -1;
    var t = ev.target && ev.target.tagName;
    if(t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return -1;
    var k = String(ev.key || '').toLowerCase();
    return KEYMAP.indexOf(k);
  }

  function init(){
    var slot = document.getElementById('demo-slot');
    if(!slot || !Ctx) return;            // no Web Audio: the fallback text stays

    var keys = build(slot);

    document.addEventListener('keydown', function(ev){
      if(ev.repeat) return;              // held keys must not retrigger
      var i = keyIndex(ev);
      if(i < 0) return;
      ev.preventDefault();
      noteOn(String(i), keys.children[i]);
    });
    document.addEventListener('keyup', function(ev){
      var i = keyIndex(ev);
      if(i >= 0) noteOff(String(i));
    });

    // Nothing may be left ringing when the pointer is released elsewhere, the
    // window loses focus, or the tab is hidden.
    document.addEventListener('pointerup', allOff);
    window.addEventListener('blur', allOff);
    document.addEventListener('visibilitychange', function(){
      if(document.hidden) allOff();
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
