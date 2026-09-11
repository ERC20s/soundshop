'use strict';

// Exercise the actual shared knob/fader binding without a browser or audio device.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../site/assets/js/demo.js'), 'utf8');
const start = source.indexOf('  function decimalsOf(');
const end = source.indexOf('  function applyAria(');
assert(start >= 0 && end > start, 'continuous-control implementation exists');
const document = { activeElement: null };
const context = {
  document, S: null, window: {},
  clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
  on: (node, type, fn) => { node.handlers[type] = fn; },
  toast: () => {}
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);
const node = { handlers: {} };
const spec = { name: 'test', label: 'Test', min: 0, max: 1, step: 0.01, default: 0.5 };
let value = 0.5;
let writes = 0;
context.bindContinuous(node, spec, () => value, v => { value = v; writes++; });
let prevented = false;
const wheel = delta => ({ deltaY: delta, deltaX: 0, preventDefault() { prevented = true; } });
node.handlers.wheel(wheel(100));
assert.equal(writes, 0, 'unfocused scrolling must not edit a patch');
assert.equal(prevented, false, 'unfocused scrolling remains available to the page');
document.activeElement = node;
node.handlers.wheel(wheel(0));
assert.equal(writes, 0, 'zero wheel delta must not edit a patch');
node.handlers.wheel(wheel(100));
assert.equal(value, 0.49);
assert.equal(prevented, true, 'focused adjustment consumes the wheel event');
node.handlers.keydown({ key: 'End', preventDefault() {} });
assert.equal(value, 1);
node.handlers.keydown({ key: 'Delete', preventDefault() {} });
assert.equal(value, 0.5, 'keyboard reset remains available');
node.handlers.dblclick({ preventDefault() {} });
assert.equal(value, 0.5);

const html = fs.readFileSync(path.join(__dirname, '../site/demo/flagship-demo.html'), 'utf8');
assert(html.indexOf('id="keys"') < html.indexOf('id="rack"'), 'keyboard precedes the sound-design rack');
assert(html.includes('aria-label="Sound design sections"'), 'section navigation has an accessible name');
console.log('test-demo-controls: scroll safety, keyboard adjustment and play-first layout passed');
