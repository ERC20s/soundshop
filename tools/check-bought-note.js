#!/usr/bin/env node
'use strict';
/*
 * tools/check-bought-note.js — fail when a product page under site/plugins/
 * lacks the required data-bought-note element with correct data-bought-item value
 * and the required data-bought-cover and data-bought-date spans. Zero-dependency
 * Node 18+ script.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

// Map product page filename to expected data-bought-item value
const PRODUCT_PAGES = {
  'flagship.html': 'vanta',
  'drift.html': 'drift',
  'prism.html': 'prism',
  'anvil.html': 'anvil'
};

const OPT_OUT_RE = /<!--\s*no-bought-note-check\s*-->/i;

function walk(dir, out) {
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.html?$/i.test(name)) out.push(full);
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/');
}

function main() {
  if (!fs.existsSync(SITE_DIR)) {
    console.error('check-bought-note: site/ directory not found at ' + SITE_DIR);
    process.exit(2);
  }

  const pluginsDir = path.join(SITE_DIR, 'plugins');
  const violations = [];

  for (const [filename, expectedItem] of Object.entries(PRODUCT_PAGES)) {
    const file = path.join(pluginsDir, filename);

    if (!fs.existsSync(file)) {
      violations.push({
        file,
        line: 0,
        reason: 'product page does not exist'
      });
      continue;
    }

    const text = fs.readFileSync(file, 'utf8');

    if (OPT_OUT_RE.test(text)) continue;

    // Look for data-bought-note element with correct data-bought-item value
    const boughtNoteRe = /data-bought-note[^>]*data-bought-item\s*=\s*["']?([^"'\s>]+)["']?/i;
    const boughtNoteMatch = boughtNoteRe.exec(text);

    if (!boughtNoteMatch) {
      // Try alternative order: data-bought-item before data-bought-note
      const altRe = /data-bought-item\s*=\s*["']?([^"'\s>]+)["']?[^>]*data-bought-note/i;
      const altMatch = altRe.exec(text);
      if (!altMatch) {
        const line = 1; // Default to line 1 if not found
        violations.push({
          file,
          line,
          reason: 'missing data-bought-note element with data-bought-item attribute'
        });
        continue;
      }
      // Check if the value matches
      if (altMatch[1] !== expectedItem) {
        const line = lineOf(text, altMatch.index);
        violations.push({
          file,
          line,
          reason: 'data-bought-item="' + altMatch[1] + '" but expected "' + expectedItem + '"'
        });
        continue;
      }
    } else if (boughtNoteMatch[1] !== expectedItem) {
      const line = lineOf(text, boughtNoteMatch.index);
      violations.push({
        file,
        line,
        reason: 'data-bought-item="' + boughtNoteMatch[1] + '" but expected "' + expectedItem + '"'
      });
      continue;
    }

    // Now verify the data-bought-note element contains required spans
    // Find the opening tag of data-bought-note
    const openingTagMatch = /(<[^>]*data-bought-note[^>]*>)/i.exec(text);
    if (!openingTagMatch) {
      const line = 1;
      violations.push({
        file,
        line,
        reason: 'malformed data-bought-note element'
      });
      continue;
    }

    const startIdx = openingTagMatch.index;
    // Find the closing tag (looking for </div> or </span> etc that closes the data-bought-note)
    // For simplicity, we'll look for the nearest closing tag after the opening
    let endIdx = text.indexOf('</div>', startIdx);
    let tagName = 'div';

    // Extract the tag name from opening tag
    const tagMatch = /<(\w+)[^>]*data-bought-note/.exec(text.substring(startIdx));
    if (tagMatch) {
      tagName = tagMatch[1];
    }

    // Find the corresponding closing tag
    if (endIdx === -1) {
      endIdx = text.length;
    } else {
      // Look for the matching closing tag
      let closePattern = new RegExp('</' + tagName + '>', 'i');
      let match = closePattern.exec(text.substring(startIdx));
      if (match) {
        endIdx = startIdx + match.index + match[0].length;
      }
    }

    const elementContent = text.substring(startIdx, endIdx);

    // Check for required spans
    const hasBoughtCover = /data-bought-cover/i.test(elementContent);
    const hasBoughtDate = /data-bought-date/i.test(elementContent);

    const problems = [];
    if (!hasBoughtCover) problems.push('missing data-bought-cover span');
    if (!hasBoughtDate) problems.push('missing data-bought-date span');

    if (problems.length > 0) {
      const line = lineOf(text, startIdx);
      violations.push({
        file,
        line,
        reason: problems.join('; ')
      });
    }
  }

  if (violations.length > 0) {
    for (const v of violations) {
      if (v.line > 0) {
        console.error(rel(v.file) + ':' + v.line + '  ' + v.reason);
      } else {
        console.error(rel(v.file) + '  ' + v.reason);
      }
    }
    console.error('\ncheck-bought-note: ' + violations.length + ' problem(s) found');
    process.exit(1);
  }

  console.log('check-bought-note: ok — all product pages include proper data-bought-note markup');
  process.exit(0);
}

if (require.main === module) main();
