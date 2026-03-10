#!/usr/bin/env node
/**
 * Viessmann History Report Generator
 * Reads viessmann-history.csv and generates an interactive HTML report
 * with Chart.js graphs (no extra dependencies — Chart.js loaded via CDN).
 *
 * Usage:
 *   node /usr/local/lib/node_modules/homebridge-viessmann-vicare/viessmann-report.js
 *   node /usr/local/lib/node_modules/homebridge-viessmann-vicare/viessmann-report.js --days 7
 *   node /usr/local/lib/node_modules/homebridge-viessmann-vicare/viessmann-report.js --days 30 --out /tmp/report.html
 *
 * No extra dependencies needed — open the generated HTML in any browser.
 * CSV file: /var/lib/homebridge/viessmann-history.csv
 */

'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 && args[i+1] ? args[i+1] : def; };
const DAYS = parseInt(getArg('--days', '7'), 10);
const HB_PATH = getArg('--path', '/var/lib/homebridge');
const CSV_FILE = path.join(HB_PATH, 'viessmann-history.csv');
const today = new Date().toISOString().slice(0, 10);
const OUT_FILE = getArg('--out', path.join(HB_PATH, `viessmann-report-${today}.html`));

if (!fs.existsSync(CSV_FILE)) {
  console.error(`ERROR: CSV not found: ${CSV_FILE}\nStart Homebridge with the plugin to begin collecting data.`);
  process.exit(1);
}

const lines = fs.readFileSync(CSV_FILE, 'utf8').trim().split('\n');
const headers = lines[0].split(',').map(h => h.trim());
const rows = lines.slice(1).map(line => {
  const vals = line.split(',');
  const obj = {};
  headers.forEach((h, i) => { obj[h] = vals[i]?.trim() || ''; });
  return obj;
});

const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - DAYS);
const filtered = rows.filter(r => r.timestamp && new Date(r.timestamp) >= cutoff);
if (!filtered.length) { console.error(`ERROR: No data in the last ${DAYS} days.`); process.exit(1); }

console.log(`Generating HTML report for last ${DAYS} days (${filtered.length} data points)...`);

const toNum = v => parseFloat(v) || 0;
const avg = (arr, key) => { const v = arr.map(r => toNum(r[key])).filter(x => x > 0); return v.length ? (v.reduce((a,b)=>a+b,0)/v.length).toFixed(1) : null; };
const maxVal = (arr, key) => { const v = arr.map(r => toNum(r[key])).filter(x => x > 0); return v.length ? Math.max(...v).toFixed(1) : null; };

const boilerRows = filtered.filter(r => r.accessory === 'boiler');
const hcRows     = filtered.filter(r => r.accessory === 'hc0');
const dhwRows    = filtered.filter(r => r.accessory === 'dhw');
const energyRows = filtered.filter(r => r.accessory === 'energy');

const burnerOnPct   = boilerRows.length ? ((boilerRows.filter(r => r.burner_active==='true').length/boilerRows.length)*100).toFixed(0) : null;
const avgMod        = avg(boilerRows, 'modulation');
const maxMod        = maxVal(boilerRows, 'modulation');
const avgRoom       = avg(hcRows, 'room_temp');
const avgTarget     = avg(hcRows, 'target_temp');
const avgDhw        = avg(dhwRows, 'dhw_temp');
const avgDhwTarget  = avg(dhwRows, 'dhw_target');

// Energy stats
const hasPV      = energyRows.some(r => r.pv_production_w !== '');
const hasBattery = energyRows.some(r => r.battery_level !== '');
const hasWallbox = energyRows.some(r => r.wallbox_charging !== '');
const avgPV      = avg(energyRows, 'pv_production_w');
const maxPV      = maxVal(energyRows, 'pv_production_w');
const latestEnergy = energyRows[energyRows.length-1] || {};
const lastPvDaily   = latestEnergy.pv_daily_kwh   || null;
const lastBattLevel = latestEnergy.battery_level  || null;
const avgWallboxPwr = avg(energyRows.filter(r => r.wallbox_charging==='true'), 'wallbox_power_w');

const lb = boilerRows[boilerRows.length-1] || {};
const burnerStarts  = lb.burner_starts || null;
const burnerHours   = lb.burner_hours  || null;
const sph = (burnerStarts && burnerHours && parseFloat(burnerHours) > 0) ? (parseFloat(burnerStarts)/parseFloat(burnerHours)).toFixed(2) : null;
const effCls   = sph ? (parseFloat(sph) < 2 ? 'good' : 'warn') : 'neutral';
const effLabel = sph ? (parseFloat(sph) < 2 ? 'Good' : 'High cycling') : 'N/A';

