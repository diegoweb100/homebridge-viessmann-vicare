#!/usr/bin/env node
/**
 * Viessmann Report Server
 * Serves a web UI to generate the Viessmann history report.
 *
 * Standalone:  node viessmann-report-server.js [--port 3001] [--path /var/lib/homebridge] [--debug]
 * Via plugin:  started automatically if reportServerPort > 0 in plugin config.
 *              --debug is passed automatically when plugin config has debug:true
 *
 * Changes in v2.0.67:
 *   - Always log actual LAN IP (not localhost / 0.0.0.0)
 *   - Report generation timeout raised to 300 s (was 60 s) — fixes timeout with large CSV (90+ days)
 *   - Comprehensive debug logging via --debug flag (forwarded from plugin when debug:true)
 *   - Full stderr included in HTTP error response so the UI shows the real cause
 *   - Request timing logged in debug mode
 */
'use strict';

const http   = require('http');
const path   = require('path');
const fs     = require('fs');
const url    = require('url');
const os     = require('os');
const { execFile, spawn } = require('child_process');

// ── CLI args ───────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 && args[i+1] ? args[i+1] : def; };

const PORT    = parseInt(getArg('--port',    process.env.REPORT_SERVER_PORT || '3001'), 10);
const HB_PATH = getArg('--path',    process.env.HB_PATH || '/var/lib/homebridge');
const SCRIPT  = getArg('--script',  path.join(__dirname, 'viessmann-report.js'));
const DEBUG   = args.includes('--debug') || process.env.DEBUG_REPORT === '1';
// --timeout <seconds> passed from plugin config (reportServerTimeout, default 300)
const TIMEOUT_SEC = parseInt(getArg('--timeout', '300'), 10);

// ── Debug logger ───────────────────────────────────────────────────────────
function dbg(...parts) {
  if (DEBUG) console.log('[ReportServer]', ...parts);
}

function dbgSection(title) {
  if (DEBUG) console.log('[ReportServer] ─────────────────────────────── ' + title);
}

// ── Local IP detection ─────────────────────────────────────────────────────
function detectLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of (nets[name] || [])) {
      if (iface.family === 'IPv4' && !iface.internal) {
        dbg(`Detected LAN IP: ${iface.address} (interface: ${name})`);
        return iface.address;
      }
    }
  }
  dbg('Could not detect LAN IP — falling back to localhost');
  return 'localhost';
}

const LAN_IP = detectLocalIP();

// ── Helpers ────────────────────────────────────────────────────────────────

function detectInstallations() {
  try {
    const files = fs.readdirSync(HB_PATH);
    const ids = [];
    for (const f of files) {
      const m = f.match(/^viessmann-history-(\d+)\.csv$/);
      if (m) ids.push(m[1]);
    }
    if (files.includes('viessmann-history.csv')) ids.push('');
    dbg(`Detected installations: [${ids.join(', ') || 'none'}]`);
    return ids;
  } catch (e) {
    dbg(`detectInstallations error: ${e.message}`);
    return [];
  }
}

