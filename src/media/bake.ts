import { unzlibSync, zlibSync } from "fflate";
import { CHUNK, CHUNK_CELLS, PIG_CHANNELS } from "./layout.ts";

/**
 * Bake format: the deposited pigment of one dry chunk, stored as a lossless
 * 8-bit RGB PNG, uploaded inside a JSON envelope to avoid image optimization. PNG is encoded and decoded
 * here (fflate for zlib) instead of through a canvas, because canvases apply
 * colour management and alpha premultiplication that would corrupt the data.
 *
 * Payload (packed row-major into the RGB bytes):
 *   header  32 bytes: "CSMEDIA" + version, chunk edge (u16), channels (u8)
 *   planes  for each channel: N² high bytes, then N² low bytes of binary16
 */

const MAGIC = "CSMEDIA";
const VERSION = 1;
const HEADER = 32;
const WIDTH = CHUNK;
const ROW = WIDTH * 3;
const PAYLOAD = HEADER + PIG_CHANNELS * 2 * CHUNK_CELLS;
export const BAKE_HEIGHT = Math.ceil(PAYLOAD / ROW);
const RAW = (ROW + 1) * BAKE_HEIGHT;
/** Largest bake file accepted (compressed). */
export const MAX_BAKE_BYTES = 2 * 1024 * 1024;
/** The JSON envelope keeps upload optimizers from treating simulation data as an image. */
export const MAX_BAKE_FILE_BYTES = 4 * Math.ceil(MAX_BAKE_BYTES / 3) + 128;

export function encodeBakeFile(png: Uint8Array): Uint8Array {
  if (!png.length || png.length > MAX_BAKE_BYTES) throw new Error("bad bake file size");
  let binary = "";
  for (let i = 0; i < png.length; i += 8192) binary += String.fromCharCode(...png.subarray(i, i + 8192));
  return new TextEncoder().encode(JSON.stringify({ format: "canvas-scribble-media", version: 1, png: btoa(binary) }));
}

