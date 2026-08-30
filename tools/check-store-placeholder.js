#!/usr/bin/env node
'use strict';

const fs = require('fs').promises;
const path = require('path');

async function main() {
  const p = path.resolve(process.cwd(), 'site', 'plugins', 'index.html');
  let txt;
  try {
    txt = await fs.readFile(p, 'utf8');
  } catch (err) {
    console.error('Failed to read', p + ':', err && err.message);
    process.exit(2);
  }

  const needle = '<div id="group-store"';
  const count = (txt.split(needle).length - 1);

  if (count < 1) {
    console.error('\nStore placeholder check failed:');
    console.error('  Expected to find the literal string "<div id=\"group-store\"" in:');
    console.error('    ' + p);
    console.error('\n  The plugins index includes styles for #group-store but the placeholder element is missing.');
    console.error('  Add a single placeholder element exactly once, for example:');
    console.error('    <div id="group-store"></div>');
    console.error('\n  If you intentionally render the store some other way, update this check via governance.');
    process.exit(1);
  }

  if (count > 1) {
    console.error('\nStore placeholder check failed:');
    console.error('  Found the placeholder more than once (' + count + ' occurrences) in:');
    console.error('    ' + p);
    console.error('  There should be exactly one <div id="group-store"></div> in the plugins index.');
    process.exit(1);
  }

  console.log('Store placeholder present exactly once in', p);
  process.exit(0);
}

main().catch(err => {
  console.error('Unexpected error:', err && err.stack || err);
  process.exit(2);
});
