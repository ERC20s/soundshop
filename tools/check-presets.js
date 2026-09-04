#!/usr/bin/env node
'use strict';
/*
 * tools/check-presets.js — semantic checks for preset JSON files under site/presets/
 *
 * Usage: node tools/check-presets.js
 * Needs: Node 18 or newer. No npm packages.
 *
 * Behavior:
 *  - find every *.json under site/presets/ (recursively) and parse them (UTF-8);
 *  - require each preset object to have a non-empty string id and name;
 *  - ensure preset ids are unique across all scanned files;
 *  - ensure preset.params, if present, is an object (not an array);
 *  - attempt to derive the parameter contract from site/assets/js/synth.js by
 *    scanning for R('name', label, group, min, max, ...) and
 *    E('name', label, group, options, ...) calls; when available,
 *    validate that every key in params is one of those names; if extraction
 *    fails, skip param-name validation and print a warning;
 *  - validate VALUES against that same contract: a range parameter must carry a
 *    finite number inside [min, max], an enum parameter must carry one of the
 *    strings the spec lists. The engine hides these mistakes at runtime —
 *    coerce() clamps numbers with clamp(n, spec.min, spec.max) and returns null
 *    for an unknown enum string, in which case loadPreset falls back to the
 *    factory default — so a preset card can advertise a value the synth never
 *    plays. This check makes that a build error instead;
 *  - print file:line information for issues and exit with code 1 on any error.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PRESETS_DIR = path.join(REPO_ROOT, 'site', 'presets');
const SYNTH_JS = path.join(REPO_ROOT, 'site', 'assets', 'js', 'synth.js');

function rel(p) { return path.relative(REPO_ROOT, p).split(path.sep).join('/') || '.'; }

function walkJson(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) walkJson(full, out);
    else if (/\.json$/i.test(name)) out.push(full);
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function findPropPositions(text, prop) {
  const re = new RegExp('"' + prop.replace(/[-\\\\^$*+?.()|[\]{}]/g, '\\$&') + '"\\s*:', 'g');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m.index);
  return out;
}

function extractParamNamesFromSynth(synthText) {
  if (!synthText || typeof synthText !== 'string') return null;
  const names = new Set();
  // match R('name', or R("name",
  const rRe = /\bR\s*\(\s*['\"]([^'\"]+)['\"]\s*,/g;
  const eRe = /\bE\s*\(\s*['\"]([^'\"]+)['\"]\s*,/g;
  let m;
  while ((m = rRe.exec(synthText)) !== null) names.add(m[1]);
  while ((m = eRe.exec(synthText)) !== null) names.add(m[1]);
  if (names.size === 0) return null;
  return names;
}

/* ---- parameter contract (ranges + enum options) --------------------------
 * synth.js builds PARAM_SPEC from two tiny factories:
 *   R(name, label, group, min, max, step, def, unit, curve)
 *   E(name, label, group, options, optionLabels, def)
 * so min/max and the option list can be read straight off those calls. Enum
 * option lists are usually named constants (WAVES, LFO_WAVES, ...), which are
 * resolved from their `var NAME = ['a', 'b'];` declarations; an inline array
 * literal works too. Anything that cannot be resolved is simply left
 * unvalidated rather than reported as a failure.
 */

function stringLiteralsIn(src) {
  const out = [];
  const re = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[2]);
  return out;
}

function extractArrayConstants(text) {
  const consts = Object.create(null);
  const re = /\b(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) consts[m[1]] = stringLiteralsIn(m[2]);
  return consts;
}

const NUM = '-?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
const STR = '(?:\'[^\']*\'|"[^"]*")';

function extractParamSpecsFromSynth(synthText) {
  if (!synthText || typeof synthText !== 'string') return null;
  const consts = extractArrayConstants(synthText);
  const specs = new Map();
  let m;

  // R('name', 'Label', 'group', min, max, ...)
  const rRe = new RegExp(
    '\\bR\\s*\\(\\s*(' + STR + ')\\s*,\\s*' + STR + '\\s*,\\s*' + STR +
    '\\s*,\\s*(' + NUM + ')\\s*,\\s*(' + NUM + ')\\s*,', 'g'
  );
  while ((m = rRe.exec(synthText)) !== null) {
    const name = m[1].slice(1, -1);
    const min = parseFloat(m[2]);
    const max = parseFloat(m[3]);
    if (!name || !isFinite(min) || !isFinite(max) || min > max) continue;
    specs.set(name, { type: 'range', min: min, max: max });
  }

  // E('name', 'Label', 'group', OPTIONS_OR_ARRAY, ...)
  const eRe = new RegExp(
    '\\bE\\s*\\(\\s*(' + STR + ')\\s*,\\s*' + STR + '\\s*,\\s*' + STR +
    '\\s*,\\s*(\\[[^\\]]*\\]|[A-Za-z_$][\\w$]*)\\s*,', 'g'
  );
  while ((m = eRe.exec(synthText)) !== null) {
    const name = m[1].slice(1, -1);
    if (!name) continue;
    const raw = m[2];
    const options = raw.charAt(0) === '['
      ? stringLiteralsIn(raw)
      : (consts[raw] || null);
    if (!options || !options.length) continue;  // unresolved: name only
    specs.set(name, { type: 'enum', options: options.slice() });
  }

  return specs.size ? specs : null;
}

/* Mirrors what SSSynth.coerce() would accept for a range parameter: a finite
   number, or a string that parses as one. Returns null when the value could
   never be read as a number at all. */
function asNumber(value) {
  if (typeof value === 'number') return isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = parseFloat(value);
    return isFinite(n) ? n : null;
  }
  return null;
}

