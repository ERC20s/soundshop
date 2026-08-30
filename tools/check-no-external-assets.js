#!/usr/bin/env node
// Zero-dependency CLI to reject external network assets in site/
// Scans .html, .css and .js files and fails on http:, https:, or protocol-relative //

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'site');
const EXT = ['.html', '.css', '.js'];
let problems = [];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && EXT.includes(path.extname(e.name).toLowerCase())) files.push(p);
  }
}

let files = [];
if (!fs.existsSync(ROOT)) {
  console.error('site/ directory not found — nothing to scan');
  process.exit(0);
}
walk(ROOT);

function report(file, lineNo, preview, why) {
  problems.push({ file, lineNo, preview, why });
}

const allowScheme = /^(data:|mailto:|tel:|blob:)/i;

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/);
  const ext = path.extname(file).toLowerCase();

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    // HTML: href/src/srcset attributes and inline CSS url(...)
    if (ext === '.html') {
      // attributes: href=, src=, srcset=
      const attrRe = /(href|src|srcset)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
      let m;
      while ((m = attrRe.exec(ln))) {
        const attr = m[1];
        const val = m[3] || m[4] || m[5] || '';
        if (!val) continue;
        // srcset may contain multiple candidates
        if (attr.toLowerCase() === 'srcset') {
          const parts = val.split(',').map(s => s.trim());
          for (const part of parts) {
            const url = part.split(/\s+/)[0];
            if (!url) continue;
            if (url === '#' || allowScheme.test(url)) continue;
            if (/^(https?:|\/\/)/i.test(url)) {
              report(file, i + 1, ln.trim(), attr + ' contains external URL: ' + url);
            }
          }
        } else {
          const url = val.trim();
          if (!url) continue;
          if (url === '#' || url.startsWith('#') || allowScheme.test(url)) continue;
          if (/^(https?:|\/\/)/i.test(url)) {
            report(file, i + 1, ln.trim(), attr + ' contains external URL: ' + url);
          }
        }
      }

      // inline CSS url(...) inside HTML
      const urlRe = /url\(\s*(["'])?([^"')]+)\1?\s*\)/gi;
      while ((m = urlRe.exec(ln))) {
        const url = (m[2] || '').trim();
        if (!url) continue;
        if (url === '#' || url.startsWith('#') || allowScheme.test(url)) continue;
        if (/^(https?:|\/\/)/i.test(url)) {
          report(file, i + 1, ln.trim(), 'inline CSS url(...) external: ' + url);
        }
      }
    }

    // CSS files: url(...) and @import
    if (ext === '.css') {
      const urlRe = /url\(\s*(["'])?([^"')]+)\1?\s*\)/gi;
      let m;
      while ((m = urlRe.exec(ln))) {
        const url = (m[2] || '').trim();
        if (!url) continue;
        if (url === '#' || url.startsWith('#') || allowScheme.test(url)) continue;
        if (/^(https?:|\/\/)/i.test(url)) report(file, i + 1, ln.trim(), 'CSS url(...) external: ' + url);
      }
      const impRe = /@import\s+(?:url\()?['"]?([^'"\)]+)['"]?\)?/gi;
      while ((m = impRe.exec(ln))) {
        const url = (m[1] || '').trim();
        if (!url) continue;
        if (url === '#' || url.startsWith('#') || allowScheme.test(url)) continue;
        if (/^(https?:|\/\/)/i.test(url)) report(file, i + 1, ln.trim(), '@import external: ' + url);
      }
    }

    // JS files: fetch('...') or fetch(`...`)
    if (ext === '.js') {
      const fetchRe = /fetch\s*\(\s*(["'`])([^"'`]+)\1/gi;
      let m;
      while ((m = fetchRe.exec(ln))) {
        const url = (m[2] || '').trim();
        if (!url) continue;
        if (allowScheme.test(url)) continue;
        if (/^(https?:|\/\/)/i.test(url)) report(file, i + 1, ln.trim(), 'fetch() external: ' + url);
      }
    }
  }
}

if (problems.length) {
  console.error('\nFound external network asset references:');
  for (const p of problems) {
    console.error(p.file + ':' + p.lineNo + ': ' + p.why);
    console.error('  ' + p.preview);
    console.error('');
  }
  console.error('Rejecting: external http(s) or protocol-relative // references are not allowed in site/');
  process.exit(1);
} else {
  console.log('OK: no external http(s)/protocol-relative assets found in site/');
  process.exit(0);
}
