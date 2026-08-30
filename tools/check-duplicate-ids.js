#!/usr/bin/env node
'use strict';
/*
 * tools/check-duplicate-ids.js — fail when an HTML page under site/
 * contains duplicate id="..." attributes. Zero-dependency Node 18+ script.
 *
 * Usage: node tools/check-duplicate-ids.js
 *
 * Opt-out: place <!-- no-duplicate-ids-check --> anywhere in an .html file to
 * skip scanning that file when there is an audited reason to keep duplicate ids.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

const TAG_RE = /<[^>]+>/g;
const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const OPT_OUT_RE = /<!--\s*no-duplicate-ids-check\s*-->/i;
const ATTR_ID_RE = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

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

function indexInRanges(idx, ranges) {
  for (const r of ranges) if (idx >= r[0] && idx < r[1]) return true;
  return false;
}

function collectFromFile(file, text, problems) {
  if (OPT_OUT_RE.test(text)) return;

  // collect script tag ranges so we can ignore tags inside <script>...</script>
  const scriptRanges = [];
  SCRIPT_TAG_RE.lastIndex = 0;
  let sm;
  while ((sm = SCRIPT_TAG_RE.exec(text)) !== null) {
    scriptRanges.push([sm.index, sm.index + sm[0].length]);
  }

  // map idValue -> { firstLine, firstIndex }
  const seen = Object.create(null);

  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(text)) !== null) {
    const tagStart = m.index;
    if (indexInRanges(tagStart, scriptRanges)) continue;
    const tag = m[0];
    ATTR_ID_RE.lastIndex = 0;
    let am;
    while ((am = ATTR_ID_RE.exec(tag)) !== null) {
      const idVal = am[1] !== undefined ? am[1] : am[2];
      if (!idVal) continue;
      const globalIndex = tagStart + am.index; // approximate position
      const line = lineOf(text, tagStart);
      if (!Object.prototype.hasOwnProperty.call(seen, idVal)) {
        seen[idVal] = { line, index: globalIndex };
      } else {
        const first = seen[idVal];
        const preview = previewLine(text, line);
        problems.push({ file, line, id: idVal, firstLine: first.line, preview });
      }
    }
  }
}

function report(problems) {
  console.error('\nFound', problems.length, 'duplicate id attribute occurrence(s):\n');
  for (const p of problems) {
    console.error(rel(p.file) + ':' + p.line + '  duplicate id="' + p.id + '" (first seen at line ' + p.firstLine + ') -> ' + p.preview);
    console.error('-----');
  }
}

function main() {
  if (!fs.existsSync(SITE_DIR)) {
    console.error('check-duplicate-ids: site/ directory not found at ' + SITE_DIR);
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

  console.log('check-duplicate-ids: ok — no duplicate id attributes found in scanned HTML pages under site/. Scanned', files.length, 'file(s).');
  process.exitCode = 0;
}

if (require.main === module) main();
