import { BRUSHES, DEFAULT_PALETTE, UI_SIZE } from "../brush/brushes.ts";
import { LIMITS } from "../constants.ts";
import { MAP_LAYERS, BRUSH_IDS } from "../core/types.ts";
import type { BrushId, MapLayer, Mode } from "../core/types.ts";
import { clamp } from "../core/util.ts";

/**
 * Per-client tool preferences (stored in a hidden client setting). Values
 * read back from storage are validated: a hand-edited or outdated setting
 * must never break the UI.
 */

export type ToolId = "draw" | "highlight" | "arrow" | "shape" | "laser" | "text" | "eraser";
export const TOOL_IDS: readonly ToolId[] = ["draw", "highlight", "arrow", "shape", "laser", "text", "eraser"];

export type ShapeVariant = "line" | "rect" | "ellipse" | "polygon";
export const SHAPE_VARIANTS: readonly ShapeVariant[] = ["line", "rect", "ellipse", "polygon"];

/** Arrow tool: a straight arrow or a freehand path with a head. */
export type ArrowVariant = "straight" | "path";
export const ARROW_VARIANTS: readonly ArrowVariant[] = ["straight", "path"];

/** Highlight tool: highlighter strokes or a filled lasso area. */
export type HighlightVariant = "stroke" | "area";
export const HIGHLIGHT_VARIANTS: readonly HighlightVariant[] = ["stroke", "area"];

export type EraserVariant = "stroke" | "partial";
export const ERASER_VARIANTS: readonly EraserVariant[] = ["stroke", "partial"];

export type HeadStyle = "end" | "both";

/** Size keys: every freehand brush plus the non-brush tools. */
export type SizeKey = BrushId | "arrow" | "shape" | "area" | "laser" | "text" | "eraser";

export interface Prefs {
  mode: Mode;
  tool: ToolId;
  brush: Exclude<BrushId, "highlighter">;
  shape: ShapeVariant;
  arrow: ArrowVariant;
  highlight: HighlightVariant;
  eraser: EraserVariant;
  /** `null` = the user's player colour. */
  color: string | null;
  recent: string[];
  sizes: Record<SizeKey, number>;
  /** Lifetime (ms, 0 = permanent; screen never permanent). */
  lifetime: Record<Mode, number>;
  fade: Record<Mode, number>;
  laserTrail: number;
  /** Map layer for temporary and for permanent items. */
  layer: { temporary: MapLayer; permanent: MapLayer };
  halo: boolean;
  dash: boolean;
  head: HeadStyle;
  /** Fill closed shapes. */
  fill: boolean;
  /** Palette position (px from the bottom-left of the docking area) or null = docked. */
  palette: { x: number; y: number } | null;
  /** Palette collapsed to the mode switch and colour. */
  compact: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  mode: "screen",
  tool: "draw",
  brush: "pen",
  shape: "rect",
  arrow: "straight",
  highlight: "stroke",
  eraser: "stroke",
  color: null,
  recent: [],
  sizes: {
    pen: BRUSHES.pen.defaultSize,
    pressure: BRUSHES.pressure.defaultSize,
    pencil: BRUSHES.pencil.defaultSize,
    marker: BRUSHES.marker.defaultSize,
    fineliner: BRUSHES.fineliner.defaultSize,
    soft: BRUSHES.soft.defaultSize,
    chalk: BRUSHES.chalk.defaultSize,
    highlighter: BRUSHES.highlighter.defaultSize,
    flat: BRUSHES.flat.defaultSize,
    calligraphy: BRUSHES.calligraphy.defaultSize,
    bristle: BRUSHES.bristle.defaultSize,
    pixel: BRUSHES.pixel.defaultSize,
    charcoal: BRUSHES.charcoal.defaultSize,
    airbrush: BRUSHES.airbrush.defaultSize,
    watercolor: BRUSHES.watercolor.defaultSize,
    neon: BRUSHES.neon.defaultSize,
    splatter: BRUSHES.splatter.defaultSize,
    arrow: 5,
    shape: 4,
    area: 3,
    laser: 6,
    text: 22,
    eraser: 24,
  },
  lifetime: { screen: 8000, map: 60_000 },
  fade: { screen: 600, map: 1000 },
  laserTrail: 1200,
  layer: { temporary: "top", permanent: "above" },
  halo: true,
  dash: false,
  head: "end",
  fill: false,
  palette: null,
  compact: false,
};

