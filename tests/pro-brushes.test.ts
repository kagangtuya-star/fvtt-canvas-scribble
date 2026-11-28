import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRUSHES, DRAW_BRUSHES, diffBrushOverride, resolveBrushParams } from "../src/brush/brushes.ts";
import { effectiveBlend } from "../src/brush/paint.ts";
import { recognizeQuickShape } from "../src/brush/quickshape.ts";
import { StrokeRecorder, realPenAngle } from "../src/brush/recorder.ts";
import { StrokeStabilizer } from "../src/brush/stabilizer.ts";
import { cloneTransformedItem, symmetryTransforms } from "../src/brush/symmetry.ts";
import { decodeAngles, encodeAngles, quantizeAngles, quantizePoints } from "../src/core/codec.ts";
import { sanitizeItem, toWire } from "../src/core/sanitize.ts";
import { itemBounds } from "../src/core/store.ts";
import { BRUSH_IDS } from "../src/core/types.ts";
import { readStored } from "../src/foundry/persistence.ts";
import { DEFAULT_PREFS, activeBrushId, brushBlend, brushOpacity, normalizePrefs } from "../src/state/prefs.ts";
import { rotateItem, scaleItem, translateItem } from "../src/tools/select.ts";
import { BOB, SCENE, makeItem } from "./helpers.ts";

const NOW = 1_000_000;

describe("angle codec", () => {
  it("round-trips quantised angles across the ±PI seam", () => {
    const raw = [-Math.PI, -2.5, -0.3, 0, 0.7, 2.8, Math.PI - 0.01, -Math.PI + 0.02];
    const q = quantizeAngles(raw);
    const enc = encodeAngles(q);
    assert.deepEqual(decodeAngles(enc), q);
    assert.ok(enc.length < raw.length * 3, `compact encoding: ${enc.length}`);
  });

  it("handles empty arrays, maxPoints and malformed input", () => {
    assert.deepEqual(decodeAngles(encodeAngles([])), []);
    const many = Array.from({ length: 50 }, (_, i) => (i * 0.1) % Math.PI);
    assert.equal(decodeAngles(encodeAngles(many), 12)!.length, 12);
    for (const bad of [null, "", "2AAA", "1!!!"]) assert.equal(decodeAngles(bad), null);
  });
});

