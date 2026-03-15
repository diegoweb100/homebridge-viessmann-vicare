#!/usr/bin/env node
/**
 * Viessmann History Report Generator
 * Reads viessmann-history.csv and generates an interactive HTML report
 * with Chart.js graphs (no extra dependencies — Chart.js loaded via CDN).
 *
 * Usage:
 *   node viessmann-report.js --installation 2045571
 *   node viessmann-report.js --installation 2045571 --days 7
 *   node viessmann-report.js --installation 2045571 --days 30 --out /tmp/report.html
 *
 * --installation <ID>  Installation ID (creates viessmann-history-<ID>.csv)
 * --days <N>           Number of days to include (default: 7)
 * --path <dir>         Homebridge storage path (default: /var/lib/homebridge)
 * --out <file>         Output HTML file path
 *
 * No extra dependencies needed — open the generated HTML in any browser.
 */

'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 && args[i+1] ? args[i+1] : def; };
const DAYS = parseInt(getArg('--days', '7'), 10);
const HB_PATH = getArg('--path', '/var/lib/homebridge');
const INSTALLATION_ID = getArg('--installation', '');
const csvSuffix = INSTALLATION_ID ? `-${INSTALLATION_ID}` : '';
const CSV_FILE = path.join(HB_PATH, `viessmann-history${csvSuffix}.csv`);
const SCHED_FILE_PATH = INSTALLATION_ID
  ? path.join(HB_PATH, `viessmann-schedule-${INSTALLATION_ID}.json`)
  : path.join(HB_PATH, 'viessmann-schedule.json');
const today = new Date().toISOString().slice(0, 10);
const outSuffix = INSTALLATION_ID ? `-${INSTALLATION_ID}` : '';
const OUT_FILE = getArg('--out', path.join(HB_PATH, `viessmann-report${outSuffix}-${today}.html`));

