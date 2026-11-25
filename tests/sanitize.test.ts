import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIMITS } from "../src/constants.ts";
import { quantizePoints } from "../src/core/codec.ts";
import { inExtent, sanitizeItem, toWire, wireSize } from "../src/core/sanitize.ts";
import type { SanitizeContext } from "../src/core/sanitize.ts";
import { ALICE, BOB, SCENE, line, makeItem } from "./helpers.ts";

const NOW = 1_000_000;
const ctx = (over: Partial<SanitizeContext> = {}): SanitizeContext => ({
  author: BOB,
  scene: SCENE,
  now: NOW,
  allowPermanent: false,
  mapExtent: { w: 3000, h: 2000 },
  ...over,
});

describe("sanitizeItem", () => {
  it("accepts a valid wire item and round-trips its geometry", () => {
    const item = makeItem({ author: BOB, createdAt: NOW, expiresAt: NOW + 5000 });
    const out = sanitizeItem(toWire(item), ctx());
    assert.ok(out);
    assert.deepEqual(out.points, quantizePoints(item.points));
    assert.equal(out.color, "#ff0000");
  });

  it("never trusts the author in the payload", () => {
    const wire = {
      ...toWire(makeItem({ author: ALICE, createdAt: NOW, expiresAt: NOW + 5000 })),
      role: 4,
      permission: "gm",
    };
    const out = sanitizeItem(wire, ctx({ author: BOB }));
    assert.equal(out?.author, BOB);
    assert.ok(!("role" in out!) && !("permission" in out!));
  });

  it("refuses permanent items unless allowed", () => {
    const wire = toWire(makeItem({ createdAt: NOW, expiresAt: null }));
    assert.equal(sanitizeItem(wire, ctx()), null);
    assert.equal(sanitizeItem(wire, ctx({ allowPermanent: true }))?.expiresAt, null);
  });

  it("rejects wrong scene, schema, id, colour, kind/tool combinations", () => {
    const base = toWire(makeItem({ createdAt: NOW, expiresAt: NOW + 5000 }));
    const bad: Record<string, unknown>[] = [
      { scene: "OtherSceneAaaaaa" },
      { schemaVersion: 2 },
      { id: "x" },
      { id: "has spaces in it!" },
      { color: "red" },
      { color: "#ff00001" },
      { kind: "stroke", tool: "rect" },
      { kind: "shape", tool: "pen" },
      { kind: "virus", tool: "virus" },
      { mode: "world" },
      { points: "garbage" },
    ];
    for (const patch of bad) assert.equal(sanitizeItem({ ...base, ...patch }, ctx()), null, JSON.stringify(patch));
  });

  it("clamps numbers and lifetimes", () => {
    const wire = {
      ...toWire(makeItem({ createdAt: NOW })),
      opacity: 9,
      size: -3,
      fadeDuration: 1e9,
      expiresAt: NOW + 1e12,
    };
    const out = sanitizeItem(wire, ctx())!;
    assert.equal(out.opacity, 1);
    assert.equal(out.size, 0.1);
    assert.equal(out.fadeDuration, LIMITS.maxFadeMs);
    assert.equal(out.expiresAt! - out.createdAt, LIMITS.maxLifetimeMs);
  });

  it("replaces a skewed createdAt with the receiver's time", () => {
    const wire = toWire(makeItem({ createdAt: NOW - 10 * 60_000, expiresAt: NOW - 10 * 60_000 + 3_600_000 }));
    assert.equal(sanitizeItem(wire, ctx())!.createdAt, NOW);
  });

  it("drops items that are already gone", () => {
    const wire = toWire(makeItem({ createdAt: NOW - 20_000, expiresAt: NOW - 15_000, fadeDuration: 500 }));
    assert.equal(sanitizeItem(wire, ctx()), null);
    assert.ok(sanitizeItem(wire, ctx({ allowExpired: true })));
  });

  it("rejects map points far outside the scene and screen points far off-screen", () => {
    const far = toWire(makeItem({ createdAt: NOW, points: [0, 0, 0.5, 50_000, 0, 0.5] }));
    assert.equal(sanitizeItem(far, ctx()), null);
    const screen = toWire(
      makeItem({ mode: "screen", layer: "top", createdAt: NOW, points: [0, 0, 0.5, 9000, 0, 0.5] }),
    );
    assert.equal(sanitizeItem(screen, ctx()), null);
  });

  it("forces screen items to the top layer and normalises anchors", () => {
    const wire = { ...toWire(makeItem({ mode: "screen", createdAt: NOW })), layer: "below", anchor: [7, -0.2] };
    const out = sanitizeItem(wire, ctx())!;
    assert.equal(out.layer, "top");
    assert.deepEqual(out.anchor, [1, -1]);
  });

  it("strips control characters from text and caps its length", () => {
    const wire = {
      ...toWire(makeItem({ kind: "text", tool: "text", createdAt: NOW })),
      text: "a\u0000b\u001b[31m\nc" + "x".repeat(500),
    };
    const out = sanitizeItem(wire, ctx())!;
    assert.ok(out.text!.startsWith("ab[31m\nc"));
    assert.equal(out.text!.length, LIMITS.maxTextLength);
    const blank = { ...wire, text: "\u0000 \u0001" };
    assert.equal(sanitizeItem(blank, ctx()), null);
  });

  it("only keeps known style flags", () => {
    const wire = {
      ...toWire(makeItem({ createdAt: NOW })),
      style: { dash: true, head: "both", fill: 5, onclick: "alert(1)" },
    };
    assert.deepEqual(sanitizeItem(wire, ctx())!.style, { dash: true, head: "both", fill: 1 });
  });

  it("keeps erase masks and limits their number", () => {
    const masks = Array.from({ length: LIMITS.maxMasksPerItem + 10 }, () => ({
      size: 3,
      points: [1, 1, 0.5, 2, 2, 0.5],
    }));
    const out = sanitizeItem(toWire(makeItem({ createdAt: NOW, erase: masks })), ctx())!;
    assert.equal(out.erase!.length, LIMITS.maxMasksPerItem);
  });

  it("caps points per item", () => {
    const wire = toWire(makeItem({ createdAt: NOW, points: line(LIMITS.maxPointsPerItem + 500, 0.5) }));
    assert.equal(sanitizeItem(wire, ctx())!.points.length / 3, LIMITS.maxPointsPerItem);
  });
});

describe("inExtent / wireSize", () => {
  it("allows a margin around the scene", () => {
    assert.ok(inExtent([-2999, -1999, 0.5], "map", { mapExtent: { w: 3000, h: 2000 } }));
    assert.ok(!inExtent([-3001, 0, 0.5], "map", { mapExtent: { w: 3000, h: 2000 } }));
  });

  it("measures the encoded size", () => {
    const item = makeItem();
    assert.equal(wireSize(item), JSON.stringify(toWire(item)).length);
  });
});
