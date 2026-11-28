import { BRUSHES, resolveBrushParams } from "../brush/brushes.ts";
import { ellipsePolyline, rectPolyline } from "../brush/shapes.ts";
import { quantizeAngles, quantizePoints } from "../core/codec.ts";
import { boundsOf } from "../core/geometry.ts";
import {
  apply,
  applyPt,
  chain,
  convexQuad,
  fromQuad,
  invert,
  isAffine,
  isIdentity,
  jacobian,
  multiply,
  rotate,
  scale,
  squareToQuad,
  translate,
} from "../core/matrix.ts";
import type { Mat3, Pt } from "../core/matrix.ts";
import { layoutText } from "../core/text-layout.ts";
import type { BrushId, ScribbleItem } from "../core/types.ts";

/**
 * One geometric transform for every item kind, used by Select & Transform,
 * symmetry companions and duplication. `m` maps the item's own space units
 * (affine or projective). Straight segments stay straight, so polylines map
 * exactly; widths, erase-mask sizes and nib angles follow the local scale,
 * rotation and handedness of the transform.
 */

export interface TransformOptions {
  /** Quantise the result for storage (default true; live previews skip it). */
  quantize?: boolean;
  /** Increment `revision` (default true; new companion items keep theirs). */
  bump?: boolean;
}

const wrapDeg = (deg: number): number => ((((deg + 180) % 360) + 360) % 360) - 180;
const roundDeg = (deg: number): number => Math.round(wrapDeg(deg) * 10) / 10;

/** Direction of angle `a` after a linear map `[ja, jb, jc, jd]`. */
const mapAngle = (j: readonly number[], a: number): number => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return Math.atan2(j[2]! * c + j[3]! * s, j[0]! * c + j[1]! * s);
};

