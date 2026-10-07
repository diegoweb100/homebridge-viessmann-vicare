/**
 * Automatic heating-curve optimisation (features.curveAutoTune, off by default) — v2 since 2.0.82
 *
 * One decision engine (evaluate → CurveDecision) used by every mode:
 *   - "auto"     (curveAutoTune: true): applies the decision when it is safe and confident
 *   - "proposal" (curveAutoTuneMode: "proposal"): only proposes; you apply it from the dashboard
 *   - dashboard "Check now" / "Apply proposal": the same engine, never a second implementation
 *
 * Data: the history CSV the plugin already writes. Samples = room vs program temperature while
 * Normal/Comfort is in force (first 2 h of each period skipped: the house is still warming up),
 * over the last 7 days but never before 12 h after the last curve change (the house reacts slowly).
 *
 * Decision:
 *   - linear regression of the room error (room − program) against the outdoor temperature
 *   - error that changes with the outdoor temperature (wide outdoor range, good fit) → slope ±0.1
 *   - same error at any outdoor temperature → shift ±1 (the steps the boiler accepts)
 *   - |error| ≤ 0.5 °C → no change
 *   - confidence 0–100 % from samples, hours covered, agreement of the samples, size of the error
 *     and (for the slope) fit and outdoor range; "auto" applies only from 75 %
 *
 * Safety:
 *   - flow veto: the room is cold although the flow is already high (median flow with the burner
 *     on ≥ curveAutoTuneMaxFlow, default 55 °C, or near the circuit maximum) → never raise the
 *     curve: the cause is elsewhere (radiator valves, air, pump, room sensor position)
 *   - one step, then at least 48 h before the next (24 h if the house is too cold)
 *   - never further than ±0.3 slope / ±3 shift from the curve found when it was switched on
 *     (the "baseline", restorable from the dashboard)
 *   - only on heating days; outside the heating season it only reads the local history:
 *     no API call, nothing written
 *   - every change is logged with its reason and kept in viessmann-curve-tuner-<id>-hc<n>.json
 */
import * as fs from 'fs';
import * as path from 'path';

interface Target { installationId: number; gatewaySerial: string; deviceId: string; circuit: number }
export interface Curve { slope: number; shift: number }
type Limits = { sMin: number; sMax: number; hMin: number; hMax: number; flowMax: number | null };

export type DecisionCode = 'NO_CHANGE' | 'INCREASE_SLOPE' | 'DECREASE_SLOPE' | 'INCREASE_SHIFT' | 'DECREASE_SHIFT' | 'WAIT' | 'IDLE';

export interface CurveStats {
  samples: number; hours: number; outdoorMean: number; outdoorRange: number; outdoorLow: number; outdoorHigh: number;
  medianRoomError: number; errorAtLow: number; errorAtHigh: number; r2: number; errorPerDegree: number; agreement: number;
}

export interface CurveDecision {
  ts: string;
  installationId: string;
  circuit: number;
  mode: 'auto' | 'proposal' | 'manual';
  current: Curve | null;
  proposed: Curve | null;
  decision: DecisionCode;
  reasonCode: string;
  reason: string;
  confidence: number;
  stats: CurveStats | null;
  flow: { median: number; max: number; expected: number | null; limit: number; samples: number } | null;
  safety: 'PASS' | 'VETO';
  vetoCode?: 'HIGH_FLOW_FOR_CURRENT_OUTDOOR' | 'LIMIT_REACHED';
  autoApply: boolean;
  applied: boolean;
}

