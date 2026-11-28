import { boundsIntersect, distToPolyline, pointInPolygon } from "../core/geometry.ts";
import type { Bounds } from "../core/geometry.ts";
import type { Entry } from "../core/store.ts";
import type { ScribbleItem } from "../core/types.ts";
import { ellipsePolyline, rectPolyline } from "../brush/shapes.ts";

/** Geometry used for hit tests: a flat `[x, y, z]` polyline and whether it is closed/filled. */
export function outlineOf(item: ScribbleItem): { flat: readonly number[]; closed: boolean; filled: boolean } {
  if (item.kind === "shape") {
    switch (item.tool) {
      case "rect":
        return { flat: rectPolyline(item.points), closed: true, filled: (item.style.fill ?? 0) > 0 };
      case "ellipse":
        return { flat: ellipsePolyline(item.points), closed: true, filled: (item.style.fill ?? 0) > 0 };
      case "polygon":
        return {
          flat: item.points,
          closed: !!item.style.closed,
          filled: !!item.style.closed && (item.style.fill ?? 0) > 0,
        };
      default:
        return { flat: item.points.slice(0, 6), closed: false, filled: false };
    }
  }
  if (item.kind === "area") return { flat: item.points, closed: true, filled: true };
  return { flat: item.points, closed: false, filled: false };
}

/** Does a disc of radius `r` at (x, y) touch the item? */
export function hitItem(entry: Entry, x: number, y: number, r: number): boolean {
  const b = entry.bounds;
  if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return false;
  const item = entry.item;
  if (item.kind === "text") return true; // bounds are the text box
  const { flat, closed, filled } = outlineOf(item);
  if (filled && pointInPolygon(x, y, flat)) return true;
  const reach = r + item.size / 2;
  return distToPolyline(x, y, flat, closed) <= reach;
}

/** Does an eraser path (flat triples, radius r) touch the item anywhere? */
export function hitPath(entry: Entry, path: readonly number[], r: number, pathBounds: Bounds): boolean {
  if (!boundsIntersect(entry.bounds, [pathBounds[0] - r, pathBounds[1] - r, pathBounds[2] + r, pathBounds[3] + r]))
    return false;
  for (let i = 0; i + 1 < path.length; i += 3) {
    if (hitItem(entry, path[i]!, path[i + 1]!, r)) return true;
  }
  return false;
}
