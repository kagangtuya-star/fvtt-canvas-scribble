import { BRUSHES } from "./brush/brushes.ts";
import type { PressureMode } from "./brush/recorder.ts";
import type { Modifiers } from "./brush/shapes.ts";
import { LIMITS, PENDING_TIMEOUT_MS } from "./constants.ts";
import { decodePoints, quantizePoints } from "./core/codec.ts";
import { boundsOf, simplifyToLimit } from "./core/geometry.ts";
import { History } from "./core/history.ts";
import type { Command, HistoryExecutor } from "./core/history.ts";
import { goneAt } from "./core/lifetime.ts";
import { allowed, mayModify, ROLES } from "./core/permissions.ts";
import type { Action } from "./core/permissions.ts";
import { inExtent, sanitizeItem, toWire, zKindOf } from "./core/sanitize.ts";
import { MapSpace, ScreenSpace } from "./core/space.ts";
import type { SpaceAdapter, Viewport } from "./core/space.ts";
import { ItemStore } from "./core/store.ts";
import type { Entry } from "./core/store.ts";
import { SCHEMA_VERSION } from "./core/types.ts";
import type { Kind, MapLayer, Mode, ScribbleItem, WireItem } from "./core/types.ts";
import { randomId } from "./core/util.ts";
import { activeGM, userColor, viewedLevel } from "./foundry/compat.ts";
import { readStored, rawItems, sceneRef, SceneWriter } from "./foundry/persistence.ts";
import * as settings from "./foundry/settings.ts";
import { t, tf } from "./i18n.ts";
import { LiveSender, Net } from "./net/net.ts";
import type { Inbound, SocketLike } from "./net/net.ts";
import type { ClearScope, Message } from "./net/protocol.ts";
import type { RenderHost } from "./render/renderer.ts";
import { normalizePrefs, sizeKey } from "./state/prefs.ts";
import type { Prefs, ToolId } from "./state/prefs.ts";
import { hitItem, hitPath } from "./tools/hit.ts";
import {
  EraserGesture,
  FreehandGesture,
  LaserGesture,
  PolygonGesture,
  ShapeGesture,
  densePath,
} from "./tools/gestures.ts";
import type { ClientSample, Gesture, Target, ToolHost } from "./tools/gestures.ts";

/** Temporary hold-to-draw override (keybindings). */
export type HoldMode = "screen" | "map" | "laser" | "eraser";

export interface TextRequest {
  target: Target;
  /** Client position of the click. */
  cx: number;
  cy: number;
  size: number;
  color: string;
}

type Level = "info" | "warn" | "error";

/** Stale remote live items (sender vanished mid-stroke) are dropped after this (ms). */
const LIVE_STALE_MS = 10_000;

/**
 * The per-client brain: owns the item store and history, turns gestures into
 * items, streams them, routes permanent items to the GM, applies inbound
 * messages after re-validating them, and keeps Scene-flag data in sync.
 */
