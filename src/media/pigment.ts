import { GROUPS, GROUP_OF, BASE_SPECTRA, BANDS, CMF, CMF_G, R_MIN, XYZ_RGB, Y_MIN } from "./spectral-tables.ts";

/**
 * Pigment optics: two-constant Kubelka–Munk over 8 spectral band groups.
 *
 * A cell holds absorption and scattering *optical depths* summed over every
 * pigment particle in it:
 *
 *   Kx_g = Σ aᵢ·Kᵢ,g      Sx = Σ aᵢ·Sᵢ      (aᵢ = amount)
 *
 * Mixing, flow, deposit and pickup are linear in these sums; the colour is
 * the KM reflectance R and transmittance T of a layer with K/S = Kx/Sx and
 * thickness Sx. Ink and paint therefore build up physically: more pigment →
 * deeper, more saturated colour, layered glazes multiply, an opaque body
 * covers what is beneath.
 *
 * Colours become pigments in one of two ways:
 *
 *  - body (gouache, oil): Sᵢ ∝ luminance and Kᵢ = Sᵢ·KS(colour). The masstone
 *    of a thick layer is the chosen colour and mixtures follow spectral.js's
 *    `mix()` (blue + yellow → green, not grey).
 *  - glaze (watercolour, ink): almost no scattering; Kᵢ is chosen so that a
 *    reference wash (GLAZE_REF amount) over white shows the chosen colour.
 *    Thinner is lighter, more is deeper, and glazes mix subtractively.
 */

export { GROUPS };

/** Optical depth of one amount unit of a body pigment's scattering (× luminance). */
export const BODY_SCATTER = 4.5;
/** Glaze pigments scatter a little (slight milkiness of thick washes). */
export const GLAZE_SCATTER = 0.08;
/** Amount of a glaze pigment at which it shows its nominal colour over white. */
export const GLAZE_REF = 0.5;
/** Floor of a glaze's reference transmittance (keeps K finite). */
const GLAZE_MIN_T = 0.015;

export type PigmentKind = "body" | "glaze";

export interface Pigment {
  /** Absorption optical depth per amount unit, per band group. */
  k: Float32Array;
  /** Scattering optical depth per amount unit. */
  s: number;
}

const GROUP_SIZE = (() => {
  const n = new Array<number>(GROUPS).fill(0);
  for (const g of GROUP_OF) n[g]!++;
  return n;
})();

const uncompand = (x: number) => (x > 0.04045 ? ((x + 0.055) / 1.055) ** 2.4 : x / 12.92);
const compand = (x: number) => (x > 0.0031308 ? 1.055 * x ** (1 / 2.4) - 0.055 : x * 12.92);

/** Linear sRGB → reflectance spectrum (spectral.js lift, floored at R_MIN). */
export function reflectance(lr: number, lg: number, lb: number): Float64Array {
  const w = Math.min(lr, lg, lb);
  const r1 = lr - w;
  const g1 = lg - w;
  const b1 = lb - w;
  const c = Math.min(g1, b1);
  const m = Math.min(r1, b1);
  const y = Math.min(r1, g1);
  const r = Math.max(0, Math.min(r1 - b1, r1 - g1));
  const g = Math.max(0, Math.min(g1 - b1, g1 - r1));
  const b = Math.max(0, Math.min(b1 - g1, b1 - r1));
  const weights = [w, c, m, y, r, g, b];
  const R = new Float64Array(BANDS);
  for (let i = 0; i < BANDS; i++) {
    let v = 0;
    for (let k = 0; k < 7; k++) v += weights[k]! * BASE_SPECTRA[k]![i]!;
    R[i] = Math.max(R_MIN, v);
  }
  return R;
}

export function hexToSpectrum(hex: string): Float64Array {
  const n = Number.parseInt(hex.slice(1, 7), 16) || 0;
  return reflectance(uncompand(((n >> 16) & 255) / 255), uncompand(((n >> 8) & 255) / 255), uncompand((n & 255) / 255));
}

const luminanceOf = (R: ArrayLike<number>) => {
  let Y = 0;
  for (let i = 0; i < BANDS; i++) Y += R[i]! * CMF[1]![i]!;
  return Math.max(Y_MIN, Y);
};

/** Group-averaged K/S (body) of a reflectance spectrum. */
export function groupKS(R: ArrayLike<number>): Float64Array {
  const out = new Float64Array(GROUPS);
  for (let i = 0; i < BANDS; i++) {
    const r = R[i]!;
    out[GROUP_OF[i]!]! += (1 - r) ** 2 / (2 * r) / GROUP_SIZE[GROUP_OF[i]!]!;
  }
  return out;
}

