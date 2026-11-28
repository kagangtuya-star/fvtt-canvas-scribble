import type { StrokeConstraint } from "../assist/constraint.ts";
import { BRUSHES, resolveBrushParams } from "../brush/brushes.ts";
import { recognizeQuickShape } from "../brush/quickshape.ts";
import { StrokeRecorder } from "../brush/recorder.ts";
import type { InputSample, PressureMode } from "../brush/recorder.ts";
import { dragShape, shapeIsDegenerate } from "../brush/shapes.ts";
import type { Modifiers } from "../brush/shapes.ts";
import { cloneTransformedItem, symmetryTransforms } from "../brush/symmetry.ts";
import type { PointTransform, SymmetryMode } from "../brush/symmetry.ts";
import { LIMITS } from "../constants.ts";
import { quantizePoints } from "../core/codec.ts";
import { boundsOf, polylineLength, resample } from "../core/geometry.ts";
import type { SpaceAdapter } from "../core/space.ts";
import type { BrushId, Kind, Mode, ScribbleItem, ShapeId } from "../core/types.ts";
import { randomId } from "../core/util.ts";
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
  twist?: number;
}

export interface Target {
  mode: Mode;
  space: SpaceAdapter;
  /** Screen anchor chosen at pointer down. */
  anchor?: [number, number];
  /** Grid snap step in space units (0 = disabled). */
  snapStep?: number;
  /** Symmetry centre in space units and axis angle (degrees). */
  symmetry?: { mode: SymmetryMode; cx: number; cy: number; angle?: number };
}

