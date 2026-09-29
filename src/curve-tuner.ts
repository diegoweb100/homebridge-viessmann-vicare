/**
 * Automatic heating-curve optimisation (features.curveAutoTune, off by default) — 2.0.81
 *
 * Every `curveAutoTuneIntervalHours` (default 24, min 12) it looks at the last 48 hours of the
 * history CSV the plugin already writes and compares the room temperature with the temperature
 * the program asks for, only while the time schedule is on Normal/Comfort (the first 2 hours
 * after a switch are skipped: the house is still warming up).
 *
 *   room too warm by > 0.5 °C  → lower the curve        room too cold by > 0.5 °C → raise it
 *   error larger in cold weather (outdoor < 5 °C) than in mild weather → change the slope (±0.1)
 *   otherwise (same error at any outdoor temperature)                     → change the shift (±1)
 *
 * Safety:
 *   - one small step per evaluation, then at least 48 h to see the effect (24 h if the house is
 *     too cold, so comfort comes back sooner)
 *   - never further than ±0.3 slope / ±3 shift from the curve found when it was switched on
 *     (the "baseline", restorable from the dashboard)
 *   - only on heating days (heating gas used, outdoor below 15 °C, circuit heating, no holiday);
 *     outside the heating season it only reads the local history: no API call, nothing written
 *   - every change is logged with its reason and kept in viessmann-curve-tuner.json
 */
import * as fs from 'fs';
import * as path from 'path';

interface Target { installationId: number; gatewaySerial: string; deviceId: string; circuit: number }
interface Curve { slope: number; shift: number }
interface TunerState {
  baseline?: Curve & { date: string };
  lastChange?: string;
  lastEval?: string;
  lastResult?: string;
  history: Array<{ ts: string; from: Curve; to: Curve; reason: string; auto: boolean }>;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

export class CurveTuner {
  private targets: Target[] = [];
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private readonly interval: number;
  private readonly maxSlope: number;
  private readonly maxShift: number;

  constructor(private readonly platform: any, private readonly dataDir: string, private readonly enabled: boolean) {
    const f = platform.config?.features || {};
    this.interval = Math.max(12, Number(f.curveAutoTuneIntervalHours) || 24) * 3600 * 1000;
    this.maxSlope = Math.min(Math.max(Number(f.curveAutoTuneMaxSlopeDelta) || 0.3, 0.1), 1);
    this.maxShift = Math.min(Math.max(Math.round(Number(f.curveAutoTuneMaxShiftDelta) || 3), 1), 10);
  }

  private stateFile(t: Target) { return path.join(this.dataDir, `viessmann-curve-tuner-${t.installationId}-hc${t.circuit}.json`); }
  private readState(t: Target): TunerState {
    try { return { history: [], ...JSON.parse(fs.readFileSync(this.stateFile(t), 'utf8')) }; } catch { return { history: [] }; }
  }
  private writeState(t: Target, s: TunerState) {
    s.history = s.history.slice(-50);
    fs.writeFileSync(this.stateFile(t), JSON.stringify(s, null, 2), 'utf8');
  }

  register(t: Target) {
    if (this.targets.some(x => x.installationId === t.installationId && x.circuit === t.circuit)) return;
    this.targets.push(t);
    if (!this.enabled) return;
    if (!this.timer) {
      this.first = setTimeout(() => this.runAll(), 10 * 60 * 1000);
      this.timer = setInterval(() => this.runAll(), this.interval);
      this.platform.log.info(`🌡️ Automatic heating-curve optimisation ON: checks every ${Math.round(this.interval / 3600000)} h on heating days only ` +
        `(steps 0.1 slope / 1 shift, max ±${this.maxSlope} / ±${this.maxShift} from the starting curve)`);
    }
  }

  stop() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  /** Summary for the dashboard. */
  status() {
    return {
      enabled: this.enabled, intervalHours: Math.round(this.interval / 3600000), maxSlope: this.maxSlope, maxShift: this.maxShift,
      circuits: this.targets.map(t => ({ installationId: String(t.installationId), circuit: t.circuit, ...this.readState(t), ...(this.idle.get(`${t.installationId}-${t.circuit}`) || {}) })),
    };
  }

  private async runAll() {
    for (const t of this.targets) {
      try { await this.evaluate(t); } catch (e: any) { this.platform.log.warn(`🌡️ Heating-curve optimisation HC${t.circuit}: ${e?.message || e}`); }
    }
  }

