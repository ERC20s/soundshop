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
 *  - attempt to derive allowed parameter names from site/assets/js/synth.js by
 *    scanning for R('name', ...) and E('name', ...) calls; when available,
 *    validate that every key in params is one of those names; if extraction
 *    fails, skip param-name validation and print a warning;
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

  // attempt to extract parameter names from synth.js
  const synthText = safeReadUtf8(SYNTH_JS);
  const allowedParams = extractParamNamesFromSynth(synthText);
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
  if (!allowedParams) console.log('check-presets: note: parameter-name validation was skipped due to inability to extract names from ' + rel(SYNTH_JS) + '.');
  process.exitCode = 0;
}

main();
