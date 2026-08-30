#!/usr/bin/env node
'use strict';
/*
 * tools/check-inline-event-handlers.js — fail when an HTML page under site/
 * contains inline event handler attributes (on*). Zero-dependency Node 18+
 * script.
 *
 * Usage: node tools/check-inline-event-handlers.js
 *
 * Opt-out: place <!-- no-inline-event-check --> anywhere in an .html file to
 * skip scanning that file when there is an audited reason to keep an inline
 * handler.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

const TAG_RE = /<[^>]+>/g;
const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const OPT_OUT_RE = /<!--\s*no-inline-event-check\s*-->/i;
const ATTR_ON_RE = /\b(on[a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function walk(dir, out) {
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.html?$/i.test(name)) out.push(full);
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

function report(problems) {
  console.error('\nFound', problems.length, 'inline event handler(s):\n');
  for (const p of problems) {
    console.error(rel(p.file) + ':' + p.line + '  ' + p.attr + ' -> ' + p.preview);
    console.error('-----');
  }
}

function indexInRanges(idx, ranges) {
  for (const r of ranges) if (idx >= r[0] && idx < r[1]) return true;
  return false;
}

function collectFromFile(file, text, problems) {
  // skip opt-out
  if (OPT_OUT_RE.test(text)) return;

  // collect script tag ranges so we can ignore tags inside <script>...</script>
  const scriptRanges = [];
  SCRIPT_TAG_RE.lastIndex = 0;
  let sm;
  while ((sm = SCRIPT_TAG_RE.exec(text)) !== null) {
    scriptRanges.push([sm.index, sm.index + sm[0].length]);
  }

  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(text)) !== null) {
    const tagStart = m.index;
    // ignore tags inside script bodies
    if (indexInRanges(tagStart, scriptRanges)) continue;
    const tag = m[0];
    ATTR_ON_RE.lastIndex = 0;
    let am;
    while ((am = ATTR_ON_RE.exec(tag)) !== null) {
      const attrName = am[1];
      const line = lineOf(text, tagStart); // per spec, compute from tag start
      const preview = previewLine(text, line);
      problems.push({ file, line, attr: attrName, preview });
    }
  }
}

function main() {
  if (!fs.existsSync(SITE_DIR)) {
    console.error('check-inline-event-handlers: site/ directory not found at ' + SITE_DIR);
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

  console.log('No inline on* event handler attributes found in scanned HTML files under site/. Scanned', files.length, 'file(s).');
  process.exitCode = 0;
}

if (require.main === module) main();
