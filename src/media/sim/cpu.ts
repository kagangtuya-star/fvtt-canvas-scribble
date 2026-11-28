import {
  BAND,
  BANDS,
  DAB,
  DAB_FLOATS,
  DAB_HEADER,
  DAB_BAND,
  GATHER_BAND,
  GATHER_FLOATS,
  GATHER_SAMPLES,
} from "../dabs.ts";
import { contact, dabIncludesChunk, gatherOffset } from "../dabs.ts";
import { fromHalf, toHalf } from "../half.ts";
import { CHUNK, CHUNK_CELLS, DRY_EPS, EMPTY_EPS, PIG, PIG_CHANNELS } from "../layout.ts";
import { PAPER_TILE } from "../paper.ts";
import type { PaperProps, PaperTile } from "../paper.ts";
import { SPECTRAL_RGB } from "../pigment.ts";
import { GROUPS } from "../spectral-tables.ts";
import type { ChunkSnapshot, SimBackend } from "./backend.ts";
import { PHYS } from "./physics.ts";

/**
 * Reference backend: the wet-media model on Float32 planes, run in the
 * worker. Every step goes through four passes (the GPU backend mirrors them):
 *
 *   A  flux       virtual-pipe outflows from water + paper relief pressure
 *   B  transport  water and suspended pigment move with the fluxes (mass conserving)
 *   C  capillary  saturation diffuses along the paper fibres and carries pigment
 *   D  local      absorption, evaporation (faster at wet edges), settling, re-wetting
 *
 * Only an activity rectangle per chunk is processed: dry cells with dry
 * neighbours cannot change.
 */

const N = CHUNK;
const NN = CHUNK_CELLS;
const C = PIG_CHANNELS;

const M0 = Float64Array.from(SPECTRAL_RGB[0]!);
const M1 = Float64Array.from(SPECTRAL_RGB[1]!);
const M2 = Float64Array.from(SPECTRAL_RGB[2]!);

/** sRGB encoding table for 4096 linear steps. */
const SRGB = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) {
  const x = i / 4096;
  SRGB[i] = Math.round((x > 0.0031308 ? 1.055 * x ** (1 / 2.4) - 0.055 : x * 12.92) * 255);
}
const enc = (v: number) => SRGB[v <= 0 ? 0 : v >= 1 ? 4096 : (v * 4096) | 0]!;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const emptyRect = (): Rect => ({ x0: N, y0: N, x1: -1, y1: -1 });
const isEmpty = (r: Rect) => r.x1 < r.x0 || r.y1 < r.y0;
function grow(r: Rect, x0: number, y0: number, x1: number, y1: number): void {
  r.x0 = Math.max(0, Math.min(r.x0, x0));
  r.y0 = Math.max(0, Math.min(r.y0, y0));
  r.x1 = Math.min(N - 1, Math.max(r.x1, x1));
  r.y1 = Math.min(N - 1, Math.max(r.y1, y1));
}

/**
 * Capillary conductance between neighbouring cells: fibre direction makes it
 * anisotropic (xuan paper bleeds along its fibres), absorbency scales it.
 * Symmetric, so each cell stores the links to its right and lower neighbour.
 * Neighbours come from the periodic tile, so chunk borders need no neighbour chunk.
 */
export function conductances(
  tile: PaperTile,
  ox: number,
  oy: number,
  pa: Float32Array,
  pfx: Float32Array,
  pfy: Float32Array,
  kR: Float32Array,
  kD: Float32Array,
): void {
  const { diffuse, aniso } = tile.props;
  const T = PAPER_TILE;
  const k = (a: number, b: number, fa: number, fb: number) =>
    Math.min(
      PHYS.capillaryMax,
      diffuse * (1 - aniso + 2 * aniso * Math.min(1, (fa * fa + fb * fb) / 2)) * ((a + b) / 2),
    );
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const r = ((oy + y) % T) * T + ((ox + x + 1) % T);
      const d = ((oy + y + 1) % T) * T + ((ox + x) % T);
      kR[i] = k(pa[i]!, tile.a[r]!, pfx[i]!, tile.fx[r]!);
      kD[i] = k(pa[i]!, tile.a[d]!, pfy[i]!, tile.fy[d]!);
    }
  }
}

/** Paper planes of one chunk: relief, absorbency and the capillary links (GPU upload). */
export function chunkPaper(
  tile: PaperTile,
  cx: number,
  cy: number,
): { ph: Float32Array; pa: Float32Array; kR: Float32Array; kD: Float32Array } {
  const c = new Chunk(cx, cy);
  c.paper(tile);
  const kR = new Float32Array(NN);
  const kD = new Float32Array(NN);
  conductances(tile, c.tileX, c.tileY, c.pa, c.pfx, c.pfy, kR, kD);
  return { ph: c.ph, pa: c.pa, kR, kD };
}

