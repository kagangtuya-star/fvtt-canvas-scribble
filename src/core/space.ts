import type { Mode } from "./types.ts";

/**
 * Coordinate adapters: the only place that knows how pointer positions map
 * into the two coordinate spaces. Map and screen items never share a
 * coordinate system.
 *
 * MAP (world space)
 *   Units are pixels relative to the top-left of the scene rectangle
 *   (`dimensions.sceneX/Y`), measured at the scene's *reference size* (the
 *   scene size when its first annotation was stored). Changing padding or the
 *   background offset moves `sceneX/Y`, so annotations stay on the map image;
 *   resizing the scene scales them with the image (like Foundry's own
 *   "reposition objects"); changing only the grid size leaves them in place.
 *
 * SCREEN (viewport space)
 *   Units are thousandths of the shorter side of the canvas viewport, measured
 *   from one of nine anchors (centre, edges, corners) picked from where the
 *   stroke starts. A circle stays a circle on 16:9, 21:9 or portrait
 *   windows, and a mark drawn next to the right-hand edge stays next to that
 *   edge on a narrower window.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface MapFrame {
  sceneX: number;
  sceneY: number;
  sceneWidth: number;
  sceneHeight: number;
  /** Reference scene size the stored units refer to. */
  refW: number;
  refH: number;
  gridSize: number;
}

export interface MapView {
  /** Canvas zoom (stage scale). */
  zoom(): number;
  /** Client (CSS px) → canvas coordinates. */
  toCanvas(cx: number, cy: number): Pt;
  toClient(x: number, y: number): Pt;
}

export interface Viewport {
  /** Canvas view rectangle in client CSS px. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SpaceAdapter {
  readonly mode: Mode;
  /** CSS px per space unit at the current view. */
  cssPerUnit(): number;
  /** Width in space units for a UI size (≈ CSS px) and brush width scale. */
  widthFor(uiSize: number, widthScale?: number): number;
  fromClient(cx: number, cy: number, anchor?: [number, number]): Pt;
  toClient(x: number, y: number, anchor?: [number, number]): Pt;
}

/** Brush sizes on the map are relative to the grid: UI size 5 on a 100 px grid = 5 px = 0.05 grid. */
export const MAP_SIZE_REFERENCE_GRID = 100;

export class MapSpace implements SpaceAdapter {
  readonly mode = "map" as const;
  readonly frame: MapFrame;
  readonly #view: MapView;
  /** Keep the UI size constant on screen at the time of drawing instead of relative to the grid. */
  followZoom: boolean;

  constructor(frame: MapFrame, view: MapView, followZoom = false) {
    this.frame = frame;
    this.#view = view;
    this.followZoom = followZoom;
  }

  /** Canvas px per space unit (x, y). */
  get sx(): number {
    return this.frame.sceneWidth / this.frame.refW;
  }

  get sy(): number {
    return this.frame.sceneHeight / this.frame.refH;
  }

  canvasFromSpace(x: number, y: number): Pt {
    return { x: this.frame.sceneX + x * this.sx, y: this.frame.sceneY + y * this.sy };
  }

  spaceFromCanvas(x: number, y: number): Pt {
    return { x: (x - this.frame.sceneX) / this.sx, y: (y - this.frame.sceneY) / this.sy };
  }

  cssPerUnit(): number {
    return this.#view.zoom() * this.sx;
  }

  widthFor(uiSize: number, widthScale = 1): number {
    if (this.followZoom) return (uiSize * widthScale) / this.cssPerUnit();
    return (uiSize * widthScale * (this.frame.gridSize / MAP_SIZE_REFERENCE_GRID)) / this.sx;
  }

  fromClient(cx: number, cy: number): Pt {
    const c = this.#view.toCanvas(cx, cy);
    return this.spaceFromCanvas(c.x, c.y);
  }

  toClient(x: number, y: number): Pt {
    const c = this.canvasFromSpace(x, y);
    return this.#view.toClient(c.x, c.y);
  }

  /** Visible area in space units (for culling), padded by `margin` CSS px. */
  visibleBounds(vp: Viewport, margin = 0): [number, number, number, number] {
    const a = this.fromClient(vp.left - margin, vp.top - margin);
    const b = this.fromClient(vp.left + vp.width + margin, vp.top + vp.height + margin);
    return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
  }
}

export class ScreenSpace implements SpaceAdapter {
  readonly mode = "screen" as const;
  viewport: Viewport;

  constructor(viewport: Viewport) {
    this.viewport = viewport;
  }

  /** CSS px per unit (1000 units = shorter viewport side). */
  cssPerUnit(): number {
    return Math.max(1, Math.min(this.viewport.width, this.viewport.height)) / 1000;
  }

  widthFor(uiSize: number, widthScale = 1): number {
    return (uiSize * widthScale) / this.cssPerUnit();
  }

  /** Anchor point in client px. */
  anchorPoint(anchor: [number, number]): Pt {
    const v = this.viewport;
    return { x: v.left + (v.width / 2) * (1 + anchor[0]), y: v.top + (v.height / 2) * (1 + anchor[1]) };
  }

  /** Pick the anchor for a stroke starting at a client point (viewport thirds). */
  anchorFor(cx: number, cy: number): [number, number] {
    const v = this.viewport;
    const fx = (cx - v.left) / Math.max(1, v.width);
    const fy = (cy - v.top) / Math.max(1, v.height);
    const pick = (f: number) => (f < 1 / 3 ? -1 : f > 2 / 3 ? 1 : 0);
    return [pick(fx), pick(fy)];
  }

  fromClient(cx: number, cy: number, anchor: [number, number] = [0, 0]): Pt {
    const a = this.anchorPoint(anchor);
    const u = this.cssPerUnit();
    return { x: (cx - a.x) / u, y: (cy - a.y) / u };
  }

  toClient(x: number, y: number, anchor: [number, number] = [0, 0]): Pt {
    const a = this.anchorPoint(anchor);
    const u = this.cssPerUnit();
    return { x: a.x + x * u, y: a.y + y * u };
  }
}
