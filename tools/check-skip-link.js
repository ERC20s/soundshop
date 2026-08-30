#!/usr/bin/env node
'use strict';
/*
 * tools/check-skip-link.js — fail when an HTML page under site/ does not
 * include an accessible skip link: an <a> element with class="skip-link"
 * and href="#main" before </body>. Zero-dependency Node 18+ script.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

const ANCHOR_TAG_RE = /<a\b[^>]*>/gi;
const HREF_RE = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const CLASS_RE = /class\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const OPT_OUT_RE = /<!--\s*no-skip-link-check\s*-->/i;

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

function stripQueryAndHash(target) {
  return target.replace(/[?#].*$/, '');
}

function cleanTarget(target) {
  if (!target) return '';
  let t = target.trim();
  try { t = decodeURIComponent(t); } catch (e) { /* ignore */ }
  return stripQueryAndHash(t);
}

function findSkipLinkBeforeIndex(text, cutoffIndex) {
  ANCHOR_TAG_RE.lastIndex = 0;
  let m;
  while ((m = ANCHOR_TAG_RE.exec(text)) !== null) {
    const tagStart = m.index;
    if (tagStart >= cutoffIndex) break;
    const tag = m[0];
    const hrefMatch = HREF_RE.exec(tag);
    const classMatch = CLASS_RE.exec(tag);
    if (!hrefMatch || !classMatch) continue;
    const href = hrefMatch[1] !== undefined ? hrefMatch[1] : hrefMatch[2];
    const classVal = classMatch[1] !== undefined ? classMatch[1] : classMatch[2];
    if (!href || !classVal) continue;
    const clean = cleanTarget(href);
    if (clean === '#main' && /\bskip-link\b/i.test(classVal)) return { ok: true, index: tagStart };
  }
  return { ok: false };
}

function main() {
  if (!fs.existsSync(SITE_DIR)) {
    console.error('check-skip-link: site/ directory not found at ' + SITE_DIR);
    process.exit(2);
  }

  const files = walk(SITE_DIR).sort();
  const missing = [];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');

    if (OPT_OUT_RE.test(text)) continue;

    const bodyMatch = /<\/body\s*>/i.exec(text);
    const cutoff = bodyMatch ? bodyMatch.index : text.length;

    const found = findSkipLinkBeforeIndex(text, cutoff);
    if (!found.ok) {
      const line = lineOf(text, cutoff);
      missing.push({ file, line });
    }
  }

  if (missing.length > 0) {
    for (const m of missing) {
      console.error(rel(m.file) + ':' + m.line + '  missing skip link (anchor.a.skip-link href="#main")');
    }
    console.error('\ncheck-skip-link: ' + missing.length + ' missing skip link(s) in ' + files.length + ' html file(s) scanned');
    process.exit(1);
  }

  console.log('check-skip-link: ok — all scanned HTML pages include an <a class="skip-link" href="#main"> before </body> (or opt-out comment present)');
  process.exit(0);
}

if (require.main === module) main();
