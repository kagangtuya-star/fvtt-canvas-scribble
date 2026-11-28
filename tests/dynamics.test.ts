import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { BRUSHES, diffBrushOverride } from "../src/brush/brushes.ts";
import {
  compileCurve,
  curveControlPoints,
  encodeCurvePoints,
  monotoneLut,
  parseCurve,
  presetOf,
  PRESET_CODE,
} from "../src/brush/curve.ts";
import {
  canonicalDynamics,
  compileDynamics,
  defaultDynamics,
  dynamicsSensors,
  dynamicsTargets,
  sanitizeDynamics,
} from "../src/brush/dynamics.ts";
import type { DynFrame } from "../src/brush/dynamics.ts";
import { paintItemLayer } from "../src/brush/paint.ts";
import { SpeedModel, StrokeRecorder, tiltOf } from "../src/brush/recorder.ts";
import { decodeUnits, encodeUnits, quantizeUnits } from "../src/core/codec.ts";
import { simplifyIndicesToLimit } from "../src/core/geometry.ts";
import { rotate, scale } from "../src/core/matrix.ts";
import { sanitizeItem, toWire } from "../src/core/sanitize.ts";
import { MapSpace } from "../src/core/space.ts";
import { itemBounds } from "../src/core/store.ts";
import type { DynamicsSpec, DynTargetSpec, ScribbleItem } from "../src/core/types.ts";
import { parseMessage } from "../src/net/protocol.ts";
import { DEFAULT_PREFS, normalizePrefs } from "../src/state/prefs.ts";
import { FreehandGesture } from "../src/tools/gestures.ts";
import type { ToolHost } from "../src/tools/gestures.ts";
import { transformItem } from "../src/tools/transform.ts";
import { BOB, SCENE, makeItem } from "./helpers.ts";

const NOW = 1_000_000;
const frame = (over: Partial<DynFrame> = {}): DynFrame => ({
  p: 0.5,
  t: 0,
  v: 0,
  tan: 0,
  tan0: 0,
  nib: 0,
  run: 0,
  i: 0,
  ...over,
});

describe("response curves", () => {
  it("canonicalises valid codes and rejects malformed ones", () => {
    assert.equal(parseCurve("lin"), "lin");
    assert.equal(parseCurve("pow:1"), "lin");
    assert.equal(parseCurve("pow:0.855"), "pow:0.86");
    assert.equal(parseCurve("thr:0.25"), "thr:0.25");
    assert.equal(parseCurve("p:0,0;128,200;255,255"), "p:0,0;128,200;255,255");
    for (const bad of [
      null,
      42,
      "",
      "cubic",
      "pow:0",
      "pow:11",
      "thr:2",
      "p:0,0",
      "p:0,0;0,10",
      "p:10,0;5,10",
      "p:0,0;300,10",
      "p:0,0;1,1;2,2;3,3;4,4;5,5;6,6;7,7;8,8",
      "p:" + "1,1;".repeat(30),
    ])
      assert.equal(parseCurve(bad), null, String(bad));
  });

  it("evaluates parametric curves exactly", () => {
    const pow = compileCurve("pow:0.85");
    for (const x of [0, 0.1, 0.37, 0.5, 0.99, 1]) assert.equal(pow(x), Math.pow(x, 0.85));
    assert.equal(compileCurve("inv")(0.25), 0.75);
    assert.equal(compileCurve("thr:0.5")(0.49), 0);
    assert.equal(compileCurve("thr:0.5")(0.5), 1);
    assert.equal(compileCurve("s")(0.5), 0.5);
    assert.equal(compileCurve("nonsense")(0.3), 0.3, "invalid codes fall back to linear");
    assert.equal(compileCurve("lin")(1.7), 1, "inputs are clamped");
  });

  it("interpolates control points monotonically without overshoot", () => {
    const fn = compileCurve("p:0,0;40,230;60,240;255,255");
    let prev = -1;
    for (let i = 0; i <= 200; i++) {
      const y = fn(i / 200);
      assert.ok(y >= prev - 1e-6, `monotone at ${i}`);
      assert.ok(y >= 0 && y <= 1);
      prev = y;
    }
    assert.ok(Math.abs(fn(40 / 255) - 230 / 255) < 0.01, "passes through the control points");
    // A peak stays a peak: no value above the highest control point.
    const lut = monotoneLut([0, 0.5, 1], [0, 0.8, 0]);
    assert.ok(Math.max(...lut) <= 0.8 + 1e-6);
    assert.ok(Math.abs(lut[0]!) < 1e-6 && Math.abs(lut.at(-1)!) < 1e-6);
  });

  it("encodes edited points and offers editable points for presets", () => {
    assert.equal(
      encodeCurvePoints([
        [1, 1],
        [0, 0],
        [0.5, 0.25],
        [0.5, 0.9],
      ]),
      "p:0,0;128,64;255,255",
    );
    assert.equal(encodeCurvePoints([[0.3, 0.4]]), "p:77,102;255,102");
    const pts = curveControlPoints(PRESET_CODE.soft);
    assert.ok(pts.length >= 2 && pts.length <= 8);
    assert.deepEqual(curveControlPoints("p:0,0;255,128"), [
      [0, 0],
      [1, 128 / 255],
    ]);
    assert.equal(presetOf("pow:0.5"), "soft");
    assert.equal(presetOf("p:0,0;255,255"), null);
  });
});

