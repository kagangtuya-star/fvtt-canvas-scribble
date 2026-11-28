import type { PressureMode } from "../brush/recorder.ts";
import type { StrokeSpec } from "../media/controller.ts";
import { CELL_UNITS } from "../media/layout.ts";
import type { ClientSample, Gesture, Target } from "./gestures.ts";
import { toSpace } from "./gestures.ts";

/** What the paint gesture needs from the wet-media controller. */
export interface MediaStrokeSink {
  begin(spec: StrokeSpec, points: number[]): string | null;
  /** Returns false when the stroke is full (the gesture continues in a new stroke). */
  add(id: string, points: number[]): boolean;
  end(id: string): void;
  cancel(id: string): void;
}

/** Points closer than this (map units) only update the pressure. */
const MIN_STEP = CELL_UNITS * 0.5;
const MOUSE_PRESSURE = 0.6;

/**
 * Paint tool: pointer samples → wet-media stroke inputs (map units with
 * pressure). The simulation, not the gesture, decides what the paint does.
 */
export class MediaGesture implements Gesture {
  readonly #sink: MediaStrokeSink;
  readonly #target: Target;
  readonly #spec: StrokeSpec;
  readonly #pressure: PressureMode;
  #id: string | null;
  #last: [number, number, number] | null = null;

  constructor(sink: MediaStrokeSink, target: Target, spec: StrokeSpec, first: ClientSample, pressure: PressureMode) {
    this.#sink = sink;
    this.#target = target;
    this.#spec = spec;
    this.#pressure = pressure;
    const p = this.#point(first);
    this.#last = p;
    this.#id = sink.begin(spec, p);
  }

  get active(): boolean {
    return !!this.#id;
  }

  #point(s: ClientSample): [number, number, number] {
    const p = toSpace(this.#target, s);
    let z = MOUSE_PRESSURE;
    if (this.#pressure !== "off" && s.pointerType === "pen" && s.pressure > 0)
      z = Math.max(0.05, Math.min(1, s.pressure));
    return [p.x, p.y, z];
  }

  move(samples: ClientSample[]): void {
    if (!this.#id) return;
    const out: number[] = [];
    for (const s of samples) {
      const p = this.#point(s);
      const last = this.#last;
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < MIN_STEP) {
        last[2] = p[2];
        continue;
      }
      out.push(p[0], p[1], p[2]);
      this.#last = p;
    }
    if (!out.length) return;
    if (!this.#sink.add(this.#id, out)) {
      // Long strokes continue in a fresh stroke from the last point (the brush is reloaded).
      this.#sink.end(this.#id);
      const tail = out.slice(-3);
      this.#id = this.#sink.begin(this.#spec, tail);
    }
  }

  up(s: ClientSample): boolean {
    if (!this.#id) return false;
    const p = this.#point(s);
    const last = this.#last;
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= MIN_STEP) this.#sink.add(this.#id, p);
    this.#sink.end(this.#id);
    this.#id = null;
    return false;
  }

  cancel(): void {
    if (this.#id) this.#sink.cancel(this.#id);
    this.#id = null;
  }
}
