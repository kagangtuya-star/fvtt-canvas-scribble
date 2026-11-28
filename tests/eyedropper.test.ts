import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { Session } from "../src/session.ts";
import { sampleColorAt } from "../src/tools/eyedropper.ts";
import { ALICE, SCENE, makeItem } from "./helpers.ts";

function setup(t: TestContext, webgl = true) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let pixel = new Uint8Array([0x12, 0xab, 0xef, 255]);
  const reads: { target: unknown; frame: PIXI.Rectangle }[] = [];
  const reads2d: number[][] = [];
  const renderer = Object.assign(new EventEmitter(), {
    resolution: 2,
    renderingToScreen: true,
    gl: webgl ? { isContextLost: (): boolean => false } : undefined,
    extract: {
      pixels(target: undefined, frame: PIXI.Rectangle) {
        reads.push({ target, frame });
        return pixel;
      },
    },
  });
  const view = {
    width: 1000,
    height: 600,
    getBoundingClientRect: () => ({ left: 10, top: 20, right: 510, bottom: 320, width: 500, height: 300 }),
    getContext(kind: string) {
      assert.equal(kind, "2d");
      return {
        getImageData(...args: number[]) {
          reads2d.push(args);
          return { data: new Uint8ClampedArray(pixel) };
        },
      };
    },
  };
  const board = {
    ready: true,
    scene: { id: SCENE, flags: {} },
    level: { id: "ground" },
    app: { renderer, view },
  };
  class Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
    constructor(x: number, y: number, width: number, height: number) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
    }
  }
  const notices: string[] = [];
  const user = { id: ALICE, role: 1, active: true };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    canvas: board,
    PIXI: { Rectangle },
    game: {
      user,
      users: new Map([[ALICE, user]]),
      time: { serverTime: 1_000_000 },
      settings: { get() {}, async set() {} },
      i18n: { localize: (key: string) => key, format: (key: string) => key },
    },
    ui: { notifications: { info: (s: string) => notices.push(s), warn: (s: string) => notices.push(s) } },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const session = new Session({ on() {}, off() {}, emit() {} });
  session.scene = board.scene as unknown as FoundryScene;
  session.updateViewport();
  session.prefs.tool = "eyedropper";
  t.after(() => {
    session.destroy();
    for (const [key, old] of originals)
      if (old) Object.defineProperty(globalThis, key, old);
      else Reflect.deleteProperty(globalThis, key);
  });
  const render = () => renderer.emit("postrender");
  return {
    board,
    renderer,
    view,
    reads,
    reads2d,
    session,
    notices,
    render,
    setPixel: (p: number[]) => (pixel = new Uint8Array(p)),
  };
}

const point = (cx = 135, cy = 95) => ({ cx, cy, time: 0, pressure: 0.5, pointerType: "mouse" });
const mods = { shift: false, alt: false };
const flush = async () => {
  // The sampler converts the pixel, then the Session applies the result.
  await Promise.resolve();
  await Promise.resolve();
};

