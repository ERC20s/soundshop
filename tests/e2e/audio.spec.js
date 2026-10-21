// The VANTA engine's real output in Chromium must not click.
//
// synth.js runs on a bare page; an AudioWorklet taps the limiter on its way
// to the speakers and records every sample on the audio thread. The patch is
// a plain sine with the effects dry, so a healthy signal changes slope by
// well under 0.002 per sample; a click (a one-sample jump in level) shows up
// as a second difference many times that.
'use strict';

const { test, expect } = require('@playwright/test');

const CLICK = 0.004;   // second difference that counts as a click

const RECORDER = `registerProcessor('ss-rec', class extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.port.onmessage = (e) => { this.on = e.data; }; }
  process(inputs) { const i = inputs[0]; if (this.on && i && i[0]) this.port.postMessage(i[0].slice(0)); return true; }
});`;

// Installed before synth.js loads: remember the context and the limiter node.
function tap() {
  const Native = window.AudioContext;
  window.AudioContext = function () { const c = new Native({ sampleRate: 48000 }); window.__ctx = c; return c; };
  const connect = AudioNode.prototype.connect;
  window.__connect = connect;
  AudioNode.prototype.connect = function (dst, ...rest) {
    if (window.__ctx && dst === window.__ctx.destination && this instanceof DynamicsCompressorNode) window.__limiter = this;
    return connect.call(this, dst, ...rest);
  };
}

const SCENARIOS = {
  'note on and off': `for (let i = 0; i < 8; i++) { S.noteOn(57 + (i % 4), 1); await wait(120); S.noteOff(57 + (i % 4)); await wait(120); }`,
  'legato retrigger': `for (let i = 0; i < 10; i++) { S.noteOn(57, 1); await wait(70); } S.noteOff(57); await wait(300);`,
  'voice stealing': `for (let i = 0; i < 24; i++) { S.noteOn(45 + i, 1); await wait(50); } S.panic(); await wait(200);`,
  'panic': `S.noteOn(57, 1); S.noteOn(64, 1); await wait(300); S.panic(); await wait(300);`,
  'stop while playing': `S.noteOn(57, 1); await wait(300); S.stop(); await wait(300);`,
  'filter type switch': `S.setParam('cutoff', 2000); S.noteOn(57, 1); await wait(200); S.setParam('filtType', 'bandpass'); await wait(200); S.setParam('filtType', 'lowpass'); await wait(200); S.noteOff(57); await wait(300);`,
  'cutoff jumps': `S.noteOn(57, 1); await wait(200); for (let i = 0; i < 10; i++) { S.setParam('cutoff', i % 2 ? 250 : 3000); await wait(40); } S.noteOff(57); await wait(300);`,
  'sample-and-hold on amp': `S.setParam('lfoTarget', 'amp'); S.setParam('lfoDepth', 1); S.setParam('lfoRate', 6); S.setParam('lfoWave', 'sh'); S.noteOn(57, 1); await wait(900); S.noteOff(57); await wait(300);`,
  'arpeggiator': `S.setParam('arpOn', 'on'); S.setParam('arpRate', '32'); S.setParam('arpBpm', 200); [57, 60, 64].forEach((m) => S.noteOn(m, 1)); await wait(1200); [57, 60, 64].forEach((m) => S.noteOff(m)); await wait(300);`
};

for (const [name, body] of Object.entries(SCENARIOS)) {
  test(`no clicks: ${name}`, async ({ page, baseURL }) => {
    await page.goto('data/items.json');   // any same-origin document
    await page.setContent('<!doctype html><script>(' + tap.toString() + ')()</script>' +
                          '<script src="' + baseURL + 'assets/js/synth.js"></script>');
    // A gesture, as on the site, so autoplay policy lets the context run.
    await page.mouse.click(5, 5);
    const res = await page.evaluate(async ([worklet, body, limit]) => {
      const S = window.SSSynth;
      await S.start();
      const ctx = window.__ctx;
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([worklet], { type: 'text/javascript' })));
      const rec = new AudioWorkletNode(ctx, 'ss-rec');
      const chunks = [];
      rec.port.onmessage = (e) => chunks.push(e.data);
      window.__connect.call(window.__limiter, rec);
      window.__connect.call(rec, ctx.destination);
      S.loadPreset({ osc1wave: 'sine', osc2Level: 0, subLevel: 0, detune: 0, cutoff: 18000, reso: 0.7,
                     fegAmt: 0, keyTrack: 0, lfoDepth: 0, drive: 0, delayMix: 0, revMix: 0,
                     ampA: 0.003, ampD: 0.1, ampS: 0.8, ampR: 0.03 });
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await wait(300);
      rec.port.postMessage(true);
      await wait(50);
      await new Function('S', 'wait', 'return (async () => {' + body + '})()')(S, wait);
      rec.port.postMessage(false);
      await wait(100);
      let n = 0, peak = 0, worst = 0, clicks = 0, last = -1, prev2 = 0, prev1 = 0;
      for (const chunk of chunks) {
        for (const x of chunk) {
          if (n >= 2) {
            const d2 = Math.abs(x - 2 * prev1 + prev2);
            if (d2 > worst) worst = d2;
            if (d2 > limit && n - last > 240) { clicks++; last = n; }
          }
          peak = Math.max(peak, Math.abs(x));
          prev2 = prev1; prev1 = x; n++;
        }
      }
      return { n, peak, worst, clicks, state: ctx.state };
    }, [RECORDER, body, CLICK]);

    expect(res.n, 'samples recorded').toBeGreaterThan(48000 * 0.3);
    expect(res.peak, 'the synth made sound').toBeGreaterThan(0.02);
    expect(res.clicks, `clicks (worst second difference ${res.worst.toFixed(4)}, limit ${CLICK})`).toBe(0);
  });
}
