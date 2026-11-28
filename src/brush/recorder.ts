import { LIMITS } from "../constants.ts";
import { quantizeAngles, quantizePoints } from "../core/codec.ts";
import { simplifyIndicesToLimit, simplifyToLimit } from "../core/geometry.ts";
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
 * Stabilization (One Euro Filter or Lazy Brush) and streamline are applied here
 * so renderers can draw stored points deterministically without lag.
 */

export type PressureMode = "auto" | "simulate" | "off";

export interface InputSample {
  /** Position in space units. */
  x: number;
  y: number;
  /** Event time (ms, `PointerEvent.timeStamp`). */
  time: number;
  pressure: number;
  pointerType: string;
  tiltX?: number;
  tiltY?: number;
  /** Stylus barrel rotation in degrees (0..359) from `PointerEvent.twist`. */
  twist?: number;
}

/** True when the sample carries real pressure (pens; not the 0.5 default of mice). */
export const hasRealPressure = (s: Pick<InputSample, "pointerType" | "pressure">): boolean =>
  s.pointerType === "pen" && s.pressure > 0 && s.pressure !== 0.5;

/** Tilt magnitude 0 (upright) … 1 (flat). */
export const tiltAmount = (s: Pick<InputSample, "tiltX" | "tiltY">): number =>
  Math.min(1, Math.hypot(s.tiltX ?? 0, s.tiltY ?? 0) / 75);

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
  /** Stabilizer algorithm (default "off"). */
  stabilizerMode?: StabilizerMode;
  /** Stabilizer strength 0..1 (default 0). */
  stabilizerStrength?: number;
  /** Space units per CSS pixel (used for lazy-brush radius). */
  unitsPerPx?: number;
  /** Minimum spacing of stored points (space units; ≈ 0.6 screen px). */
  minDistance: number;
  /** Simplification tolerance (space units). */
  tolerance: number;
}

export class StrokeRecorder {
  readonly #o: RecorderOptions;
  readonly #pressure: PressureModel;
  readonly #stabilizer: StrokeStabilizer;
  #points: number[] = [];
  #angles: number[] = [];
  #hasPenAngles = false;
  #lastAng = 0;
  #sx = 0;
  #sy = 0;
  #first: InputSample | null = null;
  #raw: InputSample | null = null;
  #lastP = 0.5;
  /** Straight-line mode (Shift while drawing). */
  line = false;

  constructor(o: RecorderOptions) {
    this.#o = o;
    this.#pressure = new PressureModel(o.usesPressure ? o.pressureMode : "off", o.width);
    this.#stabilizer = new StrokeStabilizer({
      mode: o.stabilizerMode ?? "off",
      strength: o.stabilizerStrength ?? 0,
      unitsPerPx: o.unitsPerPx ?? 1,
    });
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
      this.#points.push(filtered.x, filtered.y, p);
      if (this.#o.recordAngles) this.#angles.push(this.#lastAng);
      return;
    }
    const t = 0.15 + (1 - this.#o.streamline) * 0.85;
    this.#sx += (filtered.x - this.#sx) * t;
    this.#sy += (filtered.y - this.#sy) * t;
    const n = this.#points.length;
    const dx = this.#sx - this.#points[n - 3]!;
    const dy = this.#sy - this.#points[n - 2]!;
    if (Math.hypot(dx, dy) < this.#o.minDistance) {
      this.#points[n - 1] = Math.max(this.#points[n - 1]!, p * 0.5 + this.#points[n - 1]! * 0.5);
      return;
    }
    // Mouse fallback for dynamic angle brushes: smoothly follow movement heading when no real pen angle exists.
    if (this.#o.recordAngles && penAng === null && !this.#hasPenAngles) {
      const heading = Math.atan2(dy, dx);
      let d = ((heading - this.#lastAng + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      if (d < -Math.PI) d += Math.PI * 2;
      this.#lastAng = this.#angles.length <= 1 ? heading : this.#lastAng + d * 0.35;
    }
    this.#points.push(this.#sx, this.#sy, p);
    if (this.#o.recordAngles) this.#angles.push(this.#lastAng);
  }

  /** Points for live display: includes the un-streamlined tip so the ink meets the cursor. */
  preview(): number[] {
    if (this.line) return this.#linePoints();
    const pts = this.#points.slice();
    const raw = this.#raw;
    const n = pts.length;
    // Don't snap straight to raw cursor when lazy-brush is active (the whole point is string lag).
    if (
      !this.#stabilizer.active &&
      raw &&
      n >= 3 &&
      Math.hypot(raw.x - pts[n - 3]!, raw.y - pts[n - 2]!) > this.#o.minDistance * 0.5
    ) {
      pts.push(raw.x, raw.y, this.#lastP);
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

  #linePoints(): number[] {
    const a = this.#first;
    const b = this.#raw;
    if (!a || !b) return [];
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
    const pts = this.preview();
    if (this.line) return quantizePoints(pts);
    return quantizePoints(simplifyToLimit(pts, this.#o.tolerance, LIMITS.maxPointsPerItem));
  }

  /** Storage-ready points + aligned quantised per-point pen angles (when recorded). */
  finishWithAngles(): { points: number[]; angles?: number[] } {
    const rawPts = this.preview();
    const rawAng = this.previewAngles();
    if (this.line) {
      const points = quantizePoints(rawPts);
      if (!rawAng) return { points };
      return { points, angles: quantizeAngles(new Array<number>(points.length / 3).fill(this.#lastAng)) };
    }
    if (!rawAng) return { points: quantizePoints(simplifyToLimit(rawPts, this.#o.tolerance, LIMITS.maxPointsPerItem)) };
    const kept = simplifyIndicesToLimit(rawPts, this.#o.tolerance, LIMITS.maxPointsPerItem, rawAng);
    return {
      points: quantizePoints(kept.flatMap((i) => rawPts.slice(i * 3, i * 3 + 3))),
      angles: quantizeAngles(kept.map((i) => rawAng[i]!)),
    };
  }

  /**
   * Continue a long stroke in a new item: returns a recorder seeded with the
   * current tip so the chained item joins seamlessly.
   */
  chain(): StrokeRecorder {
    const next = new StrokeRecorder(this.#o);
    const tip = this.#raw;
    if (tip) next.add({ ...tip });
    return next;
  }
}
