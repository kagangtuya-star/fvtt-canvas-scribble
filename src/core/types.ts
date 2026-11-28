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

export type BrushId =
  | "pen"
  | "pressure"
  | "pencil"
  | "marker"
  | "fineliner"
  | "soft"
  | "chalk"
  | "highlighter"
  | "flat"
  | "calligraphy"
  | "bristle"
  | "pixel"
  | "charcoal"
  | "airbrush"
  | "watercolor"
  | "neon"
  | "splatter";

export const BRUSH_IDS: readonly BrushId[] = [
  "pen",
  "pressure",
  "pencil",
  "marker",
  "fineliner",
  "soft",
  "chalk",
  "highlighter",
  "flat",
  "calligraphy",
  "bristle",
  "pixel",
  "charcoal",
  "airbrush",
  "watercolor",
  "neon",
  "splatter",
];

export type ShapeId = "line" | "arrow" | "rect" | "ellipse" | "polygon";
export const SHAPE_IDS: readonly ShapeId[] = ["line", "arrow", "rect", "ellipse", "polygon"];

export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "lighter";
export const BLEND_MODES: readonly BlendMode[] = ["normal", "multiply", "screen", "overlay", "lighter"];

export type AngleMode = "fixed" | "follow" | "tilt" | "twist";
export const ANGLE_MODES: readonly AngleMode[] = ["fixed", "follow", "tilt", "twist"];

export type FillPattern = "solid" | "hachure" | "cross-hatch" | "dots";
export const FILL_PATTERNS: readonly FillPattern[] = ["solid", "hachure", "cross-hatch", "dots"];

export type TipShape = "round" | "rect" | "bristle";
export const TIP_SHAPES: readonly TipShape[] = ["round", "rect", "bristle"];

/**
 * Per-stroke overrides of brush parameters. Only values differing from the
 * brush preset's defaults are stored, keeping Scene flags and packets small.
 */
export interface BrushOverride {
  /** Base nib angle in degrees (-180..180). */
  ang?: number;
  /** How nib angle responds to input / path tangent. */
  am?: AngleMode;
  /** Nib aspect ratio / roundness (0.05..1.0; 1 = square/circle, 0.2 = flat). */
  asp?: number;
  /** Corner roundness for rectangular nibs (0 = sharp box, 1 = capsule/ellipse). */
  cor?: number;
  /** Tip edge hardness (0..1; 0 = airbrush soft, 1 = crisp). */
  hrd?: number;
  /** Per-dab flow / buildup opacity (0.05..1). */
  flw?: number;
  /** Dab spacing as a multiple of stroke width (0.08..3.0). */
  spc?: number;
  /** Perpendicular scatter radius as a multiple of stroke width (0..3.0). */
  sct?: number;
  /** Procedural paper/surface grain strength (0..1). */
  grn?: number;
  /** Hand-drawn roughness for roughjs shapes/areas (0..3.0; 0 = crisp vector). */
  rgh?: number;
}

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
  /** Canvas/PIXI blend mode when compositing this item. */
  blend?: BlendMode;
  /** Fill pattern for closed shapes and areas (roughjs patterns). */
  fillPattern?: FillPattern;
  /** Per-item overrides of brush/shape rendering parameters. */
  brush?: BrushOverride;
}

/** A partial-eraser stroke attached to the item it erases from. */
export interface EraseMask {
  size: number;
  /** Flat `[x, y, pressure]` triples in the item's space. */
  points: number[];
  /** Optional eraser nib shape (defaults to round). */
  tip?: "round" | "rect";
  /** Optional nib angle in degrees (-180..180, for rectangular eraser). */
  ang?: number;
  /** Optional nib aspect ratio (0.1..1, for rectangular eraser). */
  asp?: number;
  /** Optional softness/hardness (0..1, 1 = crisp). */
  hrd?: number;
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
  /**
   * Optional per-point nib angle in radians (-PI..PI), parallel to `points`
   * (length = `points.length / 3`), recorded when a brush uses pen tilt azimuth
   * or barrel twist (or simulated dynamic angle).
   */
  angles?: number[];
  style: ItemStyle;
  text?: string;
  /** Text wrapping width in space units; absent = natural width and explicit newlines only. */
  textWidth?: number;
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
  tip?: "round" | "rect";
  ang?: number;
  asp?: number;
  hrd?: number;
}

export interface WireItem extends Omit<ScribbleItem, "points" | "angles" | "erase"> {
  points: string;
  angles?: string;
  erase?: WireMask[];
}

export const isPermanent = (item: Pick<ScribbleItem, "expiresAt">): boolean => item.expiresAt === null;
