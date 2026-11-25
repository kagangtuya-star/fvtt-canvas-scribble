import { LIMITS } from "../constants.ts";
import { decodePoints, encodePoints } from "./codec.ts";
import type { ZKind } from "./codec.ts";
import { BRUSH_IDS, MAP_LAYERS, SCHEMA_VERSION, SHAPE_IDS } from "./types.ts";
import type { EraseMask, ItemStyle, Kind, MapLayer, Mode, ScribbleItem, WireItem, WireMask } from "./types.ts";

/**
 * Conversion between in-memory items and their wire/persisted form, plus the
 * validation every untrusted item goes through (socket payloads, Scene flags
 * written by another client). Nothing here trusts the payload's `author`.
 */

export const zKindOf = (kind: Kind): ZKind => (kind === "laser" ? "time" : "pressure");

export function toWire(item: ScribbleItem): WireItem {
  const { points, erase, ...rest } = item;
  const wire: WireItem = { ...rest, points: encodePoints(points, zKindOf(item.kind)) };
  if (erase?.length) wire.erase = erase.map((m) => ({ size: m.size, p: encodePoints(m.points) }));
  else delete wire.erase;
  return wire;
}

export interface SanitizeContext {
  /** Authenticated author (socket sender id, or the stored author for GM-written flags). */
  author: string;
  /** Scene the item must belong to. */
  scene: string;
  /** Receiver's server time (ms). */
  now: number;
  /** Accept `expiresAt: null` (permanent items)? */
  allowPermanent: boolean;
  /** Accept items already past their lifetime (used for persisted data, which never expires). */
  allowExpired?: boolean;
  /** Scene rectangle size in map units (for coordinate bounds); omitted → generous default. */
  mapExtent?: { w: number; h: number };
}

const HEX = /^#[0-9a-f]{6}$/;
const ID = /^[A-Za-z0-9_-]{8,32}$/;
const KINDS: readonly Kind[] = ["stroke", "shape", "area", "text", "laser"];

const num = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

function toolValid(kind: Kind, tool: unknown): tool is string {
  if (typeof tool !== "string") return false;
  switch (kind) {
    case "stroke":
      return (BRUSH_IDS as readonly string[]).includes(tool);
    case "shape":
      return (SHAPE_IDS as readonly string[]).includes(tool);
    default:
      return tool === kind;
  }
}

function sanitizeStyle(raw: unknown): ItemStyle {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: ItemStyle = {};
  if (s.dash === true) out.dash = true;
  if (s.head === "end" || s.head === "both") out.head = s.head;
  if (typeof s.fill === "number" && s.fill > 0) out.fill = num(s.fill, 0, 1, 0);
  if (s.halo === true) out.halo = true;
  if (s.closed === true) out.closed = true;
  return out;
}

/** Are all points inside the coordinate bounds of their space? */
export function inExtent(points: readonly number[], mode: Mode, ctx: Pick<SanitizeContext, "mapExtent">): boolean {
  let lim: [number, number, number, number];
  if (mode === "screen") {
    const e = LIMITS.screenExtent;
    lim = [-e, -e, e, e];
  } else {
    const w = ctx.mapExtent?.w ?? 100_000;
    const h = ctx.mapExtent?.h ?? 100_000;
    const m = LIMITS.mapMargin;
    lim = [-w * m, -h * m, w * (1 + m), h * (1 + m)];
  }
  for (let i = 0; i + 1 < points.length; i += 3) {
    const x = points[i]!;
    const y = points[i + 1]!;
    if (x < lim[0] || y < lim[1] || x > lim[2] || y > lim[3]) return false;
  }
  return true;
}

function sanitizeMasks(raw: unknown, mode: Mode, ctx: SanitizeContext): EraseMask[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: EraseMask[] = [];
  for (const m of raw.slice(0, LIMITS.maxMasksPerItem) as WireMask[]) {
    if (!m || typeof m !== "object") continue;
    const pts = decodePoints(m.p, "pressure", LIMITS.maxPointsPerMask);
    if (!pts || pts.length < 3 || !inExtent(pts, mode, ctx)) continue;
    out.push({ size: num(m.size, 0.1, 5000, 10), points: pts });
  }
  return out.length ? out : undefined;
}

