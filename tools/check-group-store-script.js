#!/usr/bin/env node
'use strict';
/*
 * tools/check-group-store-script.js — fail when an HTML page under site/
 * contains <div id="group-store"> but lacks the payment widget script that
 * populates it, handles purchases, and fires the "group-store:paid" event.
 * Looks for key indicators: groupStoreVerify function, "group-store:paid" event,
 * or the inline payment widget logic. Zero-dependency Node 18+ script.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

const GROUP_STORE_PLACEHOLDER_RE = /<div\s+id\s*=\s*["']?group-store["']?\s*>/i;
const GROUP_STORE_VERIFY_RE = /groupStoreVerify/;
const GROUP_STORE_EVENT_RE = /"group-store:paid"/;
const OPT_OUT_RE = /<!--\s*no-group-store-script-check\s*-->/i;

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
    console.error('check-group-store-script: site/ directory not found at ' + SITE_DIR);
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

    // This page has the placeholder; verify the payment widget script is present.
    // Look for key indicators that the payment widget code is present.
    const hasVerifyFunction = GROUP_STORE_VERIFY_RE.test(text);
    const hasEventDispatch = GROUP_STORE_EVENT_RE.test(text);

    // If either indicator is found, the script is present (either inline or via reference)
    if (hasVerifyFunction || hasEventDispatch) {
      continue; // Script is present, page is OK
    }

    // Script is missing
    const line = lineOf(text, placeholderMatch.index);
    violations.push({ file, line });
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(rel(v.file) + ':' + v.line + '  group-store placeholder present but payment widget script missing');
    }
    console.error('\ncheck-group-store-script: ' + violations.length + ' missing payment widget script(s) in ' + files.length + ' html file(s) scanned');
    process.exit(1);
  }

  console.log('check-group-store-script: ok — all pages with group-store placeholder include the payment widget script');
  process.exit(0);
}

if (require.main === module) main();
