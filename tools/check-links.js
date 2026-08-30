#!/usr/bin/env node
'use strict';
/*
 * check-links.js — zero-dependency internal link checker for the static site.
 *
 * Usage:  node tools/check-links.js
 * Needs:  Node 18 or newer. No npm packages.
 *
 * What it does:
 *  - walks site/ and reads every .html, .js and .css file;
 *  - collects targets from href="..." / src="..." attributes, from fetch('...')
 *    string literals, and from arrays of two or more quoted paths (fallback
 *    lists such as JSON_PATHS in site/assets/js/changelog.js);
 *  - additionally collects CSS targets — url(...) references and @import
 *    targets — from every .css file under site/ and from the contents of every
 *    <style> block in an .html file, applying exactly the same skip rules
 *    (data:, http(s):, protocol-relative //, and #fragment values are ignored,
 *    so inline data: URIs and url(#filter) SVG references never fail);
 *  - skips anything with a URL scheme (http:, https:, mailto:, data:, ...),
 *    protocol-relative //host URLs, bare '#' fragments and empty values;
 *  - resolves everything else against the directory of the file it appears in
 *    (a leading '/' resolves against site/) and checks that it exists on disk;
 *    a relative target inside a .js file is additionally tried against every
 *    directory under site/ that holds an HTML document, because a shared script
 *    (site/assets/js/*.js) resolves its fetch() paths against the page that
 *    loaded it, not against itself;
 *  - a fallback list passes when at least one of its candidates resolves;
 *  - also walks every *.json file under data/ and site/data/ (recursively), finds any
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
const SITE_DATA_DIR = path.join(SITE_DIR, 'data');

// href= / src= but not data-src=, data-demo-src=, etc.
const ATTR_RE = /(?<![\w-])(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
// fetch('literal') / fetch("literal")
const FETCH_RE = /\bfetch\(\s*(?:'([^']*)'|"([^']*)")/g;
// fetch(`literal`)
const FETCH_TEMPLATE_RE = /\bfetch\(\s*`([^`]*)`/g;
// ['a', "b", ...] — arrays of two or more string literals, treated as a fallback list
const GROUP_RE = /\[\s*((?:'[^']*'|"[^']*")(?:\s*,\s*(?:'[^']*'|"[^']*"))+)\s*\]/g;
const STRING_RE = /'([^']*)'|"([^']*)"/g;
// <style> ... </style> blocks inside an HTML document
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
// url(foo) / url('foo') / url("foo")
const CSS_URL_RE = /\burl\(\s*(?:'([^']*)'|"([^']*)"|([^)'"\s]+))\s*\)/gi;
// @import 'foo'; / @import "foo";  (the @import url(...) form is covered by CSS_URL_RE)
const CSS_IMPORT_RE = /@import\s+(?:'([^']*)'|"([^']*)")/gi;

function walk(dir, out) {
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(html|js|css)$/i.test(name)) out.push(full);
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

function cleanTarget(target) {
  let clean = stripQueryAndHash(target.trim());
  try { clean = decodeURIComponent(clean); } catch (e) { /* keep as is */ }
  return clean;
}

function resolveTarget(target, file) {
  const clean = cleanTarget(target);
  if (clean === '') return null; // "page.html#section" style self-links
  if (clean.startsWith('/')) {
    const stripped = clean.replace(/^\/+/,'');
    return path.resolve(SITE_DIR, stripped);
  }
  return path.resolve(path.dirname(file), clean);
}

// Every directory under site/ that holds an HTML document, plus site/ itself.
// A relative fetch()/path literal inside a *shared* script resolves against the
// document that loaded it, not against the script, so those are the only bases
// a runtime request can actually use.
let DOC_DIRS = null;
function docDirs() {
  if (DOC_DIRS) return DOC_DIRS;
  const dirs = new Set([SITE_DIR]);
  for (const f of walk(SITE_DIR)) {
    if (/\.html?$/i.test(f)) dirs.add(path.dirname(f));
  }
  DOC_DIRS = Array.from(dirs);
  return DOC_DIRS;
}