export class Session implements ToolHost, RenderHost {
  readonly store = new ItemStore();
  readonly history = new History();
  readonly net: Net;
  readonly #live: LiveSender;
  readonly writer: SceneWriter;
  prefs: Prefs;
  scene: FoundryScene | null = null;
  #map: MapSpace | null = null;
  readonly #screen = new ScreenSpace({ left: 0, top: 0, width: 1920, height: 1080 });
  #gesture: Gesture | null = null;
  #eraser: {
    gesture: EraserGesture;
    partial: boolean;
    deleted: ScribbleItem[];
    before: Map<string, Entry>;
    lastPreview: number;
    limited: boolean;
  } | null = null;
  readonly #pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #liveSeen = new Map<string, number>();
  readonly #listeners = new Set<() => void>();
  readonly #notified = new Map<string, number>();
  #housekeeping: ReturnType<typeof setInterval> | null = null;
  #level: string | undefined;
  /** Temporary items kept across a canvas redraw of the same scene. */
  #stash: { scene: string; items: ScribbleItem[] } | null = null;
  hold: HoldMode | null = null;
  /** Hook for the UI text editor (text tool). */
  onTextRequest: ((req: TextRequest) => void) | null = null;
  /** Renderer refresh hook (filter or layer policy changed). */
  onRefresh: (() => void) | null = null;
  /** Debug logger (debug setting). */
  log: (text: string, data?: unknown) => void = () => undefined;

  constructor(socket: SocketLike) {
    this.prefs = settings.loadPrefs();
    this.net = new Net(socket, game.users, game.user.id);
    this.net.log = (text, data) => this.log(text, data);
    this.net.onMessage((input) => this.#receive(input));
    this.#live = new LiveSender(this.net);
    this.writer = new SceneWriter(settings.budgetBytes);
    this.writer.onError = (err) => {
      console.error("CanvasScribble | Scene write failed", err);
      this.notify("error", "Notify.SaveFailed");
    };
  }

  /* -------------------------------------------- */
  /*  State & change notification                 */
  /* -------------------------------------------- */

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  changed(): void {
    for (const fn of this.#listeners) fn();
  }

  setPrefs(patch: Partial<Prefs>): void {
    this.prefs = normalizePrefs({ ...this.prefs, ...patch });
    settings.savePrefs(this.prefs);
    this.changed();
  }

  get user(): FoundryUser {
    return game.user;
  }

  can(action: Action, user: FoundryUser = game.user): boolean {
    return allowed(user.role, action, settings.thresholds());
  }

  /** Effective colour of new items. */
  color(): string {
    return this.prefs.color ?? userColor(game.user);
  }

  get isRelay(): boolean {
    return activeGM()?.id === game.user.id;
  }

  notify(level: Level, key: string, data?: Record<string, unknown>): void {
    const now = performance.now();
    if (now - (this.#notified.get(key) ?? -Infinity) < 3000) return;
    this.#notified.set(key, now);
    const text = data ? tf(key, data) : t(key);
    ui.notifications?.[level](text);
  }

  /* -------------------------------------------- */
  /*  Scene lifecycle                             */
  /* -------------------------------------------- */

  attach(scene: FoundryScene): void {
    this.detach();
    // A redraw of the same scene (config change, level switch…) keeps temporary marks and history.
    const stash = this.#stash?.scene === scene.id ? this.#stash : null;
    this.#stash = null;
    if (!stash) this.history.clear();
    this.scene = scene;
    this.net.scene = scene.id;
    this.#level = viewedLevel();
    this.rebuildSpaces();
    this.syncStored();
    if (stash) {
      const now = this.now();
      for (const item of stash.items) if (!this.store.has(item.id) && now < goneAt(item)) this.store.put(item, "temp");
    }
    this.net.send({ t: "q" });
    this.#housekeeping = setInterval(() => this.#housekeep(), 500);
    this.changed();
  }

  detach(): void {
    if (this.scene) {
      const items = [...this.store.values()].filter((e) => e.state === "temp").map((e) => e.item);
      this.#stash = { scene: this.scene.id, items };
    }
    this.cancelGesture();
    this.#live.clear();
    for (const timer of this.#pendingTimers.values()) clearTimeout(timer);
    this.#pendingTimers.clear();
    this.#liveSeen.clear();
    if (this.#housekeeping) clearInterval(this.#housekeeping);
    this.#housekeeping = null;
    this.store.reset();
    this.scene = null;
    this.#map = null;
    this.net.scene = "";
  }

  /** Recompute coordinate frames (canvas ready, scene dimensions, reference size, resize). */
  rebuildSpaces(): void {
    this.updateViewport();
    const scene = this.scene;
    const d = canvas?.dimensions;
    if (!scene || !d) {
      this.#map = null;
      return;
    }
    const ref = sceneRef(scene);
    this.#map = new MapSpace(
      {
        sceneX: d.sceneX,
        sceneY: d.sceneY,
        sceneWidth: d.sceneWidth,
        sceneHeight: d.sceneHeight,
        refW: ref.w,
        refH: ref.h,
        gridSize: d.size || 100,
      },
      {
        zoom: () => canvas.stage?.scale?.x || 1,
        toCanvas: (cx, cy) => canvas.canvasCoordinatesFromClient({ x: cx, y: cy }),
        toClient: (x, y) => canvas.clientCoordinatesFromCanvas({ x, y }),
      },
      settings.followZoom(),
    );
  }

  updateViewport(): void {
    const view = (globalThis as { canvas?: FoundryCanvas }).canvas?.app?.view;
    const r = view?.getBoundingClientRect?.();
    if (r && r.width > 0 && r.height > 0)
      this.#screen.viewport = { left: r.left, top: r.top, width: r.width, height: r.height };
    else this.#screen.viewport = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  /** Read Scene flags into the store (diffing by revision). */
  syncStored(): void {
    const scene = this.scene;
    if (!scene) return;
    const raw = rawItems(scene);
    const now = this.now();
    const present = new Set<string>();
    for (const [id, data] of Object.entries(raw)) {
      if (!data || typeof data !== "object") continue;
      present.add(id);
      const existing = this.store.get(id);
      const w = data as Partial<WireItem>;
      if (
        existing?.state === "stored" &&
        existing.item.revision === w.revision &&
        existing.item.createdAt === w.createdAt
      )
        continue;
      const item = readStored(scene, id, data, now);
      if (!item) continue;
      this.store.put(item, "stored");
      this.#clearPending(id);
    }
    for (const entry of [...this.store.values()]) {
      if (entry.state === "stored" && !present.has(entry.item.id)) this.store.remove(entry.item.id);
    }
  }

  /** Scene document changed. */
  onSceneUpdate(scene: FoundryScene, changes: Record<string, any>): void {
    if (!this.scene || scene.id !== this.scene.id) return;
    const flags = changes?.flags;
    if (!flags) return;
    const mine = Object.keys(flags).some((key) => key === "canvas-scribble" || key.startsWith("canvas-scribble"));
    if (!mine) return;
    if (flags["canvas-scribble"]?.ref) this.rebuildSpaces();
    this.syncStored();
  }

  #housekeep(): void {
    const now = performance.now();
    for (const [id, seen] of this.#liveSeen) {
      if (now - seen < LIVE_STALE_MS) continue;
      this.#liveSeen.delete(id);
      if (this.store.get(id)?.state === "live") this.store.remove(id);
    }
    const level = viewedLevel();
    if (level !== this.#level) {
      this.#level = level;
      this.onRefresh?.();
    }
    this.history.prune(this.#executor);
  }

  /** A user left: drop their live strokes. */
  onUserGone(userId: string): void {
    for (const entry of [...this.store.values()]) {
      if (entry.state === "live" && entry.item.author === userId) this.store.remove(entry.item.id);
    }
  }

  /* -------------------------------------------- */
  /*  RenderHost                                  */
  /* -------------------------------------------- */

  now(): number {
    return game.time?.serverTime ?? Date.now();
  }

  map(): MapSpace | null {
    return this.#map;
  }

  screen(): ScreenSpace {
    return this.#screen;
  }

  viewport(): Viewport {
    return this.#screen.viewport;
  }

  resolution(): number {
    return canvas?.app?.renderer?.resolution || window.devicePixelRatio || 1;
  }

  shows(item: ScribbleItem): boolean {
    if (item.mode === "map" && item.level && this.#level && item.level !== this.#level) return false;
    return true;
  }

  layerOf(item: ScribbleItem): MapLayer {
    if (item.layer === "top" && item.kind !== "laser" && settings.playerFog()) {
      const author = game.users.get(item.author);
      if (!author?.isGM) return "above";
    }
    return item.layer;
  }

  space(mode: Mode): SpaceAdapter | null {
    return mode === "map" ? this.#map : this.#screen;
  }

  /* -------------------------------------------- */
  /*  ToolHost                                    */
  /* -------------------------------------------- */

  pressureMode(): PressureMode {
    const s = settings.pressureSetting();
    return s === "never" ? "off" : s === "simulate" ? "simulate" : "auto";
  }

  /** Lifetime (ms) for new items in a mode; 0 = permanent (map only, permission required). */
  lifetimeFor(mode: Mode): number {
    const life = this.prefs.lifetime[mode];
    if (mode === "screen") return life || 8000;
    if (life === 0 && !this.can("permanent")) return 60_000;
    return life;
  }

  makeItem(
    target: Target,
    kind: Kind,
    tool: string,
    size: number,
    points: number[],
    extra?: Partial<ScribbleItem>,
  ): ScribbleItem {
    const now = this.now();
    const p = this.prefs;
    const life = kind === "laser" ? 0 : this.lifetimeFor(target.mode);
    const permanent = target.mode === "map" && life === 0 && kind !== "laser";
    const style: ScribbleItem["style"] = {};
    const brush = kind === "stroke" ? BRUSHES[tool as keyof typeof BRUSHES] : undefined;
    if (p.halo && kind !== "laser" && kind !== "area" && tool !== "highlighter" && tool !== "soft") style.halo = true;
    if (p.dash && (kind === "shape" || kind === "area" || tool === "fineliner")) style.dash = true;
    if (p.fill && kind === "shape" && (tool === "rect" || tool === "ellipse" || tool === "polygon")) style.fill = 0.22;
    if (kind === "area") style.fill = 0.28;
    const layer: MapLayer = kind === "laser" ? "top" : permanent ? p.layer.permanent : p.layer.temporary;
    const item: ScribbleItem = {
      schemaVersion: SCHEMA_VERSION,
      id: randomId(16),
      author: game.user.id,
      scene: this.scene?.id ?? "",
      mode: target.mode,
      kind,
      tool,
      color: this.color(),
      opacity: brush?.opacity ?? 1,
      size,
      points,
      style,
      createdAt: now,
      expiresAt: permanent ? null : now + life,
      fadeDuration: kind === "laser" ? p.laserTrail : p.fade[target.mode],
      layer: target.mode === "screen" ? "top" : layer,
      visibility: "all",
      revision: 0,
    };
    if (target.mode === "screen") item.anchor = target.anchor ?? [0, 0];
    else {
      const level = viewedLevel();
      if (level) item.level = level;
    }
    if (extra) {
      const { style: extraStyle, ...rest } = extra;
      Object.assign(item, rest);
      if (extraStyle) item.style = { ...item.style, ...extraStyle };
    }
    return item;
  }

  live(item: ScribbleItem): void {
    const existing = this.store.get(item.id);
    this.store.put(item, "live");
    if (!existing) this.#live.start(item);
    else this.#live.push(item);
  }

  cancel(id: string): void {
    if (this.store.get(id)?.state === "live") this.store.remove(id);
    this.#live.cancel(id);
  }

  commit(raw: ScribbleItem): void {
    if (!this.scene) return;
    const now = this.now();
    let item: ScribbleItem;
    if (raw.kind === "laser") item = { ...raw, points: quantizePoints(raw.points, "time") };
    else {
      const life = raw.expiresAt === null ? null : raw.expiresAt - raw.createdAt;
      item = {
        ...raw,
        points: quantizePoints(raw.points, zKindOf(raw.kind)),
        createdAt: now,
        expiresAt: life === null ? null : now + life,
      };
    }
    if (item.expiresAt === null) {
      if (!this.#persist(item, true)) return;
    } else {
      this.store.put(item, "temp");
      this.#live.end(item, false);
    }
    if (item.kind !== "laser") this.history.record({ type: "create", items: [item] });
    this.changed();
  }

  /**
   * Send a permanent item to storage. Returns false when it could not even be
   * queued (it is then dropped or kept as a temporary item).
   */
  #persist(item: ScribbleItem, fromLive: boolean): boolean {
    const scene = this.scene!;
    if (item.mode !== "map" || !this.can("permanent")) {
      this.notify("warn", "Notify.NoPermanentPermission");
      return this.#downgrade(item, fromLive);
    }
    const gm = activeGM();
    if (!gm) {
      this.notify("warn", "Notify.NoGM");
      return this.#downgrade(item, fromLive);
    }
    if (gm.id === game.user.id) {
      const refusal = this.writer.write(scene, item);
      if (refusal) {
        this.notify("warn", refusal === "budget" ? "Notify.Budget" : "Notify.TooMany");
        this.store.remove(item.id);
        if (fromLive) this.#live.cancel(item.id);
        return false;
      }
      this.store.put(item, "pending");
      if (fromLive) this.#live.end(item, true);
      else this.net.send({ t: "e", item: toWire(item), persist: true });
      this.#armPending(item.id, true);
      return true;
    }
    this.store.put(item, "pending");
    if (fromLive) this.#live.end(item, true);
    else this.net.send({ t: "e", item: toWire(item), persist: true });
    this.#armPending(item.id, true);
    return true;
  }

  /** No GM / no permission: keep the stroke as a temporary map item instead of losing it. */
  #downgrade(item: ScribbleItem, fromLive: boolean): boolean {
    const now = this.now();
    const temp = { ...item, createdAt: now, expiresAt: now + 60_000, layer: this.prefs.layer.temporary };
    this.store.put(temp, "temp");
    if (fromLive) this.#live.end(temp, false);
    else this.net.send({ t: "e", item: toWire(temp) });
    this.history.record({ type: "create", items: [temp] });
    this.changed();
    return false;
  }

  #armPending(id: string, mine: boolean): void {
    this.#clearPending(id);
    this.#pendingTimers.set(
      id,
      setTimeout(() => {
        this.#pendingTimers.delete(id);
        if (this.store.get(id)?.state !== "pending") return;
        this.store.remove(id);
        if (mine) this.notify("warn", "Notify.SaveTimeout");
      }, PENDING_TIMEOUT_MS),
    );
  }

  #clearPending(id: string): void {
    const timer = this.#pendingTimers.get(id);
    if (timer) clearTimeout(timer);
    this.#pendingTimers.delete(id);
  }

  /* -------------------------------------------- */
  /*  Pointer gestures                            */
  /* -------------------------------------------- */

  get drawing(): boolean {
    return !!this.#gesture || !!this.#eraser;
  }

  /** Effective tool and mode, honouring a held key. */
  effective(): { tool: ToolId; mode: Mode } {
    const p = this.prefs;
    switch (this.hold) {
      case "screen":
      case "map": {
        const tool = p.tool === "eraser" || p.tool === "text" || p.tool === "laser" ? "draw" : p.tool;
        return { tool, mode: this.hold };
      }
      case "laser":
        return { tool: "laser", mode: this.#map ? "map" : "screen" };
      case "eraser":
        return { tool: "eraser", mode: p.mode };
      default:
        return { tool: p.tool, mode: p.mode };
    }
  }

  #target(mode: Mode, s: ClientSample): Target | null {
    if (!this.scene) return null;
    if (mode === "map") {
      if (!this.#map) return null;
      return { mode, space: this.#map };
    }
    return { mode, space: this.#screen, anchor: this.#screen.anchorFor(s.cx, s.cy) };
  }

  /** Primary button down. Returns false when nothing was started (the event is not consumed). */
  pointerDown(s: ClientSample, mods: Modifiers): boolean {
    if (this.#gesture?.down) {
      this.#gesture.down(s, mods);
      return true;
    }
    this.cancelGesture();
    const { tool, mode } = this.effective();
    const action: Action = mode === "map" ? "map" : "screen";
    if (!this.can(action)) {
      this.notify("warn", mode === "map" ? "Notify.NoMapPermission" : "Notify.NoScreenPermission");
      return false;
    }
    const target = this.#target(mode, s);
    if (!target) return false;
    const p = this.prefs;
    switch (tool) {
      case "draw":
        this.#gesture = new FreehandGesture(this, target, { kind: "stroke", tool: p.brush, size: p.sizes[p.brush] }, s);
        break;
      case "highlight":
        this.#gesture =
          p.highlight === "area"
            ? new FreehandGesture(this, target, { kind: "area", tool: "area", size: p.sizes.area }, s)
            : new FreehandGesture(this, target, { kind: "stroke", tool: "highlighter", size: p.sizes.highlighter }, s);
        break;
      case "arrow":
        this.#gesture =
          p.arrow === "path"
            ? new FreehandGesture(
                this,
                target,
                { kind: "stroke", tool: "fineliner", size: p.sizes.arrow, extra: { style: { head: p.head } } },
                s,
              )
            : new ShapeGesture(this, target, "arrow", p.sizes.arrow, s, { style: { head: p.head } });
        break;
      case "shape":
        this.#gesture =
          p.shape === "polygon"
            ? new PolygonGesture(this, target, p.sizes.shape, s)
            : new ShapeGesture(this, target, p.shape, p.sizes.shape, s);
        break;
      case "laser":
        this.#gesture = new LaserGesture(this, target, p.sizes.laser, s);
        break;
      case "text": {
        const size = target.space.widthFor(p.sizes.text);
        this.onTextRequest?.({ target, cx: s.cx, cy: s.cy, size, color: this.color() });
        return true;
      }
      case "eraser":
        this.#startEraser(target, s);
        return true;
    }
    return !!this.#gesture;
  }

  pointerMove(samples: ClientSample[], mods: Modifiers): void {
    if (this.#eraser) this.#eraser.gesture.move(samples);
    else this.#gesture?.move(samples, mods);
  }

  /** Pointer moves without a button (polygon rubber band). */
  pointerHover(s: ClientSample, mods: Modifiers): void {
    this.#gesture?.hover?.(s, mods);
  }

  pointerUp(s: ClientSample, mods: Modifiers): void {
    if (this.#eraser) {
      this.#eraser.gesture.up(s);
      this.#eraser = null;
      return;
    }
    const g = this.#gesture;
    if (!g) return;
    const keep = g.up(s, mods);
    if (!keep) this.#gesture = null;
  }

  /** Enter / double click: finish a multi-click gesture. */
  finishGesture(): boolean {
    const g = this.#gesture;
    if (!g?.finish) return false;
    g.finish();
    this.#gesture = null;
    return true;
  }

  cancelGesture(): boolean {
    let did = false;
    if (this.#gesture) {
      this.#gesture.cancel();
      this.#gesture = null;
      did = true;
    }
    if (this.#eraser) {
      this.#eraser.gesture.cancel();
      this.#eraser = null;
      did = true;
    }
    return did;
  }

  /** Commit a text item from the text editor. */
  commitText(req: TextRequest, text: string): void {
    const clean = text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").slice(0, LIMITS.maxTextLength);
    if (!clean.trim()) return;
    const p = req.target.space.fromClient(req.cx, req.cy, req.target.anchor);
    const item = this.makeItem(req.target, "text", "text", req.size, [p.x, p.y, 0.5], { text: clean, style: {} });
    if (this.prefs.halo) item.style.halo = true;
    this.commit(item);
  }

  /* -------------------------------------------- */
  /*  Eraser                                      */
  /* -------------------------------------------- */

  #startEraser(target: Target, s: ClientSample): void {
    const partial = this.prefs.eraser === "partial";
    const state = {
      partial,
      deleted: [] as ScribbleItem[],
      before: new Map<string, Entry>(),
      lastPreview: 0,
      limited: false,
    };
    const gesture = new EraserGesture(
      target,
      this.prefs.sizes.eraser,
      s,
      (path, final) => this.#erase(path, final),
      () => this.#eraseCancel(),
    );
    this.#eraser = { gesture, ...state };
  }

  /** Items the eraser may touch, with the offset that maps the eraser path into each item's space. */
  *#erasable(target: Target): Generator<{ entry: Entry; dx: number; dy: number }> {
    const me = game.user;
    const th = settings.thresholds();
    for (const entry of this.store.values()) {
      const item = entry.item;
      if (item.mode !== target.mode || item.kind === "laser") continue;
      if (entry.state === "live" || entry.state === "pending") continue;
      if (!this.shows(item)) continue;
      if (!mayModify(me.id, me.role, item.author, th)) continue;
      if (target.mode === "screen") {
        const a = this.#screen.anchorPoint(target.anchor ?? [0, 0]);
        const b = this.#screen.anchorPoint(item.anchor ?? [0, 0]);
        const u = this.#screen.cssPerUnit();
        yield { entry, dx: (a.x - b.x) / u, dy: (a.y - b.y) / u };
      } else yield { entry, dx: 0, dy: 0 };
    }
  }

  #erase(path: number[], final: boolean): void {
    const e = this.#eraser;
    if (!e) return;
    const target = e.gesture.target;
    const r = e.gesture.radius;
    if (!e.partial) {
      // Whole-item eraser: test the newest part of the path, delete on contact.
      const recent = path.slice(Math.max(0, path.length - 9));
      const dense = densePath(recent, r);
      const hits: Entry[] = [];
      for (const { entry, dx, dy } of this.#erasable(target)) {
        for (let i = 0; i + 1 < dense.length; i += 3) {
          if (hitItem(entry, dense[i]! - dx, dense[i + 1]! - dy, r)) {
            hits.push(entry);
            break;
          }
        }
      }
      if (hits.length) {
        e.deleted.push(...hits.map((h) => h.item));
        this.#removeItems(hits.map((h) => h.item));
      }
      if (final && e.deleted.length) {
        this.history.record({ type: "delete", items: e.deleted });
        this.changed();
      }
      return;
    }
    // Partial eraser: masks on the touched items, previewed locally, sent at the end.
    const now = performance.now();
    if (!final && now - e.lastPreview < 50) return;
    e.lastPreview = now;
    const dense = densePath(path, r);
    const tail = densePath(path.slice(Math.max(0, path.length - 3 * 24)), r);
    const tb = boundsOf(tail);
    const after: ScribbleItem[] = [];
    for (const { entry, dx, dy } of this.#erasable(target)) {
      const id = entry.item.id;
      const original = e.before.get(id) ?? entry;
      const shift = (pts: number[]) =>
        dx || dy ? pts.map((v, i) => (i % 3 === 0 ? v - dx : i % 3 === 1 ? v - dy : v)) : pts;
      if (!e.before.has(id)) {
        // Only the newest part of the path needs testing; earlier parts were tested before.
        if (!hitPath(original, shift(tail), r, [tb[0] - dx, tb[1] - dy, tb[2] - dx, tb[3] - dy])) continue;
        e.before.set(id, entry);
      }
      const masks = original.item.erase ?? [];
      if (masks.length >= LIMITS.maxMasksPerItem) {
        e.limited = true;
        continue;
      }
      const mpts = quantizePoints(simplifyToLimit(shift(dense), r * 0.1, LIMITS.maxPointsPerMask));
      after.push({
        ...original.item,
        erase: [...masks, { size: r * 2, points: mpts }],
        revision: original.item.revision + 1,
      });
    }
    if (!final) {
      for (const item of after) {
        const state = this.store.get(item.id)?.state;
        if (state) this.store.put(item, state);
      }
      return;
    }
    if (e.limited) this.notify("info", "Notify.MaskLimit");
    if (!after.length) return;
    const before = [...e.before.values()].filter((x) => after.some((a) => a.id === x.item.id)).map((x) => x.item);
    this.#replaceItems(after);
    this.history.record({ type: "update", before, after });
    this.changed();
  }

  #eraseCancel(): void {
    const e = this.#eraser;
    if (!e) return;
    if (e.partial) {
      for (const entry of e.before.values()) if (this.store.has(entry.item.id)) this.store.put(entry.item, entry.state);
    } else if (e.deleted.length) this.history.record({ type: "delete", items: e.deleted });
  }

  /* -------------------------------------------- */
  /*  Item operations (local + network)           */
  /* -------------------------------------------- */

  /** Remove items everywhere (temporary: peers; stored: via the GM). */
  #removeItems(items: ScribbleItem[]): void {
    if (!this.scene || !items.length) return;
    const ids: string[] = [];
    const stored: string[] = [];
    for (const item of items) {
      const entry = this.store.get(item.id);
      if (entry?.state === "stored" || entry?.state === "pending" || (!entry && item.expiresAt === null))
        stored.push(item.id);
      if (entry) this.store.remove(item.id);
      this.#clearPending(item.id);
      ids.push(item.id);
    }
    for (let i = 0; i < ids.length; i += 200) this.net.send({ t: "d", ids: ids.slice(i, i + 200) });
    if (stored.length && this.isRelay) this.writer.delete(this.scene, stored);
  }

  /** Replace items everywhere (erase masks, undo/redo of an update). */
  #replaceItems(items: ScribbleItem[]): void {
    if (!this.scene) return;
    for (const item of items) {
      const entry = this.store.get(item.id);
      if (item.expiresAt === null) {
        if (this.isRelay) {
          const refusal = this.writer.write(this.scene, item);
          if (refusal) {
            this.notify("warn", "Notify.Budget");
            if (entry) this.store.put(entry.item, entry.state);
            continue;
          }
        } else this.net.send({ t: "u", item: toWire(item) });
        // Optimistic local display until the Scene update confirms it.
        this.store.put(item, "stored");
      } else {
        this.store.put(item, entry?.state === "live" ? "live" : "temp");
        this.net.send({ t: "u", item: toWire(item) });
      }
    }
  }

  /** Re-create items with their original ids (undo of delete, redo of create). */
  #restoreItems(items: ScribbleItem[]): void {
    for (const item of items) {
      if (this.store.has(item.id)) continue;
      if (item.expiresAt === null) this.#persist(item, false);
      else {
        this.store.put(item, "temp");
        this.net.send({ t: "e", item: toWire(item) });
      }
    }
  }

  readonly #executor: HistoryExecutor = {
    restore: (items) => this.#restoreItems(items),
    remove: (items) => this.#removeItems(items),
    replace: (items) => this.#replaceItems(items),
    usable: (item) =>
      !!this.scene && item.scene === this.scene.id && (item.expiresAt === null || this.now() < goneAt(item)),
  };

  undo(): Command | null {
    this.cancelGesture();
    const cmd = this.history.undo(this.#executor);
    if (!cmd) this.notify("info", "Notify.NothingToUndo");
    this.changed();
    return cmd;
  }

  redo(): Command | null {
    const cmd = this.history.redo(this.#executor);
    if (!cmd) this.notify("info", "Notify.NothingToRedo");
    this.changed();
    return cmd;
  }

  /* -------------------------------------------- */
  /*  Clearing                                    */
  /* -------------------------------------------- */

  /** Items a clear scope affects for a given sender (local view). */
  #clearTargets(scope: ClearScope, authorId: string): Entry[] {
    return [...this.store.values()].filter((e) => {
      const it = e.item;
      const temp = it.expiresAt !== null;
      switch (scope) {
        case "mine":
          return temp && it.author === authorId && e.state !== "live";
        case "screen":
          return temp && it.mode === "screen";
        case "mapTemp":
          return temp && it.mode === "map";
        case "allTemp":
          return temp;
        case "minePermanent":
          return !temp && it.author === authorId;
        case "permanent":
          return !temp;
      }
    });
  }

  /** Count of items a scope would remove right now (for the clear menu). */
  clearCount(scope: ClearScope): number {
    return this.#clearTargets(scope, game.user.id).length;
  }

  /** May the current user use this scope? */
  mayClear(scope: ClearScope): boolean {
    switch (scope) {
      case "mine":
        return true;
      case "minePermanent":
        return this.can("permanent") || this.clearCount("minePermanent") > 0;
      default:
        return this.can("manage");
    }
  }

  /** Apply a clear locally and broadcast it (confirmation is the caller's job). */
  clear(scope: ClearScope): number {
    if (!this.scene || !this.mayClear(scope)) return 0;
    const targets = this.#clearTargets(scope, game.user.id);
    for (const e of targets) {
      this.store.remove(e.item.id);
      this.#clearPending(e.item.id);
    }
    this.net.send({ t: "c", scope });
    if (this.isRelay && (scope === "minePermanent" || scope === "permanent"))
      this.#relayClear(this.scene, scope, game.user);
    // Only clearing your own marks is undoable (restoring others' marks would re-author them).
    const own = targets.map((e) => e.item).filter((i) => i.author === game.user.id);
    if (own.length && (scope === "mine" || scope === "minePermanent"))
      this.history.record({ type: "delete", items: own });
    this.changed();
    return targets.length;
  }

  #relayClear(scene: FoundryScene, scope: "minePermanent" | "permanent", sender: FoundryUser): void {
    const raw = rawItems(scene);
    const ids = Object.entries(raw)
      .filter(([, v]) => v && (scope === "permanent" || (v as { author?: string }).author === sender.id))
      .map(([id]) => id);
    if (ids.length) this.writer.delete(scene, ids);
  }

  /** Change the map layer of own (or manageable) items. */
  setLayer(items: ScribbleItem[], layer: MapLayer): void {
    const after = items
      .filter((i) => i.mode === "map" && i.layer !== layer)
      .map((i) => ({ ...i, layer, revision: i.revision + 1 }));
    if (!after.length) return;
    const before = items.filter((i) => after.some((a) => a.id === i.id));
    this.#replaceItems(after);
    this.history.record({ type: "update", before, after });
    this.changed();
  }

  /* -------------------------------------------- */
  /*  Inbound messages                            */
  /* -------------------------------------------- */

  #ctx(scene: FoundryScene, author: string, allowPermanent: boolean) {
    const ref = sceneRef(scene);
    return { author, scene: scene.id, now: this.now(), allowPermanent, mapExtent: { w: ref.w, h: ref.h } };
  }

  #receive({ msg, sender }: Inbound): void {
    const here = !!this.scene && msg.scene === this.scene.id;
    const relay = this.isRelay;
    if (!here && !relay) return;
    const scene = here ? this.scene! : game.scenes?.get(msg.scene);
    if (!scene) return;
    const th = settings.thresholds();
    const may = (a: Action) => allowed(sender.role, a, th);
    this.log(`recv ${msg.t} from ${sender.name}`, msg);
    switch (msg.t) {
      case "s":
      case "e": {
        if (!here && !(msg.t === "e" && msg.persist)) return;
        const item = sanitizeItem(msg.item, this.#ctx(scene, sender.id, true));
        if (!item) return;
        if (!may(item.mode === "map" ? "map" : "screen")) return;
        const existing = here ? this.store.get(item.id) : undefined;
        if (existing && existing.item.author !== sender.id) return;
        const permanent = item.expiresAt === null;
        if (permanent && (item.mode !== "map" || !may("permanent") || item.kind === "laser")) {
          if (msg.t === "e" && relay && msg.persist)
            this.net.send({ t: "n", to: sender.id, id: item.id, reason: "permission" }, scene.id);
          if (here && existing) this.store.remove(item.id);
          return;
        }
        if (msg.t === "s") {
          this.store.put(item, "live");
          this.#liveSeen.set(item.id, performance.now());
          return;
        }
        this.#liveSeen.delete(item.id);
        if (!permanent) {
          if (here) this.store.put(item, "temp");
          return;
        }
        if (relay && msg.persist) {
          const refusal = this.writer.write(scene, item);
          if (refusal) {
            this.net.send({ t: "n", to: sender.id, id: item.id, reason: refusal }, scene.id);
            if (here) this.store.remove(item.id);
            return;
          }
        }
        if (here && existing?.state !== "stored") {
          this.store.put(item, "pending");
          this.#armPending(item.id, false);
        }
        return;
      }
      case "p": {
        if (!here) return;
        const entry = this.store.get(msg.id);
        if (!entry || entry.state !== "live" || entry.item.author !== sender.id) return;
        const have = entry.item.points.length / 3;
        if (msg.from > have) return; // missed a batch: the end message will carry the full item
        const room = LIMITS.maxPointsPerItem - msg.from;
        const pts = decodePoints(msg.pts, zKindOf(entry.item.kind), room);
        if (!pts) return;
        const ref = sceneRef(scene);
        if (!inExtent(pts, entry.item.mode, { mapExtent: { w: ref.w, h: ref.h } })) return;
        const points = entry.item.points.slice(0, msg.from * 3).concat(pts);
        this.store.put({ ...entry.item, points }, "live");
        this.#liveSeen.set(msg.id, performance.now());
        return;
      }
      case "x": {
        if (!here) return;
        const entry = this.store.get(msg.id);
        if (entry?.state === "live" && entry.item.author === sender.id) this.store.remove(msg.id);
        this.#liveSeen.delete(msg.id);
        return;
      }
      case "d": {
        const storedIds: string[] = [];
        const raw = relay ? rawItems(scene) : {};
        for (const id of msg.ids) {
          const entry = here ? this.store.get(id) : undefined;
          // A permanent item may still be queued for writing (deleted right after drawing, e.g. by undo).
          const queued = relay ? this.writer.queued(scene, id) : undefined;
          const author = entry?.item.author ?? (raw[id] as { author?: string } | undefined)?.author ?? queued?.author;
          if (!author || !mayModify(sender.id, sender.role, author, th)) continue;
          if (relay && (raw[id] || queued)) storedIds.push(id);
          if (entry) {
            this.store.remove(id);
            this.#clearPending(id);
          }
        }
        if (storedIds.length) this.writer.delete(scene, storedIds);
        return;
      }
      case "u": {
        const id = (msg.item as { id?: unknown }).id;
        if (typeof id !== "string") return;
        const entry = here ? this.store.get(id) : undefined;
        const storedRaw = relay ? rawItems(scene)[id] : undefined;
        const current = entry?.item ?? (storedRaw ? readStored(scene, id, storedRaw, this.now()) : null);
        if (!current || !mayModify(sender.id, sender.role, current.author, th)) return;
        // The author never changes through an update.
        const item = sanitizeItem(msg.item, {
          ...this.#ctx(scene, current.author, current.expiresAt === null),
          allowExpired: current.expiresAt === null,
        });
        if (
          !item ||
          item.mode !== current.mode ||
          item.kind !== current.kind ||
          (item.expiresAt === null) !== (current.expiresAt === null)
        )
          return;
        if (item.expiresAt === null) {
          if (relay && storedRaw) {
            const refusal = this.writer.write(scene, item);
            if (refusal) this.net.send({ t: "n", to: sender.id, id: item.id, reason: refusal }, scene.id);
          }
          if (here && entry) this.store.put(item, entry.state);
        } else if (here && entry) this.store.put(item, entry.state === "live" ? "live" : "temp");
        return;
      }
      case "c": {
        const scope = msg.scope;
        const own = scope === "mine" || scope === "minePermanent";
        if (!own && !may("manage")) return;
        if (here) {
          for (const e of this.#clearTargets(scope, sender.id)) {
            this.store.remove(e.item.id);
            this.#clearPending(e.item.id);
          }
        }
        if (relay && (scope === "minePermanent" || scope === "permanent")) this.#relayClear(scene, scope, sender);
        return;
      }
      case "q": {
        if (!here) return;
        const now = this.now();
        const mine = [...this.store.values()]
          .filter((e) => e.state === "temp" && e.item.author === game.user.id && now < goneAt(e.item))
          .map((e) => toWire(e.item));
        for (let i = 0; i < mine.length; i += 50)
          this.net.send({ t: "r", to: sender.id, items: mine.slice(i, i + 50) });
        return;
      }
      case "r": {
        if (!here || msg.to !== game.user.id) return;
        for (const wire of msg.items) {
          const item = sanitizeItem(wire, this.#ctx(scene, sender.id, false));
          if (!item || this.store.has(item.id)) continue;
          if (!may(item.mode === "map" ? "map" : "screen")) continue;
          this.store.put(item, "temp");
        }
        return;
      }
      case "n": {
        if (!sender.isGM && sender.role < ROLES.GAMEMASTER) return;
        if (here && this.store.get(msg.id)?.state === "pending") this.store.remove(msg.id);
        this.#clearPending(msg.id);
        if (msg.to === game.user.id) {
          const key =
            msg.reason === "budget"
              ? "Notify.Budget"
              : msg.reason === "count"
                ? "Notify.TooMany"
                : "Notify.SaveRefused";
          this.notify("warn", key);
        }
        return;
      }
    }
  }

  /** Send a raw message (API/debug). */
  send(msg: Message): void {
    this.net.send(msg as never, msg.scene);
  }

  /* -------------------------------------------- */
  /*  Sizes                                       */
  /* -------------------------------------------- */

  /** Change the active tool's size by `delta` UI steps (wheel / [ ]). */
  nudgeSize(delta: number): void {
    const key = sizeKey(this.prefs);
    const cur = this.prefs.sizes[key];
    const step = Math.max(1, Math.round(cur * 0.12));
    const sizes = { ...this.prefs.sizes, [key]: cur + Math.sign(delta) * step };
    this.setPrefs({ sizes });
  }

  destroy(): void {
    this.detach();
    this.net.destroy();
    this.#listeners.clear();
  }
}
