// tools/validate-data.js
// Usage: node tools/validate-data.js
// Simple validator for site/presets/flagship-presets.json and data/changelog.json
// Exits with status 0 when no fatal problems were found, 1 otherwise.

const fs = require('fs');
const path = require('path');

let fatal = false;
let warnings = [];
let infos = [];

function fail(msg) {
  console.error('ERROR:', msg);
  fatal = true;
}
function warn(msg) {
  console.warn('WARN: ', msg);
  warnings.push(msg);
}
function info(msg) {
  console.log('INFO: ', msg);
  infos.push(msg);
}

function readJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    fail(`Failed to read or parse ${filePath}: ${err.message}`);
    return null;
  }
}

function baseSlug(name) {
  // Simple base-slug rule: lowercase, replace non-alphanum with '-', collapse runs, trim '-'
  // This duplicates the site's simple slug derivation; keep in sync with site code if changed.
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

// Validate presets
(function validatePresets() {
  const p = path.join('site', 'presets', 'flagship-presets.json');
  const data = readJSON(p);
  if (data === null) return;

  if (!Array.isArray(data)) {
    fail(`${p} must contain a top-level array of presets`);
    return;
  }

  info(`${p}: ${data.length} entries`);

  const slugCounts = Object.create(null);

  data.forEach((entry, i) => {
    const ctx = `${p}[${i}]`;
    if (!entry || typeof entry !== 'object') {
      fail(`${ctx} must be an object`);
      return;
    }
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      fail(`${ctx}.name must be a non-empty string`);
    }
    const params = entry.params;
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
      fail(`${ctx}.params must be an object if present`);
    }

    const hasOsc1 = params && typeof params.osc1 === 'string';
    const hasFilter = params && (typeof params.filter === 'number');
    if (!hasOsc1 && !hasFilter) {
      fail(`${ctx} must have at least one of params.osc1 (string) or params.filter (number)`);
    }

    // if name present compute slug
    if (typeof entry.name === 'string') {
      const s = baseSlug(entry.name);
      slugCounts[s] = (slugCounts[s] || 0) + 1;
    }
  });

  const collisions = Object.entries(slugCounts).filter(([,c]) => c > 1);
  if (collisions.length) {
    warn(`Found ${collisions.length} base-slug collisions among preset names`);
    collisions.slice(0,10).forEach(([slug,count]) => warn(`  '${slug}' used ${count} times`));
    if (collisions.length > 10) warn('  (more collisions omitted)');
  }
})();

// Validate changelog
(function validateChangelog() {
  const p = path.join('data', 'changelog.json');
  const data = readJSON(p);
  if (data === null) return;

  const isArray = Array.isArray(data);
  const isObjWithEntries = data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.entries);

  if (!isArray && !isObjWithEntries) {
    fail(`${p} must be either a top-level array or an object containing an entries array`);
    return;
  }

  const entries = isArray ? data : data.entries;
  info(`${p}: ${entries.length} changelog entries`);

  // Light structural checks for each entry
  entries.forEach((entry, i) => {
    const ctx = `${p}[${i}]`;
    if (!entry || typeof entry !== 'object') {
      fail(`${ctx} must be an object`);
      return;
    }
    if (!entry.version || typeof entry.version !== 'string') {
      warn(`${ctx}.version should be a string`);
    }
    if (!entry.date || typeof entry.date !== 'string') {
      warn(`${ctx}.date should be a string`);
    }
    if (!entry.title || typeof entry.title !== 'string') {
      warn(`${ctx}.title should be a string`);
    }
    if (entry.notes !== undefined && !Array.isArray(entry.notes)) {
      warn(`${ctx}.notes should be an array if present`);
    }
  });
})();

// Summary and exit
if (fatal) {
  console.error('\nValidation failed: fatal problems found.');
  process.exit(1);
} else {
  console.log('\nValidation complete.');
  if (warnings.length) {
    console.log('Warnings were reported (non-fatal):');
    warnings.forEach(w => console.log(' -', w));
  } else {
    console.log('No warnings.');
  }
  process.exit(0);
}
