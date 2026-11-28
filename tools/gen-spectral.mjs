#!/usr/bin/env node
/**
 * Generates `src/media/spectral-tables.ts` from spectral.js (MIT, Ronald van Wijnen).
 *
 * The wet-media simulation stores, per cell, a mass-weighted Kubelka–Munk
 * absorption/scattering spectrum `Q(λ) = Σ aᵢ·Yᵢ·KSᵢ(λ)` together with
 * `W = Σ aᵢ·Yᵢ`, which is exactly spectral.js's mixing rule
 * (`KS_mix = Σ cᵢ·KSᵢ / Σ cᵢ`, `cᵢ = factor² · luminance`). Every transport,
 * deposit and pickup is linear in those quantities, so mixing stays physical.
 *
 * To fit Q into a few texture channels the 38 bands are averaged into 8
 * groups of equal colour-matching weight (a PCA basis of the same size was
 * tried and was about 4× less accurate). The script reports the colour error
 * against `spectral.mix()` and fails when it exceeds the accepted bounds.
 *
 * Only public spectral.js API is used: tables are recovered from `Color`
 * instances (base spectra from primaries, CIE CMFs from impulse spectra).
 *
 *   node tools/gen-spectral.mjs          write the table
 *   node tools/gen-spectral.mjs --check  only report the error
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const spectral = require("spectral.js");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "media", "spectral-tables.ts");
const GROUPS = 8;
/** Reflectance floor: keeps K/S finite (≈ 5000) so half floats can hold it. */
const R_MIN = 1e-4;
const Y_MIN = 1e-4;

const SIZE = 38;
const { Color } = spectral;

// --- Recover tables through the public API --------------------------------
const lin = (v) => v; // Color accepts sRGB 0..255 arrays; lRGB primaries map exactly at 0/255.
const prim = (r, g, b) => new Color([r * 255, g * 255, b * 255].map(lin)).R;
const BASE = {
  W: prim(1, 1, 1),
  C: prim(0, 1, 1),
  M: prim(1, 0, 1),
  Y: prim(1, 1, 0),
  R: prim(1, 0, 0),
  G: prim(0, 1, 0),
  B: prim(0, 0, 1),
};
const CMF = [[], [], []];
for (let i = 0; i < SIZE; i++) {
  const imp = new Array(SIZE).fill(0);
  imp[i] = 1;
  const xyz = new Color(imp).XYZ;
  for (let k = 0; k < 3; k++) CMF[k][i] = xyz[k];
}
// XYZ → linear RGB: solve from three colours with known lRGB.
function solve3(A, B) {
  // Solve M·A = B for M (3×3), A/B column-major lists of vectors.
  const a = [
    [A[0][0], A[1][0], A[2][0]],
    [A[0][1], A[1][1], A[2][1]],
    [A[0][2], A[1][2], A[2][2]],
  ];
  const det =
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const inv = [
    [
      (a[1][1] * a[2][2] - a[1][2] * a[2][1]) / det,
      (a[0][2] * a[2][1] - a[0][1] * a[2][2]) / det,
      (a[0][1] * a[1][2] - a[0][2] * a[1][1]) / det,
    ],
    [
      (a[1][2] * a[2][0] - a[1][0] * a[2][2]) / det,
      (a[0][0] * a[2][2] - a[0][2] * a[2][0]) / det,
      (a[0][2] * a[1][0] - a[0][0] * a[1][2]) / det,
    ],
    [
      (a[1][0] * a[2][1] - a[1][1] * a[2][0]) / det,
      (a[0][1] * a[2][0] - a[0][0] * a[2][1]) / det,
      (a[0][0] * a[1][1] - a[0][1] * a[1][0]) / det,
    ],
  ];
  const b = [
    [B[0][0], B[1][0], B[2][0]],
    [B[0][1], B[1][1], B[2][1]],
    [B[0][2], B[1][2], B[2][2]],
  ];
  return b.map((row) => [0, 1, 2].map((j) => row[0] * inv[0][j] + row[1] * inv[1][j] + row[2] * inv[2][j]));
}
const probe = [BASE.R, BASE.G, BASE.B].map((R) => new Color(R));
const XYZ_RGB = solve3(
  probe.map((c) => c.XYZ),
  probe.map((c) => c.lRGB),
);

