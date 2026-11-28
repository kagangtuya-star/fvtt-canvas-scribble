/**
 * Response curves for brush dynamics: map a normalised sensor value (0..1)
 * to a normalised output (0..1).
 *
 * A curve travels with the item as a short code, validated like any other
 * untrusted value:
 *  - `lin` (identity), `inv` (1 − x), `s` (smoothstep)
 *  - `pow:<g>`: x^g with g in 0.1..10 (the brushes' legacy pressure exponent)
 *  - `thr:<t>`: step at t (0 below, 1 from t on)
 *  - `p:x,y;x,y;…`: 2..8 control points as integers 0..255, x strictly
 *    increasing, interpolated by a monotone cubic (Fritsch–Carlson) that never
 *    overshoots, so the output always stays within the control values.
 *
 * Parametric curves evaluate analytically (exact, e.g. `pow` matches the old
 * `Math.pow` formulas); control-point curves are baked once into a lookup table.
 */

export const CURVE_PRESETS = ["lin", "soft", "firm", "s", "inv", "thr"] as const;
export type CurvePreset = (typeof CURVE_PRESETS)[number];

/** Code of each preset (what the UI stores). */
export const PRESET_CODE: Readonly<Record<CurvePreset, string>> = {
  lin: "lin",
  soft: "pow:0.5",
  firm: "pow:2",
  s: "s",
  inv: "inv",
  thr: "thr:0.5",
};

export const MAX_CURVE_POINTS = 8;
const MAX_CODE_LENGTH = 72;
const LUT_SIZE = 1024;

export type CurveFn = (x: number) => number;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Control points (0..255 integers) of a `p:` code, or null when malformed. */
function parsePoints(body: string): [number, number][] | null {
  const parts = body.split(";");
  if (parts.length < 2 || parts.length > MAX_CURVE_POINTS) return null;
  const out: [number, number][] = [];
  for (const part of parts) {
    const m = /^(\d{1,3}),(\d{1,3})$/.exec(part);
    if (!m) return null;
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (x > 255 || y > 255) return null;
    if (out.length && x <= out[out.length - 1]![0]) return null;
    out.push([x, y]);
  }
  return out;
}

/** Canonical form of a curve code, or `null` when it is not a valid curve. */
export function parseCurve(code: unknown): string | null {
  if (typeof code !== "string" || !code || code.length > MAX_CODE_LENGTH) return null;
  if (code === "lin" || code === "inv" || code === "s") return code;
  const pow = /^pow:(\d+(?:\.\d+)?)$/.exec(code);
  if (pow) {
    const g = Number(pow[1]);
    if (!(g >= 0.1 && g <= 10)) return null;
    return g === 1 ? "lin" : `pow:${round2(g)}`;
  }
  const thr = /^thr:(\d+(?:\.\d+)?)$/.exec(code);
  if (thr) {
    const t = Number(thr[1]);
    if (!(t >= 0 && t <= 1)) return null;
    return `thr:${round2(t)}`;
  }
  if (code.startsWith("p:")) {
    const pts = parsePoints(code.slice(2));
    return pts ? encodeCurvePoints(pts.map(([x, y]) => [x / 255, y / 255])) : null;
  }
  return null;
}

