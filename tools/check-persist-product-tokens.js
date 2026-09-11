#!/usr/bin/env node
'use strict';
/*
 * tools/check-persist-product-tokens.js — ensure plugin.js's getProductToken
 * recognises every item id listed in site/data/items.json. Zero-dependency
 * Node 18+ script.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');
const ITEMS_JSON = path.join(SITE_DIR, 'data', 'items.json');
const PLUGIN_JS = path.join(SITE_DIR, 'assets', 'js', 'plugin.js');

function rel(p) { return path.relative(REPO_ROOT, p).split(path.sep).join('/'); }

function fail(msg) { console.error('check-persist-product-tokens: ' + msg); process.exit(1); }

function readItems() {
  if (!fs.existsSync(ITEMS_JSON)) fail(rel(ITEMS_JSON) + ' not found');
  let raw;
  try { raw = fs.readFileSync(ITEMS_JSON, 'utf8'); } catch (e) { fail('failed to read ' + rel(ITEMS_JSON) + ': ' + e.message); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { fail(rel(ITEMS_JSON) + ' is not valid JSON: ' + e.message); }
  if (!Array.isArray(parsed)) fail(rel(ITEMS_JSON) + ' does not contain a JSON array');
  const ids = parsed.map((it) => it && it.id).filter(Boolean);
  if (!ids.length) fail('no item ids found in ' + rel(ITEMS_JSON));
  return ids;
}

function readPlugin() {
  if (!fs.existsSync(PLUGIN_JS)) fail(rel(PLUGIN_JS) + ' not found');
  try { return fs.readFileSync(PLUGIN_JS, 'utf8'); } catch (e) { fail('failed to read ' + rel(PLUGIN_JS) + ': ' + e.message); }
}

// Extract the function body of getProductToken by finding the function and
// matching braces. Returns the body as a string (contents inside the outer
// braces), or null when not found.
function extractGetProductTokenBody(src) {
  const idx = src.indexOf('function getProductToken(');
  if (idx === -1) return null;
  // locate first '{' after the function header
  const braceIdx = src.indexOf('{', idx);
  if (braceIdx === -1) return null;
  let depth = 0;
  for (let i = braceIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        // return content inside the outer braces
        return src.slice(braceIdx + 1, i);
      }
    }
  }
  return null;
}

function main() {
  const ids = readItems();
  const pluginSrc = readPlugin();
  // Prefer detecting an explicit PRODUCT_TOKENS object in plugin.js. If it
  // exists we parse its keys and assert coverage; otherwise fall back to the
  // legacy substring scan of the getProductToken body for backward
  // compatibility with older commits.
  const productMapMatch = pluginSrc.match(/\bvar\s+PRODUCT_TOKENS\s*=\s*\{([\s\S]*?)\}\s*;/);
  let declaredKeys = null;
  if (productMapMatch) {
    const body = productMapMatch[1];
    // Extract keys like: key: 'value', or 'key': 'value', or "key": 'value'
    const keyRe = /['"]?([A-Za-z0-9_-]+)['"]?\s*:/g;
    declaredKeys = new Set();
    let m;
    while ((m = keyRe.exec(body)) !== null) {
      declaredKeys.add(m[1].toLowerCase());
    }
  }

  const missing = [];

  for (const id of ids) {
    const idStr = String(id || '').trim().toLowerCase();
    if (!idStr) continue;
    if (declaredKeys) {
      if (!declaredKeys.has(idStr)) missing.push(id);
      continue;
    }

    // Legacy fallback: locate getProductToken and ensure the id appears as a
    // substring inside it.
    const body = extractGetProductTokenBody(pluginSrc);
    if (body === null) fail('could not locate getProductToken function in ' + rel(PLUGIN_JS));
    const lower = body.toLowerCase();
    if (lower.indexOf(idStr) === -1) {
      missing.push(id);
    }
  }

  if (missing.length) {
    console.error('check-persist-product-tokens: the getProductToken function in ' + rel(PLUGIN_JS) + '\n' +
      'does not appear to recognise these item ids from ' + rel(ITEMS_JSON) + ':');
    for (const m of missing) console.error('  - ' + m);
    console.error('\nHint: update getProductToken in ' + rel(PLUGIN_JS) + ' so that it matches every id from ' + rel(ITEMS_JSON) + '\n' +
      'This guard uses a conservative substring match inside the function body; if you refactor getProductToken to a\n' +
      'more dynamic mechanism, update this script to detect it accordingly.');
    process.exit(1);
  }

  console.log('check-persist-product-tokens: ok — getProductToken recognises all item ids from ' + rel(ITEMS_JSON));
  process.exit(0);
}

if (require.main === module) main();
