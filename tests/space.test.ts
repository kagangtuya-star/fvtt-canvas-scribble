import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MapSpace, ScreenSpace } from "../src/core/space.ts";
import type { MapFrame } from "../src/core/space.ts";

/** A canvas view with pan (pivot) and zoom, like Foundry's stage. */
function view(zoom: number, pivot = { x: 2000, y: 1500 }, screen = { w: 1280, h: 800 }) {
  return {
    zoom: () => zoom,
    toCanvas: (cx: number, cy: number) => ({
      x: (cx - screen.w / 2) / zoom + pivot.x,
      y: (cy - screen.h / 2) / zoom + pivot.y,
    }),
    toClient: (x: number, y: number) => ({
      x: (x - pivot.x) * zoom + screen.w / 2,
      y: (y - pivot.y) * zoom + screen.h / 2,
    }),
  };
}

const frame: MapFrame = {
  sceneX: 500,
  sceneY: 500,
  sceneWidth: 3000,
  sceneHeight: 2000,
  refW: 3000,
  refH: 2000,
  gridSize: 100,
};

describe("MapSpace (world space)", () => {
  it("round-trips client ↔ space at any zoom", () => {
    for (const zoom of [0.25, 0.5, 1, 3]) {
      const s = new MapSpace(frame, view(zoom));
      const p = s.fromClient(300, 200);
      const back = s.toClient(p.x, p.y);
      assert.ok(Math.abs(back.x - 300) < 1e-9 && Math.abs(back.y - 200) < 1e-9);
    }
  });

  it("stores scene-relative coordinates independent of the view", () => {
    const a = new MapSpace(frame, view(0.5));
    const b = new MapSpace(frame, view(2, { x: 900, y: 700 }));
    const world = { x: 1400, y: 1100 };
    const ca = view(0.5).toClient(world.x, world.y);
    const cb = view(2, { x: 900, y: 700 }).toClient(world.x, world.y);
    assert.deepEqual(a.fromClient(ca.x, ca.y), b.fromClient(cb.x, cb.y));
    assert.deepEqual(a.fromClient(ca.x, ca.y), { x: 900, y: 600 });
  });

  it("rescales when the scene is resized after drawing", () => {
    const resized = new MapSpace({ ...frame, sceneWidth: 6000, sceneHeight: 4000 }, view(1));
    assert.deepEqual(resized.canvasFromSpace(100, 100), { x: 700, y: 700 });
  });

  it("sizes brushes relative to the grid, or to the zoom on request", () => {
    const grid = new MapSpace(frame, view(0.5));
    assert.equal(grid.widthFor(5), 5);
    assert.equal(new MapSpace({ ...frame, gridSize: 200 }, view(0.5)).widthFor(5), 10);
    const follow = new MapSpace(frame, view(0.5), true);
    assert.equal(follow.widthFor(5), 10);
  });

  it("reports the visible area for culling", () => {
    const s = new MapSpace(frame, view(1));
    const [x0, y0, x1, y1] = s.visibleBounds({ left: 0, top: 0, width: 1280, height: 800 });
    assert.deepEqual([x0, y0, x1, y1], [860, 600, 2140, 1400]);
  });
});

describe("ScreenSpace (viewport space)", () => {
  const vp = { left: 0, top: 0, width: 1600, height: 1000 };

  it("uses 1000 units for the shorter viewport side", () => {
    assert.equal(new ScreenSpace(vp).cssPerUnit(), 1);
    assert.equal(new ScreenSpace({ ...vp, height: 500 }).cssPerUnit(), 0.5);
  });

  it("anchors to viewport thirds and survives a resize", () => {
    const s = new ScreenSpace(vp);
    assert.deepEqual(s.anchorFor(100, 100), [-1, -1]);
    assert.deepEqual(s.anchorFor(800, 500), [0, 0]);
    assert.deepEqual(s.anchorFor(1500, 900), [1, 1]);
    const p = s.fromClient(1500, 900, [1, 1]);
    s.viewport = { left: 0, top: 0, width: 2000, height: 1000 };
    // Still 100 px from the bottom-right corner after the window grew.
    assert.deepEqual(s.toClient(p.x, p.y, [1, 1]), { x: 1900, y: 900 });
  });

  it("is unaffected by canvas pan and zoom (no map dependency)", () => {
    const s = new ScreenSpace(vp);
    const p = s.fromClient(400, 300);
    assert.deepEqual(s.toClient(p.x, p.y), { x: 400, y: 300 });
  });
});