// All the places a single target could legitimately resolve to. Usually one;
// for a relative target inside a .js file it is the script's own directory plus
// every document directory, because that is what the browser will do with it.
function resolveCandidates(target, file) {
  const clean = cleanTarget(target);
  if (clean === '') return [];
  if (clean.startsWith('/')) {
    const stripped = clean.replace(/^\/+/,'');
    return [path.resolve(SITE_DIR, stripped)];
  }

  const out = [path.resolve(path.dirname(file), clean)];
  if (/\.js$/i.test(file)) {
    for (const dir of docDirs()) {
      const candidate = path.resolve(dir, clean);
      if (out.indexOf(candidate) === -1) out.push(candidate);
    }
  }
  return out;
}

function existsSomewhere(candidates) {
  if (!candidates || candidates.length === 0) return true; // pure "#fragment"
  return candidates.some(existsOnDisk);
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

// url(...) and @import targets inside a stylesheet. `text` is the stylesheet
// source, `base` its absolute offset inside `full` (0 for a standalone .css
// file, the offset of the <style> body for an inline block) so reported line
// numbers always refer to the real file.
function collectCss(text, base, full, singles) {
  let m;

  CSS_URL_RE.lastIndex = 0;
  while ((m = CSS_URL_RE.exec(text)) !== null) {
    const target = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
    singles.push({ target, line: lineOf(full, base + m.index) });
  }

  CSS_IMPORT_RE.lastIndex = 0;
  while ((m = CSS_IMPORT_RE.exec(text)) !== null) {
    const target = m[1] !== undefined ? m[1] : m[2];
    singles.push({ target, line: lineOf(full, base + m.index) });
  }
}

function collect(file, text) {
  const singles = []; // { target, line }
  const groups = [];  // { targets: [], line }
  const ext = path.extname(file).toLowerCase();
  let m;

  if (ext === '.css') {
    collectCss(text, 0, text, singles);
    return { singles, groups };
  }

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

  // also capture fetch(`...`) template-literal usages
  FETCH_TEMPLATE_RE.lastIndex = 0;
  while ((m = FETCH_TEMPLATE_RE.exec(text)) !== null) {
    const target = m[1];
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

  if (ext === '.html' || ext === '.htm') {
    STYLE_BLOCK_RE.lastIndex = 0;
    while ((m = STYLE_BLOCK_RE.exec(text)) !== null) {
      const body = m[1];
      const base = m.index + m[0].indexOf(body);
      collectCss(body, base, text, singles);
    }
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
      if (!existsSomewhere(resolveCandidates(target, file))) {
        missing.push({ file, line, target, resolved });
      }
    }

    for (const { targets, line } of groups) {
      const candidates = [];
      for (const t of targets) {
        if (isExternal(t)) continue;
        candidates.push(...resolveCandidates(t, file));
      }
      if (!existsSomewhere(candidates)) missing.push({ file, line, target: '[' + targets.join(', ') + ']', resolved: null });
    }
  }

  // Check JSON data/ and site/data/ for any nested { links: { ... } } objects.
  for (const j of walkJson(DATA_DIR).concat(walkJson(SITE_DATA_DIR)).sort()) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(j, 'utf8')); } catch (e) { warnings.push({ file: j, message: 'failed to parse JSON: ' + e.message }); continue; }
    const objs = [];
    findLinkObjects(parsed, objs);
    for (const obj of objs) {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== 'string') continue;
        if (isExternal(v)) continue;
        checked++;
        const resolved = resolveTarget(v, j);
        if (!existsSomewhere(resolveCandidates(v, j))) missing.push({ file: j, line: 1, target: v, resolved });
      }
    }
  }

  for (const w of warnings) console.error('check-links: warning: ' + rel(w.file) + ': ' + w.message);
  for (const m of missing) console.error('' + rel(m.file) + ':' + m.line + '  ' + m.target + ' -> ' + (m.resolved ? rel(m.resolved) : '??'));
  if (missing.length > 0) {
    console.error('\ncheck-links: ' + missing.length + ' missing targets, ' + checked + ' checked');
    process.exit(1);
  }

  console.log('check-links: ok — ' + checked + ' targets checked');
  process.exit(0);
}

if (require.main === module) main();
