import assert from "node:assert/strict";
import { it } from "node:test";
import type { TestContext } from "node:test";
import { MapSpace, ScreenSpace } from "../src/core/space.ts";
import { ItemStore } from "../src/core/store.ts";
import { SceneRenderer } from "../src/render/renderer.ts";
import type { RenderTargets } from "../src/render/renderer.ts";
import { SpriteSet } from "../src/render/sprites.ts";
import { makeItem } from "./helpers.ts";

class Raster {
  readonly cells = new Set<string>();
  save(): void {}
  restore(): void {}
  setTransform(): void {}
  drawImage(): void {}
  clearRect(): void {
    this.cells.clear();
  }
  fillRect(x: number, y: number): void {
    this.cells.add(`${x},${y}`);
  }
}

class Surface {
  readonly raster = new Raster();
  #width = 0;
  #height = 0;
  get width(): number {
    return this.#width;
  }
  set width(value: number) {
    this.#width = value;
    this.raster.clearRect();
  }
  get height(): number {
    return this.#height;
  }
  set height(value: number) {
    this.#height = value;
    this.raster.clearRect();
  }
  getContext(): Raster {
    return this.raster;
  }
}

class BaseTexture {
  readonly canvas: Surface;
  constructor(canvas: Surface) {
    this.canvas = canvas;
  }
  update(): void {}
}

class Texture {
  readonly baseTexture: BaseTexture;
  constructor(baseTexture: BaseTexture) {
    this.baseTexture = baseTexture;
  }
  destroy(): void {}
}

class Container {
  name = "";
  destroyed = false;
  visible = true;
  parent?: Container;
  children: Container[] = [];
  position = { set() {} };
  scale = { set() {} };
  addChild<T extends Container>(child: T): T {
    this.children.push(child);
    child.parent = this;
    return child;
  }
  removeChild(child: Container): void {
    this.children = this.children.filter((x) => x !== child);
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class Sprite extends Container {
  zIndex = 0;
  blendMode: number | string = "normal";
  texture: Texture;
  constructor(texture: Texture) {
    super();
    this.texture = texture;
  }
}

const installRendererStubs = (t: TestContext) => {
  const globals = {
    document: { createElement: () => new Surface() },
    PIXI: { Container, Sprite, Texture, BaseTexture, Rectangle: class {}, UPDATE_PRIORITY: { NORMAL: 0 } },
    OffscreenCanvas: undefined,
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
};

const pixel = (over: Parameters<typeof makeItem>[0] = {}) => makeItem({ tool: "pixel", size: 2, ...over });
const firstSprite = (sprites: SpriteSet) => (sprites.container as unknown as Container).children[0] as Sprite;

it("paints a live pixel-brush corner exactly like a fresh preview of the same points", (t) => {
  installRendererStubs(t);
  const store = new ItemStore();
  const updated = new SpriteSet();
  const fresh = new SpriteSet();
  const frame = { now: 1_000_000, scale: 1, tolerance: 0, view: null, deadline: Infinity };
  const straight = pixel({ points: [1, 0.1, 0.5, 8, 0.1, 0.5] });
  updated.put(store.put(straight, "live"));
  updated.frame(frame);
  const before = firstSprite(updated);
  assert.ok(before.texture.baseTexture.canvas.raster.cells.has("4,0"));
  const turned = store.put({ ...straight, points: [...straight.points, 8, 16, 0.5] }, "live");
  updated.put(turned);
  fresh.put(turned);
  updated.frame(frame);
  fresh.frame(frame);
  const actual = firstSprite(updated).texture.baseTexture.canvas.raster.cells;
  const expected = firstSprite(fresh).texture.baseTexture.canvas.raster.cells;
  assert.ok(expected.has("4,-2") && !expected.has("4,0"));
  assert.deepEqual(actual, expected);
  updated.destroy();
  fresh.destroy();
});

it("keeps a saved blend on the scene, with earlier cached strokes below it and later strokes above it", (t) => {
  installRendererStubs(t);
  const viewport = { left: 0, top: 0, width: 500, height: 500 };
  const space = new MapSpace(
    { sceneX: 0, sceneY: 0, sceneWidth: 500, sceneHeight: 500, refW: 500, refH: 500, gridSize: 100 },
    { zoom: () => 1, toCanvas: (x, y) => ({ x, y }), toClient: (x, y) => ({ x, y }) },
  );
  let frame: () => void = () => undefined;
  const top = new Container();
  const targets = {
    top,
    primary: new Container(),
    overlay: new Container(),
    ticker: { add: (tick: () => void) => (frame = tick), remove() {} },
  } as unknown as RenderTargets;
  const store = new ItemStore();
  const renderer = new SceneRenderer(
    {
      store,
      shows: () => true,
      viewport: () => viewport,
      map: () => space,
      screen: () => new ScreenSpace(viewport),
      layerOf: () => "top",
      resolution: () => 1,
      now: () => 1_000_100,
    },
    targets,
  );
  const early = pixel({ color: "#0000ff", expiresAt: null, points: [25, 25, 0.5] });
  const blend = pixel({ ...early, id: "blend", createdAt: early.createdAt + 1, style: { blend: "multiply" } });
  const late = pixel({ ...early, id: "late", color: "#00ff00", createdAt: early.createdAt + 2 });
  const [tiles, sprites] = top.children[0]!.children as [Container, Container];
  const paintOrder = () =>
    (sprites.children as Sprite[])
      .slice()
      .sort((a, b) => a.zIndex - b.zIndex)
      .map((s) => s.blendMode);
  store.put(early, "stored");
  store.put(late, "stored");
  store.put(blend, "pending");
  frame();
  assert.deepEqual(paintOrder(), ["multiply"]);

  store.put(blend, "stored");
  for (let i = 0; i < 10; i++) frame();
  assert.ok(
    tiles.children.some((c) => c.visible),
    "the earlier normal stroke is still cached",
  );
  assert.deepEqual(paintOrder(), ["multiply", "normal"], "the later normal stroke stays above the blend");
  assert.equal(renderer.debugInfo().stored, 3);

  store.remove(blend.id);
  for (let i = 0; i < 10; i++) frame();
  assert.deepEqual(paintOrder(), [], "ordinary strokes return to the tile cache when the blend is gone");
  assert.ok(tiles.children.some((c) => c.visible));
  renderer.destroy();
});
