#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const FILES = [
  'site/presets/index.html',
  'site/plugins/flagship.html',
  'site/changelog.js'
];
const SAMPLE_PRESETS = 'site/presets/flagship-presets.json';
const SAMPLE_CHANGELOG = 'data/changelog.json';

function read(p){
  try { return fs.readFileSync(p, 'utf8'); }
  catch(e){ throw new Error('Missing file: '+p); }
}

// Find all occurrences of "function slugify(" and extract the function body
// using a brace depth scan that skips strings and comments.
function extractBodies(source){
  const bodies = [];
  const needle = 'function slugify';
  let idx = 0;
  while(true){
    const i = source.indexOf(needle, idx);
    if(i === -1) break;
    // find the first '(' after the needle
    let p = source.indexOf('(', i);
    if(p === -1){ idx = i + needle.length; continue; }
    // advance to the '{' that starts the body, skipping the parameter list
    // we will scan forward and handle nested parentheses, strings and comments
    let j = p;
    let depthPar = 0;
    let inStr = null; // ' or " or `
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;
    for(j = p; j < source.length; j++){
      const ch = source[j];
      const nxt = source[j+1];
      if(inLineComment){ if(ch === '\n'){ inLineComment = false; } continue; }
      if(inBlockComment){ if(ch === '*' && nxt === '/') { inBlockComment = false; j++; } continue; }
      if(inStr){
        if(escaped){ escaped = false; }
        else if(ch === '\\'){ escaped = true; }
        else if(ch === inStr){ inStr = null; }
        else if(inStr === '`' && ch === '$' && nxt === '{'){ // template expr
          // enter a temporary brace-balanced region until matching '}'
          j += 2; // move past ${
          let brace = 1;
          let tplInStr = null;
          let tplEsc = false;
          for(; j < source.length; j++){
            const c2 = source[j];
            const n2 = source[j+1];
            if(tplInStr){
              if(tplEsc) tplEsc = false;
              else if(c2 === '\\') tplEsc = true;
              else if(c2 === tplInStr) tplInStr = null;
            } else {
              if(c2 === '\\') { tplEsc = true; }
              else if(c2 === '"' || c2 === "'" || c2 === '`') tplInStr = c2;
              else if(c2 === '{') brace++;
              else if(c2 === '}') { if(--brace === 0) break; }
            }
          }
          continue;
        }
        continue;
      }
      // not in string/comment
      if(ch === '/' && nxt === '/') { inLineComment = true; j++; continue; }
      if(ch === '/' && nxt === '*') { inBlockComment = true; j++; continue; }
      if(ch === '"' || ch === "'" || ch === '`'){ inStr = ch; continue; }
      if(ch === '(') depthPar++;
      else if(ch === ')'){
        if(depthPar>0) depthPar--; else ;
      }
      else if(ch === '{' && depthPar === 0){ // this is the function body opening
        const bodyStart = j;
        // now scan for matching '}' with full skip of strings/comments
        let k = j+1;
        let depth = 1;
        let inS = null; let esc = false; let inLC = false; let inBC = false;
        for(; k < source.length; k++){
          const c = source[k];
          const n = source[k+1];
          if(inLC){ if(c === '\n'){ inLC = false; } continue; }
          if(inBC){ if(c === '*' && n === '/') { inBC = false; k++; } continue; }
          if(inS){
            if(esc){ esc = false; }
            else if(c === '\\') esc = true;
            else if(c === inS) inS = null;
            else if(inS === '`' && c === '$' && n === '{'){
              // handle nested ${ ... }
              k += 2; let tplDepth = 1; let tplStr = null; let tplEsc=false;
              for(; k < source.length; k++){
                const t = source[k];
                const tn = source[k+1];
                if(tplStr){ if(tplEsc) tplEsc=false; else if(t === '\\') tplEsc=true; else if(t === tplStr) tplStr=null; }
                else {
                  if(t === '\\') tplEsc = true;
                  else if(t === '"' || t === "'" || t === '`') tplStr = t;
                  else if(t === '{') tplDepth++;
                  else if(t === '}'){ if(--tplDepth===0) break; }
                }
              }
              continue;
            }
            continue;
          }
          if(c === '/' && n === '/') { inLC = true; k++; continue; }
          if(c === '/' && n === '*') { inBC = true; k++; continue; }
          if(c === '"' || c === "'" || c === '`'){ inS = c; continue; }
          if(c === '{') depth++; else if(c === '}'){
            depth--;
            if(depth === 0){
              const body = source.slice(bodyStart+1, k);
              bodies.push(body);
              idx = k+1;
              break;
            }
          }
        }
        break; // continue searching after this occurrence
      }
    }
    idx = i + needle.length;
  }
  return bodies;
}

