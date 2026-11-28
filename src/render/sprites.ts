import { effectiveBlend, paintItemLayer } from "../brush/paint.ts";
import { boundsIntersect } from "../core/geometry.ts";
import type { Bounds } from "../core/geometry.ts";
import { lifeAlpha } from "../core/lifetime.ts";
import { compareEntries } from "../core/store.ts";
import type { Entry } from "../core/store.ts";
import { pixiBlendMode } from "../foundry/compat.ts";
import { CanvasTexture } from "./canvas-texture.ts";
import { stats } from "./stats.ts";

/**
 * One raster per item for everything that is not a stored map annotation:
 * strokes being drawn (`live`), temporary items (which fade on their own
 * sprite alpha, so fading costs nothing) and permanent items waiting for the
 * GM's write (`pending`).
 */

const PAD = 2;
/** Largest raster edge / area for one item; bigger items are rasterised at a lower density. */
const MAX_EDGE = 4096;
const MAX_AREA = 4096 * 2048;
/** Live strokes grow; their canvas is allocated in steps to avoid a reallocation per pointer move. */
const LIVE_STEP = 256;

export interface ItemSprite {
  entry: Entry;
  tex: CanvasTexture | null;
  sprite: PIXI.Sprite | null;
  /** Raster density (device px per unit) of the current texture. */
  scale: number;
  order: number;
  dirty: boolean;
  /** Being replaced by a cache tile: removed after the tiles' next frame. */
  retiring: boolean;
}

export interface SpriteFrame {
  now: number;
  /** Target raster density. */
  scale: number;
  /** Relative density change tolerated before re-rasterising (0 = exact). */
  tolerance: number;
  /** Cull rectangle in space units (null = everything is visible). */
  view: Bounds | null;
  deadline: number;
}

export class SpriteSet {
  readonly container: PIXI.Container;
  readonly #sprites = new Map<string, ItemSprite>();
  #orderDirty = false;

  constructor() {
    this.container = new PIXI.Container();
    this.container.eventMode = "none";
    this.container.interactiveChildren = false;
    // Match the tile cache's drawing order for sprites layered above cached strokes.
    this.container.sortableChildren = true;
  }

  get size(): number {
    return this.#sprites.size;
  }

  has(id: string): boolean {
    return this.#sprites.has(id);
  }

