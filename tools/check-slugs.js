#!/usr/bin/env node
// tools/check-slugs.js
// Verify that every in-repo slugify implementation is semantically identical
// by extracting the function bodies, normalizing them and running examples.
// Exit codes: 0 = all match, 1 = mismatch (prints normalized forms + examples),
// 2 = fatal (missing file or extraction failure) with diagnostic messages.

const fs = require('fs');
const path = require('path');

const TARGETS = [
  'site/presets/index.html',
  'site/plugins/flagship.html',
  'site/changelog.js'
];

function readFile(p){
  try { return fs.readFileSync(p, 'utf8'); } catch(e){ return null; }
}

function indexToLine(str, idx){
  // 1-based line number
  return str.slice(0, idx).split('\n').length;
}

function extractFunctionsFromSource(src, file){
  const results = [];
  const re = /function\s+slugify\s*\(/g;
  let m;
  while((m = re.exec(src))){
    const start = m.index;
    // find the first '{' after the function header
    const bracePos = src.indexOf('{', re.lastIndex);
    if(bracePos === -1) break;
    let i = bracePos;
    let depth = 0;
    let inString = null; // ', " or `
    let inRegex = false;
    for(; i < src.length; i++){
      const ch = src[i];
      const prev = src[i-1];
      // string literal handling (naive but sufficient for small functions)
      if(inString){
        if(ch === '\\') { i++; continue; }
        if(ch === inString) { inString = null; }
        continue;
      }
      if(ch === '"' || ch === '\'' || ch === '`'){
        inString = ch; continue;
      }
      // regex literal start heuristic: a '/' that is followed by something not '/'
      // and not preceded by alnum or  ) or ] is likely a regex literal. This is
      // intentionally simple and tuned for our uses.
      if(ch === '/'){
        const next = src[i+1];
        const prevCh = src[i-1];
        if(next && next !== '/' && next !== '*'){
          // check a few characters back to avoid 'http://' and divisions
          if(!prevCh || /[\s=(:,\[!&|?{};\n]/.test(prevCh)){
            // scan forward to closing '/' that is not escaped, allow [] groups
            let j = i+1;
            let inClass = false;
            for(; j < src.length; j++){
              const c = src[j];
              if(c === '\\') { j++; continue; }
              if(c === '[') inClass = true;
              else if(c === ']') inClass = false;
              else if(c === '/' && !inClass){ break; }
            }
            i = j; // jump
            continue;
          }
        }
      }
      if(ch === '{') { depth++; }
      else if(ch === '}'){
        depth--; if(depth === 0){ i++; break; }
      }
    }
    if(depth !== 0){
      // failed to find end
      results.push({ file, error: 'Unbalanced braces parsing slugify at line ' + indexToLine(src, start) });
      break;
    }
    const fnText = src.slice(start, i);
    const startLine = indexToLine(src, start);
    const endLine = indexToLine(src, i);
    results.push({ file, startLine, endLine, code: fnText });
  }
  return results;
}

function shieldPlaceholders(code){
  const regs = [];
  code = code.replace(/\/\*(?:[^]*?)\*\//g, match => {
    // keep block comments for now (they will be stripped later), but return a token
    const id = '__COMMENT_' + regs.length + '__';
    regs.push({type:'comment', val:match});
    return id;
  });
  const strings = [];
  code = code.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, m => {
    const id = '__STR_' + strings.length + '__';
    strings.push(m);
    return id;
  });
  const regexs = [];
  // crude regex literal matcher: finds /.../flags, allows character classes
  code = code.replace(/\/(?:\\.|\[[^\]\\]*\]|[^\/\\\n])+\/[gimyus]*/g, m => {
    const id = '__REG_' + regexs.length + '__';
    regexs.push(m);
    return id;
  });
  return { code, strings, regexs, comments: regs };
}

function removeComments(code){
  // remove any remaining // comments and any placeholder comments
  code = code.replace(/\/\/.*$/gm, '');
  // remove block comment placeholders like __COMMENT_n__
  code = code.replace(/__COMMENT_\d+__/g, '');
  return code;
}

function canonicalizeReplaceCalls(code){
  // Replace .replace(anything, anything) with .REPLACE for canonical form
  // This is intentionally broad and opinionated but good for small helpers.
  return code.replace(/\.replace\s*\(\s*[^\)]*\)/g, '.REPLACE');
}

