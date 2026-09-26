#!/usr/bin/env node
/**
 * viessmann-sync-events.js
 * 
 * Fetches events-history from Viessmann API and writes burner ON/OFF events
 * directly into the CSV history file with precise timestamps.
 * 
 * Uses S.6 active=true/false (ignition start/end) as the definitive burner state.
 * Also writes S.39 (heating demand) and S.1 (DHW demand) as context events.
 *
 * Since v2.0.75: if MySQL logging is enabled in the plugin config
 * (logging.mysql.enabled = true in Homebridge config.json) the same events are
 * also inserted into the MySQL/MariaDB history table (INSERT IGNORE — safe to re-run).
 * Use --no-mysql to skip, --config <file> to point to a different config.json.
 * 
 * Usage:
 *   node viessmann-sync-events.js --installation YOUR_INSTALLATION_ID [--days 7] [--path /var/lib/homebridge]
 * 
 * Run via cron daily (e.g. 04:00) to backfill the previous day:
 *   0 4 * * * node /usr/local/lib/node_modules/homebridge-viessmann-vicare/viessmann-sync-events.js --installation YOUR_INSTALLATION_ID
 */

'use strict';
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');

// ── CLI args ───────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const getArg  = (flag, def) => { const i = args.indexOf(flag); return i !== -1 && args[i+1] ? args[i+1] : def; };
const HB_PATH       = getArg('--path',         '/var/lib/homebridge');
const INSTALLATION  = getArg('--installation', '');
const DAYS          = parseInt(getArg('--days', '7'), 10);
const DRY_RUN       = args.includes('--dry-run');
const NO_MYSQL      = args.includes('--no-mysql');
const CONFIG_FILE   = getArg('--config', path.join(HB_PATH, 'config.json'));

if (!INSTALLATION) {
  console.error('ERROR: --installation <ID> is required');
  process.exit(1);
}

// ── CSV config ─────────────────────────────────────────────────────────────
const CSV_FILE = path.join(HB_PATH, `viessmann-history-${INSTALLATION}.csv`);
const TOKEN_FILE = path.join(HB_PATH, 'viessmann-tokens.json');

const CSV_COLUMNS = [
  'timestamp', 'accessory', 'event_type',
  'burner_active', 'modulation',
  'room_temp', 'target_temp', 'outside_temp', 'outside_humidity',
  'dhw_temp', 'dhw_target', 'program', 'mode',
  'burner_starts', 'burner_hours', 'burner_starts_today', 'burner_hours_today',
  'flow_temp',
  'gas_heating_day_m3', 'gas_dhw_day_m3',
  'gas_heating_month_m3', 'gas_dhw_month_m3',
  'heat_heating_day_kwh', 'heat_dhw_day_kwh',
  'heat_heating_month_kwh', 'heat_dhw_month_kwh',
  'pv_production_w', 'pv_daily_kwh',
  'battery_level', 'battery_charging_w', 'battery_discharging_w',
  'grid_feedin_w', 'grid_draw_w',
  'wallbox_charging', 'wallbox_power_w',
];

// ── Token ──────────────────────────────────────────────────────────────────
function getToken() {
  try {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    const key    = Object.keys(tokens)[0];
    return tokens[key].accessToken;
  } catch(e) {
    console.error('ERROR: Cannot read token from', TOKEN_FILE, e.message);
    process.exit(1);
  }
}

