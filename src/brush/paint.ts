import { resample } from "../core/geometry.ts";
import type { ScribbleItem } from "../core/types.ts";
import { hashString, luminance, rng } from "../core/util.ts";
import { BRUSHES } from "./brushes.ts";
import type { BrushDefinition } from "./brushes.ts";
import { outline, samples } from "./freehand.ts";
import { arrowHead, arrowHeadLength, pathTailReference } from "./shapes.ts";
import type { Pt } from "./shapes.ts";

/**
 * Canvas 2D painters. Every visual difference between brushes lives here.
 *
 * Coordinates are item space units; the caller sets up `view` so that
 * device pixel = unit × scale + offset. Painters draw the item at *full*
 * opacity into a context that holds nothing else (an item canvas or a
 * scratch layer) — that is what allows erase masks (`destination-out`) and
 * multi-pass brushes (halo, grain) without touching other items. The item's
 * own opacity is applied by whoever composites the layer.
 */

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface View {
  /** Device pixels per space unit. */
  scale: number;
  ox: number;
  oy: number;
}

export function createCanvas(width: number, height: number): AnyCanvas {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export function ctx2d(canvas: AnyCanvas): Ctx2D {
  const ctx = canvas.getContext("2d") as Ctx2D | null;
  if (!ctx) throw new Error("CanvasScribble: 2D canvas context unavailable");
  return ctx;
}

const applyView = (ctx: Ctx2D, v: View) => ctx.setTransform(v.scale, 0, 0, v.scale, v.ox, v.oy);

/* -------------------------------------------- */
/*  Procedural grain                            */
/* -------------------------------------------- */

const GRAIN_SIZE = 96;
const grainTiles = new Map<string, AnyCanvas>();
const patternCache = new WeakMap<Ctx2D, Map<string, CanvasPattern>>();

/** Small seeded noise tiles (a few KB in memory, no image assets). */
function grainTile(kind: "graphite" | "chalk"): AnyCanvas {
  let tile = grainTiles.get(kind);
  if (tile) return tile;
  tile = createCanvas(GRAIN_SIZE, GRAIN_SIZE);
  const c = ctx2d(tile);
  const img = c.createImageData(GRAIN_SIZE, GRAIN_SIZE);
  const rand = rng(kind === "graphite" ? 0x9e3779b9 : 0x7f4a7c15);
  for (let i = 0; i < GRAIN_SIZE * GRAIN_SIZE; i++) {
    let a: number;
    if (kind === "graphite") {
      // Fine paper tooth: many faint holes, a few strong ones.
      const r = rand();
      a = r > 0.86 ? 230 : r > 0.55 ? 110 : r > 0.3 ? 40 : 0;
    } else {
      // Chalk: clumpy holes with strong contrast.
      const r = rand() * 0.6 + rand() * 0.4;
      a = r > 0.62 ? 255 : r > 0.48 ? 120 : 0;
    }
    img.data[i * 4 + 3] = a;
  }
  c.putImageData(img, 0, 0);
  grainTiles.set(kind, tile);
  return tile;
}

/** A grain pattern anchored to space-unit origin, so neighbouring tiles of a cache line up. */
function grainPattern(ctx: Ctx2D, kind: "graphite" | "chalk", unitsPerCell: number): CanvasPattern | null {
  let map = patternCache.get(ctx);
  if (!map) patternCache.set(ctx, (map = new Map()));
  let pattern = map.get(kind);
  if (!pattern) {
    pattern = ctx.createPattern(grainTile(kind) as CanvasImageSource, "repeat") ?? undefined;
    if (!pattern) return null;
    map.set(kind, pattern);
  }
  if (typeof DOMMatrix !== "undefined") pattern.setTransform(new DOMMatrix().scale(unitsPerCell));
  return pattern;
}

/* -------------------------------------------- */
/*  Helpers                                     */
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

/* -------------------------------------------- */
/*  Freehand renderers                          */
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
  ctx.fillStyle = item.color;
  ctx.fill(path, "nonzero");
  // Paper tooth: punch grain holes into the graphite.
  const pattern = grainPattern(ctx, "graphite", 1.15 / view.scale);
  if (pattern) {
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = 0.62;
    ctx.fillStyle = pattern;
    ctx.fill(path, "nonzero");
    ctx.restore();
  }
}

