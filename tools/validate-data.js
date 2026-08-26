#!/usr/bin/env node
'use strict';
/*
 * validate-data.js — small, zero-dependency validator for the repo's JSON fixtures.
 *
 * Usage: node tools/validate-data.js
 * Exits with status 1 when fatal problems are found; 0 otherwise.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PRESETS_PATH = path.join(REPO_ROOT, 'site', 'presets', 'flagship-presets.json');
const CHANGELOG_PATH = path.join(REPO_ROOT, 'data', 'changelog.json');

function rel(p) { return path.relative(REPO_ROOT, p).split(path.sep).join('/'); }

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error('file not found');
  const text = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(text); } catch (e) { throw new Error('could not parse JSON: ' + e.message); }
}

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function slugBase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

const fatals = [];
const warnings = [];

// Validate presets
let presets;
try {
  presets = readJson(PRESETS_PATH);
} catch (e) {
  fatals.push(rel(PRESETS_PATH) + ': ' + e.message);
}

if (presets !== undefined) {
  if (!Array.isArray(presets)) {
    fatals.push(rel(PRESETS_PATH) + ': top-level JSON is not an array');
  } else {
    const slugMap = Object.create(null);
    presets.forEach((p, i) => {
      const which = rel(PRESETS_PATH) + '[' + i + ']';
      if (!p || typeof p !== 'object') { warnings.push(which + ': entry is not an object'); return; }
      if (typeof p.name !== 'string') warnings.push(which + ': name is not a string');
      if (p.params !== undefined && !isObject(p.params)) warnings.push(which + ': params is not an object');
      const params = isObject(p.params) ? p.params : {};
      if (params.osc1 !== undefined && typeof params.osc1 !== 'string') warnings.push(which + ': params.osc1 is not a string');
      if (params.filter !== undefined && typeof params.filter !== 'number') warnings.push(which + ': params.filter is not a number');
      const hasOsc1 = params.osc1 !== undefined;
      const hasFilter = params.filter !== undefined;
      if (!hasOsc1 && !hasFilter) {
        fatals.push(which + ': missing both params.osc1 and params.filter (UI relies on at least one)');
      }

      const base = slugBase(p.name || p.slug || ('preset-' + i));
      slugMap[base] = (slugMap[base] || []);
      slugMap[base].push({ index: i, name: p.name });
    });

    // warn on slug collisions
    for (const base of Object.keys(slugMap)) {
      if (slugMap[base].length > 1) {
        const list = slugMap[base].map((x) => (x.name ? JSON.stringify(x.name) : ('#' + x.index))).join(', ');
        warnings.push(rel(PRESETS_PATH) + ': many entries share base slug "' + base + '": ' + list);
      }
    }
  }
}

// Validate changelog
let changelog;
try {
  changelog = readJson(CHANGELOG_PATH);
} catch (e) {
  fatals.push(rel(CHANGELOG_PATH) + ': ' + e.message);
}

if (changelog !== undefined) {
  // Accept either an array (legacy/simple) or an object containing an "entries" array.
  if (!Array.isArray(changelog) && !(isObject(changelog) && Array.isArray(changelog.entries))) {
    fatals.push(rel(CHANGELOG_PATH) + ': top-level JSON is neither an array nor an object with an entries array');
  }
}

// Print reports
if (fatals.length > 0) {
  console.error('fatal: ' + fatals.length + ' problem(s) found:');
  for (const f of fatals) console.error('  - ' + f);
}

if (warnings.length > 0) {
  console.log('warning: ' + warnings.length + ' potential issue(s):');
  for (const w of warnings) console.log('  - ' + w);
}

const ok = fatals.length === 0;
console.log('validate-data: ' + (ok ? 'OK' : 'FAIL') + ' — ' +
  (presets === undefined ? 'presets:unknown' : 'presets:' + (Array.isArray(presets) ? presets.length + ' entry(s)' : 'invalid')) + ', ' +
  (changelog === undefined ? 'changelog:unknown' : (Array.isArray(changelog) ? 'changelog: array' : 'changelog: object with entries')) + ', ' +
  warnings.length + ' warning(s)');

process.exit(ok ? 0 : 1);
