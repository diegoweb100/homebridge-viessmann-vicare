#!/usr/bin/env node
/**
 * Viessmann Report Server
 * Serves a web UI to generate the Viessmann history report.
 *
 * Standalone:  node viessmann-report-server.js [--port 3001] [--path /var/lib/homebridge]
 * Via plugin:  started automatically if reportServerPort > 0 in plugin config.
 */
'use strict';

const http = require('http');
const path = require('path');
const fs   = require('fs');
const url  = require('url');
const { execFile } = require('child_process');

// ── CLI args ───────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 && args[i+1] ? args[i+1] : def; };
const PORT    = parseInt(getArg('--port',   process.env.REPORT_SERVER_PORT || '3001'), 10);
const HB_PATH = getArg('--path',   process.env.HB_PATH || '/var/lib/homebridge');
const SCRIPT  = getArg('--script', path.join(__dirname, 'viessmann-report.js'));

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
    return ids;
  } catch { return []; }
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

function generateReport(params) {
  return new Promise((resolve, reject) => {
    const tmpOut = path.join(HB_PATH, 'viessmann-report-web-' + Date.now() + '.html');
    const cliArgs = [SCRIPT, '--path', HB_PATH, '--days', String(params.days), '--out', tmpOut];
    if (params.installation) cliArgs.push('--installation', params.installation);
    if (params.boilerKW)     cliArgs.push('--boilerKW',    params.boilerKW);
    if (params.designTemp)   cliArgs.push('--designTemp',  params.designTemp);
    if (params.gasPrice)     cliArgs.push('--gasPriceEur', params.gasPrice);
    if (params.curveSlope)   cliArgs.push('--curveSlope',  params.curveSlope);
    if (params.curveShift !== undefined && params.curveShift !== '') cliArgs.push('--curveShift', params.curveShift);

    execFile(process.execPath, cliArgs, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr || err.message)); return; }
      try {
        const html = fs.readFileSync(tmpOut, 'utf8');
        try { fs.unlinkSync(tmpOut); } catch {}
        resolve(html);
      } catch (e) { reject(e); }
    });
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
@media(max-width:420px){.field-grid{grid-template-columns:1fr}}
.field label{display:block;font-size:11px;font-family:'Space Mono',monospace;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
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
#status.err{color:#f85149}
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

<div class="card">
  <div class="section-label">Installation</div>
  <div class="field">
    <label>Installation ID</label>
    <select id="installation">${instOptions}</select>
  </div>
</div>

<div class="card">
  <div class="adv-toggle" onclick="toggleAdv()">
    <span class="arr" id="arr">&#9654;</span>
    Advanced parameters (boiler &amp; gas)
  </div>
  <div id="adv-fields">
    <div class="field-grid">
      <div class="field">
        <label>Boiler nominal power</label>
        <input type="number" id="boilerKW" placeholder="e.g. 19" min="0" max="200" step="0.5">
        <div class="hint">kW — enables heat demand &amp; sizing</div>
      </div>
      <div class="field">
        <label>Design outdoor temp</label>
        <input type="number" id="designTemp" placeholder="-7" min="-30" max="10" step="1">
        <input type="number" id="curveSlope" placeholder="Curve slope (e.g. 1.3)" min="0.2" max="3.5" step="0.1" style="margin-top:6px">
        <input type="number" id="curveShift" placeholder="Curve shift (e.g. 6)" min="-13" max="40" step="1" style="margin-top:4px">
        <div class="hint">&#176;C — for peak load calculation</div>
      </div>
      <div class="field">
        <label>Gas price</label>
        <input type="number" id="gasPrice" placeholder="0.90" min="0" max="10" step="0.01">
        <div class="hint">&#8364;/m&#179; — for cost forecast</div>
      </div>
    </div>
  </div>
</div>

<button class="btn" id="gen-btn" onclick="generate()">Generate Report</button>
<div id="status"></div>
<footer>homebridge-viessmann-vicare &nbsp;·&nbsp; report server &nbsp;·&nbsp; ${HB_PATH}</footer>

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
  btn.disabled=true;
  status.className='loading';
  status.innerHTML='<span class="spinner"></span>Generating report&hellip;';
  const p=new URLSearchParams({days});
  if(installation)p.set('installation',installation);
  if(boilerKW)p.set('boilerKW',boilerKW);
  if(designTemp)p.set('designTemp',designTemp);
  if(curveSlope)p.set('curveSlope',curveSlope);
  if(curveShift)p.set('curveShift',curveShift);
  if(gasPrice)p.set('gasPrice',gasPrice);
  try{
    const res=await fetch('/report?'+p.toString());
    if(!res.ok){throw new Error(await res.text()||res.statusText);}
    const html=await res.text();
    const blob=new Blob([html],{type:'text/html'});
    window.open(URL.createObjectURL(blob),'_blank');
    status.className='ok';
    status.textContent='\u2713 Report opened in new tab';
  }catch(e){
    status.className='err';
    status.textContent='\u2717 '+e.message;
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
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', path: HB_PATH, port: PORT }));
    return;
  }

  if (pathname === '/' || pathname === '') {
    const html = buildUI(detectInstallations());
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
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

    const csvName = installation
      ? 'viessmann-history-' + installation + '.csv'
      : 'viessmann-history.csv';

    if (!fs.existsSync(path.join(HB_PATH, csvName))) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('CSV not found: ' + path.join(HB_PATH, csvName));
      return;
    }
    if (!fs.existsSync(SCRIPT)) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Report script not found: ' + SCRIPT);
      return;
    }

    try {
      const html = await generateReport({ days, installation, boilerKW, designTemp, gasPrice, curveSlope, curveShift });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error generating report:\n' + e.message);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ── Start ──────────────────────────────────────────────────────────────────

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('[Viessmann] Report server listening on http://0.0.0.0:' + PORT);
    console.log('[Viessmann] Data path: ' + HB_PATH);
    console.log('[Viessmann] Script:    ' + SCRIPT);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('[Viessmann] Port ' + PORT + ' already in use');
    } else {
      console.error('[Viessmann] Report server error:', err.message);
    }
  });
}

module.exports = { server, PORT };
