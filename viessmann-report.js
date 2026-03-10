#!/usr/bin/env node
/**
 * Viessmann History Report Generator
 * Reads viessmann-history.csv and generates a PDF report with charts.
 *
 * Usage:
 *   node /var/lib/homebridge/viessmann-report.js
 *   node /var/lib/homebridge/viessmann-report.js --days 7
 *   node /var/lib/homebridge/viessmann-report.js --days 30 --out /tmp/report.pdf
 *
 * Dependencies (install once):
 *   sudo npm install -g pdfkit
 */

'use strict';

const fs = require('fs');
const path = require('path');

// --- Parse CLI args ---
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const DAYS = parseInt(getArg('--days', '7'), 10);
const HB_PATH = getArg('--path', '/var/lib/homebridge');
const CSV_FILE = path.join(HB_PATH, 'viessmann-history.csv');
const today = new Date().toISOString().slice(0, 10);
const OUT_FILE = getArg('--out', path.join(HB_PATH, `viessmann-report-${today}.pdf`));

// --- Check dependencies ---
let PDFDocument;
try {
  PDFDocument = require('pdfkit');
} catch {
  console.error('\n❌ pdfkit not installed. Run:\n   sudo npm install -g pdfkit\n');
  process.exit(1);
}

// --- Read and parse CSV ---
if (!fs.existsSync(CSV_FILE)) {
  console.error(`❌ CSV not found: ${CSV_FILE}`);
  console.error('   Start Homebridge with the plugin to begin collecting data.');
  process.exit(1);
}

const lines = fs.readFileSync(CSV_FILE, 'utf8').trim().split('\n');
const headers = lines[0].split(',');
const rows = lines.slice(1).map(line => {
  const vals = line.split(',');
  const obj = {};
  headers.forEach((h, i) => { obj[h.trim()] = vals[i]?.trim() || ''; });
  return obj;
});

// Filter to requested days
const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - DAYS);
const filtered = rows.filter(r => r.timestamp && new Date(r.timestamp) >= cutoff);

if (filtered.length === 0) {
  console.error(`❌ No data in the last ${DAYS} days.`);
  process.exit(1);
}

console.log(`📊 Generating report for last ${DAYS} days (${filtered.length} data points)...`);

// --- Aggregate data ---
const boilerRows = filtered.filter(r => r.accessory === 'boiler');
const hcRows = filtered.filter(r => r.accessory === 'hc0');
const dhwRows = filtered.filter(r => r.accessory === 'dhw');

function toNum(v) { return parseFloat(v) || 0; }
function avg(arr, key) {
  const vals = arr.map(r => toNum(r[key])).filter(v => v > 0);
  return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : 'N/A';
}
function max(arr, key) {
  const vals = arr.map(r => toNum(r[key])).filter(v => v > 0);
  return vals.length ? Math.max(...vals).toFixed(1) : 'N/A';
}
function pct(arr, key, condition) {
  if (!arr.length) return 'N/A';
  const count = arr.filter(r => condition(r[key])).length;
  return ((count / arr.length) * 100).toFixed(0) + '%';
}

// Burner on/off cycles
const burnerOnPct = pct(boilerRows, 'burner_active', v => v === 'true');
const avgModulation = avg(boilerRows, 'modulation');
const maxModulation = max(boilerRows, 'modulation');
const avgRoomTemp = avg(hcRows, 'room_temp');
const avgTargetTemp = avg(hcRows, 'target_temp');
const avgDhwTemp = avg(dhwRows, 'dhw_temp');
const avgDhwTarget = avg(dhwRows, 'dhw_target');

// Burner starts from latest row
const latestBoiler = boilerRows[boilerRows.length - 1] || {};
const burnerStarts = latestBoiler.burner_starts || 'N/A';
const burnerHours = latestBoiler.burner_hours || 'N/A';
const startsPerHour = (burnerStarts !== 'N/A' && burnerHours !== 'N/A' && parseFloat(burnerHours) > 0)
  ? (parseFloat(burnerStarts) / parseFloat(burnerHours)).toFixed(2)
  : 'N/A';
const efficiency = startsPerHour !== 'N/A'
  ? (parseFloat(startsPerHour) < 2 ? '✅ Buona' : '⚠️ Alta ciclatura')
  : 'N/A';

