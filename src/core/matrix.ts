/**
 * 3×3 homogeneous matrices (row-major) for 2D affine and projective
 * transforms: `x' = (a·x + b·y + c) / w`, `y' = (d·x + e·y + f) / w`,
 * `w = g·x + h·y + i`. Pure math, no DOM.
 */

export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export interface Pt {
  x: number;
  y: number;
}

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Round values within 1e-12 of 0 or ±1 (cos/sin of right angles stay exact). */
const snap = (v: number): number => {
  if (Math.abs(v) < 1e-12) return 0;
  if (Math.abs(v - 1) < 1e-12) return 1;
  if (Math.abs(v + 1) < 1e-12) return -1;
  return v;
};

/** `a · b`: applies `b` first, then `a`. */
export function multiply(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}

/** Compose in application order: `chain(m1, m2, m3)` applies m1, then m2, then m3. */
export function chain(...ms: Mat3[]): Mat3 {
  let out = IDENTITY;
  for (const m of ms) out = multiply(m, out);
  return out;
}

export const translate = (tx: number, ty: number): Mat3 => [1, 0, tx, 0, 1, ty, 0, 0, 1];

/** Linear part `[a, b; c, d]` applied around `(cx, cy)`. */
function aroundPoint(a: number, b: number, c: number, d: number, cx: number, cy: number): Mat3 {
  return [a, b, cx - a * cx - b * cy, c, d, cy - c * cx - d * cy, 0, 0, 1];
}

export const scale = (sx: number, sy: number, cx = 0, cy = 0): Mat3 => aroundPoint(sx, 0, 0, sy, cx, cy);

export function rotate(rad: number, cx = 0, cy = 0): Mat3 {
  const cos = snap(Math.cos(rad));
  const sin = snap(Math.sin(rad));
  return aroundPoint(cos, -sin, sin, cos, cx, cy);
}

/** Mirror across the line through `(cx, cy)` at angle `lineAngle` (radians, 0 = horizontal line). */
export function reflect(lineAngle: number, cx = 0, cy = 0): Mat3 {
  const cos = snap(Math.cos(2 * lineAngle));
  const sin = snap(Math.sin(2 * lineAngle));
  return aroundPoint(cos, sin, sin, -cos, cx, cy);
}

export function apply(m: Mat3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  const iw = Math.abs(w) > 1e-12 ? 1 / w : 1e12;
  return [(m[0] * x + m[1] * y + m[2]) * iw, (m[3] * x + m[4] * y + m[5]) * iw];
}

export const applyPt = (m: Mat3, p: Pt): Pt => {
  const [x, y] = apply(m, p.x, p.y);
  return { x, y };
};

export function invert(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const r = 1 / det;
  return [
    A * r,
    -(b * i - c * h) * r,
    (b * f - c * e) * r,
    B * r,
    (a * i - c * g) * r,
    -(a * f - c * d) * r,
    C * r,
    -(a * h - b * g) * r,
    (a * e - b * d) * r,
  ];
}

/** No projective part (after normalising `i` to 1). */
export function isAffine(m: Mat3, eps = 1e-12): boolean {
  return Math.abs(m[6]) <= eps * Math.abs(m[8]) && Math.abs(m[7]) <= eps * Math.abs(m[8]);
}

export function isIdentity(m: Mat3, eps = 1e-12): boolean {
  return m.every((v, i) => Math.abs(v - IDENTITY[i]!) <= eps);
}

/** Local linear part `[∂x'/∂x, ∂x'/∂y, ∂y'/∂x, ∂y'/∂y]` at a point. */
export function jacobian(m: Mat3, x: number, y: number): [number, number, number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  const u = m[0] * x + m[1] * y + m[2];
  const v = m[3] * x + m[4] * y + m[5];
  const w2 = w * w || 1e-24;
  return [
    (m[0] * w - u * m[6]) / w2,
    (m[1] * w - u * m[7]) / w2,
    (m[3] * w - v * m[6]) / w2,
    (m[4] * w - v * m[7]) / w2,
  ];
}

/** Projective map of the unit square (0,0)(1,0)(1,1)(0,1) onto a quad (Heckbert). */
export function squareToQuad(q: readonly Pt[]): Mat3 | null {
  if (q.length !== 4) return null;
  const [p0, p1, p2, p3] = q as [Pt, Pt, Pt, Pt];
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
    return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0, 1];
  }
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-14) return null;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [
    p1.x - p0.x + g * p1.x,
    p3.x - p0.x + h * p3.x,
    p0.x,
    p1.y - p0.y + g * p1.y,
    p3.y - p0.y + h * p3.y,
    p0.y,
    g,
    h,
    1,
  ];
}

/** Homography taking the four `src` corners onto the four `dst` corners. */
export function fromQuad(src: readonly Pt[], dst: readonly Pt[]): Mat3 | null {
  const a = squareToQuad(src);
  const b = squareToQuad(dst);
  if (!a || !b) return null;
  const inv = invert(a);
  return inv ? multiply(b, inv) : null;
}

/** Affine matrix of a mapping sampled at three points (exact for affine mappings). */
export function affineOf(map: (x: number, y: number) => Pt): Mat3 {
  const o = map(0, 0);
  const ex = map(1, 0);
  const ey = map(0, 1);
  return [ex.x - o.x, ey.x - o.x, o.x, ex.y - o.y, ey.y - o.y, o.y, 0, 0, 1];
}

/** Conjugate `m` (defined in space B) into space A, given `aToB`: `aToB⁻¹ · m · aToB`. */
export function conjugate(m: Mat3, aToB: Mat3): Mat3 {
  const inv = invert(aToB);
  return inv ? multiply(inv, multiply(m, aToB)) : m;
}

/** Is a quad (in order) convex and non-degenerate? */
export function convexQuad(q: readonly Pt[]): boolean {
  if (q.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}