interface TunerState {
  baseline?: Curve & { date: string };
  lastChange?: string;
  lastEval?: string;
  lastResult?: string;
  lastDecision?: CurveDecision;
  history: Array<{ ts: string; from: Curve; to: Curve; reason: string; auto: boolean; confidence?: number; decision?: DecisionCode }>;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const sgn = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quant = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Viessmann heating curve: flow temperature for a room set point and an outdoor temperature. */
export function curveFlow(c: Curve, room: number, outdoor: number): number {
  const dar = outdoor - room;
  return room + c.shift - c.slope * dar * (1.4347 + 0.021 * dar + 247.9e-6 * dar * dar);
}

export const AUTO_CONFIDENCE = 75;
const TOLERANCE = 0.5;

export class CurveTuner {
  private targets: Target[] = [];
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private readonly interval: number;
  private readonly maxSlope: number;
  private readonly maxShift: number;
  private readonly maxFlow: number;
  readonly mode: 'auto' | 'proposal';
  /** Last decision per circuit while idle (kept in memory: nothing is written outside the heating season). */
  private idle = new Map<string, CurveDecision>();

  constructor(private readonly platform: any, private readonly dataDir: string, private readonly enabled: boolean) {
    const f = platform.config?.features || {};
    this.interval = Math.max(12, Number(f.curveAutoTuneIntervalHours) || 24) * 3600 * 1000;
    this.maxSlope = Math.min(Math.max(Number(f.curveAutoTuneMaxSlopeDelta) || 0.3, 0.1), 1);
    this.maxShift = Math.min(Math.max(Math.round(Number(f.curveAutoTuneMaxShiftDelta) || 3), 1), 10);
    this.maxFlow = Math.min(Math.max(Number(f.curveAutoTuneMaxFlow) || 55, 35), 80);
    this.mode = f.curveAutoTune === 'proposal' || f.curveAutoTuneMode === 'proposal' ? 'proposal' : 'auto';
  }

  private stateFile(t: Target) { return path.join(this.dataDir, `viessmann-curve-tuner-${t.installationId}-hc${t.circuit}.json`); }
  private readState(t: Target): TunerState {
    try { return { history: [], ...JSON.parse(fs.readFileSync(this.stateFile(t), 'utf8')) }; } catch { return { history: [] }; }
  }
  private writeState(t: Target, s: TunerState) {
    s.history = s.history.slice(-50);
    const f = this.stateFile(t), tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, f);
  }

  register(t: Target) {
    if (this.targets.some(x => x.installationId === t.installationId && x.circuit === t.circuit)) return;
    this.targets.push(t);
    if (!this.enabled) return;
    if (!this.timer) {
      this.first = setTimeout(() => this.runAll(), 10 * 60 * 1000);
      this.timer = setInterval(() => this.runAll(), this.interval);
      this.platform.log.info(`🌡️ Heating-curve optimisation ON (${this.mode === 'proposal' ? 'proposals only, you apply them from the dashboard' : `automatic from ${AUTO_CONFIDENCE} % confidence`}): ` +
        `checks every ${Math.round(this.interval / 3600000)} h on heating days only (steps 0.1 slope / 1 shift, max ±${this.maxSlope} / ±${this.maxShift} from the starting curve, ` +
        `never raised with flow ≥ ${this.maxFlow} °C)`);
    }
  }

  stop() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  /** Summary for the dashboard. */
  status() {
    return {
      enabled: this.enabled, mode: this.mode, autoConfidence: AUTO_CONFIDENCE, maxFlow: this.maxFlow,
      intervalHours: Math.round(this.interval / 3600000), maxSlope: this.maxSlope, maxShift: this.maxShift,
      circuits: this.targets.map(t => {
        const st = this.readState(t);
        const idle = this.idle.get(`${t.installationId}-${t.circuit}`);
        const lastDecision = idle || st.lastDecision;
        return { installationId: String(t.installationId), circuit: t.circuit, ...st, lastDecision,
          lastEval: lastDecision?.ts || st.lastEval, lastResult: lastDecision?.reason || st.lastResult };
      }),
    };
  }

  private async runAll() {
    for (const t of this.targets) {
      try { await this.evaluate(t, this.mode); } catch (e: any) { this.platform.log.warn(`🌡️ Heating-curve optimisation HC${t.circuit}: ${e?.message || e}`); }
    }
  }