describe("visible canvas colour sampler", () => {
  it("waits for a screen frame and extracts exactly one physical pixel at every resolution", async (t) => {
    const f = setup(t);
    for (const res of [1, 1.5, 2]) {
      f.renderer.resolution = res;
      const picked = sampleColorAt(135, 95);
      const before = f.reads.length;
      f.renderer.renderingToScreen = false;
      f.render();
      assert.equal(f.reads.length, before);
      assert.equal(f.renderer.listenerCount("postrender"), 1);
      f.renderer.renderingToScreen = true;
      f.render();
      assert.equal(await picked, "#12abef");
      assert.equal(f.renderer.listenerCount("postrender"), 0);
      const { target, frame } = f.reads.at(-1)!;
      assert.equal(target, undefined);
      assert.equal(Math.round(frame.x * res), 250);
      assert.equal(Math.round(frame.y * res), 449);
      assert.equal(Math.round(frame.width * res), 1);
      assert.equal(Math.round(frame.height * res), 1);
    }
  });

  it("reads Canvas2D with a top-left origin and the same CSS-to-physical mapping", async (t) => {
    const f = setup(t, false);
    const picked = sampleColorAt(135, 95);
    f.render();
    assert.equal(await picked, "#12abef");
    assert.deepEqual(f.reads2d, [[250, 150, 1, 1]]);
    assert.equal(f.reads.length, 0);
  });

  it("rejects outside coordinates, exclusive right/bottom edges and a zero-sized canvas", async (t) => {
    const f = setup(t);
    for (const [cx, cy] of [
      [9, 20],
      [10, 19],
      [510, 20],
      [10, 320],
      [NaN, 95],
      [135, Infinity],
    ]) {
      const picked = sampleColorAt(cx, cy);
      f.render();
      assert.equal(await picked, null);
    }
    f.view.width = 0;
    const picked = sampleColorAt(135, 95);
    f.render();
    assert.equal(await picked, null);
    assert.equal(f.reads.length, 0);
  });

  it("accepts opaque black but refuses transparent pixels", async (t) => {
    const f = setup(t);
    for (const alpha of [255, 0]) {
      f.setPixel([0, 0, 0, alpha]);
      const picked = sampleColorAt(135, 95);
      f.render();
      assert.equal(await picked, alpha ? "#000000" : null);
    }
  });

  it("fails cleanly on context loss and readback errors", async (t) => {
    const f = setup(t);
    f.renderer.gl!.isContextLost = () => true;
    let picked = sampleColorAt(135, 95);
    f.render();
    assert.equal(await picked, null);
    f.renderer.gl!.isContextLost = () => false;
    t.mock.method(f.renderer.extract, "pixels", () => {
      throw new Error("readback unavailable");
    });
    picked = sampleColorAt(135, 95);
    f.render();
    assert.equal(await picked, null);
    assert.equal(f.renderer.listenerCount("postrender"), 0);
  });

  it("cleans up on cancellation, pre-cancellation and render timeout", async (t) => {
    const f = setup(t);
    const controller = new AbortController();
    const picked = sampleColorAt(135, 95, controller.signal);
    controller.abort();
    assert.equal(await picked, null);
    assert.equal(await sampleColorAt(135, 95, controller.signal), null);
    assert.equal(f.renderer.listenerCount("postrender"), 0);
    const timeout = sampleColorAt(135, 95);
    t.mock.timers.tick(2000);
    assert.equal(await timeout, null);
    assert.equal(f.renderer.listenerCount("postrender"), 0);
    f.render();
    assert.equal(f.reads.length, 0);
  });

  for (const change of ["scene", "level", "app"] as const) {
    it(`refuses a stale frame after the ${change} changes`, async (t) => {
      const f = setup(t);
      const picked = sampleColorAt(135, 95);
      if (change === "scene") f.board.scene = { id: "OtherScene", flags: {} };
      if (change === "level") f.board.level.id = "upstairs";
      if (change === "app") f.board.app = { ...f.board.app };
      f.render();
      assert.equal(await picked, null);
      assert.equal(f.reads.length, 0);
      assert.equal(f.renderer.listenerCount("postrender"), 0);
    });
  }
});

describe("eyedropper session", () => {
  it("uses the displayed pixel instead of an underlying mark's source colour", async (t) => {
    const f = setup(t);
    const p = f.session.screen().fromClient(135, 95, [-1, -1]);
    f.session.store.put(
      makeItem({ color: "#ff0000", mode: "screen", anchor: [-1, -1], points: [p.x, p.y, 0.5] }),
      "temp",
    );
    assert.equal(f.session.pointerDown(point(), mods), true);
    assert.equal(f.session.prefs.tool, "eyedropper");
    f.render();
    await flush();
    assert.equal(f.session.prefs.color, "#12abef");
    assert.equal(f.session.prefs.recent[0], "#12abef");
    assert.equal(f.session.prefs.tool, "draw");
    assert.ok(f.notices.some((s) => s.endsWith("Notify.ColorPicked")));
  });

  it("keeps colour, history and tool on failure, and reports it", async (t) => {
    const f = setup(t);
    const before = { color: f.session.prefs.color, recent: [...f.session.prefs.recent] };
    f.setPixel([0, 0, 0, 0]);
    f.session.pointerDown(point(), mods);
    f.render();
    await flush();
    assert.equal(f.session.prefs.color, before.color);
    assert.deepEqual(f.session.prefs.recent, before.recent);
    assert.equal(f.session.prefs.tool, "eyedropper");
    assert.ok(f.notices.some((s) => s.endsWith("Notify.ColorPickFailed")));
  });

  it("keeps only the latest click pending", async (t) => {
    const f = setup(t);
    f.session.pointerDown(point(), mods);
    f.session.pointerDown(point(160, 120), mods);
    assert.equal(f.renderer.listenerCount("postrender"), 1);
    f.render();
    await flush();
    assert.equal(f.session.prefs.color, "#12abef");
    assert.equal(f.reads.length, 1);
    assert.equal(f.reads[0].frame.x * 2, 300);
  });

  it("does not overwrite a tool/colour chosen after rendering but before promise resolution", async (t) => {
    const f = setup(t);
    f.session.pointerDown(point(), mods);
    f.render();
    f.session.setPrefs({ tool: "highlight", color: "#654321" });
    await flush();
    assert.equal(f.session.prefs.color, "#654321");
    assert.equal(f.session.prefs.tool, "highlight");
    assert.deepEqual(f.notices, []);
  });

  for (const action of ["cancel", "detach"] as const) {
    it(`cancels sampling without warnings on ${action}`, async (t) => {
      const f = setup(t);
      f.session.pointerDown(point(), mods);
      if (action === "cancel") assert.equal(f.session.cancelGesture(), true);
      else f.session.detach();
      f.render();
      await flush();
      assert.equal(f.renderer.listenerCount("postrender"), 0);
      assert.equal(f.reads.length, 0);
      assert.deepEqual(f.notices, []);
    });
  }
});
