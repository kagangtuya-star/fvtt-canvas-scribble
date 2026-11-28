import { resample } from "../core/geometry.ts";
import type { BlendMode, BrushId, ScribbleItem } from "../core/types.ts";
import { clamp, hashString, luminance, rng } from "../core/util.ts";
import { BRUSHES, resolveBrushParams } from "./brushes.ts";
import type { BrushDefinition, ResolvedBrushParams } from "./brushes.ts";
import { outline, samples } from "./freehand.ts";
import { paintRoughArea, paintRoughShape, usesRough } from "./rough-shapes.ts";
import { arrowHead, arrowHeadLength, pathTailReference } from "./shapes.ts";
import type { Pt } from "./shapes.ts";
import { createSurfaceCanvas, grainPattern, seededNoise2D } from "./texture.ts";
import type { AnyCanvas, Ctx2D } from "./texture.ts";

/**
 * Multi-engine Canvas 2D painters:
 *  - Engine 1: Outline Ribbon (perfect-freehand ink, Simplex pencil, soft, watercolor, neon)
 *  - Engine 2: Parameterised Swept Nib Hull (flat rectangular, calligraphy, chisel highlighter)
 *  - Engine 3: Parametric Dab / Stamp Engine (bristle, pixel, charcoal, chalk, airbrush, splatter)
 *  - Engine 4: RoughJS Sketchy Shapes & Pattern Fills
 *
 * Coordinates are item space units; the caller sets up `view` so that
 * device pixel = unit × scale + offset. Painters draw the item at *full*
 * opacity into an isolated context (an item canvas or scratch layer) so
 * erase masks (`destination-out`) and multi-pass effects never corrupt other
 * items. Item opacity and blend mode are applied when compositing.
 */

export type { AnyCanvas, Ctx2D };

export interface View {
  /** Device pixels per space unit. */
  scale: number;
  ox: number;
  oy: number;
}

/** Hard cap on dabs per stroke to protect clients from pathological spacing/length DoS. */
export const MAX_DABS_PER_ITEM = 12_000;

export function createCanvas(width: number, height: number): AnyCanvas {
  return createSurfaceCanvas(width, height);
}

export function ctx2d(canvas: AnyCanvas): Ctx2D {
  const ctx = canvas.getContext("2d") as Ctx2D | null;
  if (!ctx) throw new Error("CanvasScribble: 2D canvas context unavailable");
  return ctx;
}

const applyView = (ctx: Ctx2D, v: View) => ctx.setTransform(v.scale, 0, 0, v.scale, v.ox, v.oy);

/** Effective blend mode for an item (per-item override or brush default). */
export function effectiveBlend(item: ScribbleItem): BlendMode {
  if (item.style.blend) return item.style.blend;
  if (item.kind === "stroke") return BRUSHES[item.tool as BrushId]?.blend ?? "normal";
  return "normal";
}

/** Map `BlendMode` to Canvas2D `globalCompositeOperation`. */
export function toCanvasBlend(blend: BlendMode): GlobalCompositeOperation {
  switch (blend) {
    case "multiply":
      return "multiply";
    case "screen":
      return "screen";
    case "overlay":
      return "overlay";
    case "lighter":
      return "lighter";
    default:
      return "source-over";
  }
}

/* -------------------------------------------- */
/*  Colour helpers                              */
/* -------------------------------------------- */

function parseHex(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

/* -------------------------------------------- */
/*  Geometry & path helpers                     */
/* -------------------------------------------- */

const mid = (a: number[], b: number[]) => [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2];

/** Closed Path2D through an outline polygon using quadratic midpoints (perfect-freehand's recommendation). */
function outlinePath(poly: number[][]): Path2D {
  const path = new Path2D();
  const n = poly.length;
  if (n < 3) {
    if (n) path.arc(poly[0]![0]!, poly[0]![1]!, 0.5, 0, Math.PI * 2);
    return path;
  }
  path.moveTo(poly[0]![0]!, poly[0]![1]!);
  for (let i = 1; i < n; i++) {
    const m = mid(poly[i]!, poly[(i + 1) % n]!);
    path.quadraticCurveTo(poly[i]![0]!, poly[i]![1]!, m[0]!, m[1]!);
  }
  path.closePath();
  return path;
}

/** Open (or closed) smooth centre-line path through triples. */
function centerPath(flat: readonly number[], closed = false, trimStart = 0, trimEnd = 0): Path2D {
  const pts = trimPolyline(flat, trimStart, trimEnd);
  const path = new Path2D();
  const n = pts.length / 3;
  if (n === 0) return path;
  path.moveTo(pts[0]!, pts[1]!);
  if (n === 1) {
    path.lineTo(pts[0]! + 0.01, pts[1]!);
    return path;
  }
  if (n === 2) {
    path.lineTo(pts[3]!, pts[4]!);
    if (closed) path.closePath();
    return path;
  }
  for (let i = 1; i < n - 1; i++) {
    const x = pts[i * 3]!;
    const y = pts[i * 3 + 1]!;
    path.quadraticCurveTo(x, y, (x + pts[(i + 1) * 3]!) / 2, (y + pts[(i + 1) * 3 + 1]!) / 2);
  }
  path.lineTo(pts[(n - 1) * 3]!, pts[(n - 1) * 3 + 1]!);
  if (closed) path.closePath();
  return path;
}

/** Shorten a polyline at either end by a distance (to make room for arrow heads). */
function trimPolyline(flat: readonly number[], fromStart: number, fromEnd: number): number[] {
  let pts = flat.slice();
  if (fromEnd > 0) pts = trimEnd(pts, fromEnd);
  if (fromStart > 0) pts = reverse(trimEnd(reverse(pts), fromStart));
  return pts;
}

function reverse(flat: number[]): number[] {
  const out: number[] = [];
  for (let i = flat.length - 3; i >= 0; i -= 3) out.push(flat[i]!, flat[i + 1]!, flat[i + 2]!);
  return out;
}

function trimEnd(flat: number[], dist: number): number[] {
  const out = flat.slice();
  let remaining = dist;
  while (out.length >= 6 && remaining > 0) {
    const n = out.length;
    const x1 = out[n - 3]!;
    const y1 = out[n - 2]!;
    const x0 = out[n - 6]!;
    const y0 = out[n - 5]!;
    const seg = Math.hypot(x1 - x0, y1 - y0);
    if (seg > remaining) {
      const f = (seg - remaining) / seg;
      out[n - 3] = x0 + (x1 - x0) * f;
      out[n - 2] = y0 + (y1 - y0) * f;
      return out;
    }
    remaining -= seg;
    out.length = n - 3;
  }
  return out;
}

export function haloColor(color: string): string {
  return luminance(color) < 0.16 ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.55)";
}

