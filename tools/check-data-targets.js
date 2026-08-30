#!/usr/bin/env node
'use strict';
/*
 * check-data-targets.js — small zero-dependency checker for data-demo-src and
 * data-presets-src attributes inside site/ HTML files. Usage: node tools/check-data-targets.js
 * Exits 0 when all checked targets exist, 1 when any are missing, 2 on fatal errors.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

// Match data-demo-src="..." or data-presets-src='...'
const ATTR_RE = /\b(?:data-demo-src|data-presets-src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function walkHtml(dir, out) {
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walkHtml(full, out);
    else if (/\.html?$/i.test(name)) out.push(full);
  }
  return out;
}

function isExternal(target) {
  if (!target) return true;
  const t = target.trim();
  if (t === '' || t.startsWith('#')) return true;
  if (t.startsWith('//')) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(t); // http:, https:, mailto:, data:, javascript:, ...
}

function stripQueryAndHash(target) {
  return target.replace(/[?#].*$/, '');
}

function cleanTarget(target) {
  let clean = stripQueryAndHash(target.trim());
  try { clean = decodeURIComponent(clean); } catch (e) { /* keep as is */ }
  return clean;
}

function resolveTarget(target, file) {
  const clean = cleanTarget(target);
  if (clean === '') return null;
  if (clean.startsWith('/')) return path.join(SITE_DIR, clean);
  return path.resolve(path.dirname(file), clean);
}

function existsOnDisk(resolved) {
  if (!resolved) return true;
  if (!fs.existsSync(resolved)) return false;
  const st = fs.statSync(resolved);
  if (st.isDirectory()) return fs.existsSync(path.join(resolved, 'index.html'));
  return true;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/') || '.';
}

function main() {
  if (!fs.existsSync(SITE_DIR)) {
    console.error('check-data-targets: site/ directory not found at ' + SITE_DIR);
    process.exit(2);
  }

  const files = walkHtml(SITE_DIR).sort();
  const missing = [];
  let checked = 0;

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(text)) !== null) {
      const target = m[1] !== undefined ? m[1] : m[2];
      const line = lineOf(text, m.index);
      // skip empty, external, or fragment-only values
      if (!target) continue;
      if (isExternal(target)) continue;
      checked++;
      const resolved = resolveTarget(target, file);
      if (!existsOnDisk(resolved)) {
        missing.push({ file, line, target, resolved });
      }
    }
  }

  if (missing.length > 0) {
    for (const m of missing) {
      console.error(rel(m.file) + ':' + m.line + ' ' + m.target + ' -> ' + rel(m.resolved));
    }
    console.error('check-data-targets: ' + missing.length + ' missing data-* targets');
    process.exit(1);
  }

  console.log('check-data-targets: ' + checked + ' checked, all targets present');
  process.exit(0);
}

main();