describe("pro brushes & sanitize", () => {
  it("defines every rectangular & pro brush id and resolves/diffs overrides", () => {
    for (const id of [
      "flat",
      "calligraphy",
      "bristle",
      "pixel",
      "charcoal",
      "airbrush",
      "watercolor",
      "neon",
      "splatter",
    ] as const) {
      assert.ok(BRUSH_IDS.includes(id));
      assert.ok(DRAW_BRUSHES.includes(id));
      assert.ok(BRUSHES[id]);
    }
    const flat = BRUSHES.flat;
    const res = resolveBrushParams(flat, { ang: -45, asp: 0.25, cor: 0.2 });
    assert.equal(res.angle, -45);
    assert.equal(res.aspect, 0.25);
    assert.equal(res.corner, 0.2);
    // Identical values are omitted by diffBrushOverride
    assert.equal(diffBrushOverride(flat, { ang: flat.angle, asp: flat.aspect }), undefined);
    assert.deepEqual(diffBrushOverride(flat, { ang: 30, asp: flat.aspect }), { ang: 30 });
  });

  it("sanitizes and clamps BrushOverride, blend, fillPattern, angles and rect erase masks", () => {
    const item = makeItem({
      tool: "flat",
      createdAt: NOW,
      expiresAt: NOW + 5000,
      points: [0, 0, 0.5, 40, 0, 0.7],
      angles: quantizeAngles([0.2, 0.9]),
      style: {
        blend: "multiply",
        fillPattern: "hachure",
        brush: { ang: 999, am: "twist", asp: 0.001, cor: 5, hrd: -1, flw: 0, spc: 0.0001, sct: 99, grn: 2, rgh: 9 },
      },
      erase: [{ size: 12, points: [10, 0, 0.5, 20, 0, 0.5], tip: "rect", ang: -30, asp: 0.4, hrd: 0.5 }],
    });
    const out = sanitizeItem(toWire(item), {
      author: BOB,
      scene: SCENE,
      now: NOW,
      allowPermanent: false,
      mapExtent: { w: 3000, h: 2000 },
    })!;
    assert.ok(out);
    assert.equal(out.style.blend, "multiply");
    assert.equal(out.style.fillPattern, "hachure");
    assert.deepEqual(out.style.brush, {
      ang: 180,
      am: "twist",
      asp: 0.05,
      cor: 1,
      hrd: 0,
      flw: 0.05,
      spc: 0.08,
      sct: 3,
      grn: 1,
      rgh: 3,
    });
    assert.deepEqual(out.angles, item.angles);
    assert.equal(out.erase![0]!.tip, "rect");
    assert.equal(out.erase![0]!.ang, -30);
    assert.equal(out.erase![0]!.asp, 0.4);
    assert.equal(out.erase![0]!.hrd, 0.5);
  });

  it("pads itemBounds for scatter, neon glow and rough shapes", () => {
    const plain = itemBounds(makeItem({ tool: "pen", size: 10, points: [0, 0, 0.5, 50, 0, 0.5] }));
    const splatter = itemBounds(makeItem({ tool: "splatter", size: 10, points: [0, 0, 0.5, 50, 0, 0.5] }));
    const roughRect = itemBounds(
      makeItem({
        kind: "shape",
        tool: "rect",
        size: 10,
        points: [0, 0, 0.5, 50, 50, 0.5],
        style: { brush: { rgh: 2 } },
      }),
    );
    assert.ok(splatter[0] < plain[0] && splatter[2] > plain[2]);
    assert.ok(roughRect[0] < plain[0]);
  });

  it("keeps an explicit normal blend through sockets and scene flags", () => {
    const water = makeItem({ tool: "watercolor", createdAt: NOW, expiresAt: null, style: { blend: "normal" } });
    assert.equal(effectiveBlend({ ...water, style: {} }), "multiply");
    const wire = toWire(water);
    const received = sanitizeItem(wire, { author: BOB, scene: SCENE, now: NOW, allowPermanent: true });
    const stored = readStored({ id: SCENE } as FoundryScene, water.id, wire, NOW);
    assert.ok(received && stored);
    assert.equal(effectiveBlend(received), "normal");
    assert.equal(effectiveBlend(stored), "normal");
  });
});

describe("stabilizer & pen angle recorder", () => {
  it("smooths jitter with dejitter and in lazy mode", () => {
    const euro = new StrokeStabilizer({ mode: "off", strength: 0.5, dejitter: 0.8, unitsPerPx: 1 });
    const lazy = new StrokeStabilizer({ mode: "lazy", strength: 0.5, unitsPerPx: 1 });
    const p0 = euro.filter(0, 0, 0);
    const p1 = euro.filter(10, 8, 16);
    assert.deepEqual(p0, { x: 0, y: 0 });
    assert.ok(p1.x > 0 && p1.x < 10);

    const l0 = lazy.filter(0, 0, 0);
    const l1 = lazy.filter(5, 0, 16); // inside lazy string radius → stays anchored
    const l2 = lazy.filter(80, 0, 32); // pulls beyond radius → moves
    assert.deepEqual(l0, { x: 0, y: 0 });
    assert.equal(l1.x, 0);
    assert.ok(l2.x > 30 && l2.x < 80);
  });

  it("captures pen twist and tilt angles and falls back cleanly for mice", () => {
    assert.ok(Math.abs(realPenAngle({ pointerType: "pen", twist: 90 })! - Math.PI / 2) < 1e-6);
    assert.ok(Math.abs(realPenAngle({ pointerType: "pen", tiltX: 0, tiltY: 30 })! - Math.PI / 2) < 1e-6);
    assert.equal(realPenAngle({ pointerType: "mouse", twist: 90, tiltX: 30, tiltY: 0 }), null);

    const rec = new StrokeRecorder({
      width: 10,
      streamline: 0.2,
      pressureMode: "auto",
      usesPressure: true,
      usesTilt: true,
      recordAngles: true,
      minDistance: 0.5,
      tolerance: 0.3,
    });
    for (let i = 0; i < 20; i++) {
      rec.add({ x: i * 5, y: i * 2, time: i * 16, pressure: 0.7, pointerType: "pen", twist: 20 + i * 3 });
    }
    const { points, angles } = rec.finishWithAngles();
    assert.ok(angles && angles.length === points.length / 3);
    assert.ok(rec.usesRealAngles);
  });

  it("keeps a mid-stroke twist and the exact angles of distant endpoints", () => {
    const rec = new StrokeRecorder({
      width: 10,
      streamline: 0,
      pressureMode: "off",
      usesPressure: false,
      usesTilt: false,
      recordAngles: true,
      minDistance: 0.5,
      tolerance: 0.35,
    });
    for (let x = 0; x <= 400; x++) {
      const twist = x <= 150 ? 20 + (x * 70) / 150 : 90 - ((x - 150) * 40) / 250;
      rec.add({ x, y: 0, time: x, pressure: 0.5, pointerType: "pen", twist });
    }
    const { points, angles } = rec.finishWithAngles();
    assert.deepEqual(
      points.filter((_, i) => i % 3 === 0),
      [0, 150, 400],
    );
    assert.deepEqual(angles, quantizeAngles([20, 90, 50].map((deg) => (deg * Math.PI) / 180)));
  });
});

