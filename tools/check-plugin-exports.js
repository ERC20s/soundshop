#!/usr/bin/env node
// Zero-dependency static check that site/assets/js/plugin.js exports the
// canonical SSPlugin helper symbols. Exit 0 on success; non-zero on failure.

var fs = require('fs');
var path = require('path');

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exitCode = 2;
}

function ok(msg) {
  console.log('OK: ' + msg);
}

var target = path.join(__dirname, '..', 'site', 'assets', 'js', 'plugin.js');
if (!fs.existsSync(target)) {
  fail('site/assets/js/plugin.js not found at ' + target);
  console.error('Looked for: ' + target);
  process.exit(2);
}

var src = fs.readFileSync(target, 'utf8');

var errors = [];

function check(name, re, why) {
  if (re.test(src)) {
    ok(name + ' present');
  } else {
    errors.push(name + ' missing: ' + why);
  }
}

// Verify a global export anchor exists
check('window.SSPlugin assignment', /\bwindow\.SSPlugin\b\s*=\s*P\b|\bwindow\.SSPlugin\b/, 'expected window.SSPlugin to be assigned or referenced');

// Core helpers we want exported on the public P object
var helpers = [
  'extractDownloadUrl',
  'readBoughtArray',
  'maskEmail',
  'createBoughtCta',
  'initUrlOrderVerifyBanner'
];

helpers.forEach(function (name) {
  // Check for either a P.<name> assignment or a P.<name> reference
  var re = new RegExp('\\bP\\.' + name + '\\b');
  check('P.' + name, re, 'expected public helper P.' + name + ' to be present and exported');
});

// Also ensure the runtime-friendly function definitions exist (conservative)
check('function definitions', /function\s+extractDownloadUrl\s*\(|function\s+readBoughtArray\s*\(|function\s+maskEmail\s*\(|function\s+createBoughtCta\s*\(|function\s+initUrlOrderVerifyBanner\s*\(/, 'expected named function definitions for the helpers');

// Report
if (errors.length) {
  console.error('\nStatic check failed with ' + errors.length + ' problem(s):\n');
  errors.forEach(function (e) { console.error(' - ' + e + '\n'); });
  console.error('Please inspect site/assets/js/plugin.js and tools/check-plugin-exports.js');
  process.exit(2);
}

console.log('\nAll required plugin exports appear present in site/assets/js/plugin.js');
process.exit(0);
