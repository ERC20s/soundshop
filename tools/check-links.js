#!/usr/bin/env node
'use strict';
/*
 * check-links.js — zero-dependency internal link checker for the static site.
 *
 * Usage:  node tools/check-links.js
 * Needs:  Node 18 or newer. No npm packages.
 *
 * What it does:
 *  - walks site/ and reads every .html and .js file;
 *  - collects targets from href="..." / src="..." attributes, from fetch('...')
 *    string literals, and from arrays of two or more quoted paths (fallback
 *    lists such as JSON_PATHS in site/changelog.js);
 *  - skips anything with a URL scheme (http:, https:, mailto:, data:, ...),
 *    protocol-relative //host URLs, bare '#' fragments and empty values;
 *  - resolves everything else against the directory of the file it appears in
 *    (a leading '/' resolves against site/) and checks that it exists on disk;
 *  - a fallback list passes when at least one of its candidates resolves;
 *  - also walks every *.json file under data/ (recursively), finds any
 *    "links": { ... } object anywhere inside the parsed JSON (e.g. the
 *    per-entry links in data/changelog.json) and checks each value the same
 *    way — leading '/' resolves against site/, everything else resolves
 *    relative to the JSON file's own directory. A data/ file that fails to
 *    parse as JSON is reported as a warning, not a fatal error;
 *  - prints every missing target as  file:line  target -> resolved path  and
 *    exits with status 1 when anything is missing, 0 otherwise.
 *
 * Deliberately NOT checked: data-* attributes (used for optional targets that a
 * page probes at runtime, e.g. data-demo-src on the flagship page), URLs that
 * are built dynamically at runtime, and whether a "#fragment" on a checked
 * target actually exists in the target file (only the file's existence is
 * verified).
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');
const DATA_DIR = path.join(REPO_ROOT, 'data');

// href= / src= but not data-src=, data-demo-src=, etc.
const ATTR_RE = /(?<![\w-])(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
// fetch('literal') / fetch("literal")
const FETCH_RE = /\bfetch\(\s*(?:'([^']*)'|"([^"]*)")/g;
// ['a', "b", ...] — arrays of two or more string literals, treated as a fallback list
const GROUP_RE = /\[\s*((?:'[^']*'|"[^"]*")(?:\s*,\s*(?:'[^']*'|"[^"]*"))+)\s*\]/g;
const STRING_RE = /'([^']*)'|"([^"]*)"/g;

function walk(dir, out) {
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(html|js)$/i.test(name)) out.push(full);
  }
  return out;
}

function walkJson(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walkJson(full, out);
    else if (/\.json$/i.test(name)) out.push(full);
  }
  return out;
}

// Collect every {"links": {...}} object found anywhere inside a parsed JSON
// value — works whether the file is a single object or (like
// data/changelog.json) an array of entries, and however deep it is nested.
function findLinkObjects(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) findLinkObjects(item, out);
  } else if (node && typeof node === 'object') {
    if (node.links && typeof node.links === 'object' && !Array.isArray(node.links)) {
      out.push(node.links);
    }
    for (const v of Object.values(node)) findLinkObjects(v, out);
  }
}

function isExternal(target) {
  if (!target) return true;
  const t = target.trim();
  if (t === '' || t.startsWith('#')) return true;
  if (t.startsWith('//')) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(t); // http:, https:, mailto:, data:, javascript:, ...
}

function looksLikePath(s) {
  // Used only to decide whether a string inside an array is a path candidate.
  return /^[^\s'"<>]+$/.test(s) && (s.includes('/') || /\.[a-z0-9]+$/i.test(s));
}

function stripQueryAndHash(target) {
  return target.replace(/[?#].*$/, '');
}

function resolveTarget(target, file) {
  let clean = stripQueryAndHash(target.trim());
  try { clean = decodeURIComponent(clean); } catch (e) { /* keep as is */ }
  if (clean === '') return null; // "page.html#section" style self-links
  if (clean.startsWith('/')) return path.join(SITE_DIR, clean);
  return path.resolve(path.dirname(file), clean);
}

