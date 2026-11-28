import { effectiveBlend } from "../brush/paint.ts";
import type { Bounds } from "../core/geometry.ts";
import type { MapSpace, ScreenSpace, Viewport } from "../core/space.ts";
import { compareEntries } from "../core/store.ts";
import type { Entry, ItemStore, StoreEvent } from "../core/store.ts";
import type { MapLayer, ScribbleItem } from "../core/types.ts";
import { drawLasers } from "./laser.ts";
import { MediaLayer } from "./media-layer.ts";
import { SpriteSet } from "./sprites.ts";
import { stats } from "./stats.ts";
import { TileCache, tierFor } from "./tiles.ts";

/**
 * Display of every item of the viewed scene.
 *
 *   map "below"  → container in the primary group, under tokens (fog applies)
 *   map "above"  → container in the primary group, over tokens and tiles (fog applies)
 *   map "top"    → container in the interface group (drawn over fog)
 *   screen       → containers in the overlay group, one per anchor (not bound to the stage)
 *
 * Each container ("root") works in its own space units; the root transform
 * maps them onto the canvas or the viewport. A map root holds a tile cache
 * for stored items, a sprite set for everything else and one Graphics for
 * laser trails.
 */

export interface RenderHost {
  readonly store: ItemStore;
  /** Server time (ms). */
  now(): number;
  map(): MapSpace | null;
  screen(): ScreenSpace;
  viewport(): Viewport;
  /** Device pixels per CSS pixel of the canvas renderer. */
  resolution(): number;
  /** Item filter: viewed level, hidden authors… */
  shows(item: ScribbleItem): boolean;
  /** Effective map layer (world policy may push players' marks under the fog). */
  layerOf(item: ScribbleItem): MapLayer;
  mediaView?(bounds: Bounds): void;
}

export interface RenderTargets {
  /** Parent and sort data for map roots in the primary group. */
  primary: PIXI.Container & { sortDirty?: boolean };
  /** Parent for the "top" map root (the module's interface layer). */
  top: PIXI.Container;
  /** Parent for screen roots (the overlay group). */
  overlay: PIXI.Container;
  ticker: PIXI.Ticker;
}

/** Sort layers inside the primary group (tiles 500, drawings 600, tokens 700, weather 1000). */
export const SORT_LAYER = { below: 650, above: 750 } as const;

/** Raster time per frame for non-urgent work (ms). */
const FRAME_BUDGET_MS = 6;
const SWEEP_INTERVAL_MS = 200;
/** Screen rasters are refreshed after a resize beyond this relative density change. */
const SCREEN_RESCALE_TOLERANCE = 0.12;

type PrimarySortable = PIXI.Container & { elevation?: number; sortLayer?: number; sort?: number };

class Root {
  readonly container: PIXI.Container;
  readonly tiles: TileCache | null;
  readonly sprites = new SpriteSet();
  readonly lasers = new Map<string, Entry>();
  readonly #stored = new Map<string, Entry>();
  #firstBlend: Entry | undefined;
  #laserGraphics: PIXI.Graphics | null = null;

  constructor(name: string, withTiles: boolean) {
    this.container = new PIXI.Container();
    this.container.name = `canvas-scribble:${name}`;
    this.container.eventMode = "none";
    this.container.interactiveChildren = false;
    this.tiles = withTiles ? new TileCache() : null;
    if (this.tiles) this.container.addChild(this.tiles.container);
    this.container.addChild(this.sprites.container);
  }

  get empty(): boolean {
    return !this.sprites.size && !this.lasers.size && !this.#stored.size;
  }

  get storedCount(): number {
    return this.#stored.size;
  }

