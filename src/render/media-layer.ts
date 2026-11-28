import { pixiBlendMode } from "../foundry/compat.ts";
import { CELL_UNITS, CHUNK, parseChunkKey } from "../media/layout.ts";
import { trackTexture } from "./stats.ts";

/**
 * Display of the wet-media simulation: one pair of sprites per chunk.
 *
 * The engine renders each chunk as a 128×256 image: the paint layer's
 * reflectance R on top and its squared transmittance T² below (see
 * `media/pigment.ts`). Over the map, the Kubelka–Munk composite
 * `R + T²·map` is two blend passes: a MULTIPLY sprite with T² (the glaze
 * filters what is below) and an ADD sprite with R (light scattered back by
 * the paint body). Paint therefore glazes or covers the real scene art.
 *
 * The container sits in the primary group just under the "below" scribbles,
 * so tokens stand on the paint and the fog of war hides it.
 */

/** Sort layer inside the primary group (tiles 500, drawings 600, scribbles "below" 650, tokens 700). */
export const MEDIA_SORT_LAYER = 645;

type Sortable = PIXI.Container & { elevation?: number; sortLayer?: number };

/** One half of a chunk display. Separate textures: linear filtering must not blend R into T² at the seam. */
interface Half {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: PIXI.Texture;
}

interface ChunkView {
  edge: number;
  reflect: Half;
  transmit: Half;
  mul: PIXI.Sprite;
  add: PIXI.Sprite;
}

export class MediaLayer {
  readonly container: PIXI.Container;
  readonly #chunks = new Map<string, ChunkView>();
  readonly #mulGroup: PIXI.Container;
  readonly #addGroup: PIXI.Container;

  constructor() {
    this.container = new PIXI.Container();
    this.container.name = "canvas-scribble:media";
    this.container.eventMode = "none";
    this.container.interactiveChildren = false;
    (this.container as Sortable).sortLayer = MEDIA_SORT_LAYER;
    // All filters first, then all scattered light: neighbouring chunks never overlap, but keeping the
    // passes grouped makes the composite independent of the chunk order.
    this.#mulGroup = this.container.addChild(new PIXI.Container());
    this.#addGroup = this.container.addChild(new PIXI.Container());
  }

  get size(): number {
    return this.#chunks.size;
  }

  /** Ground elevation of the viewed level (v14), like the "below" scribbles. */
  set elevation(value: number) {
    (this.container as Sortable).elevation = value;
  }

  /** Show a chunk display from the engine, or remove it (`null`). */
  show(key: string, data: Uint8ClampedArray | null): void {
    if (!data) {
      this.#remove(key);
      return;
    }
    const edge = Math.sqrt(data.length / 8);
    if (!Number.isInteger(edge) || edge < 16 || edge > CHUNK || CHUNK % edge) return;
    const xy = parseChunkKey(key);
    if (!xy) return;
    let view = this.#chunks.get(key);
    if (!view || view.edge !== edge) {
      if (view) this.#remove(key);
      view = this.#create(xy[0], xy[1], edge);
      this.#chunks.set(key, view);
    }
    const image = new ImageData(new Uint8ClampedArray(data), edge, edge * 2);
    view.reflect.ctx.putImageData(image, 0, 0, 0, 0, edge, edge);
    view.transmit.ctx.putImageData(image, 0, -edge, 0, edge, edge, edge);
    view.reflect.texture.baseTexture.update();
    view.transmit.texture.baseTexture.update();
  }

  #half(edge: number): Half {
    const canvas = document.createElement("canvas");
    canvas.width = edge;
    canvas.height = edge;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("CanvasScribble: 2D canvas context unavailable");
    return { canvas, ctx, texture: new PIXI.Texture(new PIXI.BaseTexture(canvas)) };
  }

  #create(cx: number, cy: number, edge: number): ChunkView {
    const reflect = this.#half(edge);
    const transmit = this.#half(edge);
    trackTexture(edge * edge * 2, 1);
    const place = (sprite: PIXI.Sprite) => {
      sprite.position.set(cx * CHUNK * CELL_UNITS, cy * CHUNK * CELL_UNITS);
      sprite.scale.set((CHUNK * CELL_UNITS) / edge, (CHUNK * CELL_UNITS) / edge);
      sprite.eventMode = "none";
      return sprite;
    };
    const mul = place(new PIXI.Sprite(transmit.texture));
    mul.blendMode = pixiBlendMode("multiply");
    const add = place(new PIXI.Sprite(reflect.texture));
    add.blendMode = pixiBlendMode("lighter");
    this.#mulGroup.addChild(mul);
    this.#addGroup.addChild(add);
    return { edge, reflect, transmit, mul, add };
  }

  #remove(key: string): void {
    const view = this.#chunks.get(key);
    if (!view) return;
    this.#chunks.delete(key);
    view.mul.destroy();
    view.add.destroy();
    for (const half of [view.reflect, view.transmit]) {
      half.texture.destroy(true);
      half.canvas.width = half.canvas.height = 0;
    }
    trackTexture(view.edge * view.edge * 2, -1);
  }

  clear(): void {
    for (const key of [...this.#chunks.keys()]) this.#remove(key);
  }

  destroy(): void {
    this.clear();
    if (!this.container.destroyed) this.container.destroy({ children: true });
  }
}
