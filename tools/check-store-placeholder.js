#!/usr/bin/env node
'use strict';

const fs = require('fs').promises;
const path = require('path');

function previewAround(text, index, contextLines = 3) {
  const lines = text.split(/\r?\n/);
  let charCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const next = charCount + lines[i].length + 1;
    if (index < next) {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length, i + contextLines + 1);
      return lines.slice(start, end).map((l, idx) => {
        const num = start + idx + 1;
        return (num + ': ').padStart(6) + l;
      }).join('\n');
    }
    charCount = next;
  }
  return '';
}

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
  let idx = 0;
  const indices = [];
  while (true) {
    const found = txt.indexOf(needle, idx);
    if (found === -1) break;
    indices.push(found);
    idx = found + needle.length;
  }

  const count = indices.length;
  if (count === 1) {
    console.log('OK: found exactly one "' + needle + '" occurrence in site/plugins/index.html');
    process.exitCode = 0;
    return;
  }

  console.error('\nCheck failed: expected exactly one "' + needle + '" occurrence in site/plugins/index.html but found', count + '.\n');
  if (count === 0) {
    console.error('Suggested fix: insert the following line immediately after the closing </div> of the .bundle block and before the .strip mt-6 element:');
    console.error('\n  <div id="group-store"></div>\n');
  } else {
    console.error('Occurrences (preview with surrounding lines):\n');
    for (let i = 0; i < indices.length; i++) {
      console.error('Occurrence #' + (i + 1) + ':\n' + previewAround(txt, indices[i]) + '\n-----');
    }
    console.error('\nSuggested fix: keep exactly one of these occurrences and remove any duplicates so only one "<div id=\"group-store\"" remains.');
  }

  process.exitCode = 1;
}

main().catch(err => {
  console.error('Unexpected error:', err && err.stack || err);
  process.exit(2);
});