  private async readCurve(t: Target): Promise<{ curve: Curve; mode: string; holiday: boolean; limits: Limits } | null> {
    const api = this.platform.viessmannAPI;
    api.clearCache?.(`/features/installations/${t.installationId}`);
    const feats: any[] = await api.getDeviceFeatures(t.installationId, t.gatewaySerial, t.deviceId);
    const hc = `heating.circuits.${t.circuit}`;
    const c = feats.find(f => f.feature === `${hc}.heating.curve`);
    if (!c?.commands?.setCurve) return null;
    const p = c.commands.setCurve.params || {};
    const lv = feats.find(f => f.feature === `${hc}.temperature.levels`)?.properties?.max?.value;
    return {
      curve: { slope: c.properties?.slope?.value, shift: c.properties?.shift?.value },
      mode: feats.find(f => f.feature === `${hc}.operating.modes.active`)?.properties?.value?.value || '',
      holiday: !!(feats.find(f => f.feature === 'heating.operating.programs.holiday')?.properties?.active?.value ||
                  feats.find(f => f.feature === 'heating.operating.programs.holidayAtHome')?.properties?.active?.value),
      limits: {
        sMin: p.slope?.constraints?.min ?? 0.2, sMax: p.slope?.constraints?.max ?? 3.5,
        hMin: p.shift?.constraints?.min ?? -13, hMax: p.shift?.constraints?.max ?? 40,
        flowMax: typeof lv === 'number' && lv > 20 ? lv : null,
      },
    };
  }

  /**
   * Reads the history CSV from the end. Returns the samples since `since` and the heating-day
   * check over the last 48 h (pure apart from reading the file: also used by backtests).
   */
  analyse(t: Target, now = Date.now(), since = now - 7 * 86400000) {
    const file = path.join(this.dataDir, `viessmann-history-${t.installationId}.csv`);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const head = lines[0].replace(/\r$/, '').split(',');
    const ix = (n: string) => head.indexOf(n);
    const I = { ts: ix('timestamp'), acc: ix('accessory'), ev: ix('event_type'), burn: ix('burner_active'), room: ix('room_temp'), tgt: ix('target_temp'),
      out: ix('outside_temp'), prog: ix('program'), mode: ix('mode'), flow: ix('flow_temp'), gasH: ix('gas_heating_day_m3') };
    const from = Math.min(since, now - 48 * 3600 * 1000);
    const hc = `hc${t.circuit}`;
    const boiler: Array<{ t: number; out: number | null; burn: boolean }> = [];
    const hcRows: Array<{ t: number; room: number; tgt: number; prog: string; mode: string; flow: number | null }> = [];
    const gasDays = new Set<string>(); const out48: number[] = [];
    for (let i = lines.length - 1; i > 0; i--) {
      const c = lines[i].replace(/\r$/, '').split(',');
      if (c.length < head.length) continue;
      const tm = Date.parse(c[I.ts]);
      if (!isFinite(tm)) continue;
      if (tm > now) continue;   // backtests on older dates
      if (tm < from) break;
      if (c[I.ev] !== 'snapshot') continue;
      if (c[I.acc] === 'boiler') {
        const o = parseFloat(c[I.out]);
        boiler.push({ t: tm, out: isFinite(o) ? o : null, burn: c[I.burn] === 'true' });
        if (tm >= now - 48 * 3600 * 1000) {
          if (isFinite(o)) out48.push(o);
          const g = parseFloat(c[I.gasH]); if (isFinite(g) && g >= 0.3) gasDays.add(c[I.ts].slice(0, 10));
        }
      } else if (c[I.acc] === hc) {
        const room = parseFloat(c[I.room]), tgt = parseFloat(c[I.tgt]), fl = parseFloat(c[I.flow]);
        if (isFinite(room) && isFinite(tgt)) hcRows.push({ t: tm, room, tgt, prog: c[I.prog] || '', mode: c[I.mode] || '', flow: isFinite(fl) ? fl : null });
      }
    }
    hcRows.reverse(); boiler.reverse();
    const near = (tm: number, maxMs: number) => {
      let lo = 0, hi = boiler.length - 1, best = -1, d = Infinity;
      while (lo <= hi) { const m = (lo + hi) >> 1; const dd = Math.abs(boiler[m].t - tm); if (dd < d) { d = dd; best = m; } if (boiler[m].t < tm) lo = m + 1; else hi = m - 1; }
      return best >= 0 && d <= maxMs ? boiler[best] : null;
    };
    // samples: Normal/Comfort in force for at least 2 h, since `since`
    let start = 0, prev = '';
    const samples: Array<{ t: number; out: number; err: number; tgt: number }> = [];
    const flows: Array<{ out: number; flow: number; tgt: number }> = [];
    for (const r of hcRows) {
      const p = /^(normal|comfort)/i.test(r.prog) && r.mode === 'heating' ? 'day' : 'other';
      if (p !== prev) { start = r.t; prev = p; }
      if (r.t < since || p !== 'day' || r.t - start < 2 * 3600 * 1000) continue;
      const b = near(r.t, 3 * 3600 * 1000);
      if (!b || b.out === null) continue;
      samples.push({ t: r.t, out: b.out, err: r.room - r.tgt, tgt: r.tgt });
      const bb = near(r.t, 10 * 60 * 1000);
      if (r.flow !== null && bb?.burn && r.flow >= 25) flows.push({ out: b.out, flow: r.flow, tgt: r.tgt });
    }
    return { samples, flows, heatingDays: gasDays.size, outdoor48: out48.length ? out48.reduce((s, v) => s + v, 0) / out48.length : null };
  }

