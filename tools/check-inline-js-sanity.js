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

function hasSrcAttribute(attrStr) {
  return /\bsrc\b\s*=\s*/i.test(attrStr);
}

function isModuleScript(attrStr) {
  return /\btype\b\s*=\s*["']?\s*module\s*["']?/i.test(attrStr);
}

function previewText(s, maxChars = 320) {
  const trimmed = s.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars) + '\n...';
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

  const scriptTagRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let filesScanned = 0;
  let scriptsChecked = 0;
  const problems = [];

  for (const file of htmlFiles) {
    let txt;
    try {
      txt = await fs.readFile(file, 'utf8');
    } catch (err) {
      console.error('Failed to read', file, err && err.message);
      continue;
    }
    filesScanned++;

    let match;
    let scriptIndex = 0;
    while ((match = scriptTagRe.exec(txt)) !== null) {
      scriptIndex++;
      const attr = match[1] || '';
      const body = match[2] || '';
      if (hasSrcAttribute(attr) || isModuleScript(attr)) {
        continue; // skip external or module scripts
      }
      scriptsChecked++;
      // Compute 1-based line number where this script tag starts
      const startIndex = match.index;
      const before = txt.slice(0, startIndex);
      const lineNumber = before.split('\n').length;

      try {
        // Only check syntax — don't execute. new Function parses code.
        // Wrap in try/catch so we can continue scanning other files.
        /* eslint-disable no-new-func */
        new Function(body);
      } catch (err) {
        problems.push({ file, scriptIndex, lineNumber, error: err && err.message, preview: previewText(body) });
      }
    }
  }

  if (problems.length) {
    console.error('\nInline script syntax check failed — found', problems.length, 'problem(s):\n');
    for (const p of problems) {
      console.error('File:', p.file);
      console.error('Script #:', p.scriptIndex, ' (starts at line', p.lineNumber + ')');
      console.error('Error:', p.error);
      console.error('Preview:\n' + p.preview.split('\n').map(l => '  ' + l).join('\n'));
      console.error('-----\n');
    }
    console.error('Scanned', filesScanned, 'HTML file(s), checked', scriptsChecked, 'inline script(s).');
    process.exitCode = 1;
    return;
  }

  console.log('All inline scripts parsed OK. Scanned', filesScanned, 'HTML file(s), checked', scriptsChecked, 'inline script(s).');
  process.exitCode = 0;
}

main().catch(err => {
  console.error('Unexpected error:', err && err.stack || err);
  process.exit(2);
});
