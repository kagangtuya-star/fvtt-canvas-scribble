import type { AngleMode, BlendMode, BrushId, BrushOverride, TipShape } from "../core/types.ts";

/**
 * Brush definitions. A brush is data: it names a renderer and the parameters
 * that make it look and feel different. Adding a brush means adding an entry
 * here — the input pipeline, storage, network and caches adapt automatically.
 *
 * Values that affect rendering are part of schema v1: changing defaults for
 * existing brush ids changes how existing permanent annotations look.
 */

export type BrushCategory = "ink" | "flat" | "dry" | "wet" | "fx";

export type GrainKind = "none" | "graphite" | "chalk" | "canvas" | "watercolor";

export type RendererId =
  /** perfect-freehand outline, solid fill. */
  | "ink"
  /** perfect-freehand outline, Simplex graphite paper tooth. */
  | "pencil"
  /** perfect-freehand outline, soft feathered edge. */
  | "soft"
  /** Parametric dab/stamp engine (round, rectangular, bristle, pixel, chalk, airbrush, splatter). */
  | "dab"
  /** Parameterised swept rectangular/chisel nib (fixed, tangent, tilt, or twist); single union fill. */
  | "chisel"
  /** Constant-width centre line (round joins), supports dashes and arrow heads. */
  | "mono"
  /** Organic watercolor wash with Simplex pooling & darkened wet edge. */
  | "watercolor"
  /** Luminous glowing stroke with bright hot core. */
  | "neon";

export interface BrushDefinition {
  readonly id: BrushId;
  readonly category: BrushCategory;
  /** Font Awesome icon classes. */
  readonly icon: string;
  readonly renderer: RendererId;
  /** Default UI size (≈ CSS px at 100% zoom on a 100 px grid). */
  readonly defaultSize: number;
  /** Stroke width = UI size × widthScale. */
  readonly widthScale: number;
  readonly opacity: number;
  /** Record pressure (real or simulated) for this brush? */
  readonly pressure: boolean;
  /** Exponent applied to pressure (< 1: lighter touch, > 1: needs more pressure). */
  readonly pressureCurve: number;
  readonly thinning: number;
  readonly smoothing: number;
  /** Input-time streamline (0 = raw, 1 = very laggy). */
  readonly streamline: number;
  /** Tapers as multiples of the width. */
  readonly taperStart: number;
  readonly taperEnd: number;
  readonly cap: boolean;
  /** Edge blur as a multiple of the width (soft renderer). */
  readonly softness: number;
  /** Pen tilt broadens the stroke (like a tilted pencil). */
  readonly tilt: boolean;
  /** Draw a subtle contrasting halo by default. */
  readonly halo: boolean;
  /** May carry arrow heads / dashes (mono only). */
  readonly decorations: boolean;
  /** Tip shape for dab / chisel brushes and cursor preview. */
  readonly tip: TipShape;
  /** Default nib rotation angle in degrees (-180..180). */
  readonly angle: number;
  /** How nib angle follows input. */
  readonly angleMode: AngleMode;
  /** Nib aspect ratio / roundness (0.05..1; 1 = circle/square, 0.2 = flat). */
  readonly aspect: number;
  /** Corner roundness for rectangular nibs (0 = sharp box, 1 = capsule/ellipse). */
  readonly corner: number;
  /** Edge hardness (0 = feathered airbrush, 1 = crisp). */
  readonly hardness: number;
  /** Per-dab opacity buildup (0.05..1). */
  readonly flow: number;
  /** Dab spacing as a multiple of width (0.08..3). */
  readonly spacing: number;
  /** Perpendicular scatter as a multiple of width (0..3). */
  readonly scatter: number;
  /** Procedural grain strength (0..1). */
  readonly grain: number;
  readonly grainKind: GrainKind;
  /** Default blend mode. */
  readonly blend: BlendMode;
  /** Snap dabs to an integer pixel grid of size `item.size`. */
  readonly pixelAligned: boolean;
  /** Number of bristle fibers (for `tip: "bristle"`). */
  readonly bristles: number;
  /** Record per-point tilt/twist angle channel? */
  readonly recordsAngles: boolean;
}

const base = {
  pressure: true,
  pressureCurve: 1,
  thinning: 0.5,
  smoothing: 0.5,
  streamline: 0.45,
  taperStart: 0,
  taperEnd: 0,
  cap: true,
  softness: 0,
  tilt: false,
  halo: false,
  decorations: false,
  widthScale: 1,
  opacity: 1,
  tip: "round" as TipShape,
  angle: 0,
  angleMode: "fixed" as AngleMode,
  aspect: 1,
  corner: 0,
  hardness: 1,
  flow: 1,
  spacing: 0.16,
  scatter: 0,
  grain: 0,
  grainKind: "none" as GrainKind,
  blend: "normal" as BlendMode,
  pixelAligned: false,
  bristles: 0,
  recordsAngles: false,
} as const;

