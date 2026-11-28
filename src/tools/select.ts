import { quantizeAngles, quantizePoints } from "../core/codec.ts";
import type { ScribbleItem } from "../core/types.ts";

/**
 * Pure geometry transforms for the Select & Transform tool:
 * translate, scale, and rotate any `ScribbleItem` (including its erase masks,
 * per-point angles and brush nib angle) cleanly around an origin.
 */

export function translateItem(item: ScribbleItem, dx: number, dy: number): ScribbleItem {
  const shiftPts = (flat: readonly number[]) => {
    const out = new Array<number>(flat.length);
    for (let i = 0; i + 2 < flat.length; i += 3) {
      out[i] = flat[i]! + dx;
      out[i + 1] = flat[i + 1]! + dy;
      out[i + 2] = flat[i + 2]!;
    }
    return quantizePoints(out, item.kind === "laser" ? "time" : "pressure");
  };
  const erase = item.erase?.map((m) => ({ ...m, points: shiftPts(m.points) }));
  const next: ScribbleItem = { ...item, points: shiftPts(item.points), revision: item.revision + 1 };
  if (erase) next.erase = erase;
  return next;
}

export function scaleItem(item: ScribbleItem, cx: number, cy: number, sx: number, sy: number): ScribbleItem {
  const factor = Math.max(0.1, (Math.abs(sx) + Math.abs(sy)) / 2);
  const scalePts = (flat: readonly number[]) => {
    const out = new Array<number>(flat.length);
    for (let i = 0; i + 2 < flat.length; i += 3) {
      out[i] = cx + (flat[i]! - cx) * sx;
      out[i + 1] = cy + (flat[i + 1]! - cy) * sy;
      out[i + 2] = flat[i + 2]!;
    }
    // Keep axis-aligned rect/ellipse points ordered [minX, minY, ..., maxX, maxY, ...]
    if (item.kind === "shape" && (item.tool === "rect" || item.tool === "ellipse") && out.length >= 6) {
      const x0 = Math.min(out[0]!, out[3]!);
      const y0 = Math.min(out[1]!, out[4]!);
      const x1 = Math.max(out[0]!, out[3]!);
      const y1 = Math.max(out[1]!, out[4]!);
      out[0] = x0;
      out[1] = y0;
      out[3] = x1;
      out[4] = y1;
    }
    return quantizePoints(out, item.kind === "laser" ? "time" : "pressure");
  };
  const erase = item.erase?.map((m) => ({ ...m, size: m.size * factor, points: scalePts(m.points) }));
  const next: ScribbleItem = {
    ...item,
    size: Math.max(0.5, Math.round(item.size * factor * 10) / 10),
    points: scalePts(item.points),
    revision: item.revision + 1,
  };
  if (item.kind === "text" && item.textWidth !== undefined) next.textWidth = item.textWidth * (next.size / item.size);
  if (erase) next.erase = erase;
  return next;
}

export function rotateItem(item: ScribbleItem, cx: number, cy: number, rad: number): ScribbleItem {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotPts = (flat: readonly number[]) => {
    const out = new Array<number>(flat.length);
    for (let i = 0; i + 2 < flat.length; i += 3) {
      const dx = flat[i]! - cx;
      const dy = flat[i + 1]! - cy;
      out[i] = cx + dx * cos - dy * sin;
      out[i + 1] = cy + dx * sin + dy * cos;
      out[i + 2] = flat[i + 2]!;
    }
    return quantizePoints(out, item.kind === "laser" ? "time" : "pressure");
  };

  let points: number[];
  let tool = item.tool;
  let style = item.style;
  if (item.kind === "shape" && item.tool === "rect" && item.points.length >= 6) {
    // Rotating an axis-aligned rectangle promotes it to a closed 4-vertex polygon.
    const [x0, y0, , x1, y1] = item.points as [number, number, number, number, number];
    points = rotPts([x0, y0, 0.5, x1, y0, 0.5, x1, y1, 0.5, x0, y1, 0.5]);
    tool = "polygon";
    style = { ...style, closed: true };
  } else {
    points = rotPts(item.points);
  }

  const angles = item.angles ? quantizeAngles(item.angles.map((a) => a + rad)) : undefined;
  if (style.brush?.ang !== undefined) {
    const deg = style.brush.ang + (rad * 180) / Math.PI;
    const norm = ((((deg + 180) % 360) + 360) % 360) - 180;
    style = { ...style, brush: { ...style.brush, ang: Math.round(norm * 10) / 10 } };
  }
  const erase = item.erase?.map((m) => ({
    ...m,
    points: rotPts(m.points),
    ang: m.ang !== undefined ? ((((m.ang + (rad * 180) / Math.PI + 180) % 360) + 360) % 360) - 180 : undefined,
  }));
  const next: ScribbleItem = { ...item, tool, style, points, revision: item.revision + 1 };
  if (angles) next.angles = angles;
  if (erase) next.erase = erase;
  return next;
}
