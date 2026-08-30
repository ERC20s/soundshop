#!/usr/bin/env node
'use strict';

// tools/check-no-root-urls.js — fail if any site-facing URL literal begins with
// a leading '/' (root-anchored). Zero-dependency Node 18+ script.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

const ATTR_RE = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const FETCH_RE = /\bfetch\(\s*(?:'([^']*)'|"([^']*)")/g;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const ATTR_SRC_RE = /\bsrc\b\s*=/i;
const CSS_URL_RE = /\burl\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"\s]+))\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:'([^']*)'|"([^']*)")/gi;
// new: capture inline style="..." or style='...'
const STYLE_ATTR_RE = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

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

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/');
}

function previewLine(text, lineNumber, max = 320) {
  const lines = String(text).split(/\r?\n/);
  if (lineNumber < 1) lineNumber = 1;
  if (lineNumber > lines.length) lineNumber = lines.length;
  const s = lines[lineNumber - 1].trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n...';
}

function isSkippable(target) {
  if (!target) return true;
  const t = target.trim();
  if (t === '') return true;
  if (t.startsWith('//')) return true; // protocol-relative
  return /^[a-z][a-z0-9+.-]*:/i.test(t); // has a scheme like http:, data:, mailto:, etc.
}

function report(problems) {
  console.error('\nFound', problems.length, 'root-anchored URL(s):\n');
  for (const p of problems) {
    console.error(rel(p.file) + ':' + p.line + '  ' + p.target);
    console.error('  ' + p.preview);
    console.error('-----');
  }
}

function collectCss(text, baseIndex, file, problems) {
  let m;
  CSS_URL_RE.lastIndex = 0;
  while ((m = CSS_URL_RE.exec(text)) !== null) {
    const target = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
    if (!target) continue;
    if (target.startsWith('/') && !target.startsWith('//') && !isSkippable(target)) {
      problems.push({ file, line: lineOf(text, baseIndex + m.index), target, preview: previewLine(text, lineOf(text, baseIndex + m.index)) });
    }
  }
  CSS_IMPORT_RE.lastIndex = 0;
  while ((m = CSS_IMPORT_RE.exec(text)) !== null) {
    const target = m[1] !== undefined ? m[1] : m[2];
    if (!target) continue;
    if (target.startsWith('/') && !target.startsWith('//') && !isSkippable(target)) {
      problems.push({ file, line: lineOf(text, baseIndex + m.index), target, preview: previewLine(text, lineOf(text, baseIndex + m.index)) });
    }
  }
}

function collectFromFile(file, text, problems) {
  const ext = path.extname(file).toLowerCase();
  let m;

  if (ext === '.css') {
    collectCss(text, 0, file, problems);
    return;
  }

  // ATTR_RE: href= / src=
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(text)) !== null) {
    const target = m[1] !== undefined ? m[1] : m[2];
    if (!target) continue;
    if (target.startsWith('/') && !target.startsWith('//') && !isSkippable(target)) {
      problems.push({ file, line: lineOf(text, m.index), target, preview: previewLine(text, lineOf(text, m.index)) });
    }
  }

  // fetch(...) in this file (covers .js and inline scripts we will extract below)
  if (ext === '.js') {
    FETCH_RE.lastIndex = 0;
    while ((m = FETCH_RE.exec(text)) !== null) {
      const target = m[1] !== undefined ? m[1] : m[2];
      if (!target) continue;
      if (target.startsWith('/') && !target.startsWith('//') && !isSkippable(target)) {
        problems.push({ file, line: lineOf(text, m.index), target, preview: previewLine(text, lineOf(text, m.index)) });
      }
    }
  }

  // If this is HTML, also check inline <style> and <script> bodies and inline style="..." attributes
  if (ext === '.html' || ext === '.htm') {
    // inline style blocks
    STYLE_BLOCK_RE.lastIndex = 0;
    while ((m = STYLE_BLOCK_RE.exec(text)) !== null) {
      const body = m[1] || '';
      const base = m.index + m[0].indexOf(body);
      collectCss(body, base, file, problems);
    }

    // inline style="..." attributes — scan attribute values as CSS text
    STYLE_ATTR_RE.lastIndex = 0;
    while ((m = STYLE_ATTR_RE.exec(text)) !== null) {
      const body = m[1] !== undefined ? m[1] : m[2] || '';
      if (!body) continue;
      // compute absolute index in file so line numbers match preview and other reports
      const base = m.index + m[0].indexOf(body);
      collectCss(body, base, file, problems);
    }

    // inline script bodies — skip scripts with src attribute
    SCRIPT_TAG_RE.lastIndex = 0;
    while ((m = SCRIPT_TAG_RE.exec(text)) !== null) {
      const attrs = m[1] || '';
      const body = m[2] || '';
      if (ATTR_SRC_RE.test(attrs)) continue; // external script
      // scan this inline script for fetch('...') literals
      FETCH_RE.lastIndex = 0;
      while ((m2 = FETCH_RE.exec(body)) !== null) {
        const target = m2[1] !== undefined ? m2[1] : m2[2];
        if (!target) continue;
        const absIndex = m.index + m[0].indexOf(body) + m2.index;
        if (target.startsWith('/') && !target.startsWith('//') && !isSkippable(target)) {
          problems.push({ file, line: lineOf(text, absIndex), target, preview: previewLine(text, lineOf(text, absIndex)) });
        }
      }
    }
  }
}

function main() {
  if (!fs.existsSync(SITE_DIR)) {
    console.error('site/ directory not found at', SITE_DIR);
    process.exit(2);
  }

  const files = walk(SITE_DIR).sort();
  const problems = [];

  for (const file of files) {
    let txt;
    try {
      txt = fs.readFileSync(file, 'utf8');
    } catch (err) {
      console.error('Failed to read', file, err && err.message);
      process.exit(2);
    }
    collectFromFile(file, txt, problems);
  }

  if (problems.length) {
    report(problems);
    console.error('Scanned', files.length, 'file(s) under site/.');
    process.exitCode = 1;
    return;
  }

  console.log('No root-anchored leading \'/\' URL literals found in scanned .html, .js and .css files under site/. Scanned', files.length, 'file(s).');
  process.exitCode = 0;
}

main();
