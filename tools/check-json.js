#!/usr/bin/env node
'use strict';
/*
 * tools/check-json.js — validate every .json file under site/ and data/
 *
 * Usage: node tools/check-json.js
 * Needs: Node 18 or newer. No npm packages.
 *
 * Behaviour:
 *  - Walks site/ recursively and data/ at repo root (if present), collecting files
 *    ending in .json (case-insensitive).
 *  - For each file, reads it and runs JSON.parse; on success records it;
 *    on parse failure prints the file path, error.message and a short snippet
 *    around the reported position (if available).
 *  - Exits with code 0 if all files parse, otherwise exits 1 and prints a summary.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');
const DATA_DIR = path.join(REPO_ROOT, 'data');

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/');
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

function lineColOf(text, index) {
  if (index < 0) return { line: 1, col: 1 };
  let line = 1, col = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') { line++; col = 1; } else { col++; }
  }
  return { line, col };
}

function snippetAround(text, index, contextLines = 2) {
  const lines = text.split(/\n/);
  // compute line/col based on index
  let acc = 0, lineIdx = 0;
  for (; lineIdx < lines.length; lineIdx++) {
    const l = lines[lineIdx];
    if (acc + l.length >= index) break;
    acc += l.length + 1; // +1 for newline
  }
  const col = index - acc + 1;
  const startLine = Math.max(0, lineIdx - contextLines);
  const endLine = Math.min(lines.length - 1, lineIdx + contextLines);
  const out = [];
  for (let i = startLine; i <= endLine; i++) {
    const num = (i + 1) + '';
    out.push((' ' + num).slice(-4) + ' | ' + lines[i]);
    if (i === lineIdx) out.push('     ' + ' '.repeat(Math.max(0, col - 1)) + '^');
  }
  return out.join('\n');
}

function extractPositionFromError(err) {
  if (!err || !err.message) return -1;
  const m1 = /position\s+(\d+)/i.exec(err.message);
  if (m1) return Number(m1[1]);
  const m2 = /at\s+char\s+(\d+)/i.exec(err.message);
  if (m2) return Number(m2[1]);
  // V8 sometimes uses 'line X column Y' — try to parse that
  const m3 = /line\s+(\d+)\s+column\s+(\d+)/i.exec(err.message);
  if (m3) {
    const line = Number(m3[1]);
    const col = Number(m3[2]);
    // convert to zero-based index by walking lines — but we don't have the text here.
    return { line, col };
  }
  return -1;
}

function main() {
  if (!fs.existsSync(SITE_DIR)) {
    console.error('check-json: site/ directory not found at ' + SITE_DIR);
    process.exit(2);
  }

  const files = walkJson(SITE_DIR, []).concat(walkJson(DATA_DIR, []));
  files.sort();
  let errors = 0;

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      console.error('Failed to read ' + rel(file) + ': ' + e.message);
      errors++;
      continue;
    }

    try {
      JSON.parse(text);
    } catch (err) {
      errors++;
      // Try to get a numeric index
      const pos = extractPositionFromError(err);
      console.error('\n' + rel(file) + ': parse error — ' + err.message);
      if (typeof pos === 'number' && pos >= 0) {
        // pos might be a char index
        try {
          const snip = snippetAround(text, pos);
          console.error('\n' + snip + '\n');
        } catch (e) {
          // ignore snippet failures
        }
      } else if (pos && typeof pos === 'object' && pos.line) {
        // we got a line/col pair; build a simple snippet
        const lines = text.split(/\n/);
        const li = Math.max(0, Math.min(lines.length - 1, pos.line - 1));
        const col = Math.max(1, pos.col || 1);
        const snipLines = [];
        const start = Math.max(0, li - 1);
        const end = Math.min(lines.length - 1, li + 1);
        for (let i = start; i <= end; i++) {
          const num = (i + 1) + '';
          snipLines.push((' ' + num).slice(-4) + ' | ' + lines[i]);
          if (i === li) snipLines.push('     ' + ' '.repeat(Math.max(0, col - 1)) + '^');
        }
        console.error('\n' + snipLines.join('\n') + '\n');
      } else {
        // No position info available; print first line as context
        const first = text.split(/\n/)[0];
        console.error('\n    (no position info) ' + String(first).slice(0, 200) + '\n');
      }
    }
  }

  if (errors) {
    console.error('check-json: ' + files.length + ' JSON file(s) scanned. ' + errors + ' error(s) found.');
    process.exitCode = 1;
    return;
  }

  console.log('check-json: all JSON parsed OK. Scanned ' + files.length + ' file(s).');
  process.exitCode = 0;
}

main();