describe("dynamics model", () => {
  it("sanitises untrusted specs into canonical form", () => {
    const raw = {
      junk: { lo: 0, hi: 1, src: [{ s: "p", c: "lin" }] },
      spc: { hi: 99, src: [{ s: "v" }] },
      size: {
        m: "max",
        hi: 1.5,
        lo: -3,
        src: [
          { s: "p", c: "pow:2", extra: 1 },
          { s: "x" },
          { s: "d", dm: "weird" },
          { s: "r", rm: "smooth", f: 99 },
          { s: "t" },
          { s: "v" },
        ],
      },
      flw: { lo: 0.5, hi: 1, src: [] },
    };
    const clean = sanitizeDynamics(raw)!;
    assert.deepEqual(clean, {
      size: {
        lo: 0,
        hi: 1.5,
        m: "max",
        src: [
          { s: "p", c: "pow:2" },
          { s: "d", c: "lin", dm: "abs" },
          { s: "r", c: "lin", rm: "smooth", f: 4 },
        ],
      },
      spc: { lo: 0.5, hi: 4, src: [{ s: "v", c: "lin" }] },
    });
    assert.deepEqual(Object.keys(clean), ["size", "spc"], "target order is canonical");
    assert.deepEqual(sanitizeDynamics({}), {}, "empty dynamics are kept (no mappings at all)");
    for (const bad of [null, 1, "x", []]) assert.equal(sanitizeDynamics(bad), undefined);
    assert.equal(
      canonicalDynamics({ size: { src: [{ s: "p", c: "lin" }], hi: 1, lo: 0.2 } }),
      canonicalDynamics({ size: { lo: 0.2, hi: 1, src: [{ s: "p", c: "lin" }] } }),
    );
  });

  it("lists supported targets per renderer and the sensors in use", () => {
    assert.equal(dynamicsTargets(BRUSHES.airbrush).length, 7);
    assert.deepEqual(dynamicsTargets(BRUSHES.calligraphy), ["size", "asp", "ang"]);
    assert.deepEqual(dynamicsTargets(BRUSHES.pressure), ["size"]);
    assert.deepEqual(dynamicsTargets(BRUSHES.fineliner), []);
    assert.deepEqual(dynamicsTargets(BRUSHES.pixel), []);
    const sensors = dynamicsSensors({
      size: {
        lo: 0,
        hi: 1,
        src: [
          { s: "t", c: "lin" },
          { s: "v", c: "lin" },
        ],
      },
    });
    assert.deepEqual([...sensors].sort(), ["t", "v"]);
  });

  it("omits dynamics equal to the built-in response, keeps custom ones", () => {
    for (const id of ["pressure", "airbrush", "pencil", "calligraphy", "pen"] as const) {
      const brush = BRUSHES[id];
      assert.equal(diffBrushOverride(brush, { dyn: defaultDynamics(brush) }), undefined, id);
    }
    const custom: DynamicsSpec = { size: { lo: 0.1, hi: 1, src: [{ s: "v", c: "inv" }] } };
    assert.deepEqual(diffBrushOverride(BRUSHES.pressure, { dyn: custom })?.dyn, custom);
    // Turning every mapping off differs from a pressure brush's response, but not from the pen's.
    assert.deepEqual(diffBrushOverride(BRUSHES.pressure, { dyn: {} })?.dyn, {});
    assert.equal(diffBrushOverride(BRUSHES.pen, { dyn: {} }), undefined);
    // Defaults reproduce the legacy pressure exponent.
    assert.equal(defaultDynamics(BRUSHES.pressure).size!.src[0]!.c, "pow:0.85");
    assert.equal(defaultDynamics(BRUSHES.pencil).size!.src[1]!.s, "t");
  });

  it("maps sensors through curves onto the output range and combines them", () => {
    const one = compileDynamics({ size: { lo: 0.2, hi: 1, src: [{ s: "p", c: "lin" }] } }, 1, 10);
    assert.equal(one.size!(frame({ p: 0 })), 0.2);
    assert.equal(one.size!(frame({ p: 1 })), 1);
    assert.ok(Math.abs(one.size!(frame({ p: 0.5 })) - 0.6) < 1e-9);
    const src = [
      { s: "p" as const, c: "lin" },
      { s: "t" as const, c: "lin" },
    ];
    const f = frame({ p: 0.8, t: 0.5 });
    const run = (m: "mul" | "min" | "max" | "add") => compileDynamics({ flw: { lo: 0, hi: 1, m, src } }, 1, 10).flw!(f);
    assert.ok(Math.abs(run("mul") - 0.4) < 1e-9);
    assert.equal(run("min"), 0.5);
    assert.equal(run("max"), 0.8);
    assert.equal(run("add"), 1, "sum is clamped");
    const ang = compileDynamics({ ang: { lo: -45, hi: 45, src: [{ s: "p", c: "lin" }] } }, 1, 10);
    assert.equal(ang.ang!(frame({ p: 0.5 })), 0);
    const only = compileDynamics({ flw: { lo: 0, hi: 1, src } }, 1, 10, ["size"]);
    assert.equal(only.flw, undefined, "unsupported targets are not compiled");
  });

  it("reads direction as absolute, relative or across the nib", () => {
    const dir = (dm: "abs" | "rel" | "axial") =>
      compileDynamics({ size: { lo: 0, hi: 1, src: [{ s: "d", c: "lin", dm }] } }, 1, 10).size!;
    assert.equal(dir("abs")(frame({ tan: Math.PI })), 0.5);
    assert.ok(Math.abs(dir("abs")(frame({ tan: -Math.PI / 2 })) - 0.75) < 1e-9);
    assert.equal(dir("rel")(frame({ tan: 1, tan0: 1 })), 0);
    assert.ok(Math.abs(dir("axial")(frame({ tan: Math.PI / 2, nib: 0 })) - 1) < 1e-9);
    assert.ok(dir("axial")(frame({ tan: Math.PI, nib: 0 })) < 1e-9);
  });

  it("draws deterministic random values independent of evaluation order and other mappings", () => {
    const spec: DynamicsSpec = { size: { lo: 0, hi: 1, src: [{ s: "r", c: "lin", rm: "dab" }] } };
    const a = compileDynamics(spec, 1234, 10).size!;
    const b = compileDynamics(
      { ...spec, flw: { lo: 0, hi: 1, src: [{ s: "r", c: "lin", rm: "dab" }] } },
      1234,
      10,
    ).size!;
    const forward = [0, 1, 2, 3, 4].map((i) => a(frame({ i })));
    const backward = [4, 3, 2, 1, 0].map((i) => b(frame({ i }))).reverse();
    assert.deepEqual(forward, backward);
    assert.ok(new Set(forward).size > 3, "values vary per dab");
    const other = compileDynamics(spec, 999, 10).size!;
    assert.notDeepEqual(
      forward,
      [0, 1, 2, 3, 4].map((i) => other(frame({ i }))),
    );
    const stroke = compileDynamics({ size: { lo: 0, hi: 1, src: [{ s: "r", c: "lin", rm: "stroke" }] } }, 7, 10).size!;
    assert.equal(stroke(frame({ i: 0 })), stroke(frame({ i: 50, run: 300 })));
    const smooth = compileDynamics(
      { size: { lo: 0, hi: 1, src: [{ s: "r", c: "lin", rm: "smooth", f: 0.5 }] } },
      7,
      10,
    ).size!;
    let prev = smooth(frame({ run: 0 }));
    for (let r = 0.5; r < 100; r += 0.5) {
      const v = smooth(frame({ run: r }));
      assert.ok(v >= 0 && v <= 1);
      assert.ok(Math.abs(v - prev) < 0.1, "smooth noise changes gradually");
      prev = v;
    }
  });
});

