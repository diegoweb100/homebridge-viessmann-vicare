#!/usr/bin/env node
'use strict';
/**
 * Checks that every plugin setting the code reads can be edited in the Homebridge UI:
 *   1. every key read from the plugin config (config.x, features.x, customNames.x, cache.x,
 *      logging.x, advanced.x, network.x, postCommandRetry.x) is declared in config.schema.json
 *   2. every setting declared in the schema appears in the layout (a setting missing from the
 *      layout is invisible in the Homebridge UI)
 * Runs before every npm publish (prepublishOnly). Exit code 1 = something is missing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.schema.json'), 'utf8'));

// Settings intentionally not shown in the UI (obsolete, kept only to read old configs)
const HIDDEN_OK = new Set(['reportServerPort', 'combustion', 'customNames.rooms']);   // customNames.rooms: old name of customNames.roomNames
// Objects the code reads with a sub-key
const GROUPS = ['features', 'customNames', 'cache', 'logging', 'advanced', 'network', 'postCommandRetry'];
// Names that look like settings but are not (Homebridge/platform fields, request objects)
const NOT_SETTINGS = new Set(['platform', 'name', 'combustion', '_bridge']);

// ── declared settings ────────────────────────────────────────────────────────
const declared = new Set();
(function walk(o, pre) {
  if (!o || typeof o !== 'object' || !o.properties) return;
  for (const [k, v] of Object.entries(o.properties)) { declared.add(pre + k); walk(v, pre + k + '.'); }
})(schema.schema, '');
const leaves = [...declared].filter(k => ![...declared].some(o => o.startsWith(k + '.')));

// ── layout ───────────────────────────────────────────────────────────────────
const inLayout = new Set();
(function lw(o) {
  if (Array.isArray(o)) o.forEach(lw);
  else if (o && typeof o === 'object') { if (typeof o.key === 'string') inLayout.add(o.key.replace(/\[\]$/, '')); Object.values(o).forEach(lw); }
  else if (typeof o === 'string') inLayout.add(o.replace(/\[\]$/, ''));
})(schema.layout || []);

// ── settings read by the code ────────────────────────────────────────────────
const files = [];
(function list(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) list(p); else if (/\.ts$/.test(f.name)) files.push(p);
  }
})(path.join(ROOT, 'src'));
files.push(path.join(ROOT, 'viessmann-dashboard.js'));

const used = new Set();
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  // platform config: this.config.x / platform.config.x / (this.platform.config as any).x
  const re = /(?:this\.config|platform\.config|this\.platform\.config|\(this\.platform\.config as \w+\)|\(this\.config as \w+\)|\(config as any\))\??\.(\w+)(?:\??\.(\w+))?/g;
  // only files that receive the plugin config as `config`/`this.config`
  const isPlatformCfg = /platform\.ts$|viessmann-api\.ts$|auth-manager\.ts$/.test(file);
  for (const m of src.matchAll(re)) {
    if (/^\(?this\.config/.test(m[0]) && !isPlatformCfg) continue;   // other classes' own config objects
    const a = m[1], b = m[2];
    if (NOT_SETTINGS.has(a)) continue;
    used.add(GROUPS.includes(a) && b ? `${a}.${b}` : a);
  }
  for (const g of ['features', 'customNames']) {
    for (const m of src.matchAll(new RegExp(`\\b${g}\\??\\.(\\w+)`, 'g'))) used.add(`${g}.${m[1]}`);
  }
}
// curve tuner reads its options as `f.x` with f = config.features
const tuner = fs.readFileSync(path.join(ROOT, 'src', 'curve-tuner.ts'), 'utf8');
for (const m of tuner.matchAll(/\bf\.(curveAutoTune\w*)/g)) used.add(`features.${m[1]}`);

const ARRAY_METHODS = new Set(['length', 'map', 'filter', 'find', 'some', 'push', 'includes', 'forEach']);
const missingInSchema = [...used].filter(k => !declared.has(k) && !HIDDEN_OK.has(k) && !ARRAY_METHODS.has(k.split('.').pop())).sort();
const missingInLayout = leaves.filter(k => !inLayout.has(k) && !HIDDEN_OK.has(k) && ![...inLayout].some(l => k.startsWith(l + '.'))).sort();

let ok = true;
if (missingInSchema.length) { ok = false; console.error('✗ Read by the code but missing in config.schema.json:\n  ' + missingInSchema.join('\n  ')); }
if (missingInLayout.length) { ok = false; console.error('✗ Declared in config.schema.json but not in the layout (invisible in the Homebridge UI):\n  ' + missingInLayout.join('\n  ')); }
if (ok) console.log(`✓ config.schema.json: ${used.size} settings read by the code, all declared; ${leaves.length} settings, all visible in the UI`);
process.exit(ok ? 0 : 1);