export function transformItem(item: ScribbleItem, m: Mat3, opts: TransformOptions = {}): ScribbleItem {
  const quantize = opts.quantize ?? true;
  const zKind = item.kind === "laser" ? "time" : "pressure";
  const affine = isAffine(m);
  const b = boundsOf(item.points);
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  const j = jacobian(m, cx, cy);
  const det = j[0] * j[3] - j[1] * j[2];
  const k = Math.sqrt(Math.abs(det)) || 1;
  const mirrored = det < 0;
  const identityLinear = affine && Math.abs(j[0] - 1) < 1e-12 && Math.abs(j[3] - 1) < 1e-12 && !j[1] && !j[2];
  const eps = 1e-9 * Math.max(1, k);
  const axisAligned =
    affine && ((Math.abs(j[1]) < eps && Math.abs(j[2]) < eps) || (Math.abs(j[0]) < eps && Math.abs(j[3]) < eps));

  const mapPts = (flat: readonly number[], matrix = m): number[] => {
    const out = new Array<number>(flat.length);
    for (let i = 0; i + 2 < flat.length; i += 3) {
      const [x, y] = apply(matrix, flat[i]!, flat[i + 1]!);
      out[i] = x;
      out[i + 1] = y;
      out[i + 2] = flat[i + 2]!;
    }
    return out;
  };
  const q = (flat: number[]) => (quantize ? quantizePoints(flat, zKind) : flat);

  let tool = item.tool;
  let style = item.style;
  let points: number[];
  if (item.kind === "text") {
    const x = item.points[0]!;
    const y = item.points[1]!;
    const size = Math.max(0.5, Math.round(item.size * k * 10) / 10);
    const f = size / item.size;
    if (axisAligned && j[0] > 0 && j[3] > 0) {
      const [nx, ny] = apply(m, x, y);
      points = [nx, ny, item.points[2] ?? 0.5];
    } else {
      // Text never rotates: keep the box centred on the transformed centre.
      const layout = layoutText(item);
      const [nx, ny] = apply(m, x + layout.width / 2, y + layout.height / 2);
      points = [nx - (layout.width * f) / 2, ny - (layout.height * f) / 2, item.points[2] ?? 0.5];
    }
    const next: ScribbleItem = { ...item, size, points: q(points) };
    if (item.textWidth !== undefined) next.textWidth = item.textWidth * f;
    if (item.erase) {
      // The text itself stays upright and scales uniformly; its masks must do the same.
      const textMatrix: Mat3 = [f, 0, points[0]! - x * f, 0, f, points[1]! - y * f, 0, 0, 1];
      next.erase = item.erase.map((mask) => ({
        ...mask,
        points: q(mapPts(mask.points, textMatrix)),
        size: mask.size * f,
      }));
    }
    if (opts.bump ?? true) next.revision = item.revision + 1;
    return next;
  }
  if (item.kind === "shape" && (tool === "rect" || tool === "ellipse") && item.points.length >= 6) {
    if (axisAligned) {
      const [x0, y0] = apply(m, item.points[0]!, item.points[1]!);
      const [x1, y1] = apply(m, item.points[3]!, item.points[4]!);
      points = [
        Math.min(x0, x1),
        Math.min(y0, y1),
        item.points[2]!,
        Math.max(x0, x1),
        Math.max(y0, y1),
        item.points[5]!,
      ];
    } else {
      points = mapPts(tool === "rect" ? rectPolyline(item.points) : ellipsePolyline(item.points));
      tool = "polygon";
      style = { ...style, closed: true };
    }
  } else points = mapPts(item.points);

  let angles: number[] | undefined;
  if (item.angles) {
    angles = item.angles.map((a, i) => {
      const jj = affine ? j : jacobian(m, item.points[i * 3] ?? cx, item.points[i * 3 + 1] ?? cy);
      return mapAngle(jj, a);
    });
    if (quantize) angles = quantizeAngles(angles);
  }

  const brush = item.kind === "stroke" ? BRUSHES[item.tool as BrushId] : undefined;
  if (brush && (brush.tip !== "round" || (brush.renderer === "dab" && !brush.pixelAligned)) && !identityLinear) {
    const { angle, angleMode } = resolveBrushParams(brush, style.brush);
    const relative = angleMode === "follow" || (angleMode !== "fixed" && !!item.angles?.length);
    const turned = relative ? (mirrored ? -angle : angle) : (mapAngle(j, (angle * Math.PI) / 180) * 180) / Math.PI;
    const ang = roundDeg(turned);
    if (ang !== angle) style = { ...style, brush: { ...style.brush, ang } };
  } else if (!brush && style.brush?.ang !== undefined && !identityLinear) {
    const ang = roundDeg((mapAngle(j, (style.brush.ang * Math.PI) / 180) * 180) / Math.PI);
    style = { ...style, brush: { ...style.brush, ang } };
  }

  const dyn = style.brush?.dyn;
  if (brush && mirrored && dyn?.ang) {
    const { lo, hi } = dyn.ang;
    style = { ...style, brush: { ...style.brush, dyn: { ...dyn, ang: { ...dyn.ang, lo: -lo + 0, hi: -hi + 0 } } } };
  }

  const next: ScribbleItem = { ...item, tool, style, points: q(points) };
  if (item.kind !== "laser" && !identityLinear) next.size = Math.max(0.5, Math.round(item.size * k * 10) / 10);
  if (angles) next.angles = angles;
  if (item.erase) {
    next.erase = item.erase.map((mask) => {
      const out = { ...mask, points: q(mapPts(mask.points)) };
      if (!identityLinear) out.size = mask.size * k;
      if (mask.tip === "rect" && !identityLinear)
        out.ang = roundDeg((mapAngle(j, ((mask.ang ?? 0) * Math.PI) / 180) * 180) / Math.PI);
      return out;
    });
  }
  if (opts.bump ?? true) next.revision = item.revision + 1;
  return next;
}

/** Does `m` move anything at all? */
export const changesItems = (m: Mat3): boolean => !isIdentity(m);

/* -------------------------------------------- */
/*  Free transform frame                        */
/* -------------------------------------------- */

/**
 * Handles of the free-transform frame. Corners and edges scale in the
 * frame's own (possibly rotated or distorted) axes; with Ctrl an edge skews
 * and a corner distorts freely; Ctrl+Alt+Shift on a corner makes a
 * symmetric perspective. `scale` is the legacy uniform scale from the centre.
 */
