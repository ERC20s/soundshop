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

function previewText(s, maxChars = 320) {
  const trimmed = String(s).trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars) + '\n...';
}

// Canonical payments block copied verbatim from the repository's .d8a
const canonicalPaymentsBlock = `  <!-- Sell on your site: your items, a Buy button each. After a payment the buyer
       returns here with ?d8a_order=<id>; the widget verifies it with the platform and
       fires "group-store:paid" (window.groupStorePaid) — release the product there. -->
  <div id="group-store"></div>
  <script>
  (function () {
    var BASE = "https://d8a.com";
    var GROUP = "batch-synthshop";
    var esc = function (s) {
      return String(s).replace(/[&<>\"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; });
    };
    var el = document.getElementById("group-store");
    // The handshake: an order id is only proof once the platform says so.
    var verify = function (id) {
      return fetch(BASE + "/api/v1/store/orders/" + encodeURIComponent(id) + "?group=" + encodeURIComponent(GROUP))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { return d && d.paid ? d.order : null; })
        .catch(function () { return null; });
    };
    window.groupStoreVerify = verify;
    var back = (location.search.match(/[?&]d8a_order=([A-Za-z0-9_-]+)/) || [])[1];
    if (back) verify(back).then(function (o) {
      if (!o) return;
      window.groupStorePaid = o;
      if (el && el.parentNode) {
        var p = document.createElement("p");
        p.setAttribute("data-paid", o.id);
        p.style.cssText = "font:13px system-ui,sans-serif;color:#059669";
        p.innerHTML = "Paid: " + esc(o.itemName) + (o.quantity > 1 ? " \u00d7" + o.quantity : "") + " \u2014 order " + esc(o.id);
        el.parentNode.insertBefore(p, el);
      }
      document.dispatchEvent(new CustomEvent("group-store:paid", { detail: o }));
    });
    fetch(BASE + "/api/v1/store/items?group=" + encodeURIComponent(GROUP))
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (!el || !s.items) return;
        if (!s.items.length) { el.innerHTML = '<p style="font:13px system-ui,sans-serif;color:#9ca3af">Nothing for sale right now.</p>'; return; }
        el.innerHTML = s.items.map(function (it) {
          return '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid #e5e7eb;font:14px system-ui,sans-serif">' +
            '<div style="flex:1"><b>' + esc(it.name) + '</b>' +
            (it.description ? '<div style="font-size:12px;color:#6b7280">' + esc(it.description) + '</div>' : '') + '</div>' +
            '<span>' + esc(it.price) + '</span>' +
            '<a href="' + esc(it.payUrl) + '" data-item="' + esc(it.id) + '" style="background:#7c5cff;color:#fff;border-radius:999px;padding:6px 14px;text-decoration:none">Buy</a></div>';
        }).join("") + '<p style="font:11px system-ui,sans-serif;color:#9ca3af">Sold by <a href="' + esc(s.group.url) + '" style="color:#7c5cff">' + esc(s.group.name) + '</a></p>';
        el.addEventListener("click", function (e) {
          var a = e.target && e.target.closest ? e.target.closest("a[data-item]") : null;
          if (!a || !s.checkout.enabled) return;
          e.preventDefault();
          a.textContent = "Opening\u2026";
          // Come back to this page — minus any earlier receipt on the URL.
          var here = location.href.replace(/([?&])d8a_order=[^&#]*&?/, "$1").replace(/[?&](#|$)/, "$1");
          fetch(s.checkout.url, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ group: GROUP, item: a.getAttribute("data-item"), quantity: 1, returnUrl: here }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.url) { location.href = d.url; } else { a.textContent = "Buy"; location.href = a.href; } })
            .catch(function () { location.href = a.href; });
        });
      });
  })();
  </script>`;

// Replace JavaScript strings and comments with spaces (preserving newlines) so
// GROUP=... searches ignore text that only appears inside quotes or comments.
function stripJsStringsAndComments(src) {
  if (!src) return src;
  // Matches: double-quoted strings, single-quoted strings, template literals,
  // block comments /* ... */ and line comments //...
  const re = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^\\`])*`|\/\*[\s\S]*?\*\/|\/\/[^\n\r]*)/g;
  return src.replace(re, m => m.replace(/[^\n]/g, ' '));
}

