import { LIMITS } from "../constants.ts";
import { decodePoints, encodePoints } from "../core/codec.ts";
import { inExtent } from "../core/sanitize.ts";
import { MEDIA_BRUSH_IDS } from "./brushes.ts";
import type { MediaBrushId } from "./brushes.ts";

/**
 * A wet-media stroke as it travels over the socket. Strokes are inputs to
 * the simulation (brush, colour, loads, points), never pixels: every client
 * simulates them, and the GM's bakes make the result converge.
 */
export interface MediaStroke {
  id: string;
  brush: MediaBrushId;
  color: string;
  /** Brush diameter in map units. */
  size: number;
  /** Pigment and water loads (0..1). */
  pigment: number;
  water: number;
  /** Bristle seed. */
  seed: number;
  /** Flat [x, y, pressure] in map units (quantised by the codec). */
  points: number[];
  /** Server time the stroke started. */
  at: number;
}

export interface WireStroke {
  id: string;
  b: string;
  c: string;
  z: number;
  l: number;
  w: number;
  sd: number;
  pts: string;
  at: number;
}

/** Map units: the largest wet-media brush. */
export const MAX_MEDIA_SIZE = 600;
/** Points of one stroke (the gesture stops adding points beyond this). */
export const MAX_MEDIA_POINTS = LIMITS.maxPointsPerItem;

const ID = /^[A-Za-z0-9_-]{1,32}$/;
const HEX = /^#[0-9a-f]{6}$/;

export const isStrokeId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

export function strokeToWire(s: MediaStroke, points = s.points): WireStroke {
  return {
    id: s.id,
    b: s.brush,
    c: s.color,
    z: Math.round(s.size * 10) / 10,
    l: Math.round(s.pigment * 100) / 100,
    w: Math.round(s.water * 100) / 100,
    sd: s.seed >>> 0,
    pts: encodePoints(points, "pressure"),
    at: Math.round(s.at),
  };
}

const unit = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;

/**
 * Validate an untrusted wire stroke. Returns null for anything malformed,
 * out of range or outside the scene's map extent.
 */
export function sanitizeStroke(
  raw: unknown,
  ctx: { mapExtent: { w: number; h: number }; now: number },
  maxPoints = MAX_MEDIA_POINTS,
): MediaStroke | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isStrokeId(r.id)) return null;
  if (typeof r.b !== "string" || !(MEDIA_BRUSH_IDS as readonly string[]).includes(r.b)) return null;
  if (typeof r.c !== "string" || !HEX.test(r.c)) return null;
  const size = typeof r.z === "number" && Number.isFinite(r.z) ? r.z : NaN;
  if (!(size >= 1 && size <= MAX_MEDIA_SIZE)) return null;
  const pigment = unit(r.l);
  const water = unit(r.w);
  if (pigment === null || water === null) return null;
  if (typeof r.sd !== "number" || !Number.isInteger(r.sd) || r.sd < 0 || r.sd > 0xffffffff) return null;
  const at = typeof r.at === "number" && Number.isFinite(r.at) ? r.at : NaN;
  if (!(Math.abs(at - ctx.now) <= LIMITS.clockSkewMs + LIMITS.maxLifetimeMs)) return null;
  const points = decodePoints(r.pts, "pressure", maxPoints);
  if (!points || !inExtent(points, "map", ctx)) return null;
  return { id: r.id, brush: r.b as MediaBrushId, color: r.c, size, pigment, water, seed: r.sd, points, at };
}

/** Validate appended live points (`mp`). */
export function sanitizePoints(
  text: unknown,
  room: number,
  ctx: { mapExtent: { w: number; h: number } },
): number[] | null {
  if (room <= 0) return null;
  const pts = decodePoints(text, "pressure", room);
  if (!pts || !inExtent(pts, "map", ctx)) return null;
  return pts;
}
