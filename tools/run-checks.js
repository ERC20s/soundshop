#!/usr/bin/env node
'use strict';
/*
 * tools/run-checks.js — one runner for every guard script in tools/.
 *
 * Discovers tools/check-*.js and tools/test-*.js (this file and tools/serve.js
 * excluded), sorts them by name and runs each one sequentially in its own Node
 * process from the repository root. Prints PASS/FAIL per script, replays the
 * output of anything that failed, ends with a summary line and exits 1 when at
 * least one script failed.
 *
 * Zero dependencies, Node 18+, no arguments required.
 *
 * Usage:
 *   node tools/run-checks.js                # run everything
 *   node tools/run-checks.js --list         # print what would run, run nothing
 *   node tools/run-checks.js --only charset # run only scripts whose name contains "charset"
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const TOOLS_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, '..');
const SELF = path.basename(__filename);

// Scripts that are libraries or long-running servers, never guards.
const EXCLUDE = new Set([SELF, 'serve.js']);

function isRunnable(name) {
  if (!/\.js$/i.test(name)) return false;
  if (EXCLUDE.has(name)) return false;
  return /^check-/i.test(name) || /^test-/i.test(name);
}

function discover() {
  let names;
  try {
    names = fs.readdirSync(TOOLS_DIR);
  } catch (err) {
    console.error('run-checks: cannot read ' + TOOLS_DIR + ' — ' + (err && err.message));
    process.exit(2);
  }
  return names.filter(isRunnable).sort();
}

function parseArgs(argv) {
  const opts = { list: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list' || arg === '-l') {
      opts.list = true;
    } else if (arg === '--only' || arg === '-o') {
      opts.only = argv[++i] || '';
    } else if (arg.indexOf('--only=') === 0) {
      opts.only = arg.slice('--only='.length);
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      console.error('run-checks: unknown argument "' + arg + '" (try --help)');
      process.exit(2);
    }
  }
  if (opts.only !== null && !opts.only) {
    console.error('run-checks: --only needs a substring, e.g. --only charset');
    process.exit(2);
  }
  return opts;
}

function usage() {
  console.log('Usage: node tools/run-checks.js [--list] [--only <substring>]');
  console.log('');
  console.log('  --list            print the scripts that would run, run nothing');
  console.log('  --only <text>     run only scripts whose filename contains <text>');
  console.log('');
  console.log('Exits 0 when every script passed, 1 when any failed, 2 on a usage error.');
}

function pad(name, width) {
  return name.length >= width ? name : name + ' '.repeat(width - name.length);
}

function replay(label, text) {
  if (!text) return;
  const lines = text.replace(/\s+$/, '').split(/\r?\n/);
  for (const line of lines) console.error('    ' + label + ' ' + line);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); process.exit(0); }

  let scripts = discover();
  if (opts.only) {
    const needle = opts.only.toLowerCase();
    scripts = scripts.filter((n) => n.toLowerCase().indexOf(needle) !== -1);
  }

  if (!scripts.length) {
    console.error('run-checks: no scripts to run' + (opts.only ? ' for --only "' + opts.only + '"' : ''));
    process.exit(1);
  }

  if (opts.list) {
    for (const name of scripts) console.log('tools/' + name);
    console.log('run-checks: ' + scripts.length + ' script(s) would run');
    process.exit(0);
  }

  const width = scripts.reduce((w, n) => Math.max(w, n.length), 0);
  const failed = [];
  const started = Date.now();

  for (const name of scripts) {
    const file = path.join(TOOLS_DIR, name);
    const began = Date.now();
    const res = cp.spawnSync(process.execPath, [file], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    });
    const ms = Date.now() - began;

    if (res.error) {
      failed.push(name);
      console.log('FAIL ' + pad(name, width) + '  (could not start)');
      console.error('    ! ' + res.error.message);
      continue;
    }

    const code = res.status === null
      ? ('signal ' + (res.signal || 'unknown'))
      : res.status;

    if (res.status === 0) {
      console.log('PASS ' + pad(name, width) + '  ' + ms + 'ms');
      continue;
    }

    failed.push(name);
    console.log('FAIL ' + pad(name, width) + '  ' + ms + 'ms  (exit ' + code + ')');
    replay('|', res.stdout);
    replay('>', res.stderr);
  }

  const total = scripts.length;
  const passed = total - failed.length;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log('');
  if (failed.length) {
    console.log('failed: ' + failed.map((n) => 'tools/' + n).join(', '));
  }
  console.log('run-checks: ' + passed + ' passed, ' + failed.length + ' failed (' + total + ' script(s), ' + seconds + 's)');
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) main();
