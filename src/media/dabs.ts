import { CELL_UNITS, CHUNK, PIG, PIG_CHANNELS } from "./layout.ts";
import { MEDIA_BRUSHES } from "./brushes.ts";
import type { MediaBrush, MediaBrushId } from "./brushes.ts";
import { pigmentOf } from "./pigment.ts";

/**
 * Brush ↔ surface exchange, shared by both simulation backends.
 *
 * A stroke is resampled into dabs at fixed distance spacing (deterministic
 * from the stroke's points). The brush is a reservoir of BANDS bristle bands
 * across its width; each band holds pigment (12 channels) and water. Per dab:
 *
 *   surface:  P ← P·(1 − pickup·c) + deposit·L_b·c      (per touched cell)
 *             w ← w·(1 − pickupW·c) + depositW·Lw_b·c
 *   brush:    L_b ← L_b·(1 − drain·c̄_b) + pickup·c̄_b·Ḡ_b·gain
 *
 * where c is the contact (shape, bristle streaks, dry-brush threshold on the
 * paper relief, pressure) and Ḡ_b the wet paint under band b gathered before
 * the batch. Because a band takes up what it touches and lays it down further
 * along, wet colours are dragged and mixed (湿笔拖色); as the load runs out the
 * contact threshold rises and only the paper's peaks take paint (飞白).
 */

export const BANDS = 8;
/** Floats per packed dab: header (16) + BANDS × 16. */
export const DAB_HEADER = 16;
export const DAB_BAND = 16;
export const DAB_FLOATS = DAB_HEADER + BANDS * DAB_BAND;
/** Gather output per dab and band: [c̄, Ḡ(12), Ḡw, unused…]. */
export const GATHER_BAND = 16;
export const GATHER_FLOATS = BANDS * GATHER_BAND;
/** Gather samples per band (2 across × 2 along). */
export const GATHER_SAMPLES = 4;
/** Dabs per backend batch. */
export const MAX_DABS_PER_BATCH = 32;
/** Fine bristle streaks across the brush width. */
export const FIBERS = 24;

/** Header offsets of a packed dab. */
export const DAB = {
  x: 0,
  y: 1,
  r: 2,
  cos: 3,
  sin: 4,
  pressure: 5,
  pickup: 6,
  pickupWater: 7,
  lift: 8,
  oil: 9,
  softness: 10,
  bristles: 11,
  seed: 12,
  chunksLo: 13,
  chunksHi: 14,
} as const;
/** Offsets inside a band block. */
export const BAND = { dep: 0, depW: 12, dryT: 13, density: 14 } as const;

/** A mask over the 5×5 chunks around a dab; zero masks mean unrestricted. */
export function addDabChunk(data: Float32Array, o: number, cx: number, cy: number): void {
  const x = cx - Math.floor(data[o + DAB.x]! / CHUNK) + 2;
  const y = cy - Math.floor(data[o + DAB.y]! / CHUNK) + 2;
  if (x < 0 || x >= 5 || y < 0 || y >= 5) return;
  const bit = y * 5 + x;
  const i = o + (bit < 15 ? DAB.chunksLo : DAB.chunksHi);
  data[i] = data[i]! | (1 << (bit % 15));
}

export function dabIncludesChunk(data: Float32Array, o: number, cx: number, cy: number): boolean {
  const lo = data[o + DAB.chunksLo]!;
  const hi = data[o + DAB.chunksHi]!;
  if (!lo && !hi) return true;
  const x = cx - Math.floor(data[o + DAB.x]! / CHUNK) + 2;
  const y = cy - Math.floor(data[o + DAB.y]! / CHUNK) + 2;
  if (x < 0 || x >= 5 || y < 0 || y >= 5) return false;
  const bit = y * 5 + x;
  return ((bit < 15 ? lo : hi) & (1 << (bit % 15))) !== 0;
}

/** 32-bit integer hash → [0, 1). Mirrored exactly in GLSL. */
export function hash01(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i | 0, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 8) / 16777216;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Contact of a dab at offset (dx, dy) cells from its centre over paper height
 * `h`. Returns the contact (0..1) and writes the band index into `band[0]`.
 */
export function contact(d: Float32Array, o: number, dx: number, dy: number, h: number, band: Int32Array): number {
  const r = d[o + DAB.r]!;
  const u = dx * d[o + DAB.cos]! + dy * d[o + DAB.sin]!;
  const v = -dx * d[o + DAB.sin]! + dy * d[o + DAB.cos]!;
  const dist = Math.sqrt(u * u + v * v) / r;
  if (dist >= 1) return 0;
  const shape = Math.min(1, (1 - dist) / Math.max(0.05, d[o + DAB.softness]!));
  const across = Math.min(0.999999, Math.max(0, (v / r + 1) * 0.5));
  const b = Math.floor(across * BANDS);
  band[0] = b;
  const bo = o + DAB_HEADER + b * DAB_BAND;
  const seed = d[o + DAB.seed]! | 0;
  const streak = 1 - d[o + DAB.bristles]! * 0.6 * hash01(seed, Math.floor(across * FIBERS));
  const t = d[bo + BAND.dryT]!;
  const dry = t <= 0 ? 1 : smoothstep(t - 0.12, t + 0.12, h);
  return shape * streak * d[bo + BAND.density]! * dry * d[o + DAB.pressure]!;
}

