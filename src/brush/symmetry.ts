import type { BrushId, ScribbleItem } from "../core/types.ts";
import { BRUSHES, resolveBrushParams } from "./brushes.ts";
import { ellipsePolyline, rectPolyline } from "./shapes.ts";

/**
 * Symmetry / Mirror / Radial drawing transforms.
 *
 * Symmetry expands a single gesture into standard companion `ScribbleItem`s
 * committed in one Undo batch, so multiplayer sync, partial erasing, hit-testing
 * and tile caching work automatically with zero protocol overhead.
 */

export type SymmetryMode = "none" | "vertical" | "horizontal" | "quad" | "radial4" | "radial6" | "radial8" | "radial12";
export const SYMMETRY_MODES: readonly SymmetryMode[] = [
  "none",
  "vertical",
  "horizontal",
  "quad",
  "radial4",
  "radial6",
  "radial8",
  "radial12",
];

export interface PointTransform {
  point(x: number, y: number): [number, number];
  angle(rad: number): number;
  /** Mirror reflection flips nib angle signs. */
  mirrored: boolean;
}

const IDENTITY: PointTransform = {
  point: (x, y) => [x, y],
  angle: (a) => a,
  mirrored: false,
};

function mirrorX(cx: number): PointTransform {
  return {
    point: (x, y) => [2 * cx - x, y],
    angle: (a) => Math.PI - a,
    mirrored: true,
  };
}

function mirrorY(cy: number): PointTransform {
  return {
    point: (x, y) => [x, 2 * cy - y],
    angle: (a) => -a,
    mirrored: true,
  };
}

function rotateAround(cx: number, cy: number, rad: number): PointTransform {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    point: (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
    },
    angle: (a) => a + rad,
    mirrored: false,
  };
}

/**
 * Returns the full list of transforms for `mode` around centre `(cx, cy)`.
 * Index 0 is always the identity (the primary stroke).
 */
export function symmetryTransforms(mode: SymmetryMode, cx: number, cy: number): PointTransform[] {
  switch (mode) {
    case "vertical":
      return [IDENTITY, mirrorX(cx)];
    case "horizontal":
      return [IDENTITY, mirrorY(cy)];
    case "quad":
      return [IDENTITY, mirrorX(cx), mirrorY(cy), rotateAround(cx, cy, Math.PI)];
    case "radial4":
    case "radial6":
    case "radial8":
    case "radial12": {
      const n = Number(mode.slice(6));
      const list: PointTransform[] = [IDENTITY];
      for (let i = 1; i < n; i++) list.push(rotateAround(cx, cy, (i / n) * Math.PI * 2));
      return list;
    }
    default:
      return [IDENTITY];
  }
}

export function transformPoints(flat: readonly number[], t: PointTransform): number[] {
  const out = new Array<number>(flat.length);
  for (let i = 0; i + 2 < flat.length; i += 3) {
    const [nx, ny] = t.point(flat[i]!, flat[i + 1]!);
    out[i] = nx;
    out[i + 1] = ny;
    out[i + 2] = flat[i + 2]!;
  }
  return out;
}

export function transformAngles(angles: readonly number[], t: PointTransform): number[] {
  return angles.map((a) => t.angle(a));
}

/** Apply a symmetry transform to a ScribbleItem, producing a mirrored/rotated copy with a new id. */
export function cloneTransformedItem(item: ScribbleItem, id: string, t: PointTransform): ScribbleItem {
  let tool = item.tool;
  let points = transformPoints(item.points, t);
  const angles = item.angles ? transformAngles(item.angles, t) : undefined;
  let style = item.style;
  if (item.kind === "shape" && (tool === "rect" || tool === "ellipse") && points.length >= 6) {
    if (Math.abs(Math.sin(2 * t.angle(0))) > 1e-6) {
      points = transformPoints(tool === "rect" ? rectPolyline(item.points) : ellipsePolyline(item.points), t);
      tool = "polygon";
      style = { ...style, closed: true };
    } else {
      const [x0, y0, , x1, y1] = points as [number, number, number, number, number];
      points = [Math.min(x0, x1), Math.min(y0, y1), points[2]!, Math.max(x0, x1), Math.max(y0, y1), points[5]!];
    }
  }
  const brush = item.kind === "stroke" ? BRUSHES[item.tool as BrushId] : undefined;
  if (brush && (brush.tip !== "round" || (brush.renderer === "dab" && !brush.pixelAligned)) && t !== IDENTITY) {
    const { angle, angleMode } = resolveBrushParams(brush, style.brush);
    const relative = angleMode === "follow" || (angleMode !== "fixed" && !!angles?.length);
    const transformed = relative ? (t.mirrored ? -angle : angle) : (t.angle((angle * Math.PI) / 180) * 180) / Math.PI;
    const norm = ((((transformed + 180) % 360) + 360) % 360) - 180;
    const ang = Math.round(norm * 10) / 10;
    if (ang !== angle) style = { ...style, brush: { ...style.brush, ang } };
  }
  const copy: ScribbleItem = { ...item, id, tool, points, style };
  if (angles) copy.angles = angles;
  return copy;
}