/**
 * Validate an untrusted wire item. Returns `null` when it must be ignored.
 * Values out of range are clamped; structurally wrong data is rejected.
 */
export function sanitizeItem(raw: unknown, ctx: SanitizeContext): ScribbleItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Record<keyof WireItem, unknown>>;
  if (r.schemaVersion !== SCHEMA_VERSION) return null; // newer schemas are refused, not guessed
  if (typeof r.id !== "string" || !ID.test(r.id)) return null;
  if (r.scene !== ctx.scene) return null;
  const mode = r.mode;
  if (mode !== "map" && mode !== "screen") return null;
  const kind = r.kind as Kind;
  if (!KINDS.includes(kind)) return null;
  if (!toolValid(kind, r.tool)) return null;
  const color = typeof r.color === "string" ? r.color.toLowerCase() : "";
  if (!HEX.test(color)) return null;

  const points = decodePoints(r.points, zKindOf(kind), LIMITS.maxPointsPerItem);
  if (!points || points.length < 3 || !inExtent(points, mode, ctx)) return null;

  // Timing: createdAt within a tolerated skew of the receiver's clock.
  let createdAt = num(r.createdAt, 0, Number.MAX_SAFE_INTEGER, ctx.now);
  if (Math.abs(createdAt - ctx.now) > LIMITS.clockSkewMs && !ctx.allowExpired) createdAt = ctx.now;
  let expiresAt: number | null;
  if (r.expiresAt === null) {
    if (!ctx.allowPermanent) return null;
    expiresAt = null;
  } else {
    const life = num(Number(r.expiresAt) - createdAt, 0, LIMITS.maxLifetimeMs, 5000);
    expiresAt = createdAt + life;
  }
  const fadeDuration = num(r.fadeDuration, 0, LIMITS.maxFadeMs, 500);
  if (expiresAt !== null && !ctx.allowExpired && ctx.now >= expiresAt + fadeDuration) return null;

  const layer: MapLayer =
    mode === "screen" ? "top" : MAP_LAYERS.includes(r.layer as MapLayer) ? (r.layer as MapLayer) : "top";

  const item: ScribbleItem = {
    schemaVersion: SCHEMA_VERSION,
    id: r.id,
    author: ctx.author,
    scene: ctx.scene,
    mode,
    kind,
    tool: r.tool as string,
    color,
    opacity: num(r.opacity, 0.05, 1, 1),
    size: num(r.size, 0.1, mode === "screen" ? 400 : 5000, 4),
    points,
    style: sanitizeStyle(r.style),
    createdAt,
    expiresAt,
    fadeDuration,
    layer,
    visibility: "all",
    revision: Math.trunc(num(r.revision, 0, 1e9, 0)),
  };
  if (kind === "text") {
    if (typeof r.text !== "string") return null;
    // Plain text only: strip control characters except newlines; rendered with fillText, never as HTML.
    const text = r.text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").slice(0, LIMITS.maxTextLength);
    if (!text.trim()) return null;
    item.text = text;
  }
  if (mode === "screen") {
    const a = Array.isArray(r.anchor) ? r.anchor : [0, 0];
    const ax = Math.sign(Number(a[0]) || 0);
    const ay = Math.sign(Number(a[1]) || 0);
    item.anchor = [ax, ay];
  }
  if (typeof r.level === "string" && /^[A-Za-z0-9]{1,32}$/.test(r.level)) item.level = r.level;
  const masks = sanitizeMasks(r.erase, mode, ctx);
  if (masks) item.erase = masks;
  return item;
}

/** Approximate stored size of an item in bytes (for the per-scene budget). */
export const wireSize = (item: ScribbleItem | WireItem): number =>
  JSON.stringify("points" in item && typeof item.points === "string" ? item : toWire(item as ScribbleItem)).length;
