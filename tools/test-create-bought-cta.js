#!/usr/bin/env node
// Zero-dependency static check for presence of createBoughtCta helper in plugin.js
// Exit 0 on success; non-zero on failure with human-friendly messages.

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

function checkPresent(name, re, why) {
  if (re.test(src)) {
    ok(name + ' present');
  } else {
    errors.push(name + ' missing: ' + why);
  }
}

checkPresent('function createBoughtCta', /function\s+createBoughtCta\s*\(/, 'expected createBoughtCta(host, detail) helper');
checkPresent('uses extractDownloadUrl', /\bextractDownloadUrl\b/, 'helper must validate download URLs using extractDownloadUrl');
checkPresent('data-ssp-bought-cta guard', /data-ssp-bought-cta/, 'helper should guard with data-ssp-bought-cta to be idempotent');

if (errors.length) {
  console.error('\nStatic check failed with ' + errors.length + ' problem(s):\n');
  errors.forEach(function (e) { console.error(' - ' + e + '\n'); });
  console.error('Please inspect site/assets/js/plugin.js and tools/test-create-bought-cta.js');
  process.exit(2);
}

console.log('\nAll checks passed for createBoughtCta presence and basic patterns');
process.exit(0);
