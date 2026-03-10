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
const dhwChart    = chartData(dhwRows, 'dhw_temp');
const dhwTgtChart = chartData(dhwRows, 'dhw_target');
const outsideChart = chartData(hcRows, 'outside_temp');
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
const ovDhw      = overviewTimes.map(ts => interpolate(dhwRows,   ts, 'dhw_temp'));
const ovOutside  = overviewTimes.map(ts => interpolate(hcRows,    ts, 'outside_temp'));
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
  </div>
  ${boilerRows.length < 5 ? `<p class="note">Only ${boilerRows.length} samples — data will accumulate over time (~1 every 15 min).</p>` : ''}
  ${boilerRows.length >= 2 ? `<div class="ch"><canvas id="cMod"></canvas></div><div class="ch" style="margin-top:14px"><canvas id="cBurner"></canvas></div>` : ''}
</div>

<div class="box">
  <h2>Heating Circuit (HC0)</h2>
  <div class="grid">
    ${sc('Avg room temp', avgRoom, '°C')}
    ${sc('Avg setpoint', avgTarget, '°C')}
  </div>
  ${progDist.length ? `<div style="margin-bottom:16px"><div class="sl" style="margin-bottom:8px">Program distribution</div>
  <div class="pbars">${progDist.map(p=>`<div class="pb"><div class="pbl">${p.label}</div><div class="pbt"><div class="pbf fill-${p.label.toLowerCase()}" style="width:${p.pct}%"></div></div><div class="pbp">${p.pct}%</div></div>`).join('')}</div></div>` : ''}
  ${hcRows.length >= 2 ? `<div class="ch-tall"><canvas id="cRoom"></canvas></div>` : ''}
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
