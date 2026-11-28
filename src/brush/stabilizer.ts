import { LazyBrush } from "lazy-brush";
import { clamp } from "../core/util.ts";

/**
 * Real-time pointer stabilization, in two stages that can be combined:
 *
 *  1. Dejitter (`dejitter` 0..1): One Euro adaptive low-pass filter (Casiez et
 *     al., CHI 2012) — removes hand tremor at slow speeds while staying
 *     responsive at fast speeds. Runs in CSS pixels, so it feels the same at
 *     every zoom level.
 *  2. Stabilizer mode (deliberate lag for long clean lines):
 *     - `off`
 *     - `lazy`:    string-pull stabilizer powered by `lazy-brush`
 *     - `average`: time-window Gaussian average of recent samples (SAI/Krita
 *                  style); keeps converging while the pointer rests (`tick`)
 *
 * On pen up, {@link StrokeStabilizer.catchUp} returns the tail from the lagging
 * brush to the pointer so the stroke ends where the pen was lifted.
 */

export type StabilizerMode = "off" | "lazy" | "average";
export const STABILIZER_MODES: readonly StabilizerMode[] = ["off", "lazy", "average"];

class LowPass {
  #y = 0;
  #init = false;

  filter(x: number, alpha: number): number {
    if (!this.#init) {
      this.#y = x;
      this.#init = true;
      return x;
    }
    this.#y = alpha * x + (1 - alpha) * this.#y;
    return this.#y;
  }

  get value(): number {
    return this.#y;
  }
}

class OneEuro1D {
  readonly #x = new LowPass();
  readonly #dx = new LowPass();
  readonly #minCutoff: number;
  readonly #beta: number;
  readonly #dCutoff: number;

  constructor(minCutoff: number, beta: number, dCutoff = 1.0) {
    this.#minCutoff = minCutoff;
    this.#beta = beta;
    this.#dCutoff = dCutoff;
  }

  static alpha(cutoff: number, dtSec: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dtSec);
  }

  filter(value: number, dtSec: number, first: boolean): number {
    const dt = Math.max(1e-3, dtSec);
    const dValue = first ? 0 : (value - this.#x.value) / dt;
    const ed = this.#dx.filter(dValue, OneEuro1D.alpha(this.#dCutoff, dt));
    const cutoff = this.#minCutoff + this.#beta * Math.abs(ed);
    return this.#x.filter(value, OneEuro1D.alpha(cutoff, dt));
  }
}

/** Two-axis One Euro filter on CSS-pixel coordinates. */
export class OneEuro2D {
  readonly #x: OneEuro1D;
  readonly #y: OneEuro1D;
  #last: number | null = null;

  /** `strength` 0..1: higher = smoother at rest. */
  constructor(strength: number) {
    const s = clamp(strength, 0, 1);
    // Lower minCutoff = stronger smoothing at rest; beta (per px/s) keeps fast strokes responsive.
    const minCutoff = 3.2 - s * 2.75; // 3.2 Hz → 0.45 Hz
    const beta = Math.max(0.002, 0.025 - s * 0.02);
    this.#x = new OneEuro1D(minCutoff, beta);
    this.#y = new OneEuro1D(minCutoff, beta);
  }