  put(entry: Entry): void {
    const id = entry.item.id;
    if (entry.item.kind === "laser") {
      this.lasers.set(id, entry);
      return;
    }
    if (this.#routeStored(id, entry.state === "stored" ? entry : undefined)) return;
    this.sprites.put(entry);
  }

  /** Flatten only the normal strokes below the first blend, preserving painter order above it. */
  #routeStored(id: string, entry?: Entry): boolean {
    const tiles = this.tiles;
    if (!tiles) return false;
    const before = this.#stored.get(id);
    if (!before && !entry) return false;
    const oldFirst = this.#firstBlend;
    const cached = (e: Entry, first?: Entry) => !first || compareEntries(e, first) < 0;
    if (entry) this.#stored.set(id, entry);
    else this.#stored.delete(id);

    const blends = entry && effectiveBlend(entry.item) !== "normal";
    if (oldFirst?.item.id === id && (!blends || compareEntries(oldFirst, entry!) !== 0)) {
      this.#firstBlend = undefined;
      for (const candidate of this.#stored.values()) {
        if (effectiveBlend(candidate.item) !== "normal" && (!this.#firstBlend || cached(candidate, this.#firstBlend)))
          this.#firstBlend = candidate;
      }
    } else if (blends && cached(entry, oldFirst)) this.#firstBlend = entry;

    let discardRasters = false;
    const first = this.#firstBlend;
    if (first !== oldFirst) {
      for (const other of this.#stored.values()) {
        if (other.item.id === id) continue;
        const was = cached(other, oldFirst);
        if (was === cached(other, first)) continue;
        if (was) {
          tiles.remove(other.item.id);
          this.sprites.put(other);
          discardRasters = true;
        } else {
          tiles.add(other);
          this.sprites.retire(other.item.id);
        }
      }
    }
    const wasCached = before && cached(before, oldFirst);
    const isCached = entry && cached(entry, first);
    if (isCached) {
      if (wasCached) tiles.update(entry, before);
      else tiles.add(entry);
      this.sprites.retire(id);
    } else if (wasCached) {
      tiles.remove(id);
      if (entry) discardRasters = true;
    }
    if (discardRasters) tiles.discardRasters();
    return !!isCached;
  }

  remove(id: string): void {
    this.lasers.delete(id);
    this.#routeStored(id);
    this.sprites.remove(id);
  }

  clear(): void {
    this.lasers.clear();
    this.#stored.clear();
    this.#firstBlend = undefined;
    this.sprites.clear();
    this.tiles?.clear();
    this.#laserGraphics?.clear();
  }

  drawLasers(now: number): void {
    if (!this.lasers.size) {
      if (this.#laserGraphics) this.#laserGraphics.visible = false;
      return;
    }
    if (!this.#laserGraphics) {
      this.#laserGraphics = new PIXI.Graphics();
      this.#laserGraphics.eventMode = "none";
      this.container.addChild(this.#laserGraphics);
    }
    const live = new Set<string>();
    const items: ScribbleItem[] = [];
    for (const e of this.lasers.values()) {
      items.push(e.item);
      if (e.state === "live") live.add(e.item.id);
    }
    this.#laserGraphics.visible = true;
    drawLasers(this.#laserGraphics, items, now, live);
  }

  destroy(): void {
    this.sprites.destroy();
    this.tiles?.destroy();
    if (!this.container.destroyed) this.container.destroy({ children: true });
  }
}

export class SceneRenderer {
  readonly #host: RenderHost;
  readonly #targets: RenderTargets;
  readonly #map: Record<MapLayer, Root>;
  readonly #screenRoot: PIXI.Container;
  readonly #screen = new Map<string, Root>();
  /** Wet-media paint (fed by the session's media controller). */
  readonly media = new MediaLayer();
  /** Root each item is displayed in (items move when their layer changes). */
  readonly #where = new Map<string, Root>();
  readonly #off: () => void;
  readonly #tick = () => this.#frame();
  #frameNo = 0;
  #lastSweep = 0;
  #hidden = false;
  #destroyed = false;
  #editingTextId: string | null = null;
  #groundElevation = NaN;
  /** Called after each frame (debug overlay). */
  onFrame: ((info: { tier: number; ms: number }) => void) | null = null;

  constructor(host: RenderHost, targets: RenderTargets) {
    this.#host = host;
    this.#targets = targets;
    this.#map = { below: new Root("below", true), above: new Root("above", true), top: new Root("top", true) };
    const below = this.#map.below.container as PrimarySortable;
    below.sortLayer = SORT_LAYER.below;
    const above = this.#map.above.container as PrimarySortable;
    // Above every token and overhead tile, still below weather (sort layer 1000 at infinite elevation).
    above.elevation = Infinity;
    above.sortLayer = SORT_LAYER.above;
    targets.primary.addChild(this.media.container);
    targets.primary.addChild(below);
    targets.primary.addChild(above);
    targets.primary.sortDirty = true;
    targets.top.addChild(this.#map.top.container);
    this.#screenRoot = new PIXI.Container();
    this.#screenRoot.name = "canvas-scribble:screen";
    this.#screenRoot.eventMode = "none";
    this.#screenRoot.interactiveChildren = false;
    targets.overlay.addChild(this.#screenRoot);
    this.#off = host.store.on((e) => this.#onStore(e));
    for (const entry of host.store.values()) this.#route(entry);
    targets.ticker.add(this.#tick, this, PIXI.UPDATE_PRIORITY.NORMAL);
  }

  /** Hide or show every scribble for this client. */
  set hidden(value: boolean) {
    this.#hidden = value;
    for (const root of Object.values(this.#map)) root.container.visible = !value;
    this.media.container.visible = !value;
    this.#screenRoot.visible = !value;
  }

  get hidden(): boolean {
    return this.#hidden;
  }

  /** Re-route every item (the item filter changed: level, hidden authors…). */
  refresh(): void {
    for (const root of this.#roots()) root.clear();
    this.#where.clear();
    for (const entry of this.#host.store.values()) this.#route(entry);
  }

  /** Exclude the locally edited item from sprites AND flattened cache tiles. */
  setEditingText(id: string | null): void {
    const before = this.#editingTextId;
    this.#editingTextId = id;
    if (before && before !== id) {
      const entry = this.#host.store.get(before);
      if (entry) this.#route(entry);
    }
    if (id) this.#unroute(id);
  }

  *#roots(): Generator<Root> {
    yield* Object.values(this.#map);
    yield* this.#screen.values();
  }

  #rootFor(item: ScribbleItem): Root {
    if (item.mode === "map") return this.#map[this.#host.layerOf(item)] ?? this.#map.top;
    const anchor = item.anchor ?? [0, 0];
    const key = `${anchor[0]},${anchor[1]}`;
    let root = this.#screen.get(key);
    if (!root) {
      root = new Root(`screen ${key}`, false);
      this.#screen.set(key, root);
      this.#screenRoot.addChild(root.container);
    }
    return root;
  }

  #onStore(e: StoreEvent): void {
    if (this.#destroyed) return;
    switch (e.type) {
      case "add":
        this.#route(e.entry);
        break;
      case "update":
        this.#route(e.entry);
        break;
      case "remove":
        this.#unroute(e.entry.item.id);
        break;
      case "reset":
        for (const root of this.#roots()) root.clear();
        this.#where.clear();
        break;
    }
  }

  #route(entry: Entry): void {
    const id = entry.item.id;
    if (id === this.#editingTextId || !this.#host.shows(entry.item)) {
      this.#unroute(id);
      return;
    }
    const root = this.#rootFor(entry.item);
    const before = this.#where.get(id);
    if (before && before !== root) before.remove(id);
    root.put(entry);
    this.#where.set(id, root);
  }

  #unroute(id: string): void {
    const root = this.#where.get(id);
    if (!root) return;
    root.remove(id);
    this.#where.delete(id);
  }

  /* -------------------------------------------- */
  /*  Frame                                       */
  /* -------------------------------------------- */

  #frame(): void {
    if (this.#destroyed) return;
    const t0 = performance.now();
    const deadline = t0 + FRAME_BUDGET_MS;
    const host = this.#host;
    const now = host.now();
    const frame = ++this.#frameNo;
    if (now - this.#lastSweep > SWEEP_INTERVAL_MS || now < this.#lastSweep) {
      this.#lastSweep = now;
      host.store.sweep(now);
    }
    if (this.#hidden) return;
    const res = host.resolution();
    const vp = host.viewport();
    let tier = 0;

    // Map roots.
    const map = host.map();
    for (const root of Object.values(this.#map)) root.container.visible = !!map;
    this.media.container.visible = !!map;
    if (map) {
      const f = map.frame;
      for (const root of Object.values(this.#map)) {
        root.container.position.set(f.sceneX, f.sceneY);
        root.container.scale.set(map.sx, map.sy);
      }
      this.media.container.position.set(f.sceneX, f.sceneY);
      this.media.container.scale.set(map.sx, map.sy);
      this.#syncGround();
      tier = tierFor(map.cssPerUnit() * res * Math.max(1, map.sy / map.sx));
      const view: Bounds = map.visibleBounds(vp, 96);
      host.mediaView?.(view);
      for (const root of Object.values(this.#map)) {
        root.tiles?.frame({ view, tier, frame, deadline });
        root.sprites.frame({ now, scale: tier, tolerance: 0, view, deadline });
        root.sprites.dropRetired();
        root.drawLasers(now);
      }
    }

    // Screen roots (positions follow the viewport every frame).
    const screen = host.screen();
    const unit = screen.cssPerUnit();
    for (const [key, root] of this.#screen) {
      if (root.empty) {
        root.destroy();
        this.#screen.delete(key);
        continue;
      }
      const [ax, ay] = key.split(",").map(Number) as [number, number];
      const a = screen.anchorPoint([ax, ay]);
      root.container.position.set(a.x - vp.left, a.y - vp.top);
      root.container.scale.set(unit);
      root.sprites.frame({ now, scale: unit * res, tolerance: SCREEN_RESCALE_TOLERANCE, view: null, deadline });
      root.drawLasers(now);
    }

    stats.lastFrameMs = performance.now() - t0;
    this.onFrame?.({ tier, ms: stats.lastFrameMs });
  }

  /** "below" sits on the ground of the viewed level (v14 levels raise the background elevation). */
  #syncGround(): void {
    const primary = this.#targets.primary as PIXI.Container & { background?: { elevation?: number } };
    const ground = primary.background?.elevation ?? 0;
    if (ground === this.#groundElevation) return;
    this.#groundElevation = ground;
    (this.#map.below.container as PrimarySortable).elevation = Number.isFinite(ground) ? ground : 0;
    this.media.elevation = Number.isFinite(ground) ? ground : 0;
    this.#targets.primary.sortDirty = true;
  }

  /** Counters for the debug overlay. */
  debugInfo(): Record<string, number> {
    let tiles = 0;
    let stored = 0;
    let sprites = 0;
    let lasers = 0;
    for (const root of this.#roots()) {
      tiles += root.tiles?.textureCount ?? 0;
      stored += root.storedCount;
      sprites += root.sprites.size;
      lasers += root.lasers.size;
    }
    return { tiles, stored, sprites, lasers, screenRoots: this.#screen.size, mediaChunks: this.media.size };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#off();
    this.#targets.ticker.remove(this.#tick, this);
    for (const root of this.#roots()) root.destroy();
    this.media.destroy();
    this.#screen.clear();
    this.#where.clear();
    if (!this.#screenRoot.destroyed) this.#screenRoot.destroy({ children: true });
  }
}
