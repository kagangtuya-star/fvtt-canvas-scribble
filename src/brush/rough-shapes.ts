import rough from "roughjs/bundled/rough.esm.js";
import type { RoughDrawable, RoughOptions } from "roughjs/bundled/rough.esm.js";
import type { FillPattern, ScribbleItem } from "../core/types.ts";
import { hashString } from "../core/util.ts";
import type { Ctx2D } from "./texture.ts";

/**
 * Hand-drawn sketchy shape & pattern-fill renderer powered by `roughjs`.
 *
 * Uses `rough.generator()` directly and replays op-sets onto any Canvas 2D
 * context (`HTMLCanvasElement` or `OffscreenCanvas`) with a deterministic seed
 * derived from `item.id`, guaranteeing identical rendering across all clients
 * and tile cache zoom tiers.
 */

const gen = rough.generator();

function replayOps(ctx: Ctx2D, ops: RoughDrawable["sets"][number]["ops"]): Path2D {
  const path = new Path2D();
  for (const op of ops) {
    const d = op.data;
    if (op.op === "move") path.moveTo(d[0]!, d[1]!);
    else if (op.op === "lineTo") path.lineTo(d[0]!, d[1]!);
    else if (op.op === "bcurveTo") path.bezierCurveTo(d[0]!, d[1]!, d[2]!, d[3]!, d[4]!, d[5]!);
  }
  return path;
}

function drawDrawable(
  ctx: Ctx2D,
  drawable: RoughDrawable,
  color: string,
  strokeWidth: number,
  fillAlpha: number,
  dash: boolean,
): void {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const set of drawable.sets) {
    const path = replayOps(ctx, set.ops);
    if (set.type === "fillPath") {
      if (fillAlpha <= 0) continue;
      ctx.save();
      ctx.shadowColor = "transparent";
      ctx.globalAlpha *= fillAlpha;
      ctx.fillStyle = color;
      ctx.fill(path);
      ctx.restore();
    } else if (set.type === "fillSketch") {
      if (fillAlpha <= 0) continue;
      ctx.save();
      ctx.shadowColor = "transparent";
      ctx.globalAlpha *= Math.min(1, fillAlpha * 1.8);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.75, strokeWidth * 0.55);
      ctx.setLineDash([]);
      ctx.stroke(path);
      ctx.restore();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = strokeWidth;
      if (dash) ctx.setLineDash([strokeWidth * 2.2, strokeWidth * 2.4]);
      ctx.stroke(path);
      ctx.setLineDash([]);
    }
  }
}

function roughFillStyle(pattern: FillPattern | undefined): RoughOptions["fillStyle"] {
  switch (pattern) {
    case "hachure":
      return "hachure";
    case "cross-hatch":
      return "cross-hatch";
    case "dots":
      return "dots";
    default:
      return "solid";
  }
}

/** True when a shape or area requests hand-drawn roughness or a patterned fill. */
export function usesRough(item: ScribbleItem): boolean {
  const rgh = item.style.brush?.rgh ?? 0;
  const pat = item.style.fillPattern;
  return rgh > 0.01 || (pat !== undefined && pat !== "solid");
}

export function paintRoughShape(ctx: Ctx2D, item: ScribbleItem): void {
  const p = item.points;
  const w = item.size;
  const rgh = item.style.brush?.rgh ?? 0;
  const fill = item.style.fill ?? 0;
  const closed = item.tool !== "polygon" || !!item.style.closed;
  const seed = hashString(item.id) & 0x7fffffff || 1;
  const opts: RoughOptions = {
    seed,
    roughness: rgh,
    bowing: rgh > 0 ? 1 : 0,
    stroke: item.color,
    strokeWidth: w,
    fill: fill > 0 && closed ? item.color : undefined,
    fillStyle: roughFillStyle(item.style.fillPattern),
    fillWeight: Math.max(0.8, w * 0.5),
    hachureGap: Math.max(w * 2.4, 5),
    hachureAngle: -41,
    disableMultiStroke: rgh < 0.25,
    disableMultiStrokeFill: rgh < 0.25,
  };

  let drawable: RoughDrawable;
  if (item.tool === "line" || item.tool === "arrow") {
    drawable = gen.line(p[0]!, p[1]!, p[3]!, p[4]!, opts);
  } else if (item.tool === "rect") {
    drawable = gen.rectangle(p[0]!, p[1]!, p[3]! - p[0]!, p[4]! - p[1]!, opts);
  } else if (item.tool === "ellipse") {
    const cx = (p[0]! + p[3]!) / 2;
    const cy = (p[1]! + p[4]!) / 2;
    drawable = gen.ellipse(cx, cy, Math.abs(p[3]! - p[0]!), Math.abs(p[4]! - p[1]!), opts);
  } else {
    const pts: [number, number][] = [];
    for (let i = 0; i + 1 < p.length; i += 3) pts.push([p[i]!, p[i + 1]!]);
    drawable = closed ? gen.polygon(pts, opts) : gen.linearPath(pts, opts);
  }

  drawDrawable(ctx, drawable, item.color, w, fill, !!item.style.dash);
}

export function paintRoughArea(ctx: Ctx2D, item: ScribbleItem): void {
  const p = item.points;
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < p.length; i += 3) pts.push([p[i]!, p[i + 1]!]);
  if (pts.length < 3) return;
  const w = item.size;
  const rgh = item.style.brush?.rgh ?? 0.6;
  const fill = item.style.fill ?? 0.3;
  const seed = hashString(item.id) & 0x7fffffff || 1;
  const drawable = gen.polygon(pts, {
    seed,
    roughness: rgh,
    stroke: item.color,
    strokeWidth: w,
    fill: item.color,
    fillStyle: roughFillStyle(item.style.fillPattern),
    fillWeight: Math.max(0.8, w * 0.55),
    hachureGap: Math.max(w * 2.8, 6),
    hachureAngle: -41,
    disableMultiStroke: rgh < 0.25,
  });
  drawDrawable(ctx, drawable, item.color, w, fill, !!item.style.dash);
}