describe("QuickShape recognition", () => {
  it("recognizes a freehand line", () => {
    const pts: number[] = [];
    for (let i = 0; i <= 20; i++) pts.push(i * 10, Math.sin(i) * 1.5, 0.5);
    const m = recognizeQuickShape(pts);
    assert.equal(m?.tool, "line");
  });

  it("recognizes a freehand circle", () => {
    const pts: number[] = [];
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      pts.push(100 + Math.cos(a) * 60, 100 + Math.sin(a) * 58, 0.5);
    }
    const m = recognizeQuickShape(pts);
    assert.equal(m?.tool, "ellipse");
  });

  it("recognizes a freehand rectangle", () => {
    const pts: number[] = [];
    const seg = (x0: number, y0: number, x1: number, y1: number) => {
      for (let i = 0; i < 10; i++) pts.push(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10, 0.5);
    };
    seg(0, 0, 120, 0);
    seg(120, 0, 120, 80);
    seg(120, 80, 0, 80);
    seg(0, 80, 0, 0);
    pts.push(0, 0, 0.5);
    const m = recognizeQuickShape(pts);
    assert.equal(m?.tool, "rect");
  });

  it("recognizes a freehand triangle", () => {
    const pts: number[] = [];
    const seg = (x0: number, y0: number, x1: number, y1: number) => {
      for (let i = 0; i < 10; i++) pts.push(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10, 0.5);
    };
    seg(0, 100, 60, 0);
    seg(60, 0, 120, 100);
    seg(120, 100, 0, 100);
    pts.push(0, 100, 0.5);
    const m = recognizeQuickShape(pts);
    assert.equal(m?.tool, "polygon");
    assert.equal(m?.closed, true);
    assert.equal(m?.points.length, 9);
  });

  it("ignores an open wavy scribble", () => {
    const pts: number[] = [];
    for (let i = 0; i <= 30; i++) pts.push(i * 6, Math.sin(i * 0.6) * 40, 0.5);
    assert.equal(recognizeQuickShape(pts), null);
  });
});

