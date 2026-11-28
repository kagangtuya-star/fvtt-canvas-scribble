import { LIMITS } from "../constants.ts";
import { quantizeAngles, quantizePoints, quantizeUnits } from "../core/codec.ts";
import { simplifyIndicesToLimit, simplifyToLimit } from "../core/geometry.ts";
import type { SimplifyChannel } from "../core/geometry.ts";
import { DYN_TARGETS } from "../core/types.ts";
import type { DynamicsSpec } from "../core/types.ts";
import { LineConstraint } from "../assist/constraint.ts";
import type { StrokeConstraint } from "../assist/constraint.ts";
import { compileCurve } from "./curve.ts";
import { StrokeStabilizer } from "./stabilizer.ts";
import type { StabilizerMode } from "./stabilizer.ts";

/**
 * Pointer samples → stored stroke points (and optional per-point nib angles).
 *
 * Pressure: a pen's real `PointerEvent.pressure` is used (lightly filtered).
 * Mice and touch report no usable pressure, so a pressure value is derived
 * from smoothed speed (fast = thinner) at input time and *stored* — every
 * client then renders the identical shape, which perfect-freehand's own
 * `simulatePressure` (dependent on point spacing and timing) would not give.
 *
 * Nib angle: pens with barrel rotation (`PointerEvent.twist`) or tilt
 * (`tiltX`/`tiltY`) record real angles; mice and touch fall back gracefully
 * to smoothed stroke-direction simulation so tilt/twist brushes remain
 * expressive even without a drawing tablet.
 *
 * Dynamics channels: when a brush's dynamics use them, pen tilt (0 upright …
 * 1 flat) and drawing speed (0..1, measured on the raw samples in CSS pixels
 * per millisecond, so zoom does not change the feel) are stored per point,
 * parallel to the points, and kept aligned through simplification.
 *
 * Pipeline per sample: dejitter (One Euro) → stabilizer (lazy / average) →
 * streamline → ruler constraint → stored point. Everything happens here so
 * renderers draw stored points deterministically without lag. On pen up the
 * stabilizer's tail is caught up and optional curve smoothing is applied.
 */

export type PressureMode = "auto" | "simulate" | "off";

export interface InputSample {
  /** Position in space units. */
  x: number;
  y: number;
  /** Original CSS position for speed, independent of the transform into stroke space. */
  client?: { x: number; y: number };
  /** Event time (ms, `PointerEvent.timeStamp`). */
  time: number;
  pressure: number;
  pointerType: string;
  tiltX?: number;
  tiltY?: number;
  /** Stylus barrel rotation in degrees (0..359) from `PointerEvent.twist`. */
  twist?: number;
  /** Pen altitude in radians (π/2 = upright) from `PointerEvent.altitudeAngle`, when available. */
  altitudeAngle?: number;
}

/** True when the sample carries real pressure (pens; not the 0.5 default of mice). */
export const hasRealPressure = (s: Pick<InputSample, "pointerType" | "pressure">): boolean =>
  s.pointerType === "pen" && s.pressure > 0 && s.pressure !== 0.5;

/** Tilt magnitude 0 (upright) … 1 (flat). */
export const tiltAmount = (s: Pick<InputSample, "tiltX" | "tiltY">): number =>
  Math.min(1, Math.hypot(s.tiltX ?? 0, s.tiltY ?? 0) / 75);

/** Tilt sensor 0 (upright) … 1 (flat): pen altitude when reported, otherwise tiltX/tiltY; 0 for mice and touch. */
export function tiltOf(s: Pick<InputSample, "pointerType" | "tiltX" | "tiltY" | "altitudeAngle">): number {
  if (s.pointerType !== "pen") return 0;
  const alt = s.altitudeAngle;
  if (typeof alt === "number" && Number.isFinite(alt) && alt >= 0 && alt <= Math.PI / 2)
    return Math.min(1, Math.max(0, 1 - alt / (Math.PI / 2)));
  return tiltAmount(s);
}

