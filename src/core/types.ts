/**
 * The structured data model. Items are the source of truth; textures are
 * only caches derived from them (see `render/`).
 *
 * Coordinates are in "space units":
 *  - map items: pixels relative to the top-left corner of the scene rectangle
 *    (`canvas.dimensions.sceneRect`), measured at the scene's reference size
 *    (see `space/map-space.ts`); independent of padding and background offset.
 *  - screen items: thousandths of the shorter viewport side, relative to an
 *    anchor point of the viewport (centre, an edge or a corner).
 */

export const SCHEMA_VERSION = 1;

export type Mode = "map" | "screen";

/** Map display layer. `below`/`above` respect fog of war, `top` ignores it. */
export type MapLayer = "below" | "above" | "top";
export const MAP_LAYERS: readonly MapLayer[] = ["below", "above", "top"];

export type Kind = "stroke" | "shape" | "area" | "text" | "laser";

export type BrushId = "pen" | "pressure" | "pencil" | "marker" | "fineliner" | "soft" | "chalk" | "highlighter";
export const BRUSH_IDS: readonly BrushId[] = [
  "pen",
  "pressure",
  "pencil",
  "marker",
  "fineliner",
  "soft",
  "chalk",
  "highlighter",
];

export type ShapeId = "line" | "arrow" | "rect" | "ellipse" | "polygon";
export const SHAPE_IDS: readonly ShapeId[] = ["line", "arrow", "rect", "ellipse", "polygon"];

/** Visibility is reserved for future use; every item is visible to all viewers of its scene. */
export type Visibility = "all";

export interface ItemStyle {
  /** Dashed outline (shapes, arrows, fineliner paths). */
  dash?: boolean;
  /** Arrow heads on freehand paths and lines. */
  head?: "none" | "end" | "both";
  /** Fill opacity of closed shapes (0 = no fill). */
  fill?: number;
  /** Subtle contrasting halo that keeps marks readable on any background. */
  halo?: boolean;
  /** Polygon/polyline closed? */
  closed?: boolean;
}

/** A partial-eraser stroke attached to the item it erases from. */
export interface EraseMask {
  size: number;
  /** Flat `[x, y, pressure]` triples in the item's space. */
  points: number[];
}

export interface ScribbleItem {
  schemaVersion: number;
  id: string;
  /** User id. Always assigned from the authenticated sender, never trusted from a payload. */
  author: string;
  /** Scene the item belongs to (screen items are shown to viewers of the same scene). */
  scene: string;
  mode: Mode;
  kind: Kind;
  /** Brush id for strokes, shape id for shapes, "area" / "text" / "laser" otherwise. */
  tool: string;
  /** `#rrggbb`. */
  color: string;
  /** 0.05..1 */
  opacity: number;
  /** Stroke width (or font size for text) in space units. */
  size: number;
  /**
   * Flat triples `[x, y, z]`: z is pressure (0..1) for freehand input,
   * milliseconds since `createdAt` for laser trails, and unused (0.5) otherwise.
   */
  points: number[];
  style: ItemStyle;
  text?: string;
  /** Server time (ms) at which the item was completed. */
  createdAt: number;
  /** Server time (ms) at which fading begins; `null` = permanent. */
  expiresAt: number | null;
  /** Length of the fade-out (ms); the item is gone at `expiresAt + fadeDuration`. */
  fadeDuration: number;
  /** Map layer; screen items always use "top". */
  layer: MapLayer;
  /** Screen anchor (-1 = left/top, 0 = centre, 1 = right/bottom). */
  anchor?: [number, number];
  /** Scene level (Foundry v14 scene levels); absent = every level. */
  level?: string;
  erase?: EraseMask[];
  visibility: Visibility;
  revision: number;
}

/** Persisted/wire form: points are encoded strings (see codec.ts). */
export interface WireMask {
  size: number;
  p: string;
}

export interface WireItem extends Omit<ScribbleItem, "points" | "erase"> {
  points: string;
  erase?: WireMask[];
}

export const isPermanent = (item: Pick<ScribbleItem, "expiresAt">): boolean => item.expiresAt === null;
