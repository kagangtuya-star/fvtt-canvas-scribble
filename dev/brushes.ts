/**
 * Brush gallery: renders every brush, shape and item kind with the real
 * painters on dark and light backgrounds, at 1× and at the device pixel
 * ratio. Used for visual QA (`npm run harness`, open dist-dev/brushes.html).
 */
import { BRUSHES, DEFAULT_PALETTE } from "../src/brush/brushes.ts";
import { ctx2d, paintItemLayer } from "../src/brush/paint.ts";
import { StrokeRecorder } from "../src/brush/recorder.ts";
import { BRUSH_IDS, SCHEMA_VERSION } from "../src/core/types.ts";
import type { BrushId, ScribbleItem } from "../src/core/types.ts";

const DPR = window.devicePixelRatio || 1;

function item(over: Partial<ScribbleItem>): ScribbleItem {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: Math.random().toString(36).slice(2, 14).padEnd(12, "x"),
    author: "dev",
    scene: "dev",
    mode: "map",
    kind: "stroke",
    tool: "pen",
    color: "#e0483e",
    opacity: 1,
    size: 6,
    points: [],
    style: {},
    createdAt: 0,
    expiresAt: null,
    fadeDuration: 0,
    layer: "top",
    visibility: "all",
    revision: 0,
    ...over,
  };
}

/** Simulate a mouse gesture through the real recorder (speed-derived pressure). */
function gesture(brush: BrushId, x0: number, y0: number, width: number, kind: "wave" | "loop" | "zig"): number[] {
  const b = BRUSHES[brush];
  const rec = new StrokeRecorder({
    width,
    streamline: b.streamline,
    pressureMode: "auto",
    usesPressure: b.pressure,
    usesTilt: b.tilt,
    minDistance: 0.6,
    tolerance: 0.3,
  });
  const N = 90;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let x: number;
    let y: number;
    if (kind === "wave") {
      x = x0 + t * 250;
      y = y0 + Math.sin(t * Math.PI * 2.2) * 22;
    } else if (kind === "loop") {
      const a = t * Math.PI * 3.4;
      x = x0 + t * 200 + Math.cos(a) * 26;
      y = y0 + Math.sin(a) * 26;
    } else {
      x = x0 + t * 220;
      y = y0 + ((Math.floor(t * 6) % 2 === 0 ? (t * 6) % 1 : 1 - ((t * 6) % 1)) - 0.5) * 50;
    }
    // Uneven timing like real pointer events: slow start, fast middle, slow end.
    const time = 1000 + Math.pow(t, 0.8) * 650 + Math.sin(t * Math.PI) * 120;
    rec.add({ x, y, time, pressure: 0.5, pointerType: "mouse" });
  }
  return rec.finish();
}

/** Pen-tablet gesture with real pressure (rise and fall). */
function penGesture(x0: number, y0: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    out.push(x0 + t * 240, y0 + Math.sin(t * Math.PI * 1.5) * 16, 0.1 + Math.sin(t * Math.PI) * 0.85);
  }
  return out;
}

function panel(title: string, bg: string, draw: (ctx: CanvasRenderingContext2D) => void, w = 900, h = 560): void {
  const wrap = document.createElement("figure");
  const canvas = document.createElement("canvas");
  canvas.width = w * DPR;
  canvas.height = h * DPR;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.style.background = bg;
  const cap = document.createElement("figcaption");
  cap.textContent = title;
  wrap.append(cap, canvas);
  document.body.append(wrap);
  draw(ctx2d(canvas) as CanvasRenderingContext2D);
}

function renderSet(ctx: CanvasRenderingContext2D, dark: boolean): void {
  const view = { scale: DPR, ox: 0, oy: 0 };
  const label = (text: string, y: number) => {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.font = "12px sans-serif";
    ctx.fillStyle = dark ? "#cbbfa8" : "#4b3f2f";
    ctx.fillText(text, 10, y);
  };
  const brushes: BrushId[] = [...BRUSH_IDS];
  brushes.forEach((id, row) => {
    const b = BRUSHES[id];
    const y = 40 + row * 62;
    label(id, y + 4);
    const colors =
      id === "highlighter"
        ? ["#f2c94c", "#4caf6a", "#e85a9b"]
        : [DEFAULT_PALETTE[0]!, DEFAULT_PALETTE[5]!, dark ? "#f4f1ea" : "#26221e"];
    (["wave", "loop", "zig"] as const).forEach((kind, col) => {
      const width = b.defaultSize * b.widthScale;
      const pts = gesture(id, 90 + col * 270, y, width, kind);
      const it = item({ tool: id, color: colors[col]!, size: width, points: pts, style: { halo: b.halo } });
      const layer = document.createElement("canvas");
      layer.width = ctx.canvas.width;
      layer.height = ctx.canvas.height;
      paintItemLayer(ctx2d(layer), it, view);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = b.opacity;
      ctx.drawImage(layer, 0, 0);
      ctx.globalAlpha = 1;
    });
  });
}