class Chunk {
  readonly cx: number;
  readonly cy: number;
  /** Paper planes for this chunk's quadrant of the tile. */
  readonly ph = new Float32Array(NN);
  readonly pa = new Float32Array(NN);
  readonly pfx = new Float32Array(NN);
  readonly pfy = new Float32Array(NN);
  readonly D = new Float32Array(C * NN);
  /** Wet planes; null while the chunk is dormant (dry, deposits only). */
  w: Float32Array | null = null;
  s: Float32Array | null = null;
  m: Float32Array | null = null;
  flux: Float32Array | null = null;
  P: Float32Array | null = null;
  nw: Float32Array | null = null;
  ns: Float32Array | null = null;
  nP: Float32Array | null = null;
  edge: Float32Array | null = null;
  /** Capillary conductance to the right and lower neighbour (precomputed from the paper). */
  kR: Float32Array | null = null;
  kD: Float32Array | null = null;
  /** Capped pigment carry fraction per outflow direction (capillary pass scratch). */
  cap: Float32Array | null = null;
  /** Step stamp and region of the last step that processed this chunk. */
  stamp = 0;
  region: Rect = emptyRect();
  /** Cells that may change next step. */
  active = emptyRect();
  /** Cells changed since the last display. */
  dirty = emptyRect();
  readonly pixels = new Uint8ClampedArray(N * N * 2 * 4);
  hasPaint = false;
  L: Chunk | null = null;
  R: Chunk | null = null;
  U: Chunk | null = null;
  Dn: Chunk | null = null;

  constructor(cx: number, cy: number) {
    this.cx = cx;
    this.cy = cy;
    // Transmittance half starts white (no paint = no effect).
    for (let i = N * N * 4; i < this.pixels.length; i++) this.pixels[i] = 255;
    for (let i = 3; i < N * N * 4; i += 4) this.pixels[i] = 255;
  }

  get awake(): boolean {
    return this.w !== null;
  }

  wake(): void {
    if (this.w) return;
    this.w = new Float32Array(NN);
    this.s = new Float32Array(NN);
    this.m = new Float32Array(NN);
    this.flux = new Float32Array(4 * NN);
    this.P = new Float32Array(C * NN);
    this.nw = new Float32Array(NN);
    this.ns = new Float32Array(NN);
    this.nP = new Float32Array(C * NN);
    this.edge = new Float32Array(NN);
    this.kR = new Float32Array(NN);
    this.kD = new Float32Array(NN);
    this.cap = new Float32Array(4 * NN);
  }

  sleep(): void {
    this.w = this.s = this.m = this.flux = this.P = this.nw = this.ns = this.nP = this.edge = null;
    this.kR = this.kD = this.cap = null;
    this.active = emptyRect();
  }

  get tileX(): number {
    return (((this.cx * N) % PAPER_TILE) + PAPER_TILE) % PAPER_TILE;
  }

  get tileY(): number {
    return (((this.cy * N) % PAPER_TILE) + PAPER_TILE) % PAPER_TILE;
  }

  paper(tile: PaperTile): void {
    const ox = this.tileX;
    const oy = this.tileY;
    for (let y = 0; y < N; y++) {
      const src = (oy + y) * PAPER_TILE + ox;
      this.ph.set(tile.h.subarray(src, src + N), y * N);
      this.pa.set(tile.a.subarray(src, src + N), y * N);
      this.pfx.set(tile.fx.subarray(src, src + N), y * N);
      this.pfy.set(tile.fy.subarray(src, src + N), y * N);
    }
  }
}

export class CpuBackend implements SimBackend {
  readonly kind = "cpu" as const;
  readonly #chunks = new Map<string, Chunk>();
  #tile: PaperTile | null = null;
  #dry = 1;
  readonly #band = new Int32Array(1);

  setPaper(tile: PaperTile): void {
    this.#tile = tile;
    for (const c of this.#chunks.values()) {
      c.paper(tile);
      if (c.awake) this.#conductances(c);
    }
  }

  #conductances(c: Chunk): void {
    if (this.#tile && c.kR && c.kD) conductances(this.#tile, c.tileX, c.tileY, c.pa, c.pfx, c.pfy, c.kR, c.kD);
  }

  setDrying(factor: number): void {
    this.#dry = Math.max(0.05, Math.min(10, factor));
  }

