#!/usr/bin/env node
'use strict';
/*
 * tools/check-json.js — validate JSON files under site/ and data/
 *
 * Usage: node tools/check-json.js
 * Needs: Node 18 or newer. No npm packages.
 *
 * Behavior:
 *  - attempt to read site/ and data/ (each is optional; missing directories are skipped);
 *  - recursively find *.json files under each directory;
 *  - for each file: read as UTF-8 and JSON.parse it; on parse error print file path,
 *    the parser error message and a short snippet around the error position where available,
 *    then exit with code 1; if all parsed, print a one-line summary and exit 0.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');
const DATA_DIR = path.join(REPO_ROOT, 'data');

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/') || '.';
}

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

function snippetAround(text, pos, ctx = 80) {
  if (typeof pos !== 'number' || pos < 0 || pos > text.length) {
    // return first line or a short prefix
    const first = text.split(/\r?\n/)[0];
    return first.length > 200 ? first.slice(0, 200) + '…' : first;
  }
  const start = Math.max(0, pos - ctx);
  const end = Math.min(text.length, pos + ctx);
  const before = text.slice(start, pos);
  const after = text.slice(pos, end);
  const excerpt = (start > 0 ? '…' : '') + before + after + (end < text.length ? '…' : '');
  // compute line and column for caret
  const pre = text.slice(0, pos);
  const lineNumber = pre.split(/\r?\n/).length;
  const lineStart = pre.lastIndexOf('\n') + 1;
  const col = pos - lineStart + 1;
  const line = text.slice(lineStart, text.indexOf('\n', lineStart) === -1 ? text.length : text.indexOf('\n', lineStart));
  const marker = '\n' + ' '.repeat(Math.max(0, Math.min(200, col - (start > lineStart ? start - lineStart : 0) - 1))) + '^';
  return { excerpt, lineNumber, col, line, marker };
}

function extractPositionFromError(e) {
  if (!e || !e.message) return null;
  // try several patterns seen in various Node/V8 messages
  let m = e.message.match(/at position (\d+)/i) || e.message.match(/position (\d+)/i) || e.message.match(/char (\d+)/i);
  if (m) return Number(m[1]);
  // some engines report 'in JSON at line X column Y' — try to extract
  m = e.message.match(/at line (\d+) column (\d+)/i) || e.message.match(/line (\d+) column (\d+)/i);
  if (m) {
    const line = Number(m[1]);
    const col = Number(m[2]);
    return { line, col };
  }
  return null;
}

function lineColFromPos(text, pos) {
  let line = 1, col = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === '\n') { line++; col = 1; } else col++;
  }
  return { line, col };
}

function main() {
  const dirs = [SITE_DIR, DATA_DIR];
  const present = dirs.filter(d => fs.existsSync(d));
  if (present.length === 0) {
    console.log('check-json: no site/ or data/ directory found; nothing to scan.');
    process.exitCode = 0;
    return;
  }

  const files = [];
  for (const d of dirs) walkJson(d, files);
  files.sort();

  let bad = 0;

  for (const file of files) {
    const relpath = rel(file);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      console.error('check-json: failed to read', relpath, e && e.message);
      bad++;
      continue;
    }
    try {
      JSON.parse(text);
    } catch (e) {
      console.error('\ncheck-json: JSON parse error in', relpath + ':');
      console.error('  ' + (e && e.message ? e.message : String(e)));

      // attempt to find position
      const posInfo = extractPositionFromError(e);
      if (typeof posInfo === 'number') {
        const pos = posInfo;
        const lc = lineColFromPos(text, pos);
        const sn = snippetAround(text, pos, 80);
        if (sn && typeof sn === 'object') {
          console.error('  at line ' + lc.line + ' column ' + lc.col + ':');
          console.error('  ' + sn.line.replace(/\t/g, ' '));
          // build a caret line under the snippet's column (approximate)
          let caretCol = lc.col;
          // if snippet starts not at line start, adjust
          const snippetStart = Math.max(0, pos - 80);
          const snippetLineStart = text.slice(0, pos).lastIndexOf('\n') + 1;
          const caretOffset = pos - snippetLineStart;
          const pad = ' '.repeat(Math.max(0, caretOffset));
          console.error('  ' + pad + '^');
        } else if (typeof sn === 'string') {
          console.error('  ' + sn);
        }
      } else if (posInfo && posInfo.line && posInfo.col) {
        console.error('  at line ' + posInfo.line + ' column ' + posInfo.col);
      } else {
        // fallback: print first 300 chars
        const prefix = text.slice(0, 300).replace(/\n/g, '\\n');
        console.error('  (no position available) file starts: ' + (prefix.length ? prefix : '(empty)'));
      }

      bad++;
      // continue to report other files rather than exit immediately
    }
  }

  if (bad) {
    console.error('\ncheck-json: ' + bad + ' file(s) failed to parse.');
    process.exitCode = 1;
    return;
  }

  console.log('check-json: all JSON parsed OK. Scanned ' + files.length + ' file(s).');
  process.exitCode = 0;
}

main();