describe("dynamics channels", () => {
  it("round-trips unit channels and rejects malformed input", () => {
    const raw = [0, 0.1, 0.5, 0.999, 1, 0.3, 2, -1, Number.NaN];
    const q = quantizeUnits(raw);
    assert.deepEqual(decodeUnits(encodeUnits(q)), q);
    assert.deepEqual(q.slice(6), [1, 0, 0]);
    assert.equal(decodeUnits(encodeUnits(q), 3)!.length, 3);
    for (const bad of [null, "", "2AA", "1!!!"]) assert.equal(decodeUnits(bad), null);
  });

  it("travels on the wire aligned with the points, or not at all", () => {
    const n = 3;
    const ctx = { author: BOB, scene: SCENE, now: NOW, allowPermanent: true };
    const item = makeItem({
      createdAt: NOW,
      expiresAt: NOW + 60_000,
      tilt: quantizeUnits([0.1, 0.5, 0.9]),
      speed: quantizeUnits([0, 0.4, 0.2]),
      style: { brush: { dyn: { size: { lo: 0.2, hi: 1, src: [{ s: "t", c: "lin" }] } } } },
    });
    const back = sanitizeItem(toWire(item), ctx)!;
    assert.deepEqual(back.tilt, item.tilt);
    assert.deepEqual(back.speed, item.speed);
    assert.deepEqual(back.style.brush?.dyn, item.style.brush?.dyn);
    const wire = toWire(item);
    wire.tilt = encodeUnits([0.1, 0.2]);
    assert.equal(sanitizeItem(wire, ctx)!.tilt, undefined, "misaligned channel dropped");
    const shape = toWire(makeItem({ kind: "shape", tool: "line", tilt: new Array(n).fill(0.5) }));
    assert.equal(sanitizeItem(shape, ctx)?.tilt, undefined, "only strokes carry channels");
    const evil = toWire(makeItem({ style: { brush: { dyn: { size: { lo: 1e9, hi: -1e9, src: "x" } } } as never } }));
    assert.deepEqual(sanitizeItem(evil, ctx)!.style.brush?.dyn, {});
  });

  it("accepts channel deltas in live point updates", () => {
    const base = { v: 1, scene: SCENE, t: "p", id: "Item000000000001", from: 0, pts: "1AA" };
    assert.ok(parseMessage({ ...base, tl: "1AA", sp: "1AA" }));
    assert.equal(parseMessage({ ...base, tl: 5 }), null);
  });

  it("keeps dynamics in preferences and presets", () => {
    const dyn: DynamicsSpec = { flw: { lo: 0, hi: 1, src: [{ s: "v", c: "inv" }] } };
    const p = normalizePrefs({
      brushParams: { airbrush: { dyn, hrd: 0.5 } },
      presets: [{ id: "abc", name: "Fast fade", base: "airbrush", params: { dyn } }],
    });
    assert.deepEqual(p.brushParams.airbrush?.dyn, dyn);
    assert.deepEqual(p.presets[0]!.params.dyn, dyn);
  });

  it("measures tilt from altitude or tiltX/tiltY, pens only", () => {
    assert.equal(tiltOf({ pointerType: "mouse", tiltX: 60 }), 0);
    assert.equal(tiltOf({ pointerType: "pen", altitudeAngle: Math.PI / 2 }), 0);
    assert.ok(Math.abs(tiltOf({ pointerType: "pen", altitudeAngle: Math.PI / 4 }) - 0.5) < 1e-9);
    assert.equal(tiltOf({ pointerType: "pen", tiltX: 75, tiltY: 0 }), 1);
  });

  it("measures speed in CSS pixels per millisecond, independent of zoom", () => {
    const run = (unitsPerPx: number, pxPerMs: number) => {
      const m = new SpeedModel(unitsPerPx);
      let v = 0;
      for (let i = 0; i < 30; i++)
        v = m.next({ x: i * 8 * pxPerMs * unitsPerPx, y: 0, time: i * 8, pressure: 0.5, pointerType: "mouse" });
      return v;
    };
    assert.ok(Math.abs(run(1, 1) - run(4, 1)) < 1e-9);
    assert.ok(run(1, 2) > run(1, 0.5));
    assert.ok(run(1, 0.01) < 0.05);
  });

  it("records the same screen speed on both axes of a nonuniformly resized map", () => {
    const dyn: DynamicsSpec = { size: { lo: 0.2, hi: 1, src: [{ s: "v", c: "lin" }] } };
    const run = (zoom: number, dx: number, dy: number) => {
      const space = new MapSpace(
        { sceneX: 0, sceneY: 0, sceneWidth: 2000, sceneHeight: 1000, refW: 1000, refH: 1000, gridSize: 100 },
        {
          zoom: () => zoom,
          toCanvas: (x, y) => ({ x: x / zoom, y: y / zoom }),
          toClient: (x, y) => ({ x: x * zoom, y: y * zoom }),
        },
      );
      const committed: ScribbleItem[] = [];
      const host: ToolHost = {
        prefs: { ...DEFAULT_PREFS, brushParams: { airbrush: { dyn } } },
        now: () => NOW,
        pressureMode: () => "auto",
        makeItem: (_target, kind, tool, size, points) =>
          makeItem({ kind, tool, size, points, style: { brush: { dyn } } }),
        live() {},
        commit: (item) => committed.push(item),
        cancel() {},
      };
      const first = { cx: 50, cy: 50, time: 1, pressure: 0.6, pointerType: "pen" };
      const last = { ...first, cx: first.cx + dx, cy: first.cy + dy, time: 41 };
      const mods = { shift: false, alt: false };
      const gesture = new FreehandGesture(
        host,
        { mode: "map", space },
        { kind: "stroke", tool: "airbrush", size: 5 },
        first,
      );
      gesture.move([last], mods);
      gesture.up(last, mods);
      return committed[0]!.speed!.at(-1)!;
    };
    const horizontal = run(1, 40, 0);
    assert.ok(horizontal > 0.4 && horizontal < 0.5);
    assert.equal(run(1, 0, 40), horizontal);
    assert.equal(run(2, 0, 40), horizontal);
  });

  it("records tilt and speed per stored point and keeps them aligned through simplification", () => {
    const rec = new StrokeRecorder({
      width: 6,
      streamline: 0,
      pressureMode: "auto",
      usesPressure: true,
      usesTilt: false,
      recordTilt: true,
      recordSpeed: true,
      minDistance: 0.5,
      tolerance: 0.35,
    });
    let time = 0;
    for (let i = 0; i < 200; i++) {
      time += i < 100 ? 16 : 2;
      // Straight line: simplification would keep two points if the channels did not change.
      rec.add({
        x: i * 2,
        y: 0,
        time,
        pressure: 0.6,
        pointerType: "pen",
        // Triangle wave of tilt: corners every 50 samples.
        altitudeAngle: (Math.PI / 2) * (1 - 0.8 * (1 - Math.abs(((i / 50) % 2) - 1))),
      });
    }
    const out = rec.finishWithAngles();
    const n = out.points.length / 3;
    assert.equal(out.tilt!.length, n);
    assert.equal(out.speed!.length, n);
    assert.ok(n >= 5, `tilt corners keep points on a straight line (${n})`);
    assert.ok(out.speed!.at(-1)! > out.speed![1]! + 0.2, "faster second half");
    assert.ok(Math.max(...out.tilt!) > 0.7 && Math.min(...out.tilt!) < 0.1);
    const live = rec.previewData();
    assert.equal(live.tilt!.length, live.points.length / 3);
    // Without channels the old path is unchanged.
    const pts = [0, 0, 0.5, 5, 0, 0.5, 10, 0, 0.5];
    assert.deepEqual(simplifyIndicesToLimit(pts, 0.5, 100), simplifyIndicesToLimit(pts, 0.5, 100, undefined, []));
  });

  it("simplifies sensor changes by position along the stroke, not by sample count", () => {
    const rec = recordTilt([0, 1, 100], [0, 0.5, 1], "lin");
    assert.deepEqual(
      rec.points.filter((_, i) => i % 3 === 0),
      [0, 1, 100],
    );
    assert.deepEqual(rec.tilt, quantizeUnits([0, 0.5, 1]));
  });

  it("retains small sensor changes that cross a response threshold", () => {
    const rec = recordTilt([0, 50, 100], [0.49, 0.51, 0.49], "thr:0.5");
    assert.deepEqual(rec.tilt?.map(compileCurve("thr:0.5")), [0, 1, 0]);
    const linear = recordTilt([0, 50, 100], [0.49, 0.51, 0.49], "lin");
    assert.equal(linear.tilt?.length, 2, "small changes can still be simplified with a linear response");
  });
});

