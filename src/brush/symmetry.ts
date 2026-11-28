import { IDENTITY, multiply, reflect, rotate } from "../core/matrix.ts";
import type { Mat3 } from "../core/matrix.ts";
import type { ScribbleItem } from "../core/types.ts";
import { transformItem } from "../tools/transform.ts";

/**
 * Symmetry / Mirror / Radial / Kaleidoscope drawing transforms.
 *
 * Symmetry expands a single gesture into standard companion `ScribbleItem`s
 * committed in one Undo batch, so multiplayer sync, partial erasing, hit-testing
 * and tile caching work automatically with zero protocol overhead.
 * Every mode yields at most twelve transforms (`MAX_LIVE_BATCH`).
 */

export type SymmetryMode =
  | "none"
  | "vertical"
  | "horizontal"
  | "quad"
  | "radial4"
  | "radial6"
  | "radial8"
  | "radial12"
  | "kaleido3"
  | "kaleido4"
  | "kaleido6";
export const SYMMETRY_MODES: readonly SymmetryMode[] = [
  "none",
  "vertical",
  "horizontal",
  "quad",
  "radial4",
  "radial6",
  "radial8",
  "radial12",
  "kaleido3",
  "kaleido4",
  "kaleido6",
];

/** A symmetry transform: a matrix in the drawing's space units. */
export type PointTransform = Mat3;

/** Mirror axes of a mode (angles of the axis lines, radians), for the guide overlay. */
export function symmetryAxes(mode: SymmetryMode, angleDeg = 0): number[] {
  const a = (angleDeg * Math.PI) / 180;
  switch (mode) {
    case "vertical":
      return [a + Math.PI / 2];
    case "horizontal":
      return [a];
    case "quad":
      return [a, a + Math.PI / 2];
    default: {
      const n = foldOf(mode);
      if (!n) return [];
      // Radial modes show their sector rays; kaleidoscopes their full mirror lines.
      const step = mode.startsWith("kaleido") ? Math.PI / n : (2 * Math.PI) / n;
      return Array.from({ length: n }, (_, i) => a + i * step);
    }
  }
}

/** Rotational order of radial and kaleidoscope modes (0 otherwise). */
export function foldOf(mode: SymmetryMode): number {
  if (mode.startsWith("radial")) return Number(mode.slice(6));
  if (mode.startsWith("kaleido")) return Number(mode.slice(7));
  return 0;
}

/**
 * Returns the full list of transforms for `mode` around centre `(cx, cy)`,
 * with the mirror axes turned by `angleDeg`. Index 0 is always the identity
 * (the primary stroke).
 */
export function symmetryTransforms(mode: SymmetryMode, cx: number, cy: number, angleDeg = 0): Mat3[] {
  const a = (angleDeg * Math.PI) / 180;
  switch (mode) {
    case "vertical":
      return [IDENTITY, reflect(a + Math.PI / 2, cx, cy)];
    case "horizontal":
      return [IDENTITY, reflect(a, cx, cy)];
    case "quad":
      return [IDENTITY, reflect(a + Math.PI / 2, cx, cy), reflect(a, cx, cy), rotate(Math.PI, cx, cy)];
    case "none":
      return [IDENTITY];
    default: {
      const n = foldOf(mode);
      const list: Mat3[] = [IDENTITY];
      for (let i = 1; i < n; i++) list.push(rotate((i / n) * Math.PI * 2, cx, cy));
      if (mode.startsWith("kaleido")) {
        // Dihedral group Dn: the rotations plus a mirror through each sector boundary.
        const mirror = reflect(a, cx, cy);
        for (let i = 0; i < n; i++) list.push(multiply(rotate((i / n) * Math.PI * 2, cx, cy), mirror));
      }
      return list;
    }
  }
}

/** Apply a symmetry transform to a ScribbleItem, producing a mirrored/rotated copy with a new id. */
export function cloneTransformedItem(item: ScribbleItem, id: string, t: PointTransform): ScribbleItem {
  return { ...transformItem(item, t, { quantize: false, bump: false }), id };
}
