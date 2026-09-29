'use strict';
/**
 * Viessmann dashboard (homebridge-viessmann-vicare 2.0.81+)
 *
 * One web page on the OAuth port (redirectPort, default 4200) that replaces the separate
 * auth status page (4200) and report server (3001):
 *   - Viessmann login / token status (the OAuth callback stays on "/")
 *   - API usage and collected data
 *   - report generation (background jobs) and saved reports with automatic expiry
 *   - flue gas analyses: add / edit / delete, due dates
 *
 * Mounted by src/auth-manager.ts: the auth server calls handle() for every request it does
 * not serve itself, and page() for "/" when there is no OAuth code in the URL.
 *
 * Write requests (POST/PUT/DELETE on /api) must carry the header "X-Vicare-Dashboard: 1":
 * browsers cannot add it from another site without a CORS preflight, which this server
 * never allows, so other web pages cannot change data on your LAN (CSRF protection).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ASSET_DIR = path.join(__dirname, 'dashboard');
const NAME_RE = /^report-[\w-]+\.html$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NUM_FIELDS = ['co2', 'o2', 'lambda', 'co', 'coUndiluted', 'flueTemp', 'airTemp', 'efficiency', 'losses', 'nox', 'dewPoint'];

function createDashboard(opts) {
  const hbPath = opts.hbPath;
  const reportScript = opts.reportScript || path.join(__dirname, 'viessmann-report.js');
  const log = opts.log || { info() {}, warn() {}, debug() {}, error() {} };
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutSec) || 600, 120), 3600) * 1000;
  const retentionDays = Math.max(1, Number(opts.retentionDays) || 30);
  const reportsDir = path.join(hbPath, 'viessmann-reports');
  const combFile = path.join(hbPath, 'viessmann-combustion.json');
  const jobs = new Map();

  // ── helpers ────────────────────────────────────────────────────────────────
  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
  const writeJson = (f, obj) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8'); fs.renameSync(tmp, f); };
  const body = (req) => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 65536) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
  const num = (v) => { if (v === '' || v === null || v === undefined) return null; const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
  const langOf = (req) => /^it\b/i.test(String(req.headers['accept-language'] || '')) ? 'it' : 'en';

  // ── data sources ───────────────────────────────────────────────────────────
  function installations() {
    let files = [];
    try { files = fs.readdirSync(hbPath); } catch { return []; }
    return files.map(f => f.match(/^viessmann-history(?:-(\d+))?\.csv$/)).filter(Boolean).map(m => {
      const st = fs.statSync(path.join(hbPath, m[0]));
      // Heating curve as read from the boiler (explore file written by the plugin)
      let curve = null;
      const ex = readJson(path.join(hbPath, `viessmann-history-explore-${m[1] || 'all'}.json`), null);
      for (const dev of Object.values((ex && ex.devices) || {})) {
        const hc = dev.heatingCircuits || {}, c = hc['0'] || hc[Object.keys(hc)[0]];
        if (c && typeof c.slope === 'number') { curve = { slope: c.slope, shift: c.shift ?? 0 }; break; }
      }
      return { id: m[1] || '', file: m[0], sizeKB: Math.round(st.size / 1024), updated: st.mtime.toISOString(), curve };
    });
  }
  function apiStatus() {
    const d = readJson(path.join(hbPath, 'viessmann-api-status.json'), null);
    if (!d) return null;
    d.ageSec = Math.round((Date.now() - new Date(d.timestamp).getTime()) / 1000);
    return d;
  }

  // ── flue gas analyses ──────────────────────────────────────────────────────
  function combustion() {
    const c = readJson(combFile, null) || {};
    return {
      nominalPowerKW: c.nominalPowerKW ?? null,
      efficiencyCheckYears: c.efficiencyCheckYears ?? 4,
      maintenanceMonths: c.maintenanceMonths ?? 12,
      lastMaintenance: c.lastMaintenance ?? null,
      deletedDates: Array.isArray(c.deletedDates) ? c.deletedDates : [],
      tests: (Array.isArray(c.tests) ? c.tests : []).filter(t => DATE_RE.test(String(t.date || '').slice(0, 10))).sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
  function saveCombustion(c) { c.updated = new Date().toISOString(); writeJson(combFile, c); }
  function cleanTest(t) {
    const date = String(t.date || '').slice(0, 10);
    if (!DATE_RE.test(date) || isNaN(new Date(date + 'T12:00:00'))) throw new Error('date');
    const out = { date };
    for (const k of NUM_FIELDS) { const v = num(t[k]); if (v !== null) out[k] = v; }
    for (const k of ['technician', 'notes']) if (t[k]) out[k] = String(t[k]).slice(0, 200);
    if (out.co2 === undefined && out.o2 === undefined && out.co === undefined && out.efficiency === undefined) throw new Error('values');
    return out;
  }
  function combSummary() {
    const c = combustion();
    if (!c.tests.length) return { ...c, last: null };
    const last = c.tests[c.tests.length - 1];
    const addM = (ds, m) => { const d = new Date(ds + 'T12:00:00'); d.setMonth(d.getMonth() + m); return d.toISOString().slice(0, 10); };
    const days = (ds) => Math.round((new Date(ds + 'T12:00:00') - Date.now()) / 86400000);
    const base = [last.date, c.lastMaintenance].filter(x => DATE_RE.test(String(x || ''))).sort().pop();
    const nextCheck = addM(last.date, 12 * c.efficiencyCheckYears), nextMaint = addM(base, c.maintenanceMonths);
    return { ...c, last, nextCheck, nextMaint, daysCheck: days(nextCheck), daysMaint: days(nextMaint) };
  }
  /** Settings imported from the plugin config (older setups): added once, never overriding the dashboard. */
  function importFromConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return 0;
    const c = combustion(); let n = 0;
    for (const t of Array.isArray(cfg.tests) ? cfg.tests : []) {
      try {
        const x = cleanTest(t);
        if (!c.tests.some(y => y.date === x.date) && !c.deletedDates.includes(x.date)) { c.tests.push(x); n++; }
      } catch { /* invalid entry ignored */ }
    }
    for (const k of ['nominalPowerKW', 'efficiencyCheckYears', 'maintenanceMonths', 'lastMaintenance']) {
      if (cfg[k] !== undefined && cfg[k] !== null && !fs.existsSync(combFile)) c[k] = cfg[k];
    }
    if (n || !fs.existsSync(combFile) && Object.keys(cfg).length) { c.tests.sort((a, b) => a.date.localeCompare(b.date)); saveCombustion(c); }
    return n;
  }

  // ── reports ────────────────────────────────────────────────────────────────
  function listReports() {
    let files = [];
    try { files = fs.readdirSync(reportsDir); } catch { return []; }
    const now = Date.now(), out = [];
    for (const f of files) {
      if (!NAME_RE.test(f)) continue;
      const p = path.join(reportsDir, f);
      const meta = readJson(p.replace(/\.html$/, '.json'), {});
      const st = fs.statSync(p);
      const created = meta.created ? new Date(meta.created).getTime() : st.mtimeMs;
      const expires = created + retentionDays * 86400000;
      if (expires < now) { // expired: removed automatically
        try { fs.unlinkSync(p); fs.rmSync(p.replace(/\.html$/, '.json'), { force: true }); } catch { /* ignore */ }
        continue;
      }
      out.push({ file: f, created: new Date(created).toISOString(), expires: new Date(expires).toISOString(), sizeKB: Math.round(st.size / 1024), days: meta.days ?? null, lang: meta.lang ?? null, installation: meta.installation ?? '' });
    }
    return out.sort((a, b) => b.created.localeCompare(a.created));
  }
  function startReport(p) {
    const days = Math.round(Math.min(Math.max(num(p.days) ?? 7, 1), 3650));
    const inst = /^\d*$/.test(String(p.installation || '')) ? String(p.installation || '') : '';
    const csv = path.join(hbPath, inst ? `viessmann-history-${inst}.csv` : 'viessmann-history.csv');
    if (!fs.existsSync(csv)) throw new Error(`CSV not found: ${path.basename(csv)}`);
    if ([...jobs.values()].filter(j => j.status === 'running').length >= 2) throw new Error('busy');
    fs.mkdirSync(reportsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const file = `report-${inst || 'default'}-${days}d-${stamp}.html`;
    const out = path.join(reportsDir, file);
    const args = [reportScript, '--path', hbPath, '--days', String(days), '--out', out + '.part', '--lang', p.lang === 'en' ? 'en' : 'it'];
    if (inst) args.push('--installation', inst);
    const opt = { boilerKW: '--boilerKW', designTemp: '--designTemp', gasPrice: '--gasPriceEur', elPrice: '--elPriceEur', curveSlope: '--curveSlope', curveShift: '--curveShift' };
    for (const [k, flag] of Object.entries(opt)) { const v = num(p[k]); if (v !== null) args.push(flag, String(v)); }
    const id = crypto.randomBytes(6).toString('hex');
    const job = { id, status: 'running', started: Date.now(), file, error: null };
    jobs.set(id, job);
    log.info(`📊 Report requested from the dashboard: ${days} days${inst ? ` (installation ${inst})` : ''}`);
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let errTxt = '';
    child.stderr.on('data', (d) => { if (errTxt.length < 20000) errTxt += d; });
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => { job.error = `timeout after ${timeoutMs / 1000}s`; child.kill('SIGTERM'); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      job.finished = Date.now();
      if (code === 0 && fs.existsSync(out + '.part')) {
        fs.renameSync(out + '.part', out);
        writeJson(out.replace(/\.html$/, '.json'), { created: new Date().toISOString(), days, lang: p.lang === 'en' ? 'en' : 'it', installation: inst });
        job.status = 'done';
        log.info(`📊 Report ready (${((job.finished - job.started) / 1000).toFixed(0)} s): ${file}`);
      } else {
        fs.rmSync(out + '.part', { force: true });
        job.status = 'error';
        job.error = job.error || (errTxt.trim().split('\n').slice(-6).join('\n') || `exit code ${code}`);
        log.warn(`📊 Report failed: ${job.error.split('\n')[0]}`);
      }
      setTimeout(() => jobs.delete(id), 15 * 60000);
    });
    return job;
  }

  // ── page ───────────────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function page(req, auth) {
    const lang = langOf(req);
    const boot = { lang, version: opts.pluginVersion || '', retentionDays, auth: authView(auth) };
    return `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Viessmann ViCare</title><link rel="stylesheet" href="/assets/app.css"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23f97316' d='M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3-1-3 0-6 1-9z'/%3E%3C/svg%3E">
</head><body><div id="app"></div>
<script id="boot" type="application/json">${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>
<script src="/assets/app.js"></script></body></html>`;
  }
  function authView(auth) {
    if (!auth) return null;
    const s = auth.status || {};
    return {
      state: auth.state, authUrl: auth.authUrl || null, username: auth.username || '', method: auth.method || 'auto', redirectUri: auth.redirectUri || '',
      expiresInSeconds: s.expiresInSeconds ?? null, hasRefreshToken: !!s.hasRefreshToken, refreshTokenExpiresInDays: s.refreshTokenExpiresInDays ?? null,
    };
  }

  // ── router ─────────────────────────────────────────────────────────────────
  async function handle(req, res, url, getAuth) {
    const p = url.pathname, m = (req.method || 'GET').toUpperCase();
    try {
      if (p.startsWith('/assets/') && m === 'GET') {
        const f = p === '/assets/app.js' ? 'app.js' : p === '/assets/app.css' ? 'app.css' : null;
        if (!f) return false;
        send(res, 200, fs.readFileSync(path.join(ASSET_DIR, f)), f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
        return true;
      }
      if (p.startsWith('/reports/') && m === 'GET') {
        const f = p.slice('/reports/'.length);
        if (!NAME_RE.test(f) || !fs.existsSync(path.join(reportsDir, f))) { send(res, 404, 'Report not found (expired or deleted)', 'text/plain; charset=utf-8'); return true; }
        send(res, 200, fs.readFileSync(path.join(reportsDir, f)), 'text/html; charset=utf-8');
        return true;
      }
      if (!p.startsWith('/api/')) return false;
      if (m !== 'GET' && req.headers['x-vicare-dashboard'] !== '1') { send(res, 403, { error: 'missing dashboard header' }); return true; }

      if (p === '/api/status' && m === 'GET') {
        let curve = null; try { curve = opts.curve ? opts.curve.status() : null; } catch { /* tuner not ready */ }
        send(res, 200, { auth: authView(getAuth ? getAuth() : null), api: apiStatus(), installations: installations(), reports: listReports(), combustion: combSummary(), curve, retentionDays, version: opts.pluginVersion || '' });
        return true;
      }
      if (p === '/api/reports' && m === 'GET') { send(res, 200, listReports()); return true; }
      if (p === '/api/reports' && m === 'POST') {
        try { const j = startReport(await body(req)); send(res, 202, { id: j.id }); } catch (e) { send(res, e.message === 'busy' ? 429 : 400, { error: e.message }); }
        return true;
      }
      if (p === '/api/reports/job' && m === 'GET') {
        const j = jobs.get(String(url.searchParams.get('id') || ''));
        send(res, j ? 200 : 404, j ? { status: j.status, file: j.file, error: j.error, elapsed: Math.round(((j.finished || Date.now()) - j.started) / 1000) } : { error: 'unknown job' });
        return true;
      }
      if (p.startsWith('/api/reports/') && m === 'DELETE') {
        const f = decodeURIComponent(p.slice('/api/reports/'.length));
        if (!NAME_RE.test(f)) { send(res, 400, { error: 'name' }); return true; }
        fs.rmSync(path.join(reportsDir, f), { force: true }); fs.rmSync(path.join(reportsDir, f.replace(/\.html$/, '.json')), { force: true });
        send(res, 200, { ok: true }); return true;
      }
      if (p === '/api/curve/restore' && m === 'POST') {
        if (!opts.curve) { send(res, 404, { error: 'not available' }); return true; }
        const b = await body(req);
        try { send(res, 200, await opts.curve.restore(String(b.installationId || ''), Number(b.circuit) || 0)); } catch (e) { send(res, 400, { error: e.message }); }
        return true;
      }
      if (p === '/api/combustion' && m === 'GET') { send(res, 200, combSummary()); return true; }
      if (p === '/api/combustion' && m === 'POST') {
        const b = await body(req);
        let t; try { t = cleanTest(b); } catch (e) { send(res, 400, { error: e.message }); return true; }
        const c = combustion();
        const orig = String(b.originalDate || '');
        c.tests = c.tests.filter(x => x.date !== t.date && x.date !== orig);
        c.tests.push(t); c.tests.sort((a, x) => a.date.localeCompare(x.date));
        c.deletedDates = c.deletedDates.filter(d => d !== t.date);
        saveCombustion(c);
        log.info(`🔥 Flue gas analysis of ${t.date} saved from the dashboard`);
        send(res, 200, combSummary()); return true;
      }
      if (p === '/api/combustion/settings' && m === 'PUT') {
        const b = await body(req), c = combustion();
        c.nominalPowerKW = num(b.nominalPowerKW);
        c.efficiencyCheckYears = Math.round(Math.min(Math.max(num(b.efficiencyCheckYears) ?? 4, 1), 10));
        c.maintenanceMonths = Math.round(Math.min(Math.max(num(b.maintenanceMonths) ?? 12, 1), 60));
        c.lastMaintenance = DATE_RE.test(String(b.lastMaintenance || '')) ? b.lastMaintenance : null;
        saveCombustion(c); send(res, 200, combSummary()); return true;
      }
      if (p.startsWith('/api/combustion/') && m === 'DELETE') {
        const d = decodeURIComponent(p.slice('/api/combustion/'.length));
        if (!DATE_RE.test(d)) { send(res, 400, { error: 'date' }); return true; }
        const c = combustion();
        c.tests = c.tests.filter(x => x.date !== d);
        if (!c.deletedDates.includes(d)) c.deletedDates.push(d);
        saveCombustion(c);
        log.info(`🔥 Flue gas analysis of ${d} deleted from the dashboard`);
        send(res, 200, combSummary()); return true;
      }
      send(res, 404, { error: 'not found' });
      return true;
    } catch (e) {
      log.warn(`Dashboard error on ${m} ${p}: ${e.message}`);
      send(res, 500, { error: e.message });
      return true;
    }
  }

  return { handle, page, importFromConfig, listReports };
}

module.exports = { createDashboard };
