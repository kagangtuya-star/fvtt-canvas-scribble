import type { SpaceAdapter } from "../core/space.ts";
import type { Entry } from "../core/store.ts";
import { hitItem } from "./hit.ts";

/**
 * Canvas colour sampler (Eyedropper).
 *
 * 1. First checks topmost visible scribble items under the pointer and returns
 *    their exact `#rrggbb` colour (works reliably even when WebGL does not
 *    preserve the drawing buffer).
 * 2. Falls back to sampling a 1×1 pixel from the board canvas (2D or WebGL
 *    via PIXI's extract plugin when available).
 */

const toHex = (r: number, g: number, b: number) =>
  `#${((1 << 24) | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)).toString(16).slice(1)}`;

export function sampleColorAt(
  cx: number,
  cy: number,
  entries: readonly Entry[],
  mapSpace: SpaceAdapter | null,
  screenSpace: SpaceAdapter,
): string | null {
  // Check items topmost first (reverse draw order).
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.item.kind === "laser" || e.state === "live") continue;
    const space = e.item.mode === "map" ? mapSpace : screenSpace;
    if (!space) continue;
    const p = space.fromClient(cx, cy, e.item.anchor);
    const radius = Math.max(4 / space.cssPerUnit(), 1);
    if (hitItem(e, p.x, p.y, radius)) return e.item.color;
  }

  // Fallback: sample directly from the board canvas if readable.
  const view = (globalThis as { canvas?: FoundryCanvas }).canvas?.app?.view;
  if (!view) return null;
  const rect = view.getBoundingClientRect();
  if (cx < rect.left || cy < rect.top || cx > rect.right || cy > rect.bottom) return null;
  const scaleX = view.width / Math.max(1, rect.width);
  const scaleY = view.height / Math.max(1, rect.height);
  const px = Math.floor((cx - rect.left) * scaleX);
  const py = Math.floor((cy - rect.top) * scaleY);

  try {
    const gl = view.getContext("webgl2") || view.getContext("webgl");
    if (gl) {
      const buf = new Uint8Array(4);
      gl.readPixels(px, view.height - 1 - py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      if (buf[3]! > 0) return toHex(buf[0]!, buf[1]!, buf[2]!);
    }
  } catch {
    /* WebGL readback may be unavailable if preserveDrawingBuffer is false */
  }
  try {
    const ctx = view.getContext("2d");
    if (ctx) {
      const d = ctx.getImageData(px, py, 1, 1).data;
      if (d[3]! > 0) return toHex(d[0]!, d[1]!, d[2]!);
    }
  } catch {
    /* ignore */
  }
  return null;
}