// --- Flow temperature stats (from hc0 rows) ---
const avgFlow  = avg(hcRows, 'flow_temp');
const maxFlow  = maxVal(hcRows, 'flow_temp');
// Condensing efficiency: flow < 55°C means returning in condensing range (proxy, no return sensor)
const flowVals = hcRows.map(r => parseFloat(r.flow_temp)).filter(v => !isNaN(v) && v > 0);
const condensingPct = flowVals.length ? ((flowVals.filter(v => v < 55).length / flowVals.length) * 100).toFixed(0) : null;
const condensingCls = condensingPct !== null ? (parseFloat(condensingPct) >= 80 ? 'good' : parseFloat(condensingPct) >= 40 ? 'warn' : 'neutral') : 'neutral';
const condensingLabel = condensingPct !== null ? (parseFloat(condensingPct) >= 80 ? 'Condensing ✓' : parseFloat(condensingPct) >= 40 ? 'Borderline' : 'Not condensing') : 'N/A';

// --- Gas consumption (real data from API, m³/day) ---
const hasGasData = boilerRows.some(r => r.gas_heating_day_m3 !== '' && r.gas_heating_day_m3 !== undefined);
const latestGasRow = [...boilerRows].reverse().find(r => r.gas_heating_day_m3 !== '' && r.gas_heating_day_m3 !== undefined) || {};
const gasHeatingToday  = latestGasRow.gas_heating_day_m3  || null;
const gasDhwToday      = latestGasRow.gas_dhw_day_m3      || null;
const gasTotalToday    = (gasHeatingToday && gasDhwToday) ? (parseFloat(gasHeatingToday) + parseFloat(gasDhwToday)).toFixed(2) : gasHeatingToday || null;

// --- Daily gas aggregation (max per calendar day = total consumption for that day) ---
const gasPerDay = {};
boilerRows.forEach(r => {
  if (!r.gas_heating_day_m3 && !r.gas_dhw_day_m3) return;
  const day = r.timestamp.slice(0, 10);
  if (!gasPerDay[day]) gasPerDay[day] = { heating: 0, dhw: 0 };
  gasPerDay[day].heating = Math.max(gasPerDay[day].heating, parseFloat(r.gas_heating_day_m3) || 0);
  gasPerDay[day].dhw     = Math.max(gasPerDay[day].dhw,     parseFloat(r.gas_dhw_day_m3)     || 0);
});
const gasDays         = Object.keys(gasPerDay).sort();
const gasBarLabels    = gasDays.map(d => { const [y,m,dd]=d.split('-'); return `${dd}/${m}`; });
const gasBarHeating   = gasDays.map(d => +gasPerDay[d].heating.toFixed(2));
const gasBarDhw       = gasDays.map(d => +gasPerDay[d].dhw.toFixed(2));
const gasLineTotal    = gasDays.map(d => +(gasPerDay[d].heating + gasPerDay[d].dhw).toFixed(2));
const hasGasChart     = gasDays.length >= 1;

// --- Heating schedule ---
const SCHED_FILE = path.join(HB_PATH, 'viessmann-schedule.json');
let heatingSchedule = null;
try {
  if (fs.existsSync(SCHED_FILE)) {
    heatingSchedule = JSON.parse(fs.readFileSync(SCHED_FILE, 'utf8'));
  }
} catch(_) {}

// Given a Date, return expected program from schedule ('normal'|'reduced'|'comfort'|null)
function expectedProgram(dt) {
  if (!heatingSchedule?.entries) return null;
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  const dayKey = days[dt.getDay()];
  const slots = heatingSchedule.entries[dayKey] || [];
  const hhmm = dt.getHours() * 60 + dt.getMinutes();
  for (const s of slots) {
    const [sh, sm] = s.start.split(':').map(Number);
    const [eh, em] = s.end.split(':').map(Number);
    if (hhmm >= sh * 60 + sm && hhmm < eh * 60 + em) return s.mode;
  }
  return 'reduced';
}

// Build today's schedule slots as human-readable string
function todayScheduleText() {
  if (!heatingSchedule?.entries) return null;
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  const dayKey = days[new Date().getDay()];
  const slots = heatingSchedule.entries[dayKey] || [];
  if (!slots.length) return 'reduced (all day)';
  const parts = slots.map(s => `${s.start}–${s.end} ${s.mode}`);
  return parts.join(', ') + ' · rest: reduced';
}

// Build background annotation bands for overview chart (one band per normal slot today)
function schedBands() {
  if (!heatingSchedule?.entries) return [];
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  const bands = [];
  // For each day in the report period build bands
  const now = new Date();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dayKey = days[d.getDay()];
    const dateStr = d.toISOString().slice(0,10);
    const slots = heatingSchedule.entries[dayKey] || [];
    for (const s of slots) {
      bands.push({ date: dateStr, start: s.start, end: s.end, mode: s.mode });
    }
  }
  return bands;
}