function existsOnDisk(resolved) {
  if (!resolved) return true;
  if (!fs.existsSync(resolved)) return false;
  const st = fs.statSync(resolved);
  if (st.isDirectory()) return fs.existsSync(path.join(resolved, 'index.html'));
  return true;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/');
}

function collect(file, text) {
  const singles = []; // { target, line }
  const groups = [];  // { targets: [], line }
  let m;

  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(text)) !== null) {
    const target = m[1] !== undefined ? m[1] : m[2];
    singles.push({ target, line: lineOf(text, m.index) });
  }

  FETCH_RE.lastIndex = 0;
  while ((m = FETCH_RE.exec(text)) !== null) {
    const target = m[1] !== undefined ? m[1] : m[2];
    singles.push({ target, line: lineOf(text, m.index) });
  }

  GROUP_RE.lastIndex = 0;
  while ((m = GROUP_RE.exec(text)) !== null) {
    const targets = [];
    let s;
    STRING_RE.lastIndex = 0;
    while ((s = STRING_RE.exec(m[1])) !== null) {
      const v = s[1] !== undefined ? s[1] : s[2];
      if (looksLikePath(v)) targets.push(v);
    }
    if (targets.length >= 2) groups.push({ targets, line: lineOf(text, m.index) });
  }

  return { singles, groups };
}

function main() {
  if (!fs.existsSync(SITE_DIR)) {
    console.error('check-links: site/ directory not found at ' + SITE_DIR);
    process.exit(2);
  }

  const files = walk(SITE_DIR).sort();
  const missing = [];
  const warnings = [];
  let checked = 0;

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const { singles, groups } = collect(file, text);

    for (const { target, line } of singles) {
      if (isExternal(target)) continue;
      checked++;
      const resolved = resolveTarget(target, file);
      if (!existsOnDisk(resolved)) {
        missing.push({ file, line, target, resolved });
      }
    }

    for (const { targets, line } of groups) {
      const local = targets.filter((t) => !isExternal(t));
      if (local.length === 0) continue;
      checked++;
      const resolvedAll = local.map((t) => resolveTarget(t, file));
      if (!resolvedAll.some(existsOnDisk)) {
        missing.push({
          file,
          line,
          target: '[' + local.join(', ') + ']',
          resolved: resolvedAll.map(rel).join(' | '),
        });
      }
    }
  }

  const dataFiles = walkJson(DATA_DIR).sort();
  for (const file of dataFiles) {
    const text = fs.readFileSync(file, 'utf8');
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      warnings.push(rel(file) + ': could not parse as JSON (' + e.message + ')');
      continue;
    }

    const linkObjects = [];
    findLinkObjects(data, linkObjects);

    for (const links of linkObjects) {
      for (const key of Object.keys(links)) {
        const target = links[key];
        if (typeof target !== 'string' || isExternal(target)) continue;
        checked++;
        const resolved = resolveTarget(target, file);
        if (!existsOnDisk(resolved)) {
          const idx = text.indexOf('"' + target + '"');
          const line = idx >= 0 ? lineOf(text, idx) : 1;
          missing.push({ file, line, target, resolved });
        }
      }
    }
  }

  for (const miss of missing) {
    const resolved = typeof miss.resolved === 'string' && miss.resolved.includes(' | ')
      ? miss.resolved
      : rel(miss.resolved);
    console.log(rel(miss.file) + ':' + miss.line + '  ' + miss.target + ' -> ' + resolved);
  }

  for (const w of warnings) {
    console.log('warning: ' + w);
  }

  console.log(
    'check-links: ' + files.length + ' site file(s), ' + dataFiles.length + ' data file(s), ' +
    checked + ' internal target(s), ' + missing.length + ' missing, ' + warnings.length + ' warning(s)'
  );
  process.exit(missing.length > 0 ? 1 : 0);
}

main();