function withHalo(ctx: Ctx2D, item: ScribbleItem, view: View, draw: () => void): void {
  if (!item.style.halo) {
    draw();
    return;
  }
  ctx.save();
  ctx.shadowColor = haloColor(item.color);
  ctx.shadowBlur = Math.max(1.5, Math.min(10, item.size * view.scale * 0.45));
  draw();
  ctx.restore();
}

const spacingFor = (width: number, view: View) => Math.max(0.6 / view.scale, Math.min(width / 5, 6 / view.scale));

/** Interpolate shortest angular difference between two angles (radians). */
function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Resample a stroke in pure **space units** (independent of `view.scale`) with
 * parallel interpolated per-point angles and cumulative running length.
 */
interface SpaceSample {
  x: number;
  y: number;
  p: number;
  /** Recorded pen angle (radians) or NaN if none. */
  ang: number;
  /** Smoothed tangent angle (radians). */
  tan: number;
  run: number;
}

function buildSpaceSamples(item: ScribbleItem, stepUnits: number): SpaceSample[] {
  const flat = item.points;
  const n = flat.length / 3;
  if (n === 0) return [];
  const step = Math.max(0.15, stepUnits);
  const angles = item.angles;
  const hasAng = !!angles && angles.length > 0;
  const px = (i: number) => flat[clamp(i, 0, n - 1) * 3]!;
  const py = (i: number) => flat[clamp(i, 0, n - 1) * 3 + 1]!;
  const pa = (i: number) => (hasAng ? angles[clamp(i, 0, angles.length - 1)]! : Number.NaN);

  const out: SpaceSample[] = [];
  let run = 0;
  let lastX = flat[0]!;
  let lastY = flat[1]!;

  if (n === 1) {
    return [{ x: lastX, y: lastY, p: flat[2]!, ang: pa(0), tan: 0, run: 0 }];
  }

  for (let i = 0; i < n - 1; i++) {
    const x0 = px(i - 1);
    const y0 = py(i - 1);
    const x1 = px(i);
    const y1 = py(i);
    const x2 = px(i + 1);
    const y2 = py(i + 1);
    const x3 = px(i + 2);
    const y3 = py(i + 2);
    const p1 = flat[i * 3 + 2]!;
    const p2 = flat[(i + 1) * 3 + 2]!;
    const a1 = pa(i);
    const a2 = pa(i + 1);
    const segLen = Math.hypot(x2 - x1, y2 - y1);
    const count = Math.max(1, Math.min(64, Math.ceil(segLen / step)));
    for (let k = 0; k < count; k++) {
      const t = k / count;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 * (2 * x1 + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3);
      const y =
        0.5 * (2 * y1 + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
      if (out.length > 0) run += Math.hypot(x - lastX, y - lastY);
      lastX = x;
      lastY = y;
      out.push({
        x,
        y,
        p: p1 + (p2 - p1) * t,
        ang: hasAng ? lerpAngle(a1, a2, t) : Number.NaN,
        tan: 0,
        run,
      });
    }
  }
  const ex = flat[(n - 1) * 3]!;
  const ey = flat[(n - 1) * 3 + 1]!;
  run += Math.hypot(ex - lastX, ey - lastY);
  out.push({ x: ex, y: ey, p: flat[(n - 1) * 3 + 2]!, ang: pa(n - 1), tan: 0, run });

  // Compute smoothed tangents.
  let lastTan = 0;
  for (let i = 0; i < out.length; i++) {
    const prev = out[Math.max(0, i - 2)]!;
    const next = out[Math.min(out.length - 1, i + 2)]!;
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    if (dx * dx + dy * dy > 1e-6) lastTan = Math.atan2(dy, dx);
    out[i]!.tan = lastTan;
  }
  // Back-fill leading zero-length tangents.
  if (out.length > 1 && out[0]!.tan === 0) {
    const firstValid = out.find((s) => s.tan !== 0)?.tan ?? 0;
    for (let i = 0; i < out.length && out[i]!.tan === 0; i++) out[i]!.tan = firstValid;
  }
  return out;
}

/** Resolve nib angle (radians) for a sample given the brush's `angleMode` and base `angle`. */
function sampleAngle(s: SpaceSample, params: ResolvedBrushParams): number {
  const baseRad = (params.angle * Math.PI) / 180;
  switch (params.angleMode) {
    case "follow":
      return s.tan + baseRad;
    case "tilt":
    case "twist":
      return Number.isFinite(s.ang) ? s.ang + baseRad : baseRad;
    default:
      return baseRad;
  }
}

/* -------------------------------------------- */
/*  Pre-baked soft tip sprite cache             */
/* -------------------------------------------- */

const TIP_CACHE_LIMIT = 48;
const tipSpriteCache = new Map<string, AnyCanvas>();

function drawRoundedRectPath(ctx: Ctx2D, rx: number, ry: number, corner: number): void {
  const r = Math.min(rx, ry) * clamp(corner, 0, 1);
  ctx.beginPath();
  if (r <= 0.01) {
    ctx.rect(-rx, -ry, rx * 2, ry * 2);
  } else {
    ctx.moveTo(-rx + r, -ry);
    ctx.lineTo(rx - r, -ry);
    ctx.quadraticCurveTo(rx, -ry, rx, -ry + r);
    ctx.lineTo(rx, ry - r);
    ctx.quadraticCurveTo(rx, ry, rx - r, ry);
    ctx.lineTo(-rx + r, ry);
    ctx.quadraticCurveTo(-rx, ry, -rx, ry - r);
    ctx.lineTo(-rx, -ry + r);
    ctx.quadraticCurveTo(-rx, -ry, -rx + r, -ry);
    ctx.closePath();
  }
}

/**
 * Pre-bake a tinted soft/hard tip canvas (cached by shape, aspect, corner,
 * hardness and colour). Avoids per-dab radial gradients and shadowBlur hacks.
 */
function getTipSprite(
  tip: "round" | "rect",
  aspect: number,
  corner: number,
  hardness: number,
  color: string,
): AnyCanvas {
  const aKey = Math.round(aspect * 50);
  const cKey = Math.round(corner * 20);
  const hKey = Math.round(hardness * 25);
  const key = `${tip}:${aKey}:${cKey}:${hKey}:${color}`;
  const hit = tipSpriteCache.get(key);
  if (hit) {
    tipSpriteCache.delete(key);
    tipSpriteCache.set(key, hit);
    return hit;
  }

  const S = 128;
  const half = S / 2;
  const canvas = createCanvas(S, S);
  const c = ctx2d(canvas);
  const [cr, cg, cb] = parseHex(color);
  const img = c.createImageData(S, S);
  const data = img.data;
  const rx = half * 0.92;
  const ry = Math.max(2, rx * clamp(aspect, 0.05, 1));
  const corR = Math.min(rx, ry) * clamp(corner, 0, 1);
  // Feather width as a fraction of the smaller radius (or rx for round).
  const feather = (1 - clamp(hardness, 0, 1)) * (tip === "round" ? rx : Math.min(rx, ry));

  for (let py = 0; py < S; py++) {
    const y = py + 0.5 - half;
    for (let px = 0; px < S; px++) {
      const x = px + 0.5 - half;
      let dist: number;
      if (tip === "round") {
        // Signed distance to ellipse approximated in normalised coordinates.
        const nx = x / rx;
        const ny = y / ry;
        const r = Math.hypot(nx, ny);
        dist = (r - 1) * Math.min(rx, ry);
      } else {
        // Exact SDF of a rounded box centered at origin.
        const qx = Math.abs(x) - (rx - corR);
        const qy = Math.abs(y) - (ry - corR);
        dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corR;
      }

      let alpha: number;
      if (feather < 1) {
        alpha = clamp(0.5 - dist, 0, 1);
      } else {
        // Smooth cubic falloff inside the feather zone.
        const u = clamp(-dist / feather, 0, 1);
        alpha = u * u * (3 - 2 * u);
      }

      const idx = (py * S + px) * 4;
      data[idx] = cr;
      data[idx + 1] = cg;
      data[idx + 2] = cb;
      data[idx + 3] = Math.round(alpha * 255);
    }
  }
  c.putImageData(img, 0, 0);

  if (tipSpriteCache.size >= TIP_CACHE_LIMIT) {
    const oldest = tipSpriteCache.keys().next().value;
    if (oldest) tipSpriteCache.delete(oldest);
  }
  tipSpriteCache.set(key, canvas);
  return canvas;
}

/* -------------------------------------------- */
/*  Engine 1: Outline ribbon renderers          */
/* -------------------------------------------- */

const pathCache = new WeakMap<ScribbleItem, Path2D>();

function freehandOutline(item: ScribbleItem, brush: BrushDefinition, view: View, live: boolean): Path2D {
  if (!live) {
    const cached = pathCache.get(item);
    if (cached) return cached;
  }
  const w = item.size;
  const pts = resample(item.points, spacingFor(w, view));
  const curve = brush.pressureCurve;
  const poly = outline(pts, {
    size: w,
    thinning: brush.thinning,
    smoothing: brush.smoothing,
    streamline: 0,
    easing: curve === 1 ? undefined : (p: number) => Math.pow(Math.max(0, p), curve),
    taperStart: brush.taperStart * w,
    taperEnd: live ? 0 : brush.taperEnd * w,
    cap: brush.cap,
    last: !live,
  });
  const path = outlinePath(poly);
  if (!live) pathCache.set(item, path);
  return path;
}

function paintInk(ctx: Ctx2D, item: ScribbleItem, view: View, brush: BrushDefinition, live: boolean): void {
  const path = freehandOutline(item, brush, view, live);
  ctx.fillStyle = item.color;
  withHalo(ctx, item, view, () => ctx.fill(path, "nonzero"));
}

function paintPencil(ctx: Ctx2D, item: ScribbleItem, view: View, brush: BrushDefinition, live: boolean): void {
  const path = freehandOutline(item, brush, view, live);
  const params = resolveBrushParams(brush, item.style.brush);
  ctx.fillStyle = item.color;
  ctx.fill(path, "nonzero");
  // Seamless Simplex cold-press paper tooth; average pressure modulates how much tooth shows through.
  let avgP = 0.5;
  if (item.points.length >= 3) {
    let sum = 0;
    const n = item.points.length / 3;
    for (let i = 0; i < n; i++) sum += item.points[i * 3 + 2]!;
    avgP = sum / n;
  }
  const strength = clamp(params.grain * (1.15 - avgP * 0.45), 0.12, 0.92);
  const pattern = grainPattern(ctx, "graphite", 0.7 / Math.max(0.25, Math.min(4, view.scale)));
  if (pattern && strength > 0.01) {
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = strength;
    ctx.fillStyle = pattern;
    ctx.fill(path, "nonzero");
    ctx.restore();
  }
}

function paintSoft(ctx: Ctx2D, item: ScribbleItem, view: View, brush: BrushDefinition, live: boolean): void {
  const path = freehandOutline(item, brush, view, live);
  const params = resolveBrushParams(brush, item.style.brush);
  const softness = (1 - params.hardness) * 0.58 + brush.softness * 0.25;
  const blur = Math.max(1, item.size * softness * view.scale);
  const OFF = 20000;
  ctx.save();
  ctx.translate(-OFF / view.scale, 0);
  ctx.shadowColor = item.color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = OFF;
  ctx.fillStyle = item.color;
  ctx.fill(path, "nonzero");
  ctx.fill(path, "nonzero");
  ctx.restore();
}

/** Organic watercolor wash: soft Simplex pigment granulation + darkened wet-edge pooling. */
function paintWatercolor(ctx: Ctx2D, item: ScribbleItem, view: View, brush: BrushDefinition, live: boolean): void {
  const path = freehandOutline(item, brush, view, live);
  const params = resolveBrushParams(brush, item.style.brush);
  const w = item.size;

  // 1. Translucent pigment base.
  ctx.save();
  ctx.fillStyle = item.color;
  ctx.globalAlpha = 0.78;
  ctx.fill(path, "nonzero");

  // 2. Organic watercolor granulation (Simplex clouds).
  const gran = grainPattern(ctx, "watercolor", Math.max(0.35, w * 0.06));
  if (gran && params.grain > 0.01) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = clamp(params.grain * 0.55, 0.05, 0.65);
    ctx.fillStyle = gran;
    ctx.fill(path, "nonzero");
  }

  // 3. Darkened wet edge (clipped inside the stroke outline).
  ctx.globalCompositeOperation = "source-atop";
  ctx.strokeStyle = mixHex(item.color, "#000000", 0.35);
  ctx.lineWidth = Math.max(w * 0.14, 1.2 / view.scale);
  ctx.globalAlpha = 0.52;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke(path);
  ctx.restore();
}

