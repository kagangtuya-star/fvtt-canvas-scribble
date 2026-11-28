import {
  BANDS,
  DAB_FLOATS,
  DabWalker,
  GATHER_BAND,
  GATHER_FLOATS,
  GATHER_SAMPLES,
  MAX_DABS_PER_BATCH,
  Reservoir,
} from "../dabs.ts";
import { DAB, dabIncludesChunk, gatherOffset } from "../dabs.ts";
import { MEDIA_BRUSHES } from "../brushes.ts";
import { toHalf } from "../half.ts";
import { CHUNK, CHUNK_CELLS, DRY_EPS, EMPTY_EPS, GPU_WET_CHUNKS, PIG, PIG_CHANNELS } from "../layout.ts";
import { paperTile } from "../paper.ts";
import type { PaperId } from "../brushes.ts";
import type { PaperTile } from "../paper.ts";
import { SPECTRAL_RGB } from "../pigment.ts";
import { GROUPS } from "../spectral-tables.ts";
import type { ChunkSnapshot, SimBackend } from "./backend.ts";
import { CpuBackend, chunkPaper } from "./cpu.ts";
import { PHYS } from "./physics.ts";

/**
 * WebGL2 backend: the same model as `cpu.ts`, as fragment-shader passes.
 *
 * Wet (awake) chunks live in slots of an atlas of RGBA32F textures:
 *
 *   W      (w, s, m, edge)            water, capillary saturation, oil, wet-edge factor
 *   F      (left, right, up, down)    virtual-pipe outflows
 *   P0..2  suspended pigment          (K0..3) (K4..7) (S, A, G, F)
 *   D0..2  deposited pigment          same layout
 *   CAP    capillary carry fractions  per outflow direction
 *   PAPER  (relief, absorbency, kR, kD)
 *
 * Neighbour cells across chunk borders are found through a slot table; a
 * missing or dormant neighbour is a wall, exactly as on the CPU. Dry chunks
 * leave the GPU: their deposits are kept (and displayed) by an internal
 * CpuBackend, which also handles bakes.
 *
 * Every pass mirrors a CPU pass; `gpuSelfTest` runs both on the same input
 * and the GPU is only used when they agree on this device.
 */

const N = CHUNK;
const NN = CHUNK_CELLS;
const C = PIG_CHANNELS;
/** Atlas side in slots: 2×2 (≈19 MB of float textures) growing to 6×6 (≈170 MB). */
const START_SIDE = 2;
const MAX_SIDE = 6;
const MAX_SLOTS = GPU_WET_CHUNKS;
const DAB_TEXELS = DAB_FLOATS / 4;