/** Sample offsets (cells, dab frame) of gather sample `k` of band `b`. */
export function gatherOffset(d: Float32Array, o: number, b: number, k: number): [number, number] {
  const r = d[o + DAB.r]!;
  const across = ((b + (k & 1 ? 0.75 : 0.25)) / BANDS) * 2 - 1;
  const along = k & 2 ? 0.35 : -0.35;
  const u = along * r;
  const v = across * r;
  return [u * d[o + DAB.cos]! - v * d[o + DAB.sin]!, u * d[o + DAB.sin]! + v * d[o + DAB.cos]!];
}

/* -------------------------------------------- */
/*  Stroke walker                               */
/* -------------------------------------------- */

export interface Dab {
  /** Global cell coordinates. */
  x: number;
  y: number;
  /** Radius (cells). */
  r: number;
  angle: number;
  /** Pen pressure 0..1. */
  p: number;
}

/** Resamples stroke points (map units, flat x, y, pressure) into evenly spaced dabs. */
export class DabWalker {
  readonly #radius: number;
  readonly #spacing: number;
  readonly #limit: number;
  #px = NaN;
  #py = NaN;
  #pp = 0.5;
  /** Distance travelled since the last dab. */
  #carry = 0;
  #angle = 0;
  #started = false;
  #count = 0;
  #emitted = 0;

  constructor(sizeUnits: number, brush: MediaBrush, limit = Infinity) {
    this.#radius = Math.max(0.75, sizeUnits / 2 / CELL_UNITS);
    this.#spacing = Math.max(0.4, brush.spacing * this.#radius);
    this.#limit = limit;
  }

  get radius(): number {
    return this.#radius;
  }

  /** Points consumed so far. */
  get count(): number {
    return this.#count;
  }

