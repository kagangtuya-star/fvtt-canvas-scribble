import { createNoise4D } from "simplex-noise";
import { rng } from "../core/util.ts";
import type { PaperId } from "./brushes.ts";

/**
 * Procedural papers. A paper is never stored: every client regenerates the
 * same seamless tile from the scene's seed. Its fields drive the physics:
 *
 *   h    surface height (0..1): water pools in valleys, granulating pigment
 *        settles there, a dry brush only touches the peaks
 *   a    absorbency multiplier (sizing varies across a sheet)
 *   fx,fy  fibre direction × strength: capillary flow runs along fibres
 *          (rice paper feathering, canvas weave)
 */

/** Paper tile edge in cells (two chunks; tiles repeat seamlessly). */
export const PAPER_TILE = 256;

export interface PaperProps {
  /** Weight of the paper relief in the water pressure (pooling in valleys). */
  readonly relief: number;
  /** Surface water absorbed per step into dry paper. */
  readonly absorb: number;
  /** Water the paper can hold (capillary capacity, surface-water units). */
  readonly capacity: number;
  /** Capillary diffusivity per step (≤ 0.12 for stability with anisotropy). */
  readonly diffuse: number;
  /** How strongly fibres bias capillary flow (0..0.9). */
  readonly aniso: number;
  /** Fraction of suspended pigment carried by capillary flow. */
  readonly carry: number;
  /**
   * Pigment mobility in damp paper (× saturation): absorbent paper keeps the
   * pigment travelling in its fibres after the surface water has soaked in
   * (xuan bleeds); sized paper lets it settle (hard edges).
   */
  readonly bleed: number;
  /** Granulation response (pigment settling into the tooth). */
  readonly tooth: number;
  /** Evaporation multiplier. */
  readonly evaporation: number;
}

export const PAPERS: Readonly<Record<PaperId, PaperProps>> = {
  cold: {
    relief: 0.12,
    absorb: 0.02,
    capacity: 0.6,
    diffuse: 0.05,
    aniso: 0.3,
    carry: 0.15,
    bleed: 0.6,
    tooth: 1,
    evaporation: 1,
  },
  hot: {
    relief: 0.04,
    absorb: 0.012,
    capacity: 0.4,
    diffuse: 0.03,
    aniso: 0.1,
    carry: 0.08,
    bleed: 0.4,
    tooth: 0.4,
    evaporation: 1,
  },
  rough: {
    relief: 0.2,
    absorb: 0.025,
    capacity: 0.7,
    diffuse: 0.05,
    aniso: 0.3,
    carry: 0.15,
    bleed: 0.6,
    tooth: 1.5,
    evaporation: 1,
  },
  xuan: {
    relief: 0.03,
    absorb: 0.12,
    capacity: 0.45,
    diffuse: 0.3,
    aniso: 0.85,
    carry: 1,
    bleed: 10,
    tooth: 0.3,
    evaporation: 0.8,
  },
  canvas: {
    relief: 0.1,
    absorb: 0.004,
    capacity: 0.2,
    diffuse: 0.015,
    aniso: 0.5,
    carry: 0.05,
    bleed: 0.2,
    tooth: 0.6,
    evaporation: 1.2,
  },
};

export interface PaperTile {
  readonly id: PaperId;
  readonly props: PaperProps;
  /** Planes of PAPER_TILE² cells. */
  readonly h: Float32Array;
  readonly a: Float32Array;
  readonly fx: Float32Array;
  readonly fy: Float32Array;
}

const TAU = Math.PI * 2;

type Noise4 = (x: number, y: number, z: number, w: number) => number;

