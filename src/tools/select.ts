import { rotate, scale, translate } from "../core/matrix.ts";
import type { ScribbleItem } from "../core/types.ts";
import { transformItem } from "./transform.ts";

/**
 * Convenience transforms for the Select & Transform tool, all expressed
 * through {@link transformItem}: translate, scale and rotate any
 * `ScribbleItem` (including its erase masks, per-point angles and nib angle).
 */

export function translateItem(item: ScribbleItem, dx: number, dy: number): ScribbleItem {
  return transformItem(item, translate(dx, dy));
}

export function scaleItem(item: ScribbleItem, cx: number, cy: number, sx: number, sy: number): ScribbleItem {
  return transformItem(item, scale(sx, sy, cx, cy));
}

export function rotateItem(item: ScribbleItem, cx: number, cy: number, rad: number): ScribbleItem {
  return transformItem(item, rotate(rad, cx, cy));
}
