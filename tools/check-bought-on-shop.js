#!/usr/bin/env node
'use strict';
/*
 * tools/check-bought-on-shop.js — fail when site/plugins/index.html
 * lacks the required data-bought-summary element and data-bought-summary-list child.
 * Zero-dependency Node 18+ script.
 */

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

  // Check for data-bought-summary element
  const hasBoughtSummary = /data-bought-summary/i.test(txt);
  if (!hasBoughtSummary) {
    console.error('check-bought-on-shop: missing data-bought-summary element in site/plugins/index.html');
    process.exit(1);
  }

  // Check for data-bought-summary-list element
  const hasBoughtSummaryList = /data-bought-summary-list/i.test(txt);
  if (!hasBoughtSummaryList) {
    console.error('check-bought-on-shop: missing data-bought-summary-list element in site/plugins/index.html');
    process.exit(1);
  }

  console.log('check-bought-on-shop: ok — plugins/index.html includes proper data-bought-summary markup');
  process.exit(0);
}

if (require.main === module) main().catch(err => {
  console.error('Unexpected error:', err && err.stack || err);
  process.exit(2);
});