export const BRUSHES: Readonly<Record<BrushId, BrushDefinition>> = {
  /** Even ink line with soft ends; ignores pressure. */
  pen: {
    ...base,
    id: "pen",
    category: "ink",
    icon: "fa-solid fa-pen-fancy",
    renderer: "ink",
    defaultSize: 4,
    pressure: false,
    thinning: 0.18,
    smoothing: 0.55,
    streamline: 0.42,
    taperStart: 0.4,
    taperEnd: 1.2,
    halo: true,
  },
  /** Calligraphic ink: width follows pen pressure (or simulated pressure from speed). */
  pressure: {
    ...base,
    id: "pressure",
    category: "ink",
    icon: "fa-solid fa-pen-nib",
    renderer: "ink",
    defaultSize: 5,
    pressureCurve: 0.85,
    thinning: 0.62,
    smoothing: 0.55,
    streamline: 0.42,
    taperStart: 0.9,
    taperEnd: 2.6,
    halo: true,
  },
  /** Fine graphite pencil with seamless Simplex paper tooth. */
  pencil: {
    ...base,
    id: "pencil",
    category: "dry",
    icon: "fa-solid fa-pencil",
    renderer: "pencil",
    defaultSize: 3,
    opacity: 0.92,
    pressureCurve: 1.25,
    thinning: 0.32,
    smoothing: 0.42,
    streamline: 0.22,
    taperStart: 0.4,
    taperEnd: 1.2,
    tilt: true,
    grain: 0.62,
    grainKind: "graphite",
  },
  /** Bold felt-tip marker. */
  marker: {
    ...base,
    id: "marker",
    category: "wet",
    icon: "fa-solid fa-marker",
    renderer: "ink",
    defaultSize: 9,
    opacity: 0.88,
    pressure: false,
    thinning: 0.06,
    smoothing: 0.62,
    streamline: 0.55,
    halo: true,
  },
  /** Technical monoline; supports dashes and arrow heads. */
  fineliner: {
    ...base,
    id: "fineliner",
    category: "ink",
    icon: "fa-solid fa-pen",
    renderer: "mono",
    defaultSize: 4,
    pressure: false,
    thinning: 0,
    smoothing: 0.5,
    streamline: 0.5,
    halo: true,
    decorations: true,
  },
  /** Soft feathered brush. */
  soft: {
    ...base,
    id: "soft",
    category: "wet",
    icon: "fa-solid fa-cloud",
    renderer: "soft",
    defaultSize: 18,
    opacity: 0.6,
    pressureCurve: 0.9,
    thinning: 0.45,
    smoothing: 0.7,
    streamline: 0.5,
    taperStart: 1.2,
    taperEnd: 1.8,
    softness: 0.42,
    hardness: 0.25,
  },
  /** Rough dry chalk with deterministic space-unit scatter and paper tooth. */
  chalk: {
    ...base,
    id: "chalk",
    category: "dry",
    icon: "fa-solid fa-paintbrush",
    renderer: "dab",
    defaultSize: 10,
    opacity: 0.9,
    pressureCurve: 1.1,
    thinning: 0.3,
    smoothing: 0.5,
    streamline: 0.38,
    tip: "rect",
    angle: -20,
    aspect: 0.78,
    corner: 0.15,
    hardness: 0.82,
    flow: 0.65,
    spacing: 0.16,
    scatter: 0.22,
    grain: 0.58,
    grainKind: "chalk",
  },
  /** Translucent chisel-nib highlighter (multiply blend keeps map details crisp). */
  highlighter: {
    ...base,
    id: "highlighter",
    category: "fx",
    icon: "fa-solid fa-highlighter",
    renderer: "chisel",
    defaultSize: 9,
    widthScale: 2.6,
    opacity: 0.42,
    pressure: false,
    thinning: 0,
    smoothing: 0.6,
    streamline: 0.58,
    tip: "rect",
    angle: -38,
    angleMode: "fixed",
    aspect: 0.22,
    corner: 0,
    blend: "multiply",
  },
  /** Hard-edge rectangular / flat block brush (architectural sketch, geometric painting). */
  flat: {
    ...base,
    id: "flat",
    category: "flat",
    icon: "fa-solid fa-square",
    renderer: "chisel",
    defaultSize: 12,
    widthScale: 1.4,
    opacity: 0.96,
    pressure: true,
    pressureCurve: 0.95,
    thinning: 0.25,
    smoothing: 0.52,
    streamline: 0.42,
    tip: "rect",
    angle: 0,
    angleMode: "fixed",
    aspect: 0.48,
    corner: 0,
    hardness: 1,
    recordsAngles: true,
  },
  /** Classic italic / broad-edge calligraphy nib (sharp thin/thick contrast). */
  calligraphy: {
    ...base,
    id: "calligraphy",
    category: "flat",
    icon: "fa-solid fa-feather-pointed",
    renderer: "chisel",
    defaultSize: 10,
    widthScale: 1.5,
    opacity: 1,
    pressure: true,
    pressureCurve: 0.85,
    thinning: 0.35,
    smoothing: 0.58,
    streamline: 0.48,
    tip: "rect",
    angle: -35,
    angleMode: "fixed",
    aspect: 0.16,
    corner: 0.05,
    hardness: 1,
    halo: true,
    recordsAngles: true,
  },
  /** Flat multi-bristle oil / gouache brush that follows stroke direction (or pen twist/tilt). */
  bristle: {
    ...base,
    id: "bristle",
    category: "flat",
    icon: "fa-solid fa-brush",
    renderer: "dab",
    defaultSize: 14,
    widthScale: 1.5,
    opacity: 0.94,
    pressure: true,
    pressureCurve: 0.95,
    thinning: 0.32,
    smoothing: 0.55,
    streamline: 0.44,
    tip: "bristle",
    angle: 0,
    angleMode: "follow",
    aspect: 0.28,
    corner: 0,
    hardness: 0.9,
    flow: 0.42,
    spacing: 0.12,
    scatter: 0.04,
    grain: 0.28,
    grainKind: "canvas",
    bristles: 14,
    recordsAngles: true,
  },
  /** Axis-aligned square pixel / tile brush for battlemap walls and retro pixel art. */
  pixel: {
    ...base,
    id: "pixel",
    category: "flat",
    icon: "fa-solid fa-border-all",
    renderer: "dab",
    defaultSize: 10,
    widthScale: 1,
    opacity: 1,
    pressure: false,
    thinning: 0,
    smoothing: 0,
    streamline: 0,
    tip: "rect",
    angle: 0,
    angleMode: "fixed",
    aspect: 1,
    corner: 0,
    hardness: 1,
    flow: 1,
    spacing: 0.25,
    pixelAligned: true,
  },
  /** Square-stick dry charcoal / conte crayon with strong paper tooth & tilt response. */
  charcoal: {
    ...base,
    id: "charcoal",
    category: "dry",
    icon: "fa-solid fa-cubes-stacked",
    renderer: "dab",
    defaultSize: 12,
    widthScale: 1.3,
    opacity: 0.92,
    pressure: true,
    pressureCurve: 1.15,
    thinning: 0.36,
    smoothing: 0.46,
    streamline: 0.3,
    tilt: true,
    tip: "rect",
    angle: -25,
    angleMode: "tilt",
    aspect: 0.5,
    corner: 0.08,
    hardness: 0.72,
    flow: 0.52,
    spacing: 0.15,
    scatter: 0.14,
    grain: 0.74,
    grainKind: "chalk",
    recordsAngles: true,
  },
  /** True flow-buildup airbrush with pre-baked soft radial tip. */
  airbrush: {
    ...base,
    id: "airbrush",
    category: "wet",
    icon: "fa-solid fa-spray-can",
    renderer: "dab",
    defaultSize: 22,
    widthScale: 1.6,
    opacity: 0.85,
    pressure: true,
    pressureCurve: 1.05,
    thinning: 0.4,
    smoothing: 0.65,
    streamline: 0.5,
    tip: "round",
    hardness: 0.06,
    flow: 0.16,
    spacing: 0.14,
    scatter: 0,
  },
  /** Wet watercolor wash with organic pooling and darkened wet edges. */
  watercolor: {
    ...base,
    id: "watercolor",
    category: "wet",
    icon: "fa-solid fa-droplet",
    renderer: "watercolor",
    defaultSize: 16,
    widthScale: 1.5,
    opacity: 0.62,
    pressure: true,
    pressureCurve: 0.9,
    thinning: 0.42,
    smoothing: 0.65,
    streamline: 0.48,
    taperStart: 0.6,
    taperEnd: 1.2,
    grain: 0.55,
    grainKind: "watercolor",
    blend: "multiply",
  },
  /** Luminous neon / arcane spell-glow brush. */
  neon: {
    ...base,
    id: "neon",
    category: "fx",
    icon: "fa-solid fa-bolt",
    renderer: "neon",
    defaultSize: 8,
    widthScale: 1.1,
    opacity: 0.95,
    pressure: true,
    pressureCurve: 0.9,
    thinning: 0.35,
    smoothing: 0.6,
    streamline: 0.48,
    taperStart: 0.8,
    taperEnd: 1.6,
    softness: 0.85,
    blend: "lighter",
  },
  /** Seeded spray / droplet splatter brush. */
  splatter: {
    ...base,
    id: "splatter",
    category: "fx",
    icon: "fa-solid fa-braille",
    renderer: "dab",
    defaultSize: 16,
    widthScale: 1.3,
    opacity: 0.92,
    pressure: true,
    pressureCurve: 1,
    thinning: 0.35,
    smoothing: 0.3,
    streamline: 0.2,
    tip: "round",
    hardness: 0.85,
    flow: 0.78,
    spacing: 0.32,
    scatter: 1.35,
  },
};