/** Luminous neon / spell-glow stroke: layered coloured aura + white-hot core. */
function paintNeon(ctx: Ctx2D, item: ScribbleItem, view: View, brush: BrushDefinition, live: boolean): void {
  const path = freehandOutline(item, brush, view, live);
  const w = item.size;
  const glow = Math.max(3, w * brush.softness * view.scale);
  ctx.save();
  // Outer aura
  ctx.shadowColor = item.color;
  ctx.shadowBlur = glow * 1.4;
  ctx.fillStyle = item.color;
  ctx.fill(path, "nonzero");
  // Inner tighter glow
  ctx.shadowBlur = glow * 0.45;
  ctx.fill(path, "nonzero");
  // White-hot centre core
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.strokeStyle = mixHex(item.color, "#ffffff", 0.78);
  ctx.lineWidth = Math.max(w * 0.32, 1 / view.scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const corePts = resample(item.points, spacingFor(w, view) * 1.5);
  ctx.stroke(centerPath(corePts));
  ctx.restore();
}

/* -------------------------------------------- */
/*  Engine 2: Parameterised Swept Nib Hull      */
/* -------------------------------------------- */

/** Generate vertices of an oriented rectangle (or rounded rectangle when `corner > 0`). */
function nibFootprint(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  ang: number,
  corner: number,
): [number, number][] {
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const xform = (lx: number, ly: number): [number, number] => [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];
  const r = Math.min(halfW, halfH) * clamp(corner, 0, 1);
  if (r <= 0.02) {
    return [xform(halfW, halfH), xform(-halfW, halfH), xform(-halfW, -halfH), xform(halfW, -halfH)];
  }
  const ix = halfW - r;
  const iy = halfH - r;
  const pts: [number, number][] = [];
  const corners: [number, number, number][] = [
    [ix, iy, 0],
    [-ix, iy, Math.PI / 2],
    [-ix, -iy, Math.PI],
    [ix, -iy, Math.PI * 1.5],
  ];
  for (const [ox, oy, a0] of corners) {
    for (let k = 0; k <= 2; k++) {
      const a = a0 + (k / 2) * (Math.PI / 2);
      pts.push(xform(ox + Math.cos(a) * r, oy + Math.sin(a) * r));
    }
  }
  return pts;
}

/** Parameterised swept rectangular / chisel nib, filled once (zero overlap darkening). */
function paintChisel(ctx: Ctx2D, item: ScribbleItem, view: View, brush: BrushDefinition, live: boolean): void {
  const w = item.size;
  const params = resolveBrushParams(brush, item.style.brush);
  const step = Math.max(w * 0.14, 0.6);
  const list = buildSpaceSamples(item, step);
  if (!list.length) return;

  const footprintAt = (s: SpaceSample): [number, number][] => {
    const p = brush.pressure ? Math.pow(clamp(s.p, 0.05, 1), brush.pressureCurve) : 0.5;
    const scale = brush.pressure ? clamp(1 - brush.thinning * (0.5 - p) * 2, 0.18, 1.35) : 1;
    const hw = (w * scale) / 2;
    const hh = Math.max(0.25, hw * clamp(params.aspect, 0.05, 1));
    return nibFootprint(s.x, s.y, hw, hh, sampleAngle(s, params), params.corner);
  };

  const path = new Path2D();
  if (list.length === 1) {
    addHull(path, footprintAt(list[0]!));
  } else {
    let prev = footprintAt(list[0]!);
    for (let i = 1; i < list.length; i++) {
      const cur = footprintAt(list[i]!);
      addHull(path, [...prev, ...cur]);
      prev = cur;
    }
  }
  ctx.fillStyle = item.color;
  withHalo(ctx, item, view, () => ctx.fill(path, "nonzero"));
  void live;
}

/** Add the convex hull of `pts` (monotone chain, counter-clockwise) as a sub-path. */
function addHull(path: Path2D, pts: [number, number][]): void {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length < 3) return;
  path.moveTo(hull[0]![0], hull[0]![1]);
  for (let k = 1; k < hull.length; k++) path.lineTo(hull[k]![0], hull[k]![1]);
  path.closePath();
}