async function extractGroupFromPluginsPage(root) {
  // Read the plugins index specifically — that's the authoritative page this check targets
  const p = path.join(root, 'plugins', 'index.html');
  let txt;
  try {
    txt = await fs.readFile(p, 'utf8');
  } catch (err) {
    return null;
  }

  const scriptTagRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const attrSrcRe = /\bsrc\b\s*=\s*/i;
  const moduleTypeRe = /\btype\b\s*=\s*["']?\s*module\s*["']?/i;
  const groupAssignRe = /\bGROUP\b\s*=\s*['"]([^'"]+)['"]/;

  let match;
  while ((match = scriptTagRe.exec(txt)) !== null) {
    const attr = match[1] || '';
    const body = match[2] || '';
    if (attrSrcRe.test(attr) || moduleTypeRe.test(attr)) continue; // ignore external or module scripts
    const scrubbed = stripJsStringsAndComments(body);
    const m = groupAssignRe.exec(scrubbed);
    if (m) return m[1];
  }
  return null;
}

function extractGroupFromCanonicalBlock(block) {
  const groupAssignRe = /\bGROUP\b\s*=\s*['"]([^'"]+)['"]/;
  const m = groupAssignRe.exec(block);
  return m ? m[1] : null;
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
  const attrSrcRe = /\bsrc\b\s*=\s*/i;
  const moduleTypeRe = /\btype\b\s*=\s*["']?\s*module\s*["']?/i;
  const groupAssignRe = /\bGROUP\b\s*=\s*['"]([^\'"]+)['"]/g;

  // Derive the expected GROUP from the plugins page, then canonical block, then fallback
  let expectedGroup = null;
  try {
    const fromPlugins = await extractGroupFromPluginsPage(root);
    const fromCanonical = extractGroupFromCanonicalBlock(canonicalPaymentsBlock);
    expectedGroup = fromPlugins || fromCanonical || 'soundshop';
  } catch (err) {
    expectedGroup = 'soundshop';
  }

  console.log('Resolved expected GROUP:', expectedGroup);

  const problems = [];
  let filesScanned = 0;

  for (const file of htmlFiles) {
    let txt;
    try {
      txt = await fs.readFile(file, 'utf8');
    } catch (err) {
      console.error('Failed to read', file, err && err.message);
      continue;
    }
    filesScanned++;

    // Check for exact canonical payments block paste
    const idx = txt.indexOf(canonicalPaymentsBlock);
    if (idx !== -1) {
      const before = txt.slice(0, idx);
      const lineNumber = before.split('\n').length;
      problems.push({ type: 'canonical-paste', file, lineNumber, preview: previewText(canonicalPaymentsBlock, 800) });
    }

    // Scan inline scripts for GROUP assignments
    let match;
    while ((match = scriptTagRe.exec(txt)) !== null) {
      const attr = match[1] || '';
      const body = match[2] || '';
      if (attrSrcRe.test(attr) || moduleTypeRe.test(attr)) continue;

      // For each assignment within this script body
      let m2;
      groupAssignRe.lastIndex = 0;
      const scrubbedBody = stripJsStringsAndComments(body);
      while ((m2 = groupAssignRe.exec(scrubbedBody)) !== null) {
        const val = m2[1];
        if (val !== expectedGroup) {
          const startIndex = match.index + m2.index; // position in file
          const before = txt.slice(0, startIndex);
          const lineNumber = before.split('\n').length;
          problems.push({ type: 'group-assign', file, lineNumber, value: val, preview: previewText(body) });
        }
      }
    }
  }

  if (problems.length) {
    console.error('\nPayments widget check failed — found', problems.length, 'issue(s):\n');
    for (const p of problems) {
      if (p.type === 'canonical-paste') {
        console.error('File:', p.file);
        console.error('Issue: exact canonical .d8a payments block pasted starting at line', p.lineNumber);
        console.error('Preview:\n' + p.preview.split('\n').map(l => '  ' + l).join('\n'));
        console.error('-----\n');
      } else if (p.type === 'group-assign') {
        console.error('File:', p.file);
        console.error('Issue: GROUP assigned a non-' + expectedGroup + ' value (' + p.value + ') at line', p.lineNumber);
        console.error('Preview:\n' + p.preview.split('\n').map(l => '  ' + l).join('\n'));
        console.error('-----\n');
      }
    }
    console.error('Scanned', filesScanned, 'HTML file(s). Expected GROUP:', expectedGroup);
    process.exitCode = 1;
    return;
  }

  console.log('No pasted canonical payments block found, and no GROUP overrides detected. Scanned', filesScanned, 'HTML file(s). Expected GROUP:', expectedGroup);
  process.exitCode = 0;
}

main().catch(err => {
  console.error('Unexpected error:', err && err.stack || err);
  process.exit(2);
});
