/**
 * Wet-media surface layout shared by the main thread, the simulation worker,
 * both simulation backends and the bake format.
 *
 * The surface is a world-space grid of cells covering the scene's map space
 * (scene-relative units, see `core/space.ts`). Cells are grouped in square
 * chunks; only chunks that were painted exist.
 */

/** Map space units per simulation cell. */
export const CELL_UNITS = 2;
/** Cells per chunk edge. */
export const CHUNK = 128;
/** Cells per chunk. */
export const CHUNK_CELLS = CHUNK * CHUNK;
export const GPU_WET_CHUNKS = 36;
export const MAX_MEDIA_CHUNKS = 2048;
/** Fixed simulation step (ms of real time per physics step). */
export const STEP_MS = 50;
/** Most physics steps a tick may run to catch up; longer gaps settle analytically. */
export const MAX_CATCHUP_STEPS = 4;

/** Pigment channels (suspended and deposited layers use the same layout). */
export const PIG = {
  /** K₀…K₇: absorption optical depth per band group (see `pigment.ts`). */
  k0: 0,
  /** Scattering optical depth. */
  S: 8,
  /** Physical pigment amount. */
  A: 9,
  /** Amount × granulation. */
  G: 10,
  /** Amount × staining (stained pigment cannot be lifted again). */
  F: 11,
} as const;
/** Pigment channels (three RGBA texels on the GPU). */
export const PIG_CHANNELS = 12;

/** Cell fluid planes. */
export const FLUID = {
  /** Surface water (≈ 1 = a puddle). */
  w: 0,
  /** Capillary water in the paper (0..1 saturation). */
  s: 1,
  /** Oil medium wetness (0..1): keeps oil paint workable without water. */
  m: 2,
} as const;
export const FLUID_CHANNELS = 3;

/** Water amounts below this count as dry. */
export const DRY_EPS = 1e-4;
/** Pigment amounts below this count as empty. */
export const EMPTY_EPS = 1e-5;

/** Chunk key for chunk coordinates. */
export const chunkKey = (cx: number, cy: number): string => `${cx}_${cy}`;

const KEY = /^(-?\d{1,6})_(-?\d{1,6})$/;

/** Parse a chunk key (validated). */
export function parseChunkKey(key: string): [number, number] | null {
  const m = KEY.exec(key);
  if (!m) return null;
  const cx = Number(m[1]);
  const cy = Number(m[2]);
  return Number.isSafeInteger(cx) && Number.isSafeInteger(cy) ? [cx, cy] : null;
}

/** Map units → cell coordinate. */
export const toCell = (units: number): number => units / CELL_UNITS;

/** Chunk coordinate containing a cell coordinate. */
export const chunkOf = (cell: number): number => Math.floor(cell / CHUNK);
