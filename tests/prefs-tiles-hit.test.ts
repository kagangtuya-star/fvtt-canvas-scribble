import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PALETTE } from "../src/brush/brushes.ts";
import { LIMITS } from "../src/constants.ts";
import { ItemStore } from "../src/core/store.ts";
import { TILE_INNER, tierFor, tileRange } from "../src/render/tiles.ts";
import { DEFAULT_PREFS, normalizePrefs, pushRecent, sizeKey } from "../src/state/prefs.ts";
import { hitItem, hitPath } from "../src/tools/hit.ts";
import { makeItem } from "./helpers.ts";

describe("prefs", () => {
  it("turns garbage into defaults", () => {
    for (const raw of [null, 7, "x", [], { tool: "nuke", mode: "space", color: "javascript:", sizes: { pen: 1e9 } }]) {
      const p = normalizePrefs(raw);
      assert.equal(p.tool, DEFAULT_PREFS.tool);
      assert.ok(p.mode === "screen" || p.mode === "map");
      assert.equal(p.color, null);
      assert.ok(p.sizes.pen <= 64);
    }
  });

  it("keeps valid values and clamps lifetimes", () => {
    const p = normalizePrefs({
      mode: "map",
      tool: "laser",
      color: "#123abc",
      lifetime: { screen: 0, map: 1e12 },
      palette: { x: 10.4, y: 20.6 },
    });
    assert.equal(p.mode, "map");
    assert.equal(p.tool, "laser");
    assert.equal(p.color, "#123abc");
    assert.equal(p.lifetime.screen, DEFAULT_PREFS.lifetime.screen, "screen marks are never permanent");
    assert.equal(p.lifetime.map, LIMITS.maxLifetimeMs);
    assert.deepEqual(p.palette, { x: 10, y: 21 });
  });

  it("picks the size key of the active tool", () => {
    assert.equal(sizeKey({ ...DEFAULT_PREFS, tool: "draw", brush: "chalk" }), "chalk");
    assert.equal(sizeKey({ ...DEFAULT_PREFS, tool: "highlight", highlight: "area" }), "area");
    assert.equal(sizeKey({ ...DEFAULT_PREFS, tool: "eraser" }), "eraser");
  });

  it("tracks recent custom colours only", () => {
    const p = { ...DEFAULT_PREFS, recent: ["#111111"] };
    assert.deepEqual(pushRecent(p, "#222222"), ["#222222", "#111111"]);
    assert.deepEqual(pushRecent(p, DEFAULT_PALETTE[0]!), ["#111111"]);
  });
});

describe("tile cache helpers", () => {
  it("chooses power-of-two tiers with hysteresis-free rounding", () => {
    assert.equal(tierFor(1), 1);
    assert.equal(tierFor(1.02), 1, "tiny overshoot stays on the tier");
    assert.equal(tierFor(1.5), 2);
    assert.equal(tierFor(0.3), 0.5);
    assert.equal(tierFor(1e-9), 1 / 16);
    assert.equal(tierFor(1000), 8);
  });

  it("covers bounds with tile indices", () => {
    assert.deepEqual(tileRange([0, 0, TILE_INNER - 1, TILE_INNER - 1], 1), [0, 0, 0, 0]);
    assert.deepEqual(tileRange([-1, 0, TILE_INNER, 1], 1), [-1, 0, 1, 0]);
    assert.deepEqual(tileRange([0, 0, TILE_INNER, TILE_INNER], 2), [0, 0, 2, 2]);
  });
});

describe("hit tests", () => {
  const store = new ItemStore();
  const stroke = store.put(makeItem({ size: 4, points: [0, 0, 0.5, 100, 0, 0.5] }), "temp");
  const rect = store.put(makeItem({ kind: "shape", tool: "rect", size: 2, points: [0, 0, 0.5, 100, 50, 0.5] }), "temp");
  const filled = store.put(
    makeItem({ kind: "shape", tool: "ellipse", size: 2, style: { fill: 0.3 }, points: [0, 0, 0.5, 100, 50, 0.5] }),
    "temp",
  );
  const text = store.put(
    makeItem({ kind: "text", tool: "text", size: 20, text: "Hi", points: [500, 500, 0.5] }),
    "temp",
  );

  it("hits strokes within half their width plus the eraser radius", () => {
    assert.ok(hitItem(stroke, 50, 4, 2));
    assert.ok(!hitItem(stroke, 50, 6, 2));
  });

  it("hits only the outline of unfilled shapes, and the inside of filled ones", () => {
    assert.ok(hitItem(rect, 0, 25, 1));
    assert.ok(!hitItem(rect, 50, 25, 1));
    assert.ok(hitItem(filled, 50, 25, 1));
  });

  it("hits text inside its box", () => {
    assert.ok(hitItem(text, 505, 505, 1));
    assert.ok(!hitItem(text, 400, 400, 1));
  });

  it("tests eraser paths", () => {
    const path = [50, -20, 0.5, 50, -10, 0.5, 50, 0, 0.5, 50, 10, 0.5];
    assert.ok(hitPath(stroke, path, 1, [50, -20, 50, 10]));
    assert.ok(!hitPath(stroke, [300, 300, 0.5], 1, [300, 300, 300, 300]));
  });
});
