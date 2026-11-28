/**
 * Wet-media brushes. Unlike the appearance brushes in `brush/brushes.ts`,
 * these carry physical properties: what the brush holds (pigment, water,
 * oil), how it exchanges paint with the surface (deposit, pickup, scrubbing)
 * and what the pigment does on the paper (scatter, granulation, staining).
 * The simulation turns them into flow, diffusion, mixing and drying.
 */

export type MediaBrushId = "watercolor" | "wash" | "ink" | "gouache" | "oil" | "water" | "smudge" | "sponge";

export const MEDIA_BRUSH_IDS: readonly MediaBrushId[] = [
  "watercolor",
  "wash",
  "ink",
  "gouache",
  "oil",
  "water",
  "smudge",
  "sponge",
];

export interface MediaBrush {
  readonly id: MediaBrushId;
  readonly icon: string;
  /** Default UI size (≈ CSS px at 100% zoom on a 100 px grid). */
  readonly defaultSize: number;
  /** Does the brush load the current colour? */
  readonly coloured: boolean;
  /** Default pigment load (0..1) and water load (0..1), user adjustable. */
  readonly pigment: number;
  readonly water: number;
  /** Pigment amount per cell carried at full load. */
  readonly loadScale: number;
  /** Water per cell carried at full load. */
  readonly waterScale: number;
  /** Opaque body paint (gouache, oil) or transparent glaze (watercolour, ink); see `pigment.ts`. */
  readonly body: boolean;
  /** Medium properties of the pigment it lays down. */
  readonly scatter: number;
  readonly granulation: number;
  readonly staining: number;
  /** Lays down oil medium (keeps paint workable for minutes). */
  readonly oil: number;
  /** Fraction of the brush load given to a touched cell per dab. */
  readonly deposit: number;
  readonly depositWater: number;
  /** Fraction of a touched cell's wet paint / water taken up per dab. */
  readonly pickup: number;
  readonly pickupWater: number;
  /** Fraction of the reservoir spent per dab at full contact (how long a load lasts). */
  readonly drain: number;
  /** Scrubbing: fraction of dry, non-staining pigment lifted back into the water per dab. */
  readonly lift: number;
  /** Bristle streak strength (0 = smooth). */
  readonly bristles: number;
  /** Soft edge width as a fraction of the radius. */
  readonly softness: number;
  /** Dab spacing as a fraction of the radius. */
  readonly spacing: number;
}

const base = {
  coloured: true,
  pigment: 0.6,
  water: 0.6,
  loadScale: 0.4,
  waterScale: 0.6,
  body: false,
  scatter: 1,
  granulation: 0.25,
  staining: 0.2,
  oil: 0,
  deposit: 0.22,
  depositWater: 0.28,
  pickup: 0.05,
  pickupWater: 0.04,
  drain: 0.012,
  lift: 0.004,
  bristles: 0.35,
  softness: 0.35,
  spacing: 0.22,
} as const;