// --- Helpers --------------------------------------------------------------
const uncompand = (x) => (x > 0.04045 ? ((x + 0.055) / 1.055) ** 2.4 : x / 12.92);
const compand = (x) => (x > 0.0031308 ? 1.055 * x ** (1 / 2.4) - 0.055 : x * 12.92);
function reflectance(lrgb) {
  const [r0, g0, b0] = lrgb;
  const w = Math.min(r0, g0, b0);
  const r1 = r0 - w;
  const g1 = g0 - w;
  const b1 = b0 - w;
  const c = Math.min(g1, b1);
  const m = Math.min(r1, b1);
  const y = Math.min(r1, g1);
  const r = Math.max(0, Math.min(r1 - b1, r1 - g1));
  const g = Math.max(0, Math.min(g1 - b1, g1 - r1));
  const b = Math.max(0, Math.min(b1 - g1, b1 - r1));
  const R = new Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    R[i] = Math.max(
      R_MIN,
      w * BASE.W[i] + c * BASE.C[i] + m * BASE.M[i] + y * BASE.Y[i] + r * BASE.R[i] + g * BASE.G[i] + b * BASE.B[i],
    );
  }
  return R;
}
const ksOf = (R) => (1 - R) ** 2 / (2 * R);
const kmOf = (ks) => 1 + ks - Math.sqrt(ks * ks + 2 * ks);
const lumOf = (R) =>
  Math.max(
    Y_MIN,
    R.reduce((s, v, i) => s + v * CMF[1][i], 0),
  );