  #get(cx: number, cy: number): Chunk | undefined {
    return this.#chunks.get(`${cx}_${cy}`);
  }

  has(cx: number, cy: number): boolean {
    return this.#chunks.has(`${cx}_${cy}`);
  }

  ensure(cx: number, cy: number): void {
    let c = this.#get(cx, cy);
    if (!c) {
      c = new Chunk(cx, cy);
      if (this.#tile) c.paper(this.#tile);
      this.#chunks.set(`${cx}_${cy}`, c);
      this.#link(c);
    }
    if (!c.awake) {
      c.wake();
      this.#conductances(c);
    }
  }

  #link(c: Chunk): void {
    const l = this.#get(c.cx - 1, c.cy);
    const r = this.#get(c.cx + 1, c.cy);
    const u = this.#get(c.cx, c.cy - 1);
    const d = this.#get(c.cx, c.cy + 1);
    c.L = l ?? null;
    c.R = r ?? null;
    c.U = u ?? null;
    c.Dn = d ?? null;
    if (l) l.R = c;
    if (r) r.L = c;
    if (u) u.Dn = c;
    if (d) d.U = c;
  }

  /* -------------------------------------------- */
  /*  Dabs                                        */
  /* -------------------------------------------- */

  /** Chunk and local index of a global cell, or null. */
  #cell(gx: number, gy: number): [Chunk, number] | null {
    const cx = Math.floor(gx / N);
    const cy = Math.floor(gy / N);
    const c = this.#get(cx, cy);
    if (!c || !c.awake) return null;
    return [c, (gy - cy * N) * N + (gx - cx * N)];
  }

  gather(dabs: Float32Array, n: number, out: Float32Array): void {
    out.fill(0, 0, n * GATHER_FLOATS);
    for (let d = 0; d < n; d++) {
      const o = d * DAB_FLOATS;
      const go = d * GATHER_FLOATS;
      for (let b = 0; b < BANDS; b++) {
        const g = go + b * GATHER_BAND;
        let csum = 0;
        for (let k = 0; k < GATHER_SAMPLES; k++) {
          const [ox, oy] = gatherOffset(dabs, o, b, k);
          const sx = dabs[o + DAB.x]! + ox;
          const sy = dabs[o + DAB.y]! + oy;
          const hit = this.#cell(Math.floor(sx), Math.floor(sy));
          if (!hit) continue;
          const [ch, i] = hit;
          const c = contact(dabs, o, ox, oy, ch.ph[i]!, this.#band);
          if (c <= 0) continue;
          csum += c;
          for (let k2 = 0; k2 < C; k2++) out[g + 1 + k2]! += c * ch.P![k2 * NN + i]!;
          out[g + 1 + C]! += c * ch.w![i]!;
        }
        out[g] = csum / GATHER_SAMPLES;
        if (csum > 0) for (let k2 = 1; k2 <= C + 1; k2++) out[g + k2]! /= csum;
      }
    }
  }

  applyDabs(dabs: Float32Array, n: number): void {
    const band = this.#band;
    for (let d = 0; d < n; d++) {
      const o = d * DAB_FLOATS;
      const x = dabs[o + DAB.x]!;
      const y = dabs[o + DAB.y]!;
      const r = dabs[o + DAB.r]!;
      const pickup = dabs[o + DAB.pickup]!;
      const pickupW = dabs[o + DAB.pickupWater]!;
      const lift = dabs[o + DAB.lift]!;
      const oil = dabs[o + DAB.oil]!;
      const gx0 = Math.floor(x - r);
      const gx1 = Math.floor(x + r);
      const gy0 = Math.floor(y - r);
      const gy1 = Math.floor(y + r);
      for (let cy = Math.floor(gy0 / N); cy <= Math.floor(gy1 / N); cy++) {
        for (let cx = Math.floor(gx0 / N); cx <= Math.floor(gx1 / N); cx++) {
          if (!dabIncludesChunk(dabs, o, cx, cy)) continue;
          const ch = this.#get(cx, cy);
          if (!ch?.awake) continue;
          const P = ch.P!;
          const D = ch.D;
          const w = ch.w!;
          const mm = ch.m!;
          const lx0 = Math.max(0, gx0 - cx * N);
          const lx1 = Math.min(N - 1, gx1 - cx * N);
          const ly0 = Math.max(0, gy0 - cy * N);
          const ly1 = Math.min(N - 1, gy1 - cy * N);
          if (lx1 < lx0 || ly1 < ly0) continue;
          let touched = false;
          for (let ly = ly0; ly <= ly1; ly++) {
            const dy = cy * N + ly + 0.5 - y;
            for (let lx = lx0; lx <= lx1; lx++) {
              const i = ly * N + lx;
              const c = contact(dabs, o, cx * N + lx + 0.5 - x, dy, ch.ph[i]!, band);
              if (c <= 0) continue;
              touched = true;
              const bo = o + DAB_HEADER + band[0]! * DAB_BAND;
              const keep = 1 - pickup * c;
              for (let k = 0; k < C; k++) {
                const j = k * NN + i;
                P[j] = P[j]! * keep + dabs[bo + BAND.dep + k]! * c;
              }
              w[i] = w[i]! * (1 - pickupW * c) + dabs[bo + BAND.depW]! * c;
              if (lift > 0) {
                const A = D[PIG.A * NN + i]!;
                if (A > EMPTY_EPS) {
                  const f = lift * c * Math.max(0, 1 - D[PIG.F * NN + i]! / A);
                  for (let k = 0; k < C; k++) {
                    const j = k * NN + i;
                    const moved = D[j]! * f;
                    D[j] = D[j]! - moved;
                    P[j] = P[j]! + moved;
                  }
                }
              }
              if (oil > 0) mm[i] = Math.max(mm[i]!, oil * c);
            }
          }
          if (touched) {
            grow(ch.active, lx0 - 1, ly0 - 1, lx1 + 1, ly1 + 1);
            grow(ch.dirty, lx0, ly0, lx1, ly1);
            ch.hasPaint = true;
          }
        }
      }
    }
  }

  /* -------------------------------------------- */
  /*  Physics step                                */
  /* -------------------------------------------- */

  /** Region processed this step: activity grown by 2, plus edge strips where a neighbour is active. */
  #region(c: Chunk): Rect | null {
    const r = emptyRect();
    if (!isEmpty(c.active)) grow(r, c.active.x0 - 2, c.active.y0 - 2, c.active.x1 + 2, c.active.y1 + 2);
    const near = 3;
    if (c.L?.awake && !isEmpty(c.L.active) && c.L.active.x1 >= N - near)
      grow(r, 0, c.L.active.y0 - 2, 1, c.L.active.y1 + 2);
    if (c.R?.awake && !isEmpty(c.R.active) && c.R.active.x0 < near)
      grow(r, N - 2, c.R.active.y0 - 2, N - 1, c.R.active.y1 + 2);
    if (c.U?.awake && !isEmpty(c.U.active) && c.U.active.y1 >= N - near)
      grow(r, c.U.active.x0 - 2, 0, c.U.active.x1 + 2, 1);
    if (c.Dn?.awake && !isEmpty(c.Dn.active) && c.Dn.active.y0 < near)
      grow(r, c.Dn.active.x0 - 2, N - 2, c.Dn.active.x1 + 2, N - 1);
    return isEmpty(r) ? null : r;
  }

  step(active: readonly [number, number][]): void {
    const tile = this.#tile;
    if (!tile) return;
    const paper = tile.props;
    const work: [Chunk, Rect][] = [];
    const seen = new Set<Chunk>();
    const consider = (c: Chunk | null | undefined) => {
      if (!c || !c.awake || seen.has(c)) return;
      seen.add(c);
      const r = this.#region(c);
      if (r) work.push([c, r]);
    };
    for (const [cx, cy] of active) {
      const c = this.#get(cx, cy);
      consider(c);
      if (c) {
        consider(c.L);
        consider(c.R);
        consider(c.U);
        consider(c.Dn);
      }
    }
    const stamp = ++this.#stamp;
    for (const [c, r] of work) {
      c.stamp = stamp;
      c.region = r;
    }
    for (const [c, r] of work) this.#passFlux(c, r, paper.relief);
    for (const [c, r] of work) this.#passTransport(c, r);
    for (const [c, r] of work) this.#commit(c, r, true, false);
    for (const [c, r] of work) this.#capillaryOut(c, r, paper.carry);
    for (const [c, r] of work) this.#capillaryIn(c, r, paper.carry);
    for (const [c, r] of work) this.#commit(c, r, false, true);
    for (const [c, r] of work) this.#passLocal(c, r, paper);
  }

  /** Neighbour lookup: chunk and index of cell `i` (x, y) in direction 0 L, 1 R, 2 U, 3 D. */
  static nb(c: Chunk, x: number, y: number, i: number, dir: number, out: { c: Chunk | null; i: number }): boolean {
    switch (dir) {
      case 0:
        if (x > 0) {
          out.c = c;
          out.i = i - 1;
        } else {
          out.c = c.L;
          out.i = i + N - 1;
        }
        break;
      case 1:
        if (x < N - 1) {
          out.c = c;
          out.i = i + 1;
        } else {
          out.c = c.R;
          out.i = i - (N - 1);
        }
        break;
      case 2:
        if (y > 0) {
          out.c = c;
          out.i = i - N;
        } else {
          out.c = c.U;
          out.i = i + N * (N - 1);
        }
        break;
      default:
        if (y < N - 1) {
          out.c = c;
          out.i = i + N;
        } else {
          out.c = c.Dn;
          out.i = i - N * (N - 1);
        }
    }
    return !!out.c && out.c.awake;
  }

  readonly #nb = { c: null as Chunk | null, i: 0 };

  #passFlux(c: Chunk, r: Rect, relief: number): void {
    const w = c.w!;
    const f = c.flux!;
    const P = c.P!;
    const nb = this.#nb;
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const i = y * N + x;
        const wi = w[i]!;
        if (wi <= DRY_EPS) {
          f[i] = f[NN + i] = f[2 * NN + i] = f[3 * NN + i] = 0;
          continue;
        }
        const Hi = wi + relief * c.ph[i]!;
        const mob = 1 / (1 + (PHYS.viscosity * P[PIG.A * NN + i]!) / (wi + 1e-3));
        let sum = 0;
        for (let d = 0; d < 4; d++) {
          let out = 0;
          if (CpuBackend.nb(c, x, y, i, d, nb)) {
            const wj = nb.c!.w![nb.i]!;
            let dH = Hi - (wj + relief * nb.c!.ph[nb.i]!);
            if (wj <= DRY_EPS) dH -= PHYS.tension;
            out = Math.max(0, f[d * NN + i]! * PHYS.flowDamping + PHYS.flowGain * dH) * mob;
          }
          f[d * NN + i] = out;
          sum += out;
        }
        if (sum > wi) {
          const k = wi / sum;
          for (let d = 0; d < 4; d++) f[d * NN + i]! *= k;
        }
      }
    }
  }

  #passTransport(c: Chunk, r: Rect): void {
    const w = c.w!;
    const f = c.flux!;
    const P = c.P!;
    const nw = c.nw!;
    const nP = c.nP!;
    const nb = this.#nb;
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const i = y * N + x;
        const wi = w[i]!;
        const out = f[i]! + f[NN + i]! + f[2 * NN + i]! + f[3 * NN + i]!;
        const keep = wi > DRY_EPS ? 1 - out / wi : 1;
        let water = wi - out;
        for (let k = 0; k < C; k++) nP[k * NN + i] = P[k * NN + i]! * keep;
        for (let d = 0; d < 4; d++) {
          if (!CpuBackend.nb(c, x, y, i, d, nb)) continue;
          const o = nb.c!;
          const j = nb.i;
          const inflow = o.flux![(d ^ 1) * NN + j]!;
          if (inflow <= 0) continue;
          water += inflow;
          const wj = o.w![j]!;
          if (wj <= DRY_EPS || o.P![PIG.A * NN + j]! <= 0) continue;
          const frac = inflow / wj;
          for (let k = 0; k < C; k++) nP[k * NN + i]! += o.P![k * NN + j]! * frac;
        }
        nw[i] = Math.max(0, water);
      }
    }
  }

  /** Copy scratch planes back inside the region (a whole-chunk region just swaps the buffers). */
  #commit(c: Chunk, r: Rect, water: boolean, capillary: boolean): void {
    if (r.x0 === 0 && r.y0 === 0 && r.x1 === N - 1 && r.y1 === N - 1) {
      if (water) [c.w, c.nw] = [c.nw, c.w];
      if (capillary) [c.s, c.ns] = [c.ns, c.s];
      [c.P, c.nP] = [c.nP, c.P];
      return;
    }
    const rowLen = r.x1 - r.x0 + 1;
    for (let y = r.y0; y <= r.y1; y++) {
      const a = y * N + r.x0;
      if (water) c.w!.set(c.nw!.subarray(a, a + rowLen), a);
      if (capillary) c.s!.set(c.ns!.subarray(a, a + rowLen), a);
      for (let k = 0; k < C; k++) c.P!.set(c.nP!.subarray(k * NN + a, k * NN + a + rowLen), k * NN + a);
    }
  }

  #stamp = 0;

  /** Conductance between cell i of c and its neighbour j of o in direction d (see {@link #conductances}). */
  static k(c: Chunk, i: number, o: Chunk, j: number, d: number): number {
    switch (d) {
      case 0:
        return o.kR![j]!;
      case 1:
        return c.kR![i]!;
      case 2:
        return o.kD![j]!;
      default:
        return c.kD![i]!;
    }
  }

  /** Capillary outflow: saturation diffuses; each outflow carries a capped share of the suspended pigment. */
  #capillaryOut(c: Chunk, r: Rect, carry: number): void {
    const s = c.s!;
    const w = c.w!;
    const P = c.P!;
    const ns = c.ns!;
    const nP = c.nP!;
    const edge = c.edge!;
    const cap = c.cap!;
    const nb = this.#nb;
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const i = y * N + x;
        const si = s[i]!;
        const wi = w[i]!;
        let sNew = si;
        let dryNb = 0;
        let leave = 0;
        for (let d = 0; d < 4; d++) {
          cap[d * NN + i] = 0;
          if (!CpuBackend.nb(c, x, y, i, d, nb)) continue;
          const o = nb.c!;
          const j = nb.i;
          const sj = o.s![j]!;
          if (o.w![j]! <= DRY_EPS) dryNb++;
          if (Math.max(si, sj) <= PHYS.capillaryMin) continue;
          const phi = CpuBackend.k(c, i, o, j, d) * (si - sj);
          sNew -= phi;
          if (phi > 0) {
            const frac = (carry * phi) / (si + wi + 1e-4);
            cap[d * NN + i] = frac;
            leave += frac;
          }
        }
        ns[i] = Math.max(0, Math.min(1, sNew));
        edge[i] = wi > DRY_EPS ? dryNb / 4 : 0;
        const scale = leave > PHYS.carryMax ? PHYS.carryMax / leave : 1;
        if (scale !== 1) for (let d = 0; d < 4; d++) cap[d * NN + i]! *= scale;
        const keep = 1 - leave * scale;
        for (let k = 0; k < C; k++) nP[k * NN + i] = P[k * NN + i]! * keep;
      }
    }
  }

  /** Capillary inflow: pigment carried from wetter neighbours (their capped share towards this cell). */
  #capillaryIn(c: Chunk, r: Rect, carry: number): void {
    const s = c.s!;
    const nP = c.nP!;
    const nb = this.#nb;
    const stamp = this.#stamp;
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const i = y * N + x;
        const si = s[i]!;
        for (let d = 0; d < 4; d++) {
          if (!CpuBackend.nb(c, x, y, i, d, nb)) continue;
          const o = nb.c!;
          const j = nb.i;
          const sj = o.s![j]!;
          if (Math.max(si, sj) <= PHYS.capillaryMin || sj <= si) continue;
          const jx = j % N;
          const jy = (j / N) | 0;
          const g = o.region;
          const frac =
            o.stamp === stamp && jx >= g.x0 && jx <= g.x1 && jy >= g.y0 && jy <= g.y1
              ? o.cap![(d ^ 1) * NN + j]!
              : this.#carryFraction(o, j, d ^ 1, carry);
          if (frac <= 0 || o.P![PIG.A * NN + j]! <= 0) continue;
          for (let k = 0; k < C; k++) nP[k * NN + i]! += o.P![k * NN + j]! * frac;
        }
      }
    }
  }

  readonly #nb2 = { c: null as Chunk | null, i: 0 };

  /** Capped fraction of cell j's suspended pigment carried towards `dir` (for cells outside this step's regions). */
  #carryFraction(c: Chunk, j: number, dir: number, carry: number): number {
    const nb = this.#nb2;
    const x = j % N;
    const y = (j / N) | 0;
    const sj = c.s![j]!;
    const wj = c.w![j]!;
    let leave = 0;
    let mine = 0;
    for (let d = 0; d < 4; d++) {
      if (!CpuBackend.nb(c, x, y, j, d, nb)) continue;
      const sk = nb.c!.s![nb.i]!;
      if (Math.max(sj, sk) <= PHYS.capillaryMin || sk >= sj) continue;
      const frac = (carry * CpuBackend.k(c, j, nb.c!, nb.i, d) * (sj - sk)) / (sj + wj + 1e-4);
      leave += frac;
      if (d === dir) mine = frac;
    }
    const scale = leave > PHYS.carryMax ? PHYS.carryMax / leave : 1;
    return mine * scale;
  }

  #passLocal(c: Chunk, r: Rect, paper: PaperProps): void {
    const { absorb, capacity, tooth, evaporation } = paper;
    const damp = paper.bleed;
    const w = c.w!;
    const s = c.s!;
    const m = c.m!;
    const P = c.P!;
    const D = c.D;
    const edge = c.edge!;
    const dry = this.#dry * evaporation;
    const act = emptyRect();
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const i = y * N + x;
        let wi = w[i]!;
        let si = s[i]!;
        let mi = m[i]!;
        // Absorption into the paper.
        if (wi > 0 && si < 1) {
          const da = Math.min(wi, absorb * c.pa[i]! * (1 - si));
          wi -= da;
          si = Math.min(1, si + da / capacity);
        }
        // Evaporation (faster at the rim of a wet area).
        if (wi > 0) wi = Math.max(0, wi - PHYS.evaporate * dry * (1 + PHYS.edgeBoost * edge[i]!));
        if (si > 0) si = Math.max(0, si - PHYS.evaporateCapillary * dry * (wi > DRY_EPS ? 0.3 : 1));
        if (mi > 0) mi = Math.max(0, mi - PHYS.evaporateOil * this.#dry);
        if (wi < DRY_EPS) wi = 0;
        if (si < DRY_EPS) si = 0;
        if (mi < DRY_EPS) mi = 0;
        w[i] = wi;
        s[i] = si;
        m[i] = mi;
        // Settling (granulating pigment sinks into the tooth) and re-wetting.
        const A = P[PIG.A * NN + i]!;
        if (A > EMPTY_EPS) {
          const mob = Math.max(Math.min(1, wi / 0.03), mi, Math.min(1, si * damp));
          const gran = Math.min(1, P[PIG.G * NN + i]! / A);
          const rate = Math.min(1, PHYS.settle * (1 + tooth * gran * (1 - c.ph[i]!) * 2) + (1 - mob) * PHYS.settleDry);
          for (let k = 0; k < C; k++) {
            const j = k * NN + i;
            const moved = P[j]! * rate;
            P[j] = P[j]! - moved;
            D[j] = D[j]! + moved;
          }
        } else if (A !== 0) for (let k = 0; k < C; k++) P[k * NN + i] = 0;
        if (wi > 0.01) {
          const Ad = D[PIG.A * NN + i]!;
          if (Ad > EMPTY_EPS) {
            const f = PHYS.rewetLift * Math.min(1, wi / 0.1) * Math.max(0, 1 - D[PIG.F * NN + i]! / Ad);
            for (let k = 0; k < C; k++) {
              const j = k * NN + i;
              const moved = D[j]! * f;
              D[j] = D[j]! - moved;
              P[j] = P[j]! + moved;
            }
          }
        }
        if (wi > 0 || si > 0 || mi > 0 || P[PIG.A * NN + i]! > EMPTY_EPS) grow(act, x, y, x, y);
      }
    }
    grow(c.dirty, r.x0, r.y0, r.x1, r.y1);
    c.active = act;
  }

  quiet(cx: number, cy: number): boolean {
    const c = this.#get(cx, cy);
    return !c || !c.awake || isEmpty(c.active);
  }

  settle(cx: number, cy: number): void {
    const c = this.#get(cx, cy);
    if (!c?.awake) return;
    const P = c.P!;
    for (let j = 0; j < C * NN; j++) c.D[j] = c.D[j]! + P[j]!;
    grow(c.dirty, 0, 0, N - 1, N - 1);
    c.sleep();
  }

  /* -------------------------------------------- */
  /*  Display                                     */
  /* -------------------------------------------- */

  display(cx: number, cy: number): Uint8ClampedArray | null {
    const c = this.#get(cx, cy);
    if (!c) return null;
    const r = c.dirty;
    if (isEmpty(r)) return c.hasPaint ? c.pixels.slice() : null;
    const px = c.pixels;
    const D = c.D;
    const P = c.P;
    const w = c.w;
    const spec = new Float64Array(GROUPS);
    const trans = new Float64Array(GROUPS);
    let any = c.hasPaint;
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const i = y * N + x;
        const o = i * 4;
        const t = (NN + i) * 4;
        let A = D[PIG.A * NN + i]!;
        let sx = D[PIG.S * NN + i]!;
        if (P) {
          A += P[PIG.A * NN + i]!;
          sx += P[PIG.S * NN + i]!;
        }
        if (A <= EMPTY_EPS) {
          px[o] = px[o + 1] = px[o + 2] = 0;
          px[t] = px[t + 1] = px[t + 2] = 255;
          continue;
        }
        any = true;
        for (let g = 0; g < GROUPS; g++) {
          let kx = D[g * NN + i]!;
          if (P) kx += P[g * NN + i]!;
          kx = Math.max(0, kx);
          if (sx < 1e-6) {
            spec[g] = 0;
            trans[g] = Math.exp(-kx);
            continue;
          }
          const ks = kx / sx;
          const a = 1 + ks;
          const b = Math.sqrt(ks * ks + 2 * ks);
          if (b < 1e-6) {
            spec[g] = sx / (sx + 1);
            trans[g] = 1 / (sx + 1);
          } else {
            const xx = b * sx;
            const om = -Math.expm1(-2 * xx);
            const den = a * om + b * (2 - om);
            spec[g] = om / den;
            trans[g] = (2 * b * Math.exp(-xx)) / den;
          }
        }
        let rr = 0;
        let rg = 0;
        let rb = 0;
        let tr = 0;
        let tg = 0;
        let tb = 0;
        for (let g = 0; g < GROUPS; g++) {
          const v = spec[g]!;
          const tt = trans[g]! * trans[g]!;
          rr += M0[g]! * v;
          rg += M1[g]! * v;
          rb += M2[g]! * v;
          tr += M0[g]! * tt;
          tg += M1[g]! * tt;
          tb += M2[g]! * tt;
        }
        const h = c.ph[i]!;
        const wet = w ? Math.min(1, w[i]! / 0.2) : 0;
        const rk = (0.93 + 0.07 * h) * (1 - PHYS.wetDarken * wet);
        const tk = 0.96 + 0.04 * h;
        px[o] = enc(rr * rk);
        px[o + 1] = enc(rg * rk);
        px[o + 2] = enc(rb * rk);
        px[t] = enc(tr * tk);
        px[t + 1] = enc(tg * tk);
        px[t + 2] = enc(tb * tk);
      }
    }
    c.dirty = emptyRect();
    c.hasPaint = any;
    return any ? px.slice() : null;
  }

  /* -------------------------------------------- */
  /*  Import / export                             */
  /* -------------------------------------------- */

  exportDeposit(cx: number, cy: number): Uint16Array {
    const c = this.#get(cx, cy);
    const out = new Uint16Array(C * NN);
    if (!c) return out;
    for (let j = 0; j < C * NN; j++) out[j] = toHalf(c.D[j]!);
    return out;
  }

  importDeposit(cx: number, cy: number, halves: Uint16Array): void {
    let c = this.#get(cx, cy);
    if (!c) {
      this.ensure(cx, cy);
      c = this.#get(cx, cy)!;
    }
    c.sleep();
    for (let j = 0; j < C * NN; j++) {
      const v = fromHalf(halves[j]!);
      c.D[j] = v > 0 ? v : 0;
    }
    c.hasPaint = true;
    grow(c.dirty, 0, 0, N - 1, N - 1);
  }

  snapshot(cx: number, cy: number): ChunkSnapshot {
    const c = this.#get(cx, cy);
    const fluid = new Float32Array(3 * NN);
    const flux = new Float32Array(4 * NN);
    const suspended = new Float32Array(C * NN);
    const deposited = new Float32Array(C * NN);
    if (c) {
      deposited.set(c.D);
      if (c.awake) {
        fluid.set(c.w!, 0);
        fluid.set(c.s!, NN);
        fluid.set(c.m!, 2 * NN);
        flux.set(c.flux!);
        suspended.set(c.P!);
      }
    }
    return { fluid, flux, suspended, deposited };
  }

  restore(cx: number, cy: number, snap: ChunkSnapshot): void {
    this.ensure(cx, cy);
    const c = this.#get(cx, cy)!;
    c.D.set(snap.deposited);
    c.w!.set(snap.fluid.subarray(0, NN));
    c.s!.set(snap.fluid.subarray(NN, 2 * NN));
    c.m!.set(snap.fluid.subarray(2 * NN, 3 * NN));
    c.flux!.set(snap.flux);
    c.P!.set(snap.suspended);
    c.active = { x0: 0, y0: 0, x1: N - 1, y1: N - 1 };
    c.dirty = { x0: 0, y0: 0, x1: N - 1, y1: N - 1 };
    c.hasPaint = true;
  }

  remove(cx: number, cy: number): void {
    const c = this.#get(cx, cy);
    if (!c) return;
    if (c.L) c.L.R = null;
    if (c.R) c.R.L = null;
    if (c.U) c.U.Dn = null;
    if (c.Dn) c.Dn.U = null;
    this.#chunks.delete(`${cx}_${cy}`);
  }

  clear(): void {
    this.#chunks.clear();
  }

  destroy(): void {
    this.clear();
  }

  /* -------------------------------------------- */
  /*  Dormant storage for the GPU backend         */
  /* -------------------------------------------- */

  /** Create a chunk without waking it. */
  touch(cx: number, cy: number): void {
    if (this.#get(cx, cy)) return;
    const c = new Chunk(cx, cy);
    if (this.#tile) c.paper(this.#tile);
    this.#chunks.set(`${cx}_${cy}`, c);
    this.#link(c);
  }

  /** The deposit planes of a chunk (live reference), or null. */
  depositPlanes(cx: number, cy: number): Float32Array | null {
    return this.#get(cx, cy)?.D ?? null;
  }

  /** The deposits changed outside this backend: redraw the whole chunk. */
  invalidate(cx: number, cy: number): void {
    const c = this.#get(cx, cy);
    if (!c) return;
    c.hasPaint = true;
    grow(c.dirty, 0, 0, N - 1, N - 1);
  }

  /** Total pigment amount and water of the awake chunks (tests). */
  totals(): { pigment: number; water: number; suspended: number } {
    let pigment = 0;
    let water = 0;
    let suspended = 0;
    for (const c of this.#chunks.values()) {
      for (let i = 0; i < NN; i++) pigment += c.D[PIG.A * NN + i]!;
      if (c.awake) {
        for (let i = 0; i < NN; i++) {
          const a = c.P![PIG.A * NN + i]!;
          pigment += a;
          suspended += a;
          water += c.w![i]! + c.s![i]!;
        }
      }
    }
    return { pigment, water, suspended };
  }

  /** Cell probe (tests and debugging). */
  probe(gx: number, gy: number): { w: number; s: number; m: number; P: number[]; D: number[] } | null {
    const hit = this.#cell(gx, gy);
    const cx = Math.floor(gx / N);
    const cy = Math.floor(gy / N);
    const c = this.#get(cx, cy);
    if (!c) return null;
    const i = (gy - cy * N) * N + (gx - cx * N);
    const P = hit ? Array.from({ length: C }, (_, k) => c.P![k * NN + i]!) : new Array<number>(C).fill(0);
    return {
      w: hit ? c.w![i]! : 0,
      s: hit ? c.s![i]! : 0,
      m: hit ? c.m![i]! : 0,
      P,
      D: Array.from({ length: C }, (_, k) => c.D[k * NN + i]!),
    };
  }
}