/** Freehand brushes offered by the Draw tool, in UI order. */
export const DRAW_BRUSHES: readonly BrushId[] = [
  "pen",
  "pressure",
  "flat",
  "calligraphy",
  "bristle",
  "pixel",
  "pencil",
  "charcoal",
  "chalk",
  "marker",
  "watercolor",
  "airbrush",
  "soft",
  "fineliner",
  "neon",
  "splatter",
];

export interface ResolvedBrushParams {
  angle: number;
  angleMode: AngleMode;
  aspect: number;
  corner: number;
  hardness: number;
  flow: number;
  spacing: number;
  scatter: number;
  grain: number;
}

/** Merge a brush definition's defaults with optional per-stroke overrides. */
export function resolveBrushParams(brush: BrushDefinition, over?: BrushOverride): ResolvedBrushParams {
  return {
    angle: over?.ang ?? brush.angle,
    angleMode: over?.am ?? brush.angleMode,
    aspect: over?.asp ?? brush.aspect,
    corner: over?.cor ?? brush.corner,
    hardness: over?.hrd ?? brush.hardness,
    flow: over?.flw ?? brush.flow,
    spacing: Math.max(0.08, over?.spc ?? brush.spacing),
    scatter: over?.sct ?? brush.scatter,
    grain: over?.grn ?? brush.grain,
  };
}