export function decodeBakeFile(data: Uint8Array): Uint8Array | null {
  try {
    if (!data.length || data.length > MAX_BAKE_FILE_BYTES) return null;
    const file = JSON.parse(new TextDecoder().decode(data));
    if (
      file?.format !== "canvas-scribble-media" ||
      file.version !== 1 ||
      typeof file.png !== "string" ||
      file.png.length > 4 * Math.ceil(MAX_BAKE_BYTES / 3)
    )
      return null;
    const binary = atob(file.png);
    if (!binary.length || binary.length > MAX_BAKE_BYTES) return null;
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}
export const COVERAGE_AGE_MS = 6 * 60_000;
export const MAX_COVERAGE = 4096;
export type BakeStroke = [id: string, dabs: number, at: number];
export interface BakeCoverage {
  strokes: BakeStroke[];
  /** Timestamp fallback for deposits inherited from a bake without coverage. */
  legacyAt: number;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** Encode deposited planes (PIG_CHANNELS × CHUNK² binary16) as PNG bytes. */
export function encodeBake(halves: Uint16Array, coverage?: BakeCoverage): Uint8Array {
  if (halves.length !== PIG_CHANNELS * CHUNK_CELLS) throw new Error("bad bake size");
  const payload = new Uint8Array(BAKE_HEIGHT * ROW);
  for (let i = 0; i < MAGIC.length; i++) payload[i] = MAGIC.charCodeAt(i);
  payload[7] = VERSION;
  payload[8] = CHUNK >> 8;
  payload[9] = CHUNK & 0xff;
  payload[10] = PIG_CHANNELS;
  for (let c = 0; c < PIG_CHANNELS; c++) {
    const hi = HEADER + c * 2 * CHUNK_CELLS;
    const lo = hi + CHUNK_CELLS;
    for (let i = 0; i < CHUNK_CELLS; i++) {
      const v = halves[c * CHUNK_CELLS + i]!;
      payload[hi + i] = v >> 8;
      payload[lo + i] = v & 0xff;
    }
  }
  // Scanlines with the "Up" filter (planes are smooth vertically).
  const raw = new Uint8Array(RAW);
  for (let y = 0; y < BAKE_HEIGHT; y++) {
    const o = y * (ROW + 1);
    raw[o] = 2;
    for (let x = 0; x < ROW; x++) {
      const cur = payload[y * ROW + x]!;
      const up = y > 0 ? payload[(y - 1) * ROW + x]! : 0;
      raw[o + 1 + x] = (cur - up) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, WIDTH);
  iv.setUint32(4, BAKE_HEIGHT);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", ihdr),
    ...(coverage ? [chunk("csOp", new TextEncoder().encode(JSON.stringify(coverage)))] : []),
    chunk("IDAT", zlibSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Decode and validate bake PNG bytes; null when they are not a bake of this version. */
export function decodeBake(bytes: Uint8Array): Uint16Array | null {
  return decodeBakeState(bytes)?.halves ?? null;
}

export function decodeBakeState(bytes: Uint8Array): { halves: Uint16Array; coverage?: BakeCoverage } | null {
  try {
    if (bytes.length < 64 || bytes.length > MAX_BAKE_BYTES) return null;
    for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = 8;
    let header = false;
    let coverage: BakeCoverage | undefined;
    const idat: Uint8Array[] = [];
    while (o + 12 <= bytes.length) {
      const len = view.getUint32(o);
      const type = String.fromCharCode(bytes[o + 4]!, bytes[o + 5]!, bytes[o + 6]!, bytes[o + 7]!);
      if (o + 12 + len > bytes.length) return null;
      if (crc32(bytes, o + 4, o + 8 + len) !== view.getUint32(o + 8 + len)) return null;
      const data = bytes.subarray(o + 8, o + 8 + len);
      if (type === "IHDR") {
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        if (len !== 13 || dv.getUint32(0) !== WIDTH || dv.getUint32(4) !== BAKE_HEIGHT) return null;
        if (data[8] !== 8 || data[9] !== 2 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return null;
        header = true;
      } else if (type === "csOp") {
        const raw = JSON.parse(new TextDecoder().decode(data));
        if (
          !raw ||
          coverage ||
          !Number.isFinite(raw.legacyAt) ||
          raw.legacyAt < 0 ||
          !Array.isArray(raw.strokes) ||
          raw.strokes.length > MAX_COVERAGE ||
          !raw.strokes.every(
            (s: unknown) =>
              Array.isArray(s) &&
              s.length === 3 &&
              typeof s[0] === "string" &&
              /^[A-Za-z0-9_-]{1,32}$/.test(s[0]) &&
              Number.isSafeInteger(s[1]) &&
              s[1] > 0 &&
              Number.isFinite(s[2]) &&
              s[2] >= 0,
          )
        )
          return null;
        coverage = { legacyAt: raw.legacyAt, strokes: raw.strokes };
      } else if (type === "IDAT") idat.push(data);
      else if (type === "IEND") break;
      o += 12 + len;
    }
    if (!header || !idat.length) return null;
    const z = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
    let zo = 0;
    for (const d of idat) {
      z.set(d, zo);
      zo += d.length;
    }
    const raw = unzlibSync(z, { out: new Uint8Array(RAW) });
    if (raw.length !== RAW) return null;
    const payload = new Uint8Array(BAKE_HEIGHT * ROW);
    for (let y = 0; y < BAKE_HEIGHT; y++) {
      const ro = y * (ROW + 1);
      const filter = raw[ro]!;
      const po = y * ROW;
      for (let x = 0; x < ROW; x++) {
        const v = raw[ro + 1 + x]!;
        const a = x >= 3 ? payload[po + x - 3]! : 0;
        const b = y > 0 ? payload[po - ROW + x]! : 0;
        const c = x >= 3 && y > 0 ? payload[po - ROW + x - 3]! : 0;
        let out: number;
        switch (filter) {
          case 0:
            out = v;
            break;
          case 1:
            out = v + a;
            break;
          case 2:
            out = v + b;
            break;
          case 3:
            out = v + ((a + b) >> 1);
            break;
          case 4:
            out = v + paeth(a, b, c);
            break;
          default:
            return null;
        }
        payload[po + x] = out & 0xff;
      }
    }
    for (let i = 0; i < MAGIC.length; i++) if (payload[i] !== MAGIC.charCodeAt(i)) return null;
    if (payload[7] !== VERSION || ((payload[8]! << 8) | payload[9]!) !== CHUNK || payload[10] !== PIG_CHANNELS)
      return null;
    const halves = new Uint16Array(PIG_CHANNELS * CHUNK_CELLS);
    for (let c = 0; c < PIG_CHANNELS; c++) {
      const hi = HEADER + c * 2 * CHUNK_CELLS;
      const lo = hi + CHUNK_CELLS;
      for (let i = 0; i < CHUNK_CELLS; i++) halves[c * CHUNK_CELLS + i] = (payload[hi + i]! << 8) | payload[lo + i]!;
    }
    return { halves, coverage };
  } catch {
    return null;
  }
}
