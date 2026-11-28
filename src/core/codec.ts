/**
 * Compact point & angle encoding for the wire and for Scene flags.
 *
 * Triples `[x, y, z]` are quantised (x, y to 1/10 unit; z to 1/255 for
 * pressure or to whole milliseconds for laser timing), delta-encoded,
 * zig-zag mapped and written as LEB128 varints, then base64.
 * A typical point costs 3–5 bytes instead of ~30 bytes of JSON.
 *
 * Optional per-point angles (radians, -PI..PI) are encoded in a parallel
 * string using modular 8-bit delta encoding (~1 byte/point).
 *
 * Format: "1" + base64. The leading digit is the codec version.
 */

export type ZKind = "pressure" | "time";

const XY_SCALE = 10;
const zScale = (kind: ZKind) => (kind === "pressure" ? 255 : 1);

const zigzag = (n: number) => (n << 1) ^ (n >> 31);
const unzigzag = (n: number) => (n >>> 1) ^ -(n & 1);

function writeVarint(out: number[], value: number): void {
  let v = zigzag(value) >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Clamp to the int32 range the varint writer supports. */
const clampInt = (n: number) => Math.max(-0x3fffffff, Math.min(0x3fffffff, Math.round(n)));

export function encodePoints(flat: readonly number[], kind: ZKind = "pressure"): string {
  const zs = zScale(kind);
  const bytes: number[] = [];
  let px = 0;
  let py = 0;
  let pz = 0;
  for (let i = 0; i + 2 < flat.length; i += 3) {
    const x = clampInt(flat[i]! * XY_SCALE);
    const y = clampInt(flat[i + 1]! * XY_SCALE);
    const z = clampInt(flat[i + 2]! * zs);
    writeVarint(bytes, x - px);
    writeVarint(bytes, y - py);
    writeVarint(bytes, z - pz);
    px = x;
    py = y;
    pz = z;
  }
  return "1" + toBase64(Uint8Array.from(bytes));
}

/**
 * Decode; returns `null` for malformed input (never throws), and stops after
 * `maxPoints` points so hostile payloads cannot allocate unbounded memory.
 */
export function decodePoints(text: unknown, kind: ZKind = "pressure", maxPoints = Infinity): number[] | null {
  if (typeof text !== "string" || text[0] !== "1") return null;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(text.slice(1));
  } catch {
    return null;
  }
  const zs = zScale(kind);
  const out: number[] = [];
  let acc = [0, 0, 0];
  let component = 0;
  let value = 0;
  let shift = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (shift > 28) return null;
    value |= (b & 0x7f) << shift;
    if (b & 0x80) {
      shift += 7;
      continue;
    }
    acc[component] = acc[component]! + unzigzag(value);
    value = 0;
    shift = 0;
    component++;
    if (component === 3) {
      out.push(acc[0]! / XY_SCALE, acc[1]! / XY_SCALE, acc[2]! / zs);
      component = 0;
      if (out.length / 3 >= maxPoints) break;
    }
  }
  if (component !== 0 || shift !== 0) return null;
  if (out.some((n) => !Number.isFinite(n))) return null;
  return out;
}

/** Round to the precision the codec keeps, so local and decoded items are identical. */
export function quantizePoints(flat: readonly number[], kind: ZKind = "pressure"): number[] {
  const zs = zScale(kind);
  const out = new Array<number>(flat.length);
  for (let i = 0; i + 2 < flat.length; i += 3) {
    // `+ 0` turns -0 into 0, which is what decoding yields.
    out[i] = Math.round(flat[i]! * XY_SCALE) / XY_SCALE + 0;
    out[i + 1] = Math.round(flat[i + 1]! * XY_SCALE) / XY_SCALE + 0;
    out[i + 2] = Math.round(flat[i + 2]! * zs) / zs + 0;
  }
  return out;
}

/* -------------------------------------------- */
/*  Per-point nib angles (radians, -PI..PI)     */
/* -------------------------------------------- */

const TAU = Math.PI * 2;
const ANG_BINS = 256;

/** Map angle in radians to an integer bin in [0, 255]. */
function angleToBin(rad: number): number {
  const norm = (((rad % TAU) + TAU) % TAU) / TAU;
  return Math.round(norm * ANG_BINS) & 255;
}

/** Map integer bin in [0, 255] back to radians in [-PI, PI). */
function binToAngle(bin: number): number {
  const b = ((bin % ANG_BINS) + ANG_BINS) % ANG_BINS;
  const rad = (b / ANG_BINS) * TAU;
  return (rad >= Math.PI ? rad - TAU : rad) + 0;
}

/** Shortest signed modular delta in [-128, 127]. */
function wrapDelta(diff: number): number {
  let d = ((diff % ANG_BINS) + ANG_BINS) % ANG_BINS;
  if (d >= 128) d -= ANG_BINS;
  return d;
}

export function encodeAngles(angles: readonly number[]): string {
  const bytes: number[] = [];
  let prev = 0;
  for (let i = 0; i < angles.length; i++) {
    const cur = angleToBin(angles[i]!);
    writeVarint(bytes, wrapDelta(cur - prev));
    prev = cur;
  }
  return "1" + toBase64(Uint8Array.from(bytes));
}

export function decodeAngles(text: unknown, maxPoints = Infinity): number[] | null {
  if (typeof text !== "string" || text[0] !== "1") return null;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(text.slice(1));
  } catch {
    return null;
  }
  const out: number[] = [];
  let acc = 0;
  let value = 0;
  let shift = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (shift > 28) return null;
    value |= (b & 0x7f) << shift;
    if (b & 0x80) {
      shift += 7;
      continue;
    }
    acc = (acc + unzigzag(value)) & 255;
    value = 0;
    shift = 0;
    out.push(binToAngle(acc));
    if (out.length >= maxPoints) break;
  }
  if (shift !== 0) return null;
  return out;
}

export function quantizeAngles(angles: readonly number[]): number[] {
  const out = new Array<number>(angles.length);
  for (let i = 0; i < angles.length; i++) out[i] = binToAngle(angleToBin(angles[i]!));
  return out;
}