const scheduleToday = todayScheduleText();
const schedBandData = schedBands();

// --- Heat demand: avg modulation × nominal power ---
const NOMINAL_KW = typeof process.env.NOMINAL_KW !== 'undefined' ? parseFloat(process.env.NOMINAL_KW) : 24;
const activeBurnerRows = boilerRows.filter(r => r.burner_active === 'true' && toNum(r.modulation) > 0);
const avgHeatDemand = activeBurnerRows.length
  ? ((activeBurnerRows.reduce((s,r) => s + toNum(r.modulation), 0) / activeBurnerRows.length / 100) * NOMINAL_KW).toFixed(1)
  : null;

// --- Burner cycle analysis ---
// Reconstruct ON/OFF edges from boilerRows sorted by time
const sortedBoiler = [...boilerRows].sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
const cycles = [];
let cycleStart = null;
for (let i = 0; i < sortedBoiler.length; i++) {
  const on = sortedBoiler[i].burner_active === 'true';
  if (on && cycleStart === null) cycleStart = new Date(sortedBoiler[i].timestamp);
  if (!on && cycleStart !== null) {
    const durationMin = (new Date(sortedBoiler[i].timestamp) - cycleStart) / 60000;
    if (durationMin >= 1) cycles.push(durationMin); // ignore <1 min noise
    cycleStart = null;
  }
}
const cycleCount      = cycles.length;
const avgCycleDur     = cycleCount ? (cycles.reduce((a,b)=>a+b,0)/cycleCount).toFixed(0) : null;
const shortestCycle   = cycleCount ? Math.min(...cycles).toFixed(0) : null;
const shortCycleCls   = shortestCycle ? (parseFloat(shortestCycle) < 5 ? 'warn' : 'good') : 'neutral';
// Histogram buckets: 0-5, 5-10, 10-20, 20-40, 40+
const histBuckets = [
  { label:'0–5 min',  min:0,  max:5  },
  { label:'5–10 min', min:5,  max:10 },
  { label:'10–20 min',min:10, max:20 },
  { label:'20–40 min',min:20, max:40 },
  { label:'40+ min',  min:40, max:Infinity }
];
const histData = histBuckets.map(b => cycles.filter(d => d >= b.min && d < b.max).length);

const programs = {};
hcRows.forEach(r => { if (r.program) programs[r.program] = (programs[r.program]||0)+1; });
const totalProg = Object.values(programs).reduce((a,b)=>a+b,0);
const progDist = Object.entries(programs).map(([k,v]) => ({ label: k.charAt(0).toUpperCase()+k.slice(1), pct: ((v/totalProg)*100).toFixed(0) }));

function subsample(arr, max=200) {
  if (arr.length <= max) return arr;
  const step = Math.ceil(arr.length/max);
  return arr.filter((_,i) => i%step===0);
}
function chartData(arr, key) {
  const s = subsample(arr);
  return {
    labels: s.map(r => { const d=new Date(r.timestamp); return `${d.toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit'})} ${d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}`; }),
    values: s.map(r => toNum(r[key])||null)
  };
}

const modChart    = chartData(boilerRows, 'modulation');
const roomChart   = chartData(hcRows, 'room_temp');
const targetChart = chartData(hcRows, 'target_temp');
const flowChart   = chartData(hcRows, 'flow_temp');
const dhwChart    = chartData(dhwRows, 'dhw_temp');
const dhwTgtChart = chartData(dhwRows, 'dhw_target');
const outsideChart = chartData(boilerRows, 'outside_temp');
// Energy charts
const pvChart      = chartData(energyRows, 'pv_production_w');
const battChart    = chartData(energyRows, 'battery_level');
const battChrChart = chartData(energyRows, 'battery_charging_w');
const battDisChart = chartData(energyRows, 'battery_discharging_w');
const wallboxChart = chartData(energyRows, 'wallbox_power_w');
const sBurner     = subsample(boilerRows);
const burnerChart = {
  labels: sBurner.map(r => { const d=new Date(r.timestamp); return `${d.toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit'})} ${d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}`; }),
  values: sBurner.map(r => r.burner_active==='true' ? 1 : 0)
};