  filter(x: number, y: number, timeMs: number): { x: number; y: number } {
    const first = this.#last === null;
    const dt = first ? 1 / 60 : Math.max(1e-3, (timeMs - this.#last!) / 1000);
    this.#last = timeMs;
    return { x: this.#x.filter(x, dt, first), y: this.#y.filter(y, dt, first) };
  }
}

/** Gaussian-weighted average of the samples of the last `windowMs`. */
class WindowAverage {
  readonly #window: number;
  readonly #sigma: number;
  readonly #samples: { x: number; y: number; t: number }[] = [];

  constructor(windowMs: number) {
    this.#window = windowMs;
    this.#sigma = windowMs / 2.5;
  }

  filter(x: number, y: number, t: number): { x: number; y: number } {
    const list = this.#samples;
    list.push({ x, y, t });
    while (list.length > 1 && t - list[0]!.t > this.#window) list.shift();
    if (list.length > 256) list.splice(0, list.length - 256);
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (const s of list) {
      const age = (t - s.t) / this.#sigma;
      const w = Math.exp(-0.5 * age * age);
      sx += s.x * w;
      sy += s.y * w;
      sw += w;
    }
    return sw > 0 ? { x: sx / sw, y: sy / sw } : { x, y };
  }
}

export interface StabilizerOptions {
  mode: StabilizerMode;
  /** 0..1 stabilizer strength. */
  strength: number;
  /** 0..1 One Euro dejitter strength (0 = off). */
  dejitter?: number;
  /** Space units per CSS pixel: filters work in CSS px so zoom does not change their feel. */
  unitsPerPx: number;
}

export class StrokeStabilizer {
  readonly #mode: StabilizerMode;
  readonly #u: number;
  readonly #euro: OneEuro2D | null = null;
  readonly #lazy: LazyBrush | null = null;
  readonly #average: WindowAverage | null = null;
  #pointer: { x: number; y: number } = { x: 0, y: 0 };
  #brush: { x: number; y: number } = { x: 0, y: 0 };
  #started = false;

  constructor(opts: StabilizerOptions) {
    this.#u = Math.max(1e-6, opts.unitsPerPx);
    const strength = clamp(opts.strength, 0, 1);
    const dejitter = clamp(opts.dejitter ?? 0, 0, 1);
    if (dejitter > 0.01) this.#euro = new OneEuro2D(dejitter);
    this.#mode = strength > 0.01 ? opts.mode : "off";
    if (this.#mode === "lazy") {
      const radiusPx = 4 + strength * 44; // 4..48 CSS px string
      this.#lazy = new LazyBrush({ enabled: true, radius: radiusPx });
    } else if (this.#mode === "average") {
      this.#average = new WindowAverage(25 + strength * 175); // 25..200 ms
    }
  }

  get mode(): StabilizerMode {
    return this.#mode;
  }

  /** Adds deliberate lag (the brush trails the pointer). */
  get active(): boolean {
    return this.#mode !== "off";
  }

  /** Any filtering at all (dejitter or a stabilizer)? */
  get filtering(): boolean {
    return this.active || !!this.#euro;
  }

  /** The average keeps converging while the pointer rests: feed repeated samples. */
  get needsTick(): boolean {
    return this.#mode === "average";
  }

  /** Latest raw pointer & lagging brush position (for optional string indicator). */
  get state(): { pointer: { x: number; y: number }; brush: { x: number; y: number } } {
    return { pointer: this.#pointer, brush: this.#brush };
  }

  filter(x: number, y: number, timeMs: number): { x: number; y: number } {
    this.#pointer = { x, y };
    const u = this.#u;
    let px = x / u;
    let py = y / u;
    if (this.#euro) ({ x: px, y: py } = this.#euro.filter(px, py, timeMs));
    if (this.#lazy) {
      this.#lazy.update({ x: px, y: py }, { both: !this.#started });
      const b = this.#lazy.getBrushCoordinates();
      px = b.x;
      py = b.y;
    } else if (this.#average) ({ x: px, y: py } = this.#average.filter(px, py, timeMs));
    this.#started = true;
    this.#brush = { x: px * u, y: py * u };
    return this.#brush;
  }

  /** Points from the lagging brush to the last pointer position (space units), excluding the brush. */
  catchUp(stepPx = 2): { x: number; y: number }[] {
    if (!this.#started) return [];
    const b = this.#brush;
    const p = this.#pointer;
    const distPx = Math.hypot(p.x - b.x, p.y - b.y) / this.#u;
    if (distPx < 0.5) return [];
    const n = Math.min(32, Math.max(1, Math.ceil(distPx / stepPx)));
    const out: { x: number; y: number }[] = [];
    for (let i = 1; i <= n; i++) {
      // Ease out so the tail meets the pen smoothly instead of as a straight dash.
      const f = 1 - (1 - i / n) ** 2;
      out.push({ x: b.x + (p.x - b.x) * f, y: b.y + (p.y - b.y) * f });
    }
    this.#brush = { ...p };
    return out;
  }
}