export type TransformHandle =
  | "move"
  | "rotate"
  | "scale"
  | "pivot"
  | "width-left"
  | "width-right"
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w";

export const FRAME_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type FrameHandle = (typeof FRAME_HANDLES)[number];

/** Handle positions in the frame's unit square (quad order nw, ne, se, sw). */
export const HANDLE_LOCAL: Record<FrameHandle, Pt> = {
  nw: { x: 0, y: 0 },
  n: { x: 0.5, y: 0 },
  ne: { x: 1, y: 0 },
  e: { x: 1, y: 0.5 },
  se: { x: 1, y: 1 },
  s: { x: 0.5, y: 1 },
  sw: { x: 0, y: 1 },
  w: { x: 0, y: 0.5 },
};

const CORNER_INDEX: Partial<Record<FrameHandle, number>> = { nw: 0, ne: 1, se: 2, sw: 3 };
/** Corners of each edge handle (quad indices). */
const EDGE_CORNERS: Partial<Record<FrameHandle, [number, number]>> = { n: [0, 1], e: [1, 2], s: [2, 3], w: [3, 0] };
/** Neighbour along the top/bottom edge, for the symmetric perspective drag. */
const PERSPECTIVE_PARTNER = [1, 0, 3, 2];

export interface FrameState {
  /** Frame corners (nw, ne, se, sw) in reference space. */
  quad: readonly Pt[];
  pivot: Pt;
}

export interface FrameDrag extends FrameState {
  handle: TransformHandle;
  /** Pointer at drag start (reference space). */
  origin: Pt;
}

