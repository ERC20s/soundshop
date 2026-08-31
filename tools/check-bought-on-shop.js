#!/usr/bin/env node
'use strict';
/*
 * tools/check-bought-on-shop.js — fail when site/plugins/index.html
 * lacks the required data-bought-summary element with all required attributes and
 * child elements. Zero-dependency Node 18+ script.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/');
}

function main() {
  const file = path.join(SITE_DIR, 'plugins', 'index.html');

  if (!fs.existsSync(file)) {
    console.error('check-bought-on-shop: site/plugins/index.html does not exist');
    process.exit(2);
  }

  const text = fs.readFileSync(file, 'utf8');

  // Look for data-bought-summary element
  const boughtSummaryRe = /data-bought-summary/i;
  const boughtSummaryMatch = boughtSummaryRe.exec(text);

  if (!boughtSummaryMatch) {
    console.error('check-bought-on-shop: missing data-bought-summary element in site/plugins/index.html');
    process.exit(1);
  }

  // Find the opening tag containing data-bought-summary
  const openingTagMatch = /(<[^>]*data-bought-summary[^>]*>)/i.exec(text);
  if (!openingTagMatch) {
    const line = lineOf(text, boughtSummaryMatch.index);
    console.error(rel(file) + ':' + line + '  malformed data-bought-summary element');
    process.exit(1);
  }

  const startIdx = openingTagMatch.index;
  const openingTag = openingTagMatch[1];

  // Extract the tag name from opening tag
  const tagMatch = /<(\w+)[^>]*data-bought-summary/i.exec(openingTag);
  if (!tagMatch) {
    const line = lineOf(text, startIdx);
    console.error(rel(file) + ':' + line + '  could not extract tag name from data-bought-summary element');
    process.exit(1);
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
    console.error(rel(file) + ':' + line + '  ' + problems.join('; '));
    console.error('\ncheck-bought-on-shop: 1 problem(s) found');
    process.exit(1);
  }

  console.log('check-bought-on-shop: ok — plugins/index.html includes proper data-bought-summary markup');
  process.exit(0);
}

if (require.main === module) main().catch(err => {
  console.error('Unexpected error:', err && err.stack || err);
  process.exit(2);
});
