#!/usr/bin/env node
'use strict';
/*
 * tools/check-page-metadata.js — fail when an HTML page under site/ has no
 * non-empty <title> or no <meta name="description" content="..."> tag in
 * its <head>. Zero-dependency Node 18+ script.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

const OPT_OUT_RE = /<!--\s*no-page-metadata-check\s*-->/i;
const HEAD_OPEN_RE = /<head\b[^>]*>/i;
const HEAD_CLOSE_RE = /<\/head\s*>/i;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
const META_DESC_TAG_RE = /<meta\b[^>]*name\s*=\s*(?:"description"|'description')[^>]*>/i;
const CONTENT_ATTR_RE = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

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

function main() {
  if (!fs.existsSync(SITE_DIR)) {
    console.error('check-page-metadata: site/ directory not found at ' + SITE_DIR);
    process.exit(2);
  }

  const files = walk(SITE_DIR).sort();
  const problems = [];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');

    if (OPT_OUT_RE.test(text)) continue;

    const headOpen = HEAD_OPEN_RE.exec(text);
    const headClose = HEAD_CLOSE_RE.exec(text);

    // Determine line to report: end of </head> if present, else start of file
    const headEndIndex = headClose ? (headClose.index + headClose[0].length) : 0;
    const headStartIndex = headOpen ? headOpen.index + headOpen[0].length : -1;

    // If no head section, still check whole file for title/meta but report at file start as required
    const headContent = (headOpen && headClose && headClose.index > headOpen.index)
      ? text.slice(headStartIndex, headClose.index)
      : (headOpen && !headClose ? text.slice(headStartIndex) : '');

    // If there is no headContent (no head tags), we will treat as missing and report accordingly

    // Check title inside headContent
    let titleMatch = null;
    if (headContent) titleMatch = TITLE_RE.exec(headContent);
    else {
      // As a last resort, check the whole document for a title tag so we can still detect it
      titleMatch = TITLE_RE.exec(text);
    }

    if (!titleMatch) {
      problems.push({ file, line: lineOf(text, headEndIndex), msg: 'missing <title> element in <head>' });
    } else {
      const titleText = (titleMatch[1] || '').trim();
      if (!titleText) {
        problems.push({ file, line: lineOf(text, headEndIndex), msg: 'empty <title> text' });
      }
    }

    // Check meta description inside headContent
    let metaMatch = null;
    if (headContent) metaMatch = META_DESC_TAG_RE.exec(headContent);
    else metaMatch = META_DESC_TAG_RE.exec(text);

    if (!metaMatch) {
      problems.push({ file, line: lineOf(text, headEndIndex), msg: 'missing <meta name="description"> in <head>' });
    } else {
      const tag = metaMatch[0];
      const contentMatch = CONTENT_ATTR_RE.exec(tag);
      const content = contentMatch ? (contentMatch[1] !== undefined ? contentMatch[1] : contentMatch[2]) : '';
      if (!content || !content.trim()) {
        problems.push({ file, line: lineOf(text, headEndIndex), msg: 'empty <meta name="description"> content' });
      }
    }
  }

  if (problems.length > 0) {
    for (const p of problems) {
      console.error(rel(p.file) + ':' + p.line + '  ' + p.msg);
    }
    console.error('\ncheck-page-metadata: ' + problems.length + ' issue(s) found in ' + files.length + ' HTML file(s) scanned');
    process.exit(1);
  }

  console.log('check-page-metadata: ok — all scanned HTML pages include a non-empty <title> and <meta name="description"> in their <head>');
  process.exit(0);
}

if (require.main === module) main();