/** Symmetry transforms of a target (identity only when symmetry is off). */
export function targetTransforms(target: Target): PointTransform[] {
  const sym = target.symmetry;
  if (!sym || sym.mode === "none") return symmetryTransforms("none", 0, 0);
  return symmetryTransforms(sym.mode, sym.cx, sym.cy, sym.angle ?? 0);
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
  /** Finalise one or more live items (grouped in a single Undo command). */
  commit(item: ScribbleItem): void;
  commitBatch?(items: ScribbleItem[]): void;
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

export function snapCoord(v: number, step?: number): number {
  if (!step || step <= 0) return v;
  return Math.round(v / step) * step;
}

export const toSpace = (t: Target, s: ClientSample, applySnap = false): InputSample => {
  const p = t.space.fromClient(s.cx, s.cy, t.anchor);
  return {
    x: applySnap ? snapCoord(p.x, t.snapStep) : p.x,
    y: applySnap ? snapCoord(p.y, t.snapStep) : p.y,
    time: s.time,
    pressure: s.pressure,
    pointerType: s.pointerType,
    tiltX: s.tiltX,
    tiltY: s.tiltY,
    twist: s.twist,
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
  /** Ruler constraint for this stroke. */
  constraint?: StrokeConstraint | null;
}

const QUICKSHAPE_HOLD_MS = 380;
/** A resting pointer feeds the time-window stabilizer at this interval (ms). */
const STABILIZER_TICK_MS = 16;

export class FreehandGesture implements Gesture {
  readonly #host: ToolHost;
  readonly #target: Target;
  readonly #spec: FreehandSpec;
  readonly #transforms: PointTransform[];
  #mirrorIds: string[];
  #rec: StrokeRecorder;
  #item: ScribbleItem;
  #width: number;
  #holdTimer: ReturnType<typeof setTimeout> | null = null;
  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #lastSample: ClientSample;
  #lastMoveAt = 0;
  #snapped: ScribbleItem | null = null;

  constructor(host: ToolHost, target: Target, spec: FreehandSpec, first: ClientSample) {
    this.#host = host;
    this.#target = target;
    this.#spec = spec;
    const brush = spec.kind === "stroke" ? BRUSHES[spec.tool as BrushId] : null;
    this.#width = target.space.widthFor(spec.size, brush?.widthScale ?? 1);
    this.#transforms = targetTransforms(target);
    this.#mirrorIds = this.#transforms.slice(1).map(() => randomId(16));
    this.#rec = this.#recorder();
    this.#lastSample = first;
    this.#rec.add(toSpace(target, first, !!brush?.pixelAligned && !!target.snapStep));
    this.#item = host.makeItem(target, spec.kind, spec.tool, this.#width, this.#rec.preview(), spec.extra);
    this.#emitLive(this.#item);
    if (this.#rec.needsTick) this.#tickTimer = setInterval(() => this.#tick(), STABILIZER_TICK_MS);
  }

  /** Resting pointer: keep the time-window stabilizer converging towards it. */
  #tick(): void {
    if (this.#snapped || !this.#rec.needsTick) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - this.#lastMoveAt < STABILIZER_TICK_MS * 1.5) return;
    const brush = this.#spec.kind === "stroke" ? BRUSHES[this.#spec.tool as BrushId] : null;
    const before = this.#rec.pointCount;
    this.#rec.add(
      toSpace(this.#target, { ...this.#lastSample, time: now }, !!brush?.pixelAligned && !!this.#target.snapStep),
    );
    if (this.#rec.pointCount === before) return;
    if (this.#rec.full) this.#chain();
    const angles = this.#rec.previewAngles();
    this.#item = { ...this.#item, points: this.#rec.preview(), ...(angles ? { angles } : {}) };
    this.#emitLive(this.#item);
  }

  #stopTick(): void {
    if (this.#tickTimer) clearInterval(this.#tickTimer);
    this.#tickTimer = null;
  }

  #recorder(): StrokeRecorder {
    const brush = this.#spec.kind === "stroke" ? BRUSHES[this.#spec.tool as BrushId] : null;
    const u = px(this.#target);
    const p = this.#host.prefs;
    const resolved = brush ? resolveBrushParams(brush, p.brushParams[brush.id]) : null;
    const recordAngles =
      !!brush && (brush.recordsAngles || resolved?.angleMode === "tilt" || resolved?.angleMode === "twist");
    return new StrokeRecorder({
      width: this.#width,
      streamline: brush?.streamline ?? 0.35,
      pressureMode: this.#host.pressureMode(),
      usesPressure: brush?.pressure ?? false,
      usesTilt: brush?.tilt ?? false,
      recordAngles,
      stabilizerMode: brush?.pixelAligned ? "off" : p.stabilizer,
      stabilizerStrength: p.stabilizerStrength,
      dejitter: brush?.pixelAligned ? 0 : p.dejitter,
      constraint: this.#spec.constraint ?? null,
      smoothing: brush?.pixelAligned ? 0 : p.smoothing,
      unitsPerPx: u,
      minDistance: 0.6 * u,
      tolerance: 0.35 * u,
    });
  }

  #emitLive(primary: ScribbleItem): void {
    this.#host.live(primary);
    for (let i = 1; i < this.#transforms.length; i++) {
      this.#host.live(cloneTransformedItem(primary, this.#mirrorIds[i - 1]!, this.#transforms[i]!));
    }
  }

  #clearHold(): void {
    if (this.#holdTimer) {
      clearTimeout(this.#holdTimer);
      this.#holdTimer = null;
    }
  }

  #armQuickShape(): void {
    this.#clearHold();
    const brush = this.#spec.kind === "stroke" ? BRUSHES[this.#spec.tool as BrushId] : null;
    if (!this.#host.prefs.quickShape || this.#spec.kind !== "stroke" || brush?.pixelAligned || this.#rec.line) return;
    if (this.#rec.pointCount < 6) return;
    this.#holdTimer = setTimeout(() => {
      this.#holdTimer = null;
      const pts = this.#rec.preview();
      const match = recognizeQuickShape(pts);
      if (!match) return;
      const style = { ...this.#item.style };
      delete style.brush;
      if (match.closed) style.closed = true;
      const snapped: ScribbleItem = {
        ...this.#item,
        kind: "shape",
        tool: match.tool,
        points: quantizePoints(match.points),
        angles: undefined,
        style,
      };
      this.#snapped = snapped;
      this.#emitLive(snapped);
    }, QUICKSHAPE_HOLD_MS);
  }

  move(samples: ClientSample[], mods: Modifiers): void {
    const brush = this.#spec.kind === "stroke" ? BRUSHES[this.#spec.tool as BrushId] : null;
    const snap = !!brush?.pixelAligned && !!this.#target.snapStep;
    this.#rec.line = mods.shift && this.#spec.kind === "stroke";

    if (this.#snapped) {
      // Small hand jitter while holding preserves the QuickShape snap; larger drag exits snap.
      const last = samples.at(-1);
      if (last && this.#rec.last) {
        const sp = toSpace(this.#target, last, snap);
        if (Math.hypot(sp.x - this.#rec.last.x, sp.y - this.#rec.last.y) < 10 * px(this.#target)) return;
      }
      this.#snapped = null;
    }

    for (const s of samples) {
      this.#rec.add(toSpace(this.#target, s, snap));
      if (this.#rec.full && !this.#rec.line) this.#chain();
    }
    const last = samples.at(-1);
    if (last) this.#lastSample = last;
    this.#lastMoveAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const angles = this.#rec.previewAngles();
    this.#item = { ...this.#item, points: this.#rec.preview(), ...(angles ? { angles } : {}) };
    this.#emitLive(this.#item);
    this.#armQuickShape();
  }

  /**
   * The per-item point budget is reached: commit this part and continue
   * seamlessly in a new item. Arrow heads stay on the final part only (a
   * start head would land on a junction).
   */
  #chain(): void {
    this.#clearHold();
    const noHead = { ...this.#item.style };
    delete noHead.head;
    const { points, angles } = this.#rec.finishWithAngles();
    const done: ScribbleItem = { ...this.#item, points, ...(angles ? { angles } : {}), style: noHead };
    this.#commitAll(done);
    const next = this.#rec.chain();
    this.#rec = next;
    const style = { ...this.#item.style };
    if (style.head === "both") style.head = "end";
    this.#mirrorIds = this.#transforms.slice(1).map(() => randomId(16));
    this.#item = this.#host.makeItem(this.#target, this.#spec.kind, this.#spec.tool, this.#width, next.preview(), {
      ...this.#spec.extra,
      style,
    });
    this.#emitLive(this.#item);
  }

  #commitAll(primary: ScribbleItem): void {
    if (this.#transforms.length <= 1) {
      this.#host.commit(primary);
      return;
    }
    const batch: ScribbleItem[] = [primary];
    for (let i = 1; i < this.#transforms.length; i++) {
      batch.push(cloneTransformedItem(primary, this.#mirrorIds[i - 1]!, this.#transforms[i]!));
    }
    if (this.#host.commitBatch) this.#host.commitBatch(batch);
    else for (const it of batch) this.#host.commit(it);
  }

  up(s: ClientSample, mods: Modifiers): boolean {
    this.#clearHold();
    this.#stopTick();
    if (this.#snapped) {
      this.#commitAll(this.#snapped);
      this.#snapped = null;
      return false;
    }
    this.#rec.line = mods.shift && this.#spec.kind === "stroke";
    // The lift-off position counts: browsers may report it only with pointerup.
    const brush = this.#spec.kind === "stroke" ? BRUSHES[this.#spec.tool as BrushId] : null;
    const last = this.#rec.last;
    const lift = toSpace(this.#target, s, !!brush?.pixelAligned && !!this.#target.snapStep);
    if (!last || lift.x !== last.x || lift.y !== last.y) {
      this.#rec.add({ ...lift, pressure: last?.pressure ?? lift.pressure });
      if (this.#rec.full && !this.#rec.line) this.#chain();
    }
    this.#rec.finishTip(this.#host.prefs.stabilizerFinish);
    let { points, angles } = this.#rec.finishWithAngles();
    if (points.length < 6) {
      // A tap: a dot (two coincident points so every renderer draws a blot).
      const p = points.length >= 3 ? points : this.#rec.preview();
      if (p.length < 3) return (this.cancel(), false);
      points = [p[0]!, p[1]!, p[2] ?? 0.5, p[0]! + 0.01 * px(this.#target), p[1]!, p[2] ?? 0.5];
      if (angles && angles.length) angles = [angles[0]!, angles[0]!];
    }
    if (this.#spec.kind === "area") {
      const b = boundsOf(points);
      const min = 4 * px(this.#target);
      if (points.length < 9 || (b[2] - b[0] < min && b[3] - b[1] < min)) return (this.cancel(), false);
    }
    this.#commitAll({ ...this.#item, points, ...(angles ? { angles } : {}) });
    return false;
  }

  cancel(): void {
    this.#clearHold();
    this.#stopTick();
    this.#host.cancel(this.#item.id);
    for (const id of this.#mirrorIds) this.#host.cancel(id);
  }
}

/** Live and commit helpers for gestures that fan out symmetry companions. */
class Companions {
  readonly #host: ToolHost;
  readonly #transforms: PointTransform[];
  readonly #ids: string[];

  constructor(host: ToolHost, target: Target) {
    this.#host = host;
    this.#transforms = targetTransforms(target);
    this.#ids = this.#transforms.slice(1).map(() => randomId(16));
  }

  live(primary: ScribbleItem): void {
    this.#host.live(primary);
    for (let i = 1; i < this.#transforms.length; i++)
      this.#host.live(cloneTransformedItem(primary, this.#ids[i - 1]!, this.#transforms[i]!));
  }

  commit(primary: ScribbleItem): void {
    if (this.#transforms.length <= 1) {
      this.#host.commit(primary);
      return;
    }
    const batch = [primary];
    for (let i = 1; i < this.#transforms.length; i++)
      batch.push(cloneTransformedItem(primary, this.#ids[i - 1]!, this.#transforms[i]!));
    if (this.#host.commitBatch) this.#host.commitBatch(batch);
    else for (const it of batch) this.#host.commit(it);
  }

  cancel(primaryId: string): void {
    this.#host.cancel(primaryId);
    for (const id of this.#ids) this.#host.cancel(id);
  }
}

/* -------------------------------------------- */
/*  Two-point shapes: line, arrow, rect, ellipse */
/* -------------------------------------------- */

export class ShapeGesture implements Gesture {
  readonly #target: Target;
  readonly #shape: ShapeId;
  readonly #start: InputSample;
  readonly #companions: Companions;
  readonly #constraint: StrokeConstraint | null;
  #item: ScribbleItem;

  constructor(
    host: ToolHost,
    target: Target,
    shape: ShapeId,
    size: number,
    first: ClientSample,
    extra?: Partial<ScribbleItem>,
    constraint: StrokeConstraint | null = null,
  ) {
    this.#target = target;
    this.#shape = shape;
    this.#start = toSpace(target, first, !!target.snapStep);
    this.#companions = new Companions(host, target);
    // Rulers constrain straight lines only (the start point is the constraint's origin).
    this.#constraint = shape === "line" || shape === "arrow" ? constraint : null;
    const w = target.space.widthFor(size);
    const pts = dragShape(shape, this.#start, this.#start, { shift: false, alt: false });
    this.#item = host.makeItem(target, "shape", shape, w, pts, extra);
  }

  #started = false;

  move(samples: ClientSample[], mods: Modifiers): void {
    const last = samples.at(-1);
    if (!last) return;
    let end: { x: number; y: number } = toSpace(this.#target, last, !!this.#target.snapStep);
    let shapeMods = mods;
    if (this.#constraint) {
      end = this.#constraint.project(end.x, end.y);
      if (this.#constraint.locked) shapeMods = { ...mods, shift: false };
    }
    const points = quantizePoints(dragShape(this.#shape, this.#start, end, shapeMods));
    this.#item = { ...this.#item, points };
    if (!this.#started && shapeIsDegenerate(points, 2 * px(this.#target))) return;
    this.#started = true;
    this.#companions.live(this.#item);
  }

  up(s: ClientSample, mods: Modifiers): boolean {
    this.move([s], mods);
    if (shapeIsDegenerate(this.#item.points, 3 * px(this.#target))) {
      this.cancel();
      return false;
    }
    this.#companions.commit(this.#item);
    return false;
  }

  cancel(): void {
    if (this.#started) this.#companions.cancel(this.#item.id);
  }
}

/* -------------------------------------------- */
/*  Polygon / polyline (click, click, …)        */
/* -------------------------------------------- */

export class PolygonGesture implements Gesture {
  readonly #target: Target;
  readonly #width: number;
  readonly #vertices: number[] = [];
  readonly #companions: Companions;
  #item: ScribbleItem;
  #lastClick = 0;
  #done = false;

  constructor(host: ToolHost, target: Target, size: number, first: ClientSample, extra?: Partial<ScribbleItem>) {
    this.#target = target;
    this.#width = target.space.widthFor(size);
    this.#companions = new Companions(host, target);
    const p = toSpace(target, first, !!target.snapStep);
    this.#vertices.push(p.x, p.y, 0.5);
    this.#lastClick = first.time;
    this.#item = host.makeItem(target, "shape", "polygon", this.#width, [...this.#vertices, p.x, p.y, 0.5], extra);
    this.#companions.live(this.#item);
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
    this.#companions.live(this.#item);
  }

  move(samples: ClientSample[], mods: Modifiers): void {
    const last = samples.at(-1);
    if (last) this.#preview(toSpace(this.#target, last, !!this.#target.snapStep), mods);
  }

  hover(s: ClientSample, mods: Modifiers): void {
    if (!this.#done) this.#preview(toSpace(this.#target, s, !!this.#target.snapStep), mods);
  }

  down(s: ClientSample, mods: Modifiers): void {
    const p = toSpace(this.#target, s, !!this.#target.snapStep);
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
      this.#companions.cancel(this.#item.id);
      return;
    }
    const style = { ...this.#item.style };
    if (closed) style.closed = true;
    else {
      delete style.closed;
      delete style.fill;
    }
    this.#companions.commit({ ...this.#item, points: pts, style });
  }

  cancel(): void {
    if (this.#done) return;
    this.#done = true;
    this.#companions.cancel(this.#item.id);
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
