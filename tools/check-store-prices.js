#!/usr/bin/env node
'use strict';
/*
 * tools/check-store-prices.js — keep every price AND every item description the
 * shop shows in agreement.
 *
 * Three places state what things cost:
 *   - the root .d8a `items:` block (the source of truth: the platform reads it
 *     after every merge and it is what a buyer is actually charged),
 *   - site/data/items.json (the local storefront fallback),
 *   - the product cards and the bundle block on site/index.html.
 *
 * This guard asserts:
 *   1. every name in site/data/items.json exists in .d8a items: with the same price,
 *   2. every product card price on the homepage matches the .d8a price for that
 *      name (compared numerically, so "$149" and "$149.00" agree),
 *   3. the bundle price shown on the homepage matches the .d8a bundle price,
 *   4. the advertised "Save $N" figure equals the sum of the non-bundle .d8a
 *      prices minus the bundle price,
 *   5. every name present in BOTH .d8a items: and site/data/items.json carries
 *      the same description (whitespace-normalised), so the platform's own item
 *      list never advertises different words from the site,
 *   6. every .d8a items: line stays inside the 300-character limit the platform
 *      enforces, and no description stops mid-sentence (a truncated line used to
 *      pass unnoticed because only the price was ever read).
 *
 * It only READS .d8a; it never edits it. Zero dependencies, Node 18+.
 *
 * Usage: node tools/check-store-prices.js   (exit 0 = agreement, 1 = drift, 2 = unreadable)
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const D8A_FILE = path.join(REPO_ROOT, '.d8a');
const ITEMS_JSON = path.join(REPO_ROOT, 'site', 'data', 'items.json');
const INDEX_HTML = path.join(REPO_ROOT, 'site', 'index.html');

// The bundle row, by the name it carries in .d8a and items.json.
const BUNDLE_NAME = 'The Full Shop';

const problems = [];
function fail(msg) { problems.push(msg); }

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error('check-store-prices: cannot read ' + path.relative(REPO_ROOT, file) +
      ' — ' + (err && err.message));
    process.exit(2);
  }
}

/** "$1,299.00" / "$149" -> 1299 / 149 ; anything else -> null */
function toNumber(price) {
  if (price === null || price === undefined) return null;
  const m = String(price).trim().match(/^\$?\s*([0-9][0-9,]*)(?:\.([0-9]{1,2}))?$/);
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ''));
  const cents = m[2] ? Number((m[2] + '0').slice(0, 2)) : 0;
  if (!Number.isFinite(whole)) return null;
  return whole + cents / 100;
}

function money(n) {
  return '$' + n.toFixed(2);
}

/** Collapse runs of whitespace so wrapping/indentation never counts as drift. */
function normText(s) {
  return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
}

/** The platform's own ceiling for one `items:` line. */
const MAX_ITEM_LINE = 300;

/**
 * A finished sentence ends in terminal punctuation (optionally closed by a
 * bracket or quote). "…demo, p" does not, which is exactly the shape that
 * shipped a half-written flagship blurb.
 */
function looksFinished(description) {
  return /[.!?…][)"'”’]?$/.test(description.trim());
}

/**
 * The `items:` block of .d8a: a column-0 `items:` key, then two-space indented
 * lines of the form `Name = $12.00 — description`. The block ends at the next
 * column-0 `key:` line; `#` comments are skipped.
 *
 * Returns Map<name, { price, description, length }>. The description is
 * everything after the FIRST dash separator that follows the price, so a dash
 * inside the sentence ("Public beta — the 1.0 release…") is kept intact.
 */