// --- Overview chart: merge all rows on a unified timeline ---
// Build a time-indexed map for each series, then interpolate to a shared timeline
const allTimes = [...new Set(filtered.map(r => r.timestamp))].sort();
const overviewTimes = subsample(allTimes, 200);
// Linear interpolation on a sorted array of rows
function interpolate(arr, ts, key) {
  const t = new Date(ts).getTime();
  const valid = arr.filter(r => r[key] !== '' && r[key] !== undefined && !isNaN(toNum(r[key])));
  if (!valid.length) return null;
  // exact match
  const exact = valid.find(r => new Date(r.timestamp).getTime() === t);
  if (exact) return toNum(exact[key]);
  // find prev and next
  let prev = null, next = null;
  for (const r of valid) {
    const rt = new Date(r.timestamp).getTime();
    if (rt <= t) prev = r;
    else if (rt > t && !next) next = r;
  }
  if (prev && next) {
    const t0 = new Date(prev.timestamp).getTime();
    const t1 = new Date(next.timestamp).getTime();
    const ratio = (t - t0) / (t1 - t0);
    return +(toNum(prev[key]) + ratio * (toNum(next[key]) - toNum(prev[key]))).toFixed(2);
  }
  // extrapolate up to 1 hour at edges
  if (prev && (t - new Date(prev.timestamp).getTime()) < 60*60*1000) return toNum(prev[key]);
  if (next && (new Date(next.timestamp).getTime() - t) < 60*60*1000) return toNum(next[key]);
  return null;
}
// Burner is stepped (boolean) — use nearest within 20 min, no interpolation
function lookupBurner(arr, ts) {
  const t = new Date(ts).getTime();
  let best = null, bestDiff = Infinity;
  for (const r of arr) {
    const diff = Math.abs(new Date(r.timestamp).getTime() - t);
    if (diff < bestDiff) { bestDiff = diff; best = r; }
  }
  return (best && bestDiff < 20*60*1000) ? (best.burner_active==='true' ? 100 : 0) : null;
}

const ovLabels   = overviewTimes.map(ts => { const d=new Date(ts); return `${d.toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit'})} ${d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}`; });
const ovRoom     = overviewTimes.map(ts => interpolate(hcRows,    ts, 'room_temp'));
const ovSetpoint = overviewTimes.map(ts => interpolate(hcRows,    ts, 'target_temp'));
const ovFlow     = overviewTimes.map(ts => interpolate(hcRows,    ts, 'flow_temp'));
const ovDhw      = overviewTimes.map(ts => interpolate(dhwRows,   ts, 'dhw_temp'));
const ovOutside  = overviewTimes.map(ts => interpolate(boilerRows, ts, 'outside_temp'));
const ovOutsideHum = overviewTimes.map(ts => interpolate(boilerRows, ts, 'outside_humidity'));
const ovMod      = overviewTimes.map(ts => interpolate(boilerRows,ts, 'modulation'));
const ovBurner   = overviewTimes.map(ts => lookupBurner(boilerRows, ts));

