/**
 * Automatic heating-curve optimisation (features.curveAutoTune, off by default)
 * v2 since 2.0.82, economy optimiser since 2.0.83.
 *
 * Goal (curveAutoTuneGoal, default "economy"): the LOWEST curve that keeps the room at the
 * temperature of the program. Comfort is the constraint, saving the objective. Continuous
 * closed loop, re-evaluated every day of the heating season, in both directions:
 *
 *   room below target − 0.2 °C  → raise the curve one step (comfort first)
 *   room above target + 0.2 °C  → lower it one step (wasted heat)
 *   in between, with margin      → try one step lower (economy probe): if the room stays in the
 *                                  band the lower curve is kept and the next probe follows;
 *                                  if it gets too cool, the normal "too cool" rule raises it
 *                                  again and that curve becomes a temporary floor
 *   any curve found too cool      → temporary floor, so "too warm" cannot bounce straight back
 *   goal "comfort"               → only corrects outside ±0.5 °C (the 2.0.82 behaviour)
 *
 * There is no "rollback that stops": a failed probe is just one more measurement. The floor
 * avoids a loop (probe → too cool → raise → probe …): the same lower curve is retried only after
 * curveAutoTuneRetryDays (default 14), doubled after every new failure at that curve, and
 * forgotten after 120 days. Raising for comfort is never blocked by a floor.
 *
 * Knob: slope ±0.1 when the error clearly depends on the outdoor temperature (regression of the
 * room error on the outdoor temperature: wide outdoor range, good fit), otherwise shift ±1 —
 * the steps the boiler accepts. Data: up to 7 days of Normal/Comfort periods (first 2 h of each
 * period skipped), never earlier than 12 h after the last change.
 *
 * Safety:
 *   - confidence 0–100 %; automatic changes only from 75 % (50 % to raise the curve again after
 *     a probe that made the room too cool)
 *   - flow veto: never raise the curve when the flow with the burner on is already high
 *     (curveAutoTuneMaxFlow, default 55 °C, or near the circuit maximum)
 *   - at least 48 h between changes (24 h when the room is too cool)
 *   - never further than ±0.3 slope / ±3 shift from the curve found when it was switched on
 *     (the "baseline", restorable from the dashboard)
 *   - only on heating days; outside the heating season it only reads the local history:
 *     no API call, nothing written
 */
import * as fs from 'fs';
import * as path from 'path';

interface Target { installationId: number; gatewaySerial: string; deviceId: string; circuit: number }
export interface Curve { slope: number; shift: number }
type Limits = { sMin: number; sMax: number; hMin: number; hMax: number; flowMax: number | null };

export type DecisionCode = 'NO_CHANGE' | 'INCREASE_SLOPE' | 'DECREASE_SLOPE' | 'INCREASE_SHIFT' | 'DECREASE_SHIFT' | 'WAIT' | 'IDLE';
export type Goal = 'economy' | 'comfort';
interface Floor { slope: number; shift: number; ts: string; fails: number; until: string }
interface LastStep { from: Curve; to: Curve; dir: 1 | -1; ts: string; probe: boolean; before?: number }
/** Learned effect of one step on the room (°C): how much one shift / slope step moves the room. */
interface StepEffect { shift: number | null; slope: number | null }
const PRIOR_EFFECT = { shift: 0.15, slope: 0.3 };

export interface CurveStats {
  samples: number; hours: number; outdoorMean: number; outdoorRange: number; outdoorLow: number; outdoorHigh: number;
  medianRoomError: number; errorAtLow: number; errorAtHigh: number; r2: number; errorPerDegree: number; agreement: number;
  errorP10: number; comfortShare: number;
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
  goal?: Goal;
  probe?: boolean;          // economy probe (one step lower while comfortable)
  recovery?: boolean;       // raising again after a step down made the room too cool
  floor?: { slope: number; shift: number; until: string } | null;
  stepEffect?: StepEffect;
}

