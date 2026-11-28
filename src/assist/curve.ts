import type { Pt } from "../core/matrix.ts";

/**
 * Centripetal Catmull–Rom splines (α = 0.5: no cusps or self-intersections
 * inside a segment) through a curve ruler's control points, sampled into a
 * dense polyline for drawing and for projecting stroke points onto the curve.
 */

export interface CurveSamples {
  /** Flat `[x, y, …]` polyline. */
  xy: number[];
  /** Control segment each sample segment belongs to (`seg[i]` for sample segment i → i+1). */
  seg: number[];
  closed: boolean;
}

const lerp = (a: Pt, b: Pt, ta: number, tb: number, t: number): Pt => {
  const d = tb - ta;
  if (Math.abs(d) < 1e-9) return { x: a.x, y: a.y };
  const f = (t - ta) / d;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
};

/** Point at parameter `f` (0..1) of the segment p1 → p2 (Barry–Goldman pyramid). */
function catmullRom(p0: Pt, p1: Pt, p2: Pt, p3: Pt, f: number): Pt {
  const knot = (a: Pt, b: Pt) => Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * f;
  const a1 = lerp(p0, p1, t0, t1, t);
  const a2 = lerp(p1, p2, t1, t2, t);
  const a3 = lerp(p2, p3, t2, t3, t);
  const b1 = lerp(a1, a2, t0, t2, t);
  const b2 = lerp(a2, a3, t1, t3, t);
  return lerp(b1, b2, t1, t2, t);
}

/** Sample the spline; `step` is the target sample spacing in the points' units. */
export function sampleCurve(pts: readonly Pt[], closed: boolean, step: number): CurveSamples {
  const n = pts.length;
  const xy: number[] = [];
  const seg: number[] = [];
  if (n === 0) return { xy, seg, closed };
  if (n === 1) return { xy: [pts[0]!.x, pts[0]!.y], seg, closed: false };
  const isClosed = closed && n >= 3;
  const at = (i: number): Pt => {
    if (isClosed) return pts[((i % n) + n) % n]!;
    if (i < 0) return { x: 2 * pts[0]!.x - pts[1]!.x, y: 2 * pts[0]!.y - pts[1]!.y };
    if (i >= n) return { x: 2 * pts[n - 1]!.x - pts[n - 2]!.x, y: 2 * pts[n - 1]!.y - pts[n - 2]!.y };
    return pts[i]!;
  };
  const segments = isClosed ? n : n - 1;
  const s = Math.max(1e-3, step);
  for (let i = 0; i < segments; i++) {
    const p1 = at(i);
    const p2 = at(i + 1);
    const count = Math.max(4, Math.min(256, Math.ceil((Math.hypot(p2.x - p1.x, p2.y - p1.y) * 1.2) / s)));
    for (let k = 0; k < count; k++) {
      const p = catmullRom(at(i - 1), p1, p2, at(i + 2), k / count);
      xy.push(p.x, p.y);
      seg.push(i);
    }
  }
  const last = isClosed ? at(0) : at(n - 1);
  xy.push(last.x, last.y);
  return { xy, seg, closed: isClosed };
}

/** Closest point on sample segment `i` to p: `[t, x, y, distance²]`. */
function onSegment(xy: readonly number[], i: number, px: number, py: number): [number, number, number, number] {
  const ax = xy[i * 2]!;
  const ay = xy[i * 2 + 1]!;
  const bx = xy[i * 2 + 2]!;
  const by = xy[i * 2 + 3]!;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const x = ax + dx * t;
  const y = ay + dy * t;
  return [t, x, y, (px - x) ** 2 + (py - y) ** 2];
}

export interface CurveHit {
  /** Sample segment index. */
  index: number;
  x: number;
  y: number;
  distance: number;
  /** Signed distance along the left normal of the segment. */
  offset: number;
}

/** Nearest point among sample segments `from..to` (inclusive, wrapped for closed curves). */
export function nearestOnCurve(c: CurveSamples, px: number, py: number, from = 0, to = Infinity): CurveHit | null {
  const segs = c.xy.length / 2 - 1;
  if (segs < 1) return null;
  let best: CurveHit | null = null;
  let bestD = Infinity;
  const lo = Number.isFinite(from) ? from : 0;
  const hi = Number.isFinite(to) ? to : segs - 1;
  for (let k = lo; k <= hi; k++) {
    let i = k;
    if (c.closed) i = ((k % segs) + segs) % segs;
    else if (i < 0 || i >= segs) continue;
    const [, x, y, d2] = onSegment(c.xy, i, px, py);
    if (d2 < bestD) {
      bestD = d2;
      const dx = c.xy[i * 2 + 2]! - c.xy[i * 2]!;
      const dy = c.xy[i * 2 + 3]! - c.xy[i * 2 + 1]!;
      const len = Math.hypot(dx, dy) || 1;
      // Left normal (-dy, dx) in y-down screen coordinates.
      const offset = ((px - x) * -dy + (py - y) * dx) / len;
      best = { index: i, x, y, distance: Math.sqrt(d2), offset };
    }
  }
  return best;
}

/** Left unit normal of sample segment i. */
export function normalAt(c: CurveSamples, i: number): Pt {
  const dx = c.xy[i * 2 + 2]! - c.xy[i * 2]!;
  const dy = c.xy[i * 2 + 3]! - c.xy[i * 2 + 1]!;
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}
