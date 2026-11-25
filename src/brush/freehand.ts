import { getStroke, getStrokePoints } from "perfect-freehand";

/**
 * The only module that imports perfect-freehand. Every freehand brush goes
 * through it: outline brushes use `outline()`, stamp/chisel brushes walk the
 * same smoothed, pressure-annotated samples from `samples()`, so coordinate
 * sampling, pressure handling and smoothing are shared by all brushes.
 */

export interface FreehandOptions {
  size: number;
  thinning: number;
  smoothing: number;
  streamline: number;
  easing?: (pressure: number) => number;
  taperStart: number;
  taperEnd: number;
  cap: boolean;
  last: boolean;
}

export interface Sample {
  x: number;
  y: number;
  pressure: number;
  /** Distance along the stroke. */
  run: number;
}

const toInput = (flat: readonly number[]): [number, number, number][] => {
  const out: [number, number, number][] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) out.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return out;
};

/** Outline polygon of a pressure-sensitive stroke. */
export function outline(flat: readonly number[], o: FreehandOptions): number[][] {
  return getStroke(toInput(flat), {
    size: o.size,
    thinning: o.thinning,
    smoothing: o.smoothing,
    streamline: o.streamline,
    easing: o.easing,
    simulatePressure: false,
    last: o.last,
    start: { cap: o.cap, taper: o.taperStart },
    end: { cap: o.cap, taper: o.taperEnd },
  });
}

/** Smoothed samples with pressure and running length (for stamp-based brushes). */
export function samples(flat: readonly number[], o: Pick<FreehandOptions, "size" | "streamline" | "last">): Sample[] {
  const pts = getStrokePoints(toInput(flat), { size: o.size, streamline: o.streamline, last: o.last });
  return pts.map((p) => ({ x: p.point[0], y: p.point[1], pressure: p.pressure, run: p.runningLength }));
}
