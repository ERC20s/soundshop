#!/usr/bin/env node
'use strict';

// tools/check-innerhtml-safety.js — scan literal HTML inserted into the DOM and
// reject obviously executable or remote content (script, iframe, on* handlers,
// javascript: URLs, etc.). Zero-dependency Node 18+ script.

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

function rel(p) { return path.relative(REPO_ROOT, p).split(path.sep).join('/'); }

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
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
  let i = startIdx + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === quoteChar) return i;
    i++;
  }
  return -1;
}

function findClosingBacktick(text, startIdx) {
  let i = startIdx + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') return i;
    if (ch === '$' && text[i+1] === '{') {
      i += 2;
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

function unescapeString(lit, quote) {
  // lit includes surrounding quotes (`'"` or `\``). Return interpreted content
  if (!lit || lit.length < 2) return '';
  const q = lit[0];
  let body = lit.slice(1, lit.length - 1);
  // For template-like backtick without interpolation we still unescape common sequences
  // Replace simple escape sequences
  return body.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|u\{[0-9A-Fa-f]+\}|n|r|t|b|f|v|\\|0|'|"|`)/g, (m, g1) => {
    if (!g1) return '';
    if (g1 === 'n') return '\n';
    if (g1 === 'r') return '\r';
    if (g1 === 't') return '\t';
    if (g1 === 'b') return '\b';
    if (g1 === 'f') return '\f';
    if (g1 === 'v') return '\v';
    if (g1 === '\\') return '\\';
    if (g1 === "'") return "'";
    if (g1 === '"') return '"';
    if (g1 === '`') return '`';
    if (g1 === '0') return '\0';
    if (/^x[0-9A-Fa-f]{2}$/.test(g1)) return String.fromCharCode(parseInt(g1.slice(1), 16));
    if (/^u[0-9A-Fa-f]{4}$/.test(g1)) return String.fromCharCode(parseInt(g1.slice(1), 16));
    // fallback: remove braces and parse
    if (/^u\{[0-9A-Fa-f]+\}$/.test(g1)) {
      return String.fromCodePoint(parseInt(g1.slice(2, -1), 16));
    }
    return '';
  });
}

function classifyAssignment(text, assignIndex) {
  let i = assignIndex;
  while (i < text.length && /[\s]/.test(text[i])) i++;
  if (i >= text.length) return { kind: 'unknown', reason: 'no RHS', idx: i };
  const ch = text[i];
  if (ch === '\'' || ch === '"') {
    const close = findClosingQuote(text, i, ch);
    if (close === -1) return { kind: 'unknown', reason: 'unterminated string', idx: i };
    let j = close + 1;
    while (j < text.length && /[\s]/.test(text[j])) j++;
    const next = text[j] || '';
    const allowed = ['', ';', ')', '}', ',', '/'];
    if (next === '' || allowed.includes(next)) {
      return { kind: 'literal', start: i, end: close + 1, idx: i };
    }
    return { kind: 'non-literal', reason: 'string concatenation or extra tokens after literal', idx: i };
  }
  if (ch === '`') {
    const close = findClosingBacktick(text, i);
    if (close === -1) return { kind: 'unknown', reason: 'unterminated template', idx: i };
    const template = text.slice(i, close + 1);
    if (template.indexOf('${') !== -1) return { kind: 'non-literal', reason: 'template contains interpolation', idx: i };
    let j = close + 1;
    while (j < text.length && /[\s]/.test(text[j])) j++;
    const next = text[j] || '';
    const allowed = ['', ';', ')', '}', ',', '/'];
    if (next === '' || allowed.includes(next)) {
      return { kind: 'literal', start: i, end: close + 1, idx: i };
    }
    return { kind: 'non-literal', reason: 'template followed by extra tokens', idx: i };
  }
  if (ch === '(') {
    let j = i + 1;
    while (j < text.length && /[\s]/.test(text[j])) j++;
    if (text[j] === '\'' || text[j] === '"' || text[j] === '`') return classifyAssignment(text, j);
  }
  return { kind: 'non-literal', reason: 'RHS not a string/template literal', idx: i };
}

