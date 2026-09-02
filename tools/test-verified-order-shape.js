#!/usr/bin/env node
// Behavioural check for normalizeVerifiedOrder() in site/assets/js/plugin.js.
//
// Why this exists: the payments widget in the root .d8a defines the verifier as
//
//   .then(function (d) { return d && d.paid ? d.order : null; })
//   window.groupStoreVerify = verify;
//
// so window.groupStoreVerify resolves to the ORDER OBJECT, never to a
// {paid, order} wrapper. The "Re-verify purchases" button used to read it the
// other way round (`res && res.paid ? res.order : null`), which meant every
// re-verify collapsed to null and the button could never do anything.
//
// Every other tool under tools/ only greps the source, which is how that bug
// shipped. This one lifts the helper out of plugin.js by brace matching,
// evaluates it, and asserts the shapes it must handle. Zero dependencies.
// Exit 0 on success; exit 2 with human-readable failures otherwise.

var fs = require('fs');
var path = require('path');

var errors = [];

function ok(msg) { console.log('OK: ' + msg); }
function bad(msg) { errors.push(msg); }

var target = path.join(__dirname, '..', 'site', 'assets', 'js', 'plugin.js');
if (!fs.existsSync(target)) {
  console.error('ERROR: site/assets/js/plugin.js not found at ' + target);
  process.exit(2);
}

var src = fs.readFileSync(target, 'utf8');

// ---------------------------------------------------------------------------
// 1. Lift `function normalizeVerifiedOrder(res) { ... }` out of the file.
// ---------------------------------------------------------------------------
function extractFunction(source, name) {
  var re = new RegExp('function\\s+' + name + '\\s*\\(');
  var m = re.exec(source);
  if (!m) return null;
  var open = source.indexOf('{', m.index);
  if (open === -1) return null;
  var depth = 0;
  for (var i = open; i < source.length; i++) {
    var c = source.charAt(i);
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(m.index, i + 1);
    }
  }
  return null;
}

var body = extractFunction(src, 'normalizeVerifiedOrder');
if (!body) {
  console.error('ERROR: no "function normalizeVerifiedOrder(" found in site/assets/js/plugin.js');
  console.error('Both verify paths (the ?d8a_order= banner and the Re-verify purchases button)');
  console.error('must read groupStoreVerify results through that one shared helper.');
  process.exit(2);
}
ok('found function normalizeVerifiedOrder (' + body.length + ' chars)');

var fn;
try {
  fn = new Function('return (' + body + ');')();
} catch (e) {
  console.error('ERROR: normalizeVerifiedOrder does not evaluate: ' + (e && e.message));
  process.exit(2);
}
if (typeof fn !== 'function') {
  console.error('ERROR: normalizeVerifiedOrder did not evaluate to a function');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 2. The four shapes it has to get right.
// ---------------------------------------------------------------------------
var plainOrder = { id: 'ord_123', itemName: 'VANTA', quantity: 1 };
var envelope = { paid: true, order: { id: 'ord_456', itemName: 'DRIFT' } };

var cases = [
  {
    what: 'a bare order (what groupStoreVerify actually resolves to) comes back as itself',
    input: plainOrder,
    expect: function (out) { return out === plainOrder; },
    expected: 'the same order object'
  },
  {
    what: 'a {paid:true, order} envelope is unwrapped to the order',
    input: envelope,
    expect: function (out) { return out === envelope.order; },
    expected: 'the inner order object'
  },
  {
    what: 'an unpaid envelope yields nothing',
    input: { paid: false, order: { id: 'ord_789' } },
    expect: function (out) { return !out; },
    expected: 'null (falsy)'
  },
  {
    what: 'null yields nothing',
    input: null,
    expect: function (out) { return !out; },
    expected: 'null (falsy)'
  },
  {
    what: 'a paid:false response with no order yields nothing',
    input: { paid: false },
    expect: function (out) { return !out; },
    expected: 'null (falsy)'
  },
  {
    what: 'an object that is not an order yields nothing',
    input: { hello: 'world' },
    expect: function (out) { return !out; },
    expected: 'null (falsy)'
  },
  {
    what: 'a string is not an order',
    input: 'ord_123',
    expect: function (out) { return !out; },
    expected: 'null (falsy)'
  }
];

cases.forEach(function (c) {
  var out;
  try {
    out = fn(c.input);
  } catch (e) {
    bad(c.what + ' — threw: ' + (e && e.message));
    return;
  }
  if (c.expect(out)) {
    ok(c.what);
  } else {
    bad(c.what + ' — expected ' + c.expected + ', got ' + JSON.stringify(out));
  }
});

// ---------------------------------------------------------------------------
// 3. The bug itself must not come back anywhere in the file.
// ---------------------------------------------------------------------------
var banned = [
  {
    re: /\.paid\s*\?\s*[A-Za-z_$][A-Za-z0-9_$]*\.order/,
    why: 'reads a groupStoreVerify result as `res.paid ? res.order` — the verifier in .d8a already unwrapped the envelope, so that is always null'
  },
  {
    re: /res\.order\s*&&\s*res\.paid/,
    why: 'reads a groupStoreVerify result as an envelope inline instead of calling normalizeVerifiedOrder'
  }
];

// Comments explain the bug (they quote the old expression on purpose), so the
// scan runs over the code with comments stripped.
var code = src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

banned.forEach(function (b) {
  if (b.re.test(code)) {
    bad('site/assets/js/plugin.js still ' + b.why);
  }
});
if (!errors.length) ok('no direct {paid, order} unwrapping left in plugin.js');

// Both call sites must go through the helper: the definition plus at least two
// calls, counted over the comment-stripped source.
var uses = (code.match(/normalizeVerifiedOrder\s*\(/g) || []).length;
if (uses < 3) {
  bad('normalizeVerifiedOrder appears ' + uses + ' time(s) in code (definition + calls): both the ?d8a_order= banner and the Re-verify purchases handler must call it');
} else {
  ok('normalizeVerifiedOrder is defined and called at ' + (uses - 1) + ' site(s)');
}

if (!/P\.normalizeVerifiedOrder\s*=\s*normalizeVerifiedOrder\s*;/.test(src)) {
  bad('normalizeVerifiedOrder is not exported as P.normalizeVerifiedOrder');
} else {
  ok('exported as SSPlugin.normalizeVerifiedOrder');
}

// ---------------------------------------------------------------------------
if (errors.length) {
  console.error('\nVerified-order shape check failed with ' + errors.length + ' problem(s):\n');
  errors.forEach(function (e) { console.error(' - ' + e + '\n'); });
  console.error('Please inspect site/assets/js/plugin.js and tools/test-verified-order-shape.js');
  process.exit(2);
}

console.log('\nnormalizeVerifiedOrder handles every groupStoreVerify result shape correctly');
process.exit(0);
