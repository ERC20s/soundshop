#!/usr/bin/env node
'use strict';
/*
 * tools/check-all.js — run every verification script in tools/ and report once.
 *
 * Usage:  node tools/check-all.js
 * Needs:  Node 18 or newer. No npm packages, no arguments, no configuration.
 *
 * What it does:
 *  - reads its own directory (__dirname), so it works from anywhere in the tree;
 *  - selects every file matching /^(check|test)-.*\.js$/ except this file, and
 *    sorts them, so a new check added to tools/ is picked up with no edit here;
 *  - runs each one in a child process with the same Node binary
 *    (process.execPath), with the repository root as the working directory;
 *  - prints one PASS/FAIL line per script and replays the captured stdout and
 *    stderr only for the ones that failed, so a clean tree stays quiet;
 *  - ends with a "N passed, M failed" summary and sets process.exitCode = 1 if
 *    anything failed.
 *
 * Exit codes of the children: the existing scripts use 1 for findings and 2 for
 * an internal error (e.g. tools/test-create-bought-cta.js). This runner treats
 * ANY non-zero exit — and any signal — as a failure, and names the script, so
 * neither kind is ever swallowed.
 *
 * This runner never edits files and never touches the network; it only starts
 * the checks that are already in the repository.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOLS_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, '..');
const SELF = path.basename(__filename);
const SCRIPT_RE = /^(?:check|test)-.*\.js$/;

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/');
}

function findScripts() {
  return fs
    .readdirSync(TOOLS_DIR)
    .filter((name) => SCRIPT_RE.test(name) && name !== SELF)
    .filter((name) => {
      try {
        return fs.statSync(path.join(TOOLS_DIR, name)).isFile();
      } catch (e) {
        return false;
      }
    })
    .sort();
}

function indent(text) {
  return String(text)
    .replace(/\s+$/, '')
    .split(/\r?\n/)
    .map((line) => '    ' + line)
    .join('\n');
}

function run(name) {
  const full = path.join(TOOLS_DIR, name);
  const started = Date.now();
  const res = spawnSync(process.execPath, [full], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  const ms = Date.now() - started;

  // spawnSync itself failed (binary missing, permissions, ...): treat as a failure.
  if (res.error) {
    return { name, ok: false, code: null, signal: null, ms, output: String(res.error.message || res.error) };
  }

  const output = [res.stdout || '', res.stderr || ''].join('').replace(/\s+$/, '');
  const ok = res.status === 0 && !res.signal;
  return { name, ok, code: res.status, signal: res.signal, ms, output };
}

function main() {
  const scripts = findScripts();

  if (scripts.length === 0) {
    console.error('check-all: no check-*.js / test-*.js scripts found in ' + rel(TOOLS_DIR));
    process.exitCode = 2;
    return;
  }

  console.log('check-all: running ' + scripts.length + ' checks from ' + rel(TOOLS_DIR) + '\n');

  const results = [];
  for (const name of scripts) {
    const result = run(name);
    results.push(result);
    const status = result.ok ? 'PASS' : 'FAIL';
    console.log(status + '  ' + name + '  (' + result.ms + 'ms)');
  }

  const failed = results.filter((r) => !r.ok);

  if (failed.length > 0) {
    console.log('');
    for (const r of failed) {
      const why = r.signal ? 'killed by signal ' + r.signal : 'exit ' + r.code;
      console.log('--- ' + r.name + ' (' + why + ') ---');
      if (r.output) console.log(indent(r.output));
      console.log('');
    }
  }

  const passed = results.length - failed.length;
  console.log('check-all: ' + passed + ' passed, ' + failed.length + ' failed');
  if (failed.length > 0) {
    console.log('check-all: failing — ' + failed.map((r) => r.name).join(', '));
    process.exitCode = 1;
  }
}

if (require.main === module) main();
