import { BRUSHES } from "../brush/brushes.ts";
import { StrokeRecorder } from "../brush/recorder.ts";
import type { InputSample, PressureMode } from "../brush/recorder.ts";
import { dragShape, shapeIsDegenerate } from "../brush/shapes.ts";
import type { Modifiers } from "../brush/shapes.ts";
import { LIMITS } from "../constants.ts";
import { quantizePoints } from "../core/codec.ts";
import { boundsOf, polylineLength, resample } from "../core/geometry.ts";
import type { SpaceAdapter } from "../core/space.ts";
import type { BrushId, Kind, Mode, ScribbleItem, ShapeId } from "../core/types.ts";
import type { Prefs } from "../state/prefs.ts";

/**
 * Pointer gestures → items. A gesture lives from pointer down to pointer up
 * (polygons span several clicks). Gestures only produce structured items;
 * the {@link ToolHost} (the session) streams, stores and records them.
 */

/** Pointer sample in client (CSS) pixels. */
export interface ClientSample {
  cx: number;
  cy: number;
  time: number;
  pressure: number;
  pointerType: string;
  tiltX?: number;
  tiltY?: number;
}

export interface Target {
  mode: Mode;
  space: SpaceAdapter;
  /** Screen anchor chosen at pointer down. */
  anchor?: [number, number];
}

export interface ToolHost {
  readonly prefs: Prefs;
  pressureMode(): PressureMode;
  /** A fresh item with the user's identity, colour, timing and layer filled in. */
  makeItem(
    target: Target,
    kind: Kind,
    tool: string,
    size: number,
    points: number[],
    extra?: Partial<ScribbleItem>,
  ): ScribbleItem;
  /** Show/stream a live item (first call starts it). */
  live(item: ScribbleItem): void;
  /** Finalise a live item (temporary or permanent). */
  commit(item: ScribbleItem): void;
  /** Abandon a live item. */
  cancel(id: string): void;
  /** Server time (ms). */
  now(): number;
}

export interface Gesture {
  move(samples: ClientSample[], mods: Modifiers): void;
  /** Returns `true` when the gesture continues (polygon waits for more clicks). */
  up(sample: ClientSample, mods: Modifiers): boolean;
  /** Further click of a multi-click gesture. */
  down?(sample: ClientSample, mods: Modifiers): void;
  /** Hover between clicks (polygon rubber band). */
  hover?(sample: ClientSample, mods: Modifiers): void;
  /** Finish a multi-click gesture (Enter / double click). */
  finish?(): void;
  cancel(): void;
}

export const toSpace = (t: Target, s: ClientSample): InputSample => {
  const p = t.space.fromClient(s.cx, s.cy, t.anchor);
  return {
    x: p.x,
    y: p.y,
    time: s.time,
    pressure: s.pressure,
    pointerType: s.pointerType,
    tiltX: s.tiltX,
    tiltY: s.tiltY,
  };
};

/** Space units per CSS pixel. */
const px = (t: Target) => 1 / t.space.cssPerUnit();

/* -------------------------------------------- */
/*  Freehand: brushes, highlighter, arrow paths, areas */
/* -------------------------------------------- */

interface FreehandSpec {
  kind: "stroke" | "area";
  tool: BrushId | "area";
  /** UI size. */
  size: number;
  extra?: Partial<ScribbleItem>;
}

export class FreehandGesture implements Gesture {
  readonly #host: ToolHost;
  readonly #target: Target;
  readonly #spec: FreehandSpec;
  #rec: StrokeRecorder;
  #item: ScribbleItem;
  #width: number;