interface TunerState {
  baseline?: Curve & { date: string };
  lastChange?: string;
  lastEval?: string;
  lastResult?: string;
  lastDecision?: CurveDecision;
  lastStep?: LastStep;
  floors?: Floor[];
  stepEffect?: StepEffect;
  history: Array<{ ts: string; from: Curve; to: Curve; reason: string; auto: boolean; confidence?: number; decision?: DecisionCode; probe?: boolean; outcome?: 'kept' | 'too cool' }>;
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
const RECOVERY_CONFIDENCE = 50;
/** Comfort band around the program temperature: [target − lower, target + upper]. */
const BAND: Record<Goal, { lower: number; upper: number }> = { economy: { lower: 0.2, upper: 0.2 }, comfort: { lower: 0.5, upper: 0.5 } };
const FLOOR_MAX_AGE_DAYS = 120;
const flowAt0 = (c: Curve) => curveFlow(c, 20, 0);   // one number to compare curves: flow at 0 °C outdoor

export class CurveTuner {
  private targets: Target[] = [];
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private readonly interval: number;
  private readonly maxSlope: number;
  private readonly maxShift: number;
  private readonly maxFlow: number;
  readonly mode: 'auto' | 'proposal';
  readonly goal: Goal;
  private readonly retryDays: number;
  /** Last decision per circuit while idle (kept in memory: nothing is written outside the heating season). */
  private idle = new Map<string, CurveDecision>();

  constructor(private readonly platform: any, private readonly dataDir: string, private readonly enabled: boolean) {
    const f = platform.config?.features || {};
    this.interval = Math.max(12, Number(f.curveAutoTuneIntervalHours) || 24) * 3600 * 1000;
    this.maxSlope = Math.min(Math.max(Number(f.curveAutoTuneMaxSlopeDelta) || 0.3, 0.1), 1);
    this.maxShift = Math.min(Math.max(Math.round(Number(f.curveAutoTuneMaxShiftDelta) || 3), 1), 10);
    this.maxFlow = Math.min(Math.max(Number(f.curveAutoTuneMaxFlow) || 55, 35), 80);
    this.mode = f.curveAutoTune === 'proposal' || f.curveAutoTuneMode === 'proposal' ? 'proposal' : 'auto';
    this.goal = f.curveAutoTuneGoal === 'comfort' ? 'comfort' : 'economy';
    this.retryDays = Math.min(Math.max(Number(f.curveAutoTuneRetryDays) || 14, 3), 90);
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
      this.platform.log.info(`🌡️ Heating-curve optimisation ON — ${this.goal === 'economy' ? 'economy: lowest curve that keeps the program temperature (±0.2 °C)' : 'comfort: corrects only outside ±0.5 °C'}, ` +
        `${this.mode === 'proposal' ? 'proposals only, you apply them from the dashboard' : `automatic from ${AUTO_CONFIDENCE} % confidence`}: ` +
        `checks every ${Math.round(this.interval / 3600000)} h on heating days only (steps 0.1 slope / 1 shift, max ±${this.maxSlope} / ±${this.maxShift} from the starting curve, ` +
        `never raised with flow ≥ ${this.maxFlow} °C)`);
    }
  }