function collapseWhitespace(code){
  return code.replace(/\s+/g, ' ').trim();
}

function normalize(code){
  // remove the leading 'function slugify(' header to focus on body semantics
  let body = code;
  // If it starts with 'function', strip the 'function slugify(...)' prefix
  const m = body.match(/^function\s+slugify\s*\([^\)]*\)\s*/);
  if(m) body = body.slice(m[0].length);

  const shield = shieldPlaceholders(body);
  let c = shield.code;
  c = removeComments(c);
  c = canonicalizeReplaceCalls(c);
  c = collapseWhitespace(c);
  // replace placeholders with simple tokens so strings/regexes don't muddy diffs
  c = c.replace(/__STR_\d+__/g, '__STR__');
  c = c.replace(/__REG_\d+__/g, '__REG__');
  return c;
}

function loadSamples(){
  const presetsPath = path.join('site','presets','flagship-presets.json');
  const changelogPath = path.join('data','changelog.json');
  let presets = [];
  let changelog = [];
  try { presets = JSON.parse(fs.readFileSync(presetsPath,'utf8')); } catch(e){ /* ignore */ }
  try { changelog = JSON.parse(fs.readFileSync(changelogPath,'utf8')); } catch(e){ /* ignore */ }
  return { presets, changelog };
}

function makeFunctionFromCode(code){
  // code is like 'function slugify(s){ ... }'
  try {
    const fn = (new Function('return (' + code + ')'))();
    if(typeof fn === 'function') return fn;
  } catch(e){ }
  return null;
}

function main(){
  const allExtracts = [];
  for(const f of TARGETS){
    const src = readFile(f);
    if(src === null){
      console.error('FATAL: missing file:', f);
      process.exitCode = 2; return;
    }
    const extracts = extractFunctionsFromSource(src, f);
    if(extracts.length === 0){
      console.error('FATAL: no slugify implementation found in', f);
      process.exitCode = 2; return;
    }
    // check for parse errors
    for(const e of extracts){
      if(e.error){ console.error('FATAL: parse error in', f + ':', e.error); process.exitCode = 2; return; }
    }
    allExtracts.push(...extracts);
  }

  // Normalize each
  const normalized = allExtracts.map(e => ({
    file: e.file,
    range: e.startLine + '-' + e.endLine,
    code: e.code,
    norm: normalize(e.code)
  }));

  // Compare all normalized forms
  const first = normalized[0].norm;
  const allSame = normalized.every(n => n.norm === first);

  if(allSame){
    console.log('ok: all slugify implementations match (normalized)');
    process.exitCode = 0; return;
  }

  // MISMATCH: print diagnostics
  console.error('MISMATCH: slugify implementations differ. Normalized forms:');
  normalized.forEach((n,i)=>{
    console.error('\n--- ' + n.file + ' (lines ' + n.range + ') ---');
    console.error(n.norm);
  });

  // run example-driven outputs
  const samples = loadSamples();
  const presetsList = Array.isArray(samples.presets) ? samples.presets : [];
  const changelogList = Array.isArray(samples.changelog) ? samples.changelog : [];

  console.error('\nExample outputs for representative inputs:');

  normalized.forEach((n, idx)=>{
    console.error('\n[' + idx + '] ' + n.file + ' (lines ' + n.range + ')');
    const fn = makeFunctionFromCode(n.code);
    if(!fn){ console.error('  ERROR: could not evaluate function'); return; }
    try {
      // Preset names (first 8)
      const presetNames = presetsList.slice(0,8).map(p => (p && p.name) ? p.name : '');
      console.error('  Preset -> slug (first examples):');
      presetNames.forEach(p => {
        try { console.error('    "' + p + '" -> "' + fn(p) + '"'); } catch(e){ console.error('    "' + p + '" -> (error)'); }
      });
      // Changelog: test versions and dates
      const changex = changelogList.slice(0,8);
      console.error('  Changelog -> slug (version and date examples):');
      changex.forEach(item => {
        try {
          const v = item && item.version ? item.version : '';
          const d = item && item.date ? item.date : '';
          console.error('    version: "' + v + '" -> "' + fn(v) + '"');
          console.error('    date:    "' + d + '" -> "' + fn(d) + '"');
        } catch(e){ console.error('    (error evaluating sample)'); }
      });
    } catch(e){ console.error('  ERROR running examples:', e && e.message); }
  });

  process.exitCode = 1;
}

if(require.main === module) main();
