import { LazyBrush } from "lazy-brush";
import { clamp } from "../core/util.ts";

/**
 * Real-time pointer stabilization:
 *  - `off`:      raw coordinates (relying only on the brush's own streamline)
 *  - `one-euro`: adaptive low-pass filter (Casiez et al., CHI 2012) — suppresses
 *                hand tremor at slow speeds while staying responsive at fast speeds
 *  - `lazy`:     string-pull stabilizer powered by `lazy-brush`
 */

export type StabilizerMode = "off" | "one-euro" | "lazy";
export const STABILIZER_MODES: readonly StabilizerMode[] = ["off", "one-euro", "lazy"];

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

  reset(): void {
    this.#init = false;
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

  reset(): void {
    this.#x.reset();
    this.#dx.reset();
  }
}

export interface StabilizerOptions {
  mode: StabilizerMode;
  /** 0..1 user stabilization strength. */
  strength: number;
  /** Space units per CSS pixel (scales the lazy-brush string radius). */
  unitsPerPx: number;
}

export class StrokeStabilizer {
  readonly #mode: StabilizerMode;
  readonly #strength: number;
  #euroX: OneEuro1D | null = null;
  #euroY: OneEuro1D | null = null;
  #lazy: LazyBrush | null = null;
  #lastTime: number | null = null;
  #pointer: { x: number; y: number } = { x: 0, y: 0 };
  #brush: { x: number; y: number } = { x: 0, y: 0 };

  constructor(opts: StabilizerOptions) {
    this.#mode = opts.mode;
    this.#strength = clamp(opts.strength, 0, 1);
    if (this.#mode === "one-euro" && this.#strength > 0.01) {
      // Lower minCutoff = stronger smoothing at rest; beta controls speed responsiveness.
      const minCutoff = 3.2 - this.#strength * 2.75; // 3.2 Hz → 0.45 Hz
      const beta = 0.025 - this.#strength * 0.02; // 0.025 → 0.005
      this.#euroX = new OneEuro1D(minCutoff, Math.max(0.002, beta));
      this.#euroY = new OneEuro1D(minCutoff, Math.max(0.002, beta));
    } else if (this.#mode === "lazy" && this.#strength > 0.01) {
      const radiusPx = 4 + this.#strength * 44; // 4..48 CSS px string
      this.#lazy = new LazyBrush({
        enabled: true,
        radius: radiusPx * Math.max(1e-3, opts.unitsPerPx),
      });
    }
  }

  get mode(): StabilizerMode {
    return this.#mode;
  }

  get active(): boolean {
    return this.#mode !== "off" && this.#strength > 0.01;
  }

  /** Latest raw pointer & lagging brush position (for optional string indicator). */
  get state(): { pointer: { x: number; y: number }; brush: { x: number; y: number } } {
    return { pointer: this.#pointer, brush: this.#brush };
  }

  filter(x: number, y: number, timeMs: number): { x: number; y: number } {
    this.#pointer = { x, y };
    if (!this.active) {
      this.#brush = { x, y };
      return this.#brush;
    }
    const first = this.#lastTime === null;
    const dtSec = first ? 1 / 60 : Math.max(1e-3, (timeMs - this.#lastTime!) / 1000);
    this.#lastTime = timeMs;

    if (this.#euroX && this.#euroY) {
      const fx = this.#euroX.filter(x, dtSec, first);
      const fy = this.#euroY.filter(y, dtSec, first);
      this.#brush = { x: fx, y: fy };
      return this.#brush;
    }
    if (this.#lazy) {
      this.#lazy.update({ x, y }, { both: first });
      const b = this.#lazy.getBrushCoordinates();
      this.#brush = { x: b.x, y: b.y };
      return this.#brush;
    }
    this.#brush = { x, y };
    return this.#brush;
  }
}
