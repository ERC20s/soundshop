#!/usr/bin/env node
'use strict';
/*
 * tools/check-data-targets.js — check data-demo-src and data-presets-src targets
 *
 * Usage: node tools/check-data-targets.js
 * Needs: Node 18 or newer. No npm packages.
 *
 * What it does:
 *  - walks site/ and reads every .html file;
 *  - finds attributes data-demo-src and data-presets-src inside each HTML file;
 *  - skips external values (http:, https:, data:, mailto:, protocol-relative //),
 *    bare fragments (#...), and empty values;
 *  - strips query and hash, decodes percent-encodings, and resolves targets:
 *    - leading '/' targets are stripped of the leading slash and resolved against
 *      the repository's site/ directory (so '/demo/foo.html' -> SITE_DIR/demo/foo.html);
 *    - relative targets resolve against the containing page's directory;
 *  - reports every missing target as  file:line  target -> resolved-path and
 *    exits with status 1 if anything is missing, 0 otherwise.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

const ATTR_RE = /\b(?:data-demo-src|data-presets-src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function walkHtml(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walkHtml(full, out);
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

function isExternal(target) {
  if (!target) return true;
  const t = target.trim();
  if (t === '' || t.startsWith('#')) return true;
  if (t.startsWith('//')) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(t);
}

function stripQueryAndHash(target) {
  return target.replace(/[?#].*$/, '');
}

function cleanTarget(target) {
  let clean = stripQueryAndHash(String(target).trim());
  try { clean = decodeURIComponent(clean); } catch (e) { /* keep as-is */ }
  return clean;
}

function existsOnDisk(resolved) {
  if (!resolved) return true;
  if (!fs.existsSync(resolved)) return false;
  const st = fs.statSync(resolved);
  if (st.isDirectory()) return fs.existsSync(path.join(resolved, 'index.html'));
  return true;
}

function resolveTargetAgainstSite(clean) {
  // strip leading slashes so path.resolve joins SITE_DIR + rest reliably
  const stripped = clean.replace(/^\/+/, '');
  return path.resolve(SITE_DIR, stripped);
}

function resolveTargetRelative(clean, file) {
  return path.resolve(path.dirname(file), clean);
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
      if (isExternal(target)) continue;
      checked++;
      const clean = cleanTarget(target);
      if (clean === '') continue; // treat empty after cleaning as okay
      let resolved;
      if (clean.startsWith('/')) {
        resolved = resolveTargetAgainstSite(clean);
      } else {
        resolved = resolveTargetRelative(clean, file);
      }
      if (!existsOnDisk(resolved)) {
        missing.push({ file, line, target, resolved });
      }
    }
  }

  if (missing.length) {
    console.error('\ncheck-data-targets: missing ' + missing.length + ' target(s):\n');
    for (const m of missing) {
      console.error(rel(m.file) + ':' + m.line + '  ' + m.target + ' -> ' + rel(m.resolved));
    }
    console.error('\nScanned ' + files.length + ' HTML file(s). Checked ' + checked + ' data-* targets.');
    process.exitCode = 1;
    return;
  }

  console.log('check-data-targets: all data-demo-src and data-presets-src targets exist. Scanned ' + files.length + ' HTML file(s). Checked ' + checked + ' data-* targets.');
  process.exitCode = 0;
}

main();
