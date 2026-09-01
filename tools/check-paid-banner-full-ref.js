#!/usr/bin/env node
// Zero-dependency static check that site/assets/js/plugin.js either sets/gets
// the data-ssp-full-ref attribute on returned-checkout banners or exports a
// getPaidBannerFullRef helper. Exit 0 on success; non-zero on failure.

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

// Conservative patterns that tolerate surrounding code and formatting
var attrRe = /setAttribute\s*\(\s*['"]data-ssp-full-ref['"]|getAttribute\s*\(\s*['"]data-ssp-full-ref['"]/;
// Match either P.getPaidBannerFullRef usage/assignment or a named function
var helperRe = /\bP\.getPaidBannerFullRef\b|function\s+getPaidBannerFullRef\s*\(/;

var foundAttr = attrRe.test(src);
var foundHelper = helperRe.test(src);

if (foundAttr) ok("saw setting/getting of 'data-ssp-full-ref' in site/assets/js/plugin.js");
else console.log("INFO: no obvious setAttribute/getAttribute for 'data-ssp-full-ref' found");

if (foundHelper) ok("saw P.getPaidBannerFullRef export or function getPaidBannerFullRef present");
else console.log('INFO: no P.getPaidBannerFullRef or function getPaidBannerFullRef found');

// Fail only when neither the attribute nor the helper is present
if (foundAttr || foundHelper) {
  console.log('\nStatic check passed: attribute or helper present.');
  process.exit(0);
}

console.error('\nStatic check failed: missing both the data-ssp-full-ref attribute usage and the getPaidBannerFullRef helper.');
console.error('Expected site/assets/js/plugin.js to either set/get the attribute via setAttribute/getAttribute or to export/define getPaidBannerFullRef.');
console.error('\nHint: look for setAttribute(\"data-ssp-full-ref\") or getAttribute(\"data-ssp-full-ref\") and either P.getPaidBannerFullRef or function getPaidBannerFullRef.');
process.exit(2);