function paintSoft(ctx: Ctx2D, item: ScribbleItem, view: View, brush: BrushDefinition, live: boolean): void {
  const path = freehandOutline(item, brush, view, live);
  const blur = Math.max(1, item.size * brush.softness * view.scale);
  // Draw only the blurred shadow of the shape: the shape itself is moved far
  // out of the canvas and the shadow is offset back (works in every browser,
  // unlike ctx.filter).
  const OFF = 20000;
  ctx.save();
  ctx.translate(-OFF / view.scale, 0);
  ctx.shadowColor = item.color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = OFF;
  ctx.fillStyle = item.color;
  ctx.fill(path, "nonzero");
  ctx.fill(path, "nonzero"); // second pass gives a denser core
  ctx.restore();
}

function paintChalk(ctx: Ctx2D, item: ScribbleItem, view: View, brush: BrushDefinition, live: boolean): void {
  const w = item.size;
  const list = samples(resample(item.points, spacingFor(w, view)), { size: w, streamline: 0, last: !live });
  const rand = rng(hashString(item.id));
  const path = new Path2D();
  const step = Math.max(w * 0.14, 0.7 / view.scale);
  let nextRun = 0;
  for (const s of list) {
    if (s.run < nextRun) continue;
    nextRun = s.run + step;
    const pressure = Math.pow(Math.max(0.05, s.pressure), brush.pressureCurve);
    const r = (w / 2) * (1 - brush.thinning * (0.5 - pressure) * 2) * (0.92 + rand() * 0.16);
    const dots = Math.min(18, 5 + Math.round(r * view.scale * 0.25));
    for (let k = 0; k < dots; k++) {
      // Denser towards the centre, ragged at the edge.
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * r;
      const dr = r * (0.1 + rand() * 0.16);
      path.rect(s.x + Math.cos(a) * d - dr, s.y + Math.sin(a) * d - dr, dr * 2, dr * 2);
    }
  }
  ctx.fillStyle = item.color;
  ctx.fill(path, "nonzero");
  const pattern = grainPattern(ctx, "chalk", 1.6 / view.scale);
  if (pattern) {
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = pattern;
    ctx.fill(path, "nonzero");
    ctx.restore();
  }
}

/** Chisel nib at a fixed angle swept along the path, filled once (no overlap darkening). */
function paintChisel(ctx: Ctx2D, item: ScribbleItem, view: View, brush: BrushDefinition, live: boolean): void {
  const w = item.size;
  const list = samples(resample(item.points, spacingFor(w, view)), { size: w, streamline: 0, last: !live });
  if (!list.length) return;
  const ang = (-38 * Math.PI) / 180;
  const nx = (Math.cos(ang) * w) / 2;
  const ny = (Math.sin(ang) * w) / 2;
  const tx = -ny * 0.22;
  const ty = nx * 0.22;
  const corners = (s: { x: number; y: number }): [number, number][] => [
    [s.x + nx + tx, s.y + ny + ty],
    [s.x - nx + tx, s.y - ny + ty],
    [s.x - nx - tx, s.y - ny - ty],
    [s.x + nx - tx, s.y + ny - ty],
  ];
  const path = new Path2D();
  if (list.length === 1) addHull(path, corners(list[0]!));
  // The nib swept from one sample to the next is the convex hull of both
  // footprints; all hulls share one winding, so the nonzero fill is their union.
  for (let i = 1; i < list.length; i++) addHull(path, [...corners(list[i - 1]!), ...corners(list[i]!)]);
  ctx.fillStyle = item.color;
  ctx.fill(path, "nonzero");
  void brush;
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

/* -------------------------------------------- */
/*  Shapes, areas, text                         */
/* -------------------------------------------- */

function paintShape(ctx: Ctx2D, item: ScribbleItem, view: View): void {
  const p = item.points;
  const w = item.size;
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
      // polygon / polyline: straight segments
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
/*  Entry points                                */
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
    ctx.lineWidth = m.size;
    const pts = resample(m.points, spacingFor(m.size, view) * 2);
    ctx.stroke(centerPath(pts));
  }
  ctx.restore();
}

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
      const brush = BRUSHES[item.tool as keyof typeof BRUSHES];
      if (!brush) break;
      const render = {
        ink: paintInk,
        pencil: paintPencil,
        soft: paintSoft,
        chalk: paintChalk,
        chisel: paintChisel,
        mono: paintMono,
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
 * Composite an item into a shared canvas (cache tile) with its opacity,
 * through a scratch layer limited to `region` (device px of the target).
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
  target.globalCompositeOperation = "source-over";
  target.globalAlpha = Math.max(0, Math.min(1, item.opacity * alpha));
  target.drawImage(scratch as CanvasImageSource, 0, 0, rw, rh, region.x, region.y, rw, rh);
  target.restore();
}

/** Forget cached geometry (e.g. after an item's points changed in place). */
export function invalidatePath(item: ScribbleItem): void {
  pathCache.delete(item);
}