// ── HTTP helper ────────────────────────────────────────────────────────────
function apiGet(url, token) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('JSON parse error: ' + body.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Fetch all events for the last N days ──────────────────────────────────
async function fetchEvents(token, installationId, days) {
  const cutoff   = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffTs = cutoff.getTime();

  const base    = `https://api.viessmann-climatesolutions.com/iot/v2/events-history/installations/${installationId}/events`;
  let cursor    = null;
  let allEvents = [];
  let page      = 0;

  while (true) {
    const url = base + '?limit=1000' + (cursor ? '&cursor=' + cursor : '');
    console.log(`  Fetching page ${++page}${cursor ? ' (cursor)' : ''}...`);

    const data = await apiGet(url, token);
    const events = data.data || [];

    if (!events.length) break;

    // Events are newest-first — stop when we go past the cutoff
    let doneEarly = false;
    for (const e of events) {
      const ts = new Date(e.eventTimestamp || e.createdAt).getTime();
      if (ts < cutoffTs) { doneEarly = true; break; }
      allEvents.push(e);
    }

    if (doneEarly) break;

    cursor = data.cursor?.next;
    if (!cursor) break;

    // Rate limit protection: 1 req/sec
    await new Promise(r => setTimeout(r, 1100));
  }

  console.log(`  Total events fetched: ${allEvents.length}`);
  return allEvents;
}

// ── Parse events into CSV rows ─────────────────────────────────────────────
function eventsToCsvRows(events) {
  const rows = [];

  for (const e of events) {
    const body  = e.body || {};
    const code  = body.errorCode || '';
    const active= body.active;
    const ts    = e.eventTimestamp || e.createdAt;

    // S.6 = Ignition (most precise burner ON/OFF signal)
    if (code === 'S.6') {
      const row = {};
      CSV_COLUMNS.forEach(c => row[c] = '');
      row.timestamp   = ts;
      row.accessory   = 'boiler';
      row.event_type  = active ? 'burner_on' : 'burner_off';
      row.burner_active = active ? 'true' : 'false';
      rows.push(row);
    }

    // S.29 = Central heating demand
    // S.1  = DHW demand
    // S.39 = Heating demand (variant — write as context event)
    if (code === 'S.29' || code === 'S.1' || code === 'S.39') {
      const row = {};
      CSV_COLUMNS.forEach(c => row[c] = '');
      row.timestamp   = ts;
      row.accessory   = 'boiler';
      row.event_type  = active
        ? (code === 'S.1' ? 'dhw_demand_on' : 'heat_demand_on')
        : (code === 'S.1' ? 'dhw_demand_off' : 'heat_demand_off');
      row.burner_active = '';  // demand ≠ ignition — don't set burner_active
      rows.push(row);
    }
  }

  return rows;
}

// ── Read existing CSV timestamps ────────────────────────────────────────────
function readExistingEventTimestamps() {
  if (!fs.existsSync(CSV_FILE)) return new Set();
  const lines   = fs.readFileSync(CSV_FILE, 'utf8').trim().split('\n');
  const header  = lines[0].split(',');
  const tsIdx   = header.indexOf('timestamp');
  const etIdx   = header.indexOf('event_type');
  const existing = new Set();
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const et   = etIdx >= 0 ? vals[etIdx] : '';
    // Only track event rows (not snapshots)
    if (et && et !== 'snapshot') {
      existing.add(vals[tsIdx] + '|' + et);
    }
  }
  return existing;
}

// ── Append rows to CSV ─────────────────────────────────────────────────────
function appendToCsv(rows) {
  const exists = fs.existsSync(CSV_FILE);
  if (!exists) {
    fs.writeFileSync(CSV_FILE, CSV_COLUMNS.join(',') + '\n', 'utf8');
    console.log('  Created new CSV:', CSV_FILE);
  }

  const lines = rows.map(row =>
    CSV_COLUMNS.map(c => row[c] ?? '').join(',')
  ).join('\n') + '\n';

  fs.appendFileSync(CSV_FILE, lines, 'utf8');
}

// ── Sort CSV by timestamp after insert ────────────────────────────────────
function sortCsv() {
  const lines  = fs.readFileSync(CSV_FILE, 'utf8').trim().split('\n');
  const header = lines[0];
  const data   = lines.slice(1).filter(l => l.trim());
  data.sort((a, b) => {
    const ta = a.split(',')[0];
    const tb = b.split(',')[0];
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  fs.writeFileSync(CSV_FILE, header + '\n' + data.join('\n') + '\n', 'utf8');
}

// ── MySQL (optional, v2.0.75+) ─────────────────────────────────────────────
function readMysqlConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const plat = (cfg.platforms || []).find(p => p.platform === 'ViessmannPlatform');
    const m = plat && plat.logging && plat.logging.mysql;
    if (!m || m.enabled !== true) return null;
    return {
      host: m.host || 'localhost', port: m.port || 3306,
      database: m.database || 'homebridge', user: m.user || 'viessmann_rw',
      password: m.password || '', table: m.table || 'viessmann_history',
    };
  } catch (e) {
    console.log('  MySQL: cannot read config (' + e.message + ') — skipping');
    return null;
  }
}