export const MEDIA_BRUSHES: Readonly<Record<MediaBrushId, MediaBrush>> = {
  /** Round watercolour brush: transparent, granulating, flows and blooms. */
  watercolor: { ...base, id: "watercolor", icon: "fa-solid fa-paintbrush", defaultSize: 16 },
  /** Broad wash: lots of water, little pigment; flat even washes with wet edges. */
  wash: {
    ...base,
    id: "wash",
    icon: "fa-solid fa-water",
    defaultSize: 48,
    pigment: 0.35,
    water: 0.9,
    loadScale: 0.25,
    waterScale: 0.85,
    bristles: 0.12,
    softness: 0.45,
    drain: 0.006,
  },
  /** Sumi ink on absorbent paper: staining carbon, strong capillary bleed, ink density = load. */
  ink: {
    ...base,
    id: "ink",
    icon: "fa-solid fa-feather-pointed",
    defaultSize: 10,
    pigment: 0.7,
    water: 0.55,
    loadScale: 0.55,
    waterScale: 0.45,
    scatter: 0.4,
    granulation: 0.05,
    staining: 0.95,
    pickup: 0.02,
    lift: 0,
    bristles: 0.55,
    softness: 0.2,
    drain: 0.008,
  },
  /** Gouache: opaque, thick, little flow; covers what is below. */
  gouache: {
    ...base,
    id: "gouache",
    icon: "fa-solid fa-palette",
    defaultSize: 18,
    pigment: 0.8,
    water: 0.3,
    loadScale: 0.9,
    waterScale: 0.2,
    body: true,
    scatter: 1,
    granulation: 0.05,
    staining: 0.1,
    pickup: 0.1,
    pickupWater: 0.05,
    deposit: 0.3,
    drain: 0.02,
    bristles: 0.45,
    softness: 0.18,
  },
  /** Oil: opaque body that stays wet for minutes; drags and blends with what it touches. */
  oil: {
    ...base,
    id: "oil",
    icon: "fa-solid fa-brush",
    defaultSize: 20,
    pigment: 0.85,
    water: 0,
    loadScale: 1.1,
    waterScale: 0,
    body: true,
    scatter: 1.1,
    granulation: 0,
    staining: 0,
    oil: 0.95,
    pickup: 0.18,
    pickupWater: 0,
    deposit: 0.3,
    depositWater: 0,
    drain: 0.016,
    lift: 0,
    bristles: 0.6,
    softness: 0.15,
  },
  /** Clear water: re-wets, makes blooms and backruns, lifts non-staining pigment. */
  water: {
    ...base,
    id: "water",
    icon: "fa-solid fa-droplet",
    defaultSize: 24,
    coloured: false,
    pigment: 0,
    water: 0.8,
    loadScale: 0,
    waterScale: 0.75,
    pickup: 0.06,
    lift: 0.05,
    bristles: 0.15,
    softness: 0.45,
    drain: 0.008,
  },
  /** Blender / finger: carries no paint of its own, drags and mixes wet paint. */
  smudge: {
    ...base,
    id: "smudge",
    icon: "fa-solid fa-hand-point-up",
    defaultSize: 20,
    coloured: false,
    pigment: 0,
    water: 0,
    loadScale: 0,
    waterScale: 0.15,
    pickup: 0.35,
    pickupWater: 0.2,
    deposit: 0.3,
    depositWater: 0.25,
    drain: 0.03,
    lift: 0,
    bristles: 0.2,
    softness: 0.4,
  },
  /** Sponge / tissue: soaks up water and wet pigment, lifts non-staining colour. */
  sponge: {
    ...base,
    id: "sponge",
    icon: "fa-solid fa-soap",
    defaultSize: 30,
    coloured: false,
    pigment: 0,
    water: 0,
    loadScale: 0,
    waterScale: 0,
    pickup: 0.5,
    pickupWater: 0.6,
    deposit: 0,
    depositWater: 0,
    drain: 0.002,
    lift: 0.06,
    bristles: 0.5,
    softness: 0.5,
  },
};

/** Per-brush user overrides (stored in prefs, sent with each stroke). */
export interface MediaParams {
  /** Pigment load 0..1 (ink: density, 墨色浓淡). */
  pigment?: number;
  /** Water load 0..1. */
  water?: number;
}

export function resolveMediaParams(brush: MediaBrush, p: MediaParams | undefined): { pigment: number; water: number } {
  const clamp01 = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d;
  return { pigment: clamp01(p?.pigment, brush.pigment), water: clamp01(p?.water, brush.water) };
}

export function normalizeMediaParams(raw: unknown): MediaParams {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: MediaParams = {};
  for (const key of ["pigment", "water"] as const) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
  }
  return out;
}

/** Paper kinds (per scene). */
export type PaperId = "cold" | "hot" | "rough" | "xuan" | "canvas";
export const PAPER_IDS: readonly PaperId[] = ["cold", "hot", "rough", "xuan", "canvas"];
