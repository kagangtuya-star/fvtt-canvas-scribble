import { LIMITS } from "../constants.ts";
import { quantizePoints } from "../core/codec.ts";
import { simplifyToLimit } from "../core/geometry.ts";

/**
 * Pointer samples → stored stroke points.
 *
 * Pressure: a pen's real `PointerEvent.pressure` is used (lightly filtered).
 * Mice and touch report no usable pressure, so a pressure value is derived
 * from smoothed speed (fast = thinner) at input time and *stored* — every
 * client then renders the identical shape, which perfect-freehand's own
 * `simulatePressure` (dependent on point spacing and timing) would not give.
 *
 * Streamline is applied here too, with perfect-freehand's interpolation, so
 * renderers can draw stored points without further lag.
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
}

/** True when the sample carries real pressure (pens; not the 0.5 default of mice). */
export const hasRealPressure = (s: Pick<InputSample, "pointerType" | "pressure">): boolean =>
  s.pointerType === "pen" && s.pressure > 0 && s.pressure !== 0.5;

/** Tilt magnitude 0 (upright) … 1 (flat). */
export const tiltAmount = (s: Pick<InputSample, "tiltX" | "tiltY">): number =>
  Math.min(1, Math.hypot(s.tiltX ?? 0, s.tiltY ?? 0) / 75);

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
  /** Minimum spacing of stored points (space units; ≈ 0.6 screen px). */
  minDistance: number;
  /** Simplification tolerance (space units). */
  tolerance: number;
}

export class StrokeRecorder {
  readonly #o: RecorderOptions;
  readonly #pressure: PressureModel;
  #points: number[] = [];
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

  get last(): InputSample | null {
    return this.#raw;
  }

  add(s: InputSample): void {
    let p = this.#pressure.next(s);
    if (this.#o.usesTilt && this.#o.usesPressure) p = Math.min(1, p * (1 + 0.7 * tiltAmount(s)));
    this.#lastP = p;
    this.#raw = s;
    if (!this.#first) {
      this.#first = s;
      this.#sx = s.x;
      this.#sy = s.y;
      this.#points.push(s.x, s.y, p);
      return;
    }
    const t = 0.15 + (1 - this.#o.streamline) * 0.85;
    this.#sx += (s.x - this.#sx) * t;
    this.#sy += (s.y - this.#sy) * t;
    const n = this.#points.length;
    if (Math.hypot(this.#sx - this.#points[n - 3]!, this.#sy - this.#points[n - 2]!) < this.#o.minDistance) {
      this.#points[n - 1] = Math.max(this.#points[n - 1]!, p * 0.5 + this.#points[n - 1]! * 0.5);
      return;
    }
    this.#points.push(this.#sx, this.#sy, p);
  }

  /** Points for live display: includes the un-streamlined tip so the ink meets the cursor. */
  preview(): number[] {
    if (this.line) return this.#linePoints();
    const pts = this.#points.slice();
    const raw = this.#raw;
    const n = pts.length;
    if (raw && n >= 3 && Math.hypot(raw.x - pts[n - 3]!, raw.y - pts[n - 2]!) > this.#o.minDistance * 0.5) {
      pts.push(raw.x, raw.y, this.#lastP);
    }
    return pts;
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
