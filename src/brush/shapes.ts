import type { ShapeId } from "../core/types.ts";

/**
 * Shape construction from a drag gesture. Modifier semantics:
 *  - Shift: constrain (lines/arrows snap to 15°, rectangles become squares,
 *           ellipses become circles)
 *  - Alt:   draw from the centre (rectangles, ellipses)
 * Results are stored as plain point triples, so shapes go through the same
 * storage, network and hit-test paths as strokes.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Modifiers {
  shift: boolean;
  alt: boolean;
  /** Ctrl (or ⌘ on macOS). */
  ctrl?: boolean;
}

export const SNAP_ANGLE = Math.PI / 12; // 15°

export function snapAngle(a: Pt, b: Pt, step = SNAP_ANGLE): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

/** Two-point shapes: returns `[x0, y0, z, x1, y1, z]`. */
export function dragShape(shape: ShapeId, start: Pt, current: Pt, mods: Modifiers): number[] {
  if (shape === "line" || shape === "arrow" || shape === "polygon") {
    const end = mods.shift ? snapAngle(start, current) : current;
    return [start.x, start.y, 0.5, end.x, end.y, 0.5];
  }
  // rect / ellipse
  let dx = current.x - start.x;
  let dy = current.y - start.y;
  if (mods.shift) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  let x0 = start.x;
  let y0 = start.y;
  let x1 = start.x + dx;
  let y1 = start.y + dy;
  if (mods.alt) {
    x0 = start.x - dx;
    y0 = start.y - dy;
  }
  return [Math.min(x0, x1), Math.min(y0, y1), 0.5, Math.max(x0, x1), Math.max(y0, y1), 0.5];
}

/** Is a two-point shape big enough to keep (avoids accidental dots on click)? */
export function shapeIsDegenerate(points: readonly number[], minSize: number): boolean {
  if (points.length < 6) return true;
  return Math.hypot(points[3]! - points[0]!, points[4]! - points[1]!) < minSize;
}

/** Polygon/ellipse outline as triples (for hit tests). */
export function ellipsePolyline(points: readonly number[], segments = 48): number[] {
  const cx = (points[0]! + points[3]!) / 2;
  const cy = (points[1]! + points[4]!) / 2;
  const rx = Math.abs(points[3]! - points[0]!) / 2;
  const ry = Math.abs(points[4]! - points[1]!) / 2;
  const out: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, 0.5);
  }
  return out;
}

export function rectPolyline(points: readonly number[]): number[] {
  const [x0, y0, , x1, y1] = points as [number, number, number, number, number];
  return [x0, y0, 0.5, x1, y0, 0.5, x1, y1, 0.5, x0, y1, 0.5];
}

/** Arrow head geometry: tip, two barbs, for a shaft ending at `tip` coming from `from`. */
export function arrowHead(from: Pt, tip: Pt, width: number): [Pt, Pt, Pt] {
  const len = Math.max(width * 4.2, 6);
  const half = Math.max(width * 2.2, 3.5);
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  const bx = tip.x - Math.cos(ang) * len;
  const by = tip.y - Math.sin(ang) * len;
  const nx = -Math.sin(ang) * half;
  const ny = Math.cos(ang) * half;
  return [tip, { x: bx + nx, y: by + ny }, { x: bx - nx, y: by - ny }];
}

/** Length of the head along the shaft (the shaft stops there so the tip stays sharp). */
export const arrowHeadLength = (width: number): number => Math.max(width * 4.2, 6);

/**
 * Direction reference for an arrow head at the end of a freehand path: the
 * point roughly one head-length back, so jitter at the very end does not
 * twist the head.
 */
export function pathTailReference(flat: readonly number[], fromEnd: boolean, distance: number): Pt {
  const n = flat.length / 3;
  const idx = (k: number) => (fromEnd ? n - 1 - k : k);
  const tipX = flat[idx(0) * 3]!;
  const tipY = flat[idx(0) * 3 + 1]!;
  let acc = 0;
  let px = tipX;
  let py = tipY;
  for (let k = 1; k < n; k++) {
    const x = flat[idx(k) * 3]!;
    const y = flat[idx(k) * 3 + 1]!;
    acc += Math.hypot(x - px, y - py);
    px = x;
    py = y;
    if (acc >= distance) break;
  }
  if (px === tipX && py === tipY) return { x: tipX - 1, y: tipY };
  return { x: px, y: py };
}