/** `p:` code of control points given in 0..1 (sorted by x, duplicates dropped, at most 8). */
export function encodeCurvePoints(points: readonly (readonly [number, number])[]): string {
  const q = points
    .map(([x, y]) => [Math.round(clamp01(x) * 255), Math.round(clamp01(y) * 255)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const p of q) if (!out.length || p[0] > out[out.length - 1]![0]) out.push(p);
  while (out.length > MAX_CURVE_POINTS) out.splice(Math.floor(out.length / 2), 1);
  if (out.length === 1) out.push(out[0]![0] < 255 ? [255, out[0]![1]] : [0, out[0]![1]]);
  out.sort((a, b) => a[0] - b[0]);
  return `p:${out.map(([x, y]) => `${x},${y}`).join(";")}`;
}

/**
 * Monotone cubic Hermite interpolation (Fritsch–Carlson) of the control
 * points, sampled into a table of `n` values over x ∈ [0, 1]. Outside the
 * first/last control point the curve holds the end values.
 */
export function monotoneLut(xs: readonly number[], ys: readonly number[], n = LUT_SIZE): Float32Array {
  const k = xs.length;
  const lut = new Float32Array(n);
  const d: number[] = [];
  const m: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < k - 1; i++) d.push((ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]!));
  m[0] = d[0]!;
  m[k - 1] = d[k - 2]!;
  for (let i = 1; i < k - 1; i++) m[i] = d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2;
  for (let i = 0; i < k - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    // A negative ratio means the neighbouring secant changes sign: flatten to stay monotone.
    if (a < 0) m[i] = 0;
    if (b < 0) m[i + 1] = 0;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  let seg = 0;
  for (let j = 0; j < n; j++) {
    const x = j / (n - 1);
    let y: number;
    if (x <= xs[0]!) y = ys[0]!;
    else if (x >= xs[k - 1]!) y = ys[k - 1]!;
    else {
      while (seg < k - 2 && x > xs[seg + 1]!) seg++;
      const h = xs[seg + 1]! - xs[seg]!;
      const t = (x - xs[seg]!) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      y =
        (2 * t3 - 3 * t2 + 1) * ys[seg]! +
        (t3 - 2 * t2 + t) * h * m[seg]! +
        (-2 * t3 + 3 * t2) * ys[seg + 1]! +
        (t3 - t2) * h * m[seg + 1]!;
    }
    lut[j] = clamp01(y);
  }
  return lut;
}

const CACHE_LIMIT = 128;
const cache = new Map<string, CurveFn>();

const linear: CurveFn = (x) => clamp01(x);

/** Evaluator of a curve code; invalid codes evaluate as linear. Cached by code. */
export function compileCurve(code: string | undefined): CurveFn {
  const canon = parseCurve(code ?? "lin") ?? "lin";
  const hit = cache.get(canon);
  if (hit) return hit;
  let fn: CurveFn;
  if (canon === "lin") fn = linear;
  else if (canon === "inv") fn = (x) => 1 - clamp01(x);
  else if (canon === "s")
    fn = (x) => {
      const u = clamp01(x);
      return u * u * (3 - 2 * u);
    };
  else if (canon.startsWith("pow:")) {
    const g = Number(canon.slice(4));
    fn = (x) => Math.pow(clamp01(x), g);
  } else if (canon.startsWith("thr:")) {
    const t = Number(canon.slice(4));
    fn = (x) => (x >= t ? 1 : 0);
  } else {
    const pts = parsePoints(canon.slice(2))!;
    const lut = monotoneLut(
      pts.map((p) => p[0] / 255),
      pts.map((p) => p[1] / 255),
    );
    const last = lut.length - 1;
    fn = (x) => {
      const f = clamp01(x) * last;
      const i = Math.floor(f);
      if (i >= last) return lut[last]!;
      return lut[i]! + (lut[i + 1]! - lut[i]!) * (f - i);
    };
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(canon, fn);
  return fn;
}

/**
 * Editable control points (0..1) for a curve: the points of a `p:` code, or
 * a sampled approximation of a parametric curve (used when the user starts
 * dragging a preset).
 */
export function curveControlPoints(code: string | undefined): [number, number][] {
  const canon = parseCurve(code ?? "lin") ?? "lin";
  if (canon.startsWith("p:")) return parsePoints(canon.slice(2))!.map(([x, y]) => [x / 255, y / 255]);
  if (canon === "lin")
    return [
      [0, 0],
      [1, 1],
    ];
  if (canon === "inv")
    return [
      [0, 1],
      [1, 0],
    ];
  if (canon.startsWith("thr:")) {
    const t = Number(canon.slice(4));
    const a = Math.max(0, t - 0.02);
    const b = Math.min(1, t + 0.02);
    return [
      [0, 0],
      [a, 0],
      [b, 1],
      [1, 1],
    ];
  }
  const fn = compileCurve(canon);
  return [0, 0.2, 0.4, 0.6, 0.8, 1].map((x) => [x, fn(x)]);
}

/** Preset matching a code, if any. */
export function presetOf(code: string | undefined): CurvePreset | null {
  const canon = parseCurve(code ?? "lin") ?? "lin";
  for (const p of CURVE_PRESETS) if (PRESET_CODE[p] === canon) return p;
  return null;
}