/** Periodic fBm over the unit square (4D torus mapping), −1..1. */
function fbm(noise: Noise4, u: number, v: number, freq: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    const r = f / TAU;
    sum +=
      amp * noise(Math.cos(u * TAU) * r, Math.sin(u * TAU) * r, Math.cos(v * TAU) * r + o * 7.1, Math.sin(v * TAU) * r);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

const cache = new Map<string, PaperTile>();

/** Generate (or reuse) the tile of a paper kind for a scene seed. */
export function paperTile(id: PaperId, seed: number): PaperTile {
  const key = `${id}:${seed}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const N = PAPER_TILE;
  const h = new Float32Array(N * N);
  const a = new Float32Array(N * N);
  const fx = new Float32Array(N * N);
  const fy = new Float32Array(N * N);
  const n1 = createNoise4D(rng(seed ^ 0x51a7));
  const n2 = createNoise4D(rng(seed ^ 0x2b3c));
  const n3 = createNoise4D(rng(seed ^ 0x77e1));
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      const i = y * N + x;
      let height = 0.5;
      let absorb = 1;
      let angle = 0;
      let strength = 0.2;
      switch (id) {
        case "cold": {
          const n = fbm(n1, u, v, 24, 4);
          height = 0.5 + 0.38 * n + 0.12 * Math.abs(fbm(n2, u, v, 64, 2));
          absorb = 0.85 + 0.3 * fbm(n3, u, v, 6, 2);
          angle = Math.PI * fbm(n3, u, v, 3, 2);
          strength = 0.25;
          break;
        }
        case "hot": {
          height = 0.5 + 0.15 * fbm(n1, u, v, 32, 3);
          absorb = 0.9 + 0.2 * fbm(n3, u, v, 5, 2);
          angle = Math.PI * fbm(n3, u, v, 3, 2);
          strength = 0.1;
          break;
        }
        case "rough": {
          const n = fbm(n1, u, v, 12, 5);
          height = 0.5 + 0.45 * n + 0.1 * fbm(n2, u, v, 48, 2);
          absorb = 0.8 + 0.4 * fbm(n3, u, v, 6, 2);
          angle = Math.PI * fbm(n3, u, v, 3, 2);
          strength = 0.3;
          break;
        }
        case "xuan": {
          // Long fibres: noise stretched along a slowly turning direction.
          angle = Math.PI * fbm(n3, u, v, 2, 2) * 1.5;
          const ca = Math.cos(angle);
          const sa = Math.sin(angle);
          const along = u * ca + v * sa;
          const across = -u * sa + v * ca;
          const streak = fbm(n1, across * 0.5 + along * 0.06, along * 0.06 + across * 0.5, 96, 2);
          height = 0.5 + 0.2 * streak + 0.08 * fbm(n2, u, v, 40, 2);
          absorb = 0.7 + 0.6 * (0.5 + 0.5 * fbm(n2, u, v, 10, 3));
          strength = 0.6 + 0.4 * Math.abs(streak);
          break;
        }
        case "canvas": {
          const F = 64; // Threads per tile (integer → seamless).
          const wu = Math.sin(u * TAU * F);
          const wv = Math.sin(v * TAU * F);
          const over = ((Math.floor(u * F * 2) + Math.floor(v * F * 2)) & 1) === 0;
          height = 0.5 + 0.32 * (over ? wu : wv) + 0.08 * fbm(n1, u, v, 24, 2);
          absorb = 0.9 + 0.2 * fbm(n3, u, v, 6, 2);
          angle = over ? 0 : Math.PI / 2;
          strength = 0.7;
          break;
        }
      }
      h[i] = Math.min(1, Math.max(0, height));
      a[i] = Math.max(0.1, absorb);
      fx[i] = Math.cos(angle) * strength;
      fy[i] = Math.sin(angle) * strength;
    }
  }
  const tile = { id, props: PAPERS[id], h, a, fx, fy };
  if (cache.size > 4) cache.clear();
  cache.set(key, tile);
  return tile;
}

/** Index into a paper tile for a global cell coordinate. */
export function paperIndex(gx: number, gy: number): number {
  const N = PAPER_TILE;
  const x = ((gx % N) + N) % N;
  const y = ((gy % N) + N) % N;
  return y * N + x;
}