  stop() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  /** Summary for the dashboard. */
  status() {
    return {
      enabled: this.enabled, mode: this.mode, goal: this.goal, band: BAND[this.goal], retryDays: this.retryDays, autoConfidence: AUTO_CONFIDENCE, maxFlow: this.maxFlow,
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
    const lower = BAND[this.goal].lower;
    return {
      samples: n, hours: r1((s[n - 1].t - s[0].t) / 3600000), outdoorMean: r1(mx), outdoorRange: r1(hi - lo), outdoorLow: r1(lo), outdoorHigh: r1(hi),
      medianRoomError: r2(med), errorAtLow: r2(a * lo + b), errorAtHigh: r2(a * hi + b), r2: r2(fit), errorPerDegree: Math.round(a * 1000) / 1000, agreement: r2(agree),
      errorP10: r2(quant(ys, 0.1)), comfortShare: r2(ys.filter(v => v >= -lower).length / n),
    };
  }

  /**
   * The decision engine (pure: also used by backtests). Returns the decision object; `apply`
   * only executes it. `ctx` carries what the loop remembers: the last step and the floors.
   */
  decide(a: ReturnType<CurveTuner['analyse']>, cur: Curve, base: Curve, lim: Limits,
    ctx: { lastStep?: LastStep; floors?: Floor[]; now?: number; stepEffect?: StepEffect } = {}):
    Pick<CurveDecision, 'proposed' | 'decision' | 'reasonCode' | 'reason' | 'confidence' | 'stats' | 'flow' | 'safety' | 'vetoCode' | 'autoApply' | 'goal' | 'probe' | 'recovery' | 'floor' | 'stepEffect'> {
    const now = ctx.now ?? Date.now();
    const goal = this.goal, band = BAND[goal];
    const st = this.stats(a.samples);
    const out = { proposed: null as Curve | null, confidence: 0, stats: st, flow: null as CurveDecision['flow'], safety: 'PASS' as 'PASS' | 'VETO',
      vetoCode: undefined as CurveDecision['vetoCode'], autoApply: false, goal, probe: false, recovery: false, floor: null as CurveDecision['floor'], stepEffect: ctx.stepEffect };
    const effect = (c: Curve) => c.slope !== cur.slope ? (ctx.stepEffect?.slope ?? PRIOR_EFFECT.slope) : (ctx.stepEffect?.shift ?? PRIOR_EFFECT.shift);
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
    const trySlope = (dir: number) => { const s = r1(cur.slope + 0.1 * dir); return s >= sLo && s <= sHi ? { slope: s, shift: cur.shift } : null; };
    const tryShift = (dir: number) => { const h = cur.shift + dir; return h >= hLo && h <= hHi ? { slope: cur.slope, shift: h } : null; };
    const code = (c: Curve, dir: number): DecisionCode => c.slope !== cur.slope ? (dir > 0 ? 'INCREASE_SLOPE' : 'DECREASE_SLOPE') : (dir > 0 ? 'INCREASE_SHIFT' : 'DECREASE_SHIFT');

    // the error depends on the outdoor temperature? (regression: wide range, good fit, clear spread)
    const spread = st.errorAtLow - st.errorAtHigh;
    const dependsOnCold = st.outdoorRange >= 6 && st.r2 >= 0.25 && Math.abs(spread) >= 0.6;
    const desc = `room ${sgn(st.medianRoomError)} °C vs the program (${st.samples} samples, ${Math.round(st.hours)} h, outdoor ${st.outdoorLow}…${st.outdoorHigh} °C` +
      `${dependsOnCold ? `, ${sgn(st.errorAtLow)} °C at ${st.outdoorLow} °C vs ${sgn(st.errorAtHigh)} °C at ${st.outdoorHigh} °C` : ''})`;
    const base01 = 0.25 * clamp01(st.samples / 96) + 0.2 * clamp01(st.hours / 48);

    // 1. too cool → raise (comfort first; never blocked by a floor)
    const coldSlope = dependsOnCold && st.errorAtLow < -band.lower;
    if (coldSlope || st.medianRoomError < -band.lower) {
      const e = coldSlope ? st.errorAtLow : st.medianRoomError;
      const recovery = !!ctx.lastStep && ctx.lastStep.dir < 0 && ctx.lastStep.to.slope === cur.slope && ctx.lastStep.to.shift === cur.shift;
      let conf = base01 + 0.3 * clamp01((st.agreement - 0.5) / 0.4) + 0.25 * clamp01(0.5 + (Math.abs(e) - band.lower) / 0.5);
      if (coldSlope) conf *= 0.5 + 0.5 * Math.min(clamp01(st.r2 / 0.5), clamp01(st.outdoorRange / 10));
      out.confidence = Math.round(conf * 100); out.recovery = recovery;
      const reasonCode = coldSlope ? 'ROOM_COLD_WHEN_COLD_OUTSIDE' : 'ROOM_COLD';
      const pre = coldSlope ? 'INCREASE_SLOPE' : 'INCREASE_SHIFT';
      const why = `${desc}${recovery ? `: too cool after the step down to ${cur.slope} / ${cur.shift}` : ''}`;
      if (out.flow && out.flow.median >= out.flow.limit) {
        return { ...out, decision: pre, reasonCode: 'HIGH_FLOW_FOR_CURRENT_OUTDOOR', safety: 'VETO', vetoCode: 'HIGH_FLOW_FOR_CURRENT_OUTDOOR',
          reason: `${why}: room cool although the flow is already high (median ${out.flow.median} °C ≥ ${out.flow.limit} °C) — not raising the curve: check radiator valves, air in the radiators, pump and room sensor position` };
      }
      // after a failed step down, go back exactly to where it came from
      let to = recovery ? { ...ctx.lastStep!.from } : (coldSlope ? (trySlope(1) || tryShift(1)) : (tryShift(1) || trySlope(1)));
      if (to && (to.slope > sHi || to.shift > hHi)) to = null;
      if (!to) return { ...out, decision: pre, reasonCode: 'LIMIT_REACHED', safety: 'VETO', vetoCode: 'LIMIT_REACHED', reason: `${why}: limit reached (slope ${sLo}–${sHi}, shift ${hLo}–${hHi})` };
      out.proposed = to;
      out.autoApply = out.confidence >= (recovery ? RECOVERY_CONFIDENCE : AUTO_CONFIDENCE);
      return { ...out, decision: code(to, 1), reasonCode, reason: `${why}${out.autoApply ? '' : `: confidence ${out.confidence} % (below ${recovery ? RECOVERY_CONFIDENCE : AUTO_CONFIDENCE} %)`}` };
    }

    // active floors (lower curves that recently made the room too cool)
    const floors = (ctx.floors || []).filter(f => Date.parse(f.until) > now);
    const blockedBy = (c: Curve) => floors.find(f => flowAt0(c) <= flowAt0(f) + 0.05);
    const down = (prefSlope: boolean) => {
      const cands = (prefSlope ? [trySlope(-1), tryShift(-1)] : [tryShift(-1), trySlope(-1)]).filter(Boolean) as Curve[];
      for (const c of cands) { const f = blockedBy(c); if (!f) return { to: c, floor: null as Floor | null }; }
      return { to: null as Curve | null, floor: cands.length ? blockedBy(cands[0]) || null : null };
    };

    // 2. too warm → lower (wasted heat)
    const warmSlope = dependsOnCold && st.errorAtLow > band.upper && spread > 0;
    if (warmSlope || st.medianRoomError > band.upper) {
      const e = warmSlope ? st.errorAtLow : st.medianRoomError;
      let conf = base01 + 0.3 * clamp01((st.agreement - 0.5) / 0.4) + 0.25 * clamp01(0.5 + (Math.abs(e) - band.upper) / 0.5);
      if (warmSlope) conf *= 0.5 + 0.5 * Math.min(clamp01(st.r2 / 0.5), clamp01(st.outdoorRange / 10));
      out.confidence = Math.round(conf * 100);
      const reasonCode = warmSlope ? 'ROOM_WARM_WHEN_COLD_OUTSIDE' : 'ROOM_WARM';
      const { to, floor } = down(warmSlope);
      if (!to) {
        if (floor) return { ...out, decision: 'NO_CHANGE', reasonCode: 'FLOOR_ACTIVE', floor: { slope: floor.slope, shift: floor.shift, until: floor.until },
          reason: `${desc}: a lower curve (${floor.slope} / ${floor.shift}) made the room too cool recently — retry after ${floor.until.slice(0, 10)}` };
        return { ...out, decision: warmSlope ? 'DECREASE_SLOPE' : 'DECREASE_SHIFT', reasonCode: 'LIMIT_REACHED', safety: 'VETO', vetoCode: 'LIMIT_REACHED', reason: `${desc}: limit reached (slope ${sLo}–${sHi}, shift ${hLo}–${hHi})` };
      }
      if (st.medianRoomError - effect(to) < -band.lower) {
        // one step down would overshoot below the band (big steps for this house): stay a bit warm
        return { ...out, decision: 'NO_CHANGE', reasonCode: 'STEP_TOO_BIG',
          reason: `${desc}: one step lower would move the room by about ${effect(to).toFixed(2)} °C and make it too cool — keeping the curve` };
      }
      out.proposed = to;
      out.autoApply = out.confidence >= AUTO_CONFIDENCE;
      return { ...out, decision: code(to, -1), reasonCode, reason: `${desc}${out.autoApply ? '' : `: confidence ${out.confidence} % (below ${AUTO_CONFIDENCE} %)`}` };
    }

    // 3. in the comfort band
    if (goal === 'comfort') {
      return { ...out, decision: 'NO_CHANGE', reasonCode: 'WITHIN_TOLERANCE', reason: `${desc}: within ±${band.lower} °C, no change` };
    }
    // economy probe: even the coolest moments (10th percentile) are at the target → one step lower
    const margin = st.errorP10 >= -0.05 && st.medianRoomError >= 0.05 && st.comfortShare >= 0.9;
    if (!margin || st.samples < 48 || st.hours < 36) {
      return { ...out, decision: 'NO_CHANGE', reasonCode: 'IN_BAND_NO_MARGIN',
        reason: `${desc}: comfortable, no margin to save yet (coolest moments ${sgn(st.errorP10)} °C${st.samples < 48 || st.hours < 36 ? `, waiting for 48 samples over 36 h` : ''})` };
    }
    // slope first when the margin is larger in cold weather and cold weather was seen
    const prefSlope = dependsOnCold && spread > 0 && st.outdoorLow <= 5;
    const { to, floor } = down(prefSlope);
    if (!to) {
      if (floor) return { ...out, decision: 'NO_CHANGE', reasonCode: 'FLOOR_ACTIVE', floor: { slope: floor.slope, shift: floor.shift, until: floor.until },
        reason: `${desc}: comfortable; the next lower curve (${floor.slope} / ${floor.shift}) made the room too cool recently — retry after ${floor.until.slice(0, 10)}` };
      return { ...out, decision: 'NO_CHANGE', reasonCode: 'LIMIT_REACHED', reason: `${desc}: comfortable, already at the lowest allowed curve (slope ${sLo}, shift ${hLo})` };
    }
    if (st.medianRoomError - effect(to) < -0.1) {
      return { ...out, decision: 'NO_CHANGE', reasonCode: 'IN_BAND_NO_MARGIN',
        reason: `${desc}: comfortable; one step lower would move the room by about ${effect(to).toFixed(2)} °C, more than the margin (${sgn(st.medianRoomError)} °C)` };
    }
    const conf = base01 + 0.3 * clamp01((st.comfortShare - 0.85) / 0.13) + 0.25 * clamp01(0.5 + (st.errorP10 + 0.05) / 0.3);
    out.confidence = Math.round(conf * 100);
    out.proposed = to; out.probe = true;
    out.autoApply = out.confidence >= AUTO_CONFIDENCE;
    return { ...out, decision: code(to, -1), reasonCode: 'ECONOMY_PROBE',
      reason: `${desc}: comfortable with margin (coolest moments ${sgn(st.errorP10)} °C) — trying one step lower to save${out.autoApply ? '' : `: confidence ${out.confidence} % (below ${AUTO_CONFIDENCE} %)`}` };
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
    st.floors = (st.floors || []).filter(f => now - Date.parse(f.ts) < FLOOR_MAX_AGE_DAYS * 86400000);
    const pre = this.stats(a.samples);
    const minGap = pre && pre.medianRoomError < -BAND[this.goal].lower ? 24 : 48;
    if (st.lastChange && now - Date.parse(st.lastChange) < minGap * 3600 * 1000) {
      return save({ ...cur, decision: 'WAIT', reasonCode: 'WAITING_EFFECT', reason: `waiting for the effect of the last change (${minGap} h)` });
    }
    const d: CurveDecision = { ...cur, ...this.decide(a, info.curve, st.baseline, info.limits, { lastStep: st.lastStep, floors: st.floors, now, stepEffect: st.stepEffect }) };
    this.learn(st, d, info.curve, now);
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

  /**
   * What the loop learns (no rollback that stops anything):
   *   room too cool at a curve → that curve becomes a temporary floor (not used again for
   *                              retryDays, doubled after every new failure at it) and the
   *                              decision raises the curve one step
   *   step down + room in the band → the lower curve is kept, the next probe can follow
   */
  private learn(st: TunerState, d: CurveDecision, cur: Curve, now: number) {
    if (!d.stats || d.decision === 'WAIT') return;
    const ls = st.lastStep;
    const h = ls ? st.history.slice().reverse().find(x => x.ts === ls.ts) : undefined;
    const tooCool = d.decision.startsWith('INCREASE') && ['ROOM_COLD', 'ROOM_COLD_WHEN_COLD_OUTSIDE', 'HIGH_FLOW_FOR_CURRENT_OUTDOOR', 'LIMIT_REACHED'].includes(d.reasonCode);
    if (tooCool) {
      // this curve is too low: remember it so that "too warm" or an economy probe does not
      // come straight back to it (no ping-pong); raising for comfort is never blocked
      const prev = (st.floors || []).find(f => f.slope === cur.slope && f.shift === cur.shift);
      const since = st.lastChange ? Date.parse(st.lastChange) : 0;
      if (prev && Date.parse(prev.ts) >= since) return;   // already recorded while at this curve
      const fails = (prev?.fails || 0) + 1;
      const until = new Date(now + this.retryDays * Math.pow(2, fails - 1) * 86400000).toISOString();
      st.floors = [...(st.floors || []).filter(f => f !== prev), { slope: cur.slope, shift: cur.shift, ts: new Date(now).toISOString(), fails, until }];
      if (ls && ls.dir < 0 && h) h.outcome = 'too cool';
      this.measureEffect(st, ls, d);
      d.floor = { slope: cur.slope, shift: cur.shift, until };
      this.platform.log.info(`🌡️ Heating curve: ${cur.slope} / ${cur.shift} is too low (room ${d.stats.medianRoomError} °C) — not tried again before ${until.slice(0, 10)}`);
      return;
    }
    if (ls && ls.dir < 0 && h && !h.outcome) h.outcome = 'kept';
    this.measureEffect(st, ls, d);
    st.lastStep = undefined;
  }

  /** Learns how much one step moves the room (exponential average, used to avoid overshooting). */
  private measureEffect(st: TunerState, ls: LastStep | undefined, d: CurveDecision) {
    if (!ls || typeof ls.before !== 'number' || !d.stats) return;
    const knob: 'slope' | 'shift' = ls.from.slope !== ls.to.slope ? 'slope' : 'shift';
    const moved = (d.stats.medianRoomError - ls.before) * ls.dir;   // expected positive
    if (!(moved > 0.02 && moved < 2)) return;                        // weather noise: ignore
    const e = st.stepEffect || { shift: null, slope: null };
    e[knob] = r2(e[knob] === null ? moved : 0.5 * e[knob]! + 0.5 * moved);
    st.stepEffect = e;
  }

  private async apply(t: Target, from: Curve, to: Curve, why: string, auto: boolean, st: TunerState, d?: CurveDecision) {
    const ok = await this.platform.viessmannAPI.executeCommand(t.installationId, t.gatewaySerial, t.deviceId,
      `heating.circuits.${t.circuit}.heating.curve`, 'setCurve', { slope: to.slope, shift: to.shift });
    if (!ok) throw new Error('setCurve refused by the Viessmann API');
    st.lastChange = new Date().toISOString();
    st.lastResult = `changed: ${why}`;
    st.history.push({ ts: st.lastChange, from, to, reason: why, auto, confidence: d?.confidence, decision: d?.decision, probe: !!d?.probe });
    st.lastStep = { from, to, dir: flowAt0(to) > flowAt0(from) ? 1 : -1, ts: st.lastChange, probe: !!d?.probe, before: d?.stats?.medianRoomError };
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
