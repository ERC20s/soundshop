#!/usr/bin/env node
'use strict';

// tools/check-innerhtml.js — fail if any site-facing .innerHTML assignment uses
// a non-literal RHS. Zero-dependency Node 18+ script.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

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

function findClosingQuote(text, startIdx, quoteChar) {
  // startIdx points at the opening quote
  let i = startIdx + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2; // skip escaped char
      continue;
    }
    if (ch === quoteChar) return i;
    i++;
  }
  return -1;
}

function findClosingBacktick(text, startIdx) {
  // handle template literal; need to skip escaped backticks and ${ ... } sections
  let i = startIdx + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') return i;
    if (ch === '$' && text[i+1] === '{') {
      // skip balanced braces until matching }
      i += 2; // now inside expression
      let depth = 1;
      while (i < text.length && depth > 0) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return -1;
}

function classifyAssignment(text, assignIndex) {
  // assignIndex is index right after the operator (=, +=, etc.)
  // return { kind: 'literal'|'non-literal'|'unknown', preview, line }
  // skip whitespace
  let i = assignIndex;
  while (i < text.length && /[\s]/.test(text[i])) i++;
  if (i >= text.length) return { kind: 'unknown', reason: 'no RHS', idx: i };
  const ch = text[i];

  // If RHS starts with quote
  if (ch === '\'' || ch === '"') {
    const close = findClosingQuote(text, i, ch);
    if (close === -1) return { kind: 'unknown', reason: 'unterminated string', idx: i };
    // check what comes after the string (only whitespace and semicolon/paren/comma/end allowed for a pure literal)
    let j = close + 1;
    while (j < text.length && /[\s]/.test(text[j])) j++;
    const next = text[j] || '';
    const allowed = ['', ';', ')', '}', ',', '/'];
    if (next === '' || allowed.includes(next)) {
      return { kind: 'literal', end: close + 1, idx: i };
    }
    // if next is + (concatenation) or others, treat as non-literal
    return { kind: 'non-literal', reason: 'string concatenation or extra tokens after literal', idx: i };
  }

  if (ch === '`') {
    const close = findClosingBacktick(text, i);
    if (close === -1) return { kind: 'unknown', reason: 'unterminated template', idx: i };
    const template = text.slice(i, close + 1);
    if (template.indexOf('${') !== -1) {
      return { kind: 'non-literal', reason: 'template contains interpolation', idx: i };
    }
    // check trailing char like above
    let j = close + 1;
    while (j < text.length && /[\s]/.test(text[j])) j++;
    const next = text[j] || '';
    const allowed = ['', ';', ')', '}', ',', '/'];
    if (next === '' || allowed.includes(next)) {
      return { kind: 'literal', end: close + 1, idx: i };
    }
    return { kind: 'non-literal', reason: 'template followed by extra tokens', idx: i };
  }

  // If RHS starts with an opening parenthesis but immediately followed by a string: e.g. = ('<svg>')
  if (ch === '(') {
    // look ahead for first non-space after '('
    let j = i + 1;
    while (j < text.length && /[\s]/.test(text[j])) j++;
    if (text[j] === '\'' || text[j] === '"' || text[j] === '`') {
      // classify based on that
      return classifyAssignment(text, j);
    }
  }

  // Anything else: non-literal
  return { kind: 'non-literal', reason: 'RHS not a string/template literal', idx: i };
}

function collectFromFile(file, text, results) {
  const re = /\.innerHTML\b\s*([+\-*/]?=)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const op = m[1];
    const assignOpIdx = m.index + m[0].lastIndexOf(op);
    const afterOpIdx = assignOpIdx + op.length;
    const cls = classifyAssignment(text, afterOpIdx);
    const line = lineOf(text, m.index);
    const preview = previewLine(text, line);
    results.push({ file, index: m.index, line, preview, op, classification: cls });
  }
}

function report(results) {
  if (!results.length) {
    console.log('No .innerHTML assignments found under site/.');
    return;
  }
  console.error('\nFound ' + results.length + ' .innerHTML assignment(s):\n');
  for (const r of results) {
    const fileRel = rel(r.file);
    const kind = r.classification.kind || 'unknown';
    const reason = r.classification.reason ? ' (' + r.classification.reason + ')' : '';
    console.error(fileRel + ':' + r.line + '  ' + kind + reason + '  op=' + r.op);
    console.error('  ' + r.preview);
    console.error('-----');
  }
}

function main() {
  if (!fs.existsSync(SITE_DIR)) {
    console.error('site/ directory not found at', SITE_DIR);
    process.exit(2);
  }

  const files = walk(SITE_DIR).sort();
  const results = [];

  for (const file of files) {
    let txt;
    try { txt = fs.readFileSync(file, 'utf8'); } catch (err) {
      console.error('Failed to read', file, err && err.message);
      process.exit(2);
    }
    collectFromFile(file, txt, results);
  }

  if (!results.length) {
    console.log('No .innerHTML assignments found under site/. Scanned', files.length, 'file(s).');
    process.exitCode = 0;
    return;
  }

  report(results);

  // If any non-literal classification exists -> fail
  const nonLiteral = results.some(r => r.classification && r.classification.kind === 'non-literal');
  const unknown = results.some(r => !r.classification || r.classification.kind === 'unknown');
  if (nonLiteral || unknown) {
    console.error('\nScanned', files.length, 'file(s) under site/.');
    if (nonLiteral) console.error('One or more .innerHTML assignments use a non-literal RHS and should be reviewed.');
    if (unknown) console.error('One or more .innerHTML assignments could not be classified; please review.');
    process.exitCode = 1;
    return;
  }

  console.log('All .innerHTML assignments under site/ are literal string or template literals without interpolation. Scanned', files.length, 'file(s).');
  process.exitCode = 0;
}

main();