function recordTilt(xs: number[], values: number[], curve: string) {
  const rec = new StrokeRecorder({
    width: 6,
    streamline: 0,
    pressureMode: "off",
    usesPressure: false,
    usesTilt: false,
    recordTilt: true,
    dynamics: { size: { lo: 0.2, hi: 1, src: [{ s: "t", c: curve }] } },
    minDistance: 0.5,
    tolerance: 0.35,
  });
  for (let i = 0; i < xs.length; i++)
    rec.add({
      x: xs[i]!,
      y: 0,
      time: i * 10,
      pressure: 0.6,
      pointerType: "pen",
      altitudeAngle: (Math.PI / 2) * (1 - values[i]!),
    });
  return rec.finishWithAngles();
}

/* -------------------------------------------- */
/*  Painting                                    */
/* -------------------------------------------- */

interface Call {
  name: string;
  args: unknown[];
}

function recordingCtx(calls: Call[]): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = {};
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, k) {
      if (k in state) return state[k];
      if (k === "createImageData")
        return (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
      if (k === "createPattern") return () => ({ setTransform() {} });
      return (...args: unknown[]) => calls.push({ name: String(k), args });
    },
    set(_t, k, v) {
      state[k] = v;
      calls.push({ name: `=${String(k)}`, args: [v] });
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

class FakePath {
  readonly ops: number[][] = [];
  moveTo(x: number, y: number) {
    this.ops.push([x, y]);
  }
  lineTo(x: number, y: number) {
    this.ops.push([x, y]);
  }
  quadraticCurveTo(a: number, b: number, x: number, y: number) {
    this.ops.push([a, b], [x, y]);
  }
  closePath() {}
}

function withCanvasGlobals(t: TestContext): void {
  const set = (key: string, value: unknown) => {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => (old ? Object.defineProperty(globalThis, key, old) : Reflect.deleteProperty(globalThis, key)));
  };
  set("Path2D", FakePath);
  set(
    "OffscreenCanvas",
    class {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return recordingCtx([]);
      }
    },
  );
}

