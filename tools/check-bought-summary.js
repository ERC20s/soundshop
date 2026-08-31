#!/usr/bin/env node
'use strict';
/*
 * tools/check-bought-summary.js — fail when a product page under site/plugins/
 * lacks the required data-bought-summary element with proper child elements and
 * formatting attributes. Zero-dependency Node 18+ script.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

// Product pages that must have data-bought-summary
const PRODUCT_PAGES = {
  'flagship.html': 'vanta',
  'drift.html': 'drift',
  'prism.html': 'prism',
  'anvil.html': 'anvil'
};

const OPT_OUT_RE = /<!--\s*no-bought-summary-check\s*-->/i;

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
    console.error('check-bought-summary: site/ directory not found at ' + SITE_DIR);
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

    // Look for data-bought-summary element
    const boughtSummaryRe = /data-bought-summary/i;
    const boughtSummaryMatch = boughtSummaryRe.exec(text);

    if (!boughtSummaryMatch) {
      violations.push({
        file,
        line: 1,
        reason: 'missing data-bought-summary element'
      });
      continue;
    }

    // Find the opening tag containing data-bought-summary
    const openingTagMatch = /(<[^>]*data-bought-summary[^>]*>)/i.exec(text);
    if (!openingTagMatch) {
      const line = lineOf(text, boughtSummaryMatch.index);
      violations.push({
        file,
        line,
        reason: 'malformed data-bought-summary element'
      });
      continue;
    }

    const startIdx = openingTagMatch.index;
    const openingTag = openingTagMatch[1];

    // Extract the tag name from opening tag
    const tagMatch = /<(\w+)[^>]*data-bought-summary/i.exec(openingTag);
    if (!tagMatch) {
      const line = lineOf(text, startIdx);
      violations.push({
        file,
        line,
        reason: 'could not extract tag name from data-bought-summary element'
      });
      continue;
    }

    const tagName = tagMatch[1];
    // Find the corresponding closing tag
    const closePattern = new RegExp('</' + tagName + '>', 'i');
    let endIdx = text.length;
    const closeMatch = closePattern.exec(text.substring(startIdx));
    if (closeMatch) {
      endIdx = startIdx + closeMatch.index + closeMatch[0].length;
    }

    const elementContent = text.substring(startIdx, endIdx);

    // Check for required attributes on the opening tag
    const hasDatePrefix = /data-bought-summary-date-prefix/i.test(openingTag);
    const hasRefPrefix = /data-bought-summary-ref-prefix/i.test(openingTag);
    const hasRefSuffix = /data-bought-summary-ref-suffix/i.test(openingTag);
    const hasNoRef = /data-bought-summary-noref/i.test(openingTag);

    // Check for required child elements
    const hasBoughtSummaryList = /data-bought-summary-list/i.test(elementContent);
    const hasBoughtSummaryLabels = /data-bought-summary-labels/i.test(elementContent);

    const problems = [];
    if (!hasDatePrefix) problems.push('missing data-bought-summary-date-prefix attribute');
    if (!hasRefPrefix) problems.push('missing data-bought-summary-ref-prefix attribute');
    if (!hasRefSuffix) problems.push('missing data-bought-summary-ref-suffix attribute');
    if (!hasNoRef) problems.push('missing data-bought-summary-noref attribute');
    if (!hasBoughtSummaryList) problems.push('missing data-bought-summary-list child element');
    if (!hasBoughtSummaryLabels) problems.push('missing data-bought-summary-labels span');

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
    console.error('\ncheck-bought-summary: ' + violations.length + ' problem(s) found');
    process.exit(1);
  }

  console.log('check-bought-summary: ok — all product pages include proper data-bought-summary markup');
  process.exit(0);
}

if (require.main === module) main();
