import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRUSHES, DRAW_BRUSHES } from "../src/brush/brushes.ts";
import { PressureModel, StrokeRecorder, hasRealPressure, tiltAmount } from "../src/brush/recorder.ts";
import { arrowHead, dragShape, shapeIsDegenerate, snapAngle } from "../src/brush/shapes.ts";
import { LIMITS } from "../src/constants.ts";
import {
  boundsOf,
  distToPolyline,
  pointInPolygon,
  polylineLength,
  resample,
  simplify,
  simplifyToLimit,
} from "../src/core/geometry.ts";
import { BRUSH_IDS } from "../src/core/types.ts";
import { line } from "./helpers.ts";

describe("geometry", () => {
  it("simplifies collinear points to the endpoints", () => {
    assert.deepEqual(simplify(line(100), 0.5), [0, 0, 0.5, 99, 0, 0.5]);
  });

  it("keeps corners and pressure changes", () => {
    const corner = [0, 0, 0.5, 5, 0, 0.5, 10, 0, 0.5, 10, 5, 0.5, 10, 10, 0.5];
    assert.equal(simplify(corner, 0.5).length / 3, 3);
    const pressure = [0, 0, 0.2, 5, 0, 0.9, 10, 0, 0.2];
    assert.equal(simplify(pressure, 0.5).length / 3, 3);
  });

  it("degrades to the point limit without losing the ends", () => {
    const pts: number[] = [];
    for (let i = 0; i < 20_000; i++) pts.push(i, Math.sin(i) * 50, Math.random());
    const out = simplifyToLimit(pts, 0.1, 500);
    assert.ok(out.length / 3 <= 500);
    assert.deepEqual(out.slice(0, 2), [0, 0]);
    assert.equal(out.at(-3), 19_999);
  });

  it("measures distance, containment, length and bounds", () => {
    const sq = [0, 0, 0.5, 10, 0, 0.5, 10, 10, 0.5, 0, 10, 0.5];
    assert.ok(pointInPolygon(5, 5, sq));
    assert.ok(!pointInPolygon(15, 5, sq));
    assert.equal(distToPolyline(5, -3, sq), 3);
    assert.equal(distToPolyline(-2, 5, sq, true), 2);
    assert.equal(polylineLength(sq), 30);
    assert.deepEqual(boundsOf(sq, 1), [-1, -1, 11, 11]);
  });

  it("resamples densely without moving the endpoints", () => {
    const pts = [0, 0, 0.5, 10, 0, 0.5, 20, 10, 0.5];
    const out = resample(pts, 1);
    assert.ok(out.length / 3 > 20);
    assert.deepEqual(out.slice(0, 2), [0, 0]);
    assert.deepEqual(out.slice(-3, -1), [20, 10]);
  });
});

describe("brush registry", () => {
  it("defines every brush id", () => {
    for (const id of BRUSH_IDS) assert.ok(BRUSHES[id], id);
    for (const id of DRAW_BRUSHES) assert.ok(BRUSH_IDS.includes(id));
  });
});

describe("pressure and recorder", () => {
  it("distinguishes real pen pressure from mouse defaults", () => {
    assert.ok(hasRealPressure({ pointerType: "pen", pressure: 0.7 }));
    assert.ok(!hasRealPressure({ pointerType: "pen", pressure: 0.5 }));
    assert.ok(!hasRealPressure({ pointerType: "mouse", pressure: 0.8 }));
    assert.equal(tiltAmount({ tiltX: 0, tiltY: 0 }), 0);
    assert.equal(tiltAmount({ tiltX: 90, tiltY: 0 }), 1);
  });

  it("simulates thinner lines for fast mouse movement", () => {
    const sample = (x: number, t: number) => ({ x, y: 0, time: t, pressure: 0.5, pointerType: "mouse" });
    const slow = new PressureModel("auto", 4);
    const fast = new PressureModel("auto", 4);
    let ps = 0;
    let pf = 0;
    for (let i = 0; i < 60; i++) {
      ps = slow.next(sample(i * 0.5, i * 16));
      pf = fast.next(sample(i * 40, i * 16));
    }
    assert.ok(pf < ps, `fast ${pf} < slow ${ps}`);
    assert.equal(new PressureModel("off", 4).next(sample(0, 0)), 0.5);
  });

  it("follows real pen pressure in auto mode", () => {
    const m = new PressureModel("auto", 4);
    const v = m.next({ x: 0, y: 0, time: 0, pressure: 0.9, pointerType: "pen" });
    assert.ok(v > 0.85 && m.usesRealPressure);
  });

  it("records, simplifies and chains long strokes", () => {
    const rec = new StrokeRecorder({
      width: 4,
      streamline: 0.4,
      pressureMode: "auto",
      usesPressure: true,
      usesTilt: false,
      minDistance: 0.5,
      tolerance: 0.2,
    });
    for (let i = 0; i < 200; i++)
      rec.add({ x: i, y: Math.sin(i / 10) * 20, time: i * 8, pressure: 0.5, pointerType: "mouse" });
    const out = rec.finish();
    assert.ok(out.length / 3 >= 10 && out.length / 3 < 200);
    assert.ok(out.length / 3 <= LIMITS.maxPointsPerItem);
    const next = rec.chain();
    assert.equal(next.pointCount, 1);
  });

  it("draws a straight line while Shift is held", () => {
    const rec = new StrokeRecorder({
      width: 4,
      streamline: 0.4,
      pressureMode: "off",
      usesPressure: false,
      usesTilt: false,
      minDistance: 0.5,
      tolerance: 0.2,
    });
    rec.line = true;
    rec.add({ x: 0, y: 0, time: 0, pressure: 0.5, pointerType: "mouse" });
    rec.add({ x: 50, y: 37, time: 10, pressure: 0.5, pointerType: "mouse" });
    rec.add({ x: 100, y: 0, time: 20, pressure: 0.5, pointerType: "mouse" });
    const pts = rec.finish();
    for (let i = 1; i < pts.length; i += 3) assert.equal(pts[i], 0);
  });
});

describe("shapes", () => {
  it("snaps lines to 15° with Shift", () => {
    const p = snapAngle({ x: 0, y: 0 }, { x: 100, y: 3 });
    assert.ok(Math.abs(p.y) < 1e-9);
  });

  it("makes squares with Shift and centres with Alt", () => {
    assert.deepEqual(
      dragShape("rect", { x: 0, y: 0 }, { x: 10, y: 4 }, { shift: true, alt: false }),
      [0, 0, 0.5, 10, 10, 0.5],
    );
    assert.deepEqual(
      dragShape("ellipse", { x: 0, y: 0 }, { x: 10, y: 4 }, { shift: false, alt: true }),
      [-10, -4, 0.5, 10, 4, 0.5],
    );
  });

  it("ignores accidental clicks", () => {
    assert.ok(shapeIsDegenerate([0, 0, 0.5, 1, 1, 0.5], 3));
    assert.ok(!shapeIsDegenerate([0, 0, 0.5, 10, 0, 0.5], 3));
  });

  it("points arrow heads at the tip", () => {
    const [tip, a, b] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
    assert.deepEqual(tip, { x: 100, y: 0 });
    assert.ok(a.x < 100 && b.x < 100 && a.y === -b.y);
  });
});