  private async readCurve(t: Target): Promise<{ curve: Curve; mode: string; holiday: boolean; limits: { sMin: number; sMax: number; hMin: number; hMax: number } } | null> {
    const api = this.platform.viessmannAPI;
    api.clearCache?.(`/features/installations/${t.installationId}`);
    const feats: any[] = await api.getDeviceFeatures(t.installationId, t.gatewaySerial, t.deviceId);
    const hc = `heating.circuits.${t.circuit}`;
    const c = feats.find(f => f.feature === `${hc}.heating.curve`);
    if (!c?.commands?.setCurve) return null;
    const p = c.commands.setCurve.params || {};
    return {
      curve: { slope: c.properties?.slope?.value, shift: c.properties?.shift?.value },
      mode: feats.find(f => f.feature === `${hc}.operating.modes.active`)?.properties?.value?.value || '',
      holiday: !!(feats.find(f => f.feature === 'heating.operating.programs.holiday')?.properties?.active?.value ||
                  feats.find(f => f.feature === 'heating.operating.programs.holidayAtHome')?.properties?.active?.value),
      limits: {
        sMin: p.slope?.constraints?.min ?? 0.2, sMax: p.slope?.constraints?.max ?? 3.5,
        hMin: p.shift?.constraints?.min ?? -13, hMax: p.shift?.constraints?.max ?? 40,
      },
    };
  }

  /** Last 48 h from the history CSV: room vs requested temperature while Normal/Comfort is in force. */
  analyse(t: Target, now = Date.now()) {
    const file = path.join(this.dataDir, `viessmann-history-${t.installationId}.csv`);
    const txt = fs.readFileSync(file, 'utf8');
    const lines = txt.split('\n');
    const head = lines[0].split(',');
    const ix = (n: string) => head.indexOf(n);
    const I = { ts: ix('timestamp'), acc: ix('accessory'), ev: ix('event_type'), room: ix('room_temp'), tgt: ix('target_temp'), out: ix('outside_temp'), prog: ix('program'), mode: ix('mode'), gasH: ix('gas_heating_day_m3') };
    const from = now - 48 * 3600 * 1000;
    const hc = `hc${t.circuit}`;
    const outs: Array<[number, number]> = [];
    const hcRows: Array<{ t: number; room: number; tgt: number; prog: string; mode: string }> = [];
    let gasHeat = 0; const gasDays = new Set<string>();
    // read from the end: only the last 48 h are needed
    for (let i = lines.length - 1; i > 0; i--) {
      const c = lines[i].split(',');
      if (c.length < head.length) continue;
      const tm = Date.parse(c[I.ts]);
      if (!isFinite(tm)) continue;
      if (tm > now) continue;   // (backtests on older dates)
      if (tm < from) break;
      if (c[I.ev] !== 'snapshot') continue;
      if (c[I.acc] === 'boiler') {
        const o = parseFloat(c[I.out]); if (isFinite(o)) outs.push([tm, o]);
        const g = parseFloat(c[I.gasH]); if (isFinite(g) && g >= 0.3) { gasDays.add(c[I.ts].slice(0, 10)); gasHeat = Math.max(gasHeat, g); }
      } else if (c[I.acc] === hc) {
        const room = parseFloat(c[I.room]), tgt = parseFloat(c[I.tgt]);
        if (isFinite(room) && isFinite(tgt)) hcRows.push({ t: tm, room, tgt, prog: c[I.prog] || '', mode: c[I.mode] || '' });
      }
    }
    hcRows.reverse(); outs.reverse();
    const outAt = (tm: number) => { let best: number | null = null, d = Infinity; for (const [x, o] of outs) { const dd = Math.abs(x - tm); if (dd < d) { d = dd; best = o; } } return d < 3 * 3600 * 1000 ? best : null; };
    // samples: Normal/Comfort in force for at least 2 h
    let since = 0, prev = '';
    const cold: number[] = [], mild: number[] = [], all: number[] = [], outAll: number[] = [];
    for (const r of hcRows) {
      const p = /^(normal|comfort)/i.test(r.prog) && r.mode === 'heating' ? 'day' : 'other';
      if (p !== prev) { since = r.t; prev = p; }
      if (p !== 'day' || r.t - since < 2 * 3600 * 1000) continue;
      const o = outAt(r.t); if (o === null) continue;
      const e = r.room - r.tgt;
      all.push(e); outAll.push(o);
      if (o < 5) cold.push(e); else if (o < 15) mild.push(e);
    }
    const mean = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
    return { samples: all.length, err: mean(all), errCold: cold.length >= 12 ? mean(cold) : null, errMild: mild.length >= 12 ? mean(mild) : null, outdoor: mean(outAll), heatingDays: gasDays.size };
  }