describe("symmetry & select/transform", () => {
  it("generates mirror and radial transforms cleanly", () => {
    assert.equal(symmetryTransforms("vertical", 100, 100).length, 2);
    assert.equal(symmetryTransforms("quad", 100, 100).length, 4);
    assert.equal(symmetryTransforms("radial8", 100, 100).length, 8);
    const item = makeItem({ tool: "flat", points: [120, 80, 0.5], style: { brush: { ang: 30 } } });
    const mirror = cloneTransformedItem(item, "mirrored_item_id", symmetryTransforms("vertical", 100, 100)[1]!);
    assert.equal(mirror.points[0], 80);
    assert.equal(mirror.points[1], 80);
    assert.equal(mirror.style.brush?.ang, 150);
  });

  it("mirrors the preset nib and preserves the area of rotated QuickShape rectangles", () => {
    const center = 50;
    const horizontal = symmetryTransforms("horizontal", center, center)[1]!;
    const calligraphy = makeItem({ tool: "calligraphy" });
    assert.equal(cloneTransformedItem(calligraphy, "mirror", horizontal).style.brush?.ang, 35);

    const rect = makeItem({ kind: "shape", tool: "rect", points: [0, 0, 0.5, 100, 100, 0.5] });
    const radial = symmetryTransforms("radial8", center, center);
    const diamond = cloneTransformedItem(rect, "radial1", radial[1]!);
    const quarterTurn = cloneTransformedItem(rect, "radial2", radial[2]!);
    assert.equal(diamond.tool, "polygon");
    assert.equal(diamond.style.closed, true);
    assert.equal(diamond.points.length, 12);
    const xs = diamond.points.filter((_, i) => i % 3 === 0);
    const ys = diamond.points.filter((_, i) => i % 3 === 1);
    assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 100 * Math.SQRT2) < 0.01);
    assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 100 * Math.SQRT2) < 0.01);
    assert.equal(quarterTurn.tool, "rect");
    assert.deepEqual(quantizePoints(quarterTurn.points), quantizePoints(rect.points));
  });

  it("translates, scales and rotates items (promoting rotated rect to polygon)", () => {
    const stroke = makeItem({ points: [0, 0, 0.5, 20, 0, 0.5], size: 4 });
    const moved = translateItem(stroke, 10, -5);
    assert.deepEqual(moved.points, quantizePoints([10, -5, 0.5, 30, -5, 0.5]));
    assert.equal(moved.revision, 1);

    const scaled = scaleItem(stroke, 0, 0, 2, 2);
    assert.deepEqual(scaled.points, quantizePoints([0, 0, 0.5, 40, 0, 0.5]));
    assert.equal(scaled.size, 8);

    const rect = makeItem({ kind: "shape", tool: "rect", points: [0, 0, 0.5, 20, 10, 0.5] });
    const rotated = rotateItem(rect, 10, 5, Math.PI / 3);
    assert.equal(rotated.tool, "polygon");
    assert.equal(rotated.style.closed, true);
    assert.equal(rotated.points.length, 12);
    // Quarter turns keep an axis-aligned rectangle (same area, swapped sides).
    const quarter = rotateItem(rect, 10, 5, Math.PI / 2);
    assert.equal(quarter.tool, "rect");
    assert.deepEqual(quarter.points, quantizePoints([5, -5, 0.5, 15, 15, 0.5]));
  });
});

describe("pro prefs normalization", () => {
  it("validates presets, brushParams, stabilizer, symmetry and helpers", () => {
    const p = normalizePrefs({
      brush: "flat",
      opacities: { flat: 0.75, pen: 99 },
      blends: { flat: "multiply", pen: "bogus" },
      brushParams: { flat: { ang: -45, asp: 0.3 } },
      stabilizer: "lazy",
      stabilizerStrength: 0.6,
      symmetry: "radial6",
      gridSnap: true,
      roughness: 1.5,
      fillPattern: "cross-hatch",
      presets: [
        { id: "p1", name: "My Flat", base: "flat", size: 16, opacity: 0.8, blend: "multiply", params: { ang: -30 } },
      ],
    });
    assert.equal(activeBrushId(p), "flat");
    assert.equal(brushOpacity(p, "flat"), 0.75);
    assert.equal(brushOpacity(p, "pen"), 1);
    assert.equal(brushBlend(p, "flat"), "multiply");
    assert.equal(brushBlend(p, "pen"), "normal");
    assert.equal(p.stabilizer, "lazy");
    assert.equal(p.symmetry, "radial6");
    assert.equal(p.gridSnap, true);
    assert.equal(p.roughness, 1.5);
    assert.equal(p.fillPattern, "cross-hatch");
    assert.equal(p.presets.length, 1);
    assert.equal(p.presets[0]!.name, "My Flat");
    assert.equal(DEFAULT_PREFS.quickShape, true);
  });
});
