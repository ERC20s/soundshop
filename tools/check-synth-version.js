#!/usr/bin/env node
'use strict';
/*
 * tools/check-synth-version.js
 *
 * Fail when the shipped VANTA engine VERSION constant in
 * site/assets/js/synth.js does not exactly match the topmost
 * VANTA entry in site/data/changelog.json.
 *
 * Zero dependencies, Node 18+. Exit codes:
 *   0  OK (match)
 *   1  mismatch or expected data not found / usage
 *   2  fatal error reading files or parsing JSON
 */

const fs = require('fs');
const path = require('path');

function err(msg) {
  console.error('check-synth-version: ' + msg);
}

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    err(`cannot read ${p} — ${e && e.message}`);
    process.exit(2);
  }
}

function extractVersionFromSynth(source) {
  // Match var/let/const VERSION = '1.2.3' or "1.2.3"; allow whitespace/comments.
  const re = /(?:^|[^A-Za-z0-9_$])(var|let|const)\s+VERSION\s*=\s*(['\"])([^'\"]+)\2/m;
  const m = re.exec(source);
  if (!m) return null;
  return m[3].trim();
}

function findTopmostVanta(changelogJson) {
  if (!Array.isArray(changelogJson)) return null;
  for (const entry of changelogJson) {
    if (entry && typeof entry.product === 'string' && entry.product.toUpperCase() === 'VANTA') {
      return entry.version;
    }
  }
  return null;
}

function main() {
  const synthPath = path.join('site', 'assets', 'js', 'synth.js');
  const changelogPath = path.join('site', 'data', 'changelog.json');

  const synthSrc = readFile(synthPath);
  const synthVersion = extractVersionFromSynth(synthSrc);
  if (!synthVersion) {
    err(`could not find a VERSION assignment in ${synthPath}`);
    process.exit(2);
  }

  const changelogText = readFile(changelogPath);
  let changelog;
  try {
    changelog = JSON.parse(changelogText);
  } catch (e) {
    err(`${changelogPath} is not valid JSON — ${e && e.message}`);
    process.exit(2);
  }

  const vantaVersion = findTopmostVanta(changelog);
  if (!vantaVersion) {
    err(`no VANTA entry found in ${changelogPath}`);
    process.exit(2);
  }

  if (synthVersion === vantaVersion) {
    console.log(`PASS: synth VERSION (${synthVersion}) matches topmost VANTA changelog entry`);
    process.exit(0);
  }

  // Mismatch — print diagnostics for humans and CI
  console.log('FAIL: synth VERSION does not match topmost VANTA changelog entry');
  console.log(`  synth.js VERSION = ${synthVersion}`);
  console.log(`  changelog VANTA version = ${vantaVersion}`);
  console.log('Please update either site/assets/js/synth.js or site/data/changelog.json so they agree.');
  process.exit(1);
}

if (require.main === module) main();
