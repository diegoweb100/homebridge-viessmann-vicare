#!/usr/bin/env node
/**
 * Viessmann History Report Generator — v3 (homebridge-viessmann-vicare 2.0.80+)
 *
 * Reads viessmann-history-<ID>.csv (written by the plugin) and produces a single,
 * self-contained HTML report for technicians AND for people who know nothing about boilers:
 *   - illustrated system overview and health score
 *   - assistant advice: why, what to do, who does it, estimated savings
 *   - every value explained in plain language
 *   - gas & costs, weather-normalised forecast, heating, curve, burner, hot water,
 *     house heat loss, official API counters, energy devices, device messages, glossary
 *
 * Usage:
 *   node viessmann-report.js --installation YOUR_INSTALLATION_ID [--days 30] [--lang it|en]
 *
 * Options:
 *   --installation <ID>  installation ID (reads viessmann-history-<ID>.csv)
 *   --days <N>           period in days (default 7)
 *   --path <dir>         Homebridge storage path (default /var/lib/homebridge)
 *   --out <file>         output HTML file
 *   --lang it|en         report language (default en)
 *   --gasPriceEur <n>    gas price in €/m³ including taxes (default 1.10)
 *   --elPriceEur <n>     electricity price in €/kWh (default 0.30)
 *   --boilerKW <n>       boiler nominal power (kW) — enables sizing checks
 *   --designTemp <n>     design outdoor temperature (°C, default -7)
 *   --curveSlope / --curveShift  heating curve if not available from the API
 *   --lat / --lon        location for weather data (default: read from ViCare)
 *   --hddBase <n>        degree-day base temperature (°C, default 16)
 *
 * Data rules (see CHANGELOG 2.0.80):
 *   - Only "snapshot" rows describe the system state; burner_on rows are S.6 ignition events.
 *   - Snapshot values can be stale (cloud value repeated). Burner hours/starts come from counters.
 *   - Daily gas is derived from the MONTHLY counters (the daily ones reset hours late).
 *   - The boiler outdoor sensor can be biased; real temperatures come from Open-Meteo.
 *   - Device message timestamps are local time labelled "Z".
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ─── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const num0 = (v) => { if (v === undefined || v === null || v === '') return null; const n = parseFloat(v); return isFinite(n) ? n : null; };
const getArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : def; };
const DAYS         = Math.max(1, parseInt(getArg('--days', '7'), 10) || 7);
const LANG         = (getArg('--lang', process.env.REPORT_LANG || 'en') || 'en').toLowerCase().startsWith('it') ? 'it' : 'en';
const HB_PATH      = getArg('--path', '/var/lib/homebridge');
const INSTALLATION = getArg('--installation', '');
const PRICE_SET    = args.includes('--gasPriceEur') || !!process.env.GAS_PRICE_EUR;
const GAS_PRICE    = parseFloat(getArg('--gasPriceEur', process.env.GAS_PRICE_EUR || '1.10')) || 1.10;
const EL_PRICE     = parseFloat(getArg('--elPriceEur', '0.30')) || 0.30;
const BOILER_KW    = parseFloat(getArg('--boilerKW', process.env.BOILER_KW || '0')) || 0;
const DESIGN_ARG   = num0(getArg('--designTemp', process.env.DESIGN_TEMP || ''));   // null = derive from local climate
let   DESIGN_TEMP  = DESIGN_ARG ?? -7;
let   DESIGN_AUTO  = false;
const HDD_BASE     = parseFloat(getArg('--hddBase', '16')) || 16;
const KWH_PER_M3   = 10.5;   // usable (net) energy per m³ of natural gas
const sfx          = INSTALLATION ? `-${INSTALLATION}` : '';
const CSV_FILE     = path.join(HB_PATH, `viessmann-history${sfx}.csv`);
const todayIso     = new Date().toISOString().slice(0, 10);
const OUT_FILE     = getArg('--out', path.join(HB_PATH, `viessmann-report${sfx}-${todayIso}.html`));

if (!fs.existsSync(CSV_FILE)) {
  console.error(`ERROR: CSV not found: ${CSV_FILE}\nStart Homebridge with the plugin to begin collecting data (use --installation <ID>).`);
  process.exit(1);
}

// ─── i18n & formatting ──────────────────────────────────────────────────────
const tr = (it, en) => (LANG === 'it' ? it : en);
const LOCALE = LANG === 'it' ? 'it-IT' : 'en-GB';
const nf = (n, d = 1) => (n === null || n === undefined || !isFinite(n)) ? '—'
  : Number(n).toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
const ni = (n) => (n === null || n === undefined || !isFinite(n)) ? '—' : Math.round(n).toLocaleString(LOCALE);
const eur = (n) => (n === null || n === undefined || !isFinite(n)) ? '—' : `${ni(n)} €`;
const sgn = (n, d = 1) => (n > 0 ? '+' : '') + nf(n, d);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ─── Helpers ────────────────────────────────────────────────────────────────
const localDay = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const addDays = (ds, n) => { const d = new Date(ds + 'T12:00:00'); d.setDate(d.getDate() + n); return localDay(d); };
const num = (v) => { if (v === undefined || v === null || v === '') return null; const n = parseFloat(v); return isFinite(n) ? n : null; };
const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const fmtDate = (ds) => new Date(ds + 'T12:00:00').toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function httpJson(url, headers) {
  const code = `fetch(${JSON.stringify(url)},{headers:${JSON.stringify(headers || {})}})` +
    `.then(r=>r.ok?r.text():Promise.reject(new Error('HTTP '+r.status)))` +
    `.then(t=>process.stdout.write(t)).catch(e=>{process.stderr.write(String(e.message||e));process.exit(1)})`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 25000, maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0) throw new Error((r.stderr || 'fetch failed').slice(0, 200));
  return JSON.parse(r.stdout);
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };

// ─── Load CSV ───────────────────────────────────────────────────────────────
const lines = fs.readFileSync(CSV_FILE, 'utf8').split('\n').filter(l => l.trim());
const headers = lines[0].split(',').map(h => h.trim());
const rows = [];
for (let i = 1; i < lines.length; i++) {
  const v = lines[i].split(',');
  const o = {};
  headers.forEach((h, j) => { o[h] = (v[j] ?? '').trim(); });
  const t = Date.parse(o.timestamp);
  if (!isFinite(t)) continue;
  o.t = t;
  // Skip the few rows written by very old plugin versions with a different column order
  if (o.accessory === 'boiler' && /^\d+$/.test(o.mode)) continue;
  if (o.accessory === 'hc0' && o.dhw_target && !isFinite(parseFloat(o.dhw_target))) continue;
  if (o.accessory === 'dhw' && o.outside_humidity && !o.dhw_target) continue;
  rows.push(o);
}
rows.sort((a, b) => a.t - b.t);
const isSnap = (r) => !r.event_type || r.event_type === 'snapshot';

const NOW = Date.now();
const firstDataT = rows.length ? rows[0].t : NOW;
const reqStart = NOW - DAYS * 86400000;
const startT = Math.max(reqStart, firstDataT);
const coveredDays = Math.max(1, Math.round((NOW - startT) / 86400000));
const clamped = reqStart < firstDataT - 86400000;
const inP = (r) => r.t >= startT;

const snaps = { boiler: [], hc0: [], dhw: [], energy: [] };
const roomRows = {};
const ignitionsAll = [];
for (const r of rows) {
  if (r.accessory === 'boiler' && r.event_type === 'burner_on') { ignitionsAll.push(r); continue; }
  if (!isSnap(r)) continue;
  if (snaps[r.accessory]) snaps[r.accessory].push(r);
  else if (/^room/.test(r.accessory)) (roomRows[r.accessory] = roomRows[r.accessory] || []).push(r);
}
const ignitions = ignitionsAll.filter(inP);
const P = { boiler: snaps.boiler.filter(inP), hc0: snaps.hc0.filter(inP), dhw: snaps.dhw.filter(inP), energy: snaps.energy.filter(inP) };
const sampleCount = P.boiler.length + P.hc0.length + P.dhw.length + P.energy.length;

function nearestBoiler(t) {
  const a = snaps.boiler; if (!a.length) return null;
  let lo = 0, hi = a.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].t < t) lo = m + 1; else hi = m; }
  let b = a[lo]; if (lo > 0 && Math.abs(a[lo - 1].t - t) < Math.abs(b.t - t)) b = a[lo - 1];
  return Math.abs(b.t - t) < 5 * 60000 ? b : null;
}

// ─── Gas per day from monthly counters (increment method, whole history) ────
const gasDay = {};
(() => {
  let ph = null, pw = null, pt = null;
  for (const r of snaps.boiler) {
    const h = num(r.gas_heating_month_m3), w = num(r.gas_dhw_month_m3);
    if (h === null && w === null) continue;
    const hv = h ?? 0, wv = w ?? 0;
    if (ph !== null && r.t - pt < 3 * 86400000) {
      const dh = hv >= ph ? hv - ph : hv, dw = wv >= pw ? wv - pw : wv;   // drop = monthly reset
      if (dh < 60 && dw < 30) {
        const d = localDay(r.t);
        (gasDay[d] = gasDay[d] || { h: 0, w: 0 });
        gasDay[d].h += dh; gasDay[d].w += dw;
      }
    }
    ph = hv; pw = wv; pt = r.t;
  }
})();
const periodDays = []; for (let d = localDay(startT); d <= localDay(NOW); d = addDays(d, 1)) periodDays.push(d);
const gasP = periodDays.reduce((a, d) => { const g = gasDay[d]; if (g) { a.h += g.h; a.w += g.w; } return a; }, { h: 0, w: 0 });
gasP.tot = gasP.h + gasP.w;
const monthly = {};
for (const d of periodDays) { const g = gasDay[d]; if (!g) continue; const m = d.slice(0, 7); (monthly[m] = monthly[m] || { h: 0, w: 0 }); monthly[m].h += g.h; monthly[m].w += g.w; }
const firstGasDay = Object.keys(gasDay).sort()[0] || '';
const isPartial = (m) => m === localDay(NOW).slice(0, 7) || localDay(startT) > m + '-01' || firstGasDay > m + '-01';

// ─── API summary (explore JSON) ─────────────────────────────────────────────
const explore = readJson(path.join(HB_PATH, `viessmann-history-explore-${INSTALLATION || 'all'}.json`));
let api = null, curve = { slope: null, shift: null }, summerEco = false;
if (explore?.devices) {
  for (const dev of Object.values(explore.devices)) {
    const f = (n) => (dev.historyFeatures || []).find(x => x.feature === n)?.samples || {};
    const v = (n, p) => { const x = f(n)?.[p]?.value; return typeof x === 'number' ? x : null; };
    if (v('heating.gas.consumption.summary.heating', 'currentYear') !== null && !api) {
      const blk = (n) => ({ d7: v(n, 'lastSevenDays'), month: v(n, 'currentMonth'), lastMonth: v(n, 'lastMonth'), year: v(n, 'currentYear'), lastYear: v(n, 'lastYear') });
      api = {
        ts: explore.timestamp,
        gasH: blk('heating.gas.consumption.summary.heating'), gasW: blk('heating.gas.consumption.summary.dhw'),
        heatH: blk('heating.heat.production.summary.heating'), heatW: blk('heating.heat.production.summary.dhw'),
        elH: blk('heating.power.consumption.summary.heating'), elW: blk('heating.power.consumption.summary.dhw'),
        starts: v('heating.burners.0.statistics', 'starts'), hours: v('heating.burners.0.statistics', 'hours'),
      };
    }
    if (f('heating.circuits.0.operating.programs.normalEnergySaving')?.reason?.value === 'summerEco') summerEco = true;
    const hc = dev.heatingCircuits || {};
    const c = hc['0'] || hc[Object.keys(hc)[0]];
    if (c && curve.slope === null) curve = { slope: c.slope ?? null, shift: c.shift ?? 0 };
  }
}
const cliSlope = num(getArg('--curveSlope', '')), cliShift = num(getArg('--curveShift', ''));
if (cliSlope) curve.slope = cliSlope;
if (cliShift !== null) curve.shift = cliShift;

// ─── Weather (Open-Meteo) ───────────────────────────────────────────────────
function getLocation() {
  const la = num(getArg('--lat', '')), lo = num(getArg('--lon', ''));
  if (la !== null && lo !== null) return { lat: la, lon: lo };
  const file = path.join(HB_PATH, `viessmann-location-${INSTALLATION || 'default'}.json`);
  const c = readJson(file); if (c?.lat && c?.lon) return c;
  if (!INSTALLATION) return null;
  try {
    const tokens = readJson(path.join(HB_PATH, 'viessmann-tokens.json'));
    const find = (o) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if ((k === 'accessToken' || k === 'access_token') && typeof v === 'string') return v; const r = find(v); if (r) return r; } return null; };
    const tok = find(tokens); if (!tok) return null;
    const g = httpJson(`https://api.viessmann-climatesolutions.com/iot/v2/equipment/installations/${INSTALLATION}`, { Authorization: 'Bearer ' + tok })?.data?.address?.geolocation;
    if (g?.latitude && g?.longitude) { const loc = { lat: +(+g.latitude).toFixed(3), lon: +(+g.longitude).toFixed(3) }; try { fs.writeFileSync(file, JSON.stringify(loc)); } catch (_) {} return loc; }
  } catch (e) { process.stderr.write(`[weather] location lookup failed: ${e.message}\n`); }
  return null;
}
const loc = getLocation();
let temps = {}, forecastDays = 0;
if (loc) {
  const cacheFile = path.join(HB_PATH, `viessmann-weather-${loc.lat}_${loc.lon}.json`);
  const cache = readJson(cacheFile) || {};
  const today = localDay(NOW);
  const q = `latitude=${loc.lat}&longitude=${loc.lon}&daily=temperature_2m_mean&timezone=auto`;
  const archEnd = addDays(today, -7), archStart = addDays(today, -400);
  let missing = null;
  for (let d = archStart; d <= archEnd; d = addDays(d, 1)) if (cache[d] === undefined) { missing = d; break; }
  if (missing) {
    try { const j = httpJson(`https://archive-api.open-meteo.com/v1/archive?${q}&start_date=${missing}&end_date=${archEnd}`); (j.daily?.time || []).forEach((t, i) => { const v = j.daily.temperature_2m_mean[i]; if (v !== null && v !== undefined) cache[t] = v; }); }
    catch (e) { process.stderr.write(`[weather] archive: ${e.message}\n`); }
    try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch (_) {}
  }
  const recent = {};
  try { const j = httpJson(`https://api.open-meteo.com/v1/forecast?${q}&past_days=10&forecast_days=16`); (j.daily?.time || []).forEach((t, i) => { const v = j.daily.temperature_2m_mean[i]; if (v !== null && v !== undefined) recent[t] = v; }); }
  catch (e) { process.stderr.write(`[weather] forecast: ${e.message}\n`); }
  temps = { ...cache, ...recent };
  for (let i = 1; i <= 30; i++) if (recent[addDays(today, i)] !== undefined) forecastDays++;
}
const hasWeather = Object.keys(temps).length > 30;
const hdd = (t) => Math.max(0, HDD_BASE - t);
// Location-dependent values come from this installation's own weather, never from fixed numbers.
let warmDaysYear = null;
if (hasWeather) {
  const today = localDay(NOW), last = [];
  for (let i = 1; i <= 365; i++) { const t = temps[addDays(today, -i)]; if (t !== undefined) last.push([addDays(today, -i), t]); }
  if (last.length >= 330) {
    last.sort((a, b) => a[0] < b[0] ? -1 : 1);
    let coldest = Infinity;   // coldest 3-day mean of the last 12 months ≈ local design temperature
    for (let i = 2; i < last.length; i++) coldest = Math.min(coldest, (last[i][1] + last[i - 1][1] + last[i - 2][1]) / 3);
    if (DESIGN_ARG === null && isFinite(coldest)) { DESIGN_TEMP = Math.floor(coldest); DESIGN_AUTO = true; }
    warmDaysYear = last.filter(([, t]) => t >= HDD_BASE).length * 365 / last.length;
  }
}

// ─── Forecast (degree-day model) ────────────────────────────────────────────
let fc = null;
{
  const today = localDay(NOW);
  const days = Object.keys(gasDay).sort();
  let a = null, b = null, calibrated = false, r2 = null;
  if (hasWeather && days.length) {
    const pts = days.filter(d => temps[d] !== undefined).map(d => [hdd(temps[d]), gasDay[d].h + gasDay[d].w]);
    const warm = pts.filter(p => p[0] === 0).map(p => p[1]);
    if (pts.filter(p => p[0] >= 3).length >= 3) {
      const mx = mean(pts.map(p => p[0])), my = mean(pts.map(p => p[1]));
      const sxy = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0), sxx = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
      const syy = pts.reduce((s, p) => s + (p[1] - my) ** 2, 0);
      b = sxx > 0 ? Math.max(0, sxy / sxx) : 0; a = Math.max(0, my - b * mx);
      r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : null;
    }
    if (warm.length >= 5) a = mean(warm);
    if (api?.ts) {   // calibrate on the boiler yearly counters
      const end = localDay(api.ts); let sh = 0, cnt = 0, tot = 0;
      for (let d = `${end.slice(0, 4)}-01-01`; d <= end; d = addDays(d, 1)) { tot++; if (temps[d] !== undefined) { sh += hdd(temps[d]); cnt++; } }
      if (api.gasH.year > 0 && cnt >= tot * 0.9 && sh > 50) { b = api.gasH.year / (sh * tot / cnt); calibrated = true; }
      if (api.gasW.year > 0 && tot > 0) a = api.gasW.year / tot;
    }
    if (a === null) a = mean(pts.map(p => p[1])) ?? 0;
  }
  if (a === null && days.length) a = mean(days.slice(-30).map(d => gasDay[d].h + gasDay[d].w));
  if (a !== null) {
    let m30 = 0, m30h = 0;
    for (let i = 1; i <= 30; i++) { const d = addDays(today, i); let t = temps[d]; if (t === undefined) t = temps[addDays(d, -365)]; const h = b !== null && t !== undefined ? b * hdd(t) : 0; m30 += a + h; m30h += h; }
    let yr = null, yrH = null, hy = 0, n = 0;
    for (let i = 1; i <= 365; i++) { const t = temps[addDays(today, -i)]; if (t !== undefined) { hy += hdd(t); n++; } }
    if (b !== null && n >= 330) { yrH = b * hy * 365 / n; yr = a * 365 + yrH; }
    const Hkw = b !== null ? b * KWH_PER_M3 * 0.95 / 24 : null;            // kW per K of cold
    const need = Hkw !== null && isFinite(DESIGN_TEMP) ? Hkw * hdd(DESIGN_TEMP) : null;
    fc = { a, b, r2, calibrated, m30, m30h, yr, yrH, Hkw, need };
  }
}

// ─── Outdoor sensor bias ────────────────────────────────────────────────────
const sensorDay = {};
for (const r of snaps.boiler) { const v = num(r.outside_temp); if (v === null) continue; const d = localDay(r.t); (sensorDay[d] = sensorDay[d] || []).push(v); }
let sensorBias = null, biasDays = 0;
if (hasWeather) {
  const diffs = Object.entries(sensorDay).filter(([d, v]) => d >= localDay(NOW - 90 * 86400000) && temps[d] !== undefined && v.length >= 24).map(([d, v]) => mean(v) - temps[d]);
  if (diffs.length >= 5) { sensorBias = mean(diffs); biasDays = diffs.length; }
}
const realP = periodDays.map(d => temps[d]).filter(v => v !== undefined);
const sensP = P.boiler.map(r => num(r.outside_temp)).filter(v => v !== null);

// ─── Heating analysis ───────────────────────────────────────────────────────
// A heating day is a day on which the boiler really burned gas for heating (>= 0.3 m³).
const gasHeatDays = new Set(Object.keys(gasDay).filter(d => gasDay[d].h >= 0.3));
const isHeatRow = (r) => gasHeatDays.has(localDay(r.t)) && (r.mode || 'heating').toLowerCase() !== 'standby';
const normalSet = median(snaps.hc0.filter(r => r.program === 'normal').slice(-2000).map(r => num(r.target_temp)).filter(v => v !== null && v > 0));
const reducedSet = median(snaps.hc0.filter(r => r.program === 'reduced').slice(-2000).map(r => num(r.target_temp)).filter(v => v !== null && v > 0));
function heatStats(hcHeat) {
  if (hcHeat.length < 12) return null;
  const pairs = hcHeat.map(r => [num(r.room_temp), num(r.target_temp), r.program]).filter(([a, b]) => a !== null && b !== null && a > 0 && b > 0);
  const byDay = {};
  for (const r of hcHeat) { const v = num(r.room_temp); if (v !== null && v > 0) (byDay[localDay(r.t)] = byDay[localDay(r.t)] || []).push(v); }
  const daySd = Object.values(byDay).filter(a => a.length >= 8).map(sd).filter(v => v !== null);
  const flows = [], curvePts = [];
  let flowMax = null;
  for (const r of hcHeat) {
    const f = num(r.flow_temp); if (f === null || f <= 0) continue;
    const b = nearestBoiler(r.t);
    if (b && b.burner_active === 'true') {
      flows.push(f); flowMax = flowMax === null ? f : Math.max(flowMax, f);
      const o = num(b.outside_temp); if (o !== null) curvePts.push({ x: o, y: f });
    }
  }
  const prog = {}; for (const r of hcHeat) { const p = r.program || 'other'; prog[p] = (prog[p] || 0) + 1; }
  const normPairs = pairs.filter(p => p[2] === 'normal'), redPairs = pairs.filter(p => p[2] === 'reduced');
  const dayList = [...new Set(hcHeat.map(r => localDay(r.t)))].sort();
  return {
    days: dayList.length, from: dayList[0], to: dayList[dayList.length - 1], daySet: new Set(dayList),
    room: mean(pairs.map(p => p[0])), set: mean(pairs.map(p => p[1])), diff: mean(pairs.map(p => p[0] - p[1])),
    roomNormal: mean(normPairs.map(p => p[0])), roomReduced: mean(redPairs.map(p => p[0])),
    comfortPct: pairs.length ? 100 * pairs.filter(p => Math.abs(p[0] - p[1]) <= 1).length / pairs.length : null,
    stab: mean(daySd), flow: mean(flows), flowN: flows.length, flowMax,
    condPct: flows.length ? 100 * flows.filter(f => f < 55).length / flows.length : null,
    curvePts: curvePts.slice(-800), prog, progN: hcHeat.length,
  };
}
const heat = heatStats(P.hc0.filter(isHeatRow));
const heatDaysSet = heat ? heat.daySet : new Set();
// When the chosen period has no heating (e.g. summer), the assistant still uses the
// whole history (last heating season) so its advice stays useful all year round.
const seasonHeat = heat ? null : heatStats(snaps.hc0.filter(isHeatRow));
const heatAdv = heat || seasonHeat;
const curveLine = (() => {
  if (!curve.slope) return null;
  const rt = normalSet ?? 20, out = [];
  for (let x = -15; x <= 22; x++) {
    const dar = x - rt;
    const y = clamp(rt + curve.shift - curve.slope * dar * (1.4347 + 0.021 * dar + 247.9e-6 * dar * dar), rt, 85);
    out.push({ x, y: +y.toFixed(1) });
  }
  return out;
})();
const curveAt = (x) => { if (!curveLine) return null; const p = curveLine.find(q => q.x === Math.round(x)); return p ? p.y : null; };

// ─── Burner (counters) ──────────────────────────────────────────────────────
const cnt = P.boiler.filter(r => num(r.burner_starts) > 0);
let burner = null;
if (cnt.length >= 2) {
  const f = cnt[0], l = cnt[cnt.length - 1];
  const starts = num(l.burner_starts) - num(f.burner_starts);
  const hours = num(l.burner_hours) - num(f.burner_hours);
  const spanDays = Math.max(1 / 24, (l.t - f.t) / 86400000);
  const lastOfDay = {};
  for (const r of snaps.boiler) if (num(r.burner_starts) > 0) lastOfDay[localDay(r.t)] = num(r.burner_starts);
  const dKeys = Object.keys(lastOfDay).sort();
  const perDay = {};
  for (let i = 1; i < dKeys.length; i++) if (addDays(dKeys[i - 1], 1) === dKeys[i] && dKeys[i] >= localDay(startT)) perDay[dKeys[i]] = Math.max(0, lastOfDay[dKeys[i]] - lastOfDay[dKeys[i - 1]]);
  const heatStarts = Object.entries(perDay).filter(([d]) => heatDaysSet.has(d)).map(([, v]) => v);
  if (seasonHeat) {
    const all = [];
    for (let i = 1; i < dKeys.length; i++) if (addDays(dKeys[i - 1], 1) === dKeys[i] && seasonHeat.daySet.has(dKeys[i])) all.push(Math.max(0, lastOfDay[dKeys[i]] - lastOfDay[dKeys[i - 1]]));
    if (all.length) seasonHeat.startsPerDay = mean(all);
  }
  const warmStarts = Object.entries(perDay).filter(([d]) => !gasHeatDays.has(d)).map(([, v]) => v);
  burner = {
    starts, hours, perDay: starts / spanDays, spanDays,
    runtimePct: 100 * hours / (spanDays * 24),
    cycleMin: hours >= 10 && starts > 0 ? hours * 60 / starts : null,
    avgKw: hours >= 10 ? gasP.tot * KWH_PER_M3 / hours : null,
    dayMap: perDay, heatStartsPerDay: heatStarts.length ? mean(heatStarts) : null, warmStartsPerDay: warmStarts.length ? mean(warmStarts) : null,
    lifeStarts: num(l.burner_starts), lifeHours: num(l.burner_hours),
  };
}
const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0));
for (const r of ignitions) { const d = new Date(r.t); heatmap[(d.getDay() + 6) % 7][d.getHours()]++; }
const heatmapMax = Math.max(1, ...heatmap.flat());
const modSeries = [];
{ let prev = null; for (const r of P.boiler) { const m = num(r.modulation); if (r.burner_active === 'true' && m !== null && m > 0) { if (m !== prev) modSeries.push({ x: r.t, y: m }); prev = m; } else prev = null; } }
const modVals = modSeries.map(p => p.y);

// ─── Hot water ──────────────────────────────────────────────────────────────
let dhw = null;
if (P.dhw.length) {
  const on = P.dhw.filter(r => (r.mode || '') !== 'off');
  const temp = on.map(r => num(r.dhw_temp)).filter(v => v !== null && v > 0);
  const target = median(on.map(r => num(r.dhw_target)).filter(v => v !== null && v > 0));
  const reach = on.filter(r => num(r.dhw_temp) !== null && target !== null && num(r.dhw_temp) >= target - 5).length;
  const modes = {}; for (const r of P.dhw) { const m = r.mode || 'other'; modes[m] = (modes[m] || 0) + 1; }
  const sorted = [...temp].sort((a, b) => a - b);
  const p90 = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : null;
  const peak = sorted.length ? sorted[sorted.length - 1] : null;
  dhw = {
    onShare: temp.length ? on.length / P.dhw.length : 0, avg: mean(temp), target, peak, modes, n: P.dhw.length,
    reachPct: on.length ? 100 * reach / on.length : null,
    instant: target !== null && p90 !== null && p90 < target - 5 && peak >= target - 5,
    neverReached: target !== null && peak !== null && peak < target - 5,
    gasPerDay: gasP.w / coveredDays,
  };
}

// ─── Messages ───────────────────────────────────────────────────────────────
const CODES = {
  'S.0': ['Standby', 'Standby'], 'S.1': ['Riscaldamento acqua calda', 'DHW heating'], 'S.2': ['Riscaldamento', 'Central heating'],
  'S.3': ['Bruciatore acceso', 'Burner on'], 'S.4': ['Bruciatore spento', 'Burner off'], 'S.5': ['Prelavaggio ventilatore', 'Fan pre-purge'],
  'S.6': ['Accensione', 'Ignition'], 'S.7': ['Fiamma rilevata', 'Flame detected'], 'S.8': ['Postventilazione', 'Fan post-purge'],
  'S.10': ['Antigelo attivo', 'Frost protection'], 'S.12': ['Pompa di circolazione attiva', 'Circulation pump active'],
  'S.20': ['Protezione caldaia (sovratemperatura)', 'Boiler protection (overtemperature)'], 'S.24': ['Postcircolazione pompa', 'Pump overrun'],
  'S.29': ['Richiesta riscaldamento', 'Central heating demand'], 'S.31': ['Eco estivo', 'Summer eco'], 'S.32': ['Circuito in standby', 'Circuit standby'],
  'S.39': ['Richiesta di calore', 'Heat demand'],
  'F.1': ['Guasto bruciatore: nessuna accensione', 'Burner fault: no ignition'], 'F.2': ['Segnale fiamma perso', 'Flame signal lost'],
  'F.3': ['Errore di accensione', 'Ignition fault'], 'F.4': ['Catena di sicurezza aperta', 'Safety chain open'], 'F.5': ['Guasto valvola gas', 'Gas valve fault'],
  'F.9': ['Sensore mandata guasto', 'Flow sensor fault'], 'F.10': ['Sonda esterna guasta', 'Outdoor sensor fault'], 'F.11': ['Sensore ritorno guasto', 'Return sensor fault'],
  'F.12': ['Sensore acqua calda guasto', 'DHW sensor fault'], 'F.20': ['Termostato di sicurezza', 'Safety temperature limiter'],
  'F.22': ['Mancanza acqua / pressione bassa', 'Low water pressure'], 'F.28': ['Accensione fallita (gas)', 'Ignition failure (gas)'],
  'F.29': ['Fiamma persa dopo accensione', 'Flame lost after ignition'], 'F.30': ['Blocco di sicurezza', 'Safety shutdown'],
  'F.73': ['Pressione acqua troppo alta', 'Water pressure too high'], 'F.74': ['Pressione acqua troppo bassa', 'Water pressure too low'],
};
const codeText = (c) => CODES[c] ? CODES[c][LANG === 'it' ? 0 : 1] : tr('codice non documentato da Viessmann', 'code not documented by Viessmann');
const messages = [];
try {
  const pre = `viessmann-messages-${INSTALLATION ? INSTALLATION + '-' : ''}`;
  for (const f of fs.readdirSync(HB_PATH).filter(f => f.startsWith(pre) && f.endsWith('.json'))) {
    const arr = readJson(path.join(HB_PATH, f)); if (!Array.isArray(arr)) continue;
    for (const m of arr) {
      const t = Date.parse(String(m.timestamp || '').replace(/Z$/, ''));   // local time labelled "Z"
      if (isFinite(t)) messages.push({ code: m.errorCode || m.code || '', t });
    }
  }
} catch (_) {}
messages.sort((a, b) => b.t - a.t);
const faultsP = messages.filter(m => /^F\./.test(m.code) && m.t >= startT);
const codeCount = {}; for (const m of messages.filter(m => m.t >= startT)) codeCount[m.code] = (codeCount[m.code] || 0) + 1;

// ─── Schedule ───────────────────────────────────────────────────────────────
const sched = readJson(path.join(HB_PATH, `viessmann-schedule${sfx}.json`));
const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEK_L = LANG === 'it' ? ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return (h || 0) + (m || 0) / 60; };
const normalHoursWeek = sched?.entries ? WEEK.reduce((s, d) => s + (sched.entries[d] || []).filter(e => e.mode !== 'reduced').reduce((a, e) => a + Math.max(0, (hm(e.end) || 24) - hm(e.start)), 0), 0) : null;

// ─── Energy & rooms ─────────────────────────────────────────────────────────
const energy = P.energy.length ? {
  pv: mean(P.energy.map(r => num(r.pv_production_w)).filter(v => v !== null)),
  pvMax: Math.max(0, ...P.energy.map(r => num(r.pv_production_w)).filter(v => v !== null)),
  batt: mean(P.energy.map(r => num(r.battery_level)).filter(v => v !== null)),
  wall: mean(P.energy.map(r => num(r.wallbox_power_w)).filter(v => v !== null)),
} : null;
const rooms = Object.entries(roomRows).map(([k, a]) => { const p = a.filter(inP); return { k, avg: mean(p.map(r => num(r.room_temp)).filter(v => v !== null)), n: p.length }; }).filter(r => r.n);

// ─── Assistant: scores, advice, positives ───────────────────────────────────
const heatYearGas = fc?.yrH ?? (api?.gasH?.year ?? null);
const advice = [], positives = [];
const saving = (m3) => m3 !== null && isFinite(m3) && m3 > 0 ? { m3, eur: m3 * GAS_PRICE } : null;
const scores = { comfort: null, efficiency: 100, boiler: 100, dhw: null, reliability: 100 };

const H = heatAdv;
if (H && H.diff !== null) {
  const d = H.diff;
  scores.comfort = clamp(Math.round(100 - Math.max(0, Math.abs(d) - 0.5) * 20 - (H.stab ?? 0) * 10), 0, 100);
  if (d > 0.8) {
    const excess = d - 0.3, pts = Math.max(1, Math.min(3, Math.round(d)));
    scores.efficiency -= Math.min(25, Math.round(excess * 10));
    advice.push({
      prio: 'high', season: true, icon: 'thermo', who: tr('Tu, dall’app ViCare', 'You, in the ViCare app'), diff: tr('Facile · 2 minuti', 'Easy · 2 minutes'),
      title: tr(`La casa è ${nf(d)} °C più calda del necessario`, `The house is ${nf(d)} °C warmer than needed`),
      why: tr(`Nei ${H.days} giorni di riscaldamento le stanze erano in media a <b>${nf(H.room)} °C</b> mentre il programma chiedeva <b>${nf(H.set)} °C</b>. La caldaia non “sa” la temperatura delle stanze: decide quanto scaldare in base alla temperatura esterna e alla curva climatica (pendenza ${nf(curve.slope, 1)}, spostamento ${nf(curve.shift, 0)}). Se la curva è alta, la casa si scalda più del dovuto e il gas in più si paga.`,
        `On the ${H.days} heating days rooms averaged <b>${nf(H.room)} °C</b> while the program asked for <b>${nf(H.set)} °C</b>. The boiler does not “know” the room temperature: it decides how much to heat from the outdoor temperature and the heating curve (slope ${nf(curve.slope, 1)}, shift ${nf(curve.shift, 0)}). If the curve is too high the house gets warmer than needed and you pay for the extra gas.`),
      steps: [
        tr(`Apri ViCare → Riscaldamento → Curva di riscaldamento e abbassa lo <b>spostamento</b> di ${pts} punt${pts > 1 ? 'i' : 'o'}${curve.shift !== null ? ` (da ${nf(curve.shift, 0)} a ${nf(curve.shift - pts, 0)})` : ''}. Ogni punto vale circa 1 °C in casa.`, `Open ViCare → Heating → Heating curve and lower the <b>shift</b> by ${pts} point${pts > 1 ? 's' : ''}${curve.shift !== null ? ` (from ${nf(curve.shift, 0)} to ${nf(curve.shift - pts, 0)})` : ''}. Each point is about 1 °C indoors.`),
        tr('Aspetta 3–4 giorni (la casa reagisce lentamente) e rigenera questo report.', 'Wait 3–4 days (the house reacts slowly) and generate this report again.'),
        tr('Se ti sembra troppo fresco, rialza di mezzo punto. Non cambiare pendenza e spostamento insieme.', 'If it feels too cool, raise it by half a point. Do not change slope and shift at the same time.'),
      ],
      save: saving(heatYearGas !== null ? heatYearGas * 0.06 * excess : null),
    });
  } else if (d < -0.8) {
    advice.push({
      prio: 'medium', season: true, icon: 'thermo', who: tr('Tu, dall’app ViCare', 'You, in the ViCare app'), diff: tr('Facile', 'Easy'),
      title: tr(`La casa è ${nf(-d)} °C più fresca di quanto impostato`, `The house is ${nf(-d)} °C cooler than set`),
      why: tr(`Stanze in media a ${nf(H.room)} °C con ${nf(H.set)} °C impostati.`, `Rooms averaged ${nf(H.room)} °C with ${nf(H.set)} °C set.`),
      steps: [tr('Alza lo spostamento della curva di 1 punto e ricontrolla dopo qualche giorno.', 'Raise the curve shift by 1 point and check again after a few days.')],
      save: null,
    });
  } else positives.push(tr(`Temperatura delle stanze in linea con le impostazioni (${sgn(d)} °C).`, `Room temperature matches the settings (${sgn(d)} °C).`));
  if (H.stab !== null && H.stab < 0.5) positives.push(tr(`Temperatura molto stabile durante la giornata (±${nf(H.stab)} °C).`, `Very stable temperature during the day (±${nf(H.stab)} °C).`));
}
if (sensorBias !== null) {
  if (Math.abs(sensorBias) > 1.5) {
    scores.efficiency -= Math.min(20, Math.round(Math.abs(sensorBias) * 5));
    advice.push({
      prio: Math.abs(sensorBias) > 3 ? 'high' : 'medium', icon: 'sensor', who: tr('Tecnico o fai-da-te', 'Installer or DIY'), diff: tr('Media', 'Medium'),
      title: sensorBias > 0 ? tr(`La sonda esterna segna ${nf(sensorBias)} °C in più del reale`, `The outdoor sensor reads ${nf(sensorBias)} °C too warm`) : tr(`La sonda esterna segna ${nf(-sensorBias)} °C in meno del reale`, `The outdoor sensor reads ${nf(-sensorBias)} °C too cold`),
      why: tr(`Ho confrontato per ${biasDays} giorni la sonda della caldaia con la temperatura reale della tua zona (Open-Meteo). ${sensorBias > 0 ? 'La sonda “crede” che fuori faccia più caldo, quindi la caldaia manda acqua meno calda ai termosifoni. Probabilmente per compensare è stato alzato lo spostamento della curva: il risultato è che nelle giornate di sole o vicino a fonti di calore la regolazione sbaglia.' : 'La sonda “crede” che fuori faccia più freddo, quindi la caldaia scalda più del necessario.'} Tipiche cause: sonda al sole, sopra una finestra, vicino allo scarico fumi o su un muro caldo.`,
        `For ${biasDays} days I compared the boiler sensor with the real local temperature (Open-Meteo). ${sensorBias > 0 ? 'The sensor “thinks” it is warmer outside, so the boiler sends cooler water to the radiators. The curve shift has probably been raised to compensate: on sunny days or near heat sources the control then goes wrong.' : 'The sensor “thinks” it is colder outside, so the boiler heats more than needed.'} Typical causes: sensor in the sun, above a window, near the flue or on a warm wall.`),
      steps: [
        tr('Controlla dove è montata la sonda: deve stare su un muro a nord o nord-ovest, a 2–2,5 m d’altezza, all’ombra, lontano da finestre, balconi e scarichi.', 'Check where the sensor is mounted: north or north-west wall, 2–2.5 m high, shaded, away from windows, balconies and flues.'),
        tr('Se va spostata, chiedi al tecnico (è un cavo a bassa tensione).', 'If it must be moved, ask your installer (it is a low-voltage cable).'),
        tr('Dopo lo spostamento abbassa lo spostamento della curva di 1–2 punti e ricontrolla il report.', 'After moving it, lower the curve shift by 1–2 points and check the report again.'),
      ],
      save: null,
    });
  } else positives.push(tr(`La sonda esterna è precisa (scarto medio ${sgn(sensorBias)} °C).`, `The outdoor sensor is accurate (average difference ${sgn(sensorBias)} °C).`));
}
if (burner) {
  const hs = heat ? burner.heatStartsPerDay : (seasonHeat?.startsPerDay ?? null);
  if (H && hs !== null && hs > 30) {
    scores.boiler -= Math.min(50, Math.round((hs - 30) * 1.5));
    advice.push({
      prio: hs > 50 ? 'high' : 'medium', season: true, icon: 'flame', who: tr('Tecnico Viessmann', 'Viessmann installer'), diff: tr('Intervento tecnico', 'Service visit'),
      title: tr(`La caldaia si accende troppo spesso (${ni(hs)} volte al giorno)`, `The boiler starts too often (${ni(hs)} times a day)`),
      why: tr(`Nei giorni di riscaldamento la caldaia si è accesa in media ${ni(hs)} volte al giorno${burner.cycleMin !== null ? `, con accensioni di circa ${nf(burner.cycleMin)} minuti` : ''}. Succede quando la caldaia è molto più potente di quanto serve alla casa (qui servono circa ${nf(fc?.need)} kW con ${nf(DESIGN_TEMP, 0)} °C esterni): si accende, raggiunge subito la temperatura e si spegne. Ogni accensione spreca gas nella fase di avvio e consuma elettrodo e ventilatore.`,
        `On heating days the boiler started ${ni(hs)} times a day on average${burner.cycleMin !== null ? `, with runs of about ${nf(burner.cycleMin)} minutes` : ''}. This happens when the boiler is far more powerful than the house needs (about ${nf(fc?.need)} kW at ${nf(DESIGN_TEMP, 0)} °C outside): it starts, reaches the temperature at once and stops. Every start wastes gas while warming up and wears the electrode and fan.`),
      steps: [
        tr('Chiedi al tecnico di <b>ridurre la potenza massima in riscaldamento</b> (parametro della caldaia) vicino al fabbisogno reale.', 'Ask your installer to <b>limit the maximum heating output</b> (boiler parameter) close to the real demand.'),
        tr('Chiedi di verificare il <b>tempo di blocco anti-pendolamento</b> e la velocità della pompa.', 'Ask to check the <b>anti-cycling delay</b> and the pump speed.'),
        tr('Tieni aperte le valvole dei termosifoni principali: se chiudono quasi tutte, la caldaia non riesce a “scaricare” il calore.', 'Keep the main radiator valves open: if almost all of them close, the boiler cannot get rid of the heat.'),
        tr('Abbassare la curva climatica aiuta anche qui.', 'Lowering the heating curve also helps.'),
      ],
      save: saving(heatYearGas !== null ? heatYearGas * 0.04 : null),
    });
  } else if (H && hs !== null) positives.push(tr(`Numero di accensioni in riscaldamento nella norma (${ni(hs)} al giorno).`, `Heating starts within normal range (${ni(hs)} per day).`));
}
if (H && H.flowN >= 5) {
  if (H.flow >= 55) {
    scores.efficiency -= 15;
    advice.push({ prio: 'medium', season: true, icon: 'radiator', who: tr('Tu, dall’app ViCare', 'You, in the ViCare app'), diff: tr('Facile', 'Easy'),
      title: tr(`Acqua ai termosifoni troppo calda (${nf(H.flow)} °C)`, `Radiator water too hot (${nf(H.flow)} °C)`),
      why: tr('Una caldaia a condensazione rende di più quando l’acqua che torna dai termosifoni è sotto i 50–55 °C: così recupera il calore del vapore nei fumi.', 'A condensing boiler is most efficient when water returns below 50–55 °C: it then recovers the heat in the flue steam.'),
      steps: [tr('Abbassa la pendenza della curva di 0,1–0,2 e verifica che la casa resti calda.', 'Lower the curve slope by 0.1–0.2 and check the house stays warm.')],
      save: saving(heatYearGas !== null ? heatYearGas * 0.05 : null) });
  } else positives.push(tr(`Mandata media ${nf(H.flow)} °C: la caldaia lavora in condensazione (${ni(H.condPct)}% del tempo).`, `Average flow ${nf(H.flow)} °C: the boiler is condensing (${ni(H.condPct)}% of the time).`));
}
if (H && normalSet !== null && reducedSet !== null && normalSet - reducedSet < 2 && heatYearGas) {
  advice.push({ prio: 'low', season: true, icon: 'moon', who: tr('Tu, dall’app ViCare', 'You, in the ViCare app'), diff: tr('Facile', 'Easy'),
    title: tr(`Di notte la temperatura scende solo di ${nf(normalSet - reducedSet, 0)} °C`, `At night the temperature only drops by ${nf(normalSet - reducedSet, 0)} °C`),
    why: tr(`Normale ${nf(normalSet, 0)} °C, Ridotta ${nf(reducedSet, 0)} °C. Abbassare di un altro grado la temperatura Ridotta (notte e assenze) fa risparmiare senza toccare il comfort di giorno. Con case molto isolate o riscaldamento a pavimento il vantaggio è minore.`,
      `Normal ${nf(normalSet, 0)} °C, Reduced ${nf(reducedSet, 0)} °C. Lowering the Reduced temperature (night and away) by one more degree saves gas without touching daytime comfort. With very well insulated homes or underfloor heating the gain is smaller.`),
    steps: [tr(`Imposta la temperatura Ridotta a ${nf(reducedSet - 1, 0)} °C.`, `Set the Reduced temperature to ${nf(reducedSet - 1, 0)} °C.`), tr('Se al mattino la casa è fredda, anticipa di 30 minuti l’inizio della fascia Normale.', 'If the house is cold in the morning, start the Normal slot 30 minutes earlier.')],
    save: saving(heatYearGas * 0.06 * (normalHoursWeek !== null ? (168 - normalHoursWeek) / 168 : 0.4)) });
}
if (api && api.gasH.month === 0 && (api.elH.month ?? 0) > 0.5) {
  const perMonth = api.elH.month / Math.max(1, new Date(api.ts).getDate()) * 30;
  const offMonths = warmDaysYear !== null ? Math.max(1, Math.round(warmDaysYear / 30)) : 5;
  advice.push({ prio: 'low', icon: 'sun', who: tr('Tu, dall’app ViCare', 'You, in the ViCare app'), diff: tr('Facile', 'Easy'),
    title: tr('In estate il circuito di riscaldamento resta acceso', 'In summer the heating circuit stays on'),
    why: tr(`Questo mese la caldaia non ha usato gas per il riscaldamento, ma il riscaldamento ha già consumato ${nf(api.elH.month)} kWh di elettricità (pompa ed elettronica)${summerEco ? '; la caldaia è in “eco estivo”, quindi il circuito resta in attesa' : ''}. ${warmDaysYear !== null ? `Nella tua zona ci sono circa ${offMonths} mesi l’anno senza bisogno di riscaldamento: in quel periodo, con la modalità “solo acqua calda”,` : 'Con la modalità “solo acqua calda” fuori stagione'} la pompa si ferma e la caldaia non parte per il riscaldamento nelle giornate fresche di fine stagione.`,
      `This month the boiler used no gas for heating, but heating has already used ${nf(api.elH.month)} kWh of electricity (pump and electronics)${summerEco ? '; the boiler is in “summer eco”, so the circuit stays on standby' : ''}. ${warmDaysYear !== null ? `Your area has about ${offMonths} months a year with no heating need: during them, with “hot water only” mode,` : 'With “hot water only” mode outside the heating season'} the pump stops and the boiler does not start heating on cool days at the end of the season.`),
    steps: [tr('In ViCare imposta la modalità “Solo acqua calda” quando finisce la stagione di riscaldamento e “Riscaldamento + acqua calda” in autunno.', 'In ViCare set “Hot water only” when the heating season ends and “Heating + hot water” in autumn.')],
    save: { m3: null, eur: perMonth * offMonths * EL_PRICE, el: perMonth * offMonths } });
}
if (dhw && dhw.onShare >= 0.1) {
  if (dhw.neverReached) {
    scores.dhw = 50;
    advice.push({ prio: 'medium', icon: 'tap', who: tr('Tu / tecnico', 'You / installer'), diff: tr('Facile', 'Easy'),
      title: tr(`L’acqua calda non arriva alla temperatura impostata`, `Hot water does not reach the set temperature`),
      why: tr(`Massimo registrato ${nf(dhw.peak)} °C con obiettivo ${nf(dhw.target, 0)} °C.`, `Highest reading ${nf(dhw.peak)} °C with a ${nf(dhw.target, 0)} °C target.`),
      steps: [tr('Controlla la programmazione dell’acqua calda e la modalità Eco/Comfort in ViCare.', 'Check the hot water schedule and Eco/Comfort mode in ViCare.'), tr('Se persiste, fai controllare il sensore acqua calda.', 'If it persists, have the hot water sensor checked.')], save: null });
  } else {
    scores.dhw = 100;
    positives.push(dhw.instant
      ? tr(`Acqua calda OK: durante i prelievi arriva a ${nf(dhw.peak)} °C (obiettivo ${nf(dhw.target, 0)} °C).`, `Hot water OK: it reaches ${nf(dhw.peak)} °C while in use (target ${nf(dhw.target, 0)} °C).`)
      : tr(`Acqua calda all’obiettivo nel ${ni(dhw.reachPct)}% del tempo.`, `Hot water at target ${ni(dhw.reachPct)}% of the time.`));
    if (dhw.target !== null && dhw.target <= 50) positives.push(tr(`Temperatura dell’acqua calda impostata a ${nf(dhw.target, 0)} °C: scelta efficiente.`, `Hot water set to ${nf(dhw.target, 0)} °C: an efficient choice.`));
  }
  if (dhw.target !== null && dhw.target > 55) advice.push({ prio: 'low', icon: 'tap', who: tr('Tu, dall’app ViCare', 'You, in the ViCare app'), diff: tr('Facile', 'Easy'),
    title: tr(`Acqua calda impostata a ${nf(dhw.target, 0)} °C`, `Hot water set to ${nf(dhw.target, 0)} °C`),
    why: tr('Per l’uso domestico 45–50 °C bastano; ogni 10 °C in meno riduce le dispersioni del bollitore.', 'For home use 45–50 °C is enough; every 10 °C less cuts cylinder losses.'),
    steps: [tr('Prova 50 °C.', 'Try 50 °C.')], save: saving(fc ? fc.a * 365 * 0.08 : null) });
}
if (faultsP.length) {
  scores.reliability -= Math.min(60, faultsP.length * 15);
  advice.push({ prio: 'high', icon: 'warn', who: tr('Tecnico Viessmann', 'Viessmann installer'), diff: tr('Intervento tecnico', 'Service visit'),
    title: tr(`${faultsP.length} codici di guasto nel periodo`, `${faultsP.length} fault codes in the period`),
    why: [...new Set(faultsP.map(m => m.code))].map(c => `<b>${esc(c)}</b> ${esc(codeText(c))}`).join(' · '),
    steps: [tr('Annota i codici e le date (sezione “Messaggi della caldaia”).', 'Note the codes and dates (section “Boiler messages”).'), tr('Se si ripetono, chiama il tecnico e mostragli questo report.', 'If they repeat, call your installer and show them this report.')], save: null });
} else positives.push(tr('Nessun guasto registrato nel periodo.', 'No faults recorded in the period.'));
if (BOILER_KW && fc?.need && BOILER_KW > fc.need * 3) advice.push({ prio: 'low', icon: 'flame', who: tr('Tecnico Viessmann', 'Viessmann installer'), diff: tr('Intervento tecnico', 'Service visit'),
  title: tr(`Caldaia sovradimensionata (${nf(BOILER_KW, 0)} kW contro ${nf(fc.need)} kW necessari)`, `Oversized boiler (${nf(BOILER_KW, 0)} kW vs ${nf(fc.need)} kW needed)`),
  why: tr('Una caldaia molto più potente del necessario lavora quasi sempre al minimo e si accende e spegne spesso.', 'A boiler much bigger than needed runs at minimum most of the time and cycles often.'),
  steps: [tr('Fai limitare la potenza massima in riscaldamento.', 'Have the maximum heating output limited.')], save: null });
if (!PRICE_SET) advice.push({ prio: 'info', icon: 'euro', who: tr('Tu', 'You'), diff: tr('Facile', 'Easy'),
  title: tr('Inserisci il tuo prezzo del gas', 'Enter your gas price'),
  why: tr(`I costi sono calcolati con un prezzo indicativo di ${nf(GAS_PRICE, 2)} €/m³. Il prezzo giusto è il totale della bolletta (tasse incluse, esclusa la quota fissa) diviso per i m³ o Smc consumati.`, `Costs use an indicative price of €${nf(GAS_PRICE, 2)}/m³. The right price is the bill total (taxes included, fixed charge excluded) divided by the m³ used.`),
  steps: [tr('Inseriscilo nel campo “Prezzo gas” della pagina del report e rigenera.', 'Enter it in the “Gas price” field of the report page and generate again.')], save: null });

scores.efficiency = clamp(scores.efficiency, 0, 100); scores.boiler = clamp(scores.boiler, 0, 100); scores.reliability = clamp(scores.reliability, 0, 100);
const scoreList = Object.values(scores).filter(v => v !== null);
const PRIO = { high: 0, medium: 1, low: 2, info: 3 };
const overall = clamp(Math.round(mean(scoreList) - 6 * advice.filter(a => a.prio === 'high').length - 3 * advice.filter(a => a.prio === 'medium').length), 0, 100);
advice.sort((a, b) => PRIO[a.prio] - PRIO[b.prio]);
const totalSave = advice.reduce((s, a) => s + (a.save?.eur || 0), 0);

// ─── Chart data ─────────────────────────────────────────────────────────────
const hourly = (arr, key, filt) => { const m = {}; for (const r of arr) { if (filt && !filt(r)) continue; const v = num(r[key]); if (v === null || v <= -50) continue; const h = Math.floor(r.t / 3600000); (m[h] = m[h] || []).push(v); } const pts = Object.entries(m).map(([h, v]) => ({ x: +h * 3600000, y: +mean(v).toFixed(1) })).sort((a, b) => a.x - b.x); const out = []; for (let i = 0; i < pts.length; i++) { if (i && pts[i].x - pts[i - 1].x > 3 * 3600000) out.push({ x: pts[i - 1].x + 3600000, y: null }); out.push(pts[i]); } return out; };
const thin = (a, max = 2000) => a.length <= max ? a : a.filter((_, i) => i % Math.ceil(a.length / max) === 0);
const IGN_DAILY = coveredDays > 31;
const ignHourly = (() => { const m = {}; for (const r of ignitions) { const h = IGN_DAILY ? new Date(localDay(r.t) + 'T12:00:00').getTime() : Math.floor(r.t / 3600000) * 3600000; m[h] = (m[h] || 0) + 1; } return Object.entries(m).map(([x, y]) => ({ x: +x, y })); })();
const ddPts = Object.keys(gasDay).filter(d => temps[d] !== undefined).map(d => ({ x: +temps[d].toFixed(1), y: +(gasDay[d].h + gasDay[d].w).toFixed(2), d }));
const ddLine = fc && fc.b !== null ? Array.from({ length: 36 }, (_, i) => { const x = -10 + i; return { x, y: +(fc.a + fc.b * hdd(x)).toFixed(2) }; }) : null;
const startsOut = burner ? Object.entries(burner.dayMap).filter(([d]) => temps[d] !== undefined).map(([d, v]) => ({ x: +temps[d].toFixed(1), y: v })) : [];
const chart = {
  overview: {
    room: thin(hourly(P.hc0, 'room_temp')), set: thin(hourly(P.hc0, 'target_temp')),
    flow: thin(hourly(P.hc0, 'flow_temp', r => { if (!gasHeatDays.has(localDay(r.t))) return false; const b = nearestBoiler(r.t); return b && b.burner_active === 'true'; })),
    sensor: thin(hourly(P.boiler, 'outside_temp')), dhw: thin(hourly(P.dhw.filter(r => r.mode !== 'off'), 'dhw_temp')),
    real: periodDays.filter(d => temps[d] !== undefined).map(d => ({ x: new Date(d + 'T12:00:00').getTime(), y: temps[d] })),
    ign: ignHourly,
  },
  gas: { labels: periodDays, h: periodDays.map(d => +(gasDay[d]?.h ?? 0).toFixed(2)), w: periodDays.map(d => +(gasDay[d]?.w ?? 0).toFixed(2)), t: periodDays.map(d => temps[d] ?? null) },
  dd: { pts: ddPts, line: ddLine },
  dhw: { t: thin(hourly(P.dhw.filter(r => r.mode !== 'off'), 'dhw_temp')), s: thin(hourly(P.dhw, 'dhw_target')) },
  starts: burner ? { labels: Object.keys(burner.dayMap), v: Object.values(burner.dayMap), t: Object.keys(burner.dayMap).map(d => temps[d] ?? null) } : null,
  startsOut,
  mod: modVals.length >= 20 ? modSeries : null,
  curve: curveLine ? { line: curveLine, pts: heat?.curvePts || [] } : null,
  energy: P.energy.length >= 2 ? { pv: thin(hourly(P.energy, 'pv_production_w')), batt: thin(hourly(P.energy, 'battery_level')) } : null,
};

// ─── HTML building blocks ───────────────────────────────────────────────────
const ICON = {
  flame: '<path d="M12 2c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.2 1-3.8 2.3-5 .2 1.7 1 2.8 2.2 3.3C11 8 10.7 5 12 2z"/>',
  gas: '<path d="M6 3h8v18H6z"/><path d="M14 8h2a2 2 0 0 1 2 2v7a1.5 1.5 0 0 0 3 0V9l-3-3"/><path d="M8 7h4v4H8z"/>',
  house: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
  tap: '<path d="M4 9h9a3 3 0 0 1 3 3v1"/><path d="M8 9V6h3v3"/><path d="M6 6h7"/><path d="M16 17c0 1.1-.9 2-2 2s-2-.9-2-2c0-1.5 2-3.5 2-3.5s2 2 2 3.5z"/>',
  thermo: '<path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/>',
  sensor: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  radiator: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 6v12M11 6v12M15 6v12M19 18v2M5 18v2"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  warn: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18v.5"/>',
  euro: '<path d="M17 6a7 7 0 1 0 0 12"/><path d="M4 10h9M4 14h9"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-8"/>',
  bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9 16h6"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5z"/><path d="M8 7h7"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
  msg: '<path d="M4 5h16v11H8l-4 4V5z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
};
const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ICON.info}</svg>`;
const lvlOf = (s) => s === null ? 'info' : s >= 80 ? 'good' : s >= 55 ? 'warn' : 'bad';
const lvlText = { good: tr('bene', 'good'), warn: tr('migliorabile', 'improve'), bad: tr('da controllare', 'check'), info: tr('info', 'info') };
const badge = (lvl, txt) => `<span class="b b-${lvl}">${txt ?? lvlText[lvl]}</span>`;
const kpi = (label, value, u, help, lvl, sub) => `<div class="kpi"><div class="kl">${label}</div><div class="kv">${value}${u ? `<small>${u}</small>` : ''}${lvl ? ' ' + badge(lvl) : ''}</div>${sub ? `<div class="ks">${sub}</div>` : ''}${help ? `<div class="kh">${help}</div>` : ''}</div>`;
const naVal = (txt) => `<span class="na">${txt}</span>`;
const ring = (score, size, label, stroke = 10) => {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, v = score === null ? 0 : score;
  return `<div class="ring r-${lvlOf(score)}" style="width:${size}px"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="rt" stroke-width="${stroke}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="rv" stroke-width="${stroke}" stroke-dasharray="${(c * v / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/><text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" class="rn" style="font-size:${Math.round(size / 3.6)}px">${score === null ? '—' : score}</text></svg>${label ? `<div class="rl">${label}</div>` : ''}</div>`;
};
const chartBox = (id, title, how, cls = '') => `<figure class="chart ${cls}"><figcaption>${title}${how ? `<span class="how">${icon('info')} ${how}</span>` : ''}</figcaption><div class="cv"><canvas id="${id}"></canvas></div></figure>`;
const section = (id, ic, title, intro, body) => `<section id="${id}"><div class="sh"><div class="si">${icon(ic)}</div><div><h2>${title}</h2>${intro ? `<p class="intro">${intro}</p>` : ''}</div></div>${body}</section>`;
const sub = (t) => `<h3>${t}</h3>`;

// Illustrated system schematic (period averages)
const avgReal = realP.length ? mean(realP) : null, avgSens = sensP.length ? mean(sensP) : null;
const lastHc = [...P.hc0].reverse().find(r => num(r.room_temp) !== null);
const schem = (() => {
  const room = heat ? heat.room : num(lastHc?.room_temp);
  const set = heat ? heat.set : num(lastHc?.target_temp);
  const flow = heat?.flow ?? null;
  const t = (x, y, a, b, cls = '') => `<text x="${x}" y="${y}" class="s-big ${cls}">${a}</text><text x="${x}" y="${y + 20}" class="s-sm">${b}</text>`;
  const th = clamp(((avgReal ?? avgSens ?? 10) + 10) * 2.2, 5, 85);
  return `<svg class="schem" viewBox="0 0 960 330" role="img" aria-label="${tr('Schema dell’impianto', 'System diagram')}">
  <defs><linearGradient id="gHouse" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--s-house1)"/><stop offset="1" stop-color="var(--s-house2)"/></linearGradient>
  <linearGradient id="gFlame" x1="0" x2="0" y1="1" y2="0"><stop offset="0" stop-color="#ff6a00"/><stop offset="1" stop-color="#ffd000"/></linearGradient></defs>
  <g><circle cx="90" cy="70" r="30" fill="#ffc83d" opacity=".9"/><g stroke="#ffc83d" stroke-width="4" stroke-linecap="round" opacity=".7"><path d="M90 26v-12M90 126v-12M46 70h-12M146 70h-12M59 39l-8-8M121 101l8 8M59 101l-8 8M121 39l8-8"/></g>
  <rect x="60" y="150" width="14" height="90" rx="7" class="s-tube"/><circle cx="67" cy="248" r="16" fill="#3b82f6"/><rect x="63" y="${(240 - th).toFixed(0)}" width="8" height="${th.toFixed(0)}" rx="4" fill="#3b82f6"/>
  ${avgReal !== null ? t(95, 175, `${nf(avgReal)} °C`, tr('fuori (reale)', 'outside (real)')) : ''}
  ${avgSens !== null ? t(95, avgReal !== null ? 225 : 175, `${nf(avgSens)} °C`, tr('sonda caldaia', 'boiler sensor'), sensorBias !== null && Math.abs(sensorBias) > 1.5 ? 's-warn' : '') : ''}</g>
  <path d="M250 150 L470 40 L690 150 V310 H250 Z" fill="url(#gHouse)" class="s-line"/>
  <path d="M235 158 L470 30 L705 158" fill="none" class="s-roof"/>
  <g transform="translate(290,215)"><rect width="120" height="70" rx="8" class="s-rad"/>${[20, 40, 60, 80, 100].map(x => `<line x1="${x}" y1="6" x2="${x}" y2="64" class="s-radl"/>`).join('')}</g>
  ${heat ? `<g class="s-heat">${[320, 350, 380].map((x, i) => `<path d="M${x} 208 q6 -8 0 -14 q-6 -8 0 -14" style="animation-delay:${i * .4}s"/>`).join('')}</g>` : ''}
  ${t(300, 160, `${nf(room)} °C`, `${tr('in casa', 'indoors')} · ${tr('impostati', 'set')} ${nf(set)} °C`, heat && heat.diff > 0.8 ? 's-warn' : '')}
  <g transform="translate(520,150)"><rect width="120" height="150" rx="12" class="s-boiler"/><rect x="14" y="16" width="92" height="28" rx="5" class="s-disp"/>
  <text x="60" y="35" text-anchor="middle" class="s-dtxt">${burner ? ni(burner.perDay) + tr(' acc/g', ' st/d') : '—'}</text>
  <path d="M60 70c6 14 22 20 22 40a22 22 0 0 1-44 0c0-9 4-15 9-20 1 7 4 11 9 13-3-11-2-22 4-33z" fill="url(#gFlame)" class="s-flame"/></g>
  <path d="M520 265 H410" class="s-pipe hot"/><path d="M520 285 H410" class="s-pipe cold"/>
  ${flow !== null ? `<text x="420" y="254" class="s-sm">${tr('mandata', 'flow')} ${nf(flow)} °C</text>` : ''}
  <path d="M640 190 H760 V250" class="s-pipe hot"/>
  <g transform="translate(740,250)" class="s-tap"><path d="M0 0h40v14H14v10H0z"/><path d="M8 34c0 5 8 5 8 0 0-4-4-8-4-8s-4 4-4 8z" fill="#60a5fa"/></g>
  ${dhw ? t(795, 262, `${nf(dhw.instant || dhw.neverReached ? dhw.peak : dhw.avg)} °C`, dhw.instant ? tr('acqua calda (max)', 'hot water (max)') : tr('acqua calda', 'hot water')) : ''}
  <path d="M640 290 H700 V312 H790" class="s-pipe gas"/>
  <g transform="translate(790,290)"><rect width="120" height="40" rx="8" class="s-meter"/><text x="60" y="26" text-anchor="middle" class="s-mtxt">${nf(gasP.tot, 1)} m³</text></g>
  <text x="780" y="160" class="s-big">${eur(gasP.tot * GAS_PRICE)}</text><text x="780" y="180" class="s-sm">${tr(`gas in ${coveredDays} giorni`, `gas in ${coveredDays} days`)}</text>
  </svg>`;
})();

// Weekly schedule drawing
const schedSvg = (() => {
  if (!sched?.entries) return '';
  const W = 24 * 30, rowH = 24;
  let s = `<svg class="sched" viewBox="0 0 ${W + 64} ${7 * rowH + 24}" role="img">`;
  for (let h = 0; h <= 24; h += 3) s += `<text x="${50 + h * 30}" y="${7 * rowH + 18}" class="sc-h" text-anchor="middle">${String(h).padStart(2, '0')}</text>`;
  WEEK.forEach((d, i) => {
    const y = i * rowH;
    s += `<text x="0" y="${y + 16}" class="sc-d">${WEEK_L[i]}</text><rect x="50" y="${y + 3}" width="${W}" height="${rowH - 6}" rx="5" class="sc-red"/>`;
    for (const e of sched.entries[d] || []) { const a = hm(e.start), b = hm(e.end) || 24; s += `<rect x="${50 + a * 30}" y="${y + 3}" width="${Math.max(2, (b - a) * 30)}" height="${rowH - 6}" rx="5" class="sc-${e.mode === 'comfort' ? 'com' : e.mode === 'reduced' ? 'red' : 'nor'}"><title>${e.start}–${e.end} ${e.mode}</title></rect>`; }
  });
  return s + '</svg>';
})();

// ─── Sections ───────────────────────────────────────────────────────────────
const prioLbl = { high: tr('Priorità alta', 'High priority'), medium: tr('Priorità media', 'Medium priority'), low: tr('Priorità bassa', 'Low priority'), info: tr('Informazione', 'Information') };
const adviceHtml = advice.map((a, i) => `<article class="adv p-${a.prio}">
  <div class="adv-h"><div class="adv-i">${icon(a.icon)}</div><div><div class="adv-p">${prioLbl[a.prio]} · ${a.diff}</div><h4>${i + 1}. ${a.title}</h4>${a.season && seasonHeat ? `<div class="adv-s">${icon('calendar')} ${tr(`Nel periodo scelto il riscaldamento era spento: dati dell’ultima stagione (${fmtDate(seasonHeat.from)} – ${fmtDate(seasonHeat.to)})`, `Heating was off in the chosen period: data from the last heating season (${fmtDate(seasonHeat.from)} – ${fmtDate(seasonHeat.to)})`)}</div>` : ''}</div></div>
  <div class="adv-b"><div class="adv-why"><div class="lbl">${tr('Perché', 'Why')}</div><p>${a.why}</p></div>
  <div class="adv-do"><div class="lbl">${tr('Cosa fare', 'What to do')}</div><ol>${a.steps.map(s => `<li>${s}</li>`).join('')}</ol></div></div>
  <div class="adv-f"><span>${icon('house')} ${tr('Chi', 'Who')}: <b>${a.who}</b></span>${a.save ? `<span class="save">${icon('euro')} ${tr('Risparmio stimato', 'Estimated saving')}: <b>${a.save.m3 ? `≈ ${ni(a.save.m3)} m³ · ` : a.save.el ? `≈ ${ni(a.save.el)} kWh · ` : ''}${eur(a.save.eur)}${tr('/anno', '/year')}</b></span>` : ''}</div>
</article>`).join('');

const summaryCards = [
  { lvl: 'info', ic: 'gas', t: tr('Gas', 'Gas'), v: `${nf(gasP.tot, 1)} m³`, s: tr(`≈ ${eur(gasP.tot * GAS_PRICE)} · ${nf(gasP.tot / coveredDays, 2)} m³/giorno`, `≈ ${eur(gasP.tot * GAS_PRICE)} · ${nf(gasP.tot / coveredDays, 2)} m³/day`) },
  heat ? { lvl: lvlOf(scores.comfort), ic: 'house', t: tr('Comfort', 'Comfort'), v: `${nf(heat.room)} °C`, s: tr(`impostati ${nf(heat.set)} °C (${sgn(heat.diff)} °C)`, `set ${nf(heat.set)} °C (${sgn(heat.diff)} °C)`) }
       : { lvl: 'info', ic: 'house', t: tr('Riscaldamento', 'Heating'), v: tr('spento', 'off'), s: tr('nessun gas per riscaldare nel periodo', 'no heating gas in the period') },
  burner ? { lvl: lvlOf(scores.boiler), ic: 'flame', t: tr('Caldaia', 'Boiler'), v: `${ni(burner.perDay)} ${tr('acc./g', 'starts/d')}`, s: `${ni(burner.hours)} ${tr('ore di fiamma', 'burner hours')}` } : null,
  dhw ? { lvl: lvlOf(scores.dhw), ic: 'tap', t: tr('Acqua calda', 'Hot water'), v: `${nf(dhw.instant || dhw.neverReached ? dhw.peak : dhw.avg)} °C`, s: tr(`obiettivo ${nf(dhw.target, 0)} °C`, `target ${nf(dhw.target, 0)} °C`) } : null,
  sensorBias !== null ? { lvl: Math.abs(sensorBias) > 3 ? 'bad' : Math.abs(sensorBias) > 1.5 ? 'warn' : 'good', ic: 'sensor', t: tr('Sonda esterna', 'Outdoor sensor'), v: `${sgn(sensorBias)} °C`, s: tr('rispetto al meteo reale', 'vs real weather') } : null,
  { lvl: faultsP.length ? 'bad' : 'good', ic: 'warn', t: tr('Guasti', 'Faults'), v: String(faultsP.length), s: faultsP.length ? [...new Set(faultsP.map(m => m.code))].join(', ') : tr('nessuno', 'none') },
  fc ? { lvl: 'info', ic: 'chart', t: tr('Prossimi 30 giorni', 'Next 30 days'), v: `${ni(fc.m30)} m³`, s: `≈ ${eur(fc.m30 * GAS_PRICE)}` } : null,
].filter(Boolean);

const monthMax = Math.max(0.1, ...Object.values(monthly).map(v => v.h + v.w));
const monthRows = Object.entries(monthly).map(([m, v]) => `<tr><td>${new Date(m + '-15').toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' })}${isPartial(m) ? ` <small class="na">(${tr('parziale', 'partial')})</small>` : ''}</td><td>${nf(v.h)}</td><td>${nf(v.w)}</td><td><b>${nf(v.h + v.w)}</b></td><td>${eur((v.h + v.w) * GAS_PRICE)}</td><td class="bar"><span class="bh" style="width:${(100 * v.h / monthMax).toFixed(1)}%"></span><span class="bw" style="width:${(100 * v.w / monthMax).toFixed(1)}%"></span></td></tr>`).join('');

const modeName = { eco: 'Eco', comfort: 'Comfort', off: tr('Spenta', 'Off'), normal: tr('Normale', 'Normal'), reduced: tr('Ridotta', 'Reduced'), other: tr('Altro', 'Other') };
const pctBars = (obj, total) => `<div class="pbars">${Object.entries(obj).filter(([, n]) => n / total >= 0.005).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<div class="pb"><span class="pbl">${esc(modeName[k] || k)}</span><span class="pbt"><span class="pbf f-${esc(k)}" style="width:${(100 * n / total).toFixed(1)}%"></span></span><span class="pbp">${ni(100 * n / total)}%</span></div>`).join('')}</div>`;

const houseClass = (() => {
  if (!fc?.Hkw) return null;
  const w = fc.Hkw * 1000;
  return w < 100 ? ['good', tr('ottimo isolamento', 'excellent insulation')] : w < 200 ? ['good', tr('buon isolamento', 'good insulation')] : w < 350 ? ['warn', tr('isolamento medio', 'average insulation')] : ['bad', tr('molte dispersioni', 'high heat loss')];
})();

const S_OVERVIEW = section('overview', 'chart', tr('Andamento del periodo', 'Period overview'),
  tr('Tutto in un grafico: temperatura della casa, dell’acqua ai termosifoni, esterna (reale e sonda) e accensioni della caldaia. Clicca sulla legenda per mostrare o nascondere una linea; trascina per ingrandire, doppio clic per tornare indietro.', 'Everything in one chart: house, radiator water and outdoor temperature (real and sensor), plus boiler starts. Click the legend to show or hide a line; drag to zoom, double-click to reset.'),
  `${chartBox('cOverview', tr('Temperature (media oraria) e accensioni', 'Temperatures (hourly average) and starts'), IGN_DAILY ? tr('Le barre arancioni sono le accensioni registrate per giorno (scala a destra).', 'Orange bars are recorded starts per day (right scale).') : tr('Le barre arancioni sono le accensioni per ora (scala a destra).', 'Orange bars are starts per hour (right scale).'), 'tall')}
   ${schedSvg ? `${sub(tr('Programma settimanale del riscaldamento', 'Weekly heating schedule'))}<p class="note">${tr('Arancione = temperatura Normale, grigio = Ridotta', 'Orange = Normal temperature, grey = Reduced')}${normalSet !== null ? ` (${nf(normalSet, 0)} / ${nf(reducedSet, 0)} °C)` : ''}.</p>${schedSvg}` : ''}`);

const S_GAS = section('gas', 'gas', tr('Gas e costi', 'Gas and costs'),
  tr('Quanto gas ha usato la caldaia per scaldare la casa e l’acqua. I valori vengono dai contatori della caldaia: confrontati con le bollette sono precisi entro l’1–2%.', 'How much gas the boiler used to heat the house and the water. Values come from the boiler counters: compared with gas bills they are accurate within 1–2%.'),
  `<div class="kpis">
  ${kpi(tr('Gas totale', 'Total gas'), nf(gasP.tot), ' m³', tr('Metri cubi di gas bruciati nel periodo.', 'Cubic metres of gas burned in the period.'))}
  ${kpi(tr('Riscaldamento', 'Heating'), nf(gasP.h), ' m³', tr('Gas usato per scaldare la casa.', 'Gas used to heat the house.'), null, gasP.tot ? `${ni(100 * gasP.h / gasP.tot)}%` : '')}
  ${kpi(tr('Acqua calda', 'Hot water'), nf(gasP.w), ' m³', tr('Gas usato per doccia e rubinetti.', 'Gas used for showers and taps.'), null, gasP.tot ? `${ni(100 * gasP.w / gasP.tot)}%` : '')}
  ${kpi(tr('Costo stimato', 'Estimated cost'), ni(gasP.tot * GAS_PRICE), ' €', tr(`Gas × ${nf(GAS_PRICE, 2)} €/m³ (tasse incluse). La quota fissa della bolletta non è compresa.`, `Gas × €${nf(GAS_PRICE, 2)}/m³ (taxes included). Fixed bill charges are not included.`))}
  ${kpi(tr('Media al giorno', 'Average per day'), nf(gasP.tot / coveredDays, 2), ' m³', tr('Gas totale diviso per i giorni del periodo.', 'Total gas divided by the days in the period.'))}
  </div>
  ${chartBox('cGas', tr('Gas al giorno e temperatura esterna reale', 'Gas per day and real outdoor temperature'), tr('Barre rosse = riscaldamento, blu = acqua calda; la linea è la temperatura media esterna: più fa freddo, più salgono le barre rosse.', 'Red bars = heating, blue = hot water; the line is the mean outdoor temperature: the colder it is, the higher the red bars.'))}
  ${Object.keys(monthly).length ? `${sub(tr('Riepilogo mensile', 'Monthly summary'))}<div class="tw"><table><tr><th>${tr('Mese', 'Month')}</th><th>${tr('Riscald. m³', 'Heating m³')}</th><th>${tr('Acqua calda m³', 'Hot water m³')}</th><th>${tr('Totale m³', 'Total m³')}</th><th>${tr('Costo', 'Cost')}</th><th></th></tr>${monthRows}</table></div>` : ''}
  ${fc ? `${sub(tr('Previsione dei consumi', 'Consumption forecast'))}
  <p class="note">${tr('Stima basata sul meteo reale della tua zona (Open-Meteo) e su quanto gas usa la tua casa per ogni grado di freddo', 'Estimate based on the real weather in your area (Open-Meteo) and on how much gas your home uses for each degree of cold')}${fc.calibrated ? tr(', calibrata sui contatori annui della caldaia', ', calibrated on the boiler yearly counters') : ''}.</p>
  <div class="kpis">
  ${kpi(tr('Prossimi 30 giorni', 'Next 30 days'), ni(fc.m30), ' m³', forecastDays ? tr(`Usa le previsioni meteo dei prossimi ${forecastDays} giorni, poi le temperature dello stesso periodo dell’anno scorso.`, `Uses the forecast for the next ${forecastDays} days, then last year’s temperatures for the same period.`) : tr('Usa le temperature dello stesso periodo dell’anno scorso (previsioni non raggiungibili).', 'Uses last year’s temperatures for the same period (forecast not reachable).'), null, `≈ ${eur(fc.m30 * GAS_PRICE)}`)}
  ${kpi(tr('Stima annua', 'Yearly estimate'), fc.yr !== null ? ni(fc.yr) : naVal(tr('servono dati meteo', 'needs weather data')), fc.yr !== null ? ' m³' : '', tr('Consumo in un anno con il meteo degli ultimi 12 mesi.', 'Consumption over a year with the weather of the last 12 months.'), null, fc.yr !== null ? `≈ ${eur(fc.yr * GAS_PRICE)}` : '')}
  ${kpi(tr('Base acqua calda', 'Hot water base'), nf(fc.a, 2), tr(' m³/giorno', ' m³/day'), tr('Consumo di ogni giorno, anche senza riscaldamento.', 'Daily consumption, also without heating.'))}
  ${kpi(tr('Gas per grado-giorno', 'Gas per degree-day'), fc.b !== null ? nf(fc.b, 3) : '—', ' m³', tr(`Gas in più per ogni grado sotto i ${HDD_BASE} °C in un giorno.`, `Extra gas for each degree below ${HDD_BASE} °C in a day.`))}
  </div>
  ${ddPts.length >= 5 ? chartBox('cDD', tr('Gas al giorno in funzione della temperatura esterna', 'Daily gas versus outdoor temperature'), tr('Ogni punto è un giorno. La linea è il modello usato per la previsione: sopra i 16 °C resta solo l’acqua calda.', 'Each dot is a day. The line is the model used for the forecast: above 16 °C only hot water remains.')) : ''}
  ${!hasWeather ? `<p class="note warnline">${loc ? tr('Dati meteo non raggiungibili: la previsione non tiene conto del freddo in arrivo.', 'Weather data not reachable: the forecast ignores the coming cold.') : tr('Posizione dell’impianto sconosciuta: aggiungi --lat e --lon per usare il meteo.', 'Installation location unknown: add --lat and --lon to use the weather.')}</p>` : ''}` : ''}`);

const S_HEAT = section('heating', 'radiator', tr('Riscaldamento', 'Heating'),
  tr('Come ha lavorato il riscaldamento. Sono considerati solo i giorni in cui la caldaia ha davvero bruciato gas per scaldare casa.', 'How heating worked. Only days on which the boiler really burned gas to heat the house are considered.'),
  `${heat ? `<div class="kpis">
  ${kpi(tr('Giorni di riscaldamento', 'Heating days'), heat.days, '', tr('Giorni con almeno 0,3 m³ di gas per il riscaldamento.', 'Days with at least 0.3 m³ of heating gas.'))}
  ${kpi(tr('Temperatura stanze', 'Room temperature'), nf(heat.room), ' °C', tr('Media misurata dal termostato/sensore ambiente.', 'Average measured by the room thermostat/sensor.'), null, heat.roomNormal !== null && heat.roomReduced !== null ? tr(`di giorno ${nf(heat.roomNormal)} · di notte ${nf(heat.roomReduced)} °C`, `day ${nf(heat.roomNormal)} · night ${nf(heat.roomReduced)} °C`) : '')}
  ${kpi(tr('Temperatura impostata', 'Set temperature'), nf(heat.set), ' °C', tr('Media di quella richiesta dal programma (Normale di giorno, Ridotta di notte).', 'Average requested by the program (Normal by day, Reduced at night).'))}
  ${kpi(tr('Scarto', 'Difference'), sgn(heat.diff), ' °C', tr('Reale meno impostata. Tra −0,5 e +0,5 °C è perfetto.', 'Real minus set. Between −0.5 and +0.5 °C is perfect.'), Math.abs(heat.diff) <= 0.5 ? 'good' : Math.abs(heat.diff) <= 1 ? 'warn' : 'bad')}
  ${kpi(tr('Tempo in comfort', 'Time in comfort'), ni(heat.comfortPct), '%', tr('Quota di tempo con la temperatura entro ±1 °C da quella impostata.', 'Share of time within ±1 °C of the set temperature.'), heat.comfortPct >= 70 ? 'good' : heat.comfortPct >= 40 ? 'warn' : 'bad')}
  ${kpi(tr('Stabilità', 'Stability'), `±${nf(heat.stab)}`, ' °C', tr('Quanto oscilla la temperatura nella giornata. Sotto 0,5 °C è molto stabile.', 'How much the temperature swings during the day. Below 0.5 °C is very stable.'), heat.stab === null ? null : heat.stab < 0.5 ? 'good' : heat.stab < 1 ? 'warn' : 'bad')}
  ${kpi(tr('Mandata media', 'Average flow'), heat.flowN >= 5 ? nf(heat.flow) : naVal(tr('pochi dati', 'little data')), heat.flowN >= 5 ? ' °C' : '', tr('Temperatura dell’acqua mandata ai termosifoni con bruciatore acceso. Sotto 55 °C la caldaia condensa e rende di più.', 'Temperature of the water sent to the radiators with the burner on. Below 55 °C the boiler condenses and is more efficient.'), heat.flowN >= 5 ? (heat.flow < 55 ? 'good' : 'warn') : null, heat.flowMax !== null ? tr(`massima ${nf(heat.flowMax)} °C`, `max ${nf(heat.flowMax)} °C`) : '')}
  ${kpi(tr('Condensazione', 'Condensing'), heat.condPct !== null ? ni(heat.condPct) : '—', '%', tr('Quota del tempo di funzionamento con mandata sotto 55 °C.', 'Share of operating time with flow below 55 °C.'), heat.condPct === null ? null : heat.condPct >= 80 ? 'good' : heat.condPct >= 50 ? 'warn' : 'bad')}
  </div>
  ${sub(tr('Programmi usati nei giorni di riscaldamento', 'Programs used on heating days'))}${pctBars(heat.prog, heat.progN)}`
  : `<div class="empty">${icon('sun')}<p>${tr('Nel periodo la caldaia non ha bruciato gas per il riscaldamento (estate o riscaldamento spento). Scegli un periodo che comprenda l’inverno, per esempio 365 giorni, per vedere l’analisi completa. I consigli dell’assistente usano comunque i dati dell’ultima stagione di riscaldamento.', 'The boiler burned no heating gas in this period (summer or heating off). Choose a period that includes winter, e.g. 365 days, to see the full analysis. The assistant advice still uses the last heating season.')}</p></div>`}
  ${sub(tr('Curva climatica', 'Heating curve'))}
  ${chart.curve ? `<p class="note">${tr(`La linea arancione è la temperatura di mandata che la caldaia calcola in base alla temperatura esterna (pendenza <b>${nf(curve.slope, 1)}</b>, spostamento <b>${nf(curve.shift, 0)}</b>, ambiente ${nf(normalSet ?? 20, 0)} °C). I punti sono le mandate reali misurate con bruciatore acceso. Più la curva è alta, più la casa scalda e consuma.`, `The orange line is the flow temperature the boiler calculates from the outdoor temperature (slope <b>${nf(curve.slope, 1)}</b>, shift <b>${nf(curve.shift, 0)}</b>, room ${nf(normalSet ?? 20, 0)} °C). Dots are real flow readings with the burner on. The higher the curve, the warmer the house and the more gas it uses.`)}${curveAt(0) !== null ? ' ' + tr(`Con 0 °C fuori la caldaia punta a ${nf(curveAt(0), 0)} °C, con −5 °C a ${nf(curveAt(-5), 0)} °C.`, `At 0 °C outside the boiler aims at ${nf(curveAt(0), 0)} °C, at −5 °C at ${nf(curveAt(-5), 0)} °C.`) : ''}</p>${chartBox('cCurve', tr('Curva calcolata e mandate misurate', 'Calculated curve and measured flow'), '')}` : `<p class="note">${tr('Pendenza e spostamento non disponibili (esegui viessmann-explore-history.js oppure usa --curveSlope/--curveShift).', 'Slope and shift not available (run viessmann-explore-history.js or use --curveSlope/--curveShift).')}</p>`}`);

const S_BURNER = section('boiler', 'flame', tr('Caldaia e bruciatore', 'Boiler and burner'),
  tr('Quante volte la caldaia si è accesa e per quanto tempo. Poche accensioni lunghe sono l’ideale; molte accensioni brevi (“cicli brevi”) sprecano gas e usurano la caldaia.', 'How often the boiler started and for how long. Few long runs are ideal; many short runs (“short cycling”) waste gas and wear the boiler.'),
  burner ? `<div class="kpis">
  ${kpi(tr('Accensioni', 'Starts'), ni(burner.starts), '', tr('Accensioni del bruciatore nel periodo (contatore della caldaia).', 'Burner starts in the period (boiler counter).'))}
  ${kpi(tr('Accensioni al giorno', 'Starts per day'), nf(burner.perDay), '', tr('Media sull’intero periodo, acqua calda compresa.', 'Average over the whole period, hot water included.'), null, [burner.heatStartsPerDay !== null ? tr(`riscaldamento: ${ni(burner.heatStartsPerDay)}/g`, `heating: ${ni(burner.heatStartsPerDay)}/d`) : '', burner.warmStartsPerDay !== null ? tr(`solo acqua calda: ${ni(burner.warmStartsPerDay)}/g`, `hot water only: ${ni(burner.warmStartsPerDay)}/d`) : ''].filter(Boolean).join(' · '))}
  ${kpi(tr('Ore di fiamma', 'Burner hours'), ni(burner.hours), tr(' ore', ' h'), tr('Ore con il bruciatore acceso. Il contatore conta solo ore intere.', 'Hours with the burner on. The counter only counts whole hours.'), null, tr(`${nf(burner.runtimePct)}% del tempo`, `${nf(burner.runtimePct)}% of the time`))}
  ${kpi(tr('Durata media accensione', 'Average run length'), burner.cycleMin !== null ? nf(burner.cycleMin) : naVal(tr('servono ≥ 10 ore di fiamma', 'needs ≥ 10 burner hours')), burner.cycleMin !== null ? ' min' : '', tr('Minuti per accensione. Sotto 5 = cicli brevi; sopra 10 = ottimo. Con una caldaia combinata molte accensioni brevi sono prelievi di acqua calda.', 'Minutes per start. Below 5 = short cycling; above 10 = excellent. With a combi boiler many short runs are hot water draws.'), burner.cycleMin === null ? null : burner.cycleMin < 5 ? 'bad' : burner.cycleMin < 10 ? 'warn' : 'good')}
  ${kpi(tr('Potenza media erogata', 'Average output'), burner.avgKw !== null ? nf(burner.avgKw) : naVal(tr('pochi dati', 'little data')), burner.avgKw !== null ? ' kW' : '', tr('Energia del gas bruciato divisa per le ore di fiamma.', 'Energy of the gas burned divided by burner hours.'))}
  ${kpi(tr('Modulazione', 'Modulation'), modVals.length >= 20 ? ni(mean(modVals)) : naVal(tr(`pochi dati (${modVals.length})`, `little data (${modVals.length})`)), modVals.length >= 20 ? '%' : '', tr('Percentuale di potenza usata dal bruciatore. Il cloud Viessmann la aggiorna raramente: valore indicativo.', 'Share of burner power in use. The Viessmann cloud updates it rarely: indicative value.'), null, modVals.length >= 20 ? `min ${ni(Math.min(...modVals))}% · max ${ni(Math.max(...modVals))}%` : '')}
  ${kpi(tr('Dall’installazione', 'Since installation'), ni(burner.lifeStarts), tr(' accensioni', ' starts'), tr(`${ni(burner.lifeHours)} ore di fiamma in totale (${nf(burner.lifeHours ? burner.lifeStarts / burner.lifeHours : null, 1)} accensioni per ora di fiamma).`, `${ni(burner.lifeHours)} burner hours in total (${nf(burner.lifeHours ? burner.lifeStarts / burner.lifeHours : null, 1)} starts per burner hour).`))}
  </div>
  ${chartBox('cStarts', tr('Accensioni al giorno', 'Starts per day'), tr('La linea blu è la temperatura esterna reale: con il freddo le accensioni aumentano.', 'The blue line is the real outdoor temperature: starts rise with the cold.'))}
  ${startsOut.length >= 10 ? chartBox('cStartsOut', tr('Accensioni al giorno in funzione della temperatura esterna', 'Starts per day versus outdoor temperature'), tr('Ogni punto è un giorno.', 'Each dot is a day.'), 'small') : ''}
  ${ignitions.length ? `${sub(tr('Quando si accende la caldaia', 'When the boiler starts'))}<p class="note">${tr(`Accensioni registrate (${ni(ignitions.length)}) per giorno della settimana e ora. Più il colore è intenso, più accensioni.`, `Recorded starts (${ni(ignitions.length)}) by weekday and hour. The darker the colour, the more starts.`)}</p>
  <div class="hmap">${heatmap.map((row, i) => `<div class="hr"><span class="hd">${WEEK_L[i]}</span>${row.map((v, h) => `<span class="hc" style="--a:${v ? (0.12 + 0.88 * v / heatmapMax).toFixed(2) : 0}" title="${WEEK_L[i]} ${String(h).padStart(2, '0')}:00 — ${v}"></span>`).join('')}</div>`).join('')}<div class="hr hx"><span class="hd"></span>${Array.from({ length: 24 }, (_, h) => `<span>${h % 3 ? '' : String(h).padStart(2, '0')}</span>`).join('')}</div></div>` : ''}
  ${chart.mod ? chartBox('cMod', tr('Modulazione (solo letture nuove)', 'Modulation (new readings only)'), '', 'small') : ''}`
  : `<div class="empty">${icon('info')}<p>${tr('Dati dei contatori della caldaia non disponibili nel periodo.', 'Boiler counter data not available in the period.')}</p></div>`);

const S_DHW = dhw ? section('dhw', 'tap', tr('Acqua calda sanitaria', 'Domestic hot water'),
  dhw.instant ? tr('La tua caldaia scalda l’acqua quando apri il rubinetto (caldaia combinata o modalità Eco): per questo a riposo il sensore segna una temperatura bassa, ed è normale. Conta la temperatura massima raggiunta durante i prelievi.', 'Your boiler heats water when you open a tap (combi boiler or Eco mode): that is why the sensor reads a low temperature at rest, and that is normal. What matters is the peak temperature while in use.')
    : tr('La temperatura dell’acqua calda misurata dalla caldaia rispetto a quella impostata.', 'Hot water temperature measured by the boiler compared with the set temperature.'),
  `<div class="kpis">
  ${kpi(tr('Temperatura impostata', 'Set temperature'), nf(dhw.target, 0), ' °C', tr('Temperatura desiderata dell’acqua calda. 45–50 °C bastano per l’uso domestico.', 'Desired hot water temperature. 45–50 °C is enough for home use.'))}
  ${kpi(tr('Temperatura massima', 'Peak temperature'), nf(dhw.peak), ' °C', tr('La più alta registrata. Deve arrivare vicino all’obiettivo.', 'The highest reading. It should get close to the target.'), dhw.neverReached ? 'warn' : 'good')}
  ${kpi(tr('Temperatura media', 'Average temperature'), nf(dhw.avg), ' °C', dhw.instant ? tr('Temperatura a riposo del sensore: bassa è normale.', 'Sensor temperature at rest: low is normal.') : tr('Media con acqua calda attiva.', 'Average with hot water on.'))}
  ${!dhw.instant ? kpi(tr('Obiettivo raggiunto', 'Target reached'), ni(dhw.reachPct), '%', tr('Quota di letture a meno di 5 °C dall’obiettivo.', 'Share of readings within 5 °C of the target.')) : ''}
  ${kpi(tr('Gas per acqua calda', 'Hot water gas'), nf(dhw.gasPerDay, 2), tr(' m³/giorno', ' m³/day'), tr(`Circa ${eur(dhw.gasPerDay * 30 * GAS_PRICE)} al mese.`, `About ${eur(dhw.gasPerDay * 30 * GAS_PRICE)} per month.`))}
  </div>${sub(tr('Modalità', 'Modes'))}${pctBars(dhw.modes, dhw.n)}
  ${chartBox('cDhw', tr('Temperatura acqua calda (media oraria)', 'Hot water temperature (hourly average)'), tr('I picchi sono i momenti in cui si usa l’acqua calda.', 'Peaks are the moments hot water is used.'), 'small')}`) : '';

const S_HOUSE = fc && fc.b !== null ? section('house', 'house', tr('La casa', 'The house'),
  tr('Quanto calore perde la casa quando fuori fa freddo, calcolato dai consumi reali e dal meteo. Serve a capire se la caldaia è ben dimensionata e quanto renderebbe migliorare l’isolamento.', 'How much heat the house loses when it is cold outside, calculated from real consumption and weather. It shows whether the boiler is well sized and how much better insulation would pay off.'),
  `<div class="kpis">
  ${kpi(tr('Dispersione termica', 'Heat loss'), ni(fc.Hkw * 1000), ' W/°C', tr('Potenza persa per ogni grado di differenza tra dentro e fuori. Più è bassa, meglio è isolata la casa.', 'Power lost for each degree between inside and outside. The lower, the better insulated.'), houseClass?.[0], houseClass?.[1])}
  ${kpi(tr(`Potenza necessaria a ${nf(DESIGN_TEMP, 0)} °C`, `Heat needed at ${nf(DESIGN_TEMP, 0)} °C`), nf(fc.need), ' kW', DESIGN_AUTO ? tr(`Potenza che serve nei giorni più freddi della tua zona (${nf(DESIGN_TEMP, 0)} °C di media, ricavati dal meteo reale degli ultimi 12 mesi).`, `Power needed on the coldest days in your area (${nf(DESIGN_TEMP, 0)} °C mean, from the real weather of the last 12 months).`) : tr('Potenza che serve nella giornata più fredda di progetto.', 'Power needed on the coldest design day.'), BOILER_KW ? (BOILER_KW > fc.need * 3 ? 'warn' : 'good') : null, BOILER_KW ? tr(`caldaia: ${nf(BOILER_KW, 0)} kW`, `boiler: ${nf(BOILER_KW, 0)} kW`) : tr('inserisci i kW della caldaia per il confronto', 'enter the boiler kW to compare'))}
  ${kpi(tr('Riscaldamento in un anno', 'Heating per year'), fc.yrH !== null ? ni(fc.yrH) : '—', ' m³', tr('Gas per il solo riscaldamento con il meteo degli ultimi 12 mesi.', 'Heating-only gas with the weather of the last 12 months.'), null, fc.yrH !== null ? `≈ ${ni(fc.yrH * KWH_PER_M3)} kWh` : '')}
  ${fc.r2 !== null ? kpi(tr('Precisione del modello', 'Model accuracy'), ni(fc.r2 * 100), '%', tr('Quanto i consumi giornalieri seguono la temperatura esterna (R²). Sopra 70% il modello è affidabile.', 'How closely daily consumption follows the outdoor temperature (R²). Above 70% the model is reliable.'), fc.r2 >= 0.7 ? 'good' : 'warn') : ''}
  </div>`) : '';

const S_API = api ? section('api', 'bolt', tr('Contatori ufficiali Viessmann', 'Official Viessmann counters'),
  tr(`Valori letti direttamente dalla caldaia tramite le API Viessmann (aggiornati il ${new Date(api.ts).toLocaleString(LOCALE)}).`, `Values read directly from the boiler through the Viessmann API (updated ${new Date(api.ts).toLocaleString(LOCALE)}).`),
  `<div class="tw"><table class="api"><tr><th></th><th>${tr('7 giorni', '7 days')}</th><th>${tr('Questo mese', 'This month')}</th><th>${tr('Mese scorso', 'Last month')}</th><th>${tr('Quest’anno', 'This year')}</th></tr>
  ${[[tr('Gas riscaldamento (m³)', 'Heating gas (m³)'), api.gasH], [tr('Gas acqua calda (m³)', 'Hot water gas (m³)'), api.gasW], [tr('Calore riscaldamento (kWh)*', 'Heating heat (kWh)*'), api.heatH], [tr('Calore acqua calda (kWh)*', 'Hot water heat (kWh)*'), api.heatW], [tr('Elettricità riscaldamento (kWh)', 'Heating electricity (kWh)'), api.elH], [tr('Elettricità acqua calda (kWh)', 'Hot water electricity (kWh)'), api.elW]].map(([l, b]) => `<tr><td>${l}</td><td>${nf(b.d7)}</td><td>${nf(b.month)}</td><td>${nf(b.lastMonth)}</td><td><b>${nf(b.year)}</b></td></tr>`).join('')}
  </table></div><p class="note">${tr('* Il calore prodotto è una stima che la caldaia calcola dal gas: non è una misura, quindi non si può usare per calcolare il rendimento. Per questo il report non mostra il “rendimento termico”.', '* Heat produced is an estimate the boiler computes from gas: it is not a measurement, so it cannot be used to compute efficiency. That is why the report does not show “thermal efficiency”.')}</p>`) : '';

const S_ENERGY = energy ? section('energy', 'bolt', tr('Fotovoltaico, batteria e wallbox', 'Solar, battery and wallbox'), '',
  `<div class="kpis">${kpi(tr('Produzione FV media', 'Average PV output'), ni(energy.pv), ' W', '')}${kpi(tr('Picco FV', 'PV peak'), ni(energy.pvMax), ' W', '')}${energy.batt !== null ? kpi(tr('Batteria media', 'Average battery'), ni(energy.batt), '%', '') : ''}${energy.wall !== null ? kpi(tr('Wallbox media', 'Average wallbox'), ni(energy.wall), ' W', '') : ''}</div>${chart.energy ? chartBox('cEnergy', tr('Fotovoltaico e batteria', 'PV and battery'), '', 'small') : ''}`) : '';
const S_ROOMS = rooms.length ? section('rooms', 'house', tr('Stanze (termostati smart)', 'Rooms (smart thermostats)'), '', `<div class="kpis">${rooms.map(r => kpi(esc(r.k), nf(r.avg), ' °C', '')).join('')}</div>`) : '';

const msgType = (c) => /^F\./.test(c) ? 'f' : /^I\./.test(c) ? 'i' : 's';
const S_MSG = section('messages', 'msg', tr('Messaggi della caldaia', 'Boiler messages'),
  tr('La caldaia comunica cosa sta facendo con dei codici: <b>S.xx</b> = stato normale, <b>I.xx</b> = informazione, <b>F.xx</b> = guasto. I codici S sono normali e non richiedono nulla.', 'The boiler reports what it is doing with codes: <b>S.xx</b> = normal status, <b>I.xx</b> = information, <b>F.xx</b> = fault. S codes are normal and need no action.'),
  `${Object.keys(codeCount).length ? `<div class="chips">${Object.entries(codeCount).sort((a, b) => b[1] - a[1]).map(([c, n]) => `<span class="chip c-${msgType(c)}"><b>${esc(c)}</b> ${esc(codeText(c))} <em>×${n}</em></span>`).join('')}</div>` : ''}
  ${messages.length ? `<div class="msgs">${messages.slice(0, 15).map(m => `<div class="msg m-${msgType(m.code)}"><span class="c">${esc(m.code)}</span><span>${esc(codeText(m.code))}</span><span class="t">${new Date(m.t).toLocaleString(LOCALE)}</span></div>`).join('')}</div>` : `<p class="note">${tr('Nessun messaggio registrato.', 'No messages recorded.')}</p>`}`);

const GLOSS = [
  [tr('m³ e Smc', 'm³ and Smc'), tr('Metri cubi di gas. In bolletta trovi gli Smc (metri cubi “standard”): la differenza è di circa il 2%.', 'Cubic metres of gas. Italian bills use Smc (“standard” cubic metres): about 2% difference.')],
  [tr('Grado-giorno', 'Degree-day'), tr('Misura del freddo: se un giorno la media è 6 °C, con base 16 °C vale 10 gradi-giorno. Più gradi-giorno = più gas.', 'A measure of cold: a day with a 6 °C mean counts 10 degree-days with a 16 °C base. More degree-days = more gas.')],
  [tr('Mandata', 'Flow temperature'), tr('Temperatura dell’acqua che la caldaia manda ai termosifoni o al pavimento.', 'Temperature of the water the boiler sends to radiators or underfloor heating.')],
  [tr('Curva climatica', 'Heating curve'), tr('Regola che decide la mandata in base al freddo esterno. Pendenza = quanto sale quando fa più freddo; spostamento = alza o abbassa tutta la curva.', 'Rule that sets the flow temperature from the outdoor cold. Slope = how fast it rises as it gets colder; shift = moves the whole curve up or down.')],
  [tr('Sonda esterna', 'Outdoor sensor'), tr('Termometro della caldaia montato fuori casa: se è al sole o al caldo, la caldaia scalda male.', 'The boiler thermometer mounted outside: if it is in the sun or warm, the boiler heats badly.')],
  [tr('Condensazione', 'Condensing'), tr('Le caldaie moderne recuperano il calore del vapore nei fumi quando l’acqua di ritorno è sotto i 50–55 °C: rendono di più.', 'Modern boilers recover heat from the flue steam when return water is below 50–55 °C: they are more efficient.')],
  [tr('Modulazione', 'Modulation'), tr('La caldaia può bruciare a potenza ridotta invece di accendersi e spegnersi.', 'The boiler can burn at reduced power instead of switching on and off.')],
  [tr('Ciclo breve', 'Short cycling'), tr('Accensione di pochi minuti seguita da spegnimento: spreca gas e usura la caldaia.', 'A run of a few minutes followed by a stop: wastes gas and wears the boiler.')],
  [tr('Programmi', 'Programs'), tr('Normale = temperatura di giorno, Ridotta = notte o assenza, Comfort = temperatura extra (party o riscaldamento prolungato).', 'Normal = daytime temperature, Reduced = night or away, Comfort = extra temperature (party or extended heating).')],
  [tr('Dispersione termica', 'Heat loss'), tr('Watt che la casa perde per ogni grado di differenza tra dentro e fuori.', 'Watts the house loses for each degree between inside and outside.')],
  [tr('ACS', 'DHW'), tr('Acqua Calda Sanitaria: l’acqua di doccia e rubinetti.', 'Domestic Hot Water: shower and tap water.')],
];
const S_GLOSS = section('glossary', 'book', tr('Glossario', 'Glossary'), tr('Le parole tecniche usate nel report, spiegate in modo semplice.', 'The technical words used in this report, explained simply.'), `<dl class="gl">${GLOSS.map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('')}</dl>`);

const NAV = [['summary', tr('Riepilogo', 'Summary')], ['advice', tr('Consigli', 'Advice')], ['overview', tr('Andamento', 'Overview')], ['gas', tr('Gas', 'Gas')], ['heating', tr('Riscaldamento', 'Heating')], ['boiler', tr('Caldaia', 'Boiler')], dhw ? ['dhw', tr('Acqua calda', 'Hot water')] : null, S_HOUSE ? ['house', tr('Casa', 'House')] : null, api ? ['api', 'API'] : null, ['messages', tr('Messaggi', 'Messages')], ['glossary', tr('Glossario', 'Glossary')]].filter(Boolean);

const scoreLabels = { comfort: tr('Comfort', 'Comfort'), efficiency: tr('Efficienza', 'Efficiency'), boiler: tr('Caldaia', 'Boiler'), dhw: tr('Acqua calda', 'Hot water'), reliability: tr('Affidabilità', 'Reliability') };
const verdict = overall >= 80 ? tr('L’impianto lavora bene.', 'The system works well.') : overall >= 60 ? tr('L’impianto funziona, ma ci sono margini di miglioramento.', 'The system works, but there is room for improvement.') : tr('Ci sono alcune cose da sistemare.', 'A few things need fixing.');
const nImportant = advice.filter(a => a.prio === 'high' || a.prio === 'medium').length;

// ─── HTML ───────────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="${LANG}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${tr('Report impianto', 'Heating report')} ${todayIso}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js"></script>
<style>
:root{--bg:#eef1f7;--card:#fff;--ink:#141a2b;--mute:#5b6478;--line:#e3e7ef;--soft:#f6f8fc;--good:#12a150;--warn:#e58a00;--bad:#d92d20;--info:#5b6b85;--acc:#e2001a;--acc2:#ff5a36;--blue:#2f6fed;
--s-house1:#fff7ef;--s-house2:#ffe9d6;--s-ink:#20283b;--s-mute:#5b6478;--shadow:0 1px 2px rgba(16,24,40,.05),0 8px 24px -12px rgba(16,24,40,.15)}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--card:#141b2e;--ink:#e9edf6;--mute:#9aa4ba;--line:#26304a;--soft:#1a2238;--s-house1:#2a2230;--s-house2:#1f1a26;--s-ink:#e9edf6;--s-mute:#9aa4ba;--shadow:0 1px 2px rgba(0,0,0,.3)}}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font:16px/1.55 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
.ic{width:22px;height:22px;flex:none}
.hero{background:radial-gradient(1200px 400px at 85% -10%,#ff5a36 0,transparent 60%),linear-gradient(135deg,#1b0f2e 0%,#3a0d25 45%,#b3001b 100%);color:#fff;padding:34px 20px 38px}
.hero .in{max-width:1180px;margin:0 auto;display:flex;gap:28px;align-items:center;flex-wrap:wrap}
.hero h1{margin:0;font-size:clamp(26px,4vw,38px);letter-spacing:-.02em;line-height:1.15}
.hero .meta{opacity:.85;font-size:14px;margin-top:8px}.hero .verdict{font-size:18px;margin-top:14px;font-weight:600}
.hero .ht{flex:1 1 420px}.hero .score{display:flex;align-items:center;gap:18px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);border-radius:20px;padding:16px 22px}
.hero .score .slbl{font-size:13px;opacity:.8;text-transform:uppercase;letter-spacing:.08em}.hero .score b{font-size:15px;display:block;margin-top:4px;max-width:220px}
.hero .ring .rt{stroke:rgba(255,255,255,.18)}.hero .ring .rn{fill:#fff}
nav{position:sticky;top:0;z-index:20;background:var(--card);border-bottom:1px solid var(--line);box-shadow:0 4px 16px -12px rgba(0,0,0,.3)}
nav .in{max-width:1180px;margin:0 auto;display:flex;gap:6px;overflow-x:auto;padding:10px 16px;scrollbar-width:none}
nav a{white-space:nowrap;text-decoration:none;color:var(--mute);font-size:14px;font-weight:600;padding:6px 12px;border-radius:99px}nav a:hover{background:var(--soft);color:var(--ink)}
main{max-width:1180px;margin:0 auto;padding:0 16px 40px;position:relative}
section,.panel{background:var(--card);border-radius:20px;padding:24px;margin:18px 0;box-shadow:var(--shadow);border:1px solid var(--line);scroll-margin-top:70px}
.sh{display:flex;gap:14px;align-items:flex-start;margin-bottom:16px}.si{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,var(--acc),var(--acc2));color:#fff;flex:none}.si .ic{width:24px;height:24px}
h2{margin:0;font-size:22px;letter-spacing:-.01em}h3{font-size:17px;margin:26px 0 10px}h4{margin:2px 0 0;font-size:17px;line-height:1.35}
.intro{color:var(--mute);margin:4px 0 0;max-width:900px}.note{color:var(--mute);font-size:14px;margin:8px 0}.warnline{color:var(--warn)}
.schem{width:100%;height:auto;display:block;margin-top:6px}
.s-big{font-size:22px;font-weight:800;fill:var(--s-ink)}.s-sm{font-size:13px;fill:var(--s-mute)}.s-warn{fill:var(--warn)}
.s-line{stroke:var(--line);stroke-width:2}.s-roof{stroke:var(--acc);stroke-width:10;stroke-linecap:round;stroke-linejoin:round}
.s-tube{fill:var(--soft);stroke:var(--line);stroke-width:2}.s-rad{fill:#fff;stroke:#c9d2e3;stroke-width:3}.s-radl{stroke:#c9d2e3;stroke-width:3}
.s-heat path{fill:none;stroke:#ff7a45;stroke-width:3;stroke-linecap:round;opacity:0;animation:rise 2.4s infinite}
@keyframes rise{0%{opacity:0;transform:translateY(8px)}40%{opacity:.8}100%{opacity:0;transform:translateY(-10px)}}
.s-boiler{fill:#fff;stroke:#c9d2e3;stroke-width:3}.s-disp{fill:#0f172a}.s-dtxt{fill:#5eead4;font:700 13px ui-monospace,Menlo,monospace}
.s-flame{transform-box:fill-box;transform-origin:center bottom;animation:flick 1.6s ease-in-out infinite}@keyframes flick{50%{transform:scale(1.06,.93)}}
.s-pipe{fill:none;stroke-width:7;stroke-linecap:round;stroke-linejoin:round}.s-pipe.hot{stroke:#ef4444}.s-pipe.cold{stroke:#60a5fa}.s-pipe.gas{stroke:#f5b400;stroke-dasharray:10 6}
.s-tap path:first-child{fill:#94a3b8}.s-meter{fill:#0f172a}.s-mtxt{fill:#fde68a;font:700 16px ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){.s-rad,.s-boiler{fill:#1f2940;stroke:#3a4666}.s-radl{stroke:#3a4666}}
@media (prefers-reduced-motion:reduce){.s-heat path,.s-flame{animation:none}.s-heat path{opacity:.6}}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(138px,1fr));gap:12px;margin-top:18px}
.card{border-radius:16px;padding:14px 16px 14px 20px;background:var(--soft);border:1px solid var(--line);position:relative;overflow:hidden}
.card::before{content:"";position:absolute;inset:0 auto 0 0;width:5px;background:var(--info)}.card.good::before{background:var(--good)}.card.warn::before{background:var(--warn)}.card.bad::before{background:var(--bad)}
.card .ct{display:flex;gap:8px;align-items:center;color:var(--mute);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}.card .ct .ic{width:18px;height:18px}
.card .cval{font-size:26px;font-weight:800;margin:6px 0 2px;letter-spacing:-.02em}.card .cs{font-size:13px;color:var(--mute)}
.rings{display:flex;flex-wrap:wrap;gap:18px;justify-content:space-around;margin-top:20px;padding:16px;border-radius:16px;background:var(--soft)}
.ring{text-align:center}.ring .rt{fill:none;stroke:var(--line)}.ring .rv{fill:none;stroke-linecap:round}.ring .rn{font-weight:800;fill:var(--ink)}
.r-good .rv{stroke:var(--good)}.r-warn .rv{stroke:var(--warn)}.r-bad .rv{stroke:var(--bad)}.r-info .rv{stroke:var(--info)}.rl{font-size:13px;font-weight:700;color:var(--mute);margin-top:4px}
.bot{display:flex;gap:14px;align-items:flex-start;padding:16px 18px;border-radius:16px;background:linear-gradient(135deg,rgba(47,111,237,.10),rgba(226,0,26,.06));border:1px solid rgba(47,111,237,.25);margin-bottom:16px}
.bot .ic{width:34px;height:34px;color:var(--blue)}.bot p{margin:0}
.adv{border:1px solid var(--line);border-radius:18px;margin:14px 0;overflow:hidden;background:var(--card)}
.adv-h{display:flex;gap:14px;align-items:center;padding:16px 18px;background:var(--soft)}
.adv-i{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;color:#fff;background:var(--info);flex:none}.adv-i .ic{width:26px;height:26px}
.p-high .adv-i{background:linear-gradient(135deg,#d92d20,#ff6b3d)}.p-medium .adv-i{background:linear-gradient(135deg,#e58a00,#ffc043)}.p-low .adv-i{background:linear-gradient(135deg,#12a150,#4ade80)}.p-info .adv-i{background:linear-gradient(135deg,#2f6fed,#60a5fa)}
.adv-s{display:inline-flex;gap:6px;align-items:center;margin-top:6px;font-size:13px;color:var(--blue);background:rgba(47,111,237,.08);padding:4px 10px;border-radius:99px}.adv-s .ic{width:15px;height:15px}.adv-p{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--mute)}
.adv-b{display:grid;grid-template-columns:1.1fr 1fr}.adv-b>div{padding:14px 18px}.adv-do{border-left:1px solid var(--line)}
.adv-b p{margin:0}.adv-b ol{margin:0;padding-left:20px}.adv-b li{margin:6px 0}.lbl{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--acc);margin-bottom:6px}
.adv-f{display:flex;flex-wrap:wrap;gap:10px 22px;padding:12px 18px;border-top:1px solid var(--line);font-size:14px;color:var(--mute)}.adv-f span{display:flex;gap:6px;align-items:center}.adv-f .ic{width:18px;height:18px}.adv-f .save{color:var(--good)}
.pos{list-style:none;padding:0;margin:8px 0 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px}.pos li{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:12px;background:rgba(18,161,80,.08);font-size:15px}.pos .ic{color:var(--good);width:20px;height:20px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.kpi{border:1px solid var(--line);border-radius:14px;padding:14px 16px;background:var(--card)}
.kl{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mute);font-weight:700}.kv{font-size:28px;font-weight:800;margin:4px 0 2px;letter-spacing:-.02em;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 6px}.kv .b{align-self:center}
.kv small{font-size:15px;font-weight:600;color:var(--mute);margin-left:3px}.ks{font-size:13px;font-weight:600;color:var(--ink);opacity:.8}.kh{font-size:13.5px;color:var(--mute);margin-top:6px;line-height:1.45}
.na{color:var(--mute);font-size:15px;font-weight:600}
.b{white-space:nowrap;display:inline-block;font-size:11px;font-weight:800;padding:3px 9px;border-radius:99px;vertical-align:middle;color:#fff;letter-spacing:.03em;text-transform:uppercase}
.b-good{background:var(--good)}.b-warn{background:var(--warn)}.b-bad{background:var(--bad)}.b-info{background:var(--info)}
.chart{margin:20px 0 6px;padding:14px;border:1px solid var(--line);border-radius:16px;background:var(--card)}
.chart figcaption{font-weight:700;font-size:15px;display:flex;flex-direction:column;gap:4px;margin-bottom:8px}.how{font-weight:400;font-size:13.5px;color:var(--mute);display:flex;gap:6px;align-items:flex-start}.how .ic{width:16px;height:16px;margin-top:2px}
.cv{position:relative;height:300px}.chart.tall .cv{height:400px}.chart.small .cv{height:240px}
.tw{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:15px}th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}
th{color:var(--mute);font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
td.bar{width:28%;min-width:120px}td.bar span{display:inline-block;height:12px;vertical-align:middle}.bh{background:var(--acc);border-radius:6px 0 0 6px}.bw{background:var(--blue);border-radius:0 6px 6px 0}
.pbars{display:grid;gap:8px;max-width:640px}.pb{display:grid;grid-template-columns:110px 1fr 48px;gap:10px;align-items:center;font-size:14px}
.pbt{height:12px;border-radius:99px;background:var(--soft);overflow:hidden}.pbf{display:block;height:100%;border-radius:99px;background:var(--info)}
.f-normal,.f-comfort{background:var(--acc2)}.f-reduced{background:#94a3b8}.f-eco{background:var(--good)}.f-off{background:#cbd5e1}.pbp{text-align:right;font-weight:700}
.sched{width:100%;max-width:820px;height:auto}.sc-d,.sc-h{font-size:12px;fill:var(--mute)}.sc-red{fill:var(--soft);stroke:var(--line)}.sc-nor{fill:var(--acc2)}.sc-com{fill:var(--acc)}
.hmap{display:grid;gap:3px;max-width:820px;overflow-x:auto}.hr{display:grid;grid-template-columns:40px repeat(24,minmax(12px,1fr));gap:3px;align-items:center}
.hc{height:20px;border-radius:4px;background:rgba(229,90,0,var(--a));outline:1px solid var(--line);outline-offset:-1px}.hd{font-size:12px;color:var(--mute)}.hx span{font-size:11px;color:var(--mute)}
.empty{display:flex;gap:14px;align-items:center;padding:18px;border-radius:14px;background:var(--soft);color:var(--mute)}.empty .ic{width:34px;height:34px;color:var(--warn)}.empty p{margin:0}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}.chip{font-size:13px;padding:6px 10px;border-radius:99px;background:var(--soft);border:1px solid var(--line)}.chip em{color:var(--mute);font-style:normal}.c-f{border-color:var(--bad);background:rgba(217,45,32,.08)}
.msgs{display:grid;gap:6px}.msg{display:grid;grid-template-columns:70px 1fr auto;gap:10px;padding:9px 12px;border-radius:10px;background:var(--soft);font-size:14px}.msg .c{font-weight:800}.msg .t{color:var(--mute)}.m-f{background:rgba(217,45,32,.1)}
.gl{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin:0}.gl div{padding:12px 14px;border-radius:12px;background:var(--soft)}.gl dt{font-weight:800}.gl dd{margin:4px 0 0;color:var(--mute);font-size:14.5px}
.clamp{background:rgba(47,111,237,.1);color:var(--ink);border-radius:12px;padding:10px 14px;font-size:14px;margin:0 0 12px}
footer{text-align:center;color:var(--mute);font-size:13px;padding:10px 16px 30px}
@media (max-width:760px){.adv-b{grid-template-columns:1fr}.adv-do{border-left:0;border-top:1px solid var(--line)}section,.panel{padding:18px;border-radius:16px}.cv{height:260px}.chart.tall .cv{height:320px}.msg{grid-template-columns:56px 1fr}.msg .t{grid-column:2}}
@media print{nav{display:none}.hero{-webkit-print-color-adjust:exact;print-color-adjust:exact;padding-bottom:30px}main{margin-top:0}section{break-inside:avoid}}
</style></head><body>
<header class="hero"><div class="in">
 <div class="ht"><h1>${tr('Il tuo impianto di riscaldamento', 'Your heating system')}</h1>
 <div class="meta">${tr('Periodo', 'Period')}: <b>${fmtDate(localDay(startT))} – ${fmtDate(localDay(NOW))}</b> (${coveredDays} ${tr('giorni', 'days')}) · ${ni(sampleCount)} ${tr('letture', 'readings')} · ${tr('generato il', 'generated')} ${new Date().toLocaleString(LOCALE)}</div>
 <div class="verdict">${verdict}</div></div>
 <div class="score">${ring(overall, 110, '', 11)}<div><span class="slbl">${tr('Punteggio impianto', 'System score')}</span><b>${nImportant ? tr(`${nImportant} ${nImportant === 1 ? 'cosa' : 'cose'} da migliorare`, `${nImportant} thing${nImportant === 1 ? '' : 's'} to improve`) : tr('Nessun problema importante', 'No major issues')}${totalSave > 5 ? tr(` · risparmio possibile ≈ ${eur(totalSave)}/anno`, ` · possible saving ≈ ${eur(totalSave)}/year`) : ''}</b></div></div>
</div></header>
<nav><div class="in">${NAV.map(([id, l]) => `<a href="#${id}">${l}</a>`).join('')}</div></nav>
<main>
<div class="panel" id="summary">
 ${clamped ? `<p class="clamp">${tr(`Hai chiesto ${DAYS} giorni, ma i dati iniziano il ${fmtDate(localDay(firstDataT))}: il report copre ${coveredDays} giorni.`, `You asked for ${DAYS} days but data starts on ${fmtDate(localDay(firstDataT))}: the report covers ${coveredDays} days.`)}</p>` : ''}
 <div class="sh"><div class="si">${icon('house')}</div><div><h2>${tr('L’impianto in un colpo d’occhio', 'Your system at a glance')}</h2><p class="intro">${tr('Il disegno mostra i valori medi del periodo. Colori delle schede: verde = tutto bene, arancio = si può migliorare, rosso = da controllare, grigio = informazione. I cerchi sono i punteggi da 0 a 100.', 'The drawing shows the period averages. Card colours: green = all good, orange = can be improved, red = check it, grey = information. The circles are scores from 0 to 100.')}</p></div></div>
 ${schem}
 <div class="cards">${summaryCards.map(c => `<div class="card ${c.lvl}"><div class="ct">${icon(c.ic)} ${c.t}</div><div class="cval">${c.v}</div><div class="cs">${c.s}</div></div>`).join('')}</div>
 <div class="rings">${Object.entries(scores).filter(([, v]) => v !== null).map(([k, v]) => ring(v, 92, scoreLabels[k], 9)).join('')}</div>
</div>

<section id="advice"><div class="sh"><div class="si">${icon('bot')}</div><div><h2>${tr('Consigli dell’assistente', 'Assistant advice')}</h2><p class="intro">${tr('Ho analizzato i dati della caldaia, il meteo reale della tua zona e i contatori ufficiali. Ecco cosa ho notato, in ordine di importanza, con cosa fare e quanto puoi risparmiare.', 'I analysed the boiler data, the real weather in your area and the official counters. Here is what I noticed, by importance, with what to do and how much you can save.')}</p></div></div>
 ${advice.length ? `<div class="bot">${icon('bot')}<p>${tr(`Ho trovato <b>${advice.length}</b> ${advice.length === 1 ? 'suggerimento' : 'suggerimenti'}${totalSave > 5 ? `, per un risparmio stimato di circa <b>${eur(totalSave)} all’anno</b>` : ''}. Le stime usano il tuo consumo reale e il prezzo del gas di ${nf(GAS_PRICE, 2)} €/m³.`, `I found <b>${advice.length}</b> suggestion${advice.length === 1 ? '' : 's'}${totalSave > 5 ? `, for an estimated saving of about <b>${eur(totalSave)} a year</b>` : ''}. Estimates use your real consumption and a gas price of €${nf(GAS_PRICE, 2)}/m³.`)}</p></div>${adviceHtml}` : `<div class="bot">${icon('bot')}<p>${tr('Non ho trovato nulla da correggere nel periodo analizzato. Ottimo!', 'I found nothing to fix in the analysed period. Well done!')}</p></div>`}
 ${positives.length ? `${sub(tr('Cosa va bene', 'What is going well'))}<ul class="pos">${positives.map(p => `<li>${icon('check')}<span>${p}</span></li>`).join('')}</ul>` : ''}
</section>
${S_OVERVIEW}${S_GAS}${S_HEAT}${S_BURNER}${S_DHW}${S_HOUSE}${S_API}${S_ENERGY}${S_ROOMS}${S_MSG}${S_GLOSS}
</main>
<footer>${tr('Generato da homebridge-viessmann-vicare', 'Generated by homebridge-viessmann-vicare')} · ${esc(path.basename(CSV_FILE))}${loc ? ` · ${tr('meteo', 'weather')}: Open-Meteo.com` : ''}</footer>
<script>
const D=${JSON.stringify(chart)};
const L=${JSON.stringify({
  room: tr('Stanza', 'Room'), set: tr('Impostata', 'Set'), flow: tr('Mandata (bruciatore acceso)', 'Flow (burner on)'), sensor: tr('Sonda esterna caldaia', 'Boiler outdoor sensor'), real: tr('Esterna reale', 'Real outdoor'), dhw: tr('Acqua calda', 'Hot water'), ign: IGN_DAILY ? tr('Accensioni/giorno', 'Starts/day') : tr('Accensioni/ora', 'Starts/hour'),
  heat: tr('Riscaldamento', 'Heating'), dhwGas: tr('Acqua calda', 'Hot water'), tmean: tr('Temp. esterna media', 'Mean outdoor temp.'), day: tr('Giorni', 'Days'), model: tr('Modello', 'Model'),
  starts: tr('Accensioni', 'Starts'), calc: tr('Curva calcolata', 'Calculated curve'), meas: tr('Mandata misurata', 'Measured flow'), target: tr('Obiettivo', 'Target'), mod: tr('Modulazione', 'Modulation'),
  pv: tr('Fotovoltaico (W)', 'PV (W)'), batt: tr('Batteria (%)', 'Battery (%)'), outX: tr('Temperatura esterna (°C)', 'Outdoor temperature (°C)') })};
(function(){
if(!window.Chart){document.querySelectorAll('.chart').forEach(e=>e.style.display='none');return;}
const dark=matchMedia('(prefers-color-scheme: dark)').matches;
Chart.defaults.color=dark?'#9aa4ba':'#5b6478';Chart.defaults.borderColor=dark?'#26304a':'#e3e7ef';Chart.defaults.font.family='Inter,-apple-system,Segoe UI,Roboto,sans-serif';Chart.defaults.font.size=12.5;
Chart.defaults.plugins.legend.labels.usePointStyle=true;Chart.defaults.plugins.legend.position='bottom';Chart.defaults.maintainAspectRatio=false;
const zoom=window.ChartZoom?{zoom:{drag:{enabled:true,backgroundColor:'rgba(47,111,237,.15)'},mode:'x'},pan:{enabled:true,mode:'x',modifierKey:'shift'}}:undefined;
const time={type:'time',time:{tooltipFormat:'dd/MM/yyyy HH:mm',displayFormats:{hour:'HH:mm',day:'dd/MM',week:'dd/MM',month:'MMM yy'}},ticks:{maxRotation:0,autoSkipPadding:18}};
const grad=(ctx,c)=>{const g=ctx.createLinearGradient(0,0,0,ctx.canvas.height);g.addColorStop(0,c+'55');g.addColorStop(1,c+'00');return g;};
const mk=(id,cfg)=>{const el=document.getElementById(id);if(!el)return;const c=new Chart(el,cfg);el.addEventListener('dblclick',()=>c.resetZoom&&c.resetZoom());return c;};
const line=(label,data,color,extra)=>Object.assign({type:'line',label,data,borderColor:color,backgroundColor:color,pointRadius:0,borderWidth:2,tension:.25},extra||{});
mk('cOverview',{data:{datasets:[
  line(L.room,D.overview.room,'#12a150',{borderWidth:2.5}),line(L.set,D.overview.set,'#e5a000',{borderDash:[6,4],stepped:true,borderWidth:1.5,tension:0}),
  line(L.flow,D.overview.flow,'#ef4444',{borderWidth:1.2}),line(L.dhw,D.overview.dhw,'#a855f7',{borderWidth:1,hidden:true}),
  line(L.sensor,D.overview.sensor,'#94a3b8',{borderWidth:1}),line(L.real,D.overview.real,'#2f6fed',{pointRadius:3,borderWidth:2.5}),
  {type:'bar',label:L.ign,data:D.overview.ign,backgroundColor:'rgba(255,122,69,.45)',yAxisID:'y2',barThickness:3}]},
  options:{interaction:{mode:'nearest',axis:'x',intersect:false},scales:{x:time,y:{title:{display:true,text:'°C'}},y2:{position:'right',beginAtZero:true,grid:{display:false},title:{display:true,text:L.ign}}},plugins:{zoom}}});
mk('cGas',{data:{labels:D.gas.labels,datasets:[
  {type:'bar',label:L.heat,data:D.gas.h,backgroundColor:'#e2001a',stack:'g',borderRadius:3},{type:'bar',label:L.dhwGas,data:D.gas.w,backgroundColor:'#2f6fed',stack:'g',borderRadius:3},
  line(L.tmean,D.gas.t,'#0ea5e9',{yAxisID:'y2',pointRadius:1.5,borderWidth:1.5,spanGaps:true})]},
  options:{scales:{x:{stacked:true,ticks:{maxTicksLimit:12,maxRotation:0}},y:{stacked:true,beginAtZero:true,title:{display:true,text:'m³'}},y2:{position:'right',grid:{display:false},title:{display:true,text:'°C'}}}}});
if(D.dd.pts.length)mk('cDD',{data:{datasets:[{type:'scatter',label:L.day,data:D.dd.pts,backgroundColor:'rgba(226,0,26,.5)',pointRadius:3.5},D.dd.line?line(L.model,D.dd.line,'#2f6fed',{borderWidth:2.5,tension:0}):null].filter(Boolean)},
  options:{scales:{x:{type:'linear',title:{display:true,text:L.outX}},y:{beginAtZero:true,title:{display:true,text:'m³'}}},plugins:{tooltip:{callbacks:{label:c=>(c.raw.d?c.raw.d+': ':'')+c.raw.y+' m³ @ '+c.raw.x+' °C'}}}}});
if(D.curve)mk('cCurve',{data:{datasets:[line(L.calc,D.curve.line,'#ff7a45',{borderWidth:3,tension:.3}),{type:'scatter',label:L.meas,data:D.curve.pts,backgroundColor:'rgba(47,111,237,.45)',pointRadius:3}]},
  options:{scales:{x:{type:'linear',title:{display:true,text:L.outX}},y:{title:{display:true,text:'°C'}}}}});
if(D.starts)mk('cStarts',{data:{labels:D.starts.labels,datasets:[{type:'bar',label:L.starts,data:D.starts.v,backgroundColor:'#ff7a45',borderRadius:3},line(L.tmean,D.starts.t,'#2f6fed',{yAxisID:'y2',pointRadius:1.5,borderWidth:1.5,spanGaps:true})]},
  options:{scales:{x:{ticks:{maxTicksLimit:12,maxRotation:0}},y:{beginAtZero:true},y2:{position:'right',grid:{display:false},title:{display:true,text:'°C'}}}}});
if(D.startsOut.length)mk('cStartsOut',{type:'scatter',data:{datasets:[{label:L.starts,data:D.startsOut,backgroundColor:'rgba(255,122,69,.6)',pointRadius:3.5}]},options:{plugins:{legend:{display:false}},scales:{x:{type:'linear',title:{display:true,text:L.outX}},y:{beginAtZero:true,title:{display:true,text:L.starts}}}}});
if(D.mod)mk('cMod',{type:'scatter',data:{datasets:[{label:L.mod,data:D.mod,backgroundColor:'rgba(168,85,247,.6)',pointRadius:2.5}]},options:{plugins:{legend:{display:false},zoom},scales:{x:time,y:{beginAtZero:true,max:100,title:{display:true,text:'%'}}}}});
mk('cDhw',{data:{datasets:[line(L.dhw,D.dhw.t,'#ef4444',{borderWidth:1.5,fill:true,backgroundColor:c=>grad(c.chart.ctx,'#ef4444')}),line(L.target,D.dhw.s,'#e5a000',{borderDash:[6,4],stepped:true,tension:0,borderWidth:1.5})]},options:{scales:{x:time,y:{title:{display:true,text:'°C'}}},plugins:{zoom}}});
if(D.energy)mk('cEnergy',{data:{datasets:[line(L.pv,D.energy.pv,'#f5b400',{fill:true,backgroundColor:c=>grad(c.chart.ctx,'#f5b400')}),line(L.batt,D.energy.batt,'#12a150',{yAxisID:'y2'})]},options:{scales:{x:time,y:{beginAtZero:true},y2:{position:'right',min:0,max:100,grid:{display:false}}},plugins:{zoom}}});
})();
</script></body></html>`;

fs.writeFileSync(OUT_FILE, html, 'utf8');
console.log(`Report generated: ${OUT_FILE}`);
console.log(`Open in browser: file://${path.resolve(OUT_FILE)}`);
if (process.env.REPORT_DEBUG) console.error(JSON.stringify({ coveredDays, gasP, fc, sensorBias, heat: heat && { ...heat, curvePts: heat.curvePts.length }, burner: burner && { ...burner, dayMap: Object.keys(burner.dayMap).length }, scores, overall, advice: advice.map(a => [a.prio, a.title, a.save]), positives }, null, 1));