const pick = <T extends string>(v: unknown, list: readonly T[], fallback: T): T =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback;

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

const numIn = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : fallback;

const HEX = /^#[0-9a-f]{6}$/;

/** Validate stored preferences (unknown input → full, valid object). */
export function normalizePrefs(raw: unknown): Prefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const d = DEFAULT_PREFS;
  const sizes = { ...d.sizes };
  for (const key of Object.keys(sizes) as SizeKey[]) {
    sizes[key] = numIn(
      r.sizes?.[key],
      UI_SIZE.min,
      key === "text" ? 96 : key === "eraser" ? 160 : UI_SIZE.max,
      d.sizes[key],
    );
  }
  const brushes = BRUSH_IDS.filter((b) => b !== "highlighter") as Prefs["brush"][];
  const color = typeof r.color === "string" && HEX.test(r.color) ? r.color : null;
  const recent = Array.isArray(r.recent)
    ? r.recent.filter((c: unknown) => typeof c === "string" && HEX.test(c)).slice(0, 8)
    : [];
  const life = (m: Mode) => {
    const v = numIn(r.lifetime?.[m], 0, LIMITS.maxLifetimeMs, d.lifetime[m]);
    return m === "screen" && v === 0 ? d.lifetime.screen : v;
  };
  const palette =
    r.palette && typeof r.palette === "object" && Number.isFinite(r.palette.x) && Number.isFinite(r.palette.y)
      ? { x: Math.round(r.palette.x), y: Math.round(r.palette.y) }
      : null;
  return {
    mode: r.mode === "map" ? "map" : "screen",
    tool: pick(r.tool, TOOL_IDS, d.tool),
    brush: pick(r.brush, brushes, d.brush),
    shape: pick(r.shape, SHAPE_VARIANTS, d.shape),
    arrow: pick(r.arrow, ARROW_VARIANTS, d.arrow),
    highlight: pick(r.highlight, HIGHLIGHT_VARIANTS, d.highlight),
    eraser: pick(r.eraser, ERASER_VARIANTS, d.eraser),
    color,
    recent,
    sizes,
    lifetime: { screen: life("screen"), map: life("map") },
    fade: {
      screen: numIn(r.fade?.screen, 0, LIMITS.maxFadeMs, d.fade.screen),
      map: numIn(r.fade?.map, 0, LIMITS.maxFadeMs, d.fade.map),
    },
    laserTrail: numIn(r.laserTrail, 300, 5000, d.laserTrail),
    layer: {
      temporary: pick(r.layer?.temporary, MAP_LAYERS, d.layer.temporary),
      permanent: pick(r.layer?.permanent, MAP_LAYERS, d.layer.permanent),
    },
    halo: bool(r.halo, d.halo),
    dash: bool(r.dash, d.dash),
    head: r.head === "both" ? "both" : "end",
    fill: bool(r.fill, d.fill),
    palette,
    compact: bool(r.compact, d.compact),
  };
}

/** Size key of the active tool. */
export function sizeKey(p: Prefs): SizeKey {
  switch (p.tool) {
    case "draw":
      return p.brush;
    case "highlight":
      return p.highlight === "area" ? "area" : "highlighter";
    default:
      return p.tool;
  }
}

/** Add a colour to the recent list (most recent first, palette colours excluded). */
export function pushRecent(p: Prefs, color: string): string[] {
  if (DEFAULT_PALETTE.includes(color)) return p.recent;
  return [color, ...p.recent.filter((c) => c !== color)].slice(0, 6);
}
