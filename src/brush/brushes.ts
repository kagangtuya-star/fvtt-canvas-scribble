import type { BrushId } from "../core/types.ts";

/**
 * Brush definitions. A brush is data: it names a renderer and the parameters
 * that make it look and feel different. Adding a brush means adding an entry
 * here (and, for a new look, a renderer in `paint.ts`) — the input pipeline,
 * storage, network and caches do not change.
 *
 * Values that affect rendering are part of schema v1: changing them changes
 * how existing permanent annotations look.
 */

export type RendererId =
  /** perfect-freehand outline, solid fill. */
  | "ink"
  /** perfect-freehand outline, graphite grain, slight transparency. */
  | "pencil"
  /** perfect-freehand outline, blurred edge. */
  | "soft"
  /** Seeded stamp scatter along perfect-freehand samples, rough grain. */
  | "chalk"
  /** Fixed-angle chisel nib swept along the samples; one fill, no overlap darkening. */
  | "chisel"
  /** Constant-width centre line (round joins), supports dashes and arrow heads. */
  | "mono";

export interface BrushDefinition {
  readonly id: BrushId;
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
  /** Edge blur as a multiple of the width. */
  readonly softness: number;
  /** Pen tilt broadens the stroke (like a tilted pencil). */
  readonly tilt: boolean;
  /** Draw a subtle contrasting halo by default. */
  readonly halo: boolean;
  /** May carry arrow heads / dashes (mono only). */
  readonly decorations: boolean;
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
} as const;

export const BRUSHES: Readonly<Record<BrushId, BrushDefinition>> = {
  /** Even ink line with soft ends; ignores pressure. */
  pen: {
    ...base,
    id: "pen",
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
  pencil: {
    ...base,
    id: "pencil",
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
  },
  marker: {
    ...base,
    id: "marker",
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
  fineliner: {
    ...base,
    id: "fineliner",
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
  soft: {
    ...base,
    id: "soft",
    icon: "fa-solid fa-spray-can",
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
  },
  chalk: {
    ...base,
    id: "chalk",
    icon: "fa-solid fa-paintbrush",
    renderer: "chalk",
    defaultSize: 10,
    opacity: 0.9,
    pressureCurve: 1.1,
    thinning: 0.3,
    smoothing: 0.5,
    streamline: 0.38,
  },
  highlighter: {
    ...base,
    id: "highlighter",
    icon: "fa-solid fa-highlighter",
    renderer: "chisel",
    defaultSize: 9,
    widthScale: 2.6,
    opacity: 0.38,
    pressure: false,
    thinning: 0,
    smoothing: 0.6,
    streamline: 0.58,
  },
};

/** Freehand brushes offered by the Draw tool, in UI order. */
export const DRAW_BRUSHES: readonly BrushId[] = ["pen", "pressure", "pencil", "marker", "fineliner", "soft", "chalk"];

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
