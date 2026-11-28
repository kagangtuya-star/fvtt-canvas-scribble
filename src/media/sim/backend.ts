import type { PaperTile } from "../paper.ts";

/** Full state of one chunk (undo snapshots, CPU ↔ GPU parity checks). */
export interface ChunkSnapshot {
  /** FLUID_CHANNELS planes (w, s, m). */
  fluid: Float32Array;
  /** Four outflow planes (left, right, up, down). */
  flux: Float32Array;
  /** PIG_CHANNELS planes each. */
  suspended: Float32Array;
  deposited: Float32Array;
}

/**
 * A simulation backend owns chunk state and runs the equations. The engine
 * decides which chunks are active, feeds dabs and asks for displays, exports
 * and snapshots. Both backends implement exactly the same model.
 */
export interface SimBackend {
  readonly kind: "cpu" | "gpu";
  setPaper(tile: PaperTile): void;
  /** Drying speed multiplier. */
  setDrying(factor: number): void;
  has(cx: number, cy: number): boolean;
  /** Allocate (or wake) a chunk. */
  ensure(cx: number, cy: number): void;
  /** Gather wet paint under each band of `n` packed dabs (state before the batch). */
  gather(dabs: Float32Array, n: number, out: Float32Array): void;
  applyDabs(dabs: Float32Array, n: number): void;
  /** One physics step over the given chunks. */
  step(active: readonly [number, number][]): void;
  /** Whether a chunk certainly holds nothing wet (CPU knows exactly; GPU reports false). */
  quiet(cx: number, cy: number): boolean;
  /** Dry a chunk completely: all suspended pigment settles, water and oil vanish. */
  settle(cx: number, cy: number): void;
  /** RGBA display (CHUNK × 2·CHUNK: reflectance on top, transmittance² below), or null if empty. */
  display(cx: number, cy: number): Uint8ClampedArray | null;
  /** Deposited pigment as binary16 planes (PIG_CHANNELS × CHUNK²). */
  exportDeposit(cx: number, cy: number): Uint16Array;
  importDeposit(cx: number, cy: number, halves: Uint16Array): void;
  snapshot(cx: number, cy: number): ChunkSnapshot;
  restore(cx: number, cy: number, snap: ChunkSnapshot): void;
  remove(cx: number, cy: number): void;
  clear(): void;
  destroy(): void;
}
