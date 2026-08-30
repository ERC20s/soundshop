#!/usr/bin/env node
'use strict';
/*
 * tools/check-purchase-listener.js — fail when an HTML page under site/
 * contains <div id="group-store"> but lacks the purchase listener code that
 * handles the 'group-store:paid' event and records purchases to localStorage
 * under the key 'soundshop:bought:v1'. Zero-dependency Node 18+ script.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

const GROUP_STORE_PLACEHOLDER_RE = /<div\s+id\s*=\s*["']?group-store["']?\s*>/i;
const BOUGHT_KEY_RE = /BOUGHT_KEY\s*=\s*['"]soundshop:bought:v1['"]/;
const GROUP_STORE_EVENT_RE = /document\.addEventListener\s*\(\s*['"]group-store:paid['"]/;
const LOCALSTORAGE_SETITEM_RE = /localStorage\.setItem\s*\(\s*BOUGHT_KEY/;
const OPT_OUT_RE = /<!--\s*no-purchase-listener-check\s*-->/i;

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
    console.error('check-purchase-listener: site/ directory not found at ' + SITE_DIR);
    process.exit(2);
  }

  const files = walk(SITE_DIR).sort();
  const violations = [];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');

    if (OPT_OUT_RE.test(text)) continue;

    // Check if this page has the group-store placeholder
    const placeholderMatch = GROUP_STORE_PLACEHOLDER_RE.exec(text);
    if (!placeholderMatch) continue;

    // This page has the placeholder; verify the purchase listener is present.
    // Look for key indicators that the purchase listener code is present:
    // 1. BOUGHT_KEY constant definition with the specific key
    // 2. document.addEventListener for 'group-store:paid'
    // 3. localStorage.setItem call using BOUGHT_KEY
    const hasBoughtKey = BOUGHT_KEY_RE.test(text);
    const hasEventListener = GROUP_STORE_EVENT_RE.test(text);
    const hasLocalStorageSetItem = LOCALSTORAGE_SETITEM_RE.test(text);

    // All three indicators must be present for the listener to be functional
    if (hasBoughtKey && hasEventListener && hasLocalStorageSetItem) {
      continue; // Listener is present, page is OK
    }

    // Listener is missing or incomplete
    const line = lineOf(text, placeholderMatch.index);
    violations.push({ file, line });
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(rel(v.file) + ':' + v.line + '  group-store placeholder present but purchase listener script missing');
    }
    console.error('\ncheck-purchase-listener: ' + violations.length + ' missing purchase listener(s) in ' + files.length + ' html file(s) scanned');
    process.exit(1);
  }

  console.log('check-purchase-listener: ok — all pages with group-store placeholder include the purchase listener script');
  process.exit(0);
}

if (require.main === module) main();
