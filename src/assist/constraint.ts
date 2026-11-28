import type { Pt } from "../core/matrix.ts";
import { nearestOnCurve, normalAt, sampleCurve } from "./curve.ts";
import type { CurveSamples } from "./curve.ts";
import type { Ruler } from "./guides-model.ts";

/**
 * Stroke constraints from rulers. A constraint is created at pointer down
 * and projects every later point of that stroke:
 *
 *  - Perspective: after the pen has travelled a few pixels, the direction
 *    lock picks the candidate line through the start point (towards a
 *    vanishing point, or a parallel direction) closest to the movement, then
 *    projects every point onto it (Krita-style assistants).
 *  - Curve: strokes starting near a curve ruler follow the curve; `parallel`
 *    rulers keep the starting offset (concentric / parallel lines). The
 *    nearest point is searched in a window around the previous one, so the
 *    stroke never jumps across a loop or a close bend.
 */

export interface StrokeConstraint {
  /** Project a point (space units). Returns the input while the constraint is undecided. */
  project(x: number, y: number): Pt;
  /** False until the constraint has decided (points before the lock should be re-projected). */
  readonly locked: boolean;
}

/** Start distance (CSS px) within which a stroke snaps to a curve ruler. */
export const CURVE_CAPTURE_PX = 32;
/** Travel (CSS px) before the perspective direction lock decides. */
export const PERSPECTIVE_LOCK_PX = 10;

export class LineConstraint implements StrokeConstraint {
  readonly #start: Pt;
  readonly #candidates: Pt[];
  readonly #lockDist: number;
  #dir: Pt | null = null;

  constructor(start: Pt, candidates: Pt[], lockDist: number) {
    this.#start = start;
    this.#candidates = candidates;
    this.#lockDist = lockDist;
  }

  get locked(): boolean {
    return !!this.#dir;
  }

  /** Chosen unit direction, once locked. */
  get direction(): Pt | null {
    return this.#dir;
  }

  project(x: number, y: number): Pt {
    const s = this.#start;
    if (!this.#dir) {
      const dx = x - s.x;
      const dy = y - s.y;
      const len = Math.hypot(dx, dy);
      if (len < this.#lockDist) return { x, y };
      let best = -1;
      for (const c of this.#candidates) {
        const dot = Math.abs((dx * c.x + dy * c.y) / len);
        if (dot > best) {
          best = dot;
          this.#dir = c;
        }
      }
      if (!this.#dir) return { x, y };
    }
    const d = this.#dir;
    const t = (x - s.x) * d.x + (y - s.y) * d.y;
    return { x: s.x + d.x * t, y: s.y + d.y * t };
  }
}

export class CurveConstraint implements StrokeConstraint {
  readonly #curve: CurveSamples;
  readonly #offset: number;
  readonly #window: number;
  #index: number;

  constructor(curve: CurveSamples, index: number, offset: number, window = 32) {
    this.#curve = curve;
    this.#index = index;
    this.#offset = offset;
    this.#window = window;
  }

  readonly locked = true;

  project(x: number, y: number): Pt {
    const hit = nearestOnCurve(this.#curve, x, y, this.#index - this.#window, this.#index + this.#window);
    if (!hit) return { x, y };
    this.#index = hit.index;
    if (!this.#offset) return { x: hit.x, y: hit.y };
    const n = normalAt(this.#curve, hit.index);
    return { x: hit.x + n.x * this.#offset, y: hit.y + n.y * this.#offset };
  }
}

/** Candidate unit directions through `start` offered by the perspective rulers. */
export function perspectiveDirections(rulers: readonly Ruler[], start: Pt, minDist: number): Pt[] {
  const out: Pt[] = [];
  const add = (x: number, y: number) => {
    const len = Math.hypot(x, y);
    if (len < 1e-9) return;
    const d = { x: x / len, y: y / len };
    if (!out.some((o) => Math.abs(o.x * d.y - o.y * d.x) < 1e-6)) out.push(d);
  };
  for (const r of rulers) {
    if (r.kind !== "perspective" || !r.on) continue;
    for (const vp of r.vps) {
      if (Math.hypot(vp.x - start.x, vp.y - start.y) >= minDist) add(vp.x - start.x, vp.y - start.y);
    }
    if (r.parallels) {
      if (r.vps.length === 1) add(1, 0);
      if (r.vps.length <= 2) add(0, 1);
    }
  }
  return out;
}

/**
 * Constraint for a stroke starting at `start`, or null. `unitsPerPx` converts
 * the CSS-pixel thresholds; `lineOnly` (line/arrow tools) skips curves.
 */
export function buildConstraint(
  rulers: readonly Ruler[],
  start: Pt,
  unitsPerPx: number,
  lineOnly = false,
): StrokeConstraint | null {
  const active = rulers.filter((r) => r.on);
  if (!active.length) return null;
  if (!lineOnly) {
    let best: { curve: CurveSamples; index: number; offset: number; distance: number } | null = null;
    for (const r of active) {
      if (r.kind !== "curve") continue;
      const curve = sampleCurve(r.pts, r.closed, 3 * unitsPerPx);
      const hit = nearestOnCurve(curve, start.x, start.y);
      if (!hit || hit.distance > CURVE_CAPTURE_PX * unitsPerPx) continue;
      if (!best || hit.distance < best.distance)
        best = { curve, index: hit.index, offset: r.parallel ? hit.offset : 0, distance: hit.distance };
    }
    if (best) return new CurveConstraint(best.curve, best.index, best.offset);
  }
  const dirs = perspectiveDirections(active, start, 2 * unitsPerPx);
  if (!dirs.length) return null;
  return new LineConstraint(start, dirs, PERSPECTIVE_LOCK_PX * unitsPerPx);
}

/** Express rulers in another space (e.g. a screen stroke's anchor) by offsetting every point. */
export function offsetRulers(rulers: readonly Ruler[], dx: number, dy: number): Ruler[] {
  if (!dx && !dy) return rulers.slice();
  const move = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy });
  return rulers.map((r) =>
    r.kind === "perspective" ? { ...r, vps: r.vps.map(move) } : { ...r, pts: r.pts.map(move) },
  );
}
