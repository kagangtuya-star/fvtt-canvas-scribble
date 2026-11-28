import { createNoise2D, createNoise4D } from "simplex-noise";
import { rng } from "../core/util.ts";
import type { GrainKind } from "./brushes.ts";

/**
 * Seamless procedural surface textures powered by `simplex-noise`.
 *
 * Tiles are 4D-torus-mapped onto a 2D square so both X and Y wrap with zero
 * visible seams when repeated across map tiles, and patterns are anchored to
 * space-unit origin via `DOMMatrix`.
 */

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const TILE_SIZE = 192;
const TAU = Math.PI * 2;
const tileCache = new Map<GrainKind, AnyCanvas>();
const patternCache = new WeakMap<Ctx2D, Map<string, CanvasPattern>>();

export function createSurfaceCanvas(width: number, height: number): AnyCanvas {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Deterministic 2D Simplex noise sampler seeded from an integer (for bristles & watercolor). */
export function seededNoise2D(seed: number): (x: number, y: number) => number {
  return createNoise2D(rng(seed));
}

/**
 * Sample periodic 2D fBm by projecting (u, v) ∈ [0, 1)² onto a 4D torus.
 * Guarantees exact seamless tiling at every edge.
 */
function torusFbm(
  noise4D: (x: number, y: number, z: number, w: number) => number,
  u: number,
  v: number,
  freq: number,
  octaves: number,
): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    const r = f / TAU;
    const ax = u * TAU;
    const ay = v * TAU;
    sum += amp * noise4D(Math.cos(ax) * r, Math.sin(ax) * r, Math.cos(ay) * r, Math.sin(ay) * r);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return (sum / norm) * 0.5 + 0.5; // 0..1
}

function buildGrainTile(kind: Exclude<GrainKind, "none">): AnyCanvas {
  const cached = tileCache.get(kind);
  if (cached) return cached;
  const tile = createSurfaceCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = tile.getContext("2d") as Ctx2D | null;
  if (!ctx) return tile;
  const img = ctx.createImageData(TILE_SIZE, TILE_SIZE);
  const seed =
    kind === "graphite" ? 0x9e3779b9 : kind === "chalk" ? 0x7f4a7c15 : kind === "canvas" ? 0x517cc1b7 : 0x2c1b3c6d;
  const noise4D = createNoise4D(rng(seed));
  const rand = rng(seed ^ 0x13579bdf);

  for (let y = 0; y < TILE_SIZE; y++) {
    const v = y / TILE_SIZE;
    for (let x = 0; x < TILE_SIZE; x++) {
      const u = x / TILE_SIZE;
      let a = 0;
      if (kind === "graphite") {
        // Cold-press fine paper tooth: smooth valleys + crisp micro-grain.
        const n = torusFbm(noise4D, u, v, 14, 3);
        const micro = rand();
        const combined = n * 0.72 + micro * 0.28;
        a = combined > 0.68 ? 235 : combined > 0.52 ? Math.round(((combined - 0.52) / 0.16) * 190) : 0;
      } else if (kind === "chalk") {
        // Coarse rough pastel paper: bold clumpy valleys.
        const n = torusFbm(noise4D, u, v, 9, 3);
        const fine = torusFbm(noise4D, u, v, 26, 2);
        const c = n * 0.65 + fine * 0.35;
        a = c > 0.56 ? 255 : c > 0.44 ? Math.round(((c - 0.44) / 0.12) * 190) : 0;
      } else if (kind === "canvas") {
        // Woven linen canvas cross-hatch modulated by organic Simplex noise.
        const warp = Math.sin(u * TAU * 24) * 0.5 + 0.5;
        const weft = Math.sin(v * TAU * 24) * 0.5 + 0.5;
        const weave = Math.max(warp, weft);
        const n = torusFbm(noise4D, u, v, 8, 2);
        const c = weave * 0.65 + n * 0.35;
        a = c > 0.58 ? Math.round(((c - 0.58) / 0.42) * 210) : 0;
      } else {
        // Watercolor organic cloud granulation.
        const n = torusFbm(noise4D, u, v, 5, 4);
        a = Math.round(Math.max(0, Math.min(1, (n - 0.25) / 0.55)) * 180);
      }
      const idx = (y * TILE_SIZE + x) * 4;
      img.data[idx] = 0;
      img.data[idx + 1] = 0;
      img.data[idx + 2] = 0;
      img.data[idx + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  tileCache.set(kind, tile);
  return tile;
}

/** World-anchored seamless grain pattern so adjacent cache tiles align seamlessly. */
export function grainPattern(ctx: Ctx2D, kind: GrainKind, unitsPerCell: number): CanvasPattern | null {
  if (kind === "none") return null;
  let map = patternCache.get(ctx);
  if (!map) patternCache.set(ctx, (map = new Map()));
  let pattern = map.get(kind);
  if (!pattern) {
    pattern = ctx.createPattern(buildGrainTile(kind) as CanvasImageSource, "repeat") ?? undefined;
    if (!pattern) return null;
    map.set(kind, pattern);
  }
  if (typeof DOMMatrix !== "undefined") pattern.setTransform(new DOMMatrix().scale(unitsPerCell));
  return pattern;
}