if (!fs.existsSync(CSV_FILE)) {
  const hint = INSTALLATION_ID ? '' : '\nTip: use --installation <ID> to specify an installation (e.g. --installation 2045571)';
  console.error(`ERROR: CSV not found: ${CSV_FILE}${hint}\nStart Homebridge with the plugin to begin collecting data.`);
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
const SCHED_FILE = SCHED_FILE_PATH;
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

// --- Schedule bar HTML (pre-computed server-side, injected as static HTML) ---
function buildScheduleBarHtml() {
  if (!heatingSchedule?.entries) return '';
  const COLORS = { normal:'#4caf50', comfort:'#ff9800', reduced:'#90a4ae', off:'#ef5350' };
  const DAYS = ['sun','mon','tue','wed','thu','fri','sat'];
  const entries = heatingSchedule.entries;
  const totalMins = 24 * 60;

  // Get unique days present in the report (from ovLabels)
  const daySet = [...new Set(ovLabels.map(l => {
    const dp = l.split(' ')[0].split('/'); // [dd, MM]
    return dp[1] + '-' + dp[0]; // YYYY-MM format compatible
  }))];

  let segments = [];
  for (const ds of daySet) {
    const [mo, dd] = ds.split('-');
    const dt = new Date(new Date().getFullYear(), parseInt(mo)-1, parseInt(dd));
    const dayKey = DAYS[dt.getDay()];
    const slots = [...(entries[dayKey] || [])].sort((a, b) => {
      const am = parseInt(a.start)*60 + parseInt(a.start.split(':')[1]);
      const bm = parseInt(b.start)*60 + parseInt(b.start.split(':')[1]);
      return am - bm;
    });
    let prev = 0;
    for (const s of slots) {
      const sm = parseInt(s.start.split(':')[0])*60 + parseInt(s.start.split(':')[1]);
      const em = parseInt(s.end.split(':')[0])*60   + parseInt(s.end.split(':')[1]);
      if (sm > prev) segments.push({ mode:'reduced', mins: sm - prev });
      segments.push({ mode: s.mode, mins: em - sm });
      prev = em;
    }
    if (prev < totalMins) segments.push({ mode:'reduced', mins: totalMins - prev });
  }

  const totalSegMins = segments.reduce((a, b) => a + b.mins, 0);
  const bars = segments.map(s => {
    const pct = (s.mins / totalSegMins * 100).toFixed(3);
    const color = COLORS[s.mode] || COLORS.reduced;
    const label = s.mode.charAt(0).toUpperCase() + s.mode.slice(1);
    const hrs = Math.round(s.mins / 60 * 10) / 10;
    return `<div title="${label} (${hrs}h)" style="width:${pct}%;background:${color};height:100%"></div>`;
  }).join('');

  const legend = Object.entries(COLORS).map(([mode, color]) =>
    `<span style="font-size:10px;color:#888"><span style="display:inline-block;width:10px;height:10px;background:${color};border-radius:2px;margin-right:3px;vertical-align:middle"></span>${mode.charAt(0).toUpperCase()+mode.slice(1)}</span>`
  ).join('<span style="margin:0 8px"></span>');

  return `<div style="margin-top:6px">
    <div style="font-size:11px;color:#888;margin-bottom:3px">Heating schedule</div>
    <div style="display:flex;height:14px;border-radius:4px;overflow:hidden;width:100%">${bars}</div>
    <div style="display:flex;gap:12px;margin-top:4px;flex-wrap:wrap">${legend}</div>
  </div>`;
}

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

// ─────────────────────────────────────────────────────────────────────────────
// HEATING SYSTEM ASSISTANT
// boilerNominalPowerKW: CLI param > env var > default 0 (kW-based cards hidden)
// designOutdoorTemp:    CLI param > env var > default -7°C (Europe central)
// ─────────────────────────────────────────────────────────────────────────────
const BOILER_KW  = parseFloat(getArg('--boilerKW', process.env.BOILER_KW || '0'));
const DESIGN_TEMP = parseFloat(getArg('--designTemp', process.env.DESIGN_TEMP || '-7'));
const hasBoilerKW = BOILER_KW > 0;

// Override avgHeatDemand with correct nominal power if provided
const avgModActive = activeBurnerRows.length
  ? activeBurnerRows.reduce((s,r) => s + toNum(r.modulation), 0) / activeBurnerRows.length
  : null;
const heatDemandKW = (hasBoilerKW && avgModActive !== null)
  ? (BOILER_KW * avgModActive / 100).toFixed(1)
  : null;

// House heat loss coefficient  [kW/°C]
const avgRoomNum    = avgRoom    ? parseFloat(avgRoom)    : null;
const avgOutsideNum = avg(boilerRows, 'outside_temp') ? parseFloat(avg(boilerRows, 'outside_temp')) : null;
const deltaT        = (avgRoomNum !== null && avgOutsideNum !== null) ? avgRoomNum - avgOutsideNum : null;
const heatLossCoeff = (heatDemandKW !== null && deltaT !== null && deltaT > 0)
  ? (parseFloat(heatDemandKW) / deltaT).toFixed(2)
  : null;

// House efficiency rating
function houseEffRating(coeff) {
  if (coeff === null) return null;
  const c = parseFloat(coeff);
  if (c < 0.25) return { label: 'Excellent', cls: 'good' };
  if (c < 0.40) return { label: 'Good',      cls: 'good' };
  if (c < 0.60) return { label: 'Average',   cls: 'warn' };
  return             { label: 'Poor',        cls: 'bad'  };
}
const houseEff = houseEffRating(heatLossCoeff);

// Estimated peak load at design temperature
const peakLoadKW = (heatLossCoeff !== null && avgRoomNum !== null)
  ? (parseFloat(heatLossCoeff) * (avgRoomNum - DESIGN_TEMP)).toFixed(1)
  : null;

// Boiler sizing check
const boilerOversized = (hasBoilerKW && peakLoadKW !== null && BOILER_KW > parseFloat(peakLoadKW) * 2);

// Cycle diagnostics
const reportHours  = DAYS * 24;
const cyclesPerHour = cycleCount && reportHours ? (cycleCount / reportHours).toFixed(2) : null;
const avgCycleDurNum  = avgCycleDur ? parseFloat(avgCycleDur) : null;
const shortCycling    = avgCycleDurNum !== null && avgCycleDurNum < 5;
const excessiveCycling = cyclesPerHour !== null && parseFloat(cyclesPerHour) > 6;

// Flow temp heuristic
const avgFlowNum    = avgFlow ? parseFloat(avgFlow) : null;
const avgOutNum     = avgOutsideNum;
const highFlowTemp  = avgFlowNum !== null && avgOutNum !== null && avgFlowNum > 55 && avgOutNum > 5;

// Inefficient operation: low modulation + short cycles
const avgModNum = avgMod ? parseFloat(avgMod) : null;
const inefficientOp = avgModNum !== null && avgCycleDurNum !== null && avgModNum < 25 && avgCycleDurNum < 6;

// Build assistant insights
const insights = [];
if (shortCycling || excessiveCycling)
  insights.push({ type:'warn', text: shortCycling
    ? `Short cycling detected — avg cycle ${avgCycleDur} min (ideal > 10 min). Check system pressure, pump speed, or boiler minimum modulation setting.`
    : `High cycling rate — ${cyclesPerHour} cycles/hour. Consider increasing heating curve or minimum burner runtime.` });
if (inefficientOp)
  insights.push({ type:'warn', text: `Boiler running at low modulation (avg ${avgMod}%) with short cycles. Consider lowering the heating curve to reduce cycling.` });
if (highFlowTemp)
  insights.push({ type:'warn', text: `Flow temperature (avg ${avgFlow}°C) is higher than necessary for current outdoor conditions (${avgOutsideNum?.toFixed(1)}°C). Lowering the heating curve improves condensing efficiency.` });
if (boilerOversized)
  insights.push({ type:'info', text: `Boiler nominal power (${BOILER_KW} kW) is more than twice the estimated peak load (~${peakLoadKW} kW). Oversizing is common for combi boilers but contributes to cycling.` });
if (houseEff && (houseEff.label === 'Good' || houseEff.label === 'Excellent'))
  insights.push({ type:'good', text: `Building thermal efficiency rated ${houseEff.label} (heat loss ${heatLossCoeff} kW/°C). Good insulation reduces heating demand.` });
if (!hasBoilerKW)
  insights.push({ type:'info', text: `Add --boilerKW <nominal_kW> to enable heat demand, peak load and house efficiency calculations (e.g. --boilerKW 19).` });
if (insights.length === 0 && hasBoilerKW)
  insights.push({ type:'good', text: 'No issues detected. System appears to be operating normally.' });

// ── Comfort stability: stddev of room temperature ────────────────────────────
const roomTemps = hcRows.map(r => parseFloat(r.room_temp)).filter(v => !isNaN(v) && v > 0);
let comfortStddev = null, comfortRating = null, comfortCls = 'neutral';
if (roomTemps.length >= 10) {
  const mean = roomTemps.reduce((a,b) => a+b, 0) / roomTemps.length;
  comfortStddev = Math.sqrt(roomTemps.reduce((a,v) => a + (v-mean)**2, 0) / roomTemps.length).toFixed(2);
  const sd = parseFloat(comfortStddev);
  if (sd < 0.2)      { comfortRating = 'Excellent'; comfortCls = 'good'; }
  else if (sd < 0.5) { comfortRating = 'Good';      comfortCls = 'good'; }
  else               { comfortRating = 'Unstable';  comfortCls = 'warn'; }
}

// ── Cycling severity score ───────────────────────────────────────────────────
// score = cyclesPerHour × (10 / avgCycleDuration)  →  <1 excellent, 1-3 ok, >3 severe
let cyclingScore = null, cyclingSeverity = null, cyclingSeverityCls = 'neutral';
if (cyclesPerHour && avgCycleDurNum && avgCycleDurNum > 0) {
  cyclingScore = (parseFloat(cyclesPerHour) * (10 / avgCycleDurNum)).toFixed(2);
  const sc2 = parseFloat(cyclingScore);
  if (sc2 < 1)      { cyclingSeverity = 'Excellent'; cyclingSeverityCls = 'good'; }
  else if (sc2 < 3) { cyclingSeverity = 'Acceptable'; cyclingSeverityCls = 'warn'; }
  else              { cyclingSeverity = 'Severe';     cyclingSeverityCls = 'bad';  }
  if (sc2 >= 3)
    insights.push({ type:'warn', text: `Cycling severity score ${cyclingScore} (severe). Boiler is cycling too frequently and too briefly — check minimum burner runtime setting or hydraulic balancing.` });
}

// ── Min modulation check ─────────────────────────────────────────────────────
const minModCheck = (avgModNum !== null && avgModNum < 20 && avgCycleDurNum !== null && avgCycleDurNum < 10);
if (minModCheck)
  insights.push({ type:'warn', text: `Boiler frequently operating near minimum modulation (avg ${avgMod}%). Combined with short cycles, this suggests oversizing or flow temperature set too high.` });

// ── Gas efficiency: estimated kWh produced per m³ gas ───────────────────────
// heatProduced (kWh) = avgHeatDemand(kW) × burnerRuntime(h)
// gasUsed (m³) from latest daily reading × days
// 1 m³ natural gas ≈ 10.6 kWh (lower heating value)
const GAS_KWH_PER_M3 = 10.6;
let gasEfficiencyPct = null;
if (hasBoilerKW && heatDemandKW && burnerHours && hasGasData) {
  // total gas used in period: sum of daily maxes
  const totalGasM3 = gasDays.reduce((sum, d) => sum + gasPerDay[d].heating + gasPerDay[d].dhw, 0);
  // burner runtime in period (hours): use last - first burner_hours from boilerRows
  const firstBH = parseFloat(boilerRows[0]?.burner_hours || 0);
  const lastBH  = parseFloat(lb.burner_hours || 0);
  const runtimeH = lastBH - firstBH;
  if (totalGasM3 > 0 && runtimeH > 0) {
    const heatProduced = parseFloat(heatDemandKW) * runtimeH;
    const gasInputKwh  = totalGasM3 * GAS_KWH_PER_M3;
    gasEfficiencyPct   = Math.min(110, (heatProduced / gasInputKwh * 100)).toFixed(0);
  }
}

// ── Heating curve behaviour: correlation flow vs outdoor ─────────────────────
// Pearson correlation: negative = correct curve, ~0 = fixed flow, positive = misconfigured
let heatCurveCorr = null, heatCurveBehaviour = null, heatCurveCls = 'neutral';
const corrPairs = hcRows
  .map(r => {
    const flow = parseFloat(r.flow_temp);
    const out  = parseFloat(r.outside_temp) || parseFloat(
      boilerRows.find(b => b.timestamp === r.timestamp)?.outside_temp || ''
    );
    return (isNaN(flow) || isNaN(out) || flow <= 0 || out === 0) ? null : [out, flow];
  })
  .filter(Boolean);

// Also try matching outdoor from boilerRows by nearest timestamp
const corrPairs2 = (() => {
  const bySorted = [...boilerRows].sort((a,b) => new Date(a.timestamp)-new Date(b.timestamp));
  return hcRows.map(r => {
    const flow = parseFloat(r.flow_temp);
    if (isNaN(flow) || flow <= 0) return null;
    const t = new Date(r.timestamp).getTime();
    let best = null, bd = Infinity;
    for (const b of bySorted) {
      const d = Math.abs(new Date(b.timestamp).getTime() - t);
      if (d < bd) { bd = d; best = b; }
    }
    const out = best && bd < 30*60*1000 ? parseFloat(best.outside_temp) : NaN;
    return (!isNaN(out) && out !== 0) ? [out, flow] : null;
  }).filter(Boolean);
})();

const usePairs = corrPairs2.length >= corrPairs.length ? corrPairs2 : corrPairs;
if (usePairs.length >= 20) {
  const n  = usePairs.length;
  const mx = usePairs.reduce((a,p) => a+p[0], 0) / n;
  const my = usePairs.reduce((a,p) => a+p[1], 0) / n;
  const num = usePairs.reduce((a,p) => a + (p[0]-mx)*(p[1]-my), 0);
  const den = Math.sqrt(usePairs.reduce((a,p) => a+(p[0]-mx)**2, 0) * usePairs.reduce((a,p) => a+(p[1]-my)**2, 0));
  heatCurveCorr = den > 0 ? (num/den).toFixed(2) : null;
  if (heatCurveCorr !== null) {
    const c = parseFloat(heatCurveCorr);
    if (c < -0.3)      { heatCurveBehaviour = 'Weather-compensated ✓'; heatCurveCls = 'good'; }
    else if (c < 0.1)  { heatCurveBehaviour = 'Fixed flow temp';        heatCurveCls = 'warn'; }
    else               { heatCurveBehaviour = 'Check curve config';     heatCurveCls = 'bad';  }
    if (c >= 0.1)
      insights.push({ type:'warn', text: `Heating curve may be misconfigured — flow temperature correlates positively with outdoor temperature (r=${heatCurveCorr}). Expected: flow should rise when outdoor drops.` });
    else if (c > -0.3 && c < 0.1)
      insights.push({ type:'info', text: `Flow temperature appears fixed (r=${heatCurveCorr}). Consider enabling weather compensation on your boiler controller to improve efficiency.` });
  }
}

// ── Scatter data: heat demand vs outdoor temp ─────────────────────────────────
// Each point: x=outside_temp, y=heatDemand(kW) when burner active
const scatterData = (() => {
  if (!hasBoilerKW) return [];
  return boilerRows
    .filter(r => r.burner_active === 'true' && parseFloat(r.modulation) > 0)
    .map(r => {
      // find nearest boilerRow with outside_temp
      const out = parseFloat(r.outside_temp);
      const mod = parseFloat(r.modulation);
      if (isNaN(out) || out === 0 || isNaN(mod)) return null;
      return { x: out, y: +(BOILER_KW * mod / 100).toFixed(2) };
    })
    .filter(Boolean);
})();

// Linear regression on scatter for trendline
const scatterRegression = (() => {
  if (scatterData.length < 10) return null;
  const n  = scatterData.length;
  const mx = scatterData.reduce((a,p) => a+p.x, 0) / n;
  const my = scatterData.reduce((a,p) => a+p.y, 0) / n;
  const num = scatterData.reduce((a,p) => a + (p.x-mx)*(p.y-my), 0);
  const den = scatterData.reduce((a,p) => a + (p.x-mx)**2, 0);
  if (den === 0) return null;
  const slope     = num / den;
  const intercept = my - slope * mx;
  // balance point: outdoor temp where heat demand = 0
  const balancePoint = slope !== 0 ? (-intercept / slope).toFixed(1) : null;
  // trendline: two points covering outdoor range
  const xs = scatterData.map(p => p.x);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  return {
    slope: slope.toFixed(3), intercept: intercept.toFixed(2), balancePoint,
    line: [
      { x: xMin, y: +(slope*xMin + intercept).toFixed(2) },
      { x: xMax, y: +(slope*xMax + intercept).toFixed(2) }
    ]
  };
})();

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
const scheduleBarHtml = buildScheduleBarHtml();
const ovRoom     = overviewTimes.map(ts => interpolate(hcRows,    ts, 'room_temp'));
const ovSetpoint = overviewTimes.map(ts => interpolate(hcRows,    ts, 'target_temp'));
const ovFlow     = overviewTimes.map(ts => interpolate(hcRows,    ts, 'flow_temp'));
const ovDhw      = overviewTimes.map(ts => interpolate(dhwRows,   ts, 'dhw_temp'));
const ovOutside  = overviewTimes.map(ts => interpolate(boilerRows, ts, 'outside_temp'));
const ovOutsideHum = overviewTimes.map(ts => interpolate(boilerRows, ts, 'outside_humidity'));
const ovMod      = overviewTimes.map(ts => interpolate(boilerRows,ts, 'modulation'));
const ovBurner   = overviewTimes.map(ts => lookupBurner(boilerRows, ts));


// ─────────────────────────────────────────────────────────────────────────────
// GAS FORECAST
// Uses gasPerDay (already computed above) to project monthly/annual consumption.
// Strategy: linear regression on last N days → extrapolate to 30/365 days.
// ─────────────────────────────────────────────────────────────────────────────
let gasForecast = null;
if (gasDays.length >= 3) {
  // Use all available days; total = heating + dhw
  const totalPerDay = gasDays.map(d => gasPerDay[d].heating + gasPerDay[d].dhw);
  const n = totalPerDay.length;
  // Simple linear regression: y = a + b*x  (x = day index)
  const xMean = (n - 1) / 2;
  const yMean = totalPerDay.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  totalPerDay.forEach((y, i) => { num += (i - xMean) * (y - yMean); den += (i - xMean) ** 2; });
  const slope = den !== 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;
  // Project from today (index = n-1) forward
  const projectDay = (offset) => Math.max(0, intercept + slope * (n - 1 + offset));
  // Monthly: sum of next 30 days
  let monthSum = 0;
  for (let i = 1; i <= 30; i++) monthSum += projectDay(i);
  // Annual: sum of next 365 days (approximated as 30-day avg × 12 with seasonal note)
  // For simplicity: annualise the period avg × 365 (more stable than long regression)
  const periodAvgPerDay = yMean;
  const annualEst = periodAvgPerDay * 365;
  // Cost estimate (€): use --gasPriceEur param or env (default 0.90 €/m³ — Italian average)
  const GAS_PRICE = parseFloat(getArg('--gasPriceEur', process.env.GAS_PRICE_EUR || '0.90'));
  // Annual estimate requires at least 14 days to avoid misleading projections
  // from short atypical periods (e.g. unusually cold/warm week).
  const ANNUAL_MIN_DAYS = 14;
  const hasEnoughForAnnual = n >= ANNUAL_MIN_DAYS;
  gasForecast = {
    avgPerDay:         yMean.toFixed(2),
    trend:             slope > 0.05 ? 'rising' : slope < -0.05 ? 'falling' : 'stable',
    trendSlope:        slope.toFixed(3),
    month30:           monthSum.toFixed(1),
    annualEst:         hasEnoughForAnnual ? annualEst.toFixed(0) : null,
    costMonth:         (monthSum * GAS_PRICE).toFixed(2),
    costAnnual:        hasEnoughForAnnual ? (annualEst * GAS_PRICE).toFixed(2) : null,
    gasPrice:          GAS_PRICE.toFixed(2),
    daysUsed:          n,
    annualMinDays:     ANNUAL_MIN_DAYS,
    hasEnoughForAnnual,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VIESSMANN STATUS / ERROR CODE TRANSLATIONS
// Source: Viessmann service documentation + vieventlog error_codes.go
// ─────────────────────────────────────────────────────────────────────────────
const VIESSMANN_CODES = {
  // ── Status codes (S.) ──
  'S.0':   { en: 'Standby',                         de: 'Bereitschaft' },
  'S.1':   { en: 'DHW heating',                     de: 'Warmwasserbereitung' },
  'S.2':   { en: 'Central heating',                 de: 'Heizbetrieb' },
  'S.3':   { en: 'Burner on',                       de: 'Brenner ein' },
  'S.4':   { en: 'Burner off',                      de: 'Brenner aus' },
  'S.5':   { en: 'Fan pre-purge',                   de: 'Lüfter Vorspülung' },
  'S.6':   { en: 'Ignition',                        de: 'Zündung' },
  'S.7':   { en: 'Flame detected',                  de: 'Flamme erkannt' },
  'S.8':   { en: 'Burner post-purge',               de: 'Lüfter Nachspülung' },
  'S.9':   { en: 'Cooling mode',                    de: 'Kühlbetrieb' },
  'S.10':  { en: 'Frost protection active',         de: 'Frostschutz aktiv' },
  'S.12':  { en: 'Circulation pump active',         de: 'Umwälzpumpe aktiv' },
  'S.17':  { en: 'Flue gas test',                   de: 'Abgastest' },
  'S.19':  { en: 'Chimney sweep mode',              de: 'Schornsteinfegerbetrieb' },
  'S.20':  { en: 'Boiler protection (overtemp)',    de: 'Kesselschutz (Übertemperatur)' },
  'S.22':  { en: 'External demand active',          de: 'Externe Anforderung aktiv' },
  'S.24':  { en: 'Pump overrun',                    de: 'Pumpennachlauf' },
  'S.31':  { en: 'Summer eco mode',                 de: 'Sommer-Eco-Betrieb' },
  'S.32':  { en: 'Heating circuit standby',         de: 'Heizkreis Standby' },
  'S.40':  { en: 'Heat pump heating',               de: 'Wärmepumpe Heizbetrieb' },
  'S.41':  { en: 'Heat pump DHW',                   de: 'Wärmepumpe Warmwasser' },
  'S.42':  { en: 'Heat pump defrost',               de: 'Wärmepumpe Abtauung' },
  'S.43':  { en: 'Heat pump cooling',               de: 'Wärmepumpe Kühlung' },
  'S.44':  { en: 'Compressor starting',             de: 'Verdichter startet' },
  'S.45':  { en: 'Compressor running',              de: 'Verdichter läuft' },
  'S.46':  { en: 'Compressor stopping',             de: 'Verdichter stoppt' },
  'S.100': { en: 'Heating mode',                    de: 'Heizbetrieb' },
  'S.109': { en: 'Heating circuit active',          de: 'Heizkreis aktiv' },
  'S.111': { en: 'Normal heating program',          de: 'Normalbetrieb Heizung' },
  'S.112': { en: 'Reduced heating program',         de: 'Absenkbetrieb Heizung' },
  'S.113': { en: 'Comfort heating program',         de: 'Komfortbetrieb Heizung' },
  'S.114': { en: 'DHW demand',                      de: 'Warmwasseranforderung' },
  'S.118': { en: 'Primary circuit active',          de: 'Primärkreis aktiv' },
  'S.119': { en: 'Secondary circuit active',        de: 'Sekundärkreis aktiv' },
  'S.120': { en: 'Circulation pump running',        de: 'Umwälzpumpe läuft' },
  'S.123': { en: 'Heat pump standby',               de: 'Wärmepumpe Bereitschaft' },
  'S.124': { en: 'Heat pump grid lock',             de: 'Wärmepumpe Netzsperrzeit' },
  'S.125': { en: 'Heat pump demand pending',        de: 'Wärmepumpe Anforderung ausstehend' },
  'S.126': { en: 'Heat pump frost protection',      de: 'Wärmepumpe Frostschutz' },
  'S.130': { en: 'Defrost active',                  de: 'Abtauung aktiv' },
  'S.131': { en: 'Defrost completed',               de: 'Abtauung abgeschlossen' },
  'S.134': { en: 'Heat pump heating active',        de: 'Wärmepumpe Heizbetrieb aktiv' },
  'S.140': { en: 'Smart grid active',               de: 'Smart Grid aktiv' },
  'S.200': { en: 'Legionella protection',           de: 'Legionellenschutz' },
  'S.201': { en: 'DHW efficient mode',              de: 'Warmwasser Effizienzbetrieb' },
  'S.202': { en: 'DHW comfort mode',                de: 'Warmwasser Komfortbetrieb' },
  // ── Info codes (I.) ──
  'I.0':   { en: 'System OK',                       de: 'System OK' },
  'I.1':   { en: 'Maintenance due',                 de: 'Wartung fällig' },
  'I.2':   { en: 'Filter replacement due',          de: 'Filterwechsel fällig' },
  'I.10':  { en: 'External temperature sensor fault', de: 'Außentemperaturfühler Fehler' },
  'I.11':  { en: 'Return temperature sensor fault', de: 'Rücklauftemperaturfühler Fehler' },
  'I.12':  { en: 'DHW sensor fault',                de: 'Warmwasserfühler Fehler' },
  'I.20':  { en: 'Low water pressure warning',      de: 'Niederdruck Warnung' },
  'I.100': { en: 'System info',                     de: 'Systeminformation' },
  'I.113': { en: 'Heating curve optimisation info', de: 'Heizkurvenoptimierung Info' },
  'I.114': { en: 'Energy balance info',             de: 'Energiebilanz Info' },
  'I.115': { en: 'Runtime statistics info',         de: 'Laufzeitstatistik Info' },
  // ── Fault codes (F.) ──
  'F.0':   { en: 'No fault',                        de: 'Kein Fehler' },
  'F.1':   { en: 'Burner fault — no ignition',      de: 'Brennerstörung — keine Zündung' },
  'F.2':   { en: 'Flame signal lost',               de: 'Flammensignal verloren' },
  'F.3':   { en: 'Ignition fault',                  de: 'Zündfehler' },
  'F.4':   { en: 'Safety chain open',               de: 'Sicherheitskette offen' },
  'F.5':   { en: 'Gas valve fault',                 de: 'Gasventil Fehler' },
  'F.7':   { en: 'Flue gas sensor fault',           de: 'Abgastemperaturfühler Fehler' },
  'F.9':   { en: 'Supply sensor fault',             de: 'Vorlauftemperaturfühler Fehler' },
  'F.10':  { en: 'External sensor fault',           de: 'Außenfühler Fehler' },
  'F.11':  { en: 'Return sensor fault',             de: 'Rücklauftemperaturfühler Fehler' },
  'F.12':  { en: 'DHW sensor fault',                de: 'Warmwasserfühler Fehler' },
  'F.20':  { en: 'Safety temperature limiter',      de: 'Sicherheitstemperaturbegrenzer' },
  'F.22':  { en: 'Low water pressure fault',        de: 'Wassermangel' },
  'F.23':  { en: 'Pump fault — overtemp',           de: 'Pumpe Fehler — Übertemperatur' },
  'F.24':  { en: 'Pump circulation fault',          de: 'Pumpe Zirkulationsfehler' },
  'F.28':  { en: 'Ignition fault (gas)',            de: 'Zündstörung (Gas)' },
  'F.29':  { en: 'Flame fault after ignition',      de: 'Flammenfehler nach Zündung' },
  'F.30':  { en: 'STB safety shutdown',             de: 'STB Sicherheitsabschaltung' },
  'F.31':  { en: 'Boiler overtemperature',          de: 'Kesselübertemperatur' },
  'F.32':  { en: 'Flue overtemperature',            de: 'Abgasübertemperatur' },
  'F.33':  { en: 'Draft fault',                     de: 'Zugfehler' },
  'F.36':  { en: 'Fan fault',                       de: 'Lüfter Fehler' },
  'F.40':  { en: 'Compressor fault',                de: 'Verdichter Fehler' },
  'F.41':  { en: 'Refrigerant circuit fault',       de: 'Kältemittelkreis Fehler' },
  'F.42':  { en: 'Defrost fault',                   de: 'Abtaufehler' },
  'F.50':  { en: 'Communication fault gateway',     de: 'Kommunikationsfehler Gateway' },
  'F.51':  { en: 'Communication fault controller', de: 'Kommunikationsfehler Regler' },
  'F.52':  { en: 'Bus fault',                       de: 'Busfehler' },
  'F.60':  { en: 'Expansion vessel fault',          de: 'Ausdehnungsgefäß Fehler' },
  'F.73':  { en: 'Water pressure too high',         de: 'Wasserdruck zu hoch' },
  'F.74':  { en: 'Water pressure too low',          de: 'Wasserdruck zu niedrig' },
  'F.75':  { en: 'Pump speed sensor fault',         de: 'Pumpendrehzahlsensor Fehler' },
};

function translateCode(code) {
  if (!code) return null;
  const entry = VIESSMANN_CODES[code];
  if (entry) return entry.en;
  // Partial match fallback (e.g. S.134 → try S.13 → S.1)
  const parts = code.split('.');
  if (parts.length === 2) {
    const shorter = parts[0] + '.' + parts[1].slice(0, -1);
    if (VIESSMANN_CODES[shorter]) return VIESSMANN_CODES[shorter].en + ' (variant)';
  }
  return null;
}

// Extract device messages from the latest API data snapshot (if available via CSV extension)
// For now we show the codes from the last row that has error_code-like fields
// (future: read from a separate messages JSON file written by the plugin)
const lastBoiler = boilerRows.length ? boilerRows[boilerRows.length - 1] : null;

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
  ${scheduleBarHtml}

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
  <h2>🔍 System Analysis</h2>
  <div class="grid">
    ${heatDemandKW ? sc('Avg heat demand', heatDemandKW, ' kW') : ''}
    ${heatLossCoeff ? sc('Heat loss coeff.', heatLossCoeff, ' kW/°C') : ''}
    ${peakLoadKW ? sc('Est. peak load', peakLoadKW, ' kW', '<span style=\"font-size:10px;color:#888\">at '+DESIGN_TEMP+'°C outdoor</span>') : ''}
    ${hasBoilerKW ? sc('Boiler nominal', BOILER_KW, ' kW', boilerOversized ? badge('warn','Oversized') : badge('good','OK')) : ''}
    ${houseEff ? sc('House efficiency', houseEff.label, '', badge(houseEff.cls, heatLossCoeff+' kW/°C')) : ''}
    ${cyclesPerHour ? sc('Cycles/hour', cyclesPerHour, '', (excessiveCycling ? badge('warn','High') : badge('good','OK'))) : ''}
    ${cyclingScore ? sc('Cycling severity', cyclingSeverity, '', badge(cyclingSeverityCls, cyclingScore)) : ''}
    ${comfortStddev ? sc('Comfort stability', comfortRating, '', badge(comfortCls, '±'+comfortStddev+'°C')) : ''}
    ${gasEfficiencyPct ? sc('Est. efficiency', gasEfficiencyPct, '%') : ''}
    ${heatCurveCorr ? sc('Heating curve', heatCurveBehaviour, '', badge(heatCurveCls, 'r='+heatCurveCorr)) : ''}
  </div>
  <div style="margin-top:16px">
    ${insights.map(i => {
      const icon = i.type==='good' ? '✅' : i.type==='warn' ? '⚠️' : 'ℹ️';
      const bg   = i.type==='good' ? '#f1f8f1' : i.type==='warn' ? '#fff8e1' : '#e8f4fd';
      const br   = i.type==='good' ? '#a5d6a7' : i.type==='warn' ? '#ffe082' : '#90caf9';
      return '<div style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;background:'+bg+';border-left:3px solid '+br+';border-radius:4px;margin-bottom:8px;font-size:13px;line-height:1.5"><span style="font-size:15px;flex-shrink:0">'+icon+'</span><span>'+i.text+'</span></div>';
    }).join('')}
  </div>
  ${scatterData.length >= 10 ? `
  <div style="margin-top:18px">
    <div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-bottom:6px">Heat Demand vs Outdoor Temperature</div>
    <div class="ch-tall"><canvas id="cScatter"></canvas></div>
    <p class="note">Each point = one burner-active sample. Red line = linear regression.${scatterRegression?.balancePoint ? ' Balance point (estimated): '+scatterRegression.balancePoint+'°C outdoor.' : ''}</p>
  </div>` : ''}
</div>

<div class="box">
  <h2>Domestic Hot Water (DHW)</h2>
  <div class="grid">
    ${sc('Avg temp', avgDhw, '°C')}
    ${sc('Avg setpoint', avgDhwTarget, '°C')}
  </div>
  ${dhwRows.length >= 2 ? `<div class="ch-tall"><canvas id="cDhw"></canvas></div>` : ''}
</div>

${gasForecast ? `
<div class="box">
  <h2>⛽ Gas Forecast</h2>
  <p class="note" style="margin-bottom:14px">Projection based on last ${gasForecast.daysUsed} day(s) of data · gas price: €${gasForecast.gasPrice}/m³ · trend: <strong>${gasForecast.trend === 'rising' ? '↑ Rising' : gasForecast.trend === 'falling' ? '↓ Falling' : '→ Stable'}</strong></p>
  <div class="grid">
    ${sc('Avg consumption/day', gasForecast.avgPerDay, ' m³')}
    ${sc('Projected next 30 days', gasForecast.month30, ' m³', badge(gasForecast.trend === 'rising' ? 'warn' : 'good', '≈ €' + gasForecast.costMonth))}
    ${gasForecast.hasEnoughForAnnual
      ? sc('Annual estimate', gasForecast.annualEst, ' m³', badge('neutral', '≈ €' + gasForecast.costAnnual))
      : sc('Annual estimate', 'N/A', '', badge('neutral', 'Need ' + gasForecast.annualMinDays + ' days (have ' + gasForecast.daysUsed + ')'))}
  </div>
  <p class="note" style="margin-top:10px">
    ${gasForecast.hasEnoughForAnnual
      ? '⚠️ Annual estimate uses period average × 365 — seasonal variations not accounted for.'
      : `ℹ️ Annual estimate requires at least ${gasForecast.annualMinDays} days of gas data (currently ${gasForecast.daysUsed}). Run with <code>--days ${gasForecast.annualMinDays}</code> or more.`}
    Use <code>--gasPriceEur</code> to set your tariff.
  </p>
</div>` : ''}

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

<div class="box" id="device-messages">
  <h2>🔔 Device Messages</h2>
  <p class="note" style="margin-bottom:12px">Status, info and fault codes reported by the device. Translated from Viessmann service documentation.</p>
  <div id="msg-list">
${(() => {
  // Read messages from viessmann-messages-<ID>.json if available (written by plugin)
  const msgFile = INSTALLATION_ID
    ? require('path').join(HB_PATH, 'viessmann-messages-' + INSTALLATION_ID + '.json')
    : require('path').join(HB_PATH, 'viessmann-messages.json');
  let messages = [];
  try {
    if (require('fs').existsSync(msgFile)) {
      messages = JSON.parse(require('fs').readFileSync(msgFile, 'utf8'));
    }
  } catch(_) {}

  if (!messages.length) {
    return `<p class="note">No messages file found yet. Messages will appear here once the plugin writes <code>viessmann-messages-${INSTALLATION_ID || ''}.json</code>.</p>`;
  }

  return messages.slice(0, 20).map(m => {
    const code = m.errorCode || m.code || '';
    const desc = translateCode(code);
    const ts = m.timestamp ? new Date(m.timestamp).toLocaleString('en-GB') : '';
    const type = code.startsWith('F.') ? 'fault' : code.startsWith('I.') ? 'info' : 'status';
    const bg   = type === 'fault' ? '#fff3e0' : type === 'info' ? '#e8f4fd' : '#f1f8f1';
    const br   = type === 'fault' ? '#ffb74d' : type === 'info' ? '#90caf9' : '#a5d6a7';
    const icon = type === 'fault' ? '⚠️' : type === 'info' ? 'ℹ️' : '✅';
    return `<div style="display:flex;gap:12px;align-items:flex-start;padding:10px 12px;background:${bg};border-left:3px solid ${br};border-radius:4px;margin-bottom:6px;font-size:13px">
      <span style="flex-shrink:0">${icon}</span>
      <div style="flex:1">
        <strong>${code}</strong>${desc ? ` — ${desc}` : ' — (unknown code)'}
        ${ts ? `<span style="color:#888;font-size:11px;margin-left:8px">${ts}</span>` : ''}
        ${m.busAddress ? `<span style="color:#aaa;font-size:11px;margin-left:8px">bus: ${m.busAddress}</span>` : ''}
      </div>
    </div>`;
  }).join('');
})()}
  </div>
</div>

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
mk('cWallbox',${JSON.stringify(wallboxChart.labels)},[{label:'Wallbox power (W)',data:${JSON.stringify(wallboxChart.values)},borderColor:'#7b1fa2',backgroundColor:'rgba(123,31,162,.08)',fill:true,tension:0.3,pointRadius:2,borderWidth:2}],'W');`:''}\n${scatterData.length>=10?`
(function(){
  const c=document.getElementById('cScatter'); if(!c)return;
  const pts=${JSON.stringify(scatterData.length > 300 ? scatterData.filter((_,i)=>i%Math.ceil(scatterData.length/300)===0) : scatterData)};
  const reg=${JSON.stringify(scatterRegression)};
  const datasets=[{
    label:'Heat demand (kW)',
    data:pts,
    backgroundColor:'rgba(78,154,241,0.35)',
    pointRadius:3,
    pointHoverRadius:5,
    type:'scatter'
  }];
  if(reg){
    datasets.push({
      label:'Trend',
      data:reg.line,
      type:'line',
      borderColor:'#ef5350',
      backgroundColor:'transparent',
      borderWidth:2,
      pointRadius:0,
      tension:0
    });
  }
  new Chart(c,{
    type:'scatter',
    data:{datasets},
    options:{
      responsive:true,
      maintainAspectRatio:false,
      plugins:{
        legend:{display:true,position:'top'},
        tooltip:{callbacks:{label:p=>'outdoor: '+p.parsed.x+'°C  demand: '+p.parsed.y+' kW'}}
      },
      scales:{
        x:{title:{display:true,text:'Outdoor temperature (°C)'},grid:{color:'#f5f5f5'}},
        y:{title:{display:true,text:'Heat demand (kW)'},beginAtZero:true,grid:{color:'#f5f5f5'}}
      }
    }
  });
})();
`:``}
<\/script>
</body></html>`;

fs.writeFileSync(OUT_FILE, html, 'utf8');
console.log(`Report generated: ${OUT_FILE}`);
console.log(`Open in browser: file://${OUT_FILE}`);
