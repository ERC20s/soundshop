// Simple Web Audio synth: oscillator -> filter -> amp envelope -> master
let audioReady = false;
let ctx, masterGain, filter;
let activeNotes = new Map();
const noteMap = {
  'z': 60,'s':61,'x':62,'d':63,'c':64,'v':65,'g':66,'b':67,'h':68,'n':69,'j':70,'m':71
};

function midiToFreq(m){return 440 * Math.pow(2,(m-69)/12)}

async function ensureAudio(){
  if(audioReady) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = ctx.createGain();
  masterGain.gain.value = dBToGain(parseFloat(document.getElementById('master').value));
  filter = ctx.createBiquadFilter();
  filter.type = document.getElementById('filterType').value;
  filter.frequency.value = parseFloat(document.getElementById('filterCutoff').value);
  filter.Q.value = parseFloat(document.getElementById('filterQ').value);
  filter.connect(masterGain);
  masterGain.connect(ctx.destination);
  audioReady = true;
}

function dBToGain(db){return Math.pow(10, db/20)}

function noteOn(midi){
  if(!audioReady) return;
  const osc = ctx.createOscillator();
  const oscType = document.getElementById('oscType').value;
  osc.type = oscType;
  osc.frequency.value = midiToFreq(midi);
  const env = ctx.createGain(); env.gain.value = 0.0001;
  osc.connect(filter);
  filter.connect(env);
  env.connect(masterGain);
  osc.start();
  const now = ctx.currentTime;
  const A = parseFloat(document.getElementById('envA').value)/1000;
  const D = parseFloat(document.getElementById('envD').value)/1000;
  const S = parseFloat(document.getElementById('envS').value);
  const R = parseFloat(document.getElementById('envR').value)/1000;
  env.gain.cancelScheduledValues(now);
  env.gain.setValueAtTime(0.0001, now);
  env.gain.linearRampToValueAtTime(1, now + Math.max(0.001,A));
  env.gain.linearRampToValueAtTime(S, now + Math.max(0.001,A) + Math.max(0.001,D));
  activeNotes.set(midi,{osc,env,release:R});
  // mark key
  const el = document.querySelector(`.key[data-midi="${midi}"]`);
  if(el) el.classList.add('active');
}

function noteOff(midi){
  const entry = activeNotes.get(midi);
  if(!entry) return;
  const now = ctx.currentTime;
  const R = entry.release || 0.2;
  entry.env.gain.cancelScheduledValues(now);
  entry.env.gain.setValueAtTime(entry.env.gain.value, now);
  entry.env.gain.linearRampToValueAtTime(0.0001, now + Math.max(0.001,R));
  entry.osc.stop(now + Math.max(0.001,R) + 0.02);
  // cleanup after
  setTimeout(()=>{ try{ entry.env.disconnect(); entry.osc.disconnect(); }catch(e){} }, (R+0.1)*1000);
  activeNotes.delete(midi);
  const el = document.querySelector(`.key[data-midi="${midi}"]`);
  if(el) el.classList.remove('active');
}

function buildKeyboard(){
  const keyboard = document.getElementById('keyboard');
  // create one octave + a bit: C4 (60) to B5 (83)
  const pattern = [0,1,0,1,0,0,1,0,1,0,1,0];
  for(let i=60;i<=83;i++){
    const isBlack = pattern[(i-60)%12]===1;
    const k = document.createElement('div');
    k.className = 'key'+(isBlack? ' black':'');
    k.dataset.midi = i;
    k.tabIndex = 0;
    k.textContent = midiToNote(i);
    k.addEventListener('pointerdown', ev=>{ ev.preventDefault(); ensureAudio().then(()=>noteOn(i)); });
    k.addEventListener('pointerup', ev=>{ ev.preventDefault(); noteOff(i); });
    k.addEventListener('pointerleave', ev=>{ if(ev.buttons===0) noteOff(i); });
    keyboard.appendChild(k);
  }
}

function midiToNote(m){
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  return names[m%12]+Math.floor(m/12)-1;
}

function wireControls(){
  document.getElementById('power').addEventListener('click', ()=>ensureAudio().then(()=>{document.getElementById('power').textContent='Audio Ready'}));
  document.getElementById('master').addEventListener('input', (e)=>{ const v=e.target.value; document.getElementById('masterVal').textContent=v+' dB'; if(masterGain) masterGain.gain.setValueAtTime(dBToGain(v), ctx.currentTime); });
  document.getElementById('filterCutoff').addEventListener('input', (e)=>{ if(filter) filter.frequency.setValueAtTime(parseFloat(e.target.value), ctx.currentTime); });
  document.getElementById('filterQ').addEventListener('input', (e)=>{ if(filter) filter.Q.setValueAtTime(parseFloat(e.target.value), ctx.currentTime); });
  document.getElementById('filterType').addEventListener('change', (e)=>{ if(filter) filter.type = e.target.value; });
  document.getElementById('oscType').addEventListener('change', ()=>{});
  // preset loader
  document.getElementById('preset').addEventListener('change',(e)=>{ loadPresetIndex(e.target.value); });
  // keyboard via computer keys
  window.addEventListener('keydown', (e)=>{ if(e.repeat) return; const k = e.key.toLowerCase(); if(noteMap[k]){ ensureAudio().then(()=>noteOn(noteMap[k])); } });
  window.addEventListener('keyup', (e)=>{ const k = e.key.toLowerCase(); if(noteMap[k]) noteOff(noteMap[k]); });
}

async function loadPresets(){
  try{
    const res = await fetch('../presets/defaults.json');
    const data = await res.json();
    const sel = document.getElementById('preset');
    sel.innerHTML = '';
    data.forEach((p,idx)=>{ const opt=document.createElement('option'); opt.value=String(idx); opt.textContent=p.name; sel.appendChild(opt); });
    // now have presets; select 0
    sel.value='0';
    loadPresetIndex('0');
  }catch(e){ console.warn('Could not load presets',e); const sel=document.getElementById('preset'); sel.innerHTML='<option>none</option>'; }
}

function loadPresetIndex(idx){
  fetch('../presets/defaults.json').then(r=>r.json()).then(data=>{
    const p = data[Number(idx)]; if(!p) return;
    document.getElementById('oscType').value=p.osc||'sine';
    document.getElementById('envA').value=p.adsr?.A||10;
    document.getElementById('envD').value=p.adsr?.D||150;
    document.getElementById('envS').value=p.adsr?.S||0.7;
    document.getElementById('envR').value=p.adsr?.R||300;
    document.getElementById('filterType').value=p.filter?.type||'lowpass';
    document.getElementById('filterCutoff').value=p.filter?.cutoff||8000;
    document.getElementById('filterQ').value=p.filter?.q||1;
    document.getElementById('master').value=p.masterDB||-6; document.getElementById('masterVal').textContent=p.masterDB+' dB';
    if(filter) { filter.type = document.getElementById('filterType').value; filter.frequency.setValueAtTime(parseFloat(document.getElementById('filterCutoff').value), ctx?ctx.currentTime:0); filter.Q.setValueAtTime(parseFloat(document.getElementById('filterQ').value), ctx?ctx.currentTime:0); }
  }).catch(e=>{});
}

// init
buildKeyboard();
wireControls();
loadPresets();

// expose a small API for tests
window.__soundshop = { noteOn, noteOff, ensureAudio };
