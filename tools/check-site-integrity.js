#!/usr/bin/env node
'use strict';
/*
 * tools/check-site-integrity.js — the gaps tools/check-links.js leaves open.
 *
 * check-links.js proves that every linked FILE exists. This adds:
 *
 *   1. Broken fragments. An internal link "page.html#part" (or "#part" on the
 *      same page) must land on an element with id="part" (or <a name="part">)
 *      in that page. A link to a page that exists but a section that does not
 *      drops the reader at the top of the wrong page.
 *   2. Missing runtime assets. data-*-src / -href / -path / -url attributes
 *      name files a script fetches at runtime (preset JSON, support links);
 *      check-links.js deliberately skips data-* attributes, so a renamed file
 *      there only shows up as a broken feature in the browser.
 *   3. Plugin pages that do not render. Every product page listed in
 *      site/data/items.json, and every page under site/plugins/, must have
 *      one non-empty <h1>, real visible text in <main> (not just hidden
 *      notes), the shared stylesheet and ui.js, and — for a product — a Buy
 *      link (data-buy="<item id>") whose target and fragment exist.
 *
 * The browser-side half (pages render with no console error, a note plays,
 * the Buy link is visible) is tests/e2e/smoke.spec.js.
 *
 * Zero dependencies, Node 18+. Exit 0 when clean, 1 on any problem.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE = path.join(REPO_ROOT, 'site');
const ITEMS = path.join(SITE, 'data', 'items.json');
const PLUGINS = path.join(SITE, 'plugins');
const MIN_MAIN_TEXT = 200;   // characters of visible text a product page must carry

const problems = [];
function fail(file, line, msg) { problems.push(rel(file) + (line ? ':' + line : '') + '  ' + msg); }
function rel(p) { return path.relative(REPO_ROOT, p).split(path.sep).join('/'); }
function lineOf(text, index) { return text.slice(0, index).split('\n').length; }

function walk(dir, out) {
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.html?$/i.test(name)) out.push(full);
  }
  return out;
}

const htmlCache = new Map();
function html(file) {
  if (!htmlCache.has(file)) htmlCache.set(file, fs.readFileSync(file, 'utf8'));
  return htmlCache.get(file);
}

// ids and <a name> anchors a page declares in its markup.
const anchorCache = new Map();
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const text = html(file).replace(/<!--[\s\S]*?-->/g, '');
  const set = new Set();
  const re = /<[a-z][^>]*?\s(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(text)) !== null) set.add(m[1] !== undefined ? m[1] : m[2]);
  anchorCache.set(file, set);
  return set;
}

function isExternal(t) {
  return !t || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//');
}

// Resolve a site-relative target against the page that contains it.
function resolve(target, from) {
  const clean = target.replace(/[?#].*$/, '');
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch (e) { /* keep */ }
  if (decoded === '') return from;
  let p = decoded.startsWith('/') ? path.join(SITE, decoded) : path.resolve(path.dirname(from), decoded);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  return p;
}

/* ---- 1 + 2: fragments and data-* assets on every page ---------------- */

function checkLinks(file) {
  const text = html(file).replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const hrefRe = /(?<![\w-])href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = hrefRe.exec(text)) !== null) {
    const target = (m[1] !== undefined ? m[1] : m[2]).trim();
    if (isExternal(target) || target.indexOf('#') < 0) continue;
    const frag = target.slice(target.indexOf('#') + 1);
    if (!frag) continue;
    const dest = resolve(target, file);
    if (!/\.html?$/i.test(dest) || !fs.existsSync(dest)) continue;   // check-links.js reports missing files
    let id = frag;
    try { id = decodeURIComponent(frag); } catch (e) { /* keep */ }
    if (!anchorsOf(dest).has(id)) {
      fail(file, lineOf(text, m.index), 'link "' + target + '" points at #' + id + ', which ' + rel(dest) + ' does not define');
    }
  }

  const dataRe = /\sdata-[a-z0-9-]*-?(?:src|href|path|url)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  while ((m = dataRe.exec(text)) !== null) {
    const target = (m[1] !== undefined ? m[1] : m[2]).trim();
    if (isExternal(target) || target.startsWith('#')) continue;
    // A bare file name in a data-* attribute is resolved by the script that
    // reads it against the page, the same as an href.
    const dest = resolve(target, file);
    if (!fs.existsSync(dest)) {
      fail(file, lineOf(text, m.index), 'runtime asset "' + target + '" (' + m[0].trim().split('=')[0] + ') -> ' + rel(dest) + ' does not exist');
      continue;
    }
    const frag = target.indexOf('#') >= 0 ? target.slice(target.indexOf('#') + 1) : '';
    if (frag && /\.html?$/i.test(dest) && !anchorsOf(dest).has(frag)) {
      fail(file, lineOf(text, m.index), 'runtime link "' + target + '" points at #' + frag + ', which ' + rel(dest) + ' does not define');
    }
  }
}