// Program distribution
const programs = {};
hcRows.forEach(r => { if (r.program) programs[r.program] = (programs[r.program] || 0) + 1; });

// --- Draw simple ASCII chart for PDF ---
function sparkline(arr, key, width = 60) {
  const vals = arr.map(r => toNum(r[key]));
  if (!vals.length) return '(no data)';
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const steps = '▁▂▃▄▅▆▇█';
  return vals
    .filter((_, i) => i % Math.ceil(vals.length / width) === 0)
    .map(v => steps[Math.round(((v - min) / range) * (steps.length - 1))])
    .join('');
}

// --- Generate PDF ---
const doc = new PDFDocument({ margin: 40, size: 'A4' });
const stream = fs.createWriteStream(OUT_FILE);
doc.pipe(stream);

const W = 515; // page width minus margins

// Header
doc.fontSize(20).font('Helvetica-Bold')
  .text('Viessmann ViCare — Report Storico', { align: 'center' });
doc.fontSize(11).font('Helvetica')
  .text(`Periodo: ultimi ${DAYS} giorni  |  Generato: ${new Date().toLocaleString('it-IT')}`, { align: 'center' });
doc.moveDown();

// Divider
doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#cccccc').stroke();
doc.moveDown(0.5);

// Section helper
function section(title) {
  doc.moveDown(0.5);
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a1a2e').text(title);
  doc.fontSize(10).font('Helvetica').fillColor('#333333');
  doc.moveDown(0.3);
}

// Stat row helper
function stat(label, value, note = '') {
  doc.font('Helvetica-Bold').text(`${label}: `, { continued: true })
    .font('Helvetica').text(`${value}${note ? '  ' + note : ''}`);
}

// ── SEZIONE 1: CALDAIA ──
section('🔥 Caldaia — Bruciatore');
stat('Accensioni totali (lifetime)', burnerStarts);
stat('Ore funzionamento (lifetime)', burnerHours);
stat('Accensioni/ora', startsPerHour, `→ Efficienza: ${efficiency}`);
stat('Bruciatore attivo (nel periodo)', burnerOnPct + ' dei campioni');
stat('Modulazione media', avgModulation + '%');
stat('Modulazione massima', maxModulation + '%');

if (boilerRows.length > 5) {
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text('Modulazione nel tempo:');
  doc.font('Courier').fontSize(8).text(sparkline(boilerRows, 'modulation'));
  doc.fontSize(10).font('Helvetica');
}

// ── SEZIONE 2: RISCALDAMENTO ──
section('🌡️ Circuito Riscaldamento (HC0)');
stat('Temperatura ambiente media', avgRoomTemp + '°C');
stat('Setpoint medio', avgTargetTemp + '°C');

if (Object.keys(programs).length) {
  const total = Object.values(programs).reduce((a, b) => a + b, 0);
  const dist = Object.entries(programs)
    .map(([p, c]) => `${p}: ${((c / total) * 100).toFixed(0)}%`)
    .join('  |  ');
  stat('Distribuzione programmi', dist);
}

if (hcRows.length > 5) {
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text('Temperatura ambiente nel tempo:');
  doc.font('Courier').fontSize(8).text(sparkline(hcRows, 'room_temp'));
  doc.fontSize(10).font('Helvetica');
}

// ── SEZIONE 3: ACS ──
section('🚿 Acqua Calda Sanitaria (ACS)');
stat('Temperatura media', avgDhwTemp + '°C');
stat('Setpoint medio', avgDhwTarget + '°C');

if (dhwRows.length > 5) {
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text('Temperatura ACS nel tempo:');
  doc.font('Courier').fontSize(8).text(sparkline(dhwRows, 'dhw_temp'));
  doc.fontSize(10).font('Helvetica');
}

// ── NOTE ──
doc.moveDown();
doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#cccccc').stroke();
doc.moveDown(0.5);
doc.fontSize(9).fillColor('#888888')
  .text(`Dati da: ${CSV_FILE}  |  Campioni totali nel periodo: ${filtered.length}  |  homebridge-viessmann-vicare`);

doc.end();

stream.on('finish', () => {
  console.log(`✅ Report generato: ${OUT_FILE}`);
});
stream.on('error', err => {
  console.error(`❌ Errore scrittura PDF: ${err.message}`);
});