function parseD8aItems(text) {
  const lines = text.split(/\r?\n/);
  const items = new Map();
  let inBlock = false;

  for (const raw of lines) {
    if (/^items:\s*$/.test(raw)) { inBlock = true; continue; }
    if (!inBlock) continue;
    if (/^#/.test(raw)) continue;                 // a comment never ends the block
    if (/^\S/.test(raw) && raw.trim() !== '') break; // next column-0 key: block over
    const line = raw.trim();
    if (!line) continue;

    const eq = line.indexOf('=');
    if (eq === -1) { fail('.d8a items: line is not `Name = $0.00 — text`: ' + line); continue; }
    const name = line.slice(0, eq).trim();
    const rest = line.slice(eq + 1).trim();
    const sep = rest.match(/\s+[—–-]\s+/);
    const priceText = (sep ? rest.slice(0, sep.index) : rest).trim();
    const description = sep ? rest.slice(sep.index + sep[0].length).trim() : '';
    const value = toNumber(priceText);
    if (!name) { fail('.d8a items: line has no name: ' + line); continue; }
    if (value === null) { fail('.d8a items: line has no readable price: ' + line); continue; }
    if (items.has(name)) { fail('.d8a items: lists "' + name + '" more than once'); continue; }
    items.set(name, { price: value, description: description, length: raw.length });
  }

  if (!inBlock) fail('.d8a has no `items:` block — the shop would be paused.');
  else if (!items.size) fail('.d8a `items:` block is empty — the shop would be paused.');
  return items;
}

/** The product cards on the homepage: one <article> per card. */
function parseHomepageCards(html) {
  const cards = [];
  const articles = html.match(/<article\b[\s\S]*?<\/article>/gi) || [];
  for (const article of articles) {
    const title = article.match(/<h3[^>]*class="[^"]*\bcard__title\b[^"]*"[^>]*>([\s\S]*?)<\/h3>/i);
    const price = article.match(/<p[^>]*class="[^"]*\bcard__price\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (!title || !price) continue;               // not a priced product card
    const name = title[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const priceText = price[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    cards.push({ name: name, priceText: priceText, price: toNumber(priceText) });
  }
  return cards;
}

function main() {
  const d8aText = read(D8A_FILE);
  const itemsText = read(ITEMS_JSON);
  const html = read(INDEX_HTML);

  const d8aItems = parseD8aItems(d8aText);

  // ---- 1. items.json agrees with .d8a -------------------------------------
  let itemsJson = null;
  try {
    itemsJson = JSON.parse(itemsText);
  } catch (err) {
    fail('site/data/items.json is not valid JSON — ' + (err && err.message));
  }
  if (itemsJson && !Array.isArray(itemsJson)) {
    fail('site/data/items.json should be an array of items.');
    itemsJson = null;
  }
  if (itemsJson) {
    for (const entry of itemsJson) {
      const name = entry && entry.name ? String(entry.name).trim() : '';
      if (!name) { fail('site/data/items.json has an entry with no name.'); continue; }
      if (!d8aItems.has(name)) {
        fail('site/data/items.json lists "' + name + '" but the .d8a items: block does not — ' +
          'a name missing from .d8a is PAUSED and cannot be bought.');
        continue;
      }
      const local = toNumber(entry.price);
      if (local === null) {
        fail('site/data/items.json price for "' + name + '" is not a price: ' + JSON.stringify(entry.price));
        continue;
      }
      const truth = d8aItems.get(name);
      if (local !== truth.price) {
        fail('price drift for "' + name + '": site/data/items.json says ' + money(local) +
          ', .d8a says ' + money(truth.price) + '.');
      }

      // ---- 5. the words, not just the number ------------------------------
      const localText = normText(entry.description);
      const truthText = normText(truth.description);
      if (localText && truthText && localText !== truthText) {
        fail('description drift for "' + name + '":\n' +
          '      .d8a               : ' + truthText + '\n' +
          '      site/data/items.json: ' + localText);
      } else if (localText && !truthText) {
        fail('description drift for "' + name + '": site/data/items.json describes it but the ' +
          '.d8a items: line carries no description, so the platform lists a bare name.');
      }
    }
  }

  // ---- 2. homepage cards agree with .d8a ----------------------------------
  const cards = parseHomepageCards(html);
  if (!cards.length) {
    fail('site/index.html: found no product card (an <article> holding both ' +
      'h3.card__title and p.card__price) — has the card markup been renamed?');
  }
  for (const card of cards) {
    if (card.price === null) {
      fail('site/index.html: card "' + card.name + '" has an unreadable price "' + card.priceText + '".');
      continue;
    }
    if (!d8aItems.has(card.name)) {
      fail('site/index.html: card "' + card.name + '" is not in the .d8a items: block, ' +
        'so the page advertises something the shop does not sell.');
      continue;
    }
    const truth = d8aItems.get(card.name);
    if (card.price !== truth.price) {
      fail('price drift for "' + card.name + '": site/index.html shows ' + card.priceText +
        ', .d8a says ' + money(truth.price) + '.');
    }
  }

  // ---- 6. every .d8a items: line is a whole, legal line --------------------
  for (const [name, item] of d8aItems) {
    if (item.length > MAX_ITEM_LINE) {
      fail('.d8a items: line for "' + name + '" is ' + item.length + ' characters — the platform ' +
        'skips any line over ' + MAX_ITEM_LINE + ', which would PAUSE that product.');
    }
    if (item.description && !looksFinished(item.description)) {
      fail('.d8a items: description for "' + name + '" stops mid-sentence: "…' +
        item.description.slice(-40) + '". Restore the full sentence (site/data/items.json has it).');
    }
  }

  // ---- 3 & 4. the bundle block -------------------------------------------
  const bundleTruth = d8aItems.has(BUNDLE_NAME) ? d8aItems.get(BUNDLE_NAME).price : null;
  if (bundleTruth === null) {
    fail('.d8a items: has no "' + BUNDLE_NAME + '" row, so the homepage bundle block ' +
      'cannot be checked against it.');
  }

  // The headline price, matched inside a single <h2 class="sec-head__title"> …
  // </h2> so it can never pair a heading with a price from another section.
  const shownBundle = html.match(
    /<h2[^>]*class="[^"]*\bsec-head__title\b[^"]*"[^>]*>(?:(?!<\/h2>)[\s\S])*?<span class="num accent">\s*\$([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*<\/span>/i
  );
  if (!shownBundle) {
    fail('site/index.html: could not find the bundle headline price ' +
      '(h2.sec-head__title with a span.num.accent) — has the bundle block been restyled?');
  } else if (bundleTruth !== null) {
    const shown = toNumber(shownBundle[1]);
    if (shown !== bundleTruth) {
      fail('bundle price drift: site/index.html headline shows ' + money(shown) +
        ', .d8a says ' + money(bundleTruth) + '.');
    }
  }

  const savingMatch = html.match(/Save\s*<span class="num">\s*\$([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*<\/span>/i);
  if (!savingMatch) {
    fail('site/index.html: could not find the "Save $N" line in the bundle block — ' +
      'has the copy changed? The saving must stay checkable.');
  } else if (bundleTruth !== null) {
    let separately = 0;
    for (const [name, item] of d8aItems) {
      if (name === BUNDLE_NAME) continue;
      separately += item.price;
    }
    const expected = separately - bundleTruth;
    const shownSaving = toNumber(savingMatch[1]);
    if (shownSaving !== expected) {
      fail('the advertised saving is wrong: site/index.html says "Save ' + money(shownSaving) +
        '" but the individual plugins come to ' + money(separately) + ' and the bundle is ' +
        money(bundleTruth) + ', so the saving is ' + money(expected) + '.');
    }
  }

  if (problems.length) {
    console.error('check-store-prices: FAILED — the shop does not agree with itself.\n');
    for (const p of problems) console.error('  - ' + p);
    console.error('\nThe .d8a items: block is the source of truth for price AND wording: fix the ' +
      'page or site/data/items.json to match it (or change .d8a items: deliberately, in the same change).');
    process.exit(1);
  }

  console.log('check-store-prices: OK — ' + d8aItems.size + ' item(s) in .d8a, ' +
    (itemsJson ? itemsJson.length : 0) + ' in site/data/items.json and ' + cards.length +
    ' homepage card(s) all agree on price and wording, every items: line is whole and inside ' +
    MAX_ITEM_LINE + ' characters, and the advertised bundle saving adds up.');
}

if (require.main === module) main();
