/**
 * IEEE 754 binary16 conversion (bake files and dry chunk storage).
 * Round-to-nearest-even; NaN maps to 0 and overflow saturates, because the
 * stored quantities are physical amounts that must stay finite.
 */

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function toHalf(value: number): number {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 0 : value > 0 ? 0x7bff : 0xfbff;
  f32[0] = value;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp >= 143) return sign | 0x7bff; // ≥ 65520 → largest finite half.
  if (exp >= 113) {
    // Normal half.
    let h = sign | ((exp - 112) << 10) | (mant >>> 13);
    const rest = mant & 0x1fff;
    if (rest > 0x1000 || (rest === 0x1000 && h & 1)) h++;
    return Math.min(h, sign | 0x7bff);
  }
  if (exp < 102) return sign; // Underflow to ±0.
  // Subnormal half.
  mant |= 0x800000;
  const shift = 126 - exp;
  let h = mant >>> shift;
  const rest = mant & ((1 << shift) - 1);
  const halfway = 1 << (shift - 1);
  if (rest > halfway || (rest === halfway && h & 1)) h++;
  return sign | h;
}

const table = new Float32Array(65536);
for (let h = 0; h < 65536; h++) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  let v: number;
  if (exp === 0) v = mant * 2 ** -24;
  else if (exp === 31)
    v = 0; // Inf / NaN are never written; treat as empty.
  else v = (1 + mant / 1024) * 2 ** (exp - 15);
  table[h] = sign * v;
}

export const fromHalf = (h: number): number => table[h & 0xffff]!;