function isoToMysql(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').replace('Z', '');   // UTC, DATETIME(3)
}

async function writeToMysql(rows) {
  const m = readMysqlConfig();
  if (!m) { console.log('  MySQL: logging.mysql not enabled — skipping'); return; }
  let mysql2;
  try { mysql2 = require('mysql2/promise'); }
  catch { console.log('  MySQL: mysql2 module not found — skipping'); return; }
  const conn = await mysql2.createConnection({
    host: m.host, port: m.port, database: m.database, user: m.user, password: m.password,
  });
  try {
    const values = rows
      .map(r => [isoToMysql(r.timestamp), 'boiler', r.event_type,
        r.burner_active === 'true' ? 1 : r.burner_active === 'false' ? 0 : null,
        Number(INSTALLATION) || null])
      .filter(v => v[0]);
    let affected = 0;
    for (let i = 0; i < values.length; i += 500) {
      const [res] = await conn.query(
        'INSERT IGNORE INTO `' + m.table + '` (`ts`,`accessory`,`event_type`,`burner_active`,`installation_id`) VALUES ?',
        [values.slice(i, i + 500)]);
      affected += res.affectedRows || 0;
    }
    console.log(`  MySQL: ${affected} new event rows inserted into ${m.database}.${m.table} (${values.length - affected} already present)`);
  } finally {
    await conn.end();
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[viessmann-sync-events] installation=${INSTALLATION} days=${DAYS} path=${HB_PATH}${DRY_RUN ? ' DRY-RUN' : ''}`);

  const token = getToken();

  console.log('Fetching events-history from API...');
  const events = await fetchEvents(token, INSTALLATION, DAYS);

  if (!events.length) {
    console.log('No events found for the period.');
    return;
  }

  console.log('Parsing events into CSV rows...');
  const newRows = eventsToCsvRows(events);
  console.log(`  Parsed ${newRows.length} rows (S.6 ignition + demand events)`);

  // Deduplicate against existing CSV
  const existing = readExistingEventTimestamps();
  const toAdd    = newRows.filter(r => !existing.has(r.timestamp + '|' + r.event_type));
  console.log(`  New rows to add: ${toAdd.length} (skipping ${newRows.length - toAdd.length} already present)`);

  // Summary
  const byType = {};
  toAdd.forEach(r => { byType[r.event_type] = (byType[r.event_type]||0)+1; });
  console.log('  By type:', JSON.stringify(byType));

  if (DRY_RUN) {
    console.log('DRY-RUN: not writing to CSV / MySQL');
    toAdd.slice(0, 5).forEach(r =>
      console.log('  ', r.timestamp, r.event_type)
    );
    return;
  }

  // MySQL gets ALL parsed rows (INSERT IGNORE dedups) so older events are back-filled too
  if (!NO_MYSQL) {
    try { await writeToMysql(newRows); }
    catch (e) { console.log('  MySQL: write failed — ' + e.message); }
  }

  if (!toAdd.length) {
    console.log('Nothing to add to CSV.');
    return;
  }

  console.log('Writing to CSV...');
  appendToCsv(toAdd);

  console.log('Sorting CSV by timestamp...');
  sortCsv();

  // Final stats
  const lines = fs.readFileSync(CSV_FILE, 'utf8').trim().split('\n');
  console.log(`[viessmann-sync-events] Done. CSV now has ${lines.length - 1} rows.`);
}

main().catch(e => {
  console.error('[viessmann-sync-events] FATAL:', e.message);
  process.exit(1);
});
