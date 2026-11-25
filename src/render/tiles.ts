import { compositeItem } from "../brush/paint.ts";
import { boundsIntersect } from "../core/geometry.ts";
import type { Bounds } from "../core/geometry.ts";
import type { Entry } from "../core/store.ts";
import { clamp } from "../core/util.ts";
import { CanvasTexture } from "./canvas-texture.ts";
import { stats } from "./stats.ts";

/**
 * Tiled raster cache for permanent map items.
 *
 * Space is cut into square tiles per resolution *tier* (device pixels per
 * space unit, always a power of two). A tile is a 512 px canvas holding every
 * stored item that touches it, composited in drawing order; the GPU only sees
 * one sprite per non-empty visible tile, however many items there are.
 *
 *  - Tiles are built lazily (only visible ones) within a per-frame time budget.
 *  - A new item that is newer than everything in a tile is appended in place.
 *    Removing or editing an item marks the touched tiles dirty; they are
 *    redrawn in one go, so the old content stays on screen until then.
 *  - When the zoom crosses a tier the old tier stays displayed until every
 *    visible tile of the new tier is ready (no blank frames while zooming).
 *  - Least recently used textures are evicted beyond a pixel budget.
 *
 * Each tile canvas carries a 2 px bleed border holding the neighbours'
 * content so linear filtering never shows seams between tiles.
 */

export const TILE_CANVAS = 512;
export const TILE_PAD = 2;
export const TILE_INNER = TILE_CANVAS - 2 * TILE_PAD;
export const MIN_TIER = 1 / 16;
export const MAX_TIER = 8;

/** The cache tier for a display density: next power of two (sharp), clamped. */
export function tierFor(devicePxPerUnit: number): number {
  const exp = Math.ceil(Math.log2(Math.max(1e-6, devicePxPerUnit)) - 0.04);
  return clamp(2 ** exp, MIN_TIER, MAX_TIER);
}

/** Tile indices covering `bounds` at `tier`. */
export function tileRange(bounds: Bounds, tier: number): [x0: number, y0: number, x1: number, y1: number] {
  const size = TILE_INNER / tier;
  return [
    Math.floor(bounds[0] / size),
    Math.floor(bounds[1] / size),
    Math.floor(bounds[2] / size),
    Math.floor(bounds[3] / size),
  ];
}

const drawnAfter = (a: Entry, b: Entry): boolean =>
  a.item.createdAt > b.item.createdAt || (a.item.createdAt === b.item.createdAt && a.seq > b.seq);

const compareEntries = (a: Entry, b: Entry): number => a.item.createdAt - b.item.createdAt || a.seq - b.seq;

interface Tile {
  key: string;
  tier: number;
  ix: number;
  iy: number;
  bounds: Bounds;
  ready: boolean;
  /** Ready and contains nothing: no texture allocated. */
  empty: boolean;
  tex: CanvasTexture | null;
  sprite: PIXI.Sprite | null;
  /** Last entry composited (append check). */
  last: Entry | null;
  used: number;
}

export interface TileFrame {
  /** Visible area in space units (already padded). */
  view: Bounds;
  tier: number;
  frame: number;
  /** `performance.now()` deadline for raster work. */
  deadline: number;
}

export class TileCache {
  readonly container: PIXI.Container;
  readonly #tiles = new Map<string, Tile>();
  readonly #entries = new Map<string, Entry>();
  #sorted: Entry[] | null = null;
  #shownTier = 0;
  /** Texture budget in tiles; grows with the number of tiles a view needs. */
  #maxTextures = 64;

  constructor() {
    this.container = new PIXI.Container();
    this.container.eventMode = "none";
    this.container.interactiveChildren = false;
  }

  get size(): number {
    return this.#entries.size;
  }

  get shownTier(): number {
    return this.#shownTier;
  }