const cache = new Map<string, Pigment>();

/** The pigment of a `#rrggbb` colour in a medium (cached). `scatter` is the medium's scattering. */
export function pigmentOf(hex: string, kind: PigmentKind, scatter: number): Pigment {
  const key = `${hex}:${kind}:${scatter}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const R = hexToSpectrum(hex);
  const k = new Float32Array(GROUPS);
  let s: number;
  if (kind === "body") {
    s = scatter * BODY_SCATTER * luminanceOf(R);
    const ks = groupKS(R);
    for (let g = 0; g < GROUPS; g++) k[g] = s * ks[g]!;
  } else {
    s = scatter * GLAZE_SCATTER;
    const mean = new Float64Array(GROUPS);
    for (let i = 0; i < BANDS; i++) mean[GROUP_OF[i]!]! += R[i]! / GROUP_SIZE[GROUP_OF[i]!]!;
    // A reference wash, passed twice (down to the ground and back), transmits the colour.
    for (let g = 0; g < GROUPS; g++) k[g] = -Math.log(Math.max(GLAZE_MIN_T, Math.min(1, mean[g]!))) / (2 * GLAZE_REF);
  }
  const p = { k, s };
  if (cache.size > 512) cache.clear();
  cache.set(key, p);
  return p;
}

/** Reflectance of an infinitely thick layer for K/S (masstone). */
export const kmInfinite = (ks: number): number => 1 + ks - Math.sqrt(ks * ks + 2 * ks);

/**
 * Kubelka–Munk reflectance and transmittance of a layer with absorption depth
 * `kx` and scattering depth `sx`. Writes [R, T] into `out`.
 */
export function kmLayer(kx: number, sx: number, out: [number, number] | Float64Array): void {
  if (sx < 1e-6) {
    out[0] = 0;
    out[1] = Math.exp(-kx);
    return;
  }
  const ks = kx / sx;
  const a = 1 + ks;
  const b = Math.sqrt(ks * ks + 2 * ks);
  if (b < 1e-6) {
    out[0] = sx / (sx + 1);
    out[1] = 1 / (sx + 1);
    return;
  }
  const x = b * sx;
  const om = -Math.expm1(-2 * x);
  const denom = a * om + b * (2 - om);
  out[0] = om / denom;
  out[1] = (2 * b * Math.exp(-x)) / denom;
}

/** Linear RGB = SPECTRAL_RGB · band-group spectrum (D65 white → 1, 1, 1). */
export const SPECTRAL_RGB: readonly (readonly number[])[] = [0, 1, 2].map((k) =>
  Array.from({ length: GROUPS }, (_, g) => [0, 1, 2].reduce((s, j) => s + XYZ_RGB[k]![j]! * CMF_G[j]![g]!, 0)),
);

export function groupsToLinear(spec: ArrayLike<number>, out: number[] = [0, 0, 0]): number[] {
  for (let k = 0; k < 3; k++) {
    let v = 0;
    for (let g = 0; g < GROUPS; g++) v += SPECTRAL_RGB[k]![g]! * spec[g]!;
    out[k] = v;
  }
  return out;
}

export const toByte = (linear: number): number => Math.round(compand(Math.min(1, Math.max(0, linear))) * 255);

const hexOf = (rgb: number[]) =>
  `#${((1 << 24) | (toByte(rgb[0]!) << 16) | (toByte(rgb[1]!) << 8) | toByte(rgb[2]!)).toString(16).slice(1)}`;

/**
 * Colour of a layer over a white ground: R + T² / (1 − R) (KM over a
 * reflecting substrate). Used for previews and tests.
 */
export function layerOverWhite(kx: ArrayLike<number>, sx: number): string {
  const spec = new Float64Array(GROUPS);
  const rt = new Float64Array(2);
  for (let g = 0; g < GROUPS; g++) {
    kmLayer(kx[g]!, sx, rt);
    spec[g] = rt[0]! + (rt[1]! * rt[1]!) / Math.max(1e-6, 1 - rt[0]!);
  }
  return hexOf(groupsToLinear(spec));
}

/** Mix colours in the given amounts as one medium; returns the layer colour over white. */
export function mixHex(colors: readonly string[], amounts: readonly number[], kind: PigmentKind, scatter = 1): string {
  const kx = new Float64Array(GROUPS);
  let sx = 0;
  colors.forEach((c, i) => {
    const p = pigmentOf(c, kind, scatter);
    const a = amounts[i] ?? 0;
    for (let g = 0; g < GROUPS; g++) kx[g]! += a * p.k[g]!;
    sx += a * p.s;
  });
  return layerOverWhite(kx, sx);
}