/* ---- 3: plugin pages render ------------------------------------------ */

function visibleText(fragment) {
  return fragment
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    // drop elements shipped hidden (the bought notes) with their content
    .replace(/<(\w+)\b[^>]*\shidden(?:\s|=|>)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, 'x')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkPluginPage(file, item) {
  const text = html(file);
  const h1s = text.match(/<h1\b[^>]*>[\s\S]*?<\/h1\s*>/gi) || [];
  if (h1s.length !== 1) fail(file, 0, 'has ' + h1s.length + ' <h1> elements; a plugin page needs exactly one');
  else if (!visibleText(h1s[0])) fail(file, 0, 'its <h1> is empty');

  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(text);
  if (!main) {
    fail(file, 0, 'has no <main> element');
  } else {
    const words = visibleText(main[1]);
    if (words.length < MIN_MAIN_TEXT) {
      fail(file, lineOf(text, main.index), '<main> carries only ' + words.length + ' characters of visible text ("' +
           words.slice(0, 60) + '") — the page does not render any content');
    }
  }

  if (!/<link\b[^>]*rel\s*=\s*["']?stylesheet[^>]*assets\/style\.css/i.test(text) &&
      !/<link\b[^>]*assets\/style\.css[^>]*rel\s*=\s*["']?stylesheet/i.test(text)) {
    fail(file, 0, 'does not load assets/style.css');
  }
  if (!/<script\b[^>]*src\s*=\s*["'][^"']*assets\/js\/ui\.js["']/i.test(text)) fail(file, 0, 'does not load assets/js/ui.js');

  if (item) {
    const re = new RegExp('<a\\b[^>]*\\sdata-buy\\s*=\\s*["\']' + item.id + '["\'][^>]*>([\\s\\S]*?)</a\\s*>', 'i');
    const buy = re.exec(text);
    if (!buy) {
      fail(file, 0, 'has no Buy link for "' + item.id + '" (<a data-buy="' + item.id + '">)');
    } else {
      const href = (/\shref\s*=\s*["']([^"']*)["']/i.exec(buy[0]) || [])[1];
      if (!href) fail(file, lineOf(text, buy.index), 'its Buy link has no href');
      else if (!isExternal(href)) {
        const dest = resolve(href, file);
        const frag = href.indexOf('#') >= 0 ? href.slice(href.indexOf('#') + 1) : '';
        if (!fs.existsSync(dest)) fail(file, lineOf(text, buy.index), 'its Buy link goes to ' + rel(dest) + ', which does not exist');
        else if (frag && !anchorsOf(dest).has(frag)) fail(file, lineOf(text, buy.index), 'its Buy link goes to #' + frag + ', which ' + rel(dest) + ' does not define');
      }
      if (!/\bBuy\b/.test(visibleText(buy[1]))) fail(file, lineOf(text, buy.index), 'its Buy link does not say "Buy"');
    }
  }
}

function main() {
  if (!fs.existsSync(SITE)) { console.error('check-site-integrity: site/ not found'); process.exit(1); }
  const pages = walk(SITE).sort();
  pages.forEach(checkLinks);

  let items = [];
  try { items = JSON.parse(fs.readFileSync(ITEMS, 'utf8')); } catch (e) {
    fail(ITEMS, 0, 'cannot be read as JSON: ' + e.message);
  }
  const byPage = new Map();
  for (const it of items) {
    if (!it || !it.page) continue;
    const file = path.resolve(PLUGINS, it.page);
    if (!fs.existsSync(file)) { fail(ITEMS, 0, 'item "' + it.id + '" lists page ' + it.page + ', which does not exist'); continue; }
    // The bundle points at the shop page itself; it is checked as a plugin page, without a Buy link of its own.
    if (path.basename(file) !== 'index.html') byPage.set(file, it);
  }
  const pluginPages = pages.filter((p) => path.dirname(p) === PLUGINS);
  if (!pluginPages.length) fail(PLUGINS, 0, 'contains no pages');
  pluginPages.forEach((p) => checkPluginPage(p, byPage.get(p) || null));

  if (problems.length) {
    problems.forEach((p) => console.error(p));
    console.error('\ncheck-site-integrity: ' + problems.length + ' problem(s) in ' + pages.length + ' page(s)');
    process.exit(1);
  }
  console.log('check-site-integrity: ok — fragments, runtime assets and ' + pluginPages.length +
              ' plugin page(s) checked across ' + pages.length + ' page(s)');
  process.exit(0);
}

if (require.main === module) main();