const f = (v: number) => {
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
};

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
const int N = ${N};
const float DRY_EPS = ${f(DRY_EPS)};
const float EMPTY_EPS = ${f(EMPTY_EPS)};
uniform int uS;
uniform ivec4 uNbr[${MAX_SLOTS}];
uniform int uUsed[${MAX_SLOTS}];
uniform ivec2 uChunk[${MAX_SLOTS}];
int slotAt(ivec2 p) { return (p.y / N) * uS + p.x / N; }
ivec2 slotBase(int s) { return ivec2((s % uS) * N, (s / uS) * N); }
bool nbr(int s, ivec2 l, int d, out ivec2 t) {
  ivec2 q = l;
  int o = s;
  if (d == 0) { q.x -= 1; if (q.x < 0) { o = uNbr[s].x; q.x += N; } }
  else if (d == 1) { q.x += 1; if (q.x >= N) { o = uNbr[s].y; q.x -= N; } }
  else if (d == 2) { q.y -= 1; if (q.y < 0) { o = uNbr[s].z; q.y += N; } }
  else { q.y += 1; if (q.y >= N) { o = uNbr[s].w; q.y -= N; } }
  if (o < 0) { t = ivec2(0); return false; }
  t = slotBase(o) + q;
  return true;
}
#define AT(tex, p) texelFetch(tex, p, 0)
`;

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Pass A: virtual-pipe outflows. */
const FLUX = `${HEADER}
uniform sampler2D uW, uF, uP2, uPaper;
uniform float uRelief;
out vec4 oF;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int s = slotAt(p);
  if (uUsed[s] == 0) { oF = AT(uF, p); return; }
  ivec2 l = p - slotBase(s);
  float wi = AT(uW, p).x;
  if (wi <= DRY_EPS) { oF = vec4(0.0); return; }
  float Hi = wi + uRelief * AT(uPaper, p).x;
  float mob = 1.0 / (1.0 + (${f(PHYS.viscosity)} * AT(uP2, p).y) / (wi + 1e-3));
  vec4 fo = AT(uF, p);
  vec4 o = vec4(0.0);
  for (int d = 0; d < 4; d++) {
    ivec2 t;
    if (!nbr(s, l, d, t)) continue;
    float wj = AT(uW, t).x;
    float dH = Hi - (wj + uRelief * AT(uPaper, t).x);
    if (wj <= DRY_EPS) dH -= ${f(PHYS.tension)};
    o[d] = max(0.0, fo[d] * ${f(PHYS.flowDamping)} + ${f(PHYS.flowGain)} * dH) * mob;
  }
  float sum = o.x + o.y + o.z + o.w;
  if (sum > wi) o *= wi / sum;
  oF = o;
}`;

/** Pass B: water and suspended pigment move with the outflows. */
const TRANSPORT = `${HEADER}
uniform sampler2D uW, uF, uP0, uP1, uP2;
layout(location = 0) out vec4 oW;
layout(location = 1) out vec4 oP0;
layout(location = 2) out vec4 oP1;
layout(location = 3) out vec4 oP2;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int s = slotAt(p);
  vec4 W = AT(uW, p);
  if (uUsed[s] == 0) { oW = W; oP0 = AT(uP0, p); oP1 = AT(uP1, p); oP2 = AT(uP2, p); return; }
  ivec2 l = p - slotBase(s);
  float wi = W.x;
  vec4 fo = AT(uF, p);
  float outflow = fo.x + fo.y + fo.z + fo.w;
  float keep = wi > DRY_EPS ? 1.0 - outflow / wi : 1.0;
  float water = wi - outflow;
  vec4 a0 = AT(uP0, p) * keep;
  vec4 a1 = AT(uP1, p) * keep;
  vec4 a2 = AT(uP2, p) * keep;
  for (int d = 0; d < 4; d++) {
    ivec2 t;
    if (!nbr(s, l, d, t)) continue;
    float inflow = AT(uF, t)[d ^ 1];
    if (inflow <= 0.0) continue;
    water += inflow;
    float wj = AT(uW, t).x;
    vec4 q2 = AT(uP2, t);
    if (wj <= DRY_EPS || q2.y <= 0.0) continue;
    float fr = inflow / wj;
    a0 += AT(uP0, t) * fr;
    a1 += AT(uP1, t) * fr;
    a2 += q2 * fr;
  }
  oW = vec4(max(0.0, water), W.yzw);
  oP0 = a0; oP1 = a1; oP2 = a2;
}`;

/** Pass C, outflow half: saturation diffuses; capped carry fractions per direction. */
const CAP_OUT = `${HEADER}
uniform sampler2D uW, uPaper;
uniform float uCarry;
layout(location = 0) out vec4 oW;
layout(location = 1) out vec4 oCap;
float cond(ivec2 p, ivec2 t, int d) {
  if (d == 0) return AT(uPaper, t).z;
  if (d == 1) return AT(uPaper, p).z;
  if (d == 2) return AT(uPaper, t).w;
  return AT(uPaper, p).w;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int s = slotAt(p);
  vec4 W = AT(uW, p);
  if (uUsed[s] == 0) { oW = W; oCap = vec4(0.0); return; }
  ivec2 l = p - slotBase(s);
  float si = W.y;
  float wi = W.x;
  float sNew = si;
  float dryNb = 0.0;
  float leave = 0.0;
  vec4 cap = vec4(0.0);
  for (int d = 0; d < 4; d++) {
    ivec2 t;
    if (!nbr(s, l, d, t)) continue;
    vec4 Wj = AT(uW, t);
    float sj = Wj.y;
    if (Wj.x <= DRY_EPS) dryNb += 1.0;
    if (max(si, sj) <= ${f(PHYS.capillaryMin)}) continue;
    float phi = cond(p, t, d) * (si - sj);
    sNew -= phi;
    if (phi > 0.0) {
      float fr = (uCarry * phi) / (si + wi + 1e-4);
      cap[d] = fr;
      leave += fr;
    }
  }
  float scale = leave > ${f(PHYS.carryMax)} ? ${f(PHYS.carryMax)} / leave : 1.0;
  oW = vec4(W.x, clamp(sNew, 0.0, 1.0), W.z, wi > DRY_EPS ? dryNb / 4.0 : 0.0);
  oCap = cap * scale;
}`;

/** Pass C, inflow half: keep the own share, add what wetter neighbours carry here. */
const CAP_IN = `${HEADER}
uniform sampler2D uW, uP0, uP1, uP2, uCap;
layout(location = 0) out vec4 oP0;
layout(location = 1) out vec4 oP1;
layout(location = 2) out vec4 oP2;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int s = slotAt(p);
  if (uUsed[s] == 0) { oP0 = AT(uP0, p); oP1 = AT(uP1, p); oP2 = AT(uP2, p); return; }
  ivec2 l = p - slotBase(s);
  float si = AT(uW, p).y;
  vec4 own = AT(uCap, p);
  float keep = 1.0 - (own.x + own.y + own.z + own.w);
  vec4 a0 = AT(uP0, p) * keep;
  vec4 a1 = AT(uP1, p) * keep;
  vec4 a2 = AT(uP2, p) * keep;
  for (int d = 0; d < 4; d++) {
    ivec2 t;
    if (!nbr(s, l, d, t)) continue;
    float sj = AT(uW, t).y;
    if (max(si, sj) <= ${f(PHYS.capillaryMin)} || sj <= si) continue;
    float fr = AT(uCap, t)[d ^ 1];
    vec4 q2 = AT(uP2, t);
    if (fr <= 0.0 || q2.y <= 0.0) continue;
    a0 += AT(uP0, t) * fr;
    a1 += AT(uP1, t) * fr;
    a2 += q2 * fr;
  }
  oP0 = a0; oP1 = a1; oP2 = a2;
}`;

/** Pass D: absorption, evaporation, settling, re-wetting. */
const LOCAL = `${HEADER}
uniform sampler2D uW, uP0, uP1, uP2, uD0, uD1, uD2, uPaper;
uniform float uAbsorb, uCapacity, uTooth, uDry, uDryOil, uDamp;
layout(location = 0) out vec4 oW;
layout(location = 1) out vec4 oP0;
layout(location = 2) out vec4 oP1;
layout(location = 3) out vec4 oP2;
layout(location = 4) out vec4 oD0;
layout(location = 5) out vec4 oD1;
layout(location = 6) out vec4 oD2;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int s = slotAt(p);
  vec4 W = AT(uW, p);
  vec4 P0 = AT(uP0, p), P1 = AT(uP1, p), P2 = AT(uP2, p);
  vec4 D0 = AT(uD0, p), D1 = AT(uD1, p), D2 = AT(uD2, p);
  if (uUsed[s] == 0) { oW = W; oP0 = P0; oP1 = P1; oP2 = P2; oD0 = D0; oD1 = D1; oD2 = D2; return; }
  vec4 paper = AT(uPaper, p);
  float wi = W.x, si = W.y, mi = W.z, edge = W.w;
  if (wi > 0.0 && si < 1.0) {
    float da = min(wi, uAbsorb * paper.y * (1.0 - si));
    wi -= da;
    si = min(1.0, si + da / uCapacity);
  }
  if (wi > 0.0) wi = max(0.0, wi - ${f(PHYS.evaporate)} * uDry * (1.0 + ${f(PHYS.edgeBoost)} * edge));
  if (si > 0.0) si = max(0.0, si - ${f(PHYS.evaporateCapillary)} * uDry * (wi > DRY_EPS ? 0.3 : 1.0));
  if (mi > 0.0) mi = max(0.0, mi - ${f(PHYS.evaporateOil)} * uDryOil);
  if (wi < DRY_EPS) wi = 0.0;
  if (si < DRY_EPS) si = 0.0;
  if (mi < DRY_EPS) mi = 0.0;
  float A = P2.y;
  if (A > EMPTY_EPS) {
    float mob = max(max(min(1.0, wi / 0.03), mi), min(1.0, si * uDamp));
    float gran = min(1.0, P2.z / A);
    float rate = min(1.0, ${f(PHYS.settle)} * (1.0 + uTooth * gran * (1.0 - paper.x) * 2.0) + (1.0 - mob) * ${f(PHYS.settleDry)});
    D0 += P0 * rate; P0 -= P0 * rate;
    D1 += P1 * rate; P1 -= P1 * rate;
    D2 += P2 * rate; P2 -= P2 * rate;
  } else if (A != 0.0) {
    P0 = vec4(0.0); P1 = vec4(0.0); P2 = vec4(0.0);
  }
  if (wi > 0.01) {
    float Ad = D2.y;
    if (Ad > EMPTY_EPS) {
      float fr = ${f(PHYS.rewetLift)} * min(1.0, wi / 0.1) * max(0.0, 1.0 - D2.w / Ad);
      P0 += D0 * fr; D0 -= D0 * fr;
      P1 += D1 * fr; D1 -= D1 * fr;
      P2 += D2 * fr; D2 -= D2 * fr;
    }
  }
  oW = vec4(wi, si, mi, edge);
  oP0 = P0; oP1 = P1; oP2 = P2; oD0 = D0; oD1 = D1; oD2 = D2;
}`;

/** Brush contact, mirrored from dabs.ts. */
const CONTACT = `
uniform sampler2D uDabs;
vec4 dab(int k, int t) { return texelFetch(uDabs, ivec2(t, k), 0); }
float hash01(uint seed, uint i) {
  uint h = seed ^ (i * 0x9e3779b1u);
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return float(h >> 8u) / 16777216.0;
}
float contact(int k, float dx, float dy, float h, out int band) {
  vec4 h0 = dab(k, 0);
  vec4 h1 = dab(k, 1);
  vec4 h2 = dab(k, 2);
  vec4 h3 = dab(k, 3);
  band = 0;
  float r = h0.z;
  float u = dx * h0.w + dy * h1.x;
  float v = -dx * h1.x + dy * h0.w;
  float dist = sqrt(u * u + v * v) / r;
  if (dist >= 1.0) return 0.0;
  float shape = min(1.0, (1.0 - dist) / max(0.05, h2.z));
  float across = min(0.999999, max(0.0, (v / r + 1.0) * 0.5));
  int b = int(floor(across * ${f(BANDS)}));
  band = b;
  vec4 bb = dab(k, 4 + b * 4 + 3);
  uint seed = uint(int(h3.x));
  float streak = 1.0 - h2.w * 0.6 * hash01(seed, uint(int(floor(across * 24.0))));
  float t = bb.y;
  float dry = t <= 0.0 ? 1.0 : smoothstep(t - 0.12, t + 0.12, h);
  return shape * streak * bb.z * dry * h1.y;
}`;

/** Dab application: every cell applies the batch's dabs in order (each dab only touches its own cells). */
const APPLY = `${HEADER}${CONTACT}
uniform sampler2D uW, uP0, uP1, uP2, uD0, uD1, uD2, uPaper;
uniform int uCount;
layout(location = 0) out vec4 oW;
layout(location = 1) out vec4 oP0;
layout(location = 2) out vec4 oP1;
layout(location = 3) out vec4 oP2;
layout(location = 4) out vec4 oD0;
layout(location = 5) out vec4 oD1;
layout(location = 6) out vec4 oD2;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int s = slotAt(p);
  vec4 W = AT(uW, p);
  vec4 P0 = AT(uP0, p), P1 = AT(uP1, p), P2 = AT(uP2, p);
  vec4 D0 = AT(uD0, p), D1 = AT(uD1, p), D2 = AT(uD2, p);
  if (uUsed[s] != 0) {
    ivec2 l = p - slotBase(s);
    vec2 g = vec2(uChunk[s] * N + l) + 0.5;
    float h = AT(uPaper, p).x;
    for (int k = 0; k < ${MAX_DABS_PER_BATCH}; k++) {
      if (k >= uCount) break;
      vec4 h0 = dab(k, 0);
      if (abs(g.x - h0.x) > h0.z + 1.0 || abs(g.y - h0.y) > h0.z + 1.0) continue;
      ivec2 mask = ivec2(dab(k, 3).yz);
      if (mask.x != 0 || mask.y != 0) {
        ivec2 q = uChunk[s] - ivec2(floor(h0.xy / float(N))) + 2;
        if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, ivec2(5)))) continue;
        int bit = q.y * 5 + q.x;
        if (((bit < 15 ? mask.x : mask.y) & (1 << (bit % 15))) == 0) continue;
      }
      int b;
      float c = contact(k, g.x - h0.x, g.y - h0.y, h, b);
      if (c <= 0.0) continue;
      vec4 h1 = dab(k, 1);
      vec4 h2 = dab(k, 2);
      int bo = 4 + b * 4;
      float keep = 1.0 - h1.z * c;
      P0 = P0 * keep + dab(k, bo) * c;
      P1 = P1 * keep + dab(k, bo + 1) * c;
      P2 = P2 * keep + dab(k, bo + 2) * c;
      vec4 bb = dab(k, bo + 3);
      W.x = W.x * (1.0 - h1.w * c) + bb.x * c;
      if (h2.x > 0.0) {
        float A = D2.y;
        if (A > EMPTY_EPS) {
          float fr = h2.x * c * max(0.0, 1.0 - D2.w / A);
          P0 += D0 * fr; D0 -= D0 * fr;
          P1 += D1 * fr; D1 -= D1 * fr;
          P2 += D2 * fr; D2 -= D2 * fr;
        }
      }
      if (h2.y > 0.0) W.z = max(W.z, h2.y * c);
    }
  }
  oW = W; oP0 = P0; oP1 = P1; oP2 = P2; oD0 = D0; oD1 = D1; oD2 = D2;
}`;

/** Gather: one texel per (band, dab): mean contact and contact-weighted wet paint under the band. */
const GATHER = `${HEADER}${CONTACT}
uniform sampler2D uW, uP0, uP1, uP2, uPaper, uSamples;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  int b = q.x;
  int k = q.y;
  float csum = 0.0;
  vec4 a0 = vec4(0.0), a1 = vec4(0.0), a2 = vec4(0.0);
  float aw = 0.0;
  for (int n = 0; n < ${GATHER_SAMPLES}; n++) {
    vec4 sm = texelFetch(uSamples, ivec2(b * ${GATHER_SAMPLES} + n, k), 0);
    if (sm.x < 0.0) continue;
    ivec2 t = ivec2(sm.xy);
    int band;
    float c = contact(k, sm.z, sm.w, AT(uPaper, t).x, band);
    if (c <= 0.0) continue;
    csum += c;
    a0 += c * AT(uP0, t);
    a1 += c * AT(uP1, t);
    a2 += c * AT(uP2, t);
    aw += c * AT(uW, t).x;
  }
  if (csum > 0.0) { a0 /= csum; a1 /= csum; a2 /= csum; aw /= csum; }
  o0 = vec4(csum / ${f(GATHER_SAMPLES)}, a0.xyz);
  o1 = vec4(a0.w, a1.xyz);
  o2 = vec4(a1.w, a2.xyz);
  o3 = vec4(a2.w, aw, 0.0, 0.0);
}`;

/** Display: Kubelka–Munk layer reflectance (top half) and transmittance² (bottom half), sRGB. */
const DISPLAY = `${HEADER}
uniform sampler2D uW, uP0, uP1, uP2, uD0, uD1, uD2, uPaper;
uniform ivec2 uBase;
uniform float uM0[${GROUPS}], uM1[${GROUPS}], uM2[${GROUPS}];
out vec4 oC;
float srgb(float x) {
  x = clamp(x, 0.0, 1.0);
  return x > 0.0031308 ? 1.055 * pow(x, 1.0 / 2.4) - 0.055 : x * 12.92;
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  bool top = q.y < N;
  ivec2 t = uBase + ivec2(q.x, top ? q.y : q.y - N);
  vec4 K0 = AT(uD0, t) + AT(uP0, t);
  vec4 K1 = AT(uD1, t) + AT(uP1, t);
  vec4 K2 = AT(uD2, t) + AT(uP2, t);
  float A = K2.y;
  float sx = K2.x;
  if (A <= EMPTY_EPS) { oC = top ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(1.0); return; }
  float kxs[${GROUPS}] = float[](K0.x, K0.y, K0.z, K0.w, K1.x, K1.y, K1.z, K1.w);
  vec3 R = vec3(0.0);
  vec3 T = vec3(0.0);
  for (int g = 0; g < ${GROUPS}; g++) {
    float kx = max(0.0, kxs[g]);
    float spec;
    float trans;
    if (sx < 1e-6) {
      spec = 0.0;
      trans = exp(-kx);
    } else {
      float ks = kx / sx;
      float a = 1.0 + ks;
      float b = sqrt(ks * ks + 2.0 * ks);
      if (b < 1e-6) {
        spec = sx / (sx + 1.0);
        trans = 1.0 / (sx + 1.0);
      } else {
        float xx = b * sx;
        float om = xx < 1e-3 ? 2.0 * xx - 2.0 * xx * xx : 1.0 - exp(-2.0 * xx);
        float den = a * om + b * (2.0 - om);
        spec = om / den;
        trans = (2.0 * b * exp(-xx)) / den;
      }
    }
    vec3 m = vec3(uM0[g], uM1[g], uM2[g]);
    R += m * spec;
    T += m * trans * trans;
  }
  float h = AT(uPaper, t).x;
  float wet = min(1.0, AT(uW, t).x / 0.2);
  float rk = (0.93 + 0.07 * h) * (1.0 - ${f(PHYS.wetDarken)} * wet);
  float tk = 0.96 + 0.04 * h;
  vec3 v = top ? R * rk : T * tk;
  oC = vec4(srgb(v.r), srgb(v.g), srgb(v.b), 1.0);
}`;

type Tex = WebGLTexture;
/** Atlas rectangle: x, y, width, height (texels). */
type Rect = [number, number, number, number];
type Pair<T> = [T, T];

interface Program {
  prog: WebGLProgram;
  loc: Map<string, WebGLUniformLocation | null>;
}

function interleave(planes: (Float32Array | null)[], out = new Float32Array(NN * 4)): Float32Array {
  for (let k = 0; k < 4; k++) {
    const p = planes[k];
    if (!p) continue;
    for (let i = 0; i < NN; i++) out[i * 4 + k] = p[i]!;
  }
  return out;
}

function deinterleave(rgba: Float32Array, planes: (Float32Array | null)[]): void {
  for (let k = 0; k < 4; k++) {
    const p = planes[k];
    if (!p) continue;
    for (let i = 0; i < NN; i++) p[i] = rgba[i * 4 + k]!;
  }
}

const plane = (buf: Float32Array, k: number) => buf.subarray(k * NN, (k + 1) * NN);

export class GpuBackend implements SimBackend {
  readonly kind = "gpu" as const;
  /** Why the last `create()` returned null. */
  static lastError = "";
  readonly #gl: WebGL2RenderingContext;
  readonly #cpu = new CpuBackend();
  readonly #programs: Record<string, Program>;
  readonly #fbo: WebGLFramebuffer;
  readonly #fbo2: WebGLFramebuffer;
  readonly #vao: WebGLVertexArrayObject;
  readonly #dabTex: Tex;
  readonly #sampleTex: Tex;
  readonly #gatherTex: Tex[];
  readonly #displayTex: Tex;
  readonly renderer: string;
  #tile: PaperTile | null = null;
  #dry = 1;
  #side = START_SIDE;
  readonly #slots = new Map<string, number>();
  #slotChunk: ([number, number] | null)[] = new Array(MAX_SLOTS).fill(null);
  #tex!: {
    W: Pair<Tex>;
    F: Pair<Tex>;
    P: Pair<Tex[]>;
    D: Pair<Tex[]>;
    cap: Tex;
    paper: Tex;
  };
  #cur = { W: 0, F: 0, P: 0, D: 0 };
  readonly #nbr = new Int32Array(MAX_SLOTS * 4);
  readonly #used = new Int32Array(MAX_SLOTS);
  readonly #chunkXY = new Int32Array(MAX_SLOTS * 2);
  #layoutDirty = true;
  /** Last `ensure` per slot: a full atlas dries the least recently painted chunk early. */
  readonly #lastUse = new Float64Array(MAX_SLOTS);
  #useTick = 0;
  readonly #rgba = new Float32Array(NN * 4);

  static create(options: { allowSoftware?: boolean } = {}): GpuBackend | null {
    GpuBackend.lastError = "";
    let canvas: OffscreenCanvas | HTMLCanvasElement;
    if (typeof OffscreenCanvas !== "undefined") canvas = new OffscreenCanvas(1, 1);
    else if (typeof document !== "undefined") canvas = document.createElement("canvas");
    else {
      GpuBackend.lastError = "no canvas";
      return null;
    }
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      depth: false,
      stencil: false,
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl) {
      GpuBackend.lastError = "no WebGL2";
      return null;
    }
    if (!gl.getExtension("EXT_color_buffer_float")) {
      GpuBackend.lastError = "no float render targets";
      return null;
    }
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(
      (info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? "unknown",
    );
    if (!options.allowSoftware && /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)) {
      GpuBackend.lastError = `software renderer (${renderer})`;
      return null;
    }
    if (gl.getParameter(gl.MAX_DRAW_BUFFERS) < 7 || gl.getParameter(gl.MAX_TEXTURE_SIZE) < MAX_SIDE * N) {
      GpuBackend.lastError = "GPU limits too small";
      return null;
    }
    try {
      return new GpuBackend(gl, renderer);
    } catch (err) {
      GpuBackend.lastError = String((err as Error)?.message ?? err);
      return null;
    }
  }

  private constructor(gl: WebGL2RenderingContext, renderer: string) {
    this.#gl = gl;
    this.renderer = renderer;
    this.#programs = {
      flux: this.#program(FLUX),
      transport: this.#program(TRANSPORT),
      capOut: this.#program(CAP_OUT),
      capIn: this.#program(CAP_IN),
      local: this.#program(LOCAL),
      apply: this.#program(APPLY),
      gather: this.#program(GATHER),
      display: this.#program(DISPLAY),
    };
    this.#fbo = gl.createFramebuffer()!;
    this.#fbo2 = gl.createFramebuffer()!;
    this.#vao = gl.createVertexArray()!;
    this.#dabTex = this.#texture(DAB_TEXELS, MAX_DABS_PER_BATCH);
    this.#sampleTex = this.#texture(BANDS * GATHER_SAMPLES, MAX_DABS_PER_BATCH);
    this.#gatherTex = [0, 1, 2, 3].map(() => this.#texture(BANDS, MAX_DABS_PER_BATCH));
    this.#displayTex = this.#texture(N, 2 * N, true);
    this.#allocate(this.#side);
  }

  /* -------------------------------------------- */
  /*  GL plumbing                                 */
  /* -------------------------------------------- */

  #program(fragment: string): Program {
    const gl = this.#gl;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(prog)}`);
    return { prog, loc: new Map() };
  }

  #loc(p: Program, name: string): WebGLUniformLocation | null {
    if (!p.loc.has(name)) p.loc.set(name, this.#gl.getUniformLocation(p.prog, name));
    return p.loc.get(name)!;
  }

  #texture(w: number, h: number, bytes = false): Tex {
    const gl = this.#gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (bytes) gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    else gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h);
    return t;
  }

  /** (Re)create the atlas for `side`² slots, zero-filled. */
  #allocate(side: number): void {
    const gl = this.#gl;
    if (this.#tex) {
      const t = this.#tex;
      for (const x of [...t.W, ...t.F, ...t.P[0], ...t.P[1], ...t.D[0], ...t.D[1], t.cap, t.paper]) gl.deleteTexture(x);
    }
    const size = side * N;
    const make = () => this.#texture(size, size);
    const three = () => [make(), make(), make()];
    this.#tex = {
      W: [make(), make()],
      F: [make(), make()],
      P: [three(), three()],
      D: [three(), three()],
      cap: make(),
      paper: make(),
    };
    this.#cur = { W: 0, F: 0, P: 0, D: 0 };
    this.#side = side;
    // texStorage2D content is undefined until written: clear everything once.
    const t = this.#tex;
    for (const x of [...t.W, ...t.F, ...t.P[0], ...t.P[1], ...t.D[0], ...t.D[1], t.cap, t.paper]) {
      this.#attach([x]);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    }
    this.#layoutDirty = true;
  }

  #attach(targets: Tex[]): void {
    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo);
    const bufs: number[] = [];
    for (let i = 0; i < 8; i++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, targets[i] ?? null, 0);
      if (i < targets.length) bufs.push(gl.COLOR_ATTACHMENT0 + i);
    }
    gl.drawBuffers(bufs);
  }

  #run(
    p: Program,
    targets: Tex[],
    inputs: Record<string, Tex>,
    viewport: [number, number],
    set?: (u: (n: string) => WebGLUniformLocation | null) => void,
    rects?: readonly Rect[],
  ): void {
    const gl = this.#gl;
    this.#attach(targets);
    gl.viewport(0, 0, viewport[0], viewport[1]);
    gl.useProgram(p.prog);
    let unit = 0;
    for (const [name, tex] of Object.entries(inputs)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(this.#loc(p, name), unit);
      unit++;
    }
    gl.uniform1i(this.#loc(p, "uS"), this.#side);
    gl.uniform4iv(this.#loc(p, "uNbr[0]"), this.#nbr);
    gl.uniform1iv(this.#loc(p, "uUsed[0]"), this.#used);
    gl.uniform2iv(this.#loc(p, "uChunk[0]"), this.#chunkXY);
    set?.((n) => this.#loc(p, n));
    gl.bindVertexArray(this.#vao);
    if (!rects) {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return;
    }
    gl.enable(gl.SCISSOR_TEST);
    for (const [x, y, w, h] of rects) {
      gl.scissor(x, y, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Atlas rectangles of the used slots: passes skip the free ones (their content is never read). */
  #usedRects(): Rect[] {
    const out: Rect[] = [];
    for (const slot of this.#slots.values()) out.push([...this.#slotOrigin(slot), N, N]);
    return out;
  }

  /** Copy atlas rectangles from one texture to another. */
  #copy(from: Tex, to: Tex, rects: readonly Rect[]): void {
    const gl = this.#gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.#fbo);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, from, 0);
    for (let i = 1; i < 8; i++)
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, null, 0);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.#fbo2);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, to, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    for (const [x, y, w, h] of rects)
      gl.blitFramebuffer(x, y, x + w, y + h, x, y, x + w, y + h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  #atlas(): [number, number] {
    return [this.#side * N, this.#side * N];
  }

  #slotOrigin(slot: number): [number, number] {
    return [(slot % this.#side) * N, Math.floor(slot / this.#side) * N];
  }

  #read(tex: Tex, slot: number, out: Float32Array): Float32Array {
    const gl = this.#gl;
    this.#attach([tex]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const [x, y] = this.#slotOrigin(slot);
    gl.readPixels(x, y, N, N, gl.RGBA, gl.FLOAT, out);
    return out;
  }

  #write(tex: Tex, slot: number, data: Float32Array): void {
    const gl = this.#gl;
    const [x, y] = this.#slotOrigin(slot);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, N, N, gl.RGBA, gl.FLOAT, data);
  }

  /** Slot table: neighbours (−1 = wall), used flags, chunk coordinates. */
  #layout(): void {
    if (!this.#layoutDirty) return;
    this.#layoutDirty = false;
    this.#nbr.fill(-1);
    this.#used.fill(0);
    this.#chunkXY.fill(0);
    for (let s = 0; s < MAX_SLOTS; s++) {
      const xy = this.#slotChunk[s];
      if (!xy) continue;
      const [cx, cy] = xy;
      this.#used[s] = 1;
      this.#chunkXY[s * 2] = cx;
      this.#chunkXY[s * 2 + 1] = cy;
      const at = (x: number, y: number) => this.#slots.get(`${x}_${y}`) ?? -1;
      this.#nbr[s * 4] = at(cx - 1, cy);
      this.#nbr[s * 4 + 1] = at(cx + 1, cy);
      this.#nbr[s * 4 + 2] = at(cx, cy - 1);
      this.#nbr[s * 4 + 3] = at(cx, cy + 1);
    }
  }

  /* -------------------------------------------- */
  /*  Slots                                       */
  /* -------------------------------------------- */

  #slot(cx: number, cy: number): number | undefined {
    return this.#slots.get(`${cx}_${cy}`);
  }

  /** Grow the atlas, keeping every awake chunk. */
  #grow(): boolean {
    if (this.#side >= MAX_SIDE) return false;
    const kept: [number, number, ChunkSnapshot][] = [];
    for (const [key, slot] of this.#slots) {
      const [cx, cy] = key.split("_").map(Number) as [number, number];
      kept.push([cx, cy, this.#snapshotSlot(slot)]);
    }
    this.#slots.clear();
    this.#slotChunk = new Array(MAX_SLOTS).fill(null);
    this.#allocate(Math.min(MAX_SIDE, this.#side + 2));
    for (const [cx, cy, snap] of kept) this.restore(cx, cy, snap);
    return true;
  }

  #free(cx: number, cy: number): void {
    const key = `${cx}_${cy}`;
    const slot = this.#slots.get(key);
    if (slot === undefined) return;
    this.#slots.delete(key);
    this.#slotChunk[slot] = null;
    this.#layoutDirty = true;
  }

  /* -------------------------------------------- */
  /*  SimBackend                                  */
  /* -------------------------------------------- */

  setPaper(tile: PaperTile): void {
    this.#tile = tile;
    this.#cpu.setPaper(tile);
    for (const [key, slot] of this.#slots) {
      const [cx, cy] = key.split("_").map(Number) as [number, number];
      this.#uploadPaper(slot, cx, cy);
    }
  }

  #uploadPaper(slot: number, cx: number, cy: number): void {
    if (!this.#tile) return;
    const p = chunkPaper(this.#tile, cx, cy);
    this.#write(this.#tex.paper, slot, interleave([p.ph, p.pa, p.kR, p.kD], this.#rgba));
  }

  setDrying(factor: number): void {
    this.#dry = Math.max(0.05, Math.min(10, factor));
  }

  has(cx: number, cy: number): boolean {
    return this.#cpu.has(cx, cy);
  }

  ensure(cx: number, cy: number): void {
    this.#cpu.touch(cx, cy);
    const tick = ++this.#useTick;
    const have = this.#slot(cx, cy);
    if (have !== undefined) {
      this.#lastUse[have] = tick;
      return;
    }
    let slot = this.#freeSlot();
    if (slot < 0 && this.#grow()) slot = this.#freeSlot();
    if (slot < 0) {
      // The engine sees the evicted chunk as quiet and dries it.
      let oldest = 0;
      for (let s = 1; s < this.#side * this.#side; s++) if (this.#lastUse[s]! < this.#lastUse[oldest]!) oldest = s;
      const [ox, oy] = this.#slotChunk[oldest]!;
      this.settle(ox, oy);
      slot = oldest;
    }
    this.#lastUse[slot] = tick;
    this.#slots.set(`${cx}_${cy}`, slot);
    this.#slotChunk[slot] = [cx, cy];
    this.#layoutDirty = true;
    this.#uploadPaper(slot, cx, cy);
    const zero = this.#rgba.fill(0);
    const t = this.#tex;
    const c = this.#cur;
    this.#write(t.W[c.W], slot, zero);
    this.#write(t.F[c.F], slot, zero);
    for (const x of t.P[c.P]) this.#write(x, slot, zero);
    this.#write(t.cap, slot, zero);
    const D = this.#cpu.depositPlanes(cx, cy)!;
    for (let k = 0; k < 3; k++)
      this.#write(
        t.D[c.D][k]!,
        slot,
        interleave([plane(D, k * 4), plane(D, k * 4 + 1), plane(D, k * 4 + 2), plane(D, k * 4 + 3)]),
      );
  }

  #freeSlot(): number {
    const count = this.#side * this.#side;
    for (let s = 0; s < count; s++) if (!this.#slotChunk[s]) return s;
    return -1;
  }

  gather(dabs: Float32Array, n: number, out: Float32Array): void {
    out.fill(0, 0, n * GATHER_FLOATS);
    if (!n || !this.#slots.size) return;
    const gl = this.#gl;
    this.#layout();
    // Sample positions: atlas texel (or −1) and the offset in the dab frame.
    const samples = new Float32Array(BANDS * GATHER_SAMPLES * 4 * n);
    for (let d = 0; d < n; d++) {
      const o = d * DAB_FLOATS;
      for (let b = 0; b < BANDS; b++) {
        for (let k = 0; k < GATHER_SAMPLES; k++) {
          const [ox, oy] = gatherOffset(dabs, o, b, k);
          const gx = Math.floor(dabs[o + DAB.x]! + ox);
          const gy = Math.floor(dabs[o + DAB.y]! + oy);
          const cx = Math.floor(gx / N);
          const cy = Math.floor(gy / N);
          const slot = this.#slot(cx, cy);
          const at = ((d * BANDS + b) * GATHER_SAMPLES + k) * 4;
          if (slot === undefined) {
            samples[at] = -1;
            continue;
          }
          const [sx, sy] = this.#slotOrigin(slot);
          samples[at] = sx + gx - cx * N;
          samples[at + 1] = sy + gy - cy * N;
          samples[at + 2] = ox;
          samples[at + 3] = oy;
        }
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.#sampleTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BANDS * GATHER_SAMPLES, n, gl.RGBA, gl.FLOAT, samples);
    this.#uploadDabs(dabs, n);
    const t = this.#tex;
    const c = this.#cur;
    this.#run(
      this.#programs.gather!,
      this.#gatherTex,
      {
        uW: t.W[c.W],
        uP0: t.P[c.P][0]!,
        uP1: t.P[c.P][1]!,
        uP2: t.P[c.P][2]!,
        uPaper: t.paper,
        uSamples: this.#sampleTex,
        uDabs: this.#dabTex,
      },
      [BANDS, n],
    );
    const buf = new Float32Array(BANDS * n * 4);
    for (let a = 0; a < 4; a++) {
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + a);
      gl.readPixels(0, 0, BANDS, n, gl.RGBA, gl.FLOAT, buf);
      for (let d = 0; d < n; d++) {
        for (let b = 0; b < BANDS; b++) {
          const src = (d * BANDS + b) * 4;
          const dst = d * GATHER_FLOATS + b * GATHER_BAND + a * 4;
          for (let k = 0; k < 4; k++) if (a * 4 + k <= C + 1) out[dst + k] = buf[src + k]!;
        }
      }
    }
  }

  #uploadDabs(dabs: Float32Array, n: number): void {
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, this.#dabTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DAB_TEXELS, n, gl.RGBA, gl.FLOAT, dabs.subarray(0, n * DAB_FLOATS));
  }

  applyDabs(dabs: Float32Array, n: number): void {
    if (!n || !this.#slots.size) return;
    this.#layout();
    const rects = this.#dabRects(dabs, n);
    if (!rects.length) return;
    this.#uploadDabs(dabs, n);
    const t = this.#tex;
    const c = this.#cur;
    const nW = c.W ^ 1;
    const nP = c.P ^ 1;
    const nD = c.D ^ 1;
    this.#run(
      this.#programs.apply!,
      [t.W[nW], ...t.P[nP], ...t.D[nD]],
      {
        uW: t.W[c.W],
        uP0: t.P[c.P][0]!,
        uP1: t.P[c.P][1]!,
        uP2: t.P[c.P][2]!,
        uD0: t.D[c.D][0]!,
        uD1: t.D[c.D][1]!,
        uD2: t.D[c.D][2]!,
        uPaper: t.paper,
        uDabs: this.#dabTex,
      },
      this.#atlas(),
      (u) => this.#gl.uniform1i(u("uCount"), n),
      rects,
    );
    // Only the touched rectangles were written: copy them back instead of swapping.
    this.#copy(t.W[nW], t.W[c.W], rects);
    for (let k = 0; k < 3; k++) {
      this.#copy(t.P[nP][k]!, t.P[c.P][k]!, rects);
      this.#copy(t.D[nD][k]!, t.D[c.D][k]!, rects);
    }
  }

  /** Atlas rectangles (one per touched slot) covering the cells the dabs can reach. */
  #dabRects(dabs: Float32Array, n: number): Rect[] {
    const boxes = new Map<number, [number, number, number, number]>();
    for (let d = 0; d < n; d++) {
      const o = d * DAB_FLOATS;
      const x = dabs[o + DAB.x]!;
      const y = dabs[o + DAB.y]!;
      const r = dabs[o + DAB.r]!;
      const gx0 = Math.floor(x - r);
      const gx1 = Math.floor(x + r);
      const gy0 = Math.floor(y - r);
      const gy1 = Math.floor(y + r);
      for (let cy = Math.floor(gy0 / N); cy <= Math.floor(gy1 / N); cy++) {
        for (let cx = Math.floor(gx0 / N); cx <= Math.floor(gx1 / N); cx++) {
          if (!dabIncludesChunk(dabs, o, cx, cy)) continue;
          const slot = this.#slot(cx, cy);
          if (slot === undefined) continue;
          const lx0 = Math.max(0, gx0 - cx * N);
          const lx1 = Math.min(N - 1, gx1 - cx * N);
          const ly0 = Math.max(0, gy0 - cy * N);
          const ly1 = Math.min(N - 1, gy1 - cy * N);
          const b = boxes.get(slot);
          if (!b) boxes.set(slot, [lx0, ly0, lx1, ly1]);
          else {
            b[0] = Math.min(b[0], lx0);
            b[1] = Math.min(b[1], ly0);
            b[2] = Math.max(b[2], lx1);
            b[3] = Math.max(b[3], ly1);
          }
        }
      }
    }
    const out: Rect[] = [];
    for (const [slot, [x0, y0, x1, y1]] of boxes) {
      const [ox, oy] = this.#slotOrigin(slot);
      out.push([ox + x0, oy + y0, x1 - x0 + 1, y1 - y0 + 1]);
    }
    return out;
  }

  step(_active: readonly [number, number][]): void {
    const tile = this.#tile;
    if (!tile || !this.#slots.size) return;
    const gl = this.#gl;
    const paper = tile.props;
    this.#layout();
    const t = this.#tex;
    const size = this.#atlas();
    const used = this.#usedRects();
    let c = this.#cur;
    const P = (i: number) => ({ uP0: t.P[i]![0]!, uP1: t.P[i]![1]!, uP2: t.P[i]![2]! });
    const D = (i: number) => ({ uD0: t.D[i]![0]!, uD1: t.D[i]![1]!, uD2: t.D[i]![2]! });
    // A: flux
    this.#run(
      this.#programs.flux!,
      [t.F[c.F ^ 1]],
      { uW: t.W[c.W], uF: t.F[c.F], uP2: t.P[c.P][2]!, uPaper: t.paper },
      size,
      (u) => gl.uniform1f(u("uRelief"), paper.relief),
      used,
    );
    c = { ...c, F: c.F ^ 1 };
    // B: transport
    this.#run(
      this.#programs.transport!,
      [t.W[c.W ^ 1], ...t.P[c.P ^ 1]],
      { uW: t.W[c.W], uF: t.F[c.F], ...P(c.P) },
      size,
      undefined,
      used,
    );
    c = { ...c, W: c.W ^ 1, P: c.P ^ 1 };
    // C: capillary (outflow fractions first, then inflow from the pre-capillary state)
    this.#run(
      this.#programs.capOut!,
      [t.W[c.W ^ 1], t.cap],
      { uW: t.W[c.W], uPaper: t.paper },
      size,
      (u) => gl.uniform1f(u("uCarry"), paper.carry),
      used,
    );
    this.#run(
      this.#programs.capIn!,
      [...t.P[c.P ^ 1]],
      { uW: t.W[c.W], ...P(c.P), uCap: t.cap },
      size,
      undefined,
      used,
    );
    c = { ...c, W: c.W ^ 1, P: c.P ^ 1 };
    // D: local
    this.#run(
      this.#programs.local!,
      [t.W[c.W ^ 1], ...t.P[c.P ^ 1], ...t.D[c.D ^ 1]],
      { uW: t.W[c.W], ...P(c.P), ...D(c.D), uPaper: t.paper },
      size,
      (u) => {
        gl.uniform1f(u("uAbsorb"), paper.absorb);
        gl.uniform1f(u("uCapacity"), paper.capacity);
        gl.uniform1f(u("uTooth"), paper.tooth);
        gl.uniform1f(u("uDry"), this.#dry * paper.evaporation);
        gl.uniform1f(u("uDryOil"), this.#dry);
        gl.uniform1f(u("uDamp"), paper.bleed);
      },
      used,
    );
    this.#cur = { W: c.W ^ 1, F: c.F, P: c.P ^ 1, D: c.D ^ 1 };
  }

  quiet(cx: number, cy: number): boolean {
    // Reading activity back every step would stall the GPU; awake chunks dry on their timer.
    return this.#slot(cx, cy) === undefined;
  }

  settle(cx: number, cy: number): void {
    const slot = this.#slot(cx, cy);
    if (slot === undefined) return;
    const snap = this.#snapshotSlot(slot);
    const D = this.#cpu.depositPlanes(cx, cy)!;
    for (let j = 0; j < C * NN; j++) D[j] = snap.deposited[j]! + snap.suspended[j]!;
    this.#free(cx, cy);
    this.#cpu.invalidate(cx, cy);
  }

  display(cx: number, cy: number): Uint8ClampedArray | null {
    const slot = this.#slot(cx, cy);
    if (slot === undefined) return this.#cpu.display(cx, cy);
    const gl = this.#gl;
    this.#layout();
    const t = this.#tex;
    const c = this.#cur;
    const [bx, by] = this.#slotOrigin(slot);
    this.#run(
      this.#programs.display!,
      [this.#displayTex],
      {
        uW: t.W[c.W],
        uP0: t.P[c.P][0]!,
        uP1: t.P[c.P][1]!,
        uP2: t.P[c.P][2]!,
        uD0: t.D[c.D][0]!,
        uD1: t.D[c.D][1]!,
        uD2: t.D[c.D][2]!,
        uPaper: t.paper,
      },
      [N, 2 * N],
      (u) => {
        gl.uniform2i(u("uBase"), bx, by);
        gl.uniform1fv(u("uM0[0]"), Float32Array.from(SPECTRAL_RGB[0]!));
        gl.uniform1fv(u("uM1[0]"), Float32Array.from(SPECTRAL_RGB[1]!));
        gl.uniform1fv(u("uM2[0]"), Float32Array.from(SPECTRAL_RGB[2]!));
      },
    );
    const out = new Uint8ClampedArray(N * N * 2 * 4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, N, 2 * N, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  exportDeposit(cx: number, cy: number): Uint16Array {
    const slot = this.#slot(cx, cy);
    if (slot === undefined) return this.#cpu.exportDeposit(cx, cy);
    const snap = this.#snapshotSlot(slot);
    const out = new Uint16Array(C * NN);
    for (let j = 0; j < C * NN; j++) out[j] = toHalf(snap.deposited[j]!);
    return out;
  }

  importDeposit(cx: number, cy: number, halves: Uint16Array): void {
    this.#free(cx, cy);
    this.#cpu.importDeposit(cx, cy, halves);
  }

  #snapshotSlot(slot: number): ChunkSnapshot {
    const t = this.#tex;
    const c = this.#cur;
    const fluid = new Float32Array(3 * NN);
    const flux = new Float32Array(4 * NN);
    const suspended = new Float32Array(C * NN);
    const deposited = new Float32Array(C * NN);
    const rgba = this.#rgba;
    deinterleave(this.#read(t.W[c.W], slot, rgba), [plane(fluid, 0), plane(fluid, 1), plane(fluid, 2), null]);
    deinterleave(this.#read(t.F[c.F], slot, rgba), [plane(flux, 0), plane(flux, 1), plane(flux, 2), plane(flux, 3)]);
    for (let k = 0; k < 3; k++) {
      const four = (buf: Float32Array) => [0, 1, 2, 3].map((q) => plane(buf, k * 4 + q));
      deinterleave(this.#read(t.P[c.P][k]!, slot, rgba), four(suspended));
      deinterleave(this.#read(t.D[c.D][k]!, slot, rgba), four(deposited));
    }
    return { fluid, flux, suspended, deposited };
  }

  snapshot(cx: number, cy: number): ChunkSnapshot {
    const slot = this.#slot(cx, cy);
    return slot === undefined ? this.#cpu.snapshot(cx, cy) : this.#snapshotSlot(slot);
  }

  restore(cx: number, cy: number, snap: ChunkSnapshot): void {
    this.ensure(cx, cy);
    const slot = this.#slot(cx, cy);
    this.#cpu.depositPlanes(cx, cy)?.set(snap.deposited);
    if (slot === undefined) return;
    const t = this.#tex;
    const c = this.#cur;
    const fl = snap.fluid;
    this.#write(t.W[c.W], slot, interleave([plane(fl, 0), plane(fl, 1), plane(fl, 2), null], this.#rgba.fill(0)));
    const fx = snap.flux;
    this.#write(t.F[c.F], slot, interleave([plane(fx, 0), plane(fx, 1), plane(fx, 2), plane(fx, 3)]));
    for (let k = 0; k < 3; k++) {
      const four = (buf: Float32Array) => [0, 1, 2, 3].map((q) => plane(buf, k * 4 + q));
      this.#write(t.P[c.P][k]!, slot, interleave(four(snap.suspended)));
      this.#write(t.D[c.D][k]!, slot, interleave(four(snap.deposited)));
    }
  }

  remove(cx: number, cy: number): void {
    this.#free(cx, cy);
    this.#cpu.remove(cx, cy);
  }

  clear(): void {
    this.#slots.clear();
    this.#slotChunk = new Array(MAX_SLOTS).fill(null);
    this.#layoutDirty = true;
    this.#cpu.clear();
  }

  destroy(): void {
    this.clear();
    const lose = this.#gl.getExtension("WEBGL_lose_context");
    lose?.loseContext();
  }
}

/**
 * Run the same strokes and steps on the GPU and on the CPU reference and
 * compare every plane and the display. The GPU is used only if they agree.
 */
export function gpuSelfTest(gpu: GpuBackend, steps = 12, paper: PaperId = "xuan"): { ok: boolean; detail: string } {
  const t0 = performance.now();
  try {
    const cpu = new CpuBackend();
    const tile = paperTile(paper, 11);
    for (const be of [cpu, gpu] as const) {
      be.setPaper(tile);
      be.setDrying(1);
      be.ensure(0, 0);
      be.ensure(1, 0);
    }
    const strokes = [
      { brush: "watercolor" as const, color: "#1f4ea8", y: 40 },
      { brush: "gouache" as const, color: "#e0c020", y: 52 },
    ];
    let gatherErr = 0;
    for (const s of strokes) {
      const pts: number[] = [];
      for (let x = 160; x <= 360; x += 6) pts.push(x, s.y * 2 + Math.sin(x / 30) * 8, 0.7);
      const walker = new DabWalker(22, MEDIA_BRUSHES[s.brush]);
      const dabs = walker.push(pts);
      walker.finish(dabs);
      const spec = { brush: s.brush, color: s.color, pigment: 0.8, water: 0.6, seed: 4242 };
      const resC = new Reservoir(spec);
      const resG = new Reservoir(spec);
      const bufC = new Float32Array(MAX_DABS_PER_BATCH * DAB_FLOATS);
      const bufG = new Float32Array(MAX_DABS_PER_BATCH * DAB_FLOATS);
      const gC = new Float32Array(MAX_DABS_PER_BATCH * GATHER_FLOATS);
      const gG = new Float32Array(MAX_DABS_PER_BATCH * GATHER_FLOATS);
      for (let i = 0; i < dabs.length; i += MAX_DABS_PER_BATCH) {
        const batch = dabs.slice(i, i + MAX_DABS_PER_BATCH);
        batch.forEach((d, k) => {
          resC.pack(d, bufC, k * DAB_FLOATS);
          resG.pack(d, bufG, k * DAB_FLOATS);
        });
        cpu.gather(bufC, batch.length, gC);
        gpu.gather(bufG, batch.length, gG);
        for (let j = 0; j < batch.length * GATHER_FLOATS; j++)
          gatherErr = Math.max(gatherErr, Math.abs(gC[j]! - gG[j]!));
        batch.forEach((d, k) => {
          resC.pack(d, bufC, k * DAB_FLOATS);
          resC.exchange(gC, k * GATHER_FLOATS);
          resG.pack(d, bufG, k * DAB_FLOATS);
          resG.exchange(gG, k * GATHER_FLOATS);
        });
        cpu.applyDabs(bufC, batch.length);
        gpu.applyDabs(bufG, batch.length);
      }
      for (let i = 0; i < steps; i++) {
        cpu.step([
          [0, 0],
          [1, 0],
        ]);
        gpu.step([
          [0, 0],
          [1, 0],
        ]);
      }
    }
    let worst = 0;
    let where = "";
    /** Pigment per chunk: the scenario must paint both sides of the border, or the comparison proves nothing. */
    const paint = [0, 0];
    for (const [cx, cy] of [
      [0, 0],
      [1, 0],
    ] as const) {
      const a = cpu.snapshot(cx, cy);
      const b = gpu.snapshot(cx, cy);
      for (let i = 0; i < NN; i++) paint[cx]! += a.deposited[PIG.A * NN + i]! + a.suspended[PIG.A * NN + i]!;
      for (const key of ["fluid", "flux", "suspended", "deposited"] as const) {
        const x = a[key];
        const y = b[key];
        let scale = 1e-3;
        for (let j = 0; j < x.length; j++) scale = Math.max(scale, Math.abs(x[j]!));
        for (let j = 0; j < x.length; j++) {
          const e = Math.abs(x[j]! - y[j]!) / scale;
          if (e > worst) {
            worst = e;
            where = `${key}@${cx}_${cy}[${j}]`;
          }
        }
      }
    }
    const da = cpu.display(0, 0) ?? new Uint8ClampedArray(N * N * 8);
    const db = gpu.display(0, 0) ?? new Uint8ClampedArray(N * N * 8);
    let displayErr = 0;
    for (let j = 0; j < da.length; j++) displayErr = Math.max(displayErr, Math.abs(da[j]! - db[j]!));
    const ms = Math.round(performance.now() - t0);
    const painted = paint[0]! > 1 && paint[1]! > 1;
    const ok = painted && worst < 5e-3 && gatherErr < 5e-3 && displayErr <= 4;
    return {
      ok,
      detail: `GPU ${ok ? "ok" : "mismatch"} (${gpu.renderer}): state ${worst.toExponential(2)} at ${where}, gather ${gatherErr.toExponential(2)}, display ${displayErr}, paint ${paint.map((v) => v.toFixed(1)).join("/")}, ${ms} ms`,
    };
  } catch (err) {
    return { ok: false, detail: `GPU self-test error: ${String((err as Error)?.message ?? err)}` };
  } finally {
    gpu.clear();
  }
}