/* -------------------------------------------- */
/*  Engine 3: Parametric Dab / Stamp Engine     */
/* -------------------------------------------- */

interface DabContext {
  ctx: Ctx2D;
  item: ScribbleItem;
  brush: BrushDefinition;
  params: ResolvedBrushParams;
  rand: () => number;
  noise: ((x: number, y: number) => number) | null;
  bristleSpec: { offset: number; width: number; alpha: number; phase: number }[] | null;
}

function makeBristleSpec(count: number, seed: number) {
  const rand = rng(seed ^ 0x4b1d2e3f);
  const n = Math.max(4, count);
  const out: { offset: number; width: number; alpha: number; phase: number }[] = [];
  for (let i = 0; i < n; i++) {
    const baseOff = n === 1 ? 0 : i / (n - 1) - 0.5;
    const jitter = (rand() - 0.5) * (0.7 / n);
    out.push({
      offset: clamp(baseOff + jitter, -0.5, 0.5),
      width: 0.45 + rand() * 0.75,
      alpha: 0.35 + rand() * 0.65,
      phase: rand() * 100,
    });
  }
  return out;
}

function emitSingleDab(dc: DabContext, s: SpaceSample): void {
  const { ctx, item, brush, params, rand } = dc;
  const w = item.size;
  const pressure = brush.pressure ? Math.pow(clamp(s.p, 0.05, 1), brush.pressureCurve) : 0.6;
  const sizeScale = brush.pressure ? clamp(1 - brush.thinning * (0.5 - pressure) * 2, 0.18, 1.35) : 1;
  const dabW = w * sizeScale;
  const dabH = Math.max(0.4, dabW * clamp(params.aspect, 0.05, 1));
  const ang = sampleAngle(s, params);

  if (brush.pixelAligned) {
    const cell = Math.max(0.5, w);
    const gx = Math.floor(s.x / cell) * cell;
    const gy = Math.floor(s.y / cell) * cell;
    ctx.fillStyle = item.color;
    ctx.fillRect(gx, gy, cell, cell);
    return;
  }

  if (brush.tip === "bristle" && dc.bristleSpec) {
    const nx = -Math.sin(ang);
    const ny = Math.cos(ang);
    const tx = Math.cos(ang);
    const ty = Math.sin(ang);
    const noise = dc.noise!;
    const fiberBaseW = Math.max(0.45, (dabW / dc.bristleSpec.length) * 1.15);
    ctx.fillStyle = item.color;
    for (const f of dc.bristleSpec) {
      const wobble = noise(s.run * 0.045 + f.phase, f.offset * 6) * dabW * 0.06;
      const lateral = f.offset * dabW + wobble;
      const fx = s.x + nx * lateral;
      const fy = s.y + ny * lateral;
      const fw = fiberBaseW * f.width;
      const fh = Math.max(0.4, dabH * 0.55);
      const density = clamp((0.55 + 0.55 * pressure) * params.flow * f.alpha, 0.04, 1);
      ctx.save();
      ctx.globalAlpha = density;
      ctx.translate(fx, fy);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.ellipse(0, 0, fh / 2, fw / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    void tx;
    void ty;
    return;
  }

  // Splatter / multi-droplet scatter mode
  if (brush.id === "splatter" || params.scatter >= 0.6) {
    const drops = Math.max(2, Math.min(10, Math.round(3 + params.scatter * 3.5)));
    ctx.fillStyle = item.color;
    for (let k = 0; k < drops; k++) {
      const a = rand() * Math.PI * 2;
      const dist = Math.pow(rand(), 0.75) * w * params.scatter;
      const dr = dabW * (0.06 + Math.pow(rand(), 1.8) * 0.24);
      const sx = s.x + Math.cos(a) * dist;
      const sy = s.y + Math.sin(a) * dist;
      ctx.globalAlpha = clamp(params.flow * (0.45 + rand() * 0.55) * (0.4 + pressure * 0.7), 0.05, 1);
      ctx.beginPath();
      ctx.arc(sx, sy, dr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return;
  }

  // Scatter offset (chalk / charcoal / textured brush)
  let dx = 0;
  let dy = 0;
  if (params.scatter > 0) {
    const a = rand() * Math.PI * 2;
    const dist = Math.sqrt(rand()) * w * params.scatter * 0.6;
    dx = Math.cos(a) * dist;
    dy = Math.sin(a) * dist;
  }
  const px = s.x + dx;
  const py = s.y + dy;

  // Soft / feathered tips or semi-soft rectangular tips use pre-baked sprite cache.
  if (params.hardness < 0.96) {
    const sprite = getTipSprite(
      brush.tip === "rect" ? "rect" : "round",
      params.aspect,
      params.corner,
      params.hardness,
      item.color,
    );
    const drawSize = dabW / 0.92;
    const flowAlpha = clamp(params.flow * (brush.pressure ? 0.35 + pressure * 0.75 : 1), 0.02, 1);
    ctx.save();
    ctx.globalAlpha = flowAlpha;
    ctx.translate(px, py);
    if (ang !== 0) ctx.rotate(ang);
    ctx.drawImage(sprite as CanvasImageSource, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
    ctx.restore();
    return;
  }

  // Crisp hard-edge dab (chalk / hard round / hard rect).
  ctx.save();
  ctx.globalAlpha = clamp(params.flow * (brush.pressure ? 0.4 + pressure * 0.7 : 1), 0.04, 1);
  ctx.fillStyle = item.color;
  ctx.translate(px, py);
  if (ang !== 0) ctx.rotate(ang);
  if (brush.tip === "rect") {
    drawRoundedRectPath(ctx, dabW / 2, dabH / 2, params.corner);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.ellipse(0, 0, dabW / 2, dabH / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function paintDab(ctx: Ctx2D, item: ScribbleItem, brush: BrushDefinition): void {
  const w = item.size;
  const params = resolveBrushParams(brush, item.style.brush);
  const rawStep = brush.pixelAligned ? Math.max(0.25, w * 0.25) : Math.max(0.2, w * params.spacing);
  const list = buildSpaceSamples(item, Math.min(rawStep * 0.75, Math.max(0.4, w * 0.25)));
  if (!list.length) return;

  const totalRun = list.at(-1)!.run;
  const step = Math.max(rawStep, totalRun / MAX_DABS_PER_ITEM);
  const seed = hashString(item.id);
  const rand = rng(seed);
  const noise = brush.tip === "bristle" ? seededNoise2D(seed ^ 0x91e10da5) : null;
  const bristleSpec = brush.tip === "bristle" ? makeBristleSpec(brush.bristles || 12, seed) : null;

  const dc: DabContext = { ctx, item, brush, params, rand, noise, bristleSpec };

  if (brush.pixelAligned) ctx.imageSmoothingEnabled = false;

  emitSingleDab(dc, list[0]!);
  let nextRun = step;
  let emitted = 1;
  for (let i = 1; i < list.length && emitted < MAX_DABS_PER_ITEM; i++) {
    const s = list[i]!;
    if (s.run < nextRun) continue;
    const prev = list[i - 1]!;
    const seg = s.run - prev.run;
    while (nextRun <= s.run && emitted < MAX_DABS_PER_ITEM) {
      const f = seg > 1e-6 ? clamp((nextRun - prev.run) / seg, 0, 1) : 1;
      const interp: SpaceSample = {
        x: prev.x + (s.x - prev.x) * f,
        y: prev.y + (s.y - prev.y) * f,
        p: prev.p + (s.p - prev.p) * f,
        ang: Number.isFinite(prev.ang) && Number.isFinite(s.ang) ? lerpAngle(prev.ang, s.ang, f) : s.ang,
        tan: lerpAngle(prev.tan, s.tan, f),
        run: nextRun,
      };
      emitSingleDab(dc, interp);
      nextRun += step;
      emitted++;
    }
  }

  // Apply seamless procedural grain over the stroke.
  if (params.grain > 0.01 && brush.grainKind !== "none") {
    const cell = brush.grainKind === "canvas" ? 0.55 : brush.grainKind === "chalk" ? 0.85 : 0.7;
    const pattern = grainPattern(ctx, brush.grainKind, cell);
    if (pattern) {
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = clamp(params.grain * 0.78, 0.05, 0.85);
      ctx.fillStyle = pattern;
      // Punch only inside existing stroke alpha by filling the item's bounding box in space units.
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const s of list) {
        if (s.x < minX) minX = s.x;
        if (s.y < minY) minY = s.y;
        if (s.x > maxX) maxX = s.x;
        if (s.y > maxY) maxY = s.y;
      }
      const pad = w * (1 + params.scatter) + 4;
      ctx.fillRect(minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2);
      ctx.restore();
    }
  }
}

/* -------------------------------------------- */
/*  Mono, shapes, areas, text                   */
/* -------------------------------------------- */

function headsOf(item: ScribbleItem): { start: boolean; end: boolean } {
  const head = item.style.head ?? (item.kind === "shape" && item.tool === "arrow" ? "end" : "none");
  return { start: head === "both", end: head === "end" || head === "both" };
}

function strokeLine(ctx: Ctx2D, item: ScribbleItem, view: View, flat: readonly number[], closed: boolean): void {
  const w = item.size;
  const heads = closed ? { start: false, end: false } : headsOf(item);
  const headLen = arrowHeadLength(w);
  const path = centerPath(flat, closed, heads.start ? headLen * 0.7 : 0, heads.end ? headLen * 0.7 : 0);
  ctx.lineWidth = w;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = item.color;
  ctx.fillStyle = item.color;
  if (item.style.dash) ctx.setLineDash([w * 2.2, w * 2.4]);
  ctx.stroke(path);
  ctx.setLineDash([]);
  const n = flat.length / 3;
  if (n >= 2 && (heads.start || heads.end)) {
    const drawHead = (fromEnd: boolean) => {
      const tip: Pt = fromEnd ? { x: flat[(n - 1) * 3]!, y: flat[(n - 1) * 3 + 1]! } : { x: flat[0]!, y: flat[1]! };
      const ref = pathTailReference(flat, fromEnd, headLen * 1.2);
      const [t, l, r] = arrowHead(ref, tip, w);
      const head = new Path2D();
      head.moveTo(t.x, t.y);
      head.lineTo(l.x, l.y);
      head.quadraticCurveTo(tip.x * 0.15 + (l.x + r.x) * 0.425, tip.y * 0.15 + (l.y + r.y) * 0.425, r.x, r.y);
      head.closePath();
      ctx.lineWidth = Math.max(w * 0.35, 0.5 / view.scale);
      ctx.stroke(head);
      ctx.fill(head);
    };
    if (heads.end) drawHead(true);
    if (heads.start) drawHead(false);
  }
}

function paintMono(ctx: Ctx2D, item: ScribbleItem, view: View, _brush: BrushDefinition, live: boolean): void {
  const pts = live ? item.points : resample(item.points, spacingFor(item.size, view) * 2);
  withHalo(ctx, item, view, () => strokeLine(ctx, item, view, pts, false));
}

function paintShape(ctx: Ctx2D, item: ScribbleItem, view: View): void {
  const p = item.points;
  const w = item.size;
  if (usesRough(item)) {
    withHalo(ctx, item, view, () => {
      paintRoughShape(ctx, item);
      // Still draw crisp arrow heads when tool === "arrow".
      if (item.tool === "arrow" && p.length >= 6) {
        const heads = headsOf(item);
        const headLen = arrowHeadLength(w);
        const drawHead = (fromEnd: boolean) => {
          const tip: Pt = fromEnd ? { x: p[3]!, y: p[4]! } : { x: p[0]!, y: p[1]! };
          const ref = pathTailReference(p.slice(0, 6), fromEnd, headLen * 1.2);
          const [t, l, r] = arrowHead(ref, tip, w);
          const head = new Path2D();
          head.moveTo(t.x, t.y);
          head.lineTo(l.x, l.y);
          head.lineTo(r.x, r.y);
          head.closePath();
          ctx.fillStyle = item.color;
          ctx.fill(head);
        };
        if (heads.end) drawHead(true);
        if (heads.start) drawHead(false);
      }
    });
    return;
  }
  withHalo(ctx, item, view, () => {
    ctx.lineWidth = w;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = item.color;
    if (item.tool === "line" || item.tool === "arrow") {
      strokeLine(ctx, item, view, p.slice(0, 6), false);
      return;
    }
    let path: Path2D;
    if (item.tool === "rect") {
      path = new Path2D();
      path.rect(p[0]!, p[1]!, p[3]! - p[0]!, p[4]! - p[1]!);
    } else if (item.tool === "ellipse") {
      path = new Path2D();
      const rx = Math.abs(p[3]! - p[0]!) / 2;
      const ry = Math.abs(p[4]! - p[1]!) / 2;
      path.ellipse((p[0]! + p[3]!) / 2, (p[1]! + p[4]!) / 2, Math.max(rx, 0.01), Math.max(ry, 0.01), 0, 0, Math.PI * 2);
    } else {
      path = new Path2D();
      path.moveTo(p[0]!, p[1]!);
      for (let i = 3; i + 1 < p.length; i += 3) path.lineTo(p[i]!, p[i + 1]!);
      if (item.style.closed) path.closePath();
    }
    const fill = item.style.fill ?? 0;
    if (fill > 0 && (item.tool !== "polygon" || item.style.closed)) {
      ctx.save();
      ctx.shadowColor = "transparent";
      ctx.globalAlpha *= fill;
      ctx.fillStyle = item.color;
      ctx.fill(path);
      ctx.restore();
    }
    if (item.style.dash) ctx.setLineDash([w * 2.2, w * 2.4]);
    ctx.stroke(path);
    ctx.setLineDash([]);
  });
}

function paintArea(ctx: Ctx2D, item: ScribbleItem, view: View): void {
  if (usesRough(item)) {
    paintRoughArea(ctx, item);
    return;
  }
  const pts = resample(item.points, spacingFor(item.size, view) * 2);
  const path = centerPath(pts, true);
  ctx.save();
  ctx.globalAlpha *= item.style.fill ?? 0.3;
  ctx.fillStyle = item.color;
  ctx.fill(path, "nonzero");
  ctx.restore();
  ctx.lineWidth = item.size;
  ctx.lineJoin = "round";
  ctx.strokeStyle = item.color;
  ctx.globalAlpha *= 0.9;
  if (item.style.dash) ctx.setLineDash([item.size * 2.2, item.size * 2.4]);
  ctx.stroke(path);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

export const TEXT_FONT = `"Signika", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`;
export const TEXT_LINE_HEIGHT = 1.25;

function paintText(ctx: Ctx2D, item: ScribbleItem): void {
  const size = item.size;
  const x = item.points[0]!;
  const y = item.points[1]!;
  ctx.font = `600 ${size}px ${TEXT_FONT}`;
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  const lines = (item.text ?? "").split("\n");
  lines.forEach((line, i) => {
    const ly = y + i * size * TEXT_LINE_HEIGHT;
    ctx.lineWidth = size * 0.18;
    ctx.strokeStyle = haloColor(item.color);
    ctx.strokeText(line, x, ly);
    ctx.fillStyle = item.color;
    ctx.fillText(line, x, ly);
  });
}

/* -------------------------------------------- */
/*  Pro Eraser Masks                            */
/* -------------------------------------------- */

function applyMasks(ctx: Ctx2D, item: ScribbleItem, view: View): void {
  if (!item.erase?.length) return;
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#000";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const m of item.erase) {
    const hrd = m.hrd ?? 1;
    if (m.tip === "rect") {
      // Rectangular swept eraser nib.
      const ang = ((m.ang ?? 0) * Math.PI) / 180;
      const hw = m.size / 2;
      const hh = Math.max(0.5, hw * clamp(m.asp ?? 0.5, 0.1, 1));
      const pts = resample(m.points, Math.max(0.4, m.size * 0.25));
      const n = pts.length / 3;
      const path = new Path2D();
      if (n === 1) {
        addHull(path, nibFootprint(pts[0]!, pts[1]!, hw, hh, ang, 0));
      } else {
        let prev = nibFootprint(pts[0]!, pts[1]!, hw, hh, ang, 0);
        for (let i = 1; i < n; i++) {
          const cur = nibFootprint(pts[i * 3]!, pts[i * 3 + 1]!, hw, hh, ang, 0);
          addHull(path, [...prev, ...cur]);
          prev = cur;
        }
      }
      if (hrd < 0.95) {
        ctx.save();
        ctx.shadowColor = "#000";
        ctx.shadowBlur = Math.max(1, m.size * (1 - hrd) * 0.5 * view.scale);
        ctx.fill(path, "nonzero");
        ctx.restore();
      } else {
        ctx.fill(path, "nonzero");
      }
      continue;
    }
    ctx.lineWidth = m.size;
    const pts = resample(m.points, spacingFor(m.size, view) * 2);
    const p = centerPath(pts);
    if (hrd < 0.95) {
      ctx.save();
      ctx.shadowColor = "#000";
      ctx.shadowBlur = Math.max(1, m.size * (1 - hrd) * 0.5 * view.scale);
      ctx.stroke(p);
      ctx.restore();
    } else {
      ctx.stroke(p);
    }
  }
  ctx.restore();
}

/* -------------------------------------------- */
/*  Entry points                                */
/* -------------------------------------------- */

/**
 * Paint one item at full opacity into `ctx` (which must contain nothing
 * else in the item's area: erase masks and grain use destination-out).
 * Laser items are animated by the renderer and are not painted here.
 */
export function paintItemLayer(ctx: Ctx2D, item: ScribbleItem, view: View, live = false): void {
  ctx.save();
  applyView(ctx, view);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  switch (item.kind) {
    case "stroke": {
      const brush = BRUSHES[item.tool as BrushId];
      if (!brush) break;
      if (brush.renderer === "dab") {
        paintDab(ctx, item, brush);
        break;
      }
      const render = {
        ink: paintInk,
        pencil: paintPencil,
        soft: paintSoft,
        chisel: paintChisel,
        mono: paintMono,
        watercolor: paintWatercolor,
        neon: paintNeon,
      }[brush.renderer];
      render(ctx, item, view, brush, live);
      break;
    }
    case "shape":
      paintShape(ctx, item, view);
      break;
    case "area":
      paintArea(ctx, item, view);
      break;
    case "text":
      paintText(ctx, item);
      break;
    case "laser":
      break;
  }
  applyMasks(ctx, item, view);
  ctx.restore();
}

/** Scratch layer used to composite single items into shared tiles. */
let scratch: AnyCanvas | null = null;

/**
 * Composite an item into a shared canvas (cache tile) with its opacity and
 * blend mode, through a scratch layer limited to `region` (device px of the target).
 */
export function compositeItem(
  target: Ctx2D,
  item: ScribbleItem,
  view: View,
  region: { x: number; y: number; w: number; h: number },
  alpha = 1,
): void {
  const rw = Math.ceil(region.w);
  const rh = Math.ceil(region.h);
  if (rw <= 0 || rh <= 0) return;
  if (!scratch || scratch.width < rw || scratch.height < rh) {
    scratch = createCanvas(Math.max(rw, scratch?.width ?? 0), Math.max(rh, scratch?.height ?? 0));
  }
  const s = ctx2d(scratch);
  s.setTransform(1, 0, 0, 1, 0, 0);
  s.clearRect(0, 0, rw, rh);
  paintItemLayer(s, item, { scale: view.scale, ox: view.ox - region.x, oy: view.oy - region.y });
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalCompositeOperation = toCanvasBlend(effectiveBlend(item));
  target.globalAlpha = Math.max(0, Math.min(1, item.opacity * alpha));
  target.drawImage(scratch as CanvasImageSource, 0, 0, rw, rh, region.x, region.y, rw, rh);
  target.restore();
}

/** Forget cached geometry (e.g. after an item's points changed in place). */
export function invalidatePath(item: ScribbleItem): void {
  pathCache.delete(item);
}

/** Exported for testing/preview helpers. */
export { samples };