function removeComments(source){
  let out = '';
  let i = 0;
  const L = source.length;
  let inStr = null, esc = false, inLC = false, inBC = false;
  while(i < L){
    const c = source[i];
    const n = source[i+1];
    if(inLC){ if(c === '\n'){ inLC = false; out += c; } i++; continue; }
    if(inBC){ if(c === '*' && n === '/'){ inBC = false; i+=2; continue; } i++; continue; }
    if(inStr){ out += c; if(esc) esc = false; else if(c === '\\') esc = true; else if(c === inStr){ inStr = null; } i++; continue; }
    if(c === '/' && n === '/'){ inLC = true; i+=2; continue; }
    if(c === '/' && n === '*'){ inBC = true; i+=2; continue; }
    if(c === '"' || c === "'" || c === '`'){ inStr = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

// Tokenize strings and regex literals and replace them with placeholders
function tokenize(source){
  const tokens = { strings: [], regexes: [] };
  let out = '';
  let i = 0, L = source.length;
  let inStr = null, esc = false;
  while(i < L){
    const c = source[i];
    const n = source[i+1];
    if(inStr){
      out += c;
      if(esc) esc = false;
      else if(c === '\\') esc = true;
      else if(c === inStr) inStr = null;
      i++;
      continue;
    }
    if(c === '"' || c === "'" || c === '`'){
      // capture full string including quotes
      const quote = c;
      let j = i+1; let esc2 = false;
      while(j < L){
        const ch = source[j];
        if(esc2) { esc2 = false; j++; continue; }
        if(ch === '\\'){ esc2 = true; j++; continue; }
        if(ch === quote) { j++; break; }
        if(quote === '`' && ch === '$' && source[j+1] === '{'){
          // naive skip of template expr until matching '}'
          j += 2; let depth = 1; let tplStr = null; let tplEsc=false;
          for(; j < L; j++){
            const t = source[j];
            const tn = source[j+1];
            if(tplStr){ if(tplEsc) tplEsc=false; else if(t === '\\') tplEsc=true; else if(t === tplStr) tplStr=null; }
            else {
              if(t === '\\') tplEsc = true;
              else if(t === '"' || t === "'" || t === '`') tplStr = t;
              else if(t === '{') depth++;
              else if(t === '}'){ if(--depth===0) break; }
            }
          }
          continue;
        }
        j++;
      }
      const raw = source.slice(i, j);
      const id = tokens.strings.length;
      tokens.strings.push(raw);
      out += '__STR' + id + '__';
      i = j;
      continue;
    }
    // heuristic: regex literal if char == '/' and previous non-space char is one of
    // ( , = : [ ! ? { } ; or start of string
    if(c === '/'){
      // find previous non-space char
      let k = i-1; while(k>=0 && /\s/.test(source[k])) k--;
      const prev = k < 0 ? null : source[k];
      if(prev === null || '({[=!:;?,'.indexOf(prev) !== -1){
        // parse regex literal
        let j = i+1; let inClass = false; let esc2 = false;
        for(; j < L; j++){
          const ch = source[j];
          if(esc2) { esc2 = false; continue; }
          if(ch === '\\') { esc2 = true; continue; }
          if(ch === '[') { inClass = true; continue; }
          if(ch === ']') { inClass = false; continue; }
          if(ch === '/' && !inClass){ j++; break; }
        }
        // collect flags
        let f = '';
        while(j < L && /[gimsuy]/.test(source[j])){ f += source[j]; j++; }
        const raw = source.slice(i, j);
        const id = tokens.regexes.length;
        tokens.regexes.push(raw);
        out += '__REG' + id + '__';
        i = j;
        continue;
      }
    }
    out += c; i++;
  }
  return { out, tokens };
}

function canonicalize(body){
  // remove comments first
  const noComments = removeComments(body);
  // tokenize strings and regex
  const { out, tokens } = tokenize(noComments);
  // collapse whitespace
  let s = out.replace(/\s+/g, ' ').trim();
  // normalize replace calls: convert .replace(__REGn__,__STRm__) or .replace(__STRm__,__REGn__)
  s = s.replace(/\.replace\s*\(\s*(__REG\d+__)\s*,\s*([^\)]+?)\s*\)/g, function(_, a, b){ return '.REPLACE(' + a + ',' + b + ')'; });
  s = s.replace(/\.replace\s*\(\s*([^\)]+?)\s*,\s*(__REG\d+__)\s*\)/g, function(_, a, b){ return '.REPLACE(' + a + ',' + b + ')'; });
  // normalize any remaining .replace(...) to REPLACE(...) token
  s = s.replace(/\.replace\s*\(\s*([^\)]+?)\s*\)/g, function(_, a){ return '.REPLACE(' + a + ')'; });

  // inline token expansion for readability in diagnostics: replace __STRn__ with STR[content]
  const expand = function(text){
    let outText = text;
    tokens.strings.forEach((raw, i)=>{
      outText = outText.split('__STR' + i + '__').join('STR[' + raw.replace(/^['`"]|['`"]$/g,'') + ']');
    });
    tokens.regexes.forEach((raw, i)=>{
      outText = outText.split('__REG' + i + '__').join('REG[' + raw + ']');
    });
    return outText;
  };

  return { canon: s, tokens, pretty: expand(s) };
}

function tryBuildSlugify(body){
  // body is the inside of the function braces
  try {
    const fn = new Function('s', body);
    return fn;
  } catch(e){
    return { error: String(e) };
  }
}

function sampleInputs(){
  const presets = (()=>{ try{ const j = read(SAMPLE_PRESETS); const arr = JSON.parse(j); return Array.isArray(arr) ? arr.map(p=>p.name||'') : []; } catch(e){ return []; }})();
  const changelog = (()=>{ try{ const j = read(SAMPLE_CHANGELOG); const obj = JSON.parse(j); const list = Array.isArray(obj) ? obj : (obj && obj.entries) || []; return list.map(it=> it.version || it.date || it.title || ''); } catch(e){ return []; }})();
  const samples = [];
  presets.forEach(s=> { if(s && samples.indexOf(s)===-1) samples.push(s); });
  changelog.forEach(s=> { if(s && samples.indexOf(s)===-1) samples.push(s); });
  // add some fuzz
  ['Hello World!', 'Café del Mar', 'Lead & Gold', '  Multiple   Spaces  ', "special_chars!@#$%^&*()" ].forEach(s=>{ if(samples.indexOf(s)===-1) samples.push(s); });
  return samples.slice(0, 10);
}

function main(){
  const results = {};
  for(const f of FILES){
    let src;
    try{ src = read(f); }
    catch(e){ console.error('FATAL:', e.message); process.exit(2); }
    const bodies = extractBodies(src);
    if(bodies.length === 0){
      console.error('FATAL: no slugify function found in', f);
      process.exit(2);
    }
    // If multiple, choose the one that contains 'replace(/' or 'untitled' or 'toLowerCase'
    let chosen = bodies[0];
    for(const b of bodies){ if(/replace\s*\(\s*\/|untitled|toLowerCase\(/i.test(b)){ chosen = b; break; } }
    const norm = canonicalize(chosen);
    results[f] = { body: chosen, canon: norm.canon, pretty: norm.pretty, tokens: norm.tokens };
  }

  // Compare canonical forms pairwise
  const files = Object.keys(results);
  const baseCanon = results[files[0]].canon;
  let allSame = true;
  const diffs = [];
  for(let i=1;i<files.length;i++){
    const f = files[i];
    if(results[f].canon !== baseCanon){ allSame = false; diffs.push([files[0], f]); }
  }

  if(allSame){
    console.log('ok: slugify implementations are identical (normalized).');
    // optional small diagnostics
    console.log('Normalized form:\n', results[files[0]].pretty);
    process.exit(0);
  }

  // MISMATCH: print diagnostics
  console.error('mismatch: slugify implementations differ');
  files.forEach(f=>{
    console.error('\n--- ' + f + ' (normalized) ---');
    console.error(results[f].pretty);
  });

  // Try to build and run each slugify on sample inputs
  console.error('\nExample outputs:');
  const samples = sampleInputs();
  const built = {};
  for(const f of files){
    const tryFn = tryBuildSlugify(results[f].body);
    if(tryFn && tryFn.error){ built[f] = { error: tryFn.error }; }
    else { built[f] = { fn: tryFn }; }
  }
  samples.forEach(samp=>{
    console.error('\nInput: "' + samp + '"');
    for(const f of files){
      const b = built[f];
      if(b.error){ console.error('  ' + path.basename(f) + ': <build error> ' + b.error); }
      else {
        try{
          const out = b.fn(samp);
          console.error('  ' + path.basename(f) + ': ' + String(out));
        } catch(e){ console.error('  ' + path.basename(f) + ': <runtime error> ' + String(e)); }
      }
    }
  });

  process.exit(1);
}

if(require.main === module){
  try{ main(); }
  catch(e){ console.error('FATAL:', e && e.stack || e); process.exit(2); }
}
