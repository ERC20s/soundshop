#!/usr/bin/env node
'use strict';
/*
 * tools/test-preset-recall.js — SSSynth.loadPreset() must be a TOTAL recall.
 *
 * Why this exists: every preset path on the site goes through one function —
 *
 *   site/assets/js/demo.js:1423   if (S && S.loadPreset) S.loadPreset(p.params);
 *   site/assets/js/presets.js:233 Synth.loadPreset(preset.params);
 *   site/assets/js/home.js:831    S.loadPreset(preset.params);
 *
 * and it used to write only the keys the patch named. Anything a patch did not
 * mention kept its previous value, so turning Osc 2 Level to zero and then
 * choosing another preset left the oscillator silent: the built-in banks in
 * demo.js and home.js never name osc1Level/osc2Level. A preset that does not
 * recall as designed undersells the instrument this shop sells.
 *
 * loadPreset(obj) now starts from getDefaults() and overlays the patch;
 * loadPreset(obj, { merge: true }) keeps the old additive behaviour.
 *
 * The engine is evaluated in a vm context with no AudioContext, which is a
 * supported mode (SSSynth.supported === false, every method still returns
 * harmlessly) — so this runs anywhere Node runs, with zero dependencies.
 *
 * Exit 0 when every assertion holds, 2 otherwise.
 */

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var TARGET = path.join(__dirname, '..', 'site', 'assets', 'js', 'synth.js');

var errors = [];
function ok(msg) { console.log('OK: ' + msg); }
function bad(msg) { errors.push(msg); }

if (!fs.existsSync(TARGET)) {
  console.error('ERROR: site/assets/js/synth.js not found at ' + TARGET);
  process.exit(2);
}
var source = fs.readFileSync(TARGET, 'utf8');

/* ------------------------------------------------------------------ *
 * A fresh engine per assertion — no state leaks between cases.
 * ------------------------------------------------------------------ */
function fresh() {
  var sandbox = {
    console: console,
    setTimeout: function () { return 0; },
    clearTimeout: function () {},
    setInterval: function () { return 0; },
    clearInterval: function () {},
    Promise: Promise
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
  if (!sandbox.SSSynth || typeof sandbox.SSSynth.loadPreset !== 'function') {
    console.error('ERROR: evaluating synth.js did not expose SSSynth.loadPreset');
    process.exit(2);
  }
  return sandbox.SSSynth;
}

var probe = fresh();
var DEFAULTS = probe.getDefaults();
ok('synth.js evaluates headless and exposes SSSynth (' +
   Object.keys(DEFAULTS).length + ' parameters, supported=' + probe.supported + ')');

function eq(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
}

/* ------------------------------------------------------------------ *
 * 1. A sparse recall puts every unnamed parameter back to its default.
 * ------------------------------------------------------------------ */
(function () {
  var S = fresh();
  // The visitor moves knobs on the rack.
  S.setParam('osc2Level', 0);
  S.setParam('cutoff', 9000);
  S.setParam('arpMode', 'down');
  S.setParam('revMix', 0.95);
  if (!eq(S.getParam('osc2Level'), 0)) {
    bad('setParam(osc2Level, 0) did not take — got ' + S.getParam('osc2Level'));
    return;
  }

  // A sparse patch, exactly like the built-in banks: it never names osc2Level.
  S.loadPreset({ cutoff: 800, ampS: 0.5 });

  var params = S.getParams();
  var drifted = [];
  for (var k in DEFAULTS) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) continue;
    if (k === 'cutoff' || k === 'ampS') continue;
    if (!eq(params[k], DEFAULTS[k])) {
      drifted.push(k + '=' + params[k] + ' (default ' + DEFAULTS[k] + ')');
    }
  }
  if (drifted.length) {
    bad('a sparse preset left ' + drifted.length + ' parameter(s) off their default — patch bleed: ' + drifted.join(', '));
  } else {
    ok('every parameter the patch does not name snapped back to its default');
  }

  if (!eq(params.cutoff, 800) || !eq(params.ampS, 0.5)) {
    bad('the values the patch DOES name did not land — cutoff=' + params.cutoff + ', ampS=' + params.ampS);
  } else {
    ok('the values the patch names still land (cutoff=800, ampS=0.5)');
  }

  if (params.arpMode !== 'up') {
    bad('an enum parameter did not recall — arpMode=' + params.arpMode + ', expected the default "up"');
  } else {
    ok('enum parameters recall too (arpMode back to "up")');
  }
})();

/* ------------------------------------------------------------------ *
 * 2. The wrapper form ({ params: {...} }) behaves the same way.
 * ------------------------------------------------------------------ */
(function () {
  var S = fresh();
  S.setParam('osc1Level', 0.1);
  S.loadPreset({ id: 'x', name: 'X', params: { drive: 0.5 } });
  if (!eq(S.getParam('osc1Level'), DEFAULTS.osc1Level) || !eq(S.getParam('drive'), 0.5)) {
    bad('the { params: {...} } wrapper form does not recall — osc1Level=' +
        S.getParam('osc1Level') + ', drive=' + S.getParam('drive'));
  } else {
    ok('the { params: {...} } wrapper form recalls the same way');
  }
})();

/* ------------------------------------------------------------------ *
 * 3. merge:true still merges (the old behaviour, on request).
 * ------------------------------------------------------------------ */