function xyzToOklab(xyz) {
  const M1 = [
    [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
    [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
    [0.0481771893596242, 0.2642395317527308, 0.6335478284694309],
  ];
  const M2 = [
    [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
    [1.9779985324311684, -2.4285922420485799, 0.450593709617411],
    [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
  ];
  const lms = M1.map((r) => Math.cbrt(Math.max(0, r[0] * xyz[0] + r[1] * xyz[1] + r[2] * xyz[2])));
  return M2.map((r) => r[0] * lms[0] + r[1] * lms[1] + r[2] * lms[2]);
}
const xyzOf = (R) => CMF.map((row) => row.reduce((s, v, i) => s + v * R[i], 0));
const dE = (R1, R2) => {
  const a = xyzToOklab(xyzOf(R1));
  const b = xyzToOklab(xyzOf(R2));
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};

let seed = 12345;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

// --- Band groups ---------------------------------------------------------
// Bands are grouped so that every group carries the same share of the colour
// matching functions' mass; Q is averaged inside a group. Mixing is exact per
// group (it is linear); the error comes only from evaluating KM per group.
const mass = CMF[0].map((_, i) => CMF[0][i] + CMF[1][i] + CMF[2][i]);
const total = mass.reduce((a, b) => a + b, 0);
const GROUP_OF = new Array(SIZE);
{
  let acc = 0;
  for (let i = 0; i < SIZE; i++) {
    acc += mass[i];
    GROUP_OF[i] = Math.min(GROUPS - 1, Math.floor(((acc - mass[i] / 2) / total) * GROUPS));
  }
}
const groupSize = new Array(GROUPS).fill(0);
for (const g of GROUP_OF) groupSize[g]++;
const CMF_G = CMF.map((row) => {
  const out = new Array(GROUPS).fill(0);
  row.forEach((v, i) => (out[GROUP_OF[i]] += v));
  return out;
});
const groupQ = (q) => {
  const out = new Array(GROUPS).fill(0);
  q.forEach((v, i) => (out[GROUP_OF[i]] += v / groupSize[GROUP_OF[i]]));
  return out;
};
const expand = (g) => GROUP_OF.map((k) => g[k]);

// --- Error against spectral.js mix() ---------------------------------------
const errs = [];
const solidErrs = [];
for (let n = 0; n < 4000; n++) {
  const sa = [rand(), rand(), rand()].map((v) => Math.round(v * 255));
  const sb = [rand(), rand(), rand()].map((v) => Math.round(v * 255));
  const t = rand();
  const ref = spectral.mix([new Color(sa), 1 - t], [new Color(sb), t]).R;
  const Ra = reflectance(sa.map((x) => uncompand(x / 255)));
  const Rb = reflectance(sb.map((x) => uncompand(x / 255)));
  const Ya = lumOf(Ra);
  const Yb = lumOf(Rb);
  const wa = (1 - t) ** 2;
  const wb = t ** 2;
  const qa = groupQ(Ra.map((r) => Ya * ksOf(r)));
  const qb = groupQ(Rb.map((r) => Yb * ksOf(r)));
  const W = wa * Ya + wb * Yb;
  const R = expand(qa.map((v, k) => kmOf((wa * v + wb * qb[k]) / W)));
  errs.push(dE(ref, R));
  solidErrs.push(dE(Ra, expand(qa.map((v) => kmOf(v / Ya)))));
}
errs.sort((x, y) => x - y);
solidErrs.sort((x, y) => x - y);
const stat = (e) => ({
  mean: e.reduce((s, v) => s + v, 0) / e.length,
  p99: e[Math.floor(e.length * 0.99)],
  max: e[e.length - 1],
});
const mixStat = stat(errs);
const solidStat = stat(solidErrs);
const show = (n, st) =>
  console.log(
    `[spectral] ${GROUPS} groups ${n} ΔE_OK mean ${st.mean.toFixed(4)} p99 ${st.p99.toFixed(4)} max ${st.max.toFixed(4)}`,
  );
show("mix  ", mixStat);
show("solid", solidStat);
const ok = mixStat.mean < 0.01 && mixStat.p99 < 0.03;
if (!ok) {
  console.error("[spectral] error above bounds (mean < 0.01, p99 < 0.03)");
  process.exitCode = 1;
}

if (!process.argv.includes("--check") && ok) {
  const fmt = (arr) => arr.map((v) => Number(v.toPrecision(9))).join(", ");
  const rows = (m) => m.map((r) => `  [${fmt(r)}],`).join("\n");
  const src = `// GENERATED by tools/gen-spectral.mjs from spectral.js (MIT, © Ronald van Wijnen). Do not edit.
// Mix error vs spectral.mix(): ΔE_OK mean ${mixStat.mean.toFixed(4)}, p99 ${mixStat.p99.toFixed(4)}, max ${mixStat.max.toFixed(4)}.

/** Spectral bands of spectral.js (380–750 nm, 10 nm). */
export const BANDS = ${SIZE};
/** Band groups stored per cell. */
export const GROUPS = ${GROUPS};
/** Group index of every band. */
export const GROUP_OF: readonly number[] = [${GROUP_OF.join(", ")}];
/** Reflectance floor and luminance floor of the pigment model. */
export const R_MIN = ${R_MIN};
export const Y_MIN = ${Y_MIN};

/** Reflectance spectra of the seven primaries lifting linear RGB to a spectrum (W, C, M, Y, R, G, B). */
export const BASE_SPECTRA: readonly (readonly number[])[] = [
${rows([BASE.W, BASE.C, BASE.M, BASE.Y, BASE.R, BASE.G, BASE.B])}
];

/** CIE 1931 2° colour matching functions under D65 (rows X, Y, Z; Y of a perfect white = 1). */
export const CMF: readonly (readonly number[])[] = [
${rows(CMF)}
];

/** Colour matching functions summed per band group (rows X, Y, Z). */
export const CMF_G: readonly (readonly number[])[] = [
${rows(CMF_G)}
];

/** XYZ → linear sRGB. */
export const XYZ_RGB: readonly (readonly number[])[] = [
${rows(XYZ_RGB)}
];
`;
  writeFileSync(OUT, src);
  console.log(`[spectral] wrote ${OUT}`);
}
