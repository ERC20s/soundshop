#!/usr/bin/env node
/*
Usage: node tools/validate-data.js

Validate site/presets/flagship-presets.json and data/changelog.json for
structural problems that can break the site. Prints a short human-readable
summary, emits non-fatal warnings for style issues, and exits with status 1
for fatal errors (parse failures or missing required fields).
*/

const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    return { ok: true, data: JSON.parse(txt) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function slugBase(name) {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

let fatal = false;
const warnings = [];
const errors = [];

function fatalError(msg) {
  errors.push(msg);
  fatal = true;
}

function warn(msg) {
  warnings.push(msg);
}

// Paths
const PRESETS_PATH = path.resolve(process.cwd(), 'site/presets/flagship-presets.json');
const CHANGELOG_PATH = path.resolve(process.cwd(), 'data/changelog.json');

console.log('validate-data: reading fixtures');

// Presets
const presetsRead = readJson(PRESETS_PATH);
if (!presetsRead.ok) {
  fatalError(`Failed to read or parse presets JSON at ${PRESETS_PATH}: ${presetsRead.error.message}`);
} else {
  const presets = presetsRead.data;
  if (!Array.isArray(presets)) {
    fatalError('Presets JSON must be a top-level array.');
  } else {
    console.log(`Presets: ${presets.length} items`);
    const seenSlugs = new Map();
    presets.forEach((p, i) => {
      const where = `presets[${i}]`;
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        fatalError(`${where} must be an object.`);
        return;
      }
      if (!p.name || typeof p.name !== 'string' || p.name.trim() === '') {
        fatalError(`${where} missing non-empty name string.`);
      }
      if ('params' in p && (p.params === null || typeof p.params !== 'object' || Array.isArray(p.params))) {
        fatalError(`${where}.params must be an object when present.`);
      }
      const params = p.params || {};
      const hasOsc1 = 'osc1' in params;
      const hasFilter = 'filter' in params;
      if (hasOsc1 && typeof params.osc1 !== 'string') {
        fatalError(`${where}.params.osc1 must be a string when present.`);
      }
      if (hasFilter && typeof params.filter !== 'number') {
        fatalError(`${where}.params.filter must be a number when present.`);
      }
      if (!hasOsc1 && !hasFilter) {
        fatalError(`${where} must include at least one of params.osc1 or params.filter.`);
      }
      // slug check (warning on collisions)
      const base = slugBase(p.name || '');
      if (!base) {
        warn(`${where} name produced empty slug base; consider a simpler name.`);
      } else {
        const prev = seenSlugs.get(base);
        if (prev) {
          warn(`Slug base collision: ${where} and ${prev} both -> "${base}"`);
        } else {
          seenSlugs.set(base, where);
        }
      }
    });
  }
}

// Changelog
const changelogRead = readJson(CHANGELOG_PATH);
if (!changelogRead.ok) {
  fatalError(`Failed to read or parse changelog JSON at ${CHANGELOG_PATH}: ${changelogRead.error.message}`);
} else {
  let raw = changelogRead.data;
  let entries = null;
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) {
    entries = raw.entries;
  } else {
    fatalError('Changelog JSON must be either an array or an object with an "entries" array.');
  }

  if (entries) {
    console.log(`Changelog: ${entries.length} entries`);
    entries.forEach((e, i) => {
      const where = `changelog[${i}]`;
      if (!e || typeof e !== 'object' || Array.isArray(e)) {
        fatalError(`${where} must be an object.`);
        return;
      }
      if (!('version' in e) || typeof e.version !== 'string' || e.version.trim() === '') {
        fatalError(`${where} missing non-empty version string.`);
      }
      if (!('notes' in e)) {
        fatalError(`${where} missing notes (string or array).`);
      } else {
        const notes = e.notes;
        if (typeof notes === 'string') {
          if (notes.trim() === '') warn(`${where}.notes is an empty string.`);
        } else if (Array.isArray(notes)) {
          if (notes.length === 0) warn(`${where}.notes is an empty array.`);
          else {
            const empty = notes.filter(n => typeof n !== 'string' || n.trim() === '');
            if (empty.length > 0) warn(`${where}.notes contains ${empty.length} empty or non-string items.`);
          }
        } else {
          fatalError(`${where}.notes must be a string or an array.`);
        }
      }
      if (!('date' in e) || !e.date) {
        warn(`${where} is missing a date; this is optional but recommended.`);
      }
    });
  }
}

// Summary
console.log('');
if (errors.length === 0 && warnings.length === 0) {
  console.log('OK: no errors or warnings detected.');
} else {
  if (errors.length > 0) {
    console.log(`Errors (${errors.length}):`);
    errors.forEach(m => console.log('- ' + m));
  }
  if (warnings.length > 0) {
    console.log(`Warnings (${warnings.length}):`);
    warnings.forEach(m => console.log('- ' + m));
  }
}

if (errors.length > 0) {
  console.log('\nvalidate-data: exiting with status 1 due to fatal errors.');
  process.exit(1);
} else {
  console.log('\nvalidate-data: done (warnings only => exit 0).');
  process.exit(0);
}
