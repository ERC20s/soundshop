#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/');
}

function walkJs(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walkJs(full, out);
    else if (/\.js$/i.test(name)) out.push(full);
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function previewLines(text, lineNum, ctx = 3) {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, lineNum - 1 - ctx);
  const end = Math.min(lines.length, lineNum - 1 + ctx + 1);
  return lines.slice(start, end).map((l, i) => {
    const n = start + i + 1;
    const mark = n === lineNum ? '>' : ' ';
    return `${mark} ${String(n).padStart(4)} | ${l}`;
  }).join('\n');
}

function extractLineFromStack(err) {
  if (!err || !err.stack) return 1;
  // Try to find <anonymous>:<line>:<col>
  const m = err.stack.match(/<anonymous>:(\d+):(\d+)/);
  if (m) return Number(m[1]);
  // Fallback: look for :<line>:<col> towards the end
  const m2 = err.stack.match(/:(\d+):(\d+)\)?\s*$/);
  if (m2) return Number(m2[1]);
  return 1;
}

function containsModuleKeyword(text) {
  // crude detection of top-level import/export occurrences
  // matches an 'import' or 'export' at line start or after a newline with optional whitespace
  const re = /(^|\n)\s*(import|export)\b/gi;
  return re.exec(text);
}

function previewText(s, maxChars = 320) {
  const trimmed = String(s).trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars) + '\n...';
}

function main() {
  if (!fs.existsSync(SITE_DIR)) {
    console.error('check-js-syntax: site/ directory not found at ' + SITE_DIR);
    process.exit(2);
  }

  const files = walkJs(SITE_DIR).sort();
  if (!files.length) {
    console.log('No JavaScript files found under site/.');
    process.exitCode = 0;
    return;
  }

  const problems = [];
  let checked = 0;

  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      console.error('Failed to read', file, e && e.message);
      continue;
    }

    // detect module keywords first
    const modMatch = containsModuleKeyword(text);
    if (modMatch) {
      const index = modMatch.index + (modMatch[1] ? modMatch[1].length : 0);
      const ln = lineOf(text, index);
      problems.push({ file, line: ln, type: 'module', message: "Top-level 'import' or 'export' detected", preview: previewLines(text, ln, 3) });
      continue; // do not attempt to parse as script if it looks like a module
    }

    // attempt to parse via new Function to detect syntax errors without executing
    checked++;
    try {
      /* eslint-disable no-new-func */
      new Function(text);
    } catch (err) {
      // try to extract a line number from the error stack; fall back to 1
      const errLine = extractLineFromStack(err);
      const preview = previewLines(text, errLine, 3);
      problems.push({ file, line: errLine, type: 'syntax', message: err && err.message, preview });
    }
  }

  if (problems.length) {
    console.error('\ncheck-js-syntax: found ' + problems.length + ' problem(s):\n');
    for (const p of problems) {
      console.error(rel(p.file) + ':' + p.line + '  [' + p.type + '] ' + p.message + '\n');
      console.error(p.preview);
      console.error('-----\n');
    }
    console.error('Scanned', files.length, 'JS file(s). Parsed', checked, 'as scripts.');
    process.exitCode = 1;
    return;
  }

  console.log('All site JS files parsed OK. Scanned', files.length + ' file(s), parsed', checked + ' as scripts.');
  process.exitCode = 0;
}

main();
