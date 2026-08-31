#!/usr/bin/env node
// Zero-dependency static check for site/assets/js/plugin.js bought-summary API
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

function escapeRE(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

var target = path.join(__dirname, '..', 'site', 'assets', 'js', 'plugin.js');
if (!fs.existsSync(target)) {
  fail('site/assets/js/plugin.js not found at ' + target);
  console.error('Looked for: ' + target);
  process.exit(2);
}

var src = fs.readFileSync(target, 'utf8');

var errors = [];
var warnings = [];

function checkPresent(name, re, why) {
  if (re.test(src)) {
    ok(name + ' present');
  } else {
    errors.push(name + ' missing: ' + why);
  }
}

// 1. Exported symbols
checkPresent('P.initBoughtSummary', /\bP\.initBoughtSummary\b/, 'expected public API function P.initBoughtSummary');
checkPresent('P.initBoughtNote', /\bP\.initBoughtNote\b/, 'expected public API function P.initBoughtNote');

// 2. Helper functions
checkPresent('function maskEmail', /function\s+maskEmail\s*\(/, 'maskEmail(email) helper not found');
checkPresent('function createBoughtCta', /function\s+createBoughtCta\s*\(/, 'createBoughtCta(host, detail) helper not found');

// 3. Event listener string
checkPresent('soundshop:verified-order listener', /soundshop:verified-order/, 'event name not referenced');

// 4. Data attributes
checkPresent('data-bought-summary marker', /data-bought-summary/, 'markup marker data-bought-summary not referenced');
checkPresent('data-bought-note marker', /data-bought-note/, 'markup marker data-bought-note not referenced');

// 5. Reveal-handler closure signature checks
// Find every (function (...) { ... })(...);
var iifeRE = /\(function\s*\(\s*([^)]*?)\s*\)\s*\{([\s\S]*?)\}\s*\)\s*\(\s*([^)]*?)\s*\)/g;
var match;
var iifeCount = 0;
var iifeProblems = [];
while ((match = iifeRE.exec(src)) !== null) {
  iifeCount++;
  var paramsRaw = match[1];
  var body = match[2];
  var argsRaw = match[3];
  var params = paramsRaw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var args = argsRaw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);

  // We only check patterns that look like reveal handlers: at least 3 params
  if (params.length >= 3) {
    var third = params[2];
    // strip potential default values or destructuring
    third = third.split('=')[0].trim();
    // also remove any non-identifier chars
    third = third.replace(/[^A-Za-z0-9_$]/g, '') || params[2];
    // Check if third param name appears in the body as an identifier
    var nameRE = new RegExp('\\b' + escapeRE(third) + '\\b');
    if (!nameRE.test(body)) {
      // compute line number for snippet
      var startIndex = match.index;
      var prefix = src.slice(0, startIndex);
      var line = prefix.split('\n').length;
      var snippet = src.slice(startIndex, Math.min(startIndex + 300, src.length)).split('\n').slice(0, 10).join('\n');
      iifeProblems.push({ index: iifeCount, line: line, param: third, snippet: snippet });
    }
  }
}

if (iifeCount === 0) {
  ok('No IIFE patterns found (none to check)');
} else {
  ok('Found ' + iifeCount + ' IIFE(s) to inspect for reveal-handler parameter usage');
  if (iifeProblems.length) {
    iifeProblems.forEach(function (p) {
      errors.push('IIFE param mismatch: third parameter "' + p.param + '" is not referenced in the closure body (around line ' + p.line + '). Snippet:\n' + p.snippet);
    });
  } else {
    ok('All IIFEs with >=3 params reference their third parameter inside the body');
  }
}

// Report results
if (errors.length) {
  console.error('\nStatic check failed with ' + errors.length + ' problem(s):\n');
  errors.forEach(function (e) { console.error(' - ' + e + '\n'); });
  console.error('Please inspect site/assets/js/plugin.js and fix the issues above.');
  process.exit(2);
}

if (warnings.length) {
  console.warn('\nWarnings:\n');
  warnings.forEach(function (w) { console.warn(' - ' + w); });
}

console.log('\nAll checks passed for site/assets/js/plugin.js');
process.exit(0);