  /** Number of tiles holding a texture. */
  get textureCount(): number {
    let n = 0;
    for (const t of this.#tiles.values()) if (t.tex) n++;
    return n;
  }

  #ordered(): Entry[] {
    if (!this.#sorted) this.#sorted = [...this.#entries.values()].sort(compareEntries);
    return this.#sorted;
  }

  /* -------------------------------------------- */
  /*  Content changes                             */
  /* -------------------------------------------- */

  add(entry: Entry): void {
    const previous = this.#entries.get(entry.item.id);
    if (previous) {
      this.update(entry, previous);
      return;
    }
    this.#entries.set(entry.item.id, entry);
    this.#sorted = null;
    for (const tile of this.#tilesTouching(entry.bounds)) {
      if (!tile.ready) continue;
      if (tile.tier !== this.#shownTier || (tile.last && !drawnAfter(entry, tile.last))) {
        tile.ready = false;
        continue;
      }
      // Append in place: newest item goes on top of the tile.
      if (tile.empty) {
        this.#ensureTexture(tile);
        tile.empty = false;
      }
      this.#composite(tile, entry);
      tile.last = entry;
      tile.tex!.upload();
    }
  }

  update(entry: Entry, previous: Entry): void {
    this.#entries.set(entry.item.id, entry);
    this.#sorted = null;
    this.#invalidate(previous.bounds);
    this.#invalidate(entry.bounds);
  }

  remove(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    this.#entries.delete(id);
    this.#sorted = null;
    this.#invalidate(entry.bounds);
  }

  /** Drop every item (scene reset). */
  clear(): void {
    this.#entries.clear();
    this.#sorted = null;
    this.invalidateAll();
  }

  /** Redraw everything (e.g. the visibility filter changed). */
  invalidateAll(): void {
    for (const tile of this.#tiles.values()) tile.ready = false;
  }

  #invalidate(bounds: Bounds): void {
    for (const tile of this.#tilesTouching(bounds)) tile.ready = false;
  }

  *#tilesTouching(bounds: Bounds): Generator<Tile> {
    for (const tile of this.#tiles.values()) {
      if (boundsIntersect(tile.bounds, bounds)) yield tile;
    }
  }

  /* -------------------------------------------- */
  /*  Frame update                                */
  /* -------------------------------------------- */

  /** Build and show tiles for the view. Returns `true` when work remains. */
  frame(f: TileFrame): boolean {
    if (!this.#entries.size) {
      this.#hideAll();
      return false;
    }
    const target = this.#visibleTiles(f.tier, f.view, f.frame);
    if (!this.#shownTier) this.#shownTier = f.tier;
    const shown = this.#shownTier === f.tier ? target : this.#visibleTiles(this.#shownTier, f.view, f.frame);
    this.#maxTextures = Math.max(64, (target.length + shown.length) * 2);

    // Build: target tier first (nearest to the centre first), then dirty tiles of the shown tier.
    const cx = (f.view[0] + f.view[2]) / 2;
    const cy = (f.view[1] + f.view[3]) / 2;
    const dist = (t: Tile) => Math.hypot((t.bounds[0] + t.bounds[2]) / 2 - cx, (t.bounds[1] + t.bounds[3]) / 2 - cy);
    const queue = target.filter((t) => !t.ready).sort((a, b) => dist(a) - dist(b));
    if (shown !== target) queue.push(...shown.filter((t) => !t.ready));
    let built = 0;
    for (const tile of queue) {
      if (built > 0 && performance.now() > f.deadline) break;
      this.#build(tile);
      built++;
    }

    if (this.#shownTier !== f.tier && target.every((t) => t.ready)) this.#shownTier = f.tier;
    const visible = this.#shownTier === f.tier ? target : shown;

    // Display only the shown tier's visible tiles. Dirty tiles that are not
    // rebuilt yet keep their previous picture rather than going blank.
    const on = new Set(visible);
    for (const tile of this.#tiles.values()) {
      if (tile.sprite) tile.sprite.visible = on.has(tile) && !tile.empty;
    }

    this.#evict(f.frame);
    stats.tiles = this.textureCount;
    return queue.length > built || this.#shownTier !== f.tier;
  }

  #visibleTiles(tier: number, view: Bounds, frame: number): Tile[] {
    const [x0, y0, x1, y1] = tileRange(view, tier);
    const count = (x1 - x0 + 1) * (y1 - y0 + 1);
    // A pathological view (extreme zoom-out beyond the clamp) must not allocate thousands of tiles.
    if (count > 400) return [];
    const list: Tile[] = [];
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const key = `${tier}:${ix}:${iy}`;
        let tile = this.#tiles.get(key);
        if (!tile) {
          const size = TILE_INNER / tier;
          tile = {
            key,
            tier,
            ix,
            iy,
            bounds: [ix * size, iy * size, (ix + 1) * size, (iy + 1) * size],
            ready: false,
            empty: false,
            tex: null,
            sprite: null,
            last: null,
            used: frame,
          };
          this.#tiles.set(key, tile);
        }
        tile.used = frame;
        list.push(tile);
      }
    }
    return list;
  }

