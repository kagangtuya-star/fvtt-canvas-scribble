import { LIMITS } from "../constants.ts";
import { sanitizeDynamics } from "../brush/dynamics.ts";
import { decodeAngles, decodePoints, decodeUnits, encodeAngles, encodePoints, encodeUnits } from "./codec.ts";
import type { ZKind } from "./codec.ts";
import { cleanText } from "./text-layout.ts";
import { ANGLE_MODES, BLEND_MODES, BRUSH_IDS, FILL_PATTERNS, MAP_LAYERS, SCHEMA_VERSION, SHAPE_IDS } from "./types.ts";
import type {
  AngleMode,
  BlendMode,
  BrushOverride,
  EraseMask,
  FillPattern,
  ItemStyle,
  Kind,
  MapLayer,
  Mode,
  ScribbleItem,
  WireItem,
  WireMask,
} from "./types.ts";

/**
 * Conversion between in-memory items and their wire/persisted form, plus the
 * validation every untrusted item goes through (socket payloads, Scene flags
 * written by another client). Nothing here trusts the payload's `author`.
 */

export const zKindOf = (kind: Kind): ZKind => (kind === "laser" ? "time" : "pressure");

export function toWire(item: ScribbleItem): WireItem {
  const { points, angles, tilt, speed, erase, ...rest } = item;
  const wire: WireItem = { ...rest, points: encodePoints(points, zKindOf(item.kind)) };
  if (angles?.length) wire.angles = encodeAngles(angles);
  else delete wire.angles;
  if (tilt?.length) wire.tilt = encodeUnits(tilt);
  else delete wire.tilt;
  if (speed?.length) wire.speed = encodeUnits(speed);
  else delete wire.speed;
  if (erase?.length) {
    wire.erase = erase.map((m) => {
      const wm: WireMask = { size: m.size, p: encodePoints(m.points) };
      if (m.tip === "rect") wm.tip = "rect";
      if (typeof m.ang === "number") wm.ang = m.ang;
      if (typeof m.asp === "number") wm.asp = m.asp;
      if (typeof m.hrd === "number") wm.hrd = m.hrd;
      return wm;
    });
  } else delete wire.erase;
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

const optNum = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;

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

function sanitizeBrushOverride(raw: unknown): BrushOverride | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const b = raw as Record<string, unknown>;
  const out: BrushOverride = {};
  const ang = optNum(b.ang, -180, 180);
  if (ang !== undefined) out.ang = Math.round(ang * 10) / 10;
  if (typeof b.am === "string" && (ANGLE_MODES as readonly string[]).includes(b.am)) out.am = b.am as AngleMode;
  const asp = optNum(b.asp, 0.05, 1);
  if (asp !== undefined) out.asp = Math.round(asp * 100) / 100;
  const cor = optNum(b.cor, 0, 1);
  if (cor !== undefined) out.cor = Math.round(cor * 100) / 100;
  const hrd = optNum(b.hrd, 0, 1);
  if (hrd !== undefined) out.hrd = Math.round(hrd * 100) / 100;
  const flw = optNum(b.flw, 0.05, 1);
  if (flw !== undefined) out.flw = Math.round(flw * 100) / 100;
  const spc = optNum(b.spc, 0.08, 3);
  if (spc !== undefined) out.spc = Math.round(spc * 100) / 100;
  const sct = optNum(b.sct, 0, 3);
  if (sct !== undefined) out.sct = Math.round(sct * 100) / 100;
  const grn = optNum(b.grn, 0, 1);
  if (grn !== undefined) out.grn = Math.round(grn * 100) / 100;
  const rgh = optNum(b.rgh, 0, 3);
  if (rgh !== undefined) out.rgh = Math.round(rgh * 100) / 100;
  const dyn = sanitizeDynamics(b.dyn);
  if (dyn) out.dyn = dyn;
  return Object.keys(out).length ? out : undefined;
}

function sanitizeStyle(raw: unknown): ItemStyle {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: ItemStyle = {};
  if (s.dash === true) out.dash = true;
  if (s.head === "end" || s.head === "both") out.head = s.head;
  if (typeof s.fill === "number" && s.fill > 0) out.fill = num(s.fill, 0, 1, 0);
  if (s.halo === true) out.halo = true;
  if (s.closed === true) out.closed = true;
  if (typeof s.blend === "string" && (BLEND_MODES as readonly string[]).includes(s.blend)) {
    out.blend = s.blend as BlendMode;
  }
  if (
    typeof s.fillPattern === "string" &&
    (FILL_PATTERNS as readonly string[]).includes(s.fillPattern) &&
    s.fillPattern !== "solid"
  ) {
    out.fillPattern = s.fillPattern as FillPattern;
  }
  const brush = sanitizeBrushOverride(s.brush);
  if (brush) out.brush = brush;
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
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < lim[0] || y < lim[1] || x > lim[2] || y > lim[3])
      return false;
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
    const mask: EraseMask = { size: num(m.size, 0.1, 5000, 10), points: pts };
    if (m.tip === "rect") mask.tip = "rect";
    const ang = optNum(m.ang, -180, 180);
    if (ang !== undefined) mask.ang = ang;
    const asp = optNum(m.asp, 0.1, 1);
    if (asp !== undefined) mask.asp = asp;
    const hrd = optNum(m.hrd, 0, 1);
    if (hrd !== undefined) mask.hrd = hrd;
    out.push(mask);
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

  let angles: number[] | undefined;
  if (r.angles !== undefined) {
    const decoded = decodeAngles(r.angles, points.length / 3);
    if (decoded?.length === points.length / 3) angles = decoded;
  }
  // Dynamics channels must match the points one to one, otherwise they are dropped.
  const channel = (raw: unknown): number[] | undefined => {
    if (raw === undefined || kind !== "stroke") return undefined;
    const decoded = decodeUnits(raw, points.length / 3);
    return decoded?.length === points.length / 3 ? decoded : undefined;
  };
  const tilt = channel(r.tilt);
  const speed = channel(r.speed);

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
  if (angles) item.angles = angles;
  if (tilt) item.tilt = tilt;
  if (speed) item.speed = speed;
  if (kind === "text") {
    if (typeof r.text !== "string") return null;
    // Plain text only: strip control characters except newlines; rendered with fillText, never as HTML.
    const text = cleanText(r.text);
    if (!text.trim()) return null;
    item.text = text;
    const width = optNum(r.textWidth, 1, mode === "screen" ? 4000 : 100_000);
    if (width !== undefined) item.textWidth = width;
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
