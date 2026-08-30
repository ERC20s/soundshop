#!/usr/bin/env node
'use strict';
/*
 * tools/check-synth-order.js — fail when a page includes a dependent script
 * (assets/js/home.js, assets/js/demo.js, assets/js/presets.js) before the
 * audio engine script (assets/js/synth.js) has appeared earlier in the same
 * HTML file. Zero-dependency Node 18+ script.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

const SCRIPT_TAG_RE = /<script\b[^>]*>/gi;
const SRC_RE = /src\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const OPT_OUT_RE = /<!--\s*no-synth-check\s*-->/i;

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
  return c.replace(/^\.*\/+/, '').endsWith(suffix);
}

function findScriptTags(text) {
  const out = [];
  SCRIPT_TAG_RE.lastIndex = 0;
  let m;
  while ((m = SCRIPT_TAG_RE.exec(text)) !== null) {
    const tagStart = m.index;
    const tag = m[0];
    const srcMatch = SRC_RE.exec(tag);
    const src = srcMatch ? (srcMatch[1] !== undefined ? srcMatch[1] : srcMatch[2]) : null;
    out.push({ index: tagStart, tag, src });
  }
  return out;
}

function main() {
  if (!fs.existsSync(SITE_DIR)) {
    console.error('check-synth-order: site/ directory not found at ' + SITE_DIR);
    process.exit(2);
  }

  const files = walk(SITE_DIR).sort();
  const deps = [ 'assets/js/home.js', 'assets/js/demo.js', 'assets/js/presets.js' ];
  const synthSuffix = 'assets/js/synth.js';
  const violations = [];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');

    if (OPT_OUT_RE.test(text)) continue;

    // Find </body> to prefer reporting near end-of-file; still parse whole
    // document for script tag ordering so we can detect earlier synth script.
    const bodyMatch = /<\/body\s*>/i.exec(text);
    const cutoff = bodyMatch ? bodyMatch.index : text.length;

    const scripts = findScriptTags(text);

    for (const s of scripts) {
      if (!s.src) continue;
      // If this script is beyond the cutoff (after </body>), treat it as at EOF
      // for the purpose of line reporting, but still consider tags by index.
      const src = s.src;
      const isDep = deps.some(d => endsWithAsset(src, d));
      if (!isDep) continue;

      // Check whether any earlier script tag has src ending with synthSuffix.
      const hasEarlierSynth = scripts.some(other => other.index < s.index && other.src && endsWithAsset(other.src, synthSuffix));

      if (!hasEarlierSynth) {
        const line = lineOf(text, Math.min(s.index, cutoff));
        violations.push({ file, line, dep: src });
      }
    }
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(rel(v.file) + ':' + v.line + '  dependent script ' + v.dep + ' appears without a prior assets/js/synth.js script');
    }
    console.error('\ncheck-synth-order: ' + violations.length + ' ordering violation(s) in ' + files.length + ' html file(s) scanned');
    process.exit(1);
  }

  console.log('check-synth-order: ok — dependent scripts appear after assets/js/synth.js where required');
  process.exit(0);
}

if (require.main === module) main();
