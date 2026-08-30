#!/usr/bin/env node
'use strict';
/*
 * tools/check-required-assets.js — fail when an HTML page under site/ does not
 * include the shared stylesheet (assets/style.css) and the shared UI script
 * (assets/js/ui.js) before </body>. Zero-dependency Node 18+ script.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

const LINK_TAG_RE = /<link\b[^>]*>/gi;
const SCRIPT_TAG_RE = /<script\b[^>]*>/gi;
const HREF_RE = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const SRC_RE = /src\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const REL_RE = /rel\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const OPT_OUT_RE = /<!--\s*no-required-assets-check\s*-->/i;

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

function endsWithAsset(target, suffix) {
  const c = cleanTarget(target);
  if (!c) return false;
  // Normalize path separators and allow any leading ../ or similar
  return c.replace(/^\.*\/+/, '').endsWith(suffix);
}

function findLinkStylesheetBeforeIndex(text, cutoffIndex) {
  LINK_TAG_RE.lastIndex = 0;
  let m;
  while ((m = LINK_TAG_RE.exec(text)) !== null) {
    const tagStart = m.index;
    if (tagStart >= cutoffIndex) break;
    const tag = m[0];
    const hrefMatch = HREF_RE.exec(tag);
    if (!hrefMatch) continue;
    const href = hrefMatch[1] !== undefined ? hrefMatch[1] : hrefMatch[2];
    if (!href) continue;
    const relMatch = REL_RE.exec(tag);
    const relVal = relMatch ? (relMatch[1] !== undefined ? relMatch[1] : relMatch[2]) : '';
    if (!/stylesheet/i.test(relVal)) continue;
    if (endsWithAsset(href, 'assets/style.css')) return { ok: true, index: tagStart };
  }
  return { ok: false };
}

function findUiScriptBeforeIndex(text, cutoffIndex) {
  SCRIPT_TAG_RE.lastIndex = 0;
  let m;
  while ((m = SCRIPT_TAG_RE.exec(text)) !== null) {
    const tagStart = m.index;
    if (tagStart >= cutoffIndex) break;
    const tag = m[0];
    const srcMatch = SRC_RE.exec(tag);
    if (!srcMatch) continue;
    const src = srcMatch[1] !== undefined ? srcMatch[1] : srcMatch[2];
    if (!src) continue;
    if (endsWithAsset(src, 'assets/js/ui.js')) return { ok: true, index: tagStart };
  }
  return { ok: false };
}

function main() {
  if (!fs.existsSync(SITE_DIR)) {
    console.error('check-required-assets: site/ directory not found at ' + SITE_DIR);
    process.exit(2);
  }

  const files = walk(SITE_DIR).sort();
  const missing = [];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');

    if (OPT_OUT_RE.test(text)) continue;

    // Find where </body> is; require assets to appear before it. If missing,
    // treat the end of file as the cutoff so pages without </body> still get
    // diagnosed near EOF.
    const bodyMatch = /<\/body\s*>/i.exec(text);
    const cutoff = bodyMatch ? bodyMatch.index : text.length;

    const styleFound = findLinkStylesheetBeforeIndex(text, cutoff);
    const uiFound = findUiScriptBeforeIndex(text, cutoff);

    if (!styleFound.ok) {
      const line = lineOf(text, cutoff);
      missing.push({ file, line, which: 'assets/style.css' });
    }
    if (!uiFound.ok) {
      const line = lineOf(text, cutoff);
      missing.push({ file, line, which: 'assets/js/ui.js' });
    }
  }

  if (missing.length > 0) {
    for (const m of missing) {
      console.error(rel(m.file) + ':' + m.line + '  missing ' + m.which);
    }
    console.error('\ncheck-required-assets: ' + missing.length + ' missing required asset(s) in ' + files.length + ' html file(s) scanned');
    process.exit(1);
  }

  console.log('check-required-assets: ok — all scanned HTML pages include assets/style.css and assets/js/ui.js before </body>');
  process.exit(0);
}

if (require.main === module) main();
