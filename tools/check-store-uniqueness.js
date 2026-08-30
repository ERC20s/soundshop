#!/usr/bin/env node
'use strict';

const fs = require('fs').promises;
const path = require('path');

async function findHtmlFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let files = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      files = files.concat(await findHtmlFiles(p));
    } else if (e.isFile() && p.toLowerCase().endsWith('.html')) {
      files.push(p);
    }
  }
  return files;
}

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
  const root = path.resolve(process.cwd(), 'site');
  let htmlFiles = [];
  try {
    htmlFiles = await findHtmlFiles(root);
  } catch (err) {
    console.error('Failed to list site/ directory:', err && err.message);
    process.exit(2);
  }

  if (!htmlFiles.length) {
    console.log('No HTML files found under site/.');
    return;
  }

  const needle = '<div id="group-store"';
  const occurrences = [];

  for (const file of htmlFiles) {
    let txt;
    try {
      txt = await fs.readFile(file, 'utf8');
    } catch (err) {
      console.error('Failed to read', file, err && err.message);
      continue;
    }

    let idx = 0;
    while (true) {
      const found = txt.indexOf(needle, idx);
      if (found === -1) break;
      // compute line number
      const before = txt.slice(0, found);
      const lineNumber = before.split('\n').length;
      occurrences.push({ file, index: found, lineNumber, preview: previewAround(txt, found) });
      idx = found + needle.length;
    }
  }

  // Determine occurrences inside the canonical plugins index
  const pluginsIndex = path.resolve(root, 'plugins', 'index.html');
  const inPlugins = occurrences.filter(o => path.resolve(o.file) === pluginsIndex);
  const elsewhere = occurrences.filter(o => path.resolve(o.file) !== pluginsIndex);

  if (inPlugins.length === 1 && elsewhere.length === 0) {
    console.log('OK: found exactly one "' + needle + '" occurrence in site/plugins/index.html and none elsewhere');
    process.exitCode = 0;
    return;
  }

  console.error('\nCheck failed: group-store placeholder usage did not meet expectations.');

  if (inPlugins.length !== 1) {
    console.error('\nProblem: expected exactly one "' + needle + '" in site/plugins/index.html but found', inPlugins.length + '.');
    if (inPlugins.length === 0) {
      console.error('Suggested fix: insert the following line immediately after the closing </div> of the .bundle block and before the .strip mt-6 element:');
      console.error('\n  <div id="group-store"></div>\n');
    } else {
      console.error('Occurrences in site/plugins/index.html (preview with surrounding lines):\n');
      for (let i = 0; i < inPlugins.length; i++) {
        const p = inPlugins[i];
        console.error('Occurrence #' + (i + 1) + ' (line ' + p.lineNumber + '):\n' + p.preview + '\n-----');
      }
      console.error('\nSuggested fix: keep exactly one of these occurrences and remove duplicates so only one "<div id=\"group-store\"" remains in site/plugins/index.html.');
    }
  }

  if (elsewhere.length) {
    console.error('\nProblem: found "' + needle + '" occurrence(s) outside site/plugins/index.html:');
    for (const p of elsewhere) {
      console.error('\nFile: ' + p.file + ' (line ' + p.lineNumber + ')');
      console.error('Preview:\n' + p.preview + '\n-----');
    }
    console.error('\nSuggested fix: remove the stray "<div id=\"group-store\"" occurrences from other pages so the placeholder only appears in site/plugins/index.html.');
  }

  console.error('\nScanned', htmlFiles.length, 'HTML file(s).');
  process.exitCode = 1;
}

main().catch(err => {
  console.error('Unexpected error:', err && err.stack || err);
  process.exit(2);
});
