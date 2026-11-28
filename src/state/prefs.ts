import { BRUSHES, DEFAULT_PALETTE, UI_SIZE } from "../brush/brushes.ts";
import { STABILIZER_MODES } from "../brush/stabilizer.ts";
import type { StabilizerMode } from "../brush/stabilizer.ts";
import { SYMMETRY_MODES } from "../brush/symmetry.ts";
import type { SymmetryMode } from "../brush/symmetry.ts";
import { LIMITS } from "../constants.ts";
import { ANGLE_MODES, BLEND_MODES, BRUSH_IDS, FILL_PATTERNS, MAP_LAYERS } from "../core/types.ts";
import type { AngleMode, BlendMode, BrushId, BrushOverride, FillPattern, MapLayer, Mode } from "../core/types.ts";
import { clamp } from "../core/util.ts";

/**
 * Per-client tool preferences (stored in a hidden client setting). Values
 * read back from storage are validated: a hand-edited or outdated setting
 * must never break the UI.
 */

export type ToolId = "draw" | "highlight" | "arrow" | "shape" | "laser" | "text" | "eraser" | "select" | "eyedropper";
export const TOOL_IDS: readonly ToolId[] = [
  "draw",
  "highlight",
  "arrow",
  "shape",
  "laser",
  "text",
  "eraser",
  "select",
  "eyedropper",
];

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

export type EraserTip = "round" | "rect";

export type HeadStyle = "end" | "both";

/** User-saved custom brush preset. */
export interface BrushPreset {
  id: string;
  name: string;
  base: Exclude<BrushId, "highlighter">;
  size: number;
  opacity: number;
  blend: BlendMode;
  params: BrushOverride;
}

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
  eraserTip: EraserTip;
  eraserAngle: number;
  eraserAspect: number;
  eraserHardness: number;
  /** `null` = the user's player colour. */
  color: string | null;
  /** Secondary / swap colour (`X` swaps with foreground). */
  secondaryColor: string;
  recent: string[];
  sizes: Record<SizeKey, number>;
  /** Per-brush opacity overrides (0.05..1); absent = brush default. */
  opacities: Partial<Record<BrushId, number>>;
  /** Per-brush blend mode overrides; absent = brush default. */
  blends: Partial<Record<BrushId, BlendMode>>;
  /** Per-brush Studio parameter overrides. */
  brushParams: Partial<Record<BrushId, BrushOverride>>;
  /** User-saved custom brush presets. */
  presets: BrushPreset[];
  /** Pointer stabilization mode & strength (0..1). */
  stabilizer: StabilizerMode;
  stabilizerStrength: number;
  /** Hold at end of a freehand stroke to snap into a clean geometric shape. */
  quickShape: boolean;
  /** Mirror / radial symmetry mode. */
  symmetry: SymmetryMode;
  /** Snap shapes, lines and pixel strokes to the Foundry map grid. */
  gridSnap: boolean;
  /** Hand-drawn roughness for shapes & areas (0 = crisp, 0.5..3 = roughjs sketch). */
  roughness: number;
  /** Fill pattern for closed shapes & areas. */
  fillPattern: FillPattern;
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
  eraserTip: "round",
  eraserAngle: 0,
  eraserAspect: 0.5,
  eraserHardness: 1,
  color: null,
  secondaryColor: "#f4f1ea",
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
  opacities: {},
  blends: {},
  brushParams: {},
  presets: [],
  stabilizer: "off",
  stabilizerStrength: 0.45,
  quickShape: true,
  symmetry: "none",
  gridSnap: false,
  roughness: 0,
  fillPattern: "solid",
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

const optNumIn = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : undefined;

const HEX = /^#[0-9a-f]{6}$/;