(function () {
  var S = fresh();
  S.setParam('osc2Level', 0);
  S.loadPreset({ cutoff: 900 }, { merge: true });
  if (!eq(S.getParam('osc2Level'), 0)) {
    bad('loadPreset(patch, { merge: true }) reset an unnamed parameter — osc2Level=' + S.getParam('osc2Level'));
  } else if (!eq(S.getParam('cutoff'), 900)) {
    bad('loadPreset(patch, { merge: true }) did not apply the named value — cutoff=' + S.getParam('cutoff'));
  } else {
    ok('merge mode still overlays without resetting the rest');
  }
})();

/* ------------------------------------------------------------------ *
 * 4. Unknown and uncoercible keys are still ignored, not stored.
 * ------------------------------------------------------------------ */
(function () {
  var S = fresh();
  S.loadPreset({ notAParam: 42, cutoff: 'nonsense', osc1wave: 'banjo', reso: 6 });
  if (S.getParam('notAParam') !== undefined) {
    bad('an unknown key was stored as a parameter (notAParam)');
  } else if (!eq(S.getParam('cutoff'), DEFAULTS.cutoff)) {
    bad('an uncoercible value was stored — cutoff=' + S.getParam('cutoff'));
  } else if (S.getParam('osc1wave') !== DEFAULTS.osc1wave) {
    bad('an invalid enum option was stored — osc1wave=' + S.getParam('osc1wave'));
  } else if (!eq(S.getParam('reso'), 6)) {
    bad('a valid value next to bad ones was dropped — reso=' + S.getParam('reso'));
  } else {
    ok('unknown keys and uncoercible values are ignored, valid neighbours still apply');
  }
})();

/* ------------------------------------------------------------------ *
 * 5. Events: 'preset' once, 'param' only for values that really changed.
 * ------------------------------------------------------------------ */
(function () {
  var S = fresh();
  S.setParam('osc2Level', 0);      // one deliberate change away from default

  var presets = [];
  var moved = [];
  S.on('preset', function (e) { presets.push(e); });
  S.on('param', function (e) { moved.push(e.name); });

  // cutoff moves, ampA is already at its default, osc2Level must be restored.
  S.loadPreset({ cutoff: 800, ampA: DEFAULTS.ampA });

  if (presets.length !== 1) {
    bad("'preset' fired " + presets.length + ' time(s), expected exactly 1');
  } else if (!presets[0].applied || !eq(presets[0].applied.cutoff, 800)) {
    bad("the 'preset' event does not report the applied patch");
  } else {
    ok("'preset' fires once and reports what the patch applied");
  }

  moved.sort();
  if (moved.join(',') !== 'cutoff,osc2Level') {
    bad("'param' fired for [" + moved.join(', ') + '], expected exactly cutoff and osc2Level ' +
        '(a parameter already at the incoming value must not fire)');
  } else {
    ok("'param' fires for exactly the parameters whose value changed");
  }
})();

/* ------------------------------------------------------------------ *
 * 6. Loading the defaults themselves is still the Init patch, and a
 *    full patch round-trips unchanged.
 * ------------------------------------------------------------------ */
(function () {
  var S = fresh();
  S.setParam('cutoff', 60);
  S.loadPreset(S.getDefaults());   // demo.js:1481, the Init button
  var params = S.getParams();
  var wrong = [];
  for (var k in DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, k) && !eq(params[k], DEFAULTS[k])) wrong.push(k);
  }
  if (wrong.length) bad('loadPreset(getDefaults()) left ' + wrong.join(', ') + ' off the default');
  else ok('the Init path (loadPreset(getDefaults())) still returns every parameter to its default');

  var full = S.getDefaults();
  full.cutoff = 2400; full.reso = 8; full.arpOn = 'on'; full.volume = 0.6;
  S.loadPreset(full);
  var out = S.getParams();
  var bleed = [];
  for (var n in full) {
    if (Object.prototype.hasOwnProperty.call(full, n) && !eq(out[n], full[n])) bleed.push(n);
  }
  if (bleed.length) bad('a full patch did not round-trip: ' + bleed.join(', '));
  else ok('a full patch (the shipped library shape) round-trips exactly');
})();

/* ------------------------------------------------------------------ *
 * 7. Guard the shape itself so the merge-only version cannot come back.
 * ------------------------------------------------------------------ */
(function () {
  if (!/function\s+loadPreset\s*\(\s*obj\s*,\s*opts\s*\)/.test(source)) {
    bad('loadPreset no longer takes the (obj, opts) signature the callers rely on for { merge: true }');
  } else {
    ok('loadPreset(obj, opts) signature is in place');
  }
  if (!/loadPreset:\s*loadPreset/.test(source)) {
    bad('loadPreset is no longer exported on SSSynth');
  }
})();

/* ------------------------------------------------------------------ */
if (errors.length) {
  console.error('\nPreset recall check failed with ' + errors.length + ' problem(s):\n');
  errors.forEach(function (e) { console.error(' - ' + e + '\n'); });
  console.error('Please inspect loadPreset() in site/assets/js/synth.js');
  process.exit(2);
}

console.log('\nSSSynth.loadPreset recalls a whole patch: unnamed parameters return to their defaults');
process.exit(0);
