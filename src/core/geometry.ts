/**
 * Pure geometry on flat `[x, y, z, ...]` triples: simplification, spline
 * resampling, bounds and distance queries. No DOM, no Foundry.
 */

export type Bounds = [minX: number, minY: number, maxX: number, maxY: number];

export const EMPTY_BOUNDS: Bounds = [Infinity, Infinity, -Infinity, -Infinity];

export function boundsOf(flat: readonly number[], pad = 0): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < flat.length; i += 3) {
    const x = flat[i]!;
    const y = flat[i + 1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return [0, 0, 0, 0];
  return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

export const unionBounds = (a: Bounds, b: Bounds): Bounds => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

export const boundsIntersect = (a: Bounds, b: Bounds): boolean =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

export interface SimplifyChannel {
  values: readonly number[];
  /** Response curves that can amplify small deviations in this channel. */
  curves?: readonly ((value: number) => number)[];
}

/**
 * Ramer–Douglas–Peucker simplification that also preserves pressure changes:
 * a point is kept when either its distance from the chord or its pressure
 * deviation from the linearly interpolated pressure exceeds the tolerance.
 * Iterative, so long strokes cannot overflow the call stack.
 */
function simplifyIndices(
  flat: readonly number[],
  tolerance: number,
  pressureTolerance: number,
  angles?: readonly number[],
  angleTolerance = Math.PI / 36,
  channels?: readonly SimplifyChannel[],
  channelTolerance = 0.08,
): number[] {
  const n = flat.length / 3;
  if (n <= 2 || tolerance <= 0) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    if (last - first < 2) continue;
    const ax = flat[first * 3]!;
    const ay = flat[first * 3 + 1]!;
    const ap = flat[first * 3 + 2]!;
    const bx = flat[last * 3]!;
    const by = flat[last * 3 + 1]!;
    const bp = flat[last * 3 + 2]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const startAngle = angles?.[first] ?? 0;
    const angleDelta = shortestAngle((angles?.[last] ?? 0) - startAngle);
    let worst = -1;
    let worstScore = 1;
    for (let i = first + 1; i < last; i++) {
      const px = flat[i * 3]!;
      const py = flat[i * 3 + 1]!;
      const pp = flat[i * 3 + 2]!;
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.min(1, Math.max(0, t));
      const dist = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
      const frac = (i - first) / (last - first);
      const pDev = Math.abs(pp - (ap + (bp - ap) * frac));
      // The painter interpolates the shortest turn between samples. An unwrapped
      // angle keeps extra turns visible to simplification even across the seam.
      let score = Math.max(dist / tolerance, pDev / pressureTolerance);
      if (angles) {
        const aDev = Math.abs(angles[i]! - (startAngle + angleDelta * (len2 > 0 ? t : frac)));
        score = Math.max(score, aDev / angleTolerance);
      }
      if (channels) {
        // A retained segment interpolates the sensor over distance, not sample count.
        const along = len2 > 0 ? t : frac;
        for (const { values, curves } of channels) {
          const actual = values[i]!;
          const estimate = values[first]! + (values[last]! - values[first]!) * along;
          let deviation = Math.abs(actual - estimate);
          if (deviation > 0 && curves) {
            for (const curve of curves) deviation = Math.max(deviation, Math.abs(curve(actual) - curve(estimate)));
          }
          score = Math.max(score, deviation / channelTolerance);
        }
      }
      if (score > worstScore) {
        worstScore = score;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push(first, worst, worst, last);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

const shortestAngle = (rad: number) => (((rad % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;

function pickPoints(flat: readonly number[], indices: readonly number[]): number[] {
  const out: number[] = [];
  for (const i of indices) out.push(flat[i * 3]!, flat[i * 3 + 1]!, flat[i * 3 + 2]!);
  return out;
}

export function simplify(flat: readonly number[], tolerance: number, pressureTolerance = 0.06): number[] {
  return pickPoints(flat, simplifyIndices(flat, tolerance, pressureTolerance));
}

/** Simplify with a growing tolerance until at most `maxPoints` remain (graceful degradation). */
export function simplifyToLimit(flat: readonly number[], tolerance: number, maxPoints: number): number[] {
  return pickPoints(flat, simplifyIndicesToLimit(flat, tolerance, maxPoints));
}

/**
 * Original indices of the retained points, optionally preserving changing nib
 * angles and per-point dynamics channels (pressure, tilt, speed; 0..1).
 */
export function simplifyIndicesToLimit(
  flat: readonly number[],
  tolerance: number,
  maxPoints: number,
  angles?: readonly number[],
  channels?: readonly SimplifyChannel[],
): number[] {
  const chs = channels?.length ? channels : undefined;
  const unwrapped = angles?.map((a, i) => (i === 0 ? a : shortestAngle(a - angles[i - 1]!)));
  if (unwrapped) for (let i = 1; i < unwrapped.length; i++) unwrapped[i] = unwrapped[i - 1]! + unwrapped[i]!;
  let out = simplifyIndices(flat, tolerance, 0.06, unwrapped, Math.PI / 36, chs);
  let tol = tolerance;
  for (let i = 0; i < 12 && out.length > maxPoints; i++) {
    tol *= 1.8;
    out = simplifyIndices(flat, tol, 0.06 * (1 + i), unwrapped, (Math.PI / 36) * (1 + i), chs, 0.08 * (1 + i));
  }
  if (out.length > maxPoints) {
    // Last resort: uniform decimation, keeping both ends.
    const n = out.length;
    const step = n / maxPoints;
    const dec: number[] = [];
    for (let k = 0; k < maxPoints - 1; k++) {
      dec.push(out[Math.floor(k * step)]!);
    }
    dec.push(out[n - 1]!);
    out = dec;
  }
  return out;
}

/**
 * Densify with a uniform Catmull–Rom spline (stored strokes are simplified;
 * this restores smooth curvature). z is interpolated linearly.
 */
export function resample(flat: readonly number[], spacing: number): number[] {
  const n = flat.length / 3;
  if (n <= 1) return flat.slice();
  const step = Math.max(0.05, spacing);
  const px = (i: number) => flat[Math.min(n - 1, Math.max(0, i)) * 3]!;
  const py = (i: number) => flat[Math.min(n - 1, Math.max(0, i)) * 3 + 1]!;
  const out: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const x0 = px(i - 1);
    const y0 = py(i - 1);
    const x1 = px(i);
    const y1 = py(i);
    const x2 = px(i + 1);
    const y2 = py(i + 1);
    const x3 = px(i + 2);
    const y3 = py(i + 2);
    const z1 = flat[i * 3 + 2]!;
    const z2 = flat[(i + 1) * 3 + 2]!;
    const count = Math.max(1, Math.min(64, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step)));
    for (let k = 0; k < count; k++) {
      const t = k / count;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(
        0.5 * (2 * x1 + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3),
        0.5 * (2 * y1 + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3),
        z1 + (z2 - z1) * t,
      );
    }
  }
  out.push(flat[(n - 1) * 3]!, flat[(n - 1) * 3 + 1]!, flat[(n - 1) * 3 + 2]!);
  return out;
}

/** Distance from point p to segment ab. */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** Smallest distance from p to a polyline of triples (optionally closed). */
export function distToPolyline(px: number, py: number, flat: readonly number[], closed = false): number {
  const n = flat.length / 3;
  if (n === 0) return Infinity;
  if (n === 1) return Math.hypot(px - flat[0]!, py - flat[1]!);
  let best = Infinity;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const d = distToSegment(px, py, flat[i * 3]!, flat[i * 3 + 1]!, flat[j * 3]!, flat[j * 3 + 1]!);
    if (d < best) best = d;
  }
  return best;
}

/** Even–odd point-in-polygon test on triples. */
export function pointInPolygon(px: number, py: number, flat: readonly number[]): boolean {
  const n = flat.length / 3;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = flat[i * 3]!;
    const yi = flat[i * 3 + 1]!;
    const xj = flat[j * 3]!;
    const yj = flat[j * 3 + 1]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Total length of a polyline. */
export function polylineLength(flat: readonly number[]): number {
  let len = 0;
  for (let i = 3; i + 1 < flat.length; i += 3) len += Math.hypot(flat[i]! - flat[i - 3]!, flat[i + 1]! - flat[i - 2]!);
  return len;
}
