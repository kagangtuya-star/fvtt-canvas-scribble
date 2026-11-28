import { boundsOf, distToSegment, polylineLength, simplify } from "../core/geometry.ts";
import type { ShapeId } from "../core/types.ts";

/**
 * QuickShape (draw-and-hold geometry recognition, similar to Procreate):
 * Analyses a freehand polyline `[x, y, z, ...]` and fits a clean line,
 * circle/ellipse, rectangle, or triangle when the stroke matches closely.
 */

export interface QuickShapeMatch {
  tool: ShapeId;
  points: number[];
  closed?: boolean;
}

export function recognizeQuickShape(flat: readonly number[]): QuickShapeMatch | null {
  const n = flat.length / 3;
  if (n < 5) return null;
  const len = polylineLength(flat);
  if (len < 16) return null;

  const x0 = flat[0]!;
  const y0 = flat[1]!;
  const x1 = flat[(n - 1) * 3]!;
  const y1 = flat[(n - 1) * 3 + 1]!;
  const chord = Math.hypot(x1 - x0, y1 - y0);
  const [minX, minY, maxX, maxY] = boundsOf(flat);
  const bw = maxX - minX;
  const bh = maxY - minY;
  const diag = Math.hypot(bw, bh);
  if (diag < 14) return null;

  // 1. Straight line test: chord covers most of arc length & max perpendicular deviation is small.
  if (chord > len * 0.86) {
    let maxDev = 0;
    for (let i = 1; i < n - 1; i++) {
      const d = distToSegment(flat[i * 3]!, flat[i * 3 + 1]!, x0, y0, x1, y1);
      if (d > maxDev) maxDev = d;
    }
    if (maxDev <= Math.max(5, chord * 0.065)) {
      return { tool: "line", points: [x0, y0, 0.5, x1, y1, 0.5] };
    }
  }

  // Remaining shapes require a mostly-closed loop.
  const endGap = Math.hypot(x1 - x0, y1 - y0);
  if (endGap > Math.max(24, diag * 0.34)) return null;
  if (bw < 10 || bh < 10) return null;

  // 2. Polygon corner simplification for triangle / rectangle detection.
  const simplified = simplify(flat, Math.max(4, diag * 0.065), 10);
  const verts: [number, number][] = [];
  for (let i = 0; i + 1 < simplified.length; i += 3) verts.push([simplified[i]!, simplified[i + 1]!]);
  // Drop closing duplicate vertex near the first.
  if (verts.length > 3 && Math.hypot(verts.at(-1)![0] - verts[0]![0], verts.at(-1)![1] - verts[0]![1]) < diag * 0.25) {
    verts.pop();
  }

  // 2a. Triangle (3 distinct corners).
  if (verts.length === 3) {
    const [a, b, c] = verts as [[number, number], [number, number], [number, number]];
    const area2 = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    if (area2 > bw * bh * 0.22) {
      return {
        tool: "polygon",
        points: [a[0], a[1], 0.5, b[0], b[1], 0.5, c[0], c[1], 0.5],
        closed: true,
      };
    }
  }

  // 2b. Rectangle (4 corners with roughly perpendicular adjacent edges).
  if (verts.length === 4) {
    let orthoOk = true;
    for (let i = 0; i < 4; i++) {
      const prev = verts[(i + 3) % 4]!;
      const cur = verts[i]!;
      const next = verts[(i + 1) % 4]!;
      const ax = prev[0] - cur[0];
      const ay = prev[1] - cur[1];
      const bx = next[0] - cur[0];
      const by = next[1] - cur[1];
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (la < diag * 0.12 || lb < diag * 0.12) {
        orthoOk = false;
        break;
      }
      const cos = Math.abs((ax * bx + ay * by) / (la * lb));
      if (cos > 0.32) {
        orthoOk = false;
        break;
      }
    }
    if (orthoOk) {
      // Check if axis-aligned (within ~12°); if so return a clean rect, otherwise rotated 4-gon.
      const e0x = verts[1]![0] - verts[0]![0];
      const e0y = verts[1]![1] - verts[0]![1];
      const ang = Math.abs(Math.atan2(e0y, e0x)) % (Math.PI / 2);
      const nearAxis = ang < 0.22 || Math.PI / 2 - ang < 0.22;
      if (nearAxis) {
        return { tool: "rect", points: [minX, minY, 0.5, maxX, maxY, 0.5] };
      }
      const pts: number[] = [];
      for (const [vx, vy] of verts) pts.push(vx, vy, 0.5);
      return { tool: "polygon", points: pts, closed: true };
    }
  }

  // 3. Ellipse / Circle test: measure radial error to bounding ellipse.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = bw / 2;
  const ry = bh / 2;
  let errSum = 0;
  let maxErr = 0;
  for (let i = 0; i < n; i++) {
    const nx = (flat[i * 3]! - cx) / rx;
    const ny = (flat[i * 3 + 1]! - cy) / ry;
    const err = Math.abs(Math.hypot(nx, ny) - 1);
    errSum += err;
    if (err > maxErr) maxErr = err;
  }
  const avgErr = errSum / n;
  if (avgErr < 0.16 && maxErr < 0.36) {
    // Snap near-circles to an exact circle.
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.15) {
      const r = (rx + ry) / 2;
      return { tool: "ellipse", points: [cx - r, cy - r, 0.5, cx + r, cy + r, 0.5] };
    }
    return { tool: "ellipse", points: [minX, minY, 0.5, maxX, maxY, 0.5] };
  }

  return null;
}