export interface FrameModifiers {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

/** Point at local `(u, v)` of a frame. */
export function framePoint(quad: readonly Pt[], u: number, v: number): Pt {
  const h = squareToQuad(quad);
  return h ? applyPt(h, { x: u, y: v }) : { x: quad[0]!.x, y: quad[0]!.y };
}

/**
 * Transform for dragging a frame handle to `p` (reference space), with the
 * resulting frame; null when the drag would degenerate or fold the frame.
 */
export function frameTransform(
  drag: FrameDrag,
  p: Pt,
  mods: FrameModifiers = {},
): { m: Mat3; quad: Pt[]; pivot: Pt } | null {
  const { quad, pivot, origin, handle } = drag;
  const done = (m: Mat3, nextQuad?: Pt[]) => {
    const q = nextQuad ?? quad.map((c) => applyPt(m, c));
    return { m, quad: q, pivot: applyPt(m, pivot) };
  };
  switch (handle) {
    case "move": {
      let dx = p.x - origin.x;
      let dy = p.y - origin.y;
      if (mods.shift) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      return done(translate(dx, dy));
    }
    case "rotate": {
      let rad = Math.atan2(p.y - pivot.y, p.x - pivot.x) - Math.atan2(origin.y - pivot.y, origin.x - pivot.x);
      if (mods.shift) rad = Math.round(rad / (Math.PI / 12)) * (Math.PI / 12);
      return done(rotate(rad, pivot.x, pivot.y));
    }
    case "scale": {
      const c = framePoint(quad, 0.5, 0.5);
      const d0 = Math.max(1e-6, Math.hypot(origin.x - c.x, origin.y - c.y));
      const f = Math.max(0.15, Math.min(8, Math.hypot(p.x - c.x, p.y - c.y) / d0));
      return done(scale(f, f, c.x, c.y));
    }
    case "pivot":
    case "width-left":
    case "width-right":
      return null;
  }
  const h0 = squareToQuad(quad);
  const inv = h0 && invert(h0);
  if (!h0 || !inv) return null;
  const corner = CORNER_INDEX[handle];
  const edge = EDGE_CORNERS[handle];
  if (mods.ctrl && corner !== undefined) {
    const next = quad.map((c) => ({ x: c.x, y: c.y }));
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    if (mods.alt && mods.shift) {
      // Symmetric perspective: slide this corner and its partner apart along their edge.
      const partner = PERSPECTIVE_PARTNER[corner]!;
      const ex = quad[partner]!.x - quad[corner]!.x;
      const ey = quad[partner]!.y - quad[corner]!.y;
      const len = Math.hypot(ex, ey) || 1;
      const t = (dx * ex + dy * ey) / len;
      next[corner] = { x: quad[corner]!.x + (ex / len) * t, y: quad[corner]!.y + (ey / len) * t };
      next[partner] = { x: quad[partner]!.x - (ex / len) * t, y: quad[partner]!.y - (ey / len) * t };
    } else next[corner] = { x: quad[corner]!.x + dx, y: quad[corner]!.y + dy };
    if (!convexQuad(next)) return null;
    const m = fromQuad(quad, next);
    return m ? done(m, next) : null;
  }
  if (mods.ctrl && edge) {
    // Skew: slide the edge along its own direction.
    const [i, j] = edge;
    const ex = quad[j]!.x - quad[i]!.x;
    const ey = quad[j]!.y - quad[i]!.y;
    const len = Math.hypot(ex, ey) || 1;
    const t = ((p.x - origin.x) * ex + (p.y - origin.y) * ey) / len;
    const next = quad.map((c) => ({ x: c.x, y: c.y }));
    next[i] = { x: quad[i]!.x + (ex / len) * t, y: quad[i]!.y + (ey / len) * t };
    next[j] = { x: quad[j]!.x + (ex / len) * t, y: quad[j]!.y + (ey / len) * t };
    if (!convexQuad(next)) return null;
    const m = fromQuad(quad, next);
    return m ? done(m, next) : null;
  }
  // Scale in the frame's local axes.
  const hl = HANDLE_LOCAL[handle];
  const l = applyPt(inv, p);
  const o = applyPt(inv, origin);
  const fixed = mods.alt ? { x: 0.5, y: 0.5 } : { x: 1 - hl.x, y: 1 - hl.y };
  const ratio = (cur: number, start: number, f: number) => {
    const d = start - f;
    return Math.abs(d) < 1e-9 ? 1 : (cur - f) / d;
  };
  let sx = hl.x === 0.5 ? 1 : ratio(l.x, o.x, fixed.x);
  let sy = hl.y === 0.5 ? 1 : ratio(l.y, o.y, fixed.y);
  if (corner !== undefined && !mods.shift) {
    // Corners keep the proportions unless Shift frees them.
    const vx = o.x - fixed.x;
    const vy = o.y - fixed.y;
    const len2 = vx * vx + vy * vy || 1;
    const f = ((l.x - fixed.x) * vx + (l.y - fixed.y) * vy) / len2;
    sx = f;
    sy = f;
  }
  const clampScale = (v: number) => (Math.abs(v) < 0.02 ? (v < 0 ? -0.02 : 0.02) : v);
  sx = clampScale(sx);
  sy = clampScale(sy);
  const local = scale(sx, sy, fixed.x, fixed.y);
  const m = multiply(h0, multiply(local, inv));
  return done(m);
}

/** Apply a reference-space transform `m` to a frame. */
export function transformFrame(frame: FrameState, m: Mat3): FrameState {
  return { quad: frame.quad.map((c) => applyPt(m, c)), pivot: applyPt(m, frame.pivot) };
}

/** Direction (radians) of the frame's top edge. */
export function frameAngle(quad: readonly Pt[]): number {
  return Math.atan2(quad[1]!.y - quad[0]!.y, quad[1]!.x - quad[0]!.x);
}

/** Uniform scale by `f` around the pivot. */
export const scaleAbout = (f: number, pivot: Pt): Mat3 => scale(f, f, pivot.x, pivot.y);

/** Rotation by `deg` around the pivot. */
export const rotateAbout = (deg: number, pivot: Pt): Mat3 => rotate((deg * Math.PI) / 180, pivot.x, pivot.y);

/** Mirror the frame left↔right (`h`) or top↔bottom (`v`) about the pivot, in the frame's axes. */
export function flipAbout(axis: "h" | "v", quad: readonly Pt[], pivot: Pt): Mat3 {
  const a = frameAngle(quad);
  return chain(
    rotate(-a, pivot.x, pivot.y),
    scale(axis === "h" ? -1 : 1, axis === "v" ? -1 : 1, pivot.x, pivot.y),
    rotate(a, pivot.x, pivot.y),
  );
}