  /** Statistics of the samples: median error, regression error ~ outdoor, agreement. */
  stats(s: Array<{ t: number; out: number; err: number }>): CurveStats | null {
    if (!s.length) return null;
    const n = s.length, xs = s.map(v => v.out), ys = s.map(v => v.err);
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }
    const a = sxx > 1e-9 ? sxy / sxx : 0, b = my - a * mx;
    const fit = sxx > 1e-9 && syy > 1e-9 ? (sxy * sxy) / (sxx * syy) : 0;
    const lo = quant(xs, 0.1), hi = quant(xs, 0.9), med = median(ys);
    const agree = med === 0 ? 0 : ys.filter(v => Math.sign(v) === Math.sign(med)).length / n;
    return {
      samples: n, hours: r1((s[n - 1].t - s[0].t) / 3600000), outdoorMean: r1(mx), outdoorRange: r1(hi - lo), outdoorLow: r1(lo), outdoorHigh: r1(hi),
      medianRoomError: r2(med), errorAtLow: r2(a * lo + b), errorAtHigh: r2(a * hi + b), r2: r2(fit), errorPerDegree: Math.round(a * 1000) / 1000, agreement: r2(agree),
    };
  }

  /**
   * The decision engine (pure: also used by backtests). Returns the decision object; `apply`
   * only executes it.
   */
  decide(a: ReturnType<CurveTuner['analyse']>, cur: Curve, base: Curve, lim: Limits):
    Pick<CurveDecision, 'proposed' | 'decision' | 'reasonCode' | 'reason' | 'confidence' | 'stats' | 'flow' | 'safety' | 'vetoCode' | 'autoApply'> {
    const st = this.stats(a.samples);
    const out = { proposed: null as Curve | null, confidence: 0, stats: st, flow: null as CurveDecision['flow'], safety: 'PASS' as 'PASS' | 'VETO', vetoCode: undefined as CurveDecision['vetoCode'], autoApply: false };
    if (!st || st.samples < 24 || st.hours < 12) {
      return { ...out, decision: 'WAIT', reasonCode: 'NOT_ENOUGH_DATA', reason: `not enough Normal/Comfort data (${st ? st.samples : 0} samples, ${st ? st.hours : 0} h)` };
    }
    // flow with the burner on, for the outdoor temperatures of the samples
    if (a.flows.length >= 6) {
      const fm = median(a.flows.map(f => f.flow)), tgt = median(a.flows.map(f => f.tgt)), o = median(a.flows.map(f => f.out));
      const limit = Math.min(this.maxFlow, lim.flowMax !== null ? lim.flowMax - 2 : Infinity);
      out.flow = { median: r1(fm), max: r1(Math.max(...a.flows.map(f => f.flow))), expected: r1(curveFlow(cur, tgt, o)), limit: r1(limit), samples: a.flows.length };
    }
    const sLo = Math.max(lim.sMin, r1(base.slope - this.maxSlope)), sHi = Math.min(lim.sMax, r1(base.slope + this.maxSlope));
    const hLo = Math.max(lim.hMin, base.shift - this.maxShift), hHi = Math.min(lim.hMax, base.shift + this.maxShift);

    // slope when the error clearly depends on the outdoor temperature, otherwise shift
    const spread = st.errorAtLow - st.errorAtHigh;
    const slopeCase = st.outdoorRange >= 6 && st.r2 >= 0.25 && Math.abs(spread) >= 0.6 && Math.abs(st.errorAtLow) > TOLERANCE;
    const e = slopeCase ? st.errorAtLow : st.medianRoomError;
    const desc = `room ${sgn(st.medianRoomError)} °C vs the program (${st.samples} samples, ${Math.round(st.hours)} h, outdoor ${st.outdoorLow}…${st.outdoorHigh} °C` +
      `${slopeCase ? `, ${sgn(st.errorAtLow)} °C at ${st.outdoorLow} °C vs ${sgn(st.errorAtHigh)} °C at ${st.outdoorHigh} °C` : ''})`;
    if (Math.abs(e) <= TOLERANCE) {
      return { ...out, decision: 'NO_CHANGE', reasonCode: 'WITHIN_TOLERANCE', reason: `${desc}: within ±${TOLERANCE} °C, no change`, confidence: 0 };
    }
    const dir = e > 0 ? -1 : 1;   // too warm → lower
    const decision: DecisionCode = slopeCase ? (dir > 0 ? 'INCREASE_SLOPE' : 'DECREASE_SLOPE') : (dir > 0 ? 'INCREASE_SHIFT' : 'DECREASE_SHIFT');
    const reasonCode = slopeCase ? (dir > 0 ? 'ROOM_COLD_WHEN_COLD_OUTSIDE' : 'ROOM_WARM_WHEN_COLD_OUTSIDE') : (dir > 0 ? 'ROOM_COLD' : 'ROOM_WARM');

    // confidence: samples, hours, agreement of the samples, size of the error (+ fit and range for the slope)
    let conf = 0.25 * clamp01(st.samples / 96) + 0.2 * clamp01(st.hours / 48) + 0.3 * clamp01((st.agreement - 0.5) / 0.4) + 0.25 * clamp01(0.5 + (Math.abs(e) - TOLERANCE) / 0.5);
    if (slopeCase) conf *= 0.5 + 0.5 * Math.min(clamp01(st.r2 / 0.5), clamp01(st.outdoorRange / 10));
    out.confidence = Math.round(conf * 100);

    // safety: never raise the curve when the flow is already high
    if (dir > 0 && out.flow && out.flow.median >= out.flow.limit) {
      return { ...out, decision, reasonCode: 'HIGH_FLOW_FOR_CURRENT_OUTDOOR', safety: 'VETO', vetoCode: 'HIGH_FLOW_FOR_CURRENT_OUTDOOR',
        reason: `${desc}: room cold although the flow is already high (median ${out.flow.median} °C ≥ ${out.flow.limit} °C) — not raising the curve: check radiator valves, air in the radiators, pump and room sensor position` };
    }
    const trySlope = () => { const s = r1(cur.slope + 0.1 * dir); return s >= sLo && s <= sHi ? { slope: s, shift: cur.shift } : null; };
    const tryShift = () => { const h = cur.shift + dir; return h >= hLo && h <= hHi ? { slope: cur.slope, shift: h } : null; };
    let to = slopeCase ? trySlope() : tryShift();
    let final = decision;
    if (!to) {   // the preferred knob is at its limit: the other one, if it can still move
      to = slopeCase ? tryShift() : trySlope();
      if (to) final = to.slope !== cur.slope ? (dir > 0 ? 'INCREASE_SLOPE' : 'DECREASE_SLOPE') : (dir > 0 ? 'INCREASE_SHIFT' : 'DECREASE_SHIFT');
    }
    if (!to) {
      return { ...out, decision, reasonCode: 'LIMIT_REACHED', safety: 'VETO', vetoCode: 'LIMIT_REACHED',
        reason: `${desc}: limit reached (slope ${sLo}–${sHi}, shift ${hLo}–${hHi})` };
    }
    out.proposed = to;
    out.autoApply = out.confidence >= AUTO_CONFIDENCE;
    return { ...out, decision: final, reasonCode, reason: `${desc}${out.autoApply ? '' : `: confidence ${out.confidence} % (below ${AUTO_CONFIDENCE} %)`}` };
  }

  /**
   * Evaluates one circuit and, in "auto" mode, applies a safe and confident decision.
   * mode "proposal" / "manual" never applies (manual = dashboard "Check now").
   */
  async evaluate(t: Target, mode: 'auto' | 'proposal' | 'manual' = this.mode): Promise<CurveDecision> {
    const now = Date.now();
    const key = `${t.installationId}-${t.circuit}`;
    const base: CurveDecision = {
      ts: new Date(now).toISOString(), installationId: String(t.installationId), circuit: t.circuit, mode,
      current: null, proposed: null, decision: 'IDLE', reasonCode: '', reason: '', confidence: 0, stats: null, flow: null,
      safety: 'PASS', autoApply: false, applied: false,
    };
    const stFile = this.readState(t);
    // 1. local history first: outside the heating season no API call and no file write
    const since = Math.max(now - 7 * 86400000, stFile.lastChange ? Date.parse(stFile.lastChange) + 12 * 3600000 : 0);
    const a = this.analyse(t, now, since);
    if (a.heatingDays < 1 || (a.outdoor48 !== null && a.outdoor48 >= 15)) {
      const d = { ...base, reasonCode: a.heatingDays < 1 ? 'NO_HEATING' : 'MILD_WEATHER',
        reason: a.heatingDays < 1 ? 'no heating in the last 48 h' : `mild weather (outdoor ${a.outdoor48!.toFixed(1)} °C)` };
      this.idle.set(key, d);
      return d;
    }
    this.idle.delete(key);
    const st = stFile;
    const info = await this.readCurve(t);
    const save = (d: CurveDecision) => {
      st.lastEval = d.ts; st.lastResult = d.reason; st.lastDecision = d;
      this.writeState(t, st);
      this.platform.log.debug(`🌡️ HC${t.circuit} curve: ${d.decision} ${d.reason}`);
      return d;
    };
    if (!info || typeof info.curve.slope !== 'number') return save({ ...base, decision: 'WAIT', reasonCode: 'CURVE_NOT_AVAILABLE', reason: 'heating curve not available on this device' });
    if (!st.baseline) st.baseline = { ...info.curve, date: new Date(now).toISOString() };
    const cur = { ...base, current: info.curve };
    if (info.mode !== 'heating') return save({ ...cur, decision: 'WAIT', reasonCode: 'NOT_HEATING_MODE', reason: `circuit not heating (${info.mode || 'unknown'})` });
    if (info.holiday) return save({ ...cur, decision: 'WAIT', reasonCode: 'HOLIDAY', reason: 'holiday program active' });
    const pre = this.stats(a.samples);
    const minGap = pre && pre.medianRoomError < -TOLERANCE ? 24 : 48;
    if (st.lastChange && now - Date.parse(st.lastChange) < minGap * 3600 * 1000) {
      return save({ ...cur, decision: 'WAIT', reasonCode: 'WAITING_EFFECT', reason: `waiting for the effect of the last change (${minGap} h)` });
    }
    const d: CurveDecision = { ...cur, ...this.decide(a, info.curve, st.baseline, info.limits) };
    const change = !!d.proposed && d.safety === 'PASS';
    if (change && mode === 'auto' && d.autoApply) {
      await this.apply(t, info.curve, d.proposed!, d.reason, true, st, d);
      d.applied = true;
      return save(d);
    }
    if (change && mode === 'proposal') {
      this.platform.log.info(`💡 Heating curve proposal HC${t.circuit}: slope ${info.curve.slope} → ${d.proposed!.slope}, shift ${info.curve.shift} → ${d.proposed!.shift} ` +
        `(confidence ${d.confidence} %) — ${d.reason}. Apply it from the dashboard.`);
    }
    if (d.vetoCode === 'HIGH_FLOW_FOR_CURRENT_OUTDOOR' && mode !== 'manual') this.platform.log.warn(`🌡️ Heating curve HC${t.circuit}: ${d.reason}`);
    return save(d);
  }

  private async apply(t: Target, from: Curve, to: Curve, why: string, auto: boolean, st: TunerState, d?: CurveDecision) {
    const ok = await this.platform.viessmannAPI.executeCommand(t.installationId, t.gatewaySerial, t.deviceId,
      `heating.circuits.${t.circuit}.heating.curve`, 'setCurve', { slope: to.slope, shift: to.shift });
    if (!ok) throw new Error('setCurve refused by the Viessmann API');
    st.lastChange = new Date().toISOString();
    st.lastResult = `changed: ${why}`;
    st.history.push({ ts: st.lastChange, from, to, reason: why, auto, confidence: d?.confidence, decision: d?.decision });
    this.writeState(t, st);
    this.platform.log.info(`🌡️ Heating curve HC${t.circuit}: slope ${from.slope} → ${to.slope}, shift ${from.shift} → ${to.shift} — ${why}`);
  }

  private target(installationId: string, circuit: number): Target {
    const t = this.targets.find(x => String(x.installationId) === String(installationId) && x.circuit === circuit);
    if (!t) throw new Error('circuit not found');
    return t;
  }

  /** Dashboard "Check now": the same engine, never applies. */
  async check(installationId: string, circuit: number) {
    if (!this.enabled) throw new Error('heating-curve optimisation is off in the plugin settings');
    await this.evaluate(this.target(installationId, circuit), 'manual');
    return this.status();
  }

  /**
   * Dashboard "Apply proposal": evaluates again with fresh data (same engine) and applies only
   * if the result is still the proposal the user saw, and it passed the safety checks.
   */
  async applyProposal(installationId: string, circuit: number, expected?: Partial<Curve>) {
    if (!this.enabled) throw new Error('heating-curve optimisation is off in the plugin settings');
    const t = this.target(installationId, circuit);
    const d = await this.evaluate(t, 'manual');
    if (!d.proposed || d.safety !== 'PASS') throw new Error(`no change to apply now: ${d.reason}`);
    if (expected && (expected.slope !== d.proposed.slope || expected.shift !== d.proposed.shift)) {
      throw new Error(`the proposal changed with the latest data (now ${d.proposed.slope} / ${d.proposed.shift}): check it again`);
    }
    const st = this.readState(t);
    await this.apply(t, d.current!, d.proposed, `${d.reason} (applied from the dashboard)`, false, st, d);
    st.lastDecision = { ...d, applied: true };
    this.writeState(t, st);
    return this.status();
  }

  /** Dashboard "Restore starting curve". */
  async restore(installationId: string, circuit: number) {
    const t = this.target(installationId, circuit);
    const st = this.readState(t);
    if (!st.baseline) throw new Error('no starting curve saved');
    const info = await this.readCurve(t);
    if (!info) throw new Error('heating curve not available');
    await this.apply(t, info.curve, { slope: st.baseline.slope, shift: st.baseline.shift }, 'restored from the dashboard', false, st);
    return this.status();
  }
}
