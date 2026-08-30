#!/usr/bin/env node
'use strict';
/*
 * tools/check-charset.js — fail when an HTML page under site/ does not
 * include a UTF-8 charset declaration (either <meta charset="utf-8"> or
 * <meta http-equiv="Content-Type" content="...; charset=utf-8">).
 * Zero-dependency Node 18+ script.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

const OPT_OUT_RE = /<!--\s*no-charset-check\s*-->/i;
const HEAD_OPEN_RE = /<head\b[^>]*>/i;
const HEAD_CLOSE_RE = /<\/head\s*>/i;
const META_CHARSET_RE = /<meta\b[^>]*charset\s*=\s*['"]*utf-?8['"]*[^>]*>/i;
const META_HTTP_EQUIV_RE = /<meta\b[^>]*http-equiv\s*=\s*['"]*content-type['"]*[^>]*>/i;
const CONTENT_CHARSET_RE = /charset\s*=\s*utf-?8/i;

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

function hasUtf8Charset(text) {
  // Extract head section
  const headOpen = HEAD_OPEN_RE.exec(text);
  const headClose = HEAD_CLOSE_RE.exec(text);

  let headContent = '';
  if (headOpen && headClose && headClose.index > headOpen.index) {
    const headStartIndex = headOpen.index + headOpen[0].length;
    headContent = text.slice(headStartIndex, headClose.index);
  } else if (headOpen) {
    const headStartIndex = headOpen.index + headOpen[0].length;
    headContent = text.slice(headStartIndex);
  }

  // Check for <meta charset="utf-8">
  if (META_CHARSET_RE.test(headContent)) {
    return true;
  }

  // Check for <meta http-equiv="Content-Type" content="...; charset=utf-8">
  const httpEquivMatch = META_HTTP_EQUIV_RE.exec(headContent);
  if (httpEquivMatch && CONTENT_CHARSET_RE.test(httpEquivMatch[0])) {
    return true;
  }

  return false;
}

function main() {
  if (!fs.existsSync(SITE_DIR)) {
    console.error('check-charset: site/ directory not found at ' + SITE_DIR);
    process.exit(2);
  }

  const files = walk(SITE_DIR).sort();
  const problems = [];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');

    if (OPT_OUT_RE.test(text)) continue;

    if (!hasUtf8Charset(text)) {
      const headClose = HEAD_CLOSE_RE.exec(text);
      const headEndIndex = headClose ? (headClose.index + headClose[0].length) : 0;
      const line = lineOf(text, headEndIndex);
      problems.push({ file, line, msg: 'missing UTF-8 charset declaration in <head>' });
    }
  }

  if (problems.length > 0) {
    for (const p of problems) {
      console.error(rel(p.file) + ':' + p.line + '  ' + p.msg);
    }
    console.error('\ncheck-charset: ' + problems.length + ' issue(s) found in ' + files.length + ' HTML file(s) scanned');
    process.exit(1);
  }

  console.log('check-charset: ok — all scanned HTML pages include a UTF-8 charset declaration in <head>');
  process.exit(0);
}

if (require.main === module) main();