function renderShapes(ctx: CanvasRenderingContext2D, dark: boolean): void {
  const view = { scale: DPR, ox: 0, oy: 0 };
  const draw = (it: ScribbleItem) => {
    const layer = document.createElement("canvas");
    layer.width = ctx.canvas.width;
    layer.height = ctx.canvas.height;
    paintItemLayer(ctx2d(layer), it, view);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = it.opacity;
    ctx.drawImage(layer, 0, 0);
    ctx.globalAlpha = 1;
  };
  const ink = dark ? "#f4f1ea" : "#26221e";
  draw(
    item({
      kind: "shape",
      tool: "arrow",
      color: "#e0483e",
      size: 5,
      points: [40, 60, 0.5, 260, 40, 0.5],
      style: { halo: true },
    }),
  );
  draw(
    item({
      kind: "shape",
      tool: "arrow",
      color: "#3d8be8",
      size: 3,
      points: [40, 120, 0.5, 260, 120, 0.5],
      style: { dash: true, head: "both", halo: true },
    }),
  );
  draw(item({ kind: "shape", tool: "line", color: ink, size: 3, points: [40, 170, 0.5, 260, 200, 0.5], style: {} }));
  draw(
    item({
      kind: "shape",
      tool: "rect",
      color: "#f08a2c",
      size: 4,
      points: [300, 40, 0.5, 460, 140, 0.5],
      style: { fill: 0.18, halo: true },
    }),
  );
  draw(
    item({
      kind: "shape",
      tool: "ellipse",
      color: "#4caf6a",
      size: 4,
      points: [490, 40, 0.5, 650, 140, 0.5],
      style: { halo: true },
    }),
  );
  draw(
    item({
      kind: "shape",
      tool: "polygon",
      color: "#9b6bdf",
      size: 3,
      points: [690, 140, 0.5, 740, 40, 0.5, 820, 90, 0.5, 860, 30, 0.5],
      style: { dash: true },
    }),
  );
  draw(
    item({
      kind: "shape",
      tool: "polygon",
      color: "#2bb3a3",
      size: 3,
      points: [690, 200, 0.5, 760, 160, 0.5, 860, 220, 0.5, 780, 260, 0.5],
      style: { closed: true, fill: 0.25 },
    }),
  );
  // Freehand path arrow (fineliner + head)
  draw(
    item({
      tool: "fineliner",
      color: "#e0483e",
      size: 4,
      points: gesture("fineliner", 60, 260, 4, "wave"),
      style: { head: "end", halo: true },
    }),
  );
  draw(
    item({
      tool: "fineliner",
      color: "#f2c94c",
      size: 3,
      points: gesture("fineliner", 360, 300, 3, "loop"),
      style: { head: "end", dash: true, halo: true },
    }),
  );
  // Area
  const area: number[] = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    area.push(160 + Math.cos(a) * (90 + Math.sin(a * 3) * 12), 420 + Math.sin(a) * 60, 0.5);
  }
  draw(item({ kind: "area", tool: "area", color: "#e0483e", size: 2.5, points: area, style: { fill: 0.3 } }));
  draw(
    item({
      kind: "text",
      tool: "text",
      color: "#f2c94c",
      size: 22,
      points: [320, 380, 0.5],
      text: "Ambush here! 伏击点",
      style: {},
    }),
  );
  draw(
    item({
      kind: "text",
      tool: "text",
      color: "#26221e",
      size: 18,
      points: [320, 420, 0.5],
      text: "Dark text, light halo\n第二行",
      style: {},
    }),
  );
  // Pressure pen with real pressure + partial erase mask
  const pen = item({
    tool: "pressure",
    color: "#3d8be8",
    size: 8,
    points: penGesture(600, 330),
    style: { halo: true },
  });
  pen.erase = [{ size: 10, points: [700, 300, 0.5, 712, 380, 0.5] }];
  draw(pen);
  draw(item({ tool: "pencil", color: ink, size: 4, points: penGesture(600, 440) }));
}

document.body.style.cssText =
  "margin:16px;background:#111;color:#ddd;font:13px sans-serif;display:flex;flex-wrap:wrap;gap:16px";
const style = document.createElement("style");
style.textContent = "figure{margin:0} figcaption{margin:4px 0}";
document.head.append(style);
panel("Brushes — dark map", "#2a2621", (c) => renderSet(c, true), 900, 40 + BRUSH_IDS.length * 62);
panel("Brushes — parchment", "#e9dcc0", (c) => renderSet(c, false), 900, 40 + BRUSH_IDS.length * 62);
panel("Shapes, areas, text, masks — dark", "#2a2621", (c) => renderShapes(c, true), 900, 520);
panel("Shapes, areas, text, masks — parchment", "#e9dcc0", (c) => renderShapes(c, false), 900, 520);
(window as unknown as { __ready: boolean }).__ready = true;