  /** Decides the next step (pure: also used by tests/backtests). */
  decide(a: ReturnType<CurveTuner['analyse']>, cur: Curve, base: Curve, lim: { sMin: number; sMax: number; hMin: number; hMax: number }):
    { to: Curve; why: string } | { skip: string } {
    if (a.heatingDays < 1) return { skip: 'no heating in the last 48 h' };
    if (a.samples < 24 || a.err === null) return { skip: `not enough Normal/Comfort data (${a.samples} samples)` };
    if (a.outdoor !== null && a.outdoor >= 15) return { skip: `mild weather (outdoor ${a.outdoor.toFixed(1)} °C)` };
    const e = a.err;
    if (Math.abs(e) <= 0.5) return { skip: `room within ±0.5 °C of the program (${e >= 0 ? '+' : ''}${e.toFixed(1)} °C)` };
    const dir = e > 0 ? -1 : 1; // too warm → lower
    const sLo = Math.max(lim.sMin, r1(base.slope - this.maxSlope)), sHi = Math.min(lim.sMax, r1(base.slope + this.maxSlope));
    const hLo = Math.max(lim.hMin, base.shift - this.maxShift), hHi = Math.min(lim.hMax, base.shift + this.maxShift);
    const slopeFirst = a.errCold !== null && (a.errMild === null ? true : Math.abs(a.errCold) - Math.abs(a.errMild) > 0.6);
    const trySlope = () => { const s = r1(cur.slope + 0.1 * dir); return s >= sLo && s <= sHi ? { slope: s, shift: cur.shift } : null; };
    const tryShift = () => { const h = cur.shift + dir; return h >= hLo && h <= hHi ? { slope: cur.slope, shift: h } : null; };
    const to = slopeFirst ? (trySlope() || tryShift()) : (tryShift() || trySlope());
    const what = `room ${e > 0 ? '+' : ''}${e.toFixed(1)} °C vs the program over 48 h (outdoor ${a.outdoor?.toFixed(1)} °C` +
      `${a.errCold !== null ? `, cold ${a.errCold >= 0 ? '+' : ''}${a.errCold.toFixed(1)}` : ''}${a.errMild !== null ? `, mild ${a.errMild >= 0 ? '+' : ''}${a.errMild.toFixed(1)}` : ''})`;
    if (!to) return { skip: `${what}: limit reached (slope ${sLo}–${sHi}, shift ${hLo}–${hHi})` };
    return { to, why: what };
  }

  /** Last result per circuit while idle (kept in memory: nothing is written outside the heating season). */
  private idle = new Map<string, { lastEval: string; lastResult: string }>();

  async evaluate(t: Target) {
    const now = Date.now();
    const key = `${t.installationId}-${t.circuit}`;
    // 1. local history first: outside the heating season no API call and no file write
    const a = this.analyse(t, now);
    if (a.heatingDays < 1 || (a.outdoor !== null && a.outdoor >= 15)) {
      this.idle.set(key, { lastEval: new Date().toISOString(), lastResult: a.heatingDays < 1 ? 'no heating in the last 48 h' : `mild weather (outdoor ${a.outdoor!.toFixed(1)} °C)` });
      return;
    }
    this.idle.delete(key);
    const st = this.readState(t);
    const info = await this.readCurve(t);
    if (!info || typeof info.curve.slope !== 'number') { st.lastResult = 'heating curve not available on this device'; this.writeState(t, st); return; }
    if (!st.baseline) st.baseline = { ...info.curve, date: new Date().toISOString() };
    st.lastEval = new Date().toISOString();
    const done = (msg: string) => { st.lastResult = msg; this.writeState(t, st); this.platform.log.debug(`🌡️ HC${t.circuit} curve: ${msg}`); };
    if (info.mode !== 'heating') return done(`circuit not heating (${info.mode || 'unknown'})`);
    if (info.holiday) return done('holiday program active');
    const minGap = (a.err ?? 0) < -0.5 ? 24 : 48;
    if (st.lastChange && now - Date.parse(st.lastChange) < minGap * 3600 * 1000) return done(`waiting for the effect of the last change (${minGap} h)`);
    const d = this.decide(a, info.curve, st.baseline, info.limits);
    if ('skip' in d) return done(d.skip);
    await this.apply(t, info.curve, d.to, d.why, true, st);
  }

  private async apply(t: Target, from: Curve, to: Curve, why: string, auto: boolean, st: TunerState) {
    const ok = await this.platform.viessmannAPI.executeCommand(t.installationId, t.gatewaySerial, t.deviceId,
      `heating.circuits.${t.circuit}.heating.curve`, 'setCurve', { slope: to.slope, shift: to.shift });
    if (!ok) throw new Error('setCurve refused by the Viessmann API');
    st.lastChange = new Date().toISOString();
    st.lastResult = `changed: ${why}`;
    st.history.push({ ts: st.lastChange, from, to, reason: why, auto });
    this.writeState(t, st);
    this.platform.log.info(`🌡️ Heating curve HC${t.circuit}: slope ${from.slope} → ${to.slope}, shift ${from.shift} → ${to.shift} — ${why}`);
  }

  /** Dashboard "Restore starting curve". */
  async restore(installationId: string, circuit: number) {
    const t = this.targets.find(x => String(x.installationId) === String(installationId) && x.circuit === circuit);
    if (!t) throw new Error('circuit not found');
    const st = this.readState(t);
    if (!st.baseline) throw new Error('no starting curve saved');
    const info = await this.readCurve(t);
    if (!info) throw new Error('heating curve not available');
    await this.apply(t, info.curve, { slope: st.baseline.slope, shift: st.baseline.shift }, 'restored from the dashboard', false, st);
    return this.status();
  }
}