const strokeItem = (over: Partial<ScribbleItem>): ScribbleItem =>
  makeItem({
    id: "ItemDynamics0001",
    size: 10,
    points: [0, 0, 0.1, 40, 0, 0.1, 80, 0, 1, 120, 0, 1],
    ...over,
  });

/** Draw sizes of airbrush dabs (sprite `drawImage` width). */
const dabSizes = (calls: Call[]) => calls.filter((c) => c.name === "drawImage").map((c) => c.args[3] as number);

const fixedTarget = (n: number): DynTargetSpec => ({ lo: n, hi: n, src: [{ s: "p", c: "lin" }] });

function renderedCalls(item: ScribbleItem, scale = 1): Call[] {
  const calls: Call[] = [];
  paintItemLayer(recordingCtx(calls), item, { scale, ox: 0, oy: 0 });
  return calls;
}

describe("painting with dynamics", () => {
  it("modulates dab size, flow and spacing and stays deterministic", (t) => {
    withCanvasGlobals(t);
    const run = (dyn: DynamicsSpec | undefined) => {
      const calls: Call[] = [];
      paintItemLayer(recordingCtx(calls), strokeItem({ tool: "airbrush", style: dyn ? { brush: { dyn } } : {} }), {
        scale: 1,
        ox: 0,
        oy: 0,
      });
      return calls;
    };
    const flat = dabSizes(run({}));
    assert.ok(flat.length > 10);
    assert.equal(new Set(flat.map((v) => v.toFixed(6))).size, 1, "no mappings: constant size");

    const sized = dabSizes(run({ size: { lo: 0.2, hi: 1, src: [{ s: "p", c: "lin" }] } }));
    assert.ok(sized.at(-1)! > sized[0]! * 3, "pressure drives size");

    const alphas = (calls: Call[]) => calls.filter((c) => c.name === "=globalAlpha").map((c) => c.args[0] as number);
    const faded = alphas(run({ flw: { lo: 0, hi: 1, src: [{ s: "p", c: "inv" }] } }));
    assert.ok(faded[0]! > faded.at(-1)!, "inverted curve: light pressure is denser");

    const sparse = dabSizes(run({ spc: { lo: 3, hi: 3, src: [{ s: "p", c: "lin" }] } }));
    assert.ok(sparse.length < flat.length / 2, "spacing dynamics stretch the dab distance");

    const random = { size: { lo: 0.2, hi: 1, src: [{ s: "r" as const, c: "lin", rm: "dab" as const }] } };
    assert.deepEqual(run(random), run(random), "same item, same marks");
  });

  it("feathers bristle fibres and scatters the stamp when those targets are mapped", (t) => {
    withCanvasGlobals(t);
    const run = (dyn: DynamicsSpec) =>
      renderedCalls(strokeItem({ tool: "bristle", points: [0, 0, 0.6], style: { brush: { dyn, grn: 0 } } }));
    assert.ok(
      run({ hrd: fixedTarget(0) }).some((c) => c.name === "drawImage"),
      "soft fibres use a feathered tip",
    );
    assert.ok(
      run({ hrd: fixedTarget(2) }).some((c) => c.name === "ellipse"),
      "hard fibres keep their solid edge",
    );
    const center = (scatter: number) => run({ sct: fixedTarget(scatter) }).find((c) => c.name === "translate")!.args;
    assert.notDeepEqual(center(0), center(2), "scatter moves the fibres away from their original positions");
    assert.deepEqual(center(2), center(2), "scatter stays deterministic");
  });

  it("feathers, turns, and flattens splatter droplets with the corresponding mappings", (t) => {
    withCanvasGlobals(t);
    const run = (dyn: DynamicsSpec) =>
      renderedCalls(strokeItem({ tool: "splatter", points: [0, 0, 0.6], style: { brush: { dyn } } }));
    assert.ok(
      run({ hrd: fixedTarget(0) }).some((c) => c.name === "drawImage"),
      "soft drops use a feathered tip",
    );
    assert.ok(
      run({ hrd: fixedTarget(2) }).some((c) => c.name === "arc"),
      "hard drops keep their solid edge",
    );
    const [x0, y0] = run({ ang: fixedTarget(0) }).find((c) => c.name === "arc")!.args as number[];
    const [x90, y90] = run({ ang: fixedTarget(90) }).find((c) => c.name === "arc")!.args as number[];
    assert.ok(Math.hypot(x90! + y0!, y90! - x0!) < 1e-9, "the same droplet cloud is rotated by 90 degrees");
    const [, , rx, ry] = run({ asp: fixedTarget(0.4) }).find((c) => c.name === "ellipse")!.args as number[];
    assert.ok(Math.abs(ry! / rx! - 0.4) < 1e-9, "flatness changes the ratio of the droplet radii");
  });

  it("varies the outline width of ribbon brushes", (t) => {
    withCanvasGlobals(t);
    const width = (dyn: DynamicsSpec) => {
      const calls: Call[] = [];
      paintItemLayer(
        recordingCtx(calls),
        strokeItem({ tool: "pen", points: [0, 0, 0.5, 50, 0, 0.5, 100, 0, 0.5], style: { brush: { dyn } } }),
        { scale: 1, ox: 0, oy: 0 },
      );
      const path = calls.find((c) => c.name === "fill")!.args[0] as FakePath;
      return Math.max(...path.ops.filter(([x]) => x > 30 && x < 70).map(([, y]) => Math.abs(y!))) * 2;
    };
    const full = width({ size: { lo: 1, hi: 1, src: [{ s: "p", c: "lin" }] } });
    const half = width({ size: { lo: 0.5, hi: 0.5, src: [{ s: "p", c: "lin" }] } });
    assert.ok(Math.abs(full - 10) < 0.5, `diameter = size × m (${full})`);
    assert.ok(Math.abs(half - 5) < 0.5, `half width (${half})`);
  });

  it("draws a saved random-size ribbon with identical geometry at different view scales", (t) => {
    withCanvasGlobals(t);
    const item = strokeItem({
      tool: "pen",
      points: [0, 0, 0.5, 20, 20, 0.5, 50, -20, 0.5, 90, 0, 0.5],
      style: { brush: { dyn: { size: { lo: 0.2, hi: 2, src: [{ s: "r", c: "lin", rm: "dab" }] } } } },
    });
    const outline = (scale: number) =>
      (renderedCalls({ ...item }, scale).find((c) => c.name === "fill")!.args[0] as FakePath).ops;
    const normal = outline(1);
    assert.ok(normal.length > 10);
    assert.deepEqual(outline(0.2), normal);
    assert.deepEqual(outline(3), normal);
  });

  it("mirrors dynamic nib offsets and keeps them unchanged for a rotation", (t) => {
    withCanvasGlobals(t);
    const item = strokeItem({
      tool: "bristle",
      points: [0, 0, 0, 40, 0, 1],
      style: { brush: { am: "fixed", ang: 0, grn: 0, dyn: { ang: { lo: 30, hi: -50, src: [{ s: "p", c: "lin" }] } } } },
    });
    const flipped = transformItem(item, scale(1, -1));
    const angles = (stroke: ScribbleItem) =>
      renderedCalls(stroke)
        .filter((c) => c.name === "rotate")
        .map((c) => c.args[0] as number);
    const original = angles(item);
    const mirrored = angles(flipped);
    assert.ok(original[0]! > 0 && original.at(-1)! < 0);
    assert.equal(mirrored.length, original.length);
    assert.ok(mirrored.every((angle, i) => Math.abs(angle + original[i]!) < 1e-9));
    assert.deepEqual(transformItem(item, rotate(Math.PI / 2)).style.brush?.dyn, item.style.brush?.dyn);
  });

  it("grows culling bounds with size dynamics", () => {
    const base = itemBounds(strokeItem({ tool: "airbrush" }));
    const grown = itemBounds(
      strokeItem({
        tool: "airbrush",
        style: { brush: { dyn: { size: { lo: 1, hi: 2, src: [{ s: "p", c: "lin" }] } } } },
      }),
    );
    assert.ok(grown[3] - grown[1] > base[3] - base[1]);
  });
});
