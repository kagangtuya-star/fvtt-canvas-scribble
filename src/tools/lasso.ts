import { boundsIntersect, boundsOf, pointInPolygon } from "../core/geometry.ts";
import type { Bounds } from "../core/geometry.ts";
import type { Entry } from "../core/store.ts";
import { layoutText } from "../core/text-layout.ts";
import { outlineOf } from "./hit.ts";

/**
 * Region selection (marquee rectangle or freehand lasso). The region is a
 * closed polygon of `[x, y, z]` triples in the item's own space. `touch`
 * selects every item the region overlaps; `contain` only items whose whole
 * outline lies inside it.
 */

export type RegionMatch = "touch" | "contain";

function segmentsCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function onSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): boolean {
  const eps = 1e-8;
  return (
    x >= Math.min(ax, bx) - eps &&
    x <= Math.max(ax, bx) + eps &&
    y >= Math.min(ay, by) - eps &&
    y <= Math.max(ay, by) + eps &&
    Math.abs((x - ax) * (by - ay) - (y - ay) * (bx - ax)) <= eps * Math.max(1, Math.hypot(bx - ax, by - ay))
  );
}

function containsPoint(x: number, y: number, region: readonly number[]): boolean {
  if (pointInPolygon(x, y, region)) return true;
  for (let i = 0, j = region.length - 3; i < region.length; j = i, i += 3)
    if (onSegment(x, y, region[j]!, region[j + 1]!, region[i]!, region[i + 1]!)) return true;
  return false;
}

/** Endpoints are already inside; check the intervals between boundary contacts as well. */
function containsSegment(ax: number, ay: number, bx: number, by: number, region: readonly number[]): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  if (!dx && !dy) return true;
  const cuts = [0, 1];
  for (let i = 0, j = region.length - 3; i < region.length; j = i, i += 3) {
    const x = region[i]!;
    const y = region[i + 1]!;
    if (segmentsCross(ax, ay, bx, by, region[j]!, region[j + 1]!, x, y)) return false;
    if (onSegment(x, y, ax, ay, bx, by)) {
      const t = Math.abs(dx) >= Math.abs(dy) ? (x - ax) / dx : (y - ay) / dy;
      if (t > 0 && t < 1) cuts.push(t);
    }
  }
  cuts.sort((a, b) => a - b);
  for (let i = 1; i < cuts.length; i++) {
    const t = (cuts[i - 1]! + cuts[i]!) / 2;
    if (!containsPoint(ax + dx * t, ay + dy * t, region)) return false;
  }
  return true;
}

/** Text items are their layout box. */
function shapeOf(entry: Entry): { flat: readonly number[]; closed: boolean; filled: boolean } {
  const item = entry.item;
  if (item.kind === "text") {
    const x = item.points[0]!;
    const y = item.points[1]!;
    const l = layoutText(item);
    return {
      flat: [x, y, 0.5, x + l.width, y, 0.5, x + l.width, y + l.height, 0.5, x, y + l.height, 0.5],
      closed: true,
      filled: true,
    };
  }
  return outlineOf(item);
}

/** Does the region polygon select this entry? `regionBounds` = `boundsOf(region)`. */
export function regionHit(
  entry: Entry,
  region: readonly number[],
  match: RegionMatch,
  regionBounds: Bounds = boundsOf(region),
): boolean {
  if (region.length < 9 || !boundsIntersect(entry.bounds, regionBounds)) return false;
  const { flat, closed, filled } = shapeOf(entry);
  const n = flat.length / 3;
  if (!n) return false;
  const segs = closed ? n : n - 1;
  if (match === "contain") {
    for (let i = 0; i < n; i++) if (!containsPoint(flat[i * 3]!, flat[i * 3 + 1]!, region)) return false;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      if (!containsSegment(flat[i * 3]!, flat[i * 3 + 1]!, flat[j * 3]!, flat[j * 3 + 1]!, region)) return false;
    }
    return true;
  }
  for (let i = 0; i < n; i++) if (containsPoint(flat[i * 3]!, flat[i * 3 + 1]!, region)) return true;
  // A region entirely inside a filled shape.
  if (filled && pointInPolygon(region[0]!, region[1]!, flat)) return true;
  const m = region.length / 3;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const ax = flat[i * 3]!;
    const ay = flat[i * 3 + 1]!;
    const bx = flat[j * 3]!;
    const by = flat[j * 3 + 1]!;
    for (let k = 0; k < m; k++) {
      const l = (k + 1) % m;
      if (
        onSegment(region[k * 3]!, region[k * 3 + 1]!, ax, ay, bx, by) ||
        segmentsCross(ax, ay, bx, by, region[k * 3]!, region[k * 3 + 1]!, region[l * 3]!, region[l * 3 + 1]!)
      )
        return true;
    }
  }
  return false;
}