function checkParamValue(spec, value) {
  if (!spec) return null;
  if (spec.type === 'enum') {
    if (typeof value !== 'string' || spec.options.indexOf(value) < 0) {
      return 'value ' + JSON.stringify(value) + ' is not one of [' +
        spec.options.join(', ') + '] — the engine would ignore it and use the default';
    }
    return null;
  }
  const n = asNumber(value);
  if (n === null) {
    return 'value ' + JSON.stringify(value) + ' is not a number (expected ' +
      spec.min + '..' + spec.max + ')';
  }
  if (n < spec.min || n > spec.max) {
    return 'value ' + n + ' is out of range ' + spec.min + '..' + spec.max +
      ' — the engine would clamp it, so the preset would not sound as listed';
  }
  return null;
}

function reportError(errs, file, line, msg) {
  errs.push({ file, line, msg });
}

function prettyPrintErrors(errs) {
  for (const e of errs) {
    console.error(rel(e.file) + ':' + e.line + '  ' + e.msg);
  }
}

function safeReadUtf8(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

function main() {
  if (!fs.existsSync(PRESETS_DIR)) {
    console.log('check-presets: site/presets/ directory not found; nothing to scan.');
    process.exitCode = 0;
    return;
  }

  const files = walkJson(PRESETS_DIR).sort();
  if (files.length === 0) {
    console.log('check-presets: no JSON files under site/presets/; nothing to scan.');
    process.exitCode = 0;
    return;
  }

  // attempt to extract the parameter contract from synth.js
  const synthText = safeReadUtf8(SYNTH_JS);
  const allowedParams = extractParamNamesFromSynth(synthText);
  const paramSpecs = extractParamSpecsFromSynth(synthText);
  if (allowedParams && !paramSpecs) {
    console.error('check-presets: warning: failed to extract parameter ranges/options from ' + rel(SYNTH_JS) + ', skipping value validation.');
  }
  if (!allowedParams) {
    if (!synthText) {
      console.error('check-presets: warning: could not read ' + rel(SYNTH_JS) + ', skipping param-name validation.');
    } else {
      console.error('check-presets: warning: failed to extract parameter names from ' + rel(SYNTH_JS) + ', skipping param-name validation.');
    }
  }

  const errors = [];
  const seenIds = new Map(); // id -> { file, index }
  let totalEntries = 0;

  for (const file of files) {
    const relpath = rel(file);
    const text = safeReadUtf8(file);
    if (text === null) {
      reportError(errors, file, 1, 'failed to read file');
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // reuse a simple error print like check-json would
      reportError(errors, file, 1, 'JSON parse error: ' + (e && e.message ? e.message : String(e)));
      continue;
    }

    let entries = null;
    if (Array.isArray(parsed)) entries = parsed;
    else if (parsed && typeof parsed === 'object') {
      // if it's an object whose values look like presets, treat its values as entries
      entries = Object.values(parsed);
    } else {
      reportError(errors, file, 1, 'expected top-level array or object of presets');
      continue;
    }

    // find positions of "id" labels to give line numbers if possible
    const idPositions = findPropPositions(text, 'id');

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      totalEntries++;
      const line = (idPositions[i] !== undefined) ? lineOf(text, idPositions[i]) : 1;
      const base = 'entry[' + i + ']';
      if (!entry || typeof entry !== 'object') {
        reportError(errors, file, line, base + ' is not an object');
        continue;
      }
      // id
      if (!('id' in entry)) {
        reportError(errors, file, line, base + ' missing required "id"');
      } else if (typeof entry.id !== 'string' || entry.id.trim() === '') {
        reportError(errors, file, line, base + ' has empty or non-string "id"');
      } else {
        const id = entry.id;
        if (seenIds.has(id)) {
          const prev = seenIds.get(id);
          reportError(errors, file, line, 'duplicate preset id "' + id + '" previously in ' + rel(prev.file) + ' entry[' + prev.index + ']');
        } else {
          seenIds.set(id, { file, index: i });
        }
      }

      // name
      if (!('name' in entry)) {
        reportError(errors, file, line, base + ' missing required "name"');
      } else if (typeof entry.name !== 'string' || entry.name.trim() === '') {
        reportError(errors, file, line, base + ' has empty or non-string "name"');
      }

      // params
      if ('params' in entry) {
        const p = entry.params;
        if (p === null || typeof p !== 'object' || Array.isArray(p)) {
          reportError(errors, file, line, base + '.params must be an object (not null or array)');
        } else if (allowedParams) {
          for (const k of Object.keys(p)) {
            if (!allowedParams.has(k)) {
              reportError(errors, file, line, base + '.params contains unknown key "' + k + '"');
              continue;
            }
            if (!paramSpecs) continue;
            const spec = paramSpecs.get(k);
            if (!spec) continue;   // name known, contract not resolvable: leave it alone
            const problem = checkParamValue(spec, p[k]);
            if (problem) {
              reportError(errors, file, line, base + '.params."' + k + '" ' + problem);
            }
          }
        }
      }
    }
  }

  if (errors.length) {
    console.error('\ncheck-presets: found ' + errors.length + ' problem(s) in ' + files.length + ' file(s) (' + totalEntries + ' entry(ies)).');
    prettyPrintErrors(errors);
    process.exitCode = 1;
    return;
  }

  console.log('check-presets: OK. Scanned ' + files.length + ' file(s). Found ' + totalEntries + ' preset(s).');
  if (paramSpecs) {
    console.log('check-presets: validated parameter values against ' + paramSpecs.size + ' spec(s) from ' + rel(SYNTH_JS) + '.');
  }
  if (!allowedParams) console.log('check-presets: note: parameter-name validation was skipped due to inability to extract names from ' + rel(SYNTH_JS) + '.');
  process.exitCode = 0;
}

main();