  put(entry: Entry): void {
    const current = this.#sprites.get(entry.item.id);
    if (current) {
      if (compareEntries(entry, current.entry) !== 0) this.#orderDirty = true;
      current.entry = entry;
      current.dirty = true;
      current.retiring = false;
      return;
    }
    this.#sprites.set(entry.item.id, {
      entry,
      tex: null,
      sprite: null,
      scale: 0,
      order: 0,
      dirty: true,
      retiring: false,
    });
    this.#orderDirty = true;
    stats.itemSprites++;
  }

  /** Keep showing the sprite until {@link dropRetired} (hand-over to the tile cache). */
  retire(id: string): void {
    const s = this.#sprites.get(id);
    if (s) s.retiring = true;
  }

  dropRetired(): void {
    for (const [id, s] of this.#sprites) if (s.retiring) this.remove(id);
  }

  remove(id: string): void {
    const s = this.#sprites.get(id);
    if (!s) return;
    this.#sprites.delete(id);
    this.#releaseRaster(s);
    stats.itemSprites--;
  }

  #releaseRaster(s: ItemSprite): void {
    if (s.sprite && !s.sprite.destroyed) {
      s.sprite.parent?.removeChild(s.sprite);
      s.sprite.destroy();
    }
    s.tex?.destroy();
    s.sprite = null;
    s.tex = null;
    s.scale = 0;
  }

  clear(): void {
    for (const id of [...this.#sprites.keys()]) this.remove(id);
  }

  /** Update alpha, culling and rasters. Returns `true` when raster work was deferred. */
  frame(f: SpriteFrame): boolean {
    let deferred = false;
    if (this.#orderDirty) {
      const ordered = [...this.#sprites.values()].sort((a, b) => compareEntries(a.entry, b.entry));
      ordered.forEach((s, i) => {
        s.order = i;
        if (s.sprite) s.sprite.zIndex = i;
      });
      this.#orderDirty = false;
    }
    // Live strokes first: they are what the user is looking at.
    const list = [...this.#sprites.values()].sort(
      (a, b) => Number(b.entry.state === "live") - Number(a.entry.state === "live"),
    );
    let rastered = 0;
    for (const s of list) {
      const { item, state } = s.entry;
      const live = state === "live";
      const alpha = live ? item.opacity : item.opacity * lifeAlpha(item, f.now);
      const inView = !f.view || boundsIntersect(s.entry.bounds, f.view);
      if (alpha <= 0 || !inView) {
        if (!inView && state === "stored" && s.tex) this.#releaseRaster(s);
        else if (s.sprite) s.sprite.visible = false;
        continue;
      }
      const rescale = s.scale > 0 && Math.abs(Math.log(f.scale / s.scale)) > Math.log1p(f.tolerance) + 1e-9;
      if (!s.tex || s.dirty || rescale) {
        // Live input is urgent; saved sprites share the frame budget with the tile cache.
        const urgent = state !== "stored" && (!s.tex || (live && s.dirty));
        if (urgent || rastered === 0 || performance.now() < f.deadline) {
          this.#raster(s, f.scale);
          rastered++;
        } else deferred = true;
      }
      if (s.sprite) {
        s.sprite.visible = true;
        s.sprite.alpha = alpha;
      }
    }
    return deferred;
  }

  #raster(s: ItemSprite, target: number): void {
    const { item, state, bounds: b } = s.entry;
    const live = state === "live";
    const bw = Math.max(1e-3, b[2] - b[0]);
    const bh = Math.max(1e-3, b[3] - b[1]);
    let scale = target;
    const k = Math.min(
      1,
      MAX_EDGE / (bw * scale),
      MAX_EDGE / (bh * scale),
      Math.sqrt(MAX_AREA / (bw * bh * scale * scale)),
    );
    scale *= k;
    let w = Math.ceil(bw * scale) + 2 * PAD;
    let h = Math.ceil(bh * scale) + 2 * PAD;
    if (live) {
      w = Math.min(MAX_EDGE + 2 * PAD, Math.ceil(w / LIVE_STEP) * LIVE_STEP);
      h = Math.min(MAX_EDGE + 2 * PAD, Math.ceil(h / LIVE_STEP) * LIVE_STEP);
    }

    if (!s.tex) s.tex = new CanvasTexture(w, h);
    else if (live && s.tex.width >= w && s.tex.height >= h && s.tex.width * s.tex.height <= 4 * w * h) s.tex.clear();
    else s.tex.resize(w, h);

    // A new sample can change an already painted spline segment and its dabs.
    paintItemLayer(s.tex.ctx, item, { scale, ox: PAD - b[0] * scale, oy: PAD - b[1] * scale }, live);
    s.tex.upload();
    const texture = s.tex.texture;
    if (!s.sprite) {
      s.sprite = new PIXI.Sprite(texture);
      s.sprite.eventMode = "none";
      s.sprite.zIndex = s.order;
      this.container.addChild(s.sprite);
    } else if (s.sprite.texture !== texture) s.sprite.texture = texture;
    s.sprite.blendMode = pixiBlendMode(effectiveBlend(item));
    s.sprite.position.set(b[0] - PAD / scale, b[1] - PAD / scale);
    s.sprite.scale.set(1 / scale);
    s.scale = target;
    s.dirty = false;
    stats.itemRasters++;
  }

  destroy(): void {
    this.clear();
    if (!this.container.destroyed) this.container.destroy({ children: true });
  }
}
