#!/usr/bin/env node
/**
 * Viessmann API Historical Data Explorer
 * 
 * Tests all features containing 'statistics', 'summary', 'history', 'cumulated',
 * 'consumption', 'production' to understand available granularity.
 * 
 * Usage:
 *   node viessmann-explore-history.js --installation 2045571
 *   node viessmann-explore-history.js --installation 2045571 --out /tmp/history-explore.json
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const https = require('https');

const args   = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 && args[i+1] ? args[i+1] : def; };

const HB_PATH    = getArg('--path', '/var/lib/homebridge');
const INST       = getArg('--installation', '');
const OUT_FILE   = getArg('--out', path.join(HB_PATH, `viessmann-history-explore-${INST || 'all'}.json`));
const BASE_URL   = 'https://api.viessmann-climatesolutions.com';

if (!INST) {
  console.error('ERROR: --installation <ID> required');
  process.exit(1);
}

// ── Token ────────────────────────────────────────────────────────────────────
function getToken() {
  const tokenFile = path.join(HB_PATH, 'viessmann-tokens.json');
  if (!fs.existsSync(tokenFile)) {
    console.error(`ERROR: token file not found: ${tokenFile}`);
    process.exit(1);
  }
  const d = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  return Object.values(d)[0].accessToken;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function apiGet(url, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    };
    https.get(url, opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Keywords that indicate historical/statistical data ────────────────────────
const HISTORY_KEYWORDS = [
  'statistics', 'summary', 'history', 'cumulated',
  'consumption', 'production', 'efficiency',
  'starts', 'hours', 'runtime', 'energy',
  'spf', 'scop', 'cop',
];

const TIME_PROPS = ['currentDay', 'lastSevenDays', 'currentWeek', 'currentMonth',
                    'lastMonth', 'currentYear', 'lastYear', 'lifeCycle',
                    'day', 'week', 'month', 'year',
                    'starts', 'hours', 'value'];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const token = getToken();
  console.log(`\n🔍 Viessmann Historical Data Explorer`);
  console.log(`   Installation: ${INST}`);
  console.log(`   Output: ${OUT_FILE}\n`);

  // Step 1: Get gateways
  console.log('1. Getting gateways...');
  const gwRes = await apiGet(`${BASE_URL}/iot/v2/equipment/installations/${INST}/gateways`, token);
  const gateways = gwRes.body?.data || [];
  if (!gateways.length) { console.error('No gateways found'); process.exit(1); }
  
  const results = { 
    timestamp: new Date().toISOString(),
    installation: INST,
    devices: {},
  };

  for (const gw of gateways) {
    console.log(`\n2. Gateway: ${gw.serial}`);
    
    // Step 2: Get devices
    const devRes = await apiGet(
      `${BASE_URL}/iot/v2/equipment/installations/${INST}/gateways/${gw.serial}/devices`, token
    );
    const devices = devRes.body?.data || [];
    console.log(`   Found ${devices.length} device(s)`);

    for (const dev of devices) {
      const devKey = `${gw.serial}__${dev.id}`;
      console.log(`\n3. Device: id=${dev.id} model=${dev.modelId || '?'}`);

      // Step 3: Get all features
      await sleep(500);
      const featRes = await apiGet(
        `${BASE_URL}/iot/v2/features/installations/${INST}/gateways/${gw.serial}/devices/${dev.id}/features`,
        token
      );
      const features = featRes.body?.data || [];
      console.log(`   Total features: ${features.length}`);

      // Step 4: Filter to history/stats features
      const histFeatures = features.filter(f => {
        const name = f.feature.toLowerCase();
        return HISTORY_KEYWORDS.some(k => name.includes(k));
      });
      console.log(`   History/stats features: ${histFeatures.length}`);

      const deviceResult = {
        model: dev.modelId,
        totalFeatures: features.length,
        historyFeatures: [],
      };

      for (const f of histFeatures.sort((a,b) => a.feature.localeCompare(b.feature))) {
        const props = f.properties || {};
        const propKeys = Object.keys(props);
        
        // Analyze temporal granularity from property names
        const granularity = TIME_PROPS.filter(t => propKeys.includes(t));
        
        // Extract sample values
        const samples = {};
        for (const key of propKeys) {
          const v = props[key];
          if (v && typeof v === 'object') {
            const val = v.value;
            const unit = v.unit || '';
            if (Array.isArray(val)) {
              // Array = daily/weekly values
              samples[key] = { 
                type: 'array', 
                length: val.length, 
                unit,
                sample: val.slice(0, 3),
                note: `${val.length} values (likely ${val.length === 7 ? 'weekly' : val.length === 24 ? 'hourly' : val.length + '-point'})`,
              };
            } else if (val !== undefined && val !== null) {
              samples[key] = { type: typeof val, value: val, unit };
            }
          }
        }

        // Check commands (writeable?)
        const cmds = Object.keys(f.commands || {});

        const entry = {
          feature: f.feature,
          isEnabled: f.isEnabled,
          granularity,
          properties: propKeys,
          samples,
          commands: cmds,
        };

        deviceResult.historyFeatures.push(entry);

        // Console output
        const gran = granularity.length ? granularity.join(', ') : 'unknown';
        const enabled = f.isEnabled ? '✓' : '✗';
        console.log(`\n   [${enabled}] ${f.feature}`);
        console.log(`       Granularity: ${gran}`);
        
        for (const [k, s] of Object.entries(samples)) {
          if (s.type === 'array') {
            console.log(`       ${k}: [${s.sample.join(', ')}...] (${s.note}) ${s.unit}`);
          } else {
            console.log(`       ${k}: ${s.value} ${s.unit}`);
          }
        }
      }

      results.devices[devKey] = deviceResult;

      // Step 5: Check if time-series API endpoints exist
      console.log(`\n4. Checking time-series API availability for device ${dev.id}...`);
      await sleep(300);

      const tsEndpoints = [
        `/iot/v2/features/installations/${INST}/gateways/${gw.serial}/devices/${dev.id}/features/heating.power.consumption.heating`,
        `/iot/v2/features/installations/${INST}/gateways/${gw.serial}/devices/${dev.id}/features/heating.burners.0.statistics`,
        `/iot/v2/features/installations/${INST}/gateways/${gw.serial}/devices/${dev.id}/features/heating.boiler.serial`,
      ];

      for (const ep of tsEndpoints) {
        await sleep(300);
        const r = await apiGet(`${BASE_URL}${ep}`, token);
        const ok = r.status === 200 ? '✓' : `✗ (${r.status})`;
        console.log(`   ${ok} ${ep.split('/features/')[1]}`);
        if (r.status === 200 && r.body?.data?.properties) {
          const pkeys = Object.keys(r.body.data.properties);
          console.log(`       properties: ${pkeys.join(', ')}`);
        }
      }

      await sleep(500);
    }
  }

  // Step 6: Summary analysis
  console.log('\n\n═══════════════════════════════════════════════════════');
  console.log('SUMMARY — Available historical data granularity');
  console.log('═══════════════════════════════════════════════════════\n');

  const granularityMap = {};
  for (const [devKey, dev] of Object.entries(results.devices)) {
    for (const f of dev.historyFeatures) {
      for (const g of f.granularity) {
        if (!granularityMap[g]) granularityMap[g] = [];
        granularityMap[g].push(f.feature);
      }
    }
  }

  const granOrder = ['currentDay', 'lastSevenDays', 'currentWeek', 'currentMonth',
                     'lastMonth', 'currentYear', 'lastYear', 'lifeCycle',
                     'day', 'week', 'month', 'year', 'starts', 'hours', 'value'];
  
  for (const g of granOrder) {
    if (granularityMap[g]?.length) {
      console.log(`  ${g} (${granularityMap[g].length} features):`);
      granularityMap[g].slice(0, 5).forEach(f => console.log(`    - ${f}`));
      if (granularityMap[g].length > 5) console.log(`    ... and ${granularityMap[g].length - 5} more`);
    }
  }

  results.summary = {
    granularityMap,
    totalHistoryFeatures: Object.values(results.devices)
      .reduce((s, d) => s + d.historyFeatures.length, 0),
    note: 'day/week arrays contain multiple values; currentDay/currentMonth are running totals',
  };

  // Save results
  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n✅ Results saved to: ${OUT_FILE}`);
  console.log(`   Copy to Mac: scp homebridge@<PI_IP>:${OUT_FILE} ~/Desktop/`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