  constructor(host: ToolHost, target: Target, spec: FreehandSpec, first: ClientSample) {
    this.#host = host;
    this.#target = target;
    this.#spec = spec;
    const brush = spec.kind === "stroke" ? BRUSHES[spec.tool as BrushId] : null;
    this.#width = target.space.widthFor(spec.size, brush?.widthScale ?? 1);
    this.#rec = this.#recorder();
    this.#rec.add(toSpace(target, first));
    this.#item = host.makeItem(target, spec.kind, spec.tool, this.#width, this.#rec.preview(), spec.extra);
    host.live(this.#item);
  }

  #recorder(): StrokeRecorder {
    const brush = this.#spec.kind === "stroke" ? BRUSHES[this.#spec.tool as BrushId] : null;
    const u = px(this.#target);
    return new StrokeRecorder({
      width: this.#width,
      streamline: brush?.streamline ?? 0.35,
      pressureMode: this.#host.pressureMode(),
      usesPressure: brush?.pressure ?? false,
      usesTilt: brush?.tilt ?? false,
      minDistance: 0.6 * u,
      tolerance: 0.35 * u,
    });
  }

  move(samples: ClientSample[], mods: Modifiers): void {
    this.#rec.line = mods.shift && this.#spec.kind === "stroke";
    for (const s of samples) {
      this.#rec.add(toSpace(this.#target, s));
      if (this.#rec.full && !this.#rec.line) this.#chain();
    }
    this.#item = { ...this.#item, points: this.#rec.preview() };
    this.#host.live(this.#item);
  }

  /**
   * The per-item point budget is reached: commit this part and continue
   * seamlessly in a new item. Arrow heads stay on the final part only (a
   * start head would land on a junction).
   */
  #chain(): void {
    const noHead = { ...this.#item.style };
    delete noHead.head;
    this.#host.commit({ ...this.#item, points: this.#rec.finish(), style: noHead });
    const next = this.#rec.chain();
    this.#rec = next;
    const style = { ...this.#item.style };
    if (style.head === "both") style.head = "end";
    this.#item = this.#host.makeItem(this.#target, this.#spec.kind, this.#spec.tool, this.#width, next.preview(), {
      ...this.#spec.extra,
      style,
    });
    this.#host.live(this.#item);
  }

  up(_s: ClientSample, mods: Modifiers): boolean {
    this.#rec.line = mods.shift && this.#spec.kind === "stroke";
    let points = this.#rec.finish();
    if (points.length < 6) {
      // A tap: a dot (two coincident points so every renderer draws a round blot).
      const p = points.length >= 3 ? points : this.#rec.preview();
      if (p.length < 3) return (this.cancel(), false);
      points = [p[0]!, p[1]!, p[2] ?? 0.5, p[0]! + 0.01 * px(this.#target), p[1]!, p[2] ?? 0.5];
    }
    if (this.#spec.kind === "area") {
      const b = boundsOf(points);
      const min = 4 * px(this.#target);
      if (points.length < 9 || (b[2] - b[0] < min && b[3] - b[1] < min)) return (this.cancel(), false);
    }
    this.#host.commit({ ...this.#item, points });
    return false;
  }

  cancel(): void {
    this.#host.cancel(this.#item.id);
  }
}

/* -------------------------------------------- */
/*  Two-point shapes: line, arrow, rect, ellipse */
/* -------------------------------------------- */

export class ShapeGesture implements Gesture {
  readonly #host: ToolHost;
  readonly #target: Target;
  readonly #shape: ShapeId;
  readonly #start: InputSample;
  #item: ScribbleItem;

  constructor(
    host: ToolHost,
    target: Target,
    shape: ShapeId,
    size: number,
    first: ClientSample,
    extra?: Partial<ScribbleItem>,
  ) {
    this.#host = host;
    this.#target = target;
    this.#shape = shape;
    this.#start = toSpace(target, first);
    const w = target.space.widthFor(size);
    const pts = dragShape(shape, this.#start, this.#start, { shift: false, alt: false });
    this.#item = host.makeItem(target, "shape", shape, w, pts, extra);
  }

  #started = false;

  move(samples: ClientSample[], mods: Modifiers): void {
    const last = samples.at(-1);
    if (!last) return;
    const points = quantizePoints(dragShape(this.#shape, this.#start, toSpace(this.#target, last), mods));
    this.#item = { ...this.#item, points };
    if (!this.#started && shapeIsDegenerate(points, 2 * px(this.#target))) return;
    this.#started = true;
    this.#host.live(this.#item);
  }

  up(s: ClientSample, mods: Modifiers): boolean {
    this.move([s], mods);
    if (shapeIsDegenerate(this.#item.points, 3 * px(this.#target))) {
      this.cancel();
      return false;
    }
    this.#host.commit(this.#item);
    return false;
  }

  cancel(): void {
    if (this.#started) this.#host.cancel(this.#item.id);
  }
}

/* -------------------------------------------- */
/*  Polygon / polyline (click, click, …)        */
/* -------------------------------------------- */

export class PolygonGesture implements Gesture {
  readonly #host: ToolHost;
  readonly #target: Target;
  readonly #width: number;
  readonly #vertices: number[] = [];
  #item: ScribbleItem;
  #lastClick = 0;
  #done = false;

  constructor(host: ToolHost, target: Target, size: number, first: ClientSample, extra?: Partial<ScribbleItem>) {
    this.#host = host;
    this.#target = target;
    this.#width = target.space.widthFor(size);
    const p = toSpace(target, first);
    this.#vertices.push(p.x, p.y, 0.5);
    this.#lastClick = first.time;
    this.#item = host.makeItem(target, "shape", "polygon", this.#width, [...this.#vertices, p.x, p.y, 0.5], extra);
    host.live(this.#item);
  }

  /** Snap radius for closing on the first vertex (CSS px). */
  static CLOSE_PX = 10;

  #preview(cursor: InputSample | null, mods: Modifiers): void {
    const pts = [...this.#vertices];
    if (cursor) {
      let c = cursor;
      if (mods.shift) {
        const n = pts.length;
        const a = { x: pts[n - 3]!, y: pts[n - 2]! };
        const ang = Math.round(Math.atan2(c.y - a.y, c.x - a.x) / (Math.PI / 12)) * (Math.PI / 12);
        const len = Math.hypot(c.x - a.x, c.y - a.y);
        c = { ...c, x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
      }
      pts.push(c.x, c.y, 0.5);
    }
    this.#item = { ...this.#item, points: quantizePoints(pts) };
    this.#host.live(this.#item);
  }

  move(samples: ClientSample[], mods: Modifiers): void {
    const last = samples.at(-1);
    if (last) this.#preview(toSpace(this.#target, last), mods);
  }

  hover(s: ClientSample, mods: Modifiers): void {
    if (!this.#done) this.#preview(toSpace(this.#target, s), mods);
  }

  down(s: ClientSample, mods: Modifiers): void {
    const p = toSpace(this.#target, s);
    const near =
      Math.hypot(p.x - this.#vertices[0]!, p.y - this.#vertices[1]!) <= PolygonGesture.CLOSE_PX * px(this.#target);
    const double = s.time - this.#lastClick < 350;
    this.#lastClick = s.time;
    if (near && this.#vertices.length >= 9) {
      this.#close(true);
      return;
    }
    if (double) {
      this.finish();
      return;
    }
    // Shift snaps the new vertex like the preview.
    this.#preview(p, mods);
    const pts = this.#item.points;
    this.#vertices.push(pts.at(-3)!, pts.at(-2)!, 0.5);
    if (this.#vertices.length / 3 >= 256) this.finish();
  }

  up(): boolean {
    return !this.#done;
  }

  finish(): void {
    this.#close(false);
  }

  #close(closed: boolean): void {
    if (this.#done) return;
    this.#done = true;
    const pts = quantizePoints(this.#vertices);
    if (pts.length < 6 || polylineLength(pts) < 3 * px(this.#target)) {
      this.#host.cancel(this.#item.id);
      return;
    }
    const style = { ...this.#item.style };
    if (closed) style.closed = true;
    else {
      delete style.closed;
      delete style.fill;
    }
    this.#host.commit({ ...this.#item, points: pts, style });
  }

  cancel(): void {
    if (this.#done) return;
    this.#done = true;
    this.#host.cancel(this.#item.id);
  }
}

/* -------------------------------------------- */
/*  Laser                                       */
/* -------------------------------------------- */

export class LaserGesture implements Gesture {
  readonly #host: ToolHost;
  readonly #target: Target;
  readonly #width: number;
  #item: ScribbleItem;
  #points: number[] = [];
  #start: number;

  constructor(host: ToolHost, target: Target, size: number, first: ClientSample) {
    this.#host = host;
    this.#target = target;
    this.#width = target.space.widthFor(size);
    this.#start = host.now();
    this.#push(first);
    this.#item = host.makeItem(target, "laser", "laser", this.#width, this.#points.slice(), {
      createdAt: this.#start,
      fadeDuration: host.prefs.laserTrail,
      layer: "top",
    });
    host.live(this.#item);
  }

  #push(s: ClientSample): void {
    const p = toSpace(this.#target, s);
    const t = Math.max(0, Math.round(this.#host.now() - this.#start));
    const n = this.#points.length;
    if (n && Math.hypot(p.x - this.#points[n - 3]!, p.y - this.#points[n - 2]!) < 1.2 * px(this.#target)) {
      this.#points[n - 1] = t; // resting pointer: keep the tip fresh
      return;
    }
    this.#points.push(p.x, p.y, t);
  }

  move(samples: ClientSample[]): void {
    for (const s of samples) this.#push(s);
    if (this.#points.length / 3 >= LIMITS.maxPointsPerItem - 4) this.#chain();
    this.#item = { ...this.#item, points: this.#points.slice() };
    this.#host.live(this.#item);
  }

  /** Long pointing sessions continue in a new item (the old trail fades on its own). */
  #chain(): void {
    this.#commit();
    const n = this.#points.length;
    const tail = [this.#points[n - 3]!, this.#points[n - 2]!, 0];
    this.#start = this.#host.now();
    this.#points = tail;
    this.#item = this.#host.makeItem(this.#target, "laser", "laser", this.#width, tail.slice(), {
      createdAt: this.#start,
      fadeDuration: this.#host.prefs.laserTrail,
      layer: "top",
    });
    this.#host.live(this.#item);
  }

  #commit(): void {
    const pts = quantizePoints(this.#points, "time");
    const last = pts.at(-1) ?? 0;
    this.#host.commit({ ...this.#item, points: pts, createdAt: this.#start, expiresAt: this.#start + last });
  }

  up(s: ClientSample): boolean {
    this.#push(s);
    this.#commit();
    return false;
  }

  cancel(): void {
    this.#commit();
  }
}

/* -------------------------------------------- */
/*  Eraser path                                 */
/* -------------------------------------------- */

/** Collects an eraser path (space units) and reports new segments to a callback. */
export class EraserGesture implements Gesture {
  readonly #target: Target;
  readonly #onPath: (path: number[], final: boolean) => void;
  readonly #onCancel: () => void;
  readonly points: number[] = [];
  readonly radius: number;

  constructor(
    target: Target,
    uiSize: number,
    first: ClientSample,
    onPath: (path: number[], final: boolean) => void,
    onCancel: () => void,
  ) {
    this.#target = target;
    this.radius = target.space.widthFor(uiSize) / 2;
    this.#onPath = onPath;
    this.#onCancel = onCancel;
    const p = toSpace(target, first);
    this.points.push(p.x, p.y, 1);
    onPath(this.points, false);
  }

  get target(): Target {
    return this.#target;
  }

  move(samples: ClientSample[]): void {
    for (const s of samples) {
      const p = toSpace(this.#target, s);
      const n = this.points.length;
      if (Math.hypot(p.x - this.points[n - 3]!, p.y - this.points[n - 2]!) < this.radius * 0.25) continue;
      this.points.push(p.x, p.y, 1);
    }
    this.#onPath(this.points, false);
  }

  up(s: ClientSample): boolean {
    this.move([s]);
    this.#onPath(this.points, true);
    return false;
  }

  cancel(): void {
    this.#onCancel();
  }
}

/** Dense copy of an eraser path so fast strokes leave no gaps between hit tests. */
export function densePath(path: readonly number[], radius: number): number[] {
  if (path.length <= 3) return path.slice();
  return resample(path, Math.max(radius * 0.5, 1e-3));
}