/** Extract only fields that differ from the brush definition's defaults (compact wire storage). */
export function diffBrushOverride(brush: BrushDefinition, over?: BrushOverride): BrushOverride | undefined {
  if (!over) return undefined;
  const out: BrushOverride = {};
  if (over.ang !== undefined && Math.abs(over.ang - brush.angle) > 0.05) out.ang = Math.round(over.ang * 10) / 10;
  if (over.am !== undefined && over.am !== brush.angleMode) out.am = over.am;
  if (over.asp !== undefined && Math.abs(over.asp - brush.aspect) > 0.005) out.asp = Math.round(over.asp * 100) / 100;
  if (over.cor !== undefined && Math.abs(over.cor - brush.corner) > 0.005) out.cor = Math.round(over.cor * 100) / 100;
  if (over.hrd !== undefined && Math.abs(over.hrd - brush.hardness) > 0.005) out.hrd = Math.round(over.hrd * 100) / 100;
  if (over.flw !== undefined && Math.abs(over.flw - brush.flow) > 0.005) out.flw = Math.round(over.flw * 100) / 100;
  if (over.spc !== undefined && Math.abs(over.spc - brush.spacing) > 0.005) out.spc = Math.round(over.spc * 100) / 100;
  if (over.sct !== undefined && Math.abs(over.sct - brush.scatter) > 0.005) out.sct = Math.round(over.sct * 100) / 100;
  if (over.grn !== undefined && Math.abs(over.grn - brush.grain) > 0.005) out.grn = Math.round(over.grn * 100) / 100;
  if (over.rgh !== undefined && over.rgh > 0.01) out.rgh = Math.round(over.rgh * 100) / 100;
  return Object.keys(out).length ? out : undefined;
}

export const UI_SIZE = { min: 1, max: 64 } as const;

/** Quick size presets (UI size). */
export const SIZE_PRESETS: readonly number[] = [2, 4, 8, 14, 24];

/**
 * Curated default colours: readable on dark dungeon maps and on light
 * parchment, warm and cool hues, no neon. The last two are the light/dark
 * neutrals; highlighter colours reuse the same hues at low opacity.
 */
export const DEFAULT_PALETTE: readonly string[] = [
  "#e0483e", // red
  "#f08a2c", // orange
  "#f2c94c", // amber
  "#4caf6a", // green
  "#2bb3a3", // teal
  "#3d8be8", // blue
  "#9b6bdf", // violet
  "#e85a9b", // pink
  "#f4f1ea", // paper white
  "#26221e", // ink
];