  /** Feed points (map units); returns the new dabs. */
  push(points: ArrayLike<number>, out: Dab[] = []): Dab[] {
    for (let i = 0; i + 2 < points.length; i += 3) {
      const x = points[i]! / CELL_UNITS;
      const y = points[i + 1]! / CELL_UNITS;
      const p = points[i + 2]!;
      this.#count++;
      if (!this.#started) {
        this.#started = true;
        this.#px = x;
        this.#py = y;
        this.#pp = p;
        this.#carry = this.#spacing; // A dab at the very first point.
        continue;
      }
      const dx = x - this.#px;
      const dy = y - this.#py;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) {
        this.#pp = p;
        continue;
      }
      this.#angle = Math.atan2(dy, dx);
      let pos = this.#spacing - this.#carry;
      if (this.#carry >= this.#spacing) pos = 0;
      while (pos <= len && this.#emitted < this.#limit) {
        const f = pos / len;
        out.push({
          x: this.#px + dx * f,
          y: this.#py + dy * f,
          r: this.#radius,
          angle: this.#angle,
          p: this.#pp + (p - this.#pp) * f,
        });
        this.#emitted++;
        pos += this.#spacing;
      }
      if (this.#emitted >= this.#limit) break;
      this.#carry = len - (pos - this.#spacing);
      this.#px = x;
      this.#py = y;
      this.#pp = p;
    }
    return out;
  }

  /** End of the stroke: a tap that never moved still leaves one dab. */
  finish(out: Dab[] = []): Dab[] {
    if (this.#started && this.#emitted === 0) {
      out.push({ x: this.#px, y: this.#py, r: this.#radius, angle: this.#angle, p: this.#pp });
      this.#emitted++;
    }
    return out;
  }
}

/* -------------------------------------------- */
/*  Brush reservoir                             */
/* -------------------------------------------- */

export interface StrokeSpec {
  brush: MediaBrushId;
  color: string;
  pigment: number;
  water: number;
  seed: number;
}

/** The brush's load per bristle band, updated dab by dab. */
/** Fraction of the difference to the brush mean evened out per dab (see `Reservoir#wick`). */
const BRUSH_WICK = 0.3;

export class Reservoir {
  readonly brush: MediaBrush;
  readonly #seed: number;
  /** BANDS × PIG_CHANNELS pigment load (per-cell optical depth units). */
  readonly load = new Float32Array(BANDS * PIG_CHANNELS);
  readonly water = new Float32Array(BANDS);
  readonly #density = new Float32Array(BANDS);
  readonly #wet0: number;
  readonly #dryBrush: boolean;

  constructor(spec: StrokeSpec) {
    const brush = MEDIA_BRUSHES[spec.brush];
    this.brush = brush;
    this.#seed = spec.seed & 0xffffff;
    const amount = brush.coloured ? brush.loadScale * spec.pigment : 0;
    const pig = pigmentOf(spec.color, brush.body ? "body" : "glaze", brush.scatter);
    for (let b = 0; b < BANDS; b++) {
      const jitter = 1 - brush.bristles * 0.35 * hash01(this.#seed ^ 0x1234, b);
      const a = amount * jitter;
      const o = b * PIG_CHANNELS;
      for (let g = 0; g < 8; g++) this.load[o + PIG.k0 + g] = a * pig.k[g]!;
      this.load[o + PIG.S] = a * pig.s;
      this.load[o + PIG.A] = a;
      this.load[o + PIG.G] = a * brush.granulation;
      this.load[o + PIG.F] = a * brush.staining;
      this.water[b] = brush.waterScale * spec.water * (0.85 + 0.15 * jitter);
      this.#density[b] = 1 - brush.bristles * 0.45 * hash01(this.#seed ^ 0x9876, b);
    }
    this.#wet0 = Math.max(0.02, brush.waterScale * spec.water + 0.5 * amount);
    this.#dryBrush = amount + brush.waterScale * spec.water > 0.02;
  }

  /** Pack a dab with the current reservoir into `out` at offset `o`. */
  pack(dab: Dab, out: Float32Array, o: number): void {
    const brush = this.brush;
    out[o + DAB.x] = dab.x;
    out[o + DAB.y] = dab.y;
    out[o + DAB.r] = dab.r * (0.55 + 0.45 * dab.p);
    out[o + DAB.cos] = Math.cos(dab.angle);
    out[o + DAB.sin] = Math.sin(dab.angle);
    out[o + DAB.pressure] = 0.4 + 0.6 * dab.p;
    out[o + DAB.pickup] = brush.pickup;
    out[o + DAB.pickupWater] = brush.pickupWater;
    out[o + DAB.lift] = brush.lift;
    out[o + DAB.oil] = brush.oil;
    out[o + DAB.softness] = brush.softness;
    out[o + DAB.bristles] = brush.bristles;
    out[o + DAB.seed] = this.#seed;
    out[o + DAB.chunksLo] = out[o + DAB.chunksHi] = 0;
    for (let b = 0; b < BANDS; b++) {
      const bo = o + DAB_HEADER + b * DAB_BAND;
      const lo = b * PIG_CHANNELS;
      for (let c = 0; c < PIG_CHANNELS; c++) out[bo + BAND.dep + c] = brush.deposit * this.load[lo + c]!;
      out[bo + BAND.depW] = brush.depositWater * this.water[b]!;
      if (this.#dryBrush) {
        const wet = Math.min(1, (this.water[b]! + 0.5 * this.load[lo + PIG.A]!) / this.#wet0);
        out[bo + BAND.dryT] = Math.min(0.92, Math.max(0, 1.1 - 1.5 * wet - 0.3 * dab.p));
      } else out[bo + BAND.dryT] = 0;
      out[bo + BAND.density] = this.#density[b]!;
    }
  }

  /** Update the load after a dab from what was gathered under each band. */
  exchange(gather: Float32Array, go: number): void {
    const brush = this.brush;
    const gain = brush.drain / Math.max(brush.deposit, 0.05);
    const gainW = brush.drain / Math.max(brush.depositWater, 0.05);
    for (let b = 0; b < BANDS; b++) {
      const g = go + b * GATHER_BAND;
      const cbar = gather[g]!;
      if (cbar <= 0) continue;
      const lo = b * PIG_CHANNELS;
      const keep = 1 - brush.drain * cbar;
      const take = brush.pickup * cbar * gain;
      for (let c = 0; c < PIG_CHANNELS; c++) this.load[lo + c] = this.load[lo + c]! * keep + take * gather[g + 1 + c]!;
      this.water[b] = this.water[b]! * keep + brush.pickupWater * cbar * gainW * gather[g + 1 + PIG_CHANNELS]!;
    }
    this.#wick();
  }

  /**
   * Paint and water creep between the bristles towards the drier ones (the
   * belly of the brush feeds the tip), so bands that touch the paper most do
   * not run dry while the rim still holds paint.
   */
  #wick(): void {
    for (let c = 0; c < PIG_CHANNELS; c++) {
      let mean = 0;
      for (let b = 0; b < BANDS; b++) mean += this.load[b * PIG_CHANNELS + c]!;
      mean /= BANDS;
      for (let b = 0; b < BANDS; b++) {
        const i = b * PIG_CHANNELS + c;
        this.load[i] = this.load[i]! + BRUSH_WICK * (mean - this.load[i]!);
      }
    }
    let mean = 0;
    for (let b = 0; b < BANDS; b++) mean += this.water[b]!;
    mean /= BANDS;
    for (let b = 0; b < BANDS; b++) this.water[b] = this.water[b]! + BRUSH_WICK * (mean - this.water[b]!);
  }
}