function numParam(val, def, min, max) {
  const n = parseFloat(val);
  if (isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function safeNum(val) {
  if (!val) return '';
  return String(val).replace(/[^0-9.\-]/g, '');
}

// ── Report generation ──────────────────────────────────────────────────────
// NOTE ON TIMEOUT: viessmann-report.js is CPU-intensive when processing large
// CSV files (e.g. 90 days = ~26 000 rows). The default 60 s was insufficient.
// Raised to 300 s (5 minutes) which comfortably handles the largest datasets.

const REPORT_TIMEOUT_MS = Math.min(Math.max(TIMEOUT_SEC, 60), 1800) * 1000; // from --timeout arg (clamped 60–1800s)

function generateReport(params) {
  return new Promise((resolve, reject) => {
    const tmpOut   = path.join(HB_PATH, 'viessmann-report-web-' + Date.now() + '.html');
    const cliArgs  = [
      SCRIPT,
      '--path',         HB_PATH,
      '--days',         String(params.days),
      '--out',          tmpOut,
    ];
    if (params.installation) cliArgs.push('--installation', params.installation);
    if (params.boilerKW)     cliArgs.push('--boilerKW',    params.boilerKW);
    if (params.designTemp)   cliArgs.push('--designTemp',  params.designTemp);
    if (params.gasPrice)     cliArgs.push('--gasPriceEur', params.gasPrice);
    if (params.curveSlope)   cliArgs.push('--curveSlope',  params.curveSlope);
    if (params.curveShift !== undefined && params.curveShift !== '')
      cliArgs.push('--curveShift', params.curveShift);
    if (params.lang)         cliArgs.push('--lang',        params.lang);

    const t0 = Date.now();
    dbgSection('generateReport');
    dbg(`Node binary: ${process.execPath}`);
    dbg(`Script:      ${SCRIPT}`);
    dbg(`Output:      ${tmpOut}`);
    dbg(`Parameters:  days=${params.days} installation=${params.installation||'(default)'} boilerKW=${params.boilerKW||'-'} lang=${params.lang||'en'}`);
    dbg(`Full CLI:    node ${cliArgs.join(' ')}`);
    dbg(`Timeout:     ${REPORT_TIMEOUT_MS / 1000}s`);

    // Verify the CSV exists before even spawning the child process
    const csvName = params.installation
      ? `viessmann-history-${params.installation}.csv`
      : 'viessmann-history.csv';
    const csvPath = path.join(HB_PATH, csvName);
    if (!fs.existsSync(csvPath)) {
      dbg(`CSV not found: ${csvPath}`);
      return reject(new Error(`CSV file not found: ${csvPath}`));
    }
    const csvStat = fs.statSync(csvPath);
    dbg(`CSV file: ${csvPath} (${(csvStat.size / 1024).toFixed(1)} KB, ${csvStat.mtime.toISOString()})`);

    execFile(
      process.execPath,
      cliArgs,
      {
        timeout:   REPORT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 10 MB for stdout/stderr (HTML goes to file, not stdout)
      },
      (err, stdout, stderr) => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

        if (DEBUG) {
          if (stdout && stdout.trim()) dbg(`[child stdout]\n${stdout.trim()}`);
          if (stderr && stderr.trim()) dbg(`[child stderr]\n${stderr.trim()}`);
        }

        if (err) {
          const isTimeout = err.killed || err.signal === 'SIGTERM' || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          const label     = isTimeout
            ? `Timeout after ${elapsed}s (limit: ${REPORT_TIMEOUT_MS / 1000}s)`
            : `Failed after ${elapsed}s (exit code ${err.code})`;

          dbg(`ERROR: ${label}`);
          dbg(`  err.message: ${err.message}`);

          // Build a rich error message that includes stderr so the UI can show real cause
          const detail = stderr ? stderr.trim() : err.message;
          reject(new Error(`${label}\n${detail}`));
          return;
        }

        dbg(`Child process completed in ${elapsed}s`);

        // Read the generated HTML file
        if (!fs.existsSync(tmpOut)) {
          dbg(`ERROR: output file not created: ${tmpOut}`);
          reject(new Error(`Report script completed but output file was not created.\nstdout: ${stdout}`));
          return;
        }

        const stat = fs.statSync(tmpOut);
        dbg(`Output file: ${tmpOut} (${(stat.size / 1024).toFixed(1)} KB)`);

        try {
          const html = fs.readFileSync(tmpOut, 'utf8');
          try { fs.unlinkSync(tmpOut); dbg(`Temp file deleted`); } catch (unlinkErr) {
            dbg(`Could not delete temp file: ${unlinkErr.message}`);
          }
          resolve(html);
        } catch (readErr) {
          dbg(`ERROR reading output file: ${readErr.message}`);
          reject(readErr);
        }
      }
    );
  });
}

// ── UI HTML ────────────────────────────────────────────────────────────────

function buildUI(installations) {
  const today = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
  const instOptions = installations.length === 0
    ? '<option value="">No CSV found — check path</option>'
    : installations.map(id =>
        '<option value="' + id + '">' + (id ? 'Installation ' + id : 'Default (no ID)') + '</option>'
      ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Viessmann Report</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#0d1117;--surface:#161b22;--border:#21262d;--accent:#f97316;--accent2:#fb923c;--text:#e6edf3;--muted:#7d8590;--good:#3fb950;--r:10px}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Syne',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 16px 60px}
header{text-align:center;margin-bottom:40px}
.logo{display:inline-flex;align-items:center;gap:10px;margin-bottom:10px}
.logo svg{width:36px;height:36px}
header h1{font-size:clamp(22px,5vw,34px);font-weight:800;letter-spacing:-.5px}
header h1 span{color:var(--accent)}
header p{color:var(--muted);font-size:13px;margin-top:6px;font-family:'Space Mono',monospace}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:26px 28px;width:100%;max-width:560px}
.card+.card{margin-top:14px}
.section-label{font-family:'Space Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:2px;color:var(--accent);margin-bottom:14px}
.presets{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}
.preset{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 6px;font-family:'Space Mono',monospace;font-size:11px;color:var(--muted);cursor:pointer;text-align:center;transition:all .15s;user-select:none}
.preset:hover,.preset.active{border-color:var(--accent);color:var(--accent);background:rgba(249,115,22,.08)}
.preset .n{font-size:20px;font-weight:700;color:var(--text);display:block;margin-bottom:2px}
.preset.active .n{color:var(--accent)}
.custom-row{display:flex;align-items:center;gap:10px}
.custom-row label{font-size:12px;color:var(--muted);white-space:nowrap;font-family:'Space Mono',monospace}
input,select{background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:'Space Mono',monospace;font-size:13px;padding:9px 12px;width:100%;transition:border-color .15s;appearance:none;-webkit-appearance:none}
input:focus,select:focus{outline:none;border-color:var(--accent)}
.custom-row input{max-width:80px}
.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:560px){.field-grid{grid-template-columns:1fr}}
.field{margin-bottom:0}
.field label{display:block;font-size:11px;font-family:'Space Mono',monospace;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.field+.field{margin-top:14px}
.hint{font-size:10px;color:var(--muted);margin-top:4px;opacity:.7}
.adv-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;font-family:'Space Mono',monospace;color:var(--muted);user-select:none;transition:color .15s}
.adv-toggle:hover{color:var(--text)}
.arr{transition:transform .2s;display:inline-block}
.arr.open{transform:rotate(90deg)}
#adv-fields{display:none;margin-top:16px}
#adv-fields.visible{display:block}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;max-width:560px;padding:16px;background:var(--accent);border:none;border-radius:var(--r);color:#fff;font-family:'Syne',sans-serif;font-size:16px;font-weight:700;cursor:pointer;transition:background .15s,transform .1s;margin-top:16px}
.btn:hover{background:var(--accent2)}
.btn:active{transform:scale(.98)}
.btn:disabled{background:var(--border);color:var(--muted);cursor:not-allowed;transform:none}
#status{width:100%;max-width:560px;margin-top:12px;font-family:'Space Mono',monospace;font-size:12px;text-align:center;min-height:18px}
#status.loading{color:var(--accent)}
#status.ok{color:var(--good)}
#status.err{color:#f85149;white-space:pre-wrap;text-align:left;background:rgba(248,81,73,.08);border-radius:6px;padding:10px 14px}
@keyframes spin{to{transform:rotate(360deg)}}
.spinner{display:inline-block;width:13px;height:13px;border:2px solid rgba(249,115,22,.3);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px}
footer{margin-top:36px;font-family:'Space Mono',monospace;font-size:10px;color:var(--muted);text-align:center;opacity:.4}
</style>
</head>
<body>
<header>
  <div class="logo">
    <svg viewBox="0 0 36 36" fill="none">
      <circle cx="18" cy="18" r="17" stroke="#f97316" stroke-width="2"/>
      <path d="M11 24L18 10L25 24" stroke="#f97316" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <path d="M13.5 19.5H22.5" stroke="#f97316" stroke-width="2" stroke-linecap="round"/>
    </svg>
    <h1>Viessmann <span>ViCare</span></h1>
  </div>
  <p>History Report Generator &nbsp;·&nbsp; ${today}</p>
</header>

<!-- 1. Period -->
<div class="card">
  <div class="section-label">Period</div>
  <div class="presets">
    <div class="preset active" data-days="7"  onclick="setDays(7,this)"><span class="n">7</span>days</div>
    <div class="preset"        data-days="14" onclick="setDays(14,this)"><span class="n">14</span>days</div>
    <div class="preset"        data-days="30" onclick="setDays(30,this)"><span class="n">30</span>days</div>
    <div class="preset"        data-days="90" onclick="setDays(90,this)"><span class="n">90</span>days</div>
  </div>
  <div class="custom-row">
    <label>Custom:</label>
    <input type="number" id="days-input" value="7" min="1" max="365" oninput="onCustom(this)">
    <label>days</label>
  </div>
</div>

<!-- 2. Installation -->
<div class="card">
  <div class="section-label">Installation</div>
  <div class="field">
    <label>Installation ID</label>
    <select id="installation">${instOptions}</select>
  </div>
</div>

<!-- 3. Language always visible + Advanced collapsed -->
<div class="card">
  <div class="field" style="margin-bottom:14px">
    <label>Language</label>
    <select id="lang">
      <option value="en">🌐 English</option>
      <option value="it">🇮🇹 Italiano</option>
    </select>
  </div>
  <div class="adv-toggle" onclick="toggleAdv()">
    <span class="arr" id="arr">&#9654;</span>
    Advanced parameters (boiler &amp; gas)
  </div>
  <div id="adv-fields">
    <div class="field-grid" style="margin-top:16px">
      <div class="field">
        <label>Boiler nominal power</label>
        <input type="number" id="boilerKW" placeholder="e.g. 25" min="0" max="200" step="0.5">
        <div class="hint">kW — enables heat demand &amp; sizing</div>
      </div>
      <div class="field">
        <label>Design outdoor temp</label>
        <input type="number" id="designTemp" placeholder="-7" min="-30" max="10" step="1">
        <div class="hint">&#176;C — for peak load calculation</div>
      </div>
      <div class="field">
        <label>Heating curve slope</label>
        <input type="number" id="curveSlope" placeholder="e.g. 1.3" min="0.2" max="3.5" step="0.1">
        <div class="hint">e.g. 1.3 — from ViCare app</div>
      </div>
      <div class="field">
        <label>Heating curve shift</label>
        <input type="number" id="curveShift" placeholder="e.g. 6" min="-13" max="40" step="1">
        <div class="hint">e.g. 6 — from ViCare app</div>
      </div>
      <div class="field">
        <label>Gas price</label>
        <input type="number" id="gasPrice" placeholder="0.90" min="0" max="10" step="0.01">
        <div class="hint">&#8364;/m&#179; — for cost forecast</div>
      </div>
    </div>
  </div>
</div>

<button class="btn" id="gen-btn" onclick="generate()">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
  Generate Report
</button>
<div id="status"></div>
<footer>homebridge-viessmann-vicare &nbsp;·&nbsp; report server &nbsp;·&nbsp; ${HB_PATH} &nbsp;·&nbsp; ${LAN_IP}:${PORT}</footer>

<script>
let currentDays = 7;
function setDays(d,el){currentDays=d;document.getElementById('days-input').value=d;document.querySelectorAll('.preset').forEach(p=>p.classList.remove('active'));if(el)el.classList.add('active');}
function onCustom(el){currentDays=parseInt(el.value)||7;document.querySelectorAll('.preset').forEach(p=>{p.classList.toggle('active',parseInt(p.dataset.days)===currentDays);});}
function toggleAdv(){document.getElementById('adv-fields').classList.toggle('visible');document.getElementById('arr').classList.toggle('open');}
async function generate(){
  const btn=document.getElementById('gen-btn'),status=document.getElementById('status');
  const days=parseInt(document.getElementById('days-input').value)||7;
  const installation=document.getElementById('installation').value;
  const boilerKW=document.getElementById('boilerKW').value.trim();
  const designTemp=document.getElementById('designTemp').value.trim();
  const curveSlope=document.getElementById('curveSlope').value.trim();
  const curveShift=document.getElementById('curveShift').value.trim();
  const gasPrice=document.getElementById('gasPrice').value.trim();
  const lang=document.getElementById('lang').value;
  btn.disabled=true;
  status.className='loading';
  status.innerHTML='<span class="spinner"></span>Generating report — please wait (large datasets may take up to 2 min)&hellip;';
  const p=new URLSearchParams({days});
  if(installation)p.set('installation',installation);
  if(boilerKW)p.set('boilerKW',boilerKW);
  if(designTemp)p.set('designTemp',designTemp);
  if(curveSlope)p.set('curveSlope',curveSlope);
  if(curveShift!=='')p.set('curveShift',curveShift);
  if(gasPrice)p.set('gasPrice',gasPrice);
  if(lang)p.set('lang',lang);
  try{
    const res=await fetch('/report?'+p.toString());
    if(!res.ok){
      const errText=await res.text();
      throw new Error(errText||res.statusText);
    }
    const html=await res.text();
    const blob=new Blob([html],{type:'text/html'});
    window.open(URL.createObjectURL(blob),'_blank');
    status.className='ok';
    status.textContent='\u2713 Report opened in new tab';
  }catch(e){
    status.className='err';
    status.textContent='\u2717 Error: '+e.message;
  }finally{
    btn.disabled=false;
  }
}
</script>
</body>
</html>`;
}

// ── HTTP Server ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const t0      = Date.now();
  const parsed  = url.parse(req.url, true);
  const pathname = parsed.pathname;

  dbg(`→ ${req.method} ${req.url}`);

  if (pathname === '/health') {
    const body = JSON.stringify({
      status: 'ok',
      path:   HB_PATH,
      port:   PORT,
      lanIP:  LAN_IP,
      script: SCRIPT,
      scriptExists: fs.existsSync(SCRIPT),
      installations: detectInstallations(),
      debug:  DEBUG,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    dbg(`← 200 /health (${Date.now()-t0}ms)`);
    return;
  }

  if (pathname === '/' || pathname === '') {
    const installations = detectInstallations();
    const html = buildUI(installations);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    dbg(`← 200 / (${Date.now()-t0}ms, ${installations.length} installation(s))`);
    return;
  }

  if (pathname === '/report') {
    const q            = parsed.query;
    const days         = Math.round(numParam(q.days, 7, 1, 365));
    const installation = (q.installation || '').replace(/[^0-9]/g, '');
    const boilerKW     = safeNum(q.boilerKW);
    const designTemp   = safeNum(q.designTemp);
    const curveSlope   = safeNum(q.curveSlope);
    const curveShift   = q.curveShift !== undefined ? safeNum(q.curveShift) : undefined;
    const gasPrice     = safeNum(q.gasPrice);
    const lang         = (q.lang || 'en').replace(/[^a-z]/g, '').slice(0, 5);

    dbg(`/report params: days=${days} installation=${installation||'(default)'} boilerKW=${boilerKW||'-'} designTemp=${designTemp||'-'} lang=${lang}`);

    const csvName = installation
      ? 'viessmann-history-' + installation + '.csv'
      : 'viessmann-history.csv';
    const csvPath = path.join(HB_PATH, csvName);

    if (!fs.existsSync(csvPath)) {
      const msg = 'CSV not found: ' + csvPath;
      dbg('ERROR: ' + msg);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(msg);
      return;
    }
    if (!fs.existsSync(SCRIPT)) {
      const msg = 'Report script not found: ' + SCRIPT;
      dbg('ERROR: ' + msg);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(msg);
      return;
    }

    try {
      const html = await generateReport({ days, installation, boilerKW, designTemp, gasPrice, curveSlope, curveShift, lang });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      dbg(`← 200 /report (${Date.now()-t0}ms, ${(html.length/1024).toFixed(0)} KB)`);
    } catch (e) {
      const msg = e.message || String(e);
      dbg(`← 500 /report error (${Date.now()-t0}ms): ${msg.split('\n')[0]}`);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Error generating report:\n' + msg);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
  dbg(`← 404 ${pathname}`);
});

// ── Start ──────────────────────────────────────────────────────────────────

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('[ReportServer] ═══════════════════════════════════════════════');
    console.log('[ReportServer] Viessmann ViCare Report Server');
    console.log('[ReportServer] ═══════════════════════════════════════════════');
    console.log(`[ReportServer] 🌐 Open from any device: http://${LAN_IP}:${PORT}`);
    console.log(`[ReportServer] 📁 Data path:            ${HB_PATH}`);
    console.log(`[ReportServer] ⏱️  Report timeout:       ${REPORT_TIMEOUT_MS/1000}s (--timeout ${TIMEOUT_SEC}s)`);
    if (DEBUG) {
      console.log(`[ReportServer] 🔍 Debug mode:           ON`);
      console.log(`[ReportServer]    Script:   ${SCRIPT}`);
      console.log(`[ReportServer]    Node:     ${process.execPath} (${process.version})`);
      console.log(`[ReportServer]    Platform: ${process.platform} ${os.arch()}`);
      console.log(`[ReportServer]    PID:      ${process.pid}`);
    }
    console.log('[ReportServer] ═══════════════════════════════════════════════');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[ReportServer] ERROR: Port ${PORT} is already in use`);
    } else {
      console.error(`[ReportServer] ERROR: ${err.message}`);
    }
  });
}

module.exports = { server, PORT, LAN_IP };
