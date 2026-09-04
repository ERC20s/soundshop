#!/usr/bin/env node
'use strict';
/*
 * tools/check-bought-summary.js — fail when a product page under site/plugins/
 * lacks the required data-bought-summary element with proper child elements and
 * formatting attributes. Zero-dependency Node 18+ script.
 *
 * It also checks, on EVERY page under site/plugins/ that carries the block, that
 * a Support link inside the block agrees with the block's own
 * data-bought-summary-support-href attribute: a page that declares
 * data-bought-summary-support-href="../docs.html#support" must not also hard-code
 * <a href="docs.html#support"> in the same element, because from site/plugins/
 * that resolves to the non-existent site/plugins/docs.html.
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

// Read a double- or single-quoted attribute value off an opening tag.
function attrValue(openingTag, name) {
  const re = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i');
  const m = re.exec(openingTag);
  if (!m) return null;
  return m[2] !== undefined ? m[2] : m[3];
}

// Locate the data-bought-summary element in a page. Returns null when the page
// does not carry one (index.html and the product pages both carry one today).
function findBoughtSummary(text) {
  const openingTagMatch = /(<\w+[^>]*\bdata-bought-summary\b[^>]*>)/i.exec(text);
  if (!openingTagMatch) return null;

  const startIdx = openingTagMatch.index;
  const openingTag = openingTagMatch[1];
  const tagMatch = /<(\w+)/.exec(openingTag);
  if (!tagMatch) return null;

  const tagName = tagMatch[1];
  const closePattern = new RegExp('</' + tagName + '>', 'i');
  let endIdx = text.length;
  const closeMatch = closePattern.exec(text.substring(startIdx));
  if (closeMatch) endIdx = startIdx + closeMatch.index + closeMatch[0].length;

  return { startIdx, endIdx, openingTag, content: text.substring(startIdx, endIdx) };
}

// Rule: inside a data-bought-summary block, any link whose target ends in
// docs.html#support must be exactly the value the block declares in
// data-bought-summary-support-href. A block that declares no such attribute is
// left alone — there is nothing on the page to compare against.
function checkSupportLinks(file, text, violations) {
  const block = findBoughtSummary(text);
  if (!block) return;

  const expected = attrValue(block.openingTag, 'data-bought-summary-support-href');
  if (!expected) return;

  const linkRe = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(block.content)) !== null) {
    const href = m[2] !== undefined ? m[2] : m[3];
    if (!/docs\.html#support$/i.test(href)) continue;
    if (href === expected) continue;
    violations.push({
      file,
      line: lineOf(text, block.startIdx + m.index),
      reason: 'bought-summary Support link href="' + href + '" does not match this block\'s ' +
        'data-bought-summary-support-href="' + expected + '" (a page-relative "docs.html#support" ' +
        'resolves to site/plugins/docs.html, which does not exist)'
    });
  }
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

  // Second pass: the Support-link rule, on every page under site/plugins/ that
  // carries a bought-summary block (index.html included, not just the four
  // product pages).
  let pluginPages = [];
  try {
    pluginPages = fs.readdirSync(pluginsDir)
      .filter((name) => /\.html$/i.test(name))
      .sort();
  } catch (err) {
    pluginPages = [];
  }

  for (const name of pluginPages) {
    const file = path.join(pluginsDir, name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      continue;
    }
    if (OPT_OUT_RE.test(text)) continue;
    checkSupportLinks(file, text, violations);
  }

  violations.sort((a, b) => rel(a.file).localeCompare(rel(b.file)) || a.line - b.line);

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

  console.log('check-bought-summary: ok — all product pages include proper data-bought-summary markup, ' +
    'and every Support link inside a bought-summary block matches its own support-href');
  process.exit(0);
}

if (require.main === module) main();