/** Speed (CSS px/ms) that maps to ≈ 0.63; normalised speed is `1 − exp(−v / SPEED_REF)`. */
export const SPEED_REF = 1.2;
/** Time constant of the speed smoothing (ms). */
const SPEED_SMOOTH_MS = 30;

/** Smoothed, normalised drawing speed 0..1 from pointer positions in CSS pixels. */
export class SpeedModel {
  readonly #unitsPerPx: number;
  #last: InputSample | null = null;
  #v = 0;

  constructor(unitsPerPx: number) {
    this.#unitsPerPx = Math.max(1e-6, unitsPerPx);
  }

  get value(): number {
    return 1 - Math.exp(-this.#v / SPEED_REF);
  }

  next(s: InputSample): number {
    const prev = this.#last;
    if (!prev) {
      this.#last = s;
      return this.value;
    }
    const dt = s.time - prev.time;
    // Samples sharing a timestamp: keep the older reference so the distance accumulates.
    if (!(dt > 0)) return this.value;
    this.#last = s;
    const distance =
      s.client && prev.client
        ? Math.hypot(s.client.x - prev.client.x, s.client.y - prev.client.y)
        : Math.hypot(s.x - prev.x, s.y - prev.y) / this.#unitsPerPx;
    const instant = distance / dt;
    const a = 1 - Math.exp(-Math.min(dt, 250) / SPEED_SMOOTH_MS);
    this.#v += (instant - this.#v) * a;
    return this.value;
  }

  copy(): SpeedModel {
    const out = new SpeedModel(this.#unitsPerPx);
    out.#last = this.#last;
    out.#v = this.#v;
    return out;
  }
}

/** Extract real pen nib angle (radians) from twist or tilt azimuth, or `null` if unavailable. */
export function realPenAngle(s: Pick<InputSample, "pointerType" | "tiltX" | "tiltY" | "twist">): number | null {
  if (s.pointerType !== "pen") return null;
  if (typeof s.twist === "number" && Number.isFinite(s.twist) && s.twist !== 0) {
    return (s.twist * Math.PI) / 180;
  }
  const tx = s.tiltX ?? 0;
  const ty = s.tiltY ?? 0;
  if (Math.hypot(tx, ty) >= 6) return Math.atan2(ty, tx);
  return null;
}

export class PressureModel {
  readonly #mode: PressureMode;
  readonly #width: number;
  #last: InputSample | null = null;
  #speed = 0;
  #value = 0.5;
  #real = false;

  constructor(mode: PressureMode, width: number) {
    this.#mode = mode;
    this.#width = Math.max(0.01, width);
  }

  get usesRealPressure(): boolean {
    return this.#real;
  }

  next(s: InputSample): number {
    if (this.#mode === "off") return 0.5;
    if (this.#mode === "auto" && (this.#real || hasRealPressure(s))) {
      this.#real = true;
      const target = Math.min(1, Math.max(0.04, s.pressure));
      this.#value = this.#last ? this.#value + (target - this.#value) * 0.5 : target;
      this.#last = s;
      return this.#value;
    }
    const prev = this.#last;
    this.#last = s;
    if (!prev) {
      this.#value = 0.6;
      return this.#value;
    }
    const dt = Math.max(1, s.time - prev.time);
    // Speed in "stroke widths per 16 ms", so the feel is independent of size and zoom.
    const instant = (Math.hypot(s.x - prev.x, s.y - prev.y) / this.#width) * (16 / dt);
    this.#speed += (instant - this.#speed) * 0.2;
    const target = 0.82 - Math.min(1, this.#speed / 2.4) * 0.48;
    this.#value += (target - this.#value) * 0.14;
    return Math.min(0.9, Math.max(0.3, this.#value));
  }
}

export interface RecorderOptions {
  /** Stroke width in space units. */
  width: number;
  /** 0..1, perfect-freehand semantics. */
  streamline: number;
  pressureMode: PressureMode;
  /** Brush records pressure? */
  usesPressure: boolean;
  /** Brush broadens with tilt? */
  usesTilt: boolean;
  /** Record parallel per-point nib angles (from pen twist/tilt or mouse simulation)? */
  recordAngles?: boolean;
  /** Record the per-point tilt channel (tilt dynamics)? */
  recordTilt?: boolean;
  /** Record the per-point speed channel (speed dynamics)? */
  recordSpeed?: boolean;
  /** Custom mappings whose sensor responses should survive point simplification. */
  dynamics?: DynamicsSpec;
  /** Stabilizer algorithm (default "off"). */
  stabilizerMode?: StabilizerMode;
  /** Stabilizer strength 0..1 (default 0). */
  stabilizerStrength?: number;
  /** One Euro dejitter strength 0..1 (default 0). */
  dejitter?: number;
  /** Ruler constraint applied after streamline (shared by chained items of one stroke). */
  constraint?: StrokeConstraint | null;
  /** Post-stroke curve smoothing 0..1 (default 0). */
  smoothing?: number;
  /** Space units per CSS pixel (used for lazy-brush radius). */
  unitsPerPx?: number;
  /** Minimum spacing of stored points (space units; ≈ 0.6 screen px). */
  minDistance: number;
  /** Simplification tolerance (space units). */
  tolerance: number;
}

function simplificationChannels(
  points: readonly number[],
  { tilt, speed }: { tilt?: number[]; speed?: number[] },
  dynamics?: DynamicsSpec,
): SimplifyChannel[] {
  const codes = { p: new Set<string>(), t: new Set<string>(), v: new Set<string>() };
  if (dynamics) {
    for (const key of DYN_TARGETS) {
      const target = dynamics[key];
      if (!target || target.lo === target.hi) continue;
      for (const { s, c } of target.src) if (s === "p" || s === "t" || s === "v") codes[s].add(c);
    }
  }
  const channels: SimplifyChannel[] = [];
  const add = (values: readonly number[], curves: Set<string>) =>
    channels.push({ values, curves: [...curves].filter((c) => c !== "lin").map(compileCurve) });
  if (codes.p.size)
    add(
      points.filter((_, i) => i % 3 === 2),
      codes.p,
    );
  if (tilt) add(tilt, codes.t);
  if (speed) add(speed, codes.v);
  return channels;
}

export class StrokeRecorder {
  readonly #o: RecorderOptions;
  readonly #pressure: PressureModel;
  readonly #stabilizer: StrokeStabilizer;
  #speedModel: SpeedModel;
  #points: number[] = [];
  #angles: number[] = [];
  #tilt: number[] = [];
  #speed: number[] = [];
  #lastT = 0;
  #lastV = 0;
  #hasPenAngles = false;
  #lastAng = 0;
  #sx = 0;
  #sy = 0;
  #first: InputSample | null = null;
  #raw: InputSample | null = null;
  #lastP = 0.5;
  #finishedTip = false;
  /** Straight-line mode (Shift while drawing). */
  line = false;

  constructor(o: RecorderOptions) {
    this.#o = o;
    this.#pressure = new PressureModel(o.usesPressure ? o.pressureMode : "off", o.width);
    this.#stabilizer = new StrokeStabilizer({
      mode: o.stabilizerMode ?? "off",
      strength: o.stabilizerStrength ?? 0,
      dejitter: o.dejitter ?? 0,
      unitsPerPx: o.unitsPerPx ?? 1,
    });
    this.#speedModel = new SpeedModel(o.unitsPerPx ?? 1);
  }

  /** Append the current dynamics channel values for a new stored point. */
  #pushChannels(): void {
    if (this.#o.recordTilt) this.#tilt.push(this.#lastT);
    if (this.#o.recordSpeed) this.#speed.push(this.#lastV);
  }

  /** Project through the ruler constraint; re-projects earlier points when the constraint locks. */
  #project(x: number, y: number): { x: number; y: number } {
    const c = this.#o.constraint;
    if (!c) return { x, y };
    const wasLocked = c.locked;
    const p = c.project(x, y);
    if (!wasLocked && c.locked) {
      const pts = this.#points;
      for (let i = 0; i + 2 < pts.length; i += 3) {
        const q = c.project(pts[i]!, pts[i + 1]!);
        pts[i] = q.x;
        pts[i + 1] = q.y;
      }
    }
    return p;
  }

  /** The stabilizer keeps converging while the pointer rests (feed repeated samples). */
  get needsTick(): boolean {
    return this.#stabilizer.needsTick && !this.line;
  }

  get pointCount(): number {
    return this.#points.length / 3;
  }

  /** Stored point budget reached: the caller chains a new item. */
  get full(): boolean {
    return this.#points.length / 3 >= LIMITS.maxPointsPerItem - 8;
  }

  get usesRealPressure(): boolean {
    return this.#pressure.usesRealPressure;
  }

  get usesRealAngles(): boolean {
    return this.#hasPenAngles;
  }

  get last(): InputSample | null {
    return this.#raw;
  }

  /** Stabilizer pointer & lagging brush coordinates (for Lazy Brush visual guide). */
  get stabilizerState(): {
    active: boolean;
    mode: StabilizerMode;
    pointer: { x: number; y: number };
    brush: { x: number; y: number };
  } {
    return { active: this.#stabilizer.active, mode: this.#stabilizer.mode, ...this.#stabilizer.state };
  }

  add(s: InputSample): void {
    let p = this.#pressure.next(s);
    if (this.#o.usesTilt && this.#o.usesPressure) p = Math.min(1, p * (1 + 0.7 * tiltAmount(s)));
    this.#lastP = p;
    this.#raw = s;
    if (this.#o.recordTilt) this.#lastT = tiltOf(s);
    if (this.#o.recordSpeed) this.#lastV = this.#speedModel.next(s);

    const penAng = this.#o.recordAngles ? realPenAngle(s) : null;
    if (penAng !== null) {
      this.#hasPenAngles = true;
      this.#lastAng = penAng;
    }

    const filtered = this.#stabilizer.filter(s.x, s.y, s.time);

    if (!this.#first) {
      this.#first = s;
      this.#sx = filtered.x;
      this.#sy = filtered.y;
      const q = this.#project(filtered.x, filtered.y);
      this.#points.push(q.x, q.y, p);
      if (this.#o.recordAngles) this.#angles.push(this.#lastAng);
      this.#pushChannels();
      return;
    }
    const t = 0.15 + (1 - this.#o.streamline) * 0.85;
    this.#sx += (filtered.x - this.#sx) * t;
    this.#sy += (filtered.y - this.#sy) * t;
    const q = this.#project(this.#sx, this.#sy);
    const n = this.#points.length;
    const dx = q.x - this.#points[n - 3]!;
    const dy = q.y - this.#points[n - 2]!;
    if (Math.hypot(dx, dy) < this.#o.minDistance) {
      this.#points[n - 1] = Math.max(this.#points[n - 1]!, p * 0.5 + this.#points[n - 1]! * 0.5);
      if (this.#o.recordTilt) this.#tilt[this.#tilt.length - 1] = this.#lastT;
      if (this.#o.recordSpeed) this.#speed[this.#speed.length - 1] = this.#lastV;
      return;
    }
    // Mouse fallback for dynamic angle brushes: smoothly follow movement heading when no real pen angle exists.
    if (this.#o.recordAngles && penAng === null && !this.#hasPenAngles) {
      const heading = Math.atan2(dy, dx);
      let d = ((heading - this.#lastAng + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      if (d < -Math.PI) d += Math.PI * 2;
      this.#lastAng = this.#angles.length <= 1 ? heading : this.#lastAng + d * 0.35;
    }
    this.#points.push(q.x, q.y, p);
    if (this.#o.recordAngles) this.#angles.push(this.#lastAng);
    this.#pushChannels();
  }

  /** Pin the lift-off point, optionally bridging the gap from the lagging brush. */
  finishTip(catchUp: boolean): void {
    const raw = this.#raw;
    if (this.#finishedTip || this.line || !raw) return;
    this.#finishedTip = true;
    if (!catchUp && this.#stabilizer.active) return;
    const append = (x: number, y: number, minDistance: number) => {
      const q = this.#project(x, y);
      const n = this.#points.length;
      if (n >= 3 && Math.hypot(q.x - this.#points[n - 3]!, q.y - this.#points[n - 2]!) <= minDistance) return;
      this.#points.push(q.x, q.y, this.#lastP);
      if (this.#o.recordAngles) this.#angles.push(this.#lastAng);
      this.#pushChannels();
    };
    if (catchUp) for (const p of this.#stabilizer.catchUp().slice(0, -1)) append(p.x, p.y, this.#o.minDistance);
    append(raw.x, raw.y, 0);
  }

  /** Points for live display: includes the un-streamlined tip so the ink meets the cursor. */
  preview(): number[] {
    if (this.line) return this.#linePoints();
    const pts = this.#points.slice();
    const raw = this.#raw;
    const n = pts.length;
    // Don't snap straight to raw cursor when lazy-brush is active (the whole point is string lag).
    if (!this.#finishedTip && !this.#stabilizer.active && raw && n >= 3) {
      const tip = this.#o.constraint?.locked ? this.#o.constraint.project(raw.x, raw.y) : raw;
      if (Math.hypot(tip.x - pts[n - 3]!, tip.y - pts[n - 2]!) > this.#o.minDistance * 0.5)
        pts.push(tip.x, tip.y, this.#lastP);
    }
    return pts;
  }

  /** Preview per-point angles matching `preview()`, or `undefined` when no angles are recorded. */
  previewAngles(): number[] | undefined {
    if (!this.#o.recordAngles || !this.#hasPenAngles) return undefined;
    const ptsCount = this.preview().length / 3;
    const ang = this.#angles.slice(0, ptsCount);
    while (ang.length < ptsCount) ang.push(this.#lastAng);
    return ang;
  }

  /** Preview dynamics channels matching `preview()` (absent when not recorded). */
  previewChannels(count = this.preview().length / 3): { tilt?: number[]; speed?: number[] } {
    const fit = (src: number[], last: number): number[] => {
      if (this.line) return new Array<number>(count).fill(last);
      const out = src.slice(0, count);
      while (out.length < count) out.push(last);
      return out;
    };
    const out: { tilt?: number[]; speed?: number[] } = {};
    if (this.#o.recordTilt) out.tilt = fit(this.#tilt, this.#lastT);
    if (this.#o.recordSpeed) out.speed = fit(this.#speed, this.#lastV);
    return out;
  }

  /** Live item data: preview points plus any recorded angles and dynamics channels. */
  previewData(): { points: number[]; angles?: number[]; tilt?: number[]; speed?: number[] } {
    const points = this.preview();
    const angles = this.previewAngles();
    return { points, ...(angles ? { angles } : {}), ...this.previewChannels(points.length / 3) };
  }

  #linePoints(): number[] {
    const a = this.#first;
    const raw = this.#raw;
    if (!a || !raw) return [];
    const c = this.#o.constraint;
    const b = c instanceof LineConstraint ? c.project(raw.x, raw.y) : raw;
    const p = this.#o.usesPressure ? 0.62 : 0.5;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.min(48, Math.ceil(len / Math.max(this.#o.minDistance * 4, this.#o.width))));
    const out: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      out.push(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, p);
    }
    return out;
  }

  /** Storage-ready points: simplified (within the per-item budget) and quantised. */
  finish(): number[] {
    const pts = this.#smoothed(this.preview());
    if (this.line) return quantizePoints(pts);
    return quantizePoints(simplifyToLimit(pts, this.#o.tolerance, LIMITS.maxPointsPerItem));
  }

  /** Post-stroke smoothing (point count unchanged, so per-point angles stay aligned). */
  #smoothed(pts: number[]): number[] {
    if (this.line || this.#o.constraint) return pts;
    return smoothPolyline(pts, this.#o.smoothing ?? 0);
  }

  /** Storage-ready points + aligned quantised per-point pen angles and dynamics channels (when recorded). */
  finishWithAngles(): { points: number[]; angles?: number[]; tilt?: number[]; speed?: number[] } {
    const rawPts = this.#smoothed(this.preview());
    const rawAng = this.previewAngles();
    const ch = this.previewChannels(rawPts.length / 3);
    const units = (v: number[] | undefined, pick: (a: number[]) => number[]) =>
      v ? quantizeUnits(pick(v)) : undefined;
    const withChannels = (
      base: { points: number[]; angles?: number[] },
      pick: (a: number[]) => number[],
    ): { points: number[]; angles?: number[]; tilt?: number[]; speed?: number[] } => {
      const tilt = units(ch.tilt, pick);
      const speed = units(ch.speed, pick);
      return { ...base, ...(tilt ? { tilt } : {}), ...(speed ? { speed } : {}) };
    };
    if (this.line) {
      const points = quantizePoints(rawPts);
      const same = (a: number[]) => a;
      if (!rawAng) return withChannels({ points }, same);
      return withChannels(
        { points, angles: quantizeAngles(new Array<number>(points.length / 3).fill(this.#lastAng)) },
        same,
      );
    }
    if (!rawAng && !ch.tilt && !ch.speed && !this.#o.dynamics)
      return { points: quantizePoints(simplifyToLimit(rawPts, this.#o.tolerance, LIMITS.maxPointsPerItem)) };
    const channels = simplificationChannels(rawPts, ch, this.#o.dynamics);
    const kept = simplifyIndicesToLimit(rawPts, this.#o.tolerance, LIMITS.maxPointsPerItem, rawAng, channels);
    const pick = (a: number[]) => kept.map((i) => a[i]!);
    return withChannels(
      {
        points: quantizePoints(kept.flatMap((i) => rawPts.slice(i * 3, i * 3 + 3))),
        ...(rawAng ? { angles: quantizeAngles(pick(rawAng)) } : {}),
      },
      pick,
    );
  }

  /**
   * Continue a long stroke in a new item: returns a recorder seeded with the
   * current tip so the chained item joins seamlessly.
   */
  chain(): StrokeRecorder {
    const next = new StrokeRecorder(this.#o);
    // Speed continues across the junction instead of restarting from rest.
    next.#speedModel = this.#speedModel.copy();
    const tip = this.#raw;
    if (tip) next.add({ ...tip });
    return next;
  }
}

/**
 * Laplacian smoothing of a stroke's x/y (endpoints pinned, pressure kept):
 * `strength` 0..1 maps to 0..24 passes, each moving every point halfway to
 * the average of its neighbours.
 */
export function smoothPolyline(flat: readonly number[], strength: number): number[] {
  const out = flat.slice();
  const n = out.length / 3;
  const passes = Math.round(Math.min(1, Math.max(0, strength)) * 24);
  if (n < 3 || passes <= 0) return out;
  const tmp = new Float64Array(n * 2);
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 1; i < n - 1; i++) {
      tmp[i * 2] = (out[(i - 1) * 3]! + out[(i + 1) * 3]!) / 2;
      tmp[i * 2 + 1] = (out[(i - 1) * 3 + 1]! + out[(i + 1) * 3 + 1]!) / 2;
    }
    for (let i = 1; i < n - 1; i++) {
      out[i * 3] = out[i * 3]! + (tmp[i * 2]! - out[i * 3]!) * 0.5;
      out[i * 3 + 1] = out[i * 3 + 1]! + (tmp[i * 2 + 1]! - out[i * 3 + 1]!) * 0.5;
    }
  }
  return out;
}
