import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRUSHES, DRAW_BRUSHES, diffBrushOverride, resolveBrushParams } from "../src/brush/brushes.ts";
import { effectiveBlend } from "../src/brush/paint.ts";
import { decodeAngles, encodeAngles, quantizeAngles } from "../src/core/codec.ts";
import { sanitizeItem, toWire } from "../src/core/sanitize.ts";
import { itemBounds } from "../src/core/store.ts";
import { BRUSH_IDS } from "../src/core/types.ts";
import { readStored } from "../src/foundry/persistence.ts";
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