  #build(tile: Tile): void {
    const items = this.#ordered().filter((e) => boundsIntersect(e.bounds, tile.bounds));
    tile.ready = true;
    tile.last = items.at(-1) ?? null;
    if (!items.length) {
      tile.empty = true;
      this.#releaseTexture(tile);
      return;
    }
    tile.empty = false;
    this.#ensureTexture(tile);
    tile.tex!.clear();
    for (const entry of items) this.#composite(tile, entry);
    tile.tex!.upload();
    stats.tileBuilds++;
  }

  #composite(tile: Tile, entry: Entry): void {
    const s = tile.tier;
    const view = { scale: s, ox: TILE_PAD - tile.bounds[0] * s, oy: TILE_PAD - tile.bounds[1] * s };
    const b = entry.bounds;
    const x0 = Math.max(0, Math.floor(b[0] * s + view.ox));
    const y0 = Math.max(0, Math.floor(b[1] * s + view.oy));
    const x1 = Math.min(TILE_CANVAS, Math.ceil(b[2] * s + view.ox));
    const y1 = Math.min(TILE_CANVAS, Math.ceil(b[3] * s + view.oy));
    if (x1 <= x0 || y1 <= y0) return;
    compositeItem(tile.tex!.ctx, entry.item, view, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }

  #ensureTexture(tile: Tile): void {
    if (tile.tex) return;
    tile.tex = new CanvasTexture(TILE_CANVAS, TILE_CANVAS, { x: TILE_PAD, y: TILE_PAD, w: TILE_INNER, h: TILE_INNER });
    const sprite = new PIXI.Sprite(tile.tex.texture);
    sprite.position.set(tile.bounds[0], tile.bounds[1]);
    sprite.scale.set(1 / tile.tier);
    sprite.eventMode = "none";
    sprite.visible = false;
    tile.sprite = this.container.addChild(sprite);
  }

  #releaseTexture(tile: Tile): void {
    if (tile.sprite) {
      if (!tile.sprite.destroyed) {
        tile.sprite.parent?.removeChild(tile.sprite);
        tile.sprite.destroy();
      }
      tile.sprite = null;
    }
    tile.tex?.destroy();
    tile.tex = null;
  }

  #hideAll(): void {
    for (const tile of this.#tiles.values()) if (tile.sprite) tile.sprite.visible = false;
  }

  #evict(frame: number): void {
    let textures = 0;
    for (const t of this.#tiles.values()) if (t.tex) textures++;
    if (textures > this.#maxTextures) {
      const victims = [...this.#tiles.values()].filter((t) => t.tex && t.used < frame).sort((a, b) => a.used - b.used);
      for (const t of victims) {
        if (textures <= this.#maxTextures) break;
        this.#releaseTexture(t);
        this.#tiles.delete(t.key);
        textures--;
      }
    }
    // Forget bookkeeping of empty/unbuilt tiles that have not been looked at for a while.
    if (this.#tiles.size > 4 * this.#maxTextures) {
      for (const t of [...this.#tiles.values()]) {
        if (!t.tex && t.used < frame - 120) this.#tiles.delete(t.key);
      }
    }
  }

  destroy(): void {
    for (const tile of this.#tiles.values()) this.#releaseTexture(tile);
    this.#tiles.clear();
    this.#entries.clear();
    this.#sorted = null;
    if (!this.container.destroyed) this.container.destroy({ children: true });
  }
}