function parseArguments(text, startParenIdx) {
  const args = [];
  let i = startParenIdx + 1;
  let curStart = i;
  let depth = 0;
  let inQuote = null;
  while (i < text.length) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inQuote) inQuote = null;
      i++; continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { inQuote = ch; i++; continue; }
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') {
      if (depth === 0) {
        // push last argument
        const argText = text.slice(curStart, i).trim();
        if (argText.length) args.push({ start: curStart, end: i, text: argText });
        return args;
      }
      depth--; i++; continue;
    }
    if (ch === ',' && depth === 0) {
      const argText = text.slice(curStart, i).trim();
      args.push({ start: curStart, end: i, text: argText });
      curStart = i + 1;
      i++; continue;
    }
    if (ch === '\\') { i += 2; continue; }
    i++;
  }
  return args; // unterminated, but return what we have
}

const unsafePatterns = [
  { re: /<script\b/i, name: '<script>' },
  { re: /<iframe\b/i, name: '<iframe>' },
  { re: /\bon[a-z]+\s*=\s*/i, name: 'inline event handler (on*)' },
  { re: /javascript\s*:/i, name: 'javascript: URL' },
];

function scanLiteralForUnsafe(content) {
  for (const p of unsafePatterns) {
    if (p.re.test(content)) return p.name;
  }
  return null;
}

function collectFromFile(file, text, results) {
  // innerHTML and outerHTML assignments
  const assignRe = /\.(innerHTML|outerHTML)\b\s*([+\-*/]?=)/g;
  let m;
  while ((m = assignRe.exec(text)) !== null) {
    const prop = m[1];
    const op = m[2];
    const assignOpIdx = m.index + m[0].lastIndexOf(op);
    const afterOpIdx = assignOpIdx + op.length;
    const cls = classifyAssignment(text, afterOpIdx);
    if (cls.kind === 'literal') {
      const lit = text.slice(cls.start, cls.end);
      const content = unescapeString(lit);
      const why = scanLiteralForUnsafe(content);
      if (why) {
        const line = lineOf(text, m.index);
        const preview = previewLine(text, line);
        results.push({ file, line, preview, prop, kind: 'literal-unsafe', why });
      }
    }
  }

  // insertAdjacentHTML calls - check the second argument
  const insRe = /\.insertAdjacentHTML\s*\(/g;
  while ((m = insRe.exec(text)) !== null) {
    const parenIdx = m.index + m[0].lastIndexOf('(');
    const args = parseArguments(text, parenIdx);
    if (args && args.length >= 2) {
      const second = args[1];
      // classify second arg: if it's a literal string/template without interpolation
      const trimmed = second.text;
      const firstChar = trimmed[0];
      if (firstChar === '"' || firstChar === '\'' || firstChar === '`') {
        const litStart = second.start + trimmed.search(/\S/);
        const cls = classifyAssignment(text, litStart);
        if (cls.kind === 'literal') {
          const lit = text.slice(cls.start, cls.end);
          const content = unescapeString(lit);
          const why = scanLiteralForUnsafe(content);
          if (why) {
            const line = lineOf(text, m.index);
            const preview = previewLine(text, line);
            results.push({ file, line, preview, prop: 'insertAdjacentHTML', kind: 'literal-unsafe', why });
          }
        }
      }
    }
  }
}

function report(results, scanned) {
  if (!results.length) {
    console.log('No unsafe literal HTML found in site/ (checked innerHTML, outerHTML and insertAdjacentHTML). Scanned', scanned, 'file(s).');
    return;
  }
  console.error('\nFound ' + results.length + ' unsafe literal HTML insertion(s):\n');
  for (const r of results) {
    const fileRel = rel(r.file);
    console.error(fileRel + ':' + r.line + '  ' + r.prop + '  ' + r.kind + '  reason=' + r.why);
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

  report(results, files.length);

  if (results.length) {
    console.error('\nOne or more literal HTML insertions contain executable or remote content and should be reviewed.');
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

main();
