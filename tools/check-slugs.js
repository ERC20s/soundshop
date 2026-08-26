#!/usr/bin/env node
// tools/check-slugs.js
// Verify that the slugify implementations in three files are equivalent.
// Zero-dependency Node script.
const fs = require('fs');
const path = require('path');

const TARGETS = [
  'site/presets/index.html',
  'site/plugins/flagship.html',
  'site/changelog.js'
];

function read(file){
  try{ return fs.readFileSync(file,'utf8'); }catch(e){ return null; }
}

function extractFunctionsNamedSlugify(src){
  const results = [];
  let idx = 0;
  while(true){
    const fnPos = src.indexOf('function slugify', idx);
    if(fnPos === -1) break;
    let bracePos = src.indexOf('{', fnPos);
    if(bracePos === -1) break;
    // find matching closing brace
    let depth = 0;
    let end = bracePos;
    for(let i=bracePos;i<src.length;i++){
      const ch = src[i];
      if(ch === '{') depth++;
      else if(ch === '}'){
        depth--;
        if(depth === 0){ end = i; break; }
      }
    }
    const fnText = src.slice(fnPos, end+1);
    results.push({ start: fnPos, text: fnText });
    idx = end+1;
  }
  return results;
}

function chooseBest(fnList, file){
  if(fnList.length === 0) return null;
  if(fnList.length === 1) return fnList[0].text;
  // prefer one mentioning 'preset' or 'untitled'
  for(const f of fnList){ if(/untitled|preset/.test(f.text)) return f.text; }
  // prefer one that uses the more general toLowerCase+replace pattern
  for(const f of fnList){ if(/toLowerCase\(\)\s*\.replace\(/.test(f.text)) return f.text; }
  // fallback to first
  return fnList[0].text;
}

function normalizeSource(src){
  // Strip comments
  let s = src.replace(/\/\/.*$/mg,'').replace(/\/\*[\s\S]*?\*\//g,'');
  // Collapse whitespace
  s = s.replace(/\s+/g,' ');
  // Normalize double/single quotes to single
  s = s.replace(/"/g, "'");
  // Remove spaces around punctuation to canonicalize
  s = s.replace(/\s*([=(){};,:+\-<>&|\/] )/g,'$1');
  s = s.trim();
  // Extract the sequence of operations for a compact canonical form
  const ops = [];
  if(/toLowerCase\(\)/.test(s)) ops.push('toLower');
  const replaceMatches = [...s.matchAll(/\.replace\((\/[^/]+\/[gimy]*)\s*,\s*([^\)]+)\)/g)];
  if(replaceMatches.length){
    ops.push('replaces:' + replaceMatches.map(m=>m[1]).join(',')).slice(0);
  }
  // detect fallback default after || or ternary
  const fallbackMatch = s.match(/\|\|\s*'([^']+)'/) || s.match(/\?\s*'([^']+)'\s*:/);
  const fallback = fallbackMatch ? fallbackMatch[1] : '';
  return { compact: ops.join('|') || s, fallback: fallback, raw: s };
}

function makeRunner(fnText){
  // Create a function that calls slugify(s) defined in fnText
  try{
    const code = fnText + '\n; return slugify(s);';
    return new Function('s', code);
  }catch(e){ return null; }
}

function showDiffs(samples, runners, labels){
  const rows = [];
  samples.forEach(sample=>{
    const out = runners.map(r=>{
      try{ return String(r(sample)); }catch(e){ return '<<error:'+e.message+'>>'; }
    });
    const allSame = out.every(v=>v===out[0]);
    if(!allSame) rows.push({ sample, out });
  });
  if(rows.length === 0) return 'All sample inputs produced identical slugs.';
  let s = '';
  rows.forEach(r=>{
    s += 'Input: ' + JSON.stringify(r.sample) + '\n';
    r.out.forEach((o,i)=> s += '  ' + labels[i] + ': ' + o + '\n');
    s += '\n';
  });
  return s;
}

(function main(){
  const found = {};
  for(const file of TARGETS){
    const src = read(file);
    if(src == null) { console.error('Unable to read', file); process.exitCode = 2; return; }
    const fns = extractFunctionsNamedSlugify(src);
    const chosen = chooseBest(fns, file);
    if(!chosen){ console.error('No slugify() found in', file); process.exitCode = 2; return; }
    found[file] = chosen;
  }

  const normalized = {};
  Object.keys(found).forEach(k=> normalized[k] = normalizeSource(found[k]));

  const comps = Object.keys(normalized).map(k=> normalized[k].compact);
  const allEqual = comps.every(c=> c === comps[0]);

  if(allEqual){
    console.log('OK: slugify implementations are equivalent (normalized).');
    process.exitCode = 0;
    return;
  }

  // Mismatch: print diagnostics
  console.error('MISMATCH: slugify implementations differ across files.');
  Object.keys(found).forEach(k=>{
    console.error('\n--- ' + k + ' ---\n');
    console.error(found[k].trim() + '\n');
    console.error('Canonical: ' + JSON.stringify(normalized[k].compact) + ', fallback: ' + JSON.stringify(normalized[k].fallback) + '\n');
  });

  // Build sample inputs: preset names + changelog versions/dates
  const presetSamples = [];
  try{
    const pj = read('site/presets/flagship-presets.json');
    if(pj) {
      const arr = JSON.parse(pj);
      arr.forEach(p=> presetSamples.push(p.name || ''));
    }
  }catch(e){}
  // Add some extra synthetic samples
  presetSamples.push('Simple Name');
  presetSamples.push('  Leading/Trailing  ');
  presetSamples.push('Café — special_chars!');

  const changelogSamples = [];
  try{
    const cj = read('data/changelog.json');
    if(cj){
      const arr = JSON.parse(cj);
      arr.forEach(it=>{
        if(it.version) changelogSamples.push(it.version);
        if(it.date) changelogSamples.push(it.date);
      });
    }
  }catch(e){}
  changelogSamples.push('2026-08-01');

  // Prepare runners
  const labels = Object.keys(found);
  const runners = labels.map(k=> makeRunner(found[k]));
  console.error('\nExample differing outputs for preset names:\n');
  console.error(showDiffs(presetSamples, runners, labels));
  console.error('\nExample differing outputs for changelog versions/dates:\n');
  console.error(showDiffs(changelogSamples, runners, labels));

  console.error('\nFix: align the three slugify() implementations so they produce the same outputs.\n');
  process.exitCode = 1;
})();