const sc = (l,v,u='',badge='') => `<div class="sc"><div class="sl">${l}</div><div class="sv">${v!==null?v+u:'<span class="na">N/A</span>'} ${badge}</div></div>`;
const badge = (cls,txt) => `<span class="badge badge-${cls}">${txt}</span>`;
const genAt = new Date().toLocaleString('en-GB');
const periodStart = cutoff.toLocaleDateString('en-GB');
const periodEnd = new Date().toLocaleDateString('en-GB');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Viessmann Report ${today}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f6fa;color:#2d2d2d}
header{background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;padding:26px 32px}
header h1{font-size:20px;font-weight:700}
header p{font-size:12px;opacity:.65;margin-top:5px}
.wrap{max-width:1080px;margin:0 auto;padding:24px 16px}
.box{background:#fff;border-radius:12px;padding:22px 24px;margin-bottom:22px;box-shadow:0 1px 4px rgba(0,0,0,.07)}
.box h2{font-size:15px;font-weight:700;color:#1a1a2e;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid #f0f0f0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:18px}
.sc{background:#f8f9fc;border-radius:8px;padding:13px 15px}
.sl{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#999;margin-bottom:5px}
.sv{font-size:19px;font-weight:700;color:#1a1a2e}
.na{font-size:13px;color:#bbb;font-weight:400}
.badge{font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;vertical-align:middle}
.badge-good{background:#e6f4ea;color:#2d7a3a}
.badge-warn{background:#fff3e0;color:#e65100}
.badge-neutral{background:#eee;color:#777}
.ch{position:relative;height:210px;margin-top:6px}
.ch-tall{position:relative;height:250px;margin-top:6px}
.ch-overview{position:relative;height:320px;margin-top:6px}
.note{font-size:11px;color:#aaa;margin-top:8px;font-style:italic}
.pbars{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
.pb{flex:1;min-width:90px}
.pbl{font-size:10px;color:#999;margin-bottom:4px}
.pbt{background:#f0f0f0;border-radius:3px;height:7px}
.pbf{height:7px;border-radius:3px}
.fill-normal{background:#4e9af1}
.fill-reduced{background:#f1c94e}
.fill-comfort{background:#f17c4e}
.pbp{font-size:11px;font-weight:600;margin-top:3px}
footer{text-align:center;font-size:10px;color:#bbb;padding:16px}
@media(max-width:500px){.grid{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<header>
  <h1>Viessmann ViCare — History Report</h1>
  <p>Period: ${periodStart} — ${periodEnd} &nbsp;(last ${DAYS} days) &nbsp;|&nbsp; Generated: ${genAt} &nbsp;|&nbsp; ${filtered.length} samples</p>
</header>
<div class="wrap">

<div class="box">
  <h2>Overview</h2>
  <div class="ch-overview"><canvas id="cOverview"></canvas></div>
  <p class="note">Left axis: temperatures (°C) — Right axis: modulation, burner & outdoor humidity (% / 0–100)</p>
</div>

<div class="box">
  <h2>Boiler — Burner</h2>
  <div class="grid">
    ${sc('Lifetime starts', burnerStarts)}
    ${sc('Running hours', burnerHours, 'h')}
    ${sc('Starts/hour', sph, '', badge(effCls, effLabel))}
    ${sc('Burner active', burnerOnPct, '% samples')}
    ${sc('Avg modulation', avgMod, '%')}
    ${sc('Max modulation', maxMod, '%')}
    ${avgHeatDemand ? sc('Avg heat demand', avgHeatDemand, ' kW') : ''}
    ${hasGasData ? sc('Gas heating today', gasHeatingToday, ' m³') : ''}
    ${hasGasData && gasDhwToday ? sc('Gas DHW today', gasDhwToday, ' m³') : ''}
    ${hasGasData && gasTotalToday ? sc('Gas total today', gasTotalToday, ' m³') : ''}
    ${cycleCount > 0 ? sc('Cycles (period)', cycleCount) : ''}
    ${avgCycleDur ? sc('Avg cycle', avgCycleDur, ' min') : ''}
    ${shortestCycle ? sc('Shortest cycle', shortestCycle, ' min', badge(shortCycleCls, parseFloat(shortestCycle)<5?'⚠ Short':'OK')) : ''}
  </div>
  ${boilerRows.length < 5 ? `<p class="note">Only ${boilerRows.length} samples — data will accumulate over time (~1 every 15 min).</p>` : ''}
  ${boilerRows.length >= 2 ? `<div class="ch"><canvas id="cMod"></canvas></div><div class="ch" style="margin-top:14px"><canvas id="cBurner"></canvas></div>` : ''}
  ${cycleCount >= 3 ? `<div style="margin-top:18px"><div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-bottom:10px">Cycle duration histogram</div><div class="ch"><canvas id="cCycleHist"></canvas></div><p class="note">Distribution of burner ON durations. Short cycles (&lt;5 min) indicate short-cycling.</p></div>` : ''}
  ${hasGasChart ? `<div style="margin-top:18px"><div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-bottom:10px">Daily gas consumption (m³)</div><div class="ch-tall"><canvas id="cGas"></canvas></div><p class="note">Stacked bars: heating (dark blue) + DHW (teal). Red line: daily total. Today's bar shows current accumulated value.</p></div>` : ''}
</div>

<div class="box">
  <h2>Heating Circuit (HC0)</h2>
  <div class="grid">
    ${sc('Avg room temp', avgRoom, '°C')}
    ${sc('Avg setpoint', avgTarget, '°C')}
    ${avgFlow ? sc('Avg flow temp', avgFlow, '°C') : ''}
    ${maxFlow ? sc('Max flow temp', maxFlow, '°C') : ''}
    ${condensingPct !== null ? sc('Condensing mode', condensingPct, '% time', badge(condensingCls, condensingLabel)) : ''}
    ${scheduleToday ? sc('Today\'s schedule', scheduleToday) : ''}
  </div>
  ${progDist.length ? `<div style="margin-bottom:16px"><div class="sl" style="margin-bottom:8px">Program distribution</div>
  <div class="pbars">${progDist.map(p=>`<div class="pb"><div class="pbl">${p.label}</div><div class="pbt"><div class="pbf fill-${p.label.toLowerCase()}" style="width:${p.pct}%"></div></div><div class="pbp">${p.pct}%</div></div>`).join('')}</div></div>` : ''}
  ${hcRows.length >= 2 ? `<div class="ch-tall"><canvas id="cRoom"></canvas></div>` : ''}
  ${flowVals.length >= 2 ? `<div class="ch" style="margin-top:14px"><canvas id="cFlow"></canvas></div><p class="note">Flow temperature (supply) — proxy for condensing efficiency. Below 55°C = condensing range.</p>` : ''}
</div>

<div class="box">
  <h2>Domestic Hot Water (DHW)</h2>
  <div class="grid">
    ${sc('Avg temp', avgDhw, '°C')}
    ${sc('Avg setpoint', avgDhwTarget, '°C')}
  </div>
  ${dhwRows.length >= 2 ? `<div class="ch-tall"><canvas id="cDhw"></canvas></div>` : ''}
</div>

${energyRows.length >= 1 ? `
<div class="box">
  <h2>Energy System</h2>
  <div class="grid">
    ${hasPV ? sc('PV avg production', avgPV, 'W') : ''}
    ${hasPV ? sc('PV max production', maxPV, 'W') : ''}
    ${hasPV ? sc('PV yield (latest day)', lastPvDaily, 'kWh') : ''}
    ${hasBattery ? sc('Battery level (latest)', lastBattLevel, '%') : ''}
    ${hasWallbox ? sc('Wallbox avg power', avgWallboxPwr, 'W') : ''}
  </div>
  ${energyRows.length < 5 ? `<p class="note">Only ${energyRows.length} samples — data will accumulate over time (~1 every 15 min).</p>` : ''}
  ${hasPV && energyRows.length >= 2 ? `<div class="ch-tall"><canvas id="cPV"></canvas></div>` : ''}
  ${hasBattery && energyRows.length >= 2 ? `<div class="ch-tall" style="margin-top:14px"><canvas id="cBatt"></canvas></div>` : ''}
  ${hasWallbox && energyRows.length >= 2 ? `<div class="ch" style="margin-top:14px"><canvas id="cWallbox"></canvas></div>` : ''}
</div>` : ''}

</div>
<footer>homebridge-viessmann-vicare &nbsp;|&nbsp; ${CSV_FILE}</footer>

<script>
Chart.defaults.font.family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
Chart.defaults.font.size=11;Chart.defaults.color='#888';

function mk(id,labels,datasets,yLbl){
  const c=document.getElementById(id); if(!c)return;
  new Chart(c,{type:'line',data:{labels,datasets},options:{
    responsive:true,maintainAspectRatio:false,
    interaction:{mode:'index',intersect:false},
    plugins:{legend:{position:'top',labels:{boxWidth:11,padding:14}}},
    scales:{
      x:{ticks:{maxTicksLimit:8,maxRotation:30},grid:{color:'#f5f5f5'}},
      y:{title:{display:!!yLbl,text:yLbl},grid:{color:'#f5f5f5'}}
    }
  }});
}

// Overview chart — dual Y axis
(function(){
  const c=document.getElementById('cOverview'); if(!c)return;
  new Chart(c,{type:'line',data:{
    labels:${JSON.stringify(ovLabels)},
    datasets:[
      {label:'Room temp (°C)', yAxisID:'yTemp', data:${JSON.stringify(ovRoom)},    borderColor:'#4e9af1',backgroundColor:'rgba(78,154,241,.06)',fill:true, tension:0.3,pointRadius:1,borderWidth:2},
      {label:'HC0 setpoint (°C)',   yAxisID:'yTemp', data:${JSON.stringify(ovSetpoint)},borderColor:'#f1c94e',backgroundColor:'transparent',             fill:false,tension:0.3,pointRadius:0,borderWidth:1.5,borderDash:[5,4]},
      ...(${JSON.stringify(ovFlow)}.some(v=>v!==null) ? [{label:'Flow temp (°C)', yAxisID:'yTemp', data:${JSON.stringify(ovFlow)}, borderColor:'#ef5350',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:1.5,borderDash:[2,2]}] : []),
      {label:'DHW temp (°C)',      yAxisID:'yTemp', data:${JSON.stringify(ovDhw)},     borderColor:'#00897b',backgroundColor:'rgba(0,137,123,.04)',fill:false,tension:0.3,pointRadius:1,borderWidth:1.5},
      {label:'Outdoor temp (°C)',  yAxisID:'yTemp', data:${JSON.stringify(ovOutside)}, borderColor:'#90a4ae',backgroundColor:'transparent',             fill:false,tension:0.3,pointRadius:0,borderWidth:1.5,borderDash:[3,3]},
      {label:'Modulation (%)',     yAxisID:'yRight',data:${JSON.stringify(ovMod)},     borderColor:'#e65100',backgroundColor:'rgba(230,81,0,.04)',fill:false,tension:0.3,pointRadius:0,borderWidth:1.5},
      {label:'Burner (0/100)',  yAxisID:'yRight',data:${JSON.stringify(ovBurner)},  borderColor:'#37474f',backgroundColor:'rgba(55,71,79,.07)', fill:true, tension:0,  pointRadius:0,borderWidth:1,stepped:true},
      ...(${JSON.stringify(ovOutsideHum)}.some(v=>v!==null) ? [{label:'Outdoor humidity (%)', yAxisID:'yRight',data:${JSON.stringify(ovOutsideHum)},borderColor:'#7986cb',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:1.5,borderDash:[4,2]}] : [])
    ]
  },options:{
    responsive:true,maintainAspectRatio:false,
    interaction:{mode:'index',intersect:false},
    plugins:{legend:{position:'top',labels:{boxWidth:11,padding:12,usePointStyle:true}}},
    scales:{
      x:{ticks:{maxTicksLimit:10,maxRotation:30},grid:{color:'#f5f5f5'}},
      yTemp:{type:'linear',position:'left', title:{display:true,text:'°C'},grid:{color:'#f5f5f5'},ticks:{color:'#4e9af1'}},
      yRight:{type:'linear',position:'right',title:{display:true,text:'% / ON–OFF'},grid:{drawOnChartArea:false},min:0,max:110,ticks:{color:'#e65100'}}
    }
    }});

  // Schedule bands overlay — draw after chart renders
  ${schedBandData.length ? `
  (function(){
    const bands = ${JSON.stringify(schedBandData)};
    const labels = ${JSON.stringify(ovLabels)};
    const chart = Chart.getChart(document.getElementById('cOverview'));
    if(!chart) return;
    // Convert label "dd/MM HH:MM" to comparable minutes-since-midnight * date
    function labelToMins(label) {
      // label format: "10/03 15:48"
      const m = label.match(/(\d+)\/(\d+) (\d+):(\d+)/);
      if(!m) return 0;
      return parseInt(m[2])*100000 + parseInt(m[1])*1440 + parseInt(m[3])*60 + parseInt(m[4]);
    }
    function bandToMins(dateStr, timeStr) {
      // dateStr: "2026-03-10", timeStr: "17:00"
      const [y,mo,d] = dateStr.split('-');
      const [h,mi] = timeStr.split(':');
      return parseInt(mo)*100000 + parseInt(d)*1440 + parseInt(h)*60 + parseInt(mi);
    }
    Chart.register({
      id: 'schedBands',
      beforeDraw(ch) {
        const {ctx, chartArea:{left,right,top,bottom}, scales:{x}} = ch;
        if(!x) return;
        ctx.save();
        bands.forEach(b => {
          const m0 = bandToMins(b.date, b.start);
          const m1 = bandToMins(b.date, b.end);
          // find label indices by numeric time comparison
          let i0 = labels.findIndex(l => labelToMins(l) >= m0);
          let i1 = labels.findIndex(l => labelToMins(l) >= m1);
          if(i0 < 0) return; // band entirely before data range
          if(i1 < 0) i1 = labels.length - 1;
          const x0 = x.getPixelForValue(i0);
          const x1 = x.getPixelForValue(i1);
          if(x1 < left || x0 > right) return;
          ctx.fillStyle = b.mode === 'normal' ? 'rgba(78,154,241,0.10)' : b.mode === 'comfort' ? 'rgba(255,152,0,0.12)' : 'rgba(180,180,180,0.06)';
          ctx.fillRect(Math.max(x0,left), top, Math.min(x1,right)-Math.max(x0,left), bottom-top);
        });
        ctx.restore();
      }
    });
    chart.update();
  })();
  ` : ''}
})();
${boilerRows.length>=2?`
mk('cMod',${JSON.stringify(modChart.labels)},[{label:'Modulation (%)',data:${JSON.stringify(modChart.values)},borderColor:'#e65100',backgroundColor:'rgba(230,81,0,.07)',fill:true,tension:0.3,pointRadius:2,borderWidth:2}],'%');
mk('cBurner',${JSON.stringify(burnerChart.labels)},[{label:'Burner (1=ON 0=OFF)',data:${JSON.stringify(burnerChart.values)},borderColor:'#1a1a2e',backgroundColor:'rgba(26,26,46,.06)',fill:true,tension:0,pointRadius:0,borderWidth:1.5,stepped:true}],'');`:''}
${hcRows.length>=2?`
mk('cRoom',${JSON.stringify(roomChart.labels)},[
  {label:'Room temp (°C)',data:${JSON.stringify(roomChart.values)},borderColor:'#4e9af1',backgroundColor:'rgba(78,154,241,.07)',fill:true,tension:0.3,pointRadius:2,borderWidth:2},
  {label:'Setpoint (°C)',data:${JSON.stringify(targetChart.values)},borderColor:'#f1c94e',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:2,borderDash:[5,4]}
],'°C');`:''}
${flowVals.length>=2?`
mk('cFlow',${JSON.stringify(flowChart.labels)},[{label:'Flow temp (°C)',data:${JSON.stringify(flowChart.values)},borderColor:'#ef5350',backgroundColor:'rgba(239,83,80,.07)',fill:true,tension:0.3,pointRadius:2,borderWidth:2}],'°C');
`:''}
${cycleCount>=3?`
(function(){const c=document.getElementById('cCycleHist');if(!c)return;new Chart(c,{type:'bar',data:{labels:${JSON.stringify(histBuckets.map(b=>b.label))},datasets:[{label:'Cycles',data:${JSON.stringify(histData)},backgroundColor:${JSON.stringify(histData.map((_,i)=>i===0?'rgba(239,83,80,.7)':'rgba(78,154,241,.6)'))},borderColor:${JSON.stringify(histData.map((_,i)=>i===0?'#ef5350':'#4e9af1'))},borderWidth:1.5,borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{color:'#f5f5f5'}},y:{title:{display:true,text:'# cycles'},ticks:{stepSize:1}}}}});})();
`:''}
${hasGasChart?`
(function(){
  const c=document.getElementById('cGas'); if(!c)return;
  new Chart(c,{
    type:'bar',
    data:{
      labels:${JSON.stringify(gasBarLabels)},
      datasets:[
        {type:'bar', label:'Heating (m\u00b3)', data:${JSON.stringify(gasBarHeating)}, backgroundColor:'rgba(26,86,180,.75)', borderColor:'#1a56b4', borderWidth:1, borderRadius:3, stack:'gas'},
        {type:'bar', label:'DHW (m\u00b3)',     data:${JSON.stringify(gasBarDhw)},     backgroundColor:'rgba(0,137,123,.65)', borderColor:'#00897b', borderWidth:1, borderRadius:3, stack:'gas'},
        {type:'line',label:'Total (m\u00b3)',   data:${JSON.stringify(gasLineTotal)},  borderColor:'#e53935', backgroundColor:'transparent', borderWidth:2, pointRadius:4, pointBackgroundColor:'#e53935', tension:0.3, yAxisID:'y'}
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{position:'top',labels:{boxWidth:11,padding:12}}},
      scales:{
        x:{grid:{color:'#f5f5f5'},stacked:true},
        y:{title:{display:true,text:'m\u00b3'},grid:{color:'#f5f5f5'},stacked:true,beginAtZero:true}
      }
    }
  });
})();
`:''}
${dhwRows.length>=2?`
mk('cDhw',${JSON.stringify(dhwChart.labels)},[
  {label:'DHW temp (°C)',data:${JSON.stringify(dhwChart.values)},borderColor:'#00897b',backgroundColor:'rgba(0,137,123,.07)',fill:true,tension:0.3,pointRadius:2,borderWidth:2},
  {label:'DHW setpoint (°C)',data:${JSON.stringify(dhwTgtChart.values)},borderColor:'#80cbc4',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:2,borderDash:[5,4]}
],'°C');`:''}
${hasPV&&energyRows.length>=2?`
mk('cPV',${JSON.stringify(pvChart.labels)},[{label:'PV production (W)',data:${JSON.stringify(pvChart.values)},borderColor:'#f9a825',backgroundColor:'rgba(249,168,37,.1)',fill:true,tension:0.3,pointRadius:2,borderWidth:2}],'W');`:''}\n${hasBattery&&energyRows.length>=2?`
mk('cBatt',${JSON.stringify(battChart.labels)},[{label:'Battery level (%)',data:${JSON.stringify(battChart.values)},borderColor:'#43a047',backgroundColor:'rgba(67,160,71,.08)',fill:true,tension:0.3,pointRadius:2,borderWidth:2},{label:'Charging (W)',data:${JSON.stringify(battChrChart.values)},borderColor:'#1e88e5',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:1.5,borderDash:[4,3]},{label:'Discharging (W)',data:${JSON.stringify(battDisChart.values)},borderColor:'#e53935',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:1.5,borderDash:[4,3]}],'');`:''}\n${hasWallbox&&energyRows.length>=2?`
mk('cWallbox',${JSON.stringify(wallboxChart.labels)},[{label:'Wallbox power (W)',data:${JSON.stringify(wallboxChart.values)},borderColor:'#7b1fa2',backgroundColor:'rgba(123,31,162,.08)',fill:true,tension:0.3,pointRadius:2,borderWidth:2}],'W');`:''}\n<\/script>
</body></html>`;

fs.writeFileSync(OUT_FILE, html, 'utf8');
console.log(`Report generated: ${OUT_FILE}`);
console.log(`Open in browser: file://${OUT_FILE}`);