export function normalizeBrushOverride(raw: unknown): BrushOverride {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const b = raw as Record<string, unknown>;
  const out: BrushOverride = {};
  const ang = optNumIn(b.ang, -180, 180);
  if (ang !== undefined) out.ang = Math.round(ang * 10) / 10;
  if (typeof b.am === "string" && (ANGLE_MODES as readonly string[]).includes(b.am)) out.am = b.am as AngleMode;
  const asp = optNumIn(b.asp, 0.05, 1);
  if (asp !== undefined) out.asp = Math.round(asp * 100) / 100;
  const cor = optNumIn(b.cor, 0, 1);
  if (cor !== undefined) out.cor = Math.round(cor * 100) / 100;
  const hrd = optNumIn(b.hrd, 0, 1);
  if (hrd !== undefined) out.hrd = Math.round(hrd * 100) / 100;
  const flw = optNumIn(b.flw, 0.05, 1);
  if (flw !== undefined) out.flw = Math.round(flw * 100) / 100;
  const spc = optNumIn(b.spc, 0.08, 3);
  if (spc !== undefined) out.spc = Math.round(spc * 100) / 100;
  const sct = optNumIn(b.sct, 0, 3);
  if (sct !== undefined) out.sct = Math.round(sct * 100) / 100;
  const grn = optNumIn(b.grn, 0, 1);
  if (grn !== undefined) out.grn = Math.round(grn * 100) / 100;
  const rgh = optNumIn(b.rgh, 0, 3);
  if (rgh !== undefined) out.rgh = Math.round(rgh * 100) / 100;
  return out;
}

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
  const secondaryColor =
    typeof r.secondaryColor === "string" && HEX.test(r.secondaryColor) ? r.secondaryColor : d.secondaryColor;
  const recent = Array.isArray(r.recent)
    ? r.recent.filter((c: unknown) => typeof c === "string" && HEX.test(c)).slice(0, 8)
    : [];

  const opacities: Partial<Record<BrushId, number>> = {};
  if (r.opacities && typeof r.opacities === "object") {
    for (const id of BRUSH_IDS) {
      const v = optNumIn(r.opacities[id], 0.05, 1);
      if (v !== undefined) opacities[id] = Math.round(v * 100) / 100;
    }
  }
  const blends: Partial<Record<BrushId, BlendMode>> = {};
  if (r.blends && typeof r.blends === "object") {
    for (const id of BRUSH_IDS) {
      const v = r.blends[id];
      if (typeof v === "string" && (BLEND_MODES as readonly string[]).includes(v)) blends[id] = v as BlendMode;
    }
  }
  const brushParams: Partial<Record<BrushId, BrushOverride>> = {};
  if (r.brushParams && typeof r.brushParams === "object") {
    for (const id of BRUSH_IDS) {
      const ov = normalizeBrushOverride(r.brushParams[id]);
      if (Object.keys(ov).length) brushParams[id] = ov;
    }
  }

  const presets: BrushPreset[] = [];
  if (Array.isArray(r.presets)) {
    for (const item of r.presets.slice(0, 40)) {
      if (!item || typeof item !== "object") continue;
      const id = typeof item.id === "string" && item.id.trim() ? item.id.slice(0, 32) : "";
      const name = typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 40) : "";
      if (!id || !name) continue;
      const base = pick(item.base, brushes, "pen");
      presets.push({
        id,
        name,
        base,
        size: numIn(item.size, UI_SIZE.min, UI_SIZE.max, BRUSHES[base].defaultSize),
        opacity: numIn(item.opacity, 0.05, 1, BRUSHES[base].opacity),
        blend: pick(item.blend, BLEND_MODES, BRUSHES[base].blend),
        params: normalizeBrushOverride(item.params),
      });
    }
  }

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
    eraserTip: r.eraserTip === "rect" ? "rect" : "round",
    eraserAngle: numIn(r.eraserAngle, -180, 180, d.eraserAngle),
    eraserAspect: numIn(r.eraserAspect, 0.1, 1, d.eraserAspect),
    eraserHardness: numIn(r.eraserHardness, 0, 1, d.eraserHardness),
    color,
    secondaryColor,
    recent,
    sizes,
    opacities,
    blends,
    brushParams,
    presets,
    stabilizer: pick(r.stabilizer, STABILIZER_MODES, d.stabilizer),
    stabilizerStrength: numIn(r.stabilizerStrength, 0, 1, d.stabilizerStrength),
    quickShape: bool(r.quickShape, d.quickShape),
    symmetry: pick(r.symmetry, SYMMETRY_MODES, d.symmetry),
    gridSnap: bool(r.gridSnap, d.gridSnap),
    roughness: numIn(r.roughness, 0, 3, d.roughness),
    fillPattern: pick(r.fillPattern, FILL_PATTERNS, d.fillPattern),
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

/** Active brush id for draw/highlight tools, or null for non-brush tools. */
export function activeBrushId(p: Pick<Prefs, "tool" | "brush" | "highlight">): BrushId | null {
  if (p.tool === "draw") return p.brush;
  if (p.tool === "highlight" && p.highlight === "stroke") return "highlighter";
  return null;
}

/** Effective opacity of a brush (user override or brush default). */
export function brushOpacity(p: Pick<Prefs, "opacities">, id: BrushId): number {
  return p.opacities[id] ?? BRUSHES[id].opacity;
}

/** Effective blend mode of a brush (user override or brush default). */
export function brushBlend(p: Pick<Prefs, "blends">, id: BrushId): BlendMode {
  return p.blends[id] ?? BRUSHES[id].blend;
}

/** Size key of the active tool. */
export function sizeKey(p: Prefs): SizeKey {
  switch (p.tool) {
    case "draw":
      return p.brush;
    case "highlight":
      return p.highlight === "area" ? "area" : "highlighter";
    case "select":
    case "eyedropper":
      return p.brush;
    default:
      return p.tool;
  }
}

/** Add a colour to the recent list (most recent first, palette colours excluded). */
export function pushRecent(p: Prefs, color: string): string[] {
  if (DEFAULT_PALETTE.includes(color)) return p.recent;
  return [color, ...p.recent.filter((c) => c !== color)].slice(0, 6);
}
