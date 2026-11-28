import { buildConstraint, offsetRulers } from "./assist/constraint.ts";
import type { StrokeConstraint } from "./assist/constraint.ts";
import { emptyGuides, GUIDE_LIMITS, normalizeRuler } from "./assist/guides-model.ts";
import type { Ruler, SceneGuides } from "./assist/guides-model.ts";
import { BRUSHES, diffBrushOverride, resolveBrushParams } from "./brush/brushes.ts";
import type { PressureMode } from "./brush/recorder.ts";
import type { Modifiers } from "./brush/shapes.ts";
import { LIMITS, PENDING_TIMEOUT_MS } from "./constants.ts";
import {
  decodeAngles,
  decodePoints,
  decodeUnits,
  quantizeAngles,
  quantizePoints,
  quantizeUnits,
} from "./core/codec.ts";
import { boundsOf, simplifyToLimit } from "./core/geometry.ts";
import type { Bounds } from "./core/geometry.ts";
import { History } from "./core/history.ts";
import { affineOf, conjugate, IDENTITY } from "./core/matrix.ts";
import type { Mat3, Pt } from "./core/matrix.ts";
import type { Command, HistoryExecutor } from "./core/history.ts";
import { goneAt } from "./core/lifetime.ts";
import { allowed, mayModify, ROLES } from "./core/permissions.ts";
import type { Action } from "./core/permissions.ts";
import { inExtent, sanitizeItem, toWire, zKindOf } from "./core/sanitize.ts";
import { MapSpace, ScreenSpace } from "./core/space.ts";
import type { SpaceAdapter, Viewport } from "./core/space.ts";
import { ItemStore } from "./core/store.ts";
import type { Entry, EntryState } from "./core/store.ts";
import { cleanText, layoutText } from "./core/text-layout.ts";
import { SCHEMA_VERSION } from "./core/types.ts";
import type { BrushId, EraseMask, Kind, MapLayer, Mode, ScribbleItem, WireItem } from "./core/types.ts";
import { randomId } from "./core/util.ts";
import { activeGM, userColor, viewedLevel } from "./foundry/compat.ts";
import { readStored, rawItems, sceneRef, SceneWriter } from "./foundry/persistence.ts";
import * as settings from "./foundry/settings.ts";
import { t, tf } from "./i18n.ts";
import { MEDIA_BRUSHES, resolveMediaParams } from "./media/brushes.ts";
import { MediaController } from "./media/controller.ts";
import type { MediaMessage } from "./media/controller.ts";
import { MAX_MEDIA_SIZE } from "./media/ops.ts";
import { LiveSender, Net } from "./net/net.ts";
import type { Inbound, SocketLike } from "./net/net.ts";
import { MAX_UPDATE_BATCH } from "./net/protocol.ts";
import type { ClearScope, Message } from "./net/protocol.ts";
import type { RenderHost } from "./render/renderer.ts";
import {
  activeBrushId,
  brushBlend,
  brushOpacity,
  MEDIA_UI_SIZE,
  normalizePrefs,
  pushRecent,
  sizeKey,
} from "./state/prefs.ts";
import type { Prefs, ToolId } from "./state/prefs.ts";
import { sampleColorAt } from "./tools/eyedropper.ts";
import { hitItem, hitPath } from "./tools/hit.ts";
import { regionHit } from "./tools/lasso.ts";
import { translateItem } from "./tools/select.ts";
import {
  changesItems,
  flipAbout,
  frameTransform,
  rotateAbout,
  scaleAbout,
  transformFrame,
  transformItem,
} from "./tools/transform.ts";
import type { FrameState, TransformHandle } from "./tools/transform.ts";
import {
  EraserGesture,
  FreehandGesture,
  LaserGesture,
  PolygonGesture,
  ShapeGesture,
  densePath,
  toSpace,
} from "./tools/gestures.ts";
import type { ClientSample, Gesture, Target, ToolHost } from "./tools/gestures.ts";
import { MediaGesture } from "./tools/media-gesture.ts";

/** Temporary hold-to-draw override (keybindings). */
export type HoldMode = "screen" | "map" | "laser" | "eraser";

export interface TextRequest {
  target: Target;
  /** Client position of the click. */
  cx: number;
  cy: number;
  size: number;
  color: string;
  scene: string;
  point: { x: number; y: number };
  original?: ScribbleItem;
}

type Level = "info" | "warn" | "error";

/** Stale remote live items (sender vanished mid-stroke) are dropped after this (ms). */
const LIVE_STALE_MS = 10_000;
/** Live transform previews are re-applied at most this often (ms). */
const TRANSFORM_FRAME_MS = 16;
/** Socket payload kept under this many characters per `U` message. */
const UPDATE_CHUNK_CHARS = 180_000;

/** Ruler creation presets. */
export type RulerPreset = "perspective1" | "perspective2" | "perspective3" | "curve";

interface Transforming {
  handle: TransformHandle;
  mode: Mode;
  originals: Entry[];
  start: FrameState;
  now: FrameState;
  /** Pointer at drag start (reference space; item space for text width handles). */
  origin: Pt;
  moved: boolean;
  lastApply: number;
  /** Text width handles work in the single text item's space. */
  target?: Target;
}

interface RegionSelect {
  shape: "rect" | "lasso";
  op: "replace" | "add" | "subtract";
  mode: Mode;
  /** Client px pairs. */
  pts: number[];
}

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
  /** Wet-media simulation (paint tool). */
  readonly media: MediaController;
  prefs: Prefs;
  scene: FoundryScene | null = null;
  #map: MapSpace | null = null;
  readonly #screen = new ScreenSpace({ left: 0, top: 0, width: 1920, height: 1080 });
  #gesture: Gesture | null = null;
  #colorPick: AbortController | null = null;
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
  /** Selected item ids (Select & Transform tool); all of one mode. */
  readonly selection = new Set<string>();
  editingTextId: string | null = null;
  onTextEditingChange: ((id: string | null) => void) | null = null;
  #xform: Transforming | null = null;
  #region: RegionSelect | null = null;
  /** Free-transform frame of the selection, kept while the selection is unchanged. */
  #frame: (FrameState & { key: string }) | null = null;
  /** Renderer hook: items being transformed are drawn as sprites instead of cached tiles. */
  onTransientChange: ((ids: ReadonlySet<string> | null) => void) | null = null;
  /** Symmetry centre and rulers of the viewed scene (this user only). */
  guides: SceneGuides = emptyGuides();
  /** Ruler handles are editable. */
  rulerEdit = false;
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
    this.media = new MediaController(this);
    this.media.onChange = () => this.changed();
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
    this.#cancelColorPick();
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

  mediaView(bounds: Bounds): void {
    this.media.view(bounds);
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
    this.guides = settings.loadGuides(scene.id);
    this.#level = viewedLevel();
    this.rebuildSpaces();
    this.syncStored();
    if (stash) {
      const now = this.now();
      for (const item of stash.items) if (!this.store.has(item.id) && now < goneAt(item)) this.store.put(item, "temp");
    }
    this.net.send({ t: "q" });
    this.media.attach(scene);
    this.#housekeeping = setInterval(() => this.#housekeep(), 500);
    this.changed();
  }

  detach(): void {
    if (this.scene) {
      const items = [...this.store.values()].filter((e) => e.state === "temp").map((e) => e.item);
      this.#stash = { scene: this.scene.id, items };
    }
    this.cancelGesture();
    this.media.detach();
    this.setEditingText(null);
    this.selection.clear();
    this.#frame = null;
    this.guides = emptyGuides();
    this.rulerEdit = false;
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
    this.media.onSceneUpdate(scene, changes);
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
    this.media.onUserGone(userId);
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
    const brush = kind === "stroke" ? BRUSHES[tool as BrushId] : undefined;
    if (
      p.halo &&
      kind !== "laser" &&
      kind !== "area" &&
      tool !== "highlighter" &&
      tool !== "soft" &&
      tool !== "airbrush" &&
      tool !== "watercolor" &&
      tool !== "neon"
    )
      style.halo = true;
    if (p.dash && (kind === "shape" || kind === "area" || tool === "fineliner")) style.dash = true;
    if (p.fill && kind === "shape" && (tool === "rect" || tool === "ellipse" || tool === "polygon")) style.fill = 0.22;
    if (kind === "area") style.fill = 0.28;
    if ((kind === "shape" || kind === "area") && p.fillPattern !== "solid") style.fillPattern = p.fillPattern;
    if ((kind === "shape" || kind === "area") && p.roughness > 0.01) {
      style.brush = { ...(style.brush ?? {}), rgh: Math.round(p.roughness * 100) / 100 };
    }
    if (brush) {
      const blend = brushBlend(p, brush.id);
      if (blend !== brush.blend) style.blend = blend;
      const ov = diffBrushOverride(brush, p.brushParams[brush.id]);
      if (ov) style.brush = ov;
    }
    const layer: MapLayer = kind === "laser" ? "top" : permanent ? p.layer.permanent : p.layer.temporary;
    const opacity = brush ? brushOpacity(p, brush.id) : 1;
    const item: ScribbleItem = {
      schemaVersion: SCHEMA_VERSION,
      id: randomId(16),
      author: game.user.id,
      scene: this.scene?.id ?? "",
      mode: target.mode,
      kind,
      tool,
      color: this.color(),
      opacity,
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
    this.commitBatch([raw]);
  }

  /** Commit one or more items (e.g. symmetry strokes) as a single Undo step. */
  commitBatch(rawItems: ScribbleItem[]): void {
    if (!this.scene || !rawItems.length) return;
    const now = this.now();
    const committed: ScribbleItem[] = [];
    for (const raw of rawItems) {
      let item: ScribbleItem;
      if (raw.kind === "laser") item = { ...raw, points: quantizePoints(raw.points, "time") };
      else {
        const life = raw.expiresAt === null ? null : raw.expiresAt - raw.createdAt;
        item = {
          ...raw,
          points: quantizePoints(raw.points, zKindOf(raw.kind)),
          ...(raw.angles?.length ? { angles: quantizeAngles(raw.angles) } : {}),
          ...(raw.tilt?.length ? { tilt: quantizeUnits(raw.tilt) } : {}),
          ...(raw.speed?.length ? { speed: quantizeUnits(raw.speed) } : {}),
          createdAt: now,
          expiresAt: life === null ? null : now + life,
        };
      }
      if (item.expiresAt === null) {
        if (!this.#persist(item, true)) continue;
      } else {
        this.store.put(item, "temp");
        this.#live.end(item, false);
      }
      if (item.kind !== "laser") committed.push(item);
    }
    if (committed.length) this.history.record({ type: "create", items: committed });
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
    const onSent = () => {
      if (this.scene?.id === scene.id && this.store.get(item.id)?.state === "pending") this.#armPending(item.id, true);
    };
    const accepted = fromLive
      ? this.#live.end(item, true, onSent)
      : this.net.send({ t: "e", item: toWire(item), persist: true }, scene.id, onSent);
    if (!accepted) {
      this.store.remove(item.id);
      this.notify("warn", "Notify.SaveRefused");
    }
    return accepted;
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
        const tool =
          p.tool === "eraser" ||
          p.tool === "text" ||
          p.tool === "laser" ||
          (p.tool === "paint" && this.hold === "screen")
            ? "draw"
            : p.tool;
        return { tool, mode: this.hold };
      }
      case "laser":
        return { tool: "laser", mode: this.#map ? "map" : "screen" };
      case "eraser":
        return { tool: "eraser", mode: p.mode };
      default:
        // Wet media only exists on the map.
        return { tool: p.tool, mode: p.tool === "paint" && this.#map ? "map" : p.mode };
    }
  }

  #target(mode: Mode, s: ClientSample): Target | null {
    if (!this.scene) return null;
    const symMode = this.prefs.symmetry;
    const angle = this.prefs.symmetryAngle;
    if (mode === "map") {
      if (!this.#map) return null;
      const snapStep = this.prefs.gridSnap ? (this.#map.frame.gridSize / this.#map.sx) * 0.5 : 0;
      let symmetry: Target["symmetry"];
      if (symMode !== "none") {
        const c = this.symmetryCenterFor("map");
        symmetry = { mode: symMode, cx: c.x, cy: c.y, angle };
      }
      return { mode, space: this.#map, snapStep, symmetry };
    }
    const anchor: [number, number] = symMode !== "none" ? [0, 0] : this.#screen.anchorFor(s.cx, s.cy);
    let symmetry: Target["symmetry"];
    if (symMode !== "none") {
      const c = this.symmetryCenterFor("screen");
      symmetry = { mode: symMode, cx: c.x, cy: c.y, angle };
    }
    return { mode, space: this.#screen, anchor, symmetry };
  }

  /* -------------------------------------------- */
  /*  Drawing guides: symmetry centre, rulers     */
  /* -------------------------------------------- */

  /** Symmetry centre in the mode's reference space (map units / screen units around the centre). */
  symmetryCenterFor(mode: Mode): Pt {
    const stored = this.guides.symmetry[mode];
    if (stored) return stored;
    if (mode === "screen" || !this.#map) return { x: 0, y: 0 };
    const vp = this.#screen.viewport;
    return this.#map.fromClient(vp.left + vp.width / 2, vp.top + vp.height / 2);
  }

  /** Move (or reset with null) the symmetry centre of a mode. */
  setSymmetryCenter(mode: Mode, p: Pt | null): void {
    const symmetry = { ...this.guides.symmetry };
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) symmetry[mode] = { x: p.x, y: p.y };
    else delete symmetry[mode];
    this.guides = { ...this.guides, symmetry };
    this.#saveGuides();
    this.changed();
  }

  #saveGuides(): void {
    if (this.scene) settings.saveGuides(this.scene.id, this.guides);
  }

  /** Client point → a mode's reference space. */
  toRefSpace(mode: Mode, cx: number, cy: number): Pt | null {
    const space = this.space(mode);
    if (!space) return null;
    return mode === "screen" ? space.fromClient(cx, cy, [0, 0]) : space.fromClient(cx, cy);
  }

  /** Reference-space point → client. */
  fromRefSpace(mode: Mode, p: Pt): Pt | null {
    const space = this.space(mode);
    if (!space) return null;
    return mode === "screen" ? space.toClient(p.x, p.y, [0, 0]) : space.toClient(p.x, p.y);
  }

  /** Rulers of a mode (all, or only the snapping ones). */
  rulersFor(mode: Mode, onlyOn = false): Ruler[] {
    return this.guides.rulers.filter((r) => r.mode === mode && (!onlyOn || r.on));
  }

  setRulerEdit(on: boolean): void {
    this.rulerEdit = on;
    this.changed();
  }

  /** Add a ruler around the viewport centre of the current mode; returns its id. */
  addRuler(preset: RulerPreset): string | null {
    if (this.guides.rulers.length >= GUIDE_LIMITS.rulers) {
      this.notify("warn", "Notify.TooManyRulers");
      return null;
    }
    const mode: Mode = this.prefs.mode === "map" && this.#map ? "map" : "screen";
    const vp = this.#screen.viewport;
    const c = this.toRefSpace(mode, vp.left + vp.width / 2, vp.top + vp.height / 2);
    const space = this.space(mode);
    if (!c || !space) return null;
    const u = 1 / space.cssPerUnit();
    const w = vp.width * u;
    const hh = vp.height * u;
    const at = (fx: number, fy: number): Pt => ({ x: c.x + fx * w, y: c.y + fy * hh });
    const id = randomId(12);
    let ruler: Ruler;
    if (preset === "curve") {
      ruler = {
        id,
        kind: "curve",
        mode,
        on: true,
        pts: [at(-0.3, 0.12), at(-0.1, -0.08), at(0.1, -0.08), at(0.3, 0.12)],
        closed: false,
        parallel: false,
      };
    } else {
      const vps =
        preset === "perspective1"
          ? [at(0, -0.05)]
          : preset === "perspective2"
            ? [at(-0.38, -0.05), at(0.38, -0.05)]
            : [at(-0.38, -0.12), at(0.38, -0.12), at(0, 0.9)];
      ruler = { id, kind: "perspective", mode, on: true, vps, parallels: true };
    }
    this.guides = { ...this.guides, rulers: [...this.guides.rulers, ruler] };
    this.#saveGuides();
    this.changed();
    return id;
  }

  /** Replace a ruler's fields (validated). */
  updateRuler(id: string, patch: Partial<Ruler>, save = true): boolean {
    const i = this.guides.rulers.findIndex((r) => r.id === id);
    if (i < 0) return false;
    const next = normalizeRuler({ ...this.guides.rulers[i], ...patch, id, kind: this.guides.rulers[i]!.kind });
    if (!next) return false;
    const rulers = this.guides.rulers.slice();
    rulers[i] = next;
    this.guides = { ...this.guides, rulers };
    if (save) this.#saveGuides();
    this.changed();
    return true;
  }

  removeRuler(id: string): void {
    this.guides = { ...this.guides, rulers: this.guides.rulers.filter((r) => r.id !== id) };
    this.#saveGuides();
    this.changed();
  }

  /** Move a ruler's point (vanishing point or curve control point). */
  moveRulerPoint(id: string, index: number, p: Pt, save = false): void {
    const r = this.guides.rulers.find((x) => x.id === id);
    if (!r) return;
    if (r.kind === "perspective") {
      if (!r.vps[index]) return;
      const vps = r.vps.slice();
      vps[index] = p;
      this.updateRuler(id, { vps }, save);
    } else {
      if (!r.pts[index]) return;
      const pts = r.pts.slice();
      pts[index] = p;
      this.updateRuler(id, { pts }, save);
    }
  }

  /** Insert a curve control point after `index`. */
  insertRulerPoint(id: string, index: number, p: Pt): void {
    const r = this.guides.rulers.find((x) => x.id === id);
    if (r?.kind !== "curve" || r.pts.length >= GUIDE_LIMITS.curvePoints) return;
    const pts = r.pts.slice();
    pts.splice(index + 1, 0, p);
    this.updateRuler(id, { pts });
  }

  /** Remove a curve control point (curves keep at least two). */
  removeRulerPoint(id: string, index: number): void {
    const r = this.guides.rulers.find((x) => x.id === id);
    if (r?.kind !== "curve" || r.pts.length <= 2) return;
    this.updateRuler(id, { pts: r.pts.filter((_, i) => i !== index) });
  }

  /** Ruler constraint for a stroke starting at `s` (Alt at pointer down draws freely). */
  #constraintFor(target: Target, s: ClientSample, mods: Modifiers, lineOnly = false): StrokeConstraint | null {
    if (!this.prefs.rulers || mods.alt) return null;
    const rulers = this.rulersFor(target.mode, true);
    if (!rulers.length) return null;
    let dx = 0;
    let dy = 0;
    if (target.mode === "screen" && target.anchor && (target.anchor[0] || target.anchor[1])) {
      // Rulers live around the viewport centre; express them in the stroke's anchor space.
      const origin = target.space.toClient(0, 0, [0, 0]);
      const o = target.space.fromClient(origin.x, origin.y, target.anchor);
      dx = o.x;
      dy = o.y;
    }
    const start = toSpace(target, s, lineOnly && !!target.snapStep);
    return buildConstraint(offsetRulers(rulers, dx, dy), start, 1 / target.space.cssPerUnit(), lineOnly);
  }

  /** Primary button down. Returns false when nothing was started (the event is not consumed). */
  pointerDown(s: ClientSample, mods: Modifiers): boolean {
    if (this.#gesture?.down) {
      this.#gesture.down(s, mods);
      return true;
    }
    this.cancelGesture();
    const { tool, mode } = this.effective();
    if (tool === "eyedropper") {
      void this.#pickColor(s.cx, s.cy);
      return true;
    }
    if (tool === "select") {
      return this.#selectDown(s, mods);
    }
    if (this.selection.size) {
      this.selection.clear();
      this.changed();
    }
    if (tool === "paint") return this.#paintDown(s);
    const action: Action = mode === "map" ? "map" : "screen";
    if (!this.can(action)) {
      this.notify("warn", mode === "map" ? "Notify.NoMapPermission" : "Notify.NoScreenPermission");
      return false;
    }
    const target = this.#target(mode, s);
    if (!target) return false;
    const p = this.prefs;
    const ruler = (lineOnly = false) => this.#constraintFor(target, s, mods, lineOnly);
    switch (tool) {
      case "draw":
        this.#gesture = new FreehandGesture(
          this,
          target,
          { kind: "stroke", tool: p.brush, size: p.sizes[p.brush], constraint: ruler() },
          s,
        );
        break;
      case "highlight":
        this.#gesture =
          p.highlight === "area"
            ? new FreehandGesture(this, target, { kind: "area", tool: "area", size: p.sizes.area }, s)
            : new FreehandGesture(
                this,
                target,
                { kind: "stroke", tool: "highlighter", size: p.sizes.highlighter, constraint: ruler() },
                s,
              );
        break;
      case "arrow":
        this.#gesture =
          p.arrow === "path"
            ? new FreehandGesture(
                this,
                target,
                {
                  kind: "stroke",
                  tool: "fineliner",
                  size: p.sizes.arrow,
                  extra: { style: { head: p.head } },
                  constraint: ruler(),
                },
                s,
              )
            : new ShapeGesture(this, target, "arrow", p.sizes.arrow, s, { style: { head: p.head } }, ruler(true));
        break;
      case "shape":
        this.#gesture =
          p.shape === "polygon"
            ? new PolygonGesture(this, target, p.sizes.shape, s)
            : new ShapeGesture(
                this,
                target,
                p.shape,
                p.sizes.shape,
                s,
                undefined,
                p.shape === "line" ? ruler(true) : null,
              );
        break;
      case "laser":
        this.#gesture = new LaserGesture(this, target, p.sizes.laser, s);
        break;
      case "text": {
        const hit = this.#selectHit(s);
        if (hit?.item.kind === "text") return this.editText(hit.item.id);
        const size = target.space.widthFor(p.sizes.text);
        const point = target.space.fromClient(s.cx, s.cy, target.anchor);
        this.onTextRequest?.({ target, cx: s.cx, cy: s.cy, size, color: this.color(), point, scene: this.scene!.id });
        return true;
      }
      case "eraser":
        this.#startEraser(target, s);
        return true;
    }
    return !!this.#gesture;
  }

  #paintDown(s: ClientSample): boolean {
    if (!this.can("media")) {
      this.notify("warn", "Notify.NoMediaPermission");
      return false;
    }
    const target = this.#target("map", s);
    if (!target) return false;
    const p = this.prefs;
    const brush = MEDIA_BRUSHES[p.mediaBrush];
    const loads = resolveMediaParams(brush, p.mediaParams[p.mediaBrush]);
    const size = Math.min(MAX_MEDIA_SIZE, target.space.widthFor(p.mediaSizes[p.mediaBrush]));
    const gesture = new MediaGesture(
      this.media,
      { ...target, symmetry: undefined, snapStep: 0 },
      { brush: brush.id, color: this.color(), size, pigment: loads.pigment, water: loads.water },
      s,
      this.pressureMode(),
    );
    if (!gesture.active) return false;
    this.#gesture = gesture;
    return true;
  }

  pointerMove(samples: ClientSample[], mods: Modifiers): void {
    if (this.#xform) {
      const last = samples.at(-1);
      if (last) this.#xformMove(last, mods);
      return;
    }
    if (this.#region) {
      for (const sample of samples) this.#regionAdd(sample);
      this.changed();
      return;
    }
    if (this.#eraser) this.#eraser.gesture.move(samples);
    else this.#gesture?.move(samples, mods);
  }

  /** Pointer moves without a button (polygon rubber band). */
  pointerHover(s: ClientSample, mods: Modifiers): void {
    this.#gesture?.hover?.(s, mods);
  }

  pointerUp(s: ClientSample, mods: Modifiers): void {
    if (this.#xform) {
      this.#xformUp(s, mods);
      return;
    }
    if (this.#region) {
      this.#regionUp(s);
      return;
    }
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

  async #pickColor(cx: number, cy: number): Promise<void> {
    const request = new AbortController();
    this.#colorPick = request;
    const scene = this.scene;
    let picked: string | null = null;
    try {
      picked = await sampleColorAt(cx, cy, request.signal);
    } catch (error) {
      this.log("Colour sampling failed", error);
    }
    if (this.#colorPick !== request) return;
    this.#colorPick = null;
    if (request.signal.aborted || !scene || this.scene !== scene || this.effective().tool !== "eyedropper") return;
    if (!picked) {
      this.notify("warn", "Notify.ColorPickFailed");
      return;
    }
    this.setPrefs({ color: picked, recent: pushRecent(this.prefs, picked), tool: "draw" });
    this.notify("info", "Notify.ColorPicked", { color: picked });
  }

  #cancelColorPick(): boolean {
    const request = this.#colorPick;
    if (!request) return false;
    this.#colorPick = null;
    request.abort();
    return true;
  }

  cancelGesture(): boolean {
    let did = this.#cancelColorPick();
    if (this.#xform) {
      const x = this.#xform;
      this.#xform = null;
      if (x.moved) for (const o of x.originals) if (this.store.has(o.item.id)) this.store.put(o.item, o.state);
      this.onTransientChange?.(null);
      this.changed();
      did = true;
    }
    if (this.#region) {
      this.#region = null;
      this.changed();
      did = true;
    }
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

  /* -------------------------------------------- */
  /*  Select & Transform                          */
  /* -------------------------------------------- */

  /** The selected id when exactly one item is selected. */
  get selectedId(): string | null {
    return this.selection.size === 1 ? (this.selection.values().next().value ?? null) : null;
  }

  set selectedId(id: string | null) {
    this.selection.clear();
    if (id) this.selection.add(id);
  }

  /** Selected entries that still exist and are shown (vanished ids are dropped). */
  selectedEntries(): Entry[] {
    const out: Entry[] = [];
    for (const id of [...this.selection]) {
      const entry = this.store.get(id);
      if (!entry || entry.item.kind === "laser" || !this.shows(entry.item)) {
        this.selection.delete(id);
        continue;
      }
      out.push(entry);
    }
    return out;
  }

  selectedEntry(): Entry | null {
    const list = this.selectedEntries();
    return list.length === 1 ? list[0]! : null;
  }

  /** Mode of the selected items (a selection never mixes modes). */
  selectionMode(): Mode | null {
    return this.selectedEntries()[0]?.item.mode ?? null;
  }

  clearSelection(): boolean {
    if (!this.selection.size) return false;
    this.selection.clear();
    this.#frame = null;
    this.changed();
    return true;
  }

  /** Escape: cancel the current gesture, else drop the selection. */
  dismiss(): boolean {
    return this.cancelGesture() || this.clearSelection();
  }

  /** Select every item of the current mode the user may modify. */
  selectAll(): number {
    const mode = this.effective().mode;
    this.selection.clear();
    for (const entry of this.store.values()) {
      if (entry.item.mode === mode && entry.item.kind !== "laser" && this.#modifiable(entry))
        this.selection.add(entry.item.id);
    }
    this.#frame = null;
    this.changed();
    return this.selection.size;
  }

  /** Item space → the mode's reference space (identity on the map). */
  #toRef(item: ScribbleItem): Mat3 {
    if (item.mode === "map") return IDENTITY;
    const a = item.anchor ?? [0, 0];
    const space = this.space("screen");
    if (!space || (!a[0] && !a[1])) return IDENTITY;
    return affineOf((x, y) => {
      const c = space.toClient(x, y, a);
      return space.fromClient(c.x, c.y, [0, 0]);
    });
  }

  #selectionKey(entries: readonly Entry[]): string {
    return entries
      .map((e) => `${e.item.id}:${e.item.revision}`)
      .sort()
      .join(",");
  }

  #textFrame(item: ScribbleItem): FrameState {
    const l = layoutText(item);
    const m = this.#toRef(item);
    const x = item.points[0]! + m[2];
    const y = item.points[1]! + m[5];
    return {
      quad: [
        { x, y },
        { x: x + l.width, y },
        { x: x + l.width, y: y + l.height },
        { x, y: y + l.height },
      ],
      pivot: { x: x + l.width / 2, y: y + l.height / 2 },
    };
  }

  /**
   * Free-transform frame of the selection in reference space (nw, ne, se, sw
   * and the pivot). A rotated or distorted frame is kept while the selection
   * stays as this client left it; otherwise it is the bounding box again.
   */
  selectionFrame(): (FrameState & { mode: Mode; entries: Entry[] }) | null {
    const x = this.#xform;
    if (x) return { mode: x.mode, entries: x.originals, ...x.now };
    const entries = this.selectedEntries();
    if (!entries.length) return null;
    const mode = entries[0]!.item.mode;
    const key = this.#selectionKey(entries);
    if (this.#frame?.key !== key) {
      let b: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
      for (const e of entries) {
        let box = e.bounds;
        if (e.item.kind === "text") {
          const l = layoutText(e.item);
          const [tx, ty] = [e.item.points[0]!, e.item.points[1]!];
          box = [tx, ty, tx + l.width, ty + l.height];
        }
        const m = this.#toRef(e.item);
        for (const [cx, cy] of [
          [box[0], box[1]],
          [box[2], box[3]],
        ] as const) {
          const px = m[0] * cx + m[1] * cy + m[2];
          const py = m[3] * cx + m[4] * cy + m[5];
          b = [Math.min(b[0], px), Math.min(b[1], py), Math.max(b[2], px), Math.max(b[3], py)];
        }
      }
      const pad = 1e-3;
      if (b[2] - b[0] < pad) b = [b[0] - pad, b[1], b[2] + pad, b[3]];
      if (b[3] - b[1] < pad) b = [b[0], b[1] - pad, b[2], b[3] + pad];
      this.#frame = {
        key,
        quad: [
          { x: b[0], y: b[1] },
          { x: b[2], y: b[1] },
          { x: b[2], y: b[3] },
          { x: b[0], y: b[3] },
        ],
        pivot: { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 },
      };
    }
    return { mode, entries, quad: this.#frame.quad, pivot: this.#frame.pivot };
  }

  /** The region being dragged (client px pairs), for the overlay. */
  selectionRegion(): { shape: "rect" | "lasso"; pts: readonly number[] } | null {
    return this.#region ? { shape: this.#region.shape, pts: this.#region.pts } : null;
  }

  /** Is a transform drag in progress? */
  get transforming(): boolean {
    return !!this.#xform;
  }

  /** Start a transform drag from a frame handle (called by the guides overlay). */
  startTransformHandle(
    handle: TransformHandle,
    cx: number,
    cy: number,
    mods: Modifiers = { shift: false, alt: false },
  ): boolean {
    void mods;
    const entries = this.selectedEntries();
    if (!entries.length) return false;
    if (handle !== "pivot" && !entries.every((e) => this.#modifiable(e))) return false;
    if (handle === "rotate" && entries.every((e) => e.item.kind === "text")) return false;
    const frame = this.selectionFrame();
    if (!frame) return false;
    if (handle === "width-left" || handle === "width-right") {
      const entry = entries.length === 1 ? entries[0]! : null;
      if (entry?.item.kind !== "text") return false;
      const space = this.space(entry.item.mode);
      if (!space) return false;
      const target: Target = { mode: entry.item.mode, space, anchor: entry.item.anchor };
      this.#xform = {
        handle,
        mode: frame.mode,
        originals: entries,
        start: frame,
        now: frame,
        origin: space.fromClient(cx, cy, entry.item.anchor),
        moved: false,
        lastApply: 0,
        target,
      };
      return true;
    }
    const origin = this.toRefSpace(frame.mode, cx, cy);
    if (!origin) return false;
    const state: FrameState = { quad: frame.quad, pivot: frame.pivot };
    this.#xform = {
      handle,
      mode: frame.mode,
      originals: entries,
      start: state,
      now: state,
      origin,
      moved: false,
      lastApply: 0,
    };
    return true;
  }

  #modifiable(entry: Entry): boolean {
    return (
      entry.state !== "live" &&
      entry.state !== "pending" &&
      this.shows(entry.item) &&
      (this.can(entry.item.mode) || this.can("manage")) &&
      (entry.item.expiresAt === null || this.now() < goneAt(entry.item)) &&
      mayModify(game.user.id, game.user.role, entry.item.author, settings.thresholds())
    );
  }

  #selectHit(s: ClientSample): Entry | null {
    const list = this.store.ordered();
    let hit: Entry | null = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]!;
      const it = e.item;
      if (it.kind === "laser" || !this.#modifiable(e)) continue;
      const space = this.space(it.mode);
      if (!space) continue;
      const p = space.fromClient(s.cx, s.cy, it.anchor);
      const r = Math.max(6 / space.cssPerUnit(), 2);
      if (hitItem(e, p.x, p.y, r)) {
        hit = e;
        break;
      }
    }
    return hit;
  }

  /**
   * Select tool pointer down: on an item, select it (Shift toggles, Ctrl
   * removes) and start moving the selection; on empty space, start a
   * marquee or lasso region.
   */
  #selectDown(s: ClientSample, mods: Modifiers): boolean {
    const hit = this.#selectHit(s);
    const add = mods.shift;
    const sub = !!mods.ctrl;
    if (hit) {
      const id = hit.item.id;
      const mode = this.selectionMode();
      if (mode && mode !== hit.item.mode) this.selection.clear();
      if (sub || (add && this.selection.has(id))) {
        this.selection.delete(id);
        this.changed();
        return true;
      }
      if (add) this.selection.add(id);
      else if (!this.selection.has(id)) this.selectedId = id;
      this.changed();
      this.startTransformHandle("move", s.cx, s.cy, mods);
      return true;
    }
    const mode = this.effective().mode;
    if (!add && !sub) this.clearSelection();
    this.#region = {
      shape: this.prefs.selectShape,
      op: add ? "add" : sub ? "subtract" : "replace",
      mode,
      pts: [s.cx, s.cy],
    };
    this.changed();
    return true;
  }

  #regionAdd(s: ClientSample): void {
    const r = this.#region;
    if (!r) return;
    if (r.shape === "rect") {
      r.pts = [r.pts[0]!, r.pts[1]!, s.cx, s.cy];
      return;
    }
    const n = r.pts.length;
    if (n >= 4000) return;
    if (Math.hypot(s.cx - r.pts[n - 2]!, s.cy - r.pts[n - 1]!) >= 3) r.pts.push(s.cx, s.cy);
  }

  #regionUp(s: ClientSample): void {
    this.#regionAdd(s);
    const r = this.#region!;
    this.#region = null;
    const pts = r.pts;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]!);
      maxX = Math.max(maxX, pts[i]!);
      minY = Math.min(minY, pts[i + 1]!);
      maxY = Math.max(maxY, pts[i + 1]!);
    }
    if (maxX - minX < 3 && maxY - minY < 3) {
      // A click on empty space.
      this.changed();
      return;
    }
    const client = r.shape === "rect" ? [minX, minY, maxX, minY, maxX, maxY, minX, maxY] : pts.length >= 6 ? pts : [];
    if (!client.length) {
      this.changed();
      return;
    }
    const match = this.prefs.selectMatch;
    const regions = new Map<string, { poly: number[]; bounds: Bounds }>();
    const regionFor = (item: ScribbleItem) => {
      const key = item.mode === "screen" ? String(item.anchor ?? [0, 0]) : "map";
      let reg = regions.get(key);
      if (!reg) {
        const space = this.space(item.mode)!;
        const poly: number[] = [];
        for (let i = 0; i + 1 < client.length; i += 2) {
          const p = space.fromClient(client[i]!, client[i + 1]!, item.anchor);
          poly.push(p.x, p.y, 0.5);
        }
        reg = { poly, bounds: boundsOf(poly) };
        regions.set(key, reg);
      }
      return reg;
    };
    const mode = this.selectionMode();
    if (r.op === "add" && mode && mode !== r.mode) this.selection.clear();
    for (const entry of this.store.values()) {
      const item = entry.item;
      if (item.mode !== r.mode || item.kind === "laser" || !this.space(item.mode) || !this.#modifiable(entry)) continue;
      const reg = regionFor(item);
      if (!regionHit(entry, reg.poly, match, reg.bounds)) continue;
      if (r.op === "subtract") this.selection.delete(item.id);
      else this.selection.add(item.id);
    }
    this.#frame = null;
    this.changed();
  }

  #xformMove(s: ClientSample, mods: Modifiers, final = false): void {
    const x = this.#xform;
    if (!x) return;
    if (x.handle === "width-left" || x.handle === "width-right") {
      const target = x.target!;
      const original = x.originals[0]!.item;
      const p = target.space.fromClient(s.cx, s.cy, target.anchor);
      const dx = p.x - x.origin.x;
      if (!x.moved && Math.abs(dx) < 1.5 / target.space.cssPerUnit()) return;
      const oldWidth = layoutText(original).width;
      const max = original.mode === "screen" ? 4000 : 100_000;
      const width = Math.max(1, Math.min(max, oldWidth + (x.handle === "width-left" ? -dx : dx)));
      const unchanged = dx === 0 || width === oldWidth;
      if (unchanged && !x.moved) return;
      if (!x.moved) {
        x.moved = true;
        this.onTransientChange?.(new Set([original.id]));
      }
      const next = unchanged
        ? original
        : {
            ...(x.handle === "width-left" ? translateItem(original, oldWidth - width, 0) : original),
            textWidth: width,
            revision: original.revision + 1,
          };
      x.now = unchanged ? x.start : this.#textFrame(next);
      if (this.store.has(original.id)) this.store.put(next, x.originals[0]!.state);
      this.changed();
      return;
    }
    const p = this.toRefSpace(x.mode, s.cx, s.cy);
    if (!p) return;
    if (x.handle === "pivot") {
      x.now = { quad: x.start.quad, pivot: p };
      x.moved = true;
      this.changed();
      return;
    }
    const space = this.space(x.mode)!;
    if (!x.moved && Math.hypot(p.x - x.origin.x, p.y - x.origin.y) < 1.5 / space.cssPerUnit()) return;
    const result = frameTransform({ ...x.start, handle: x.handle, origin: x.origin }, p, mods);
    if (!result) return;
    const changed = changesItems(result.m);
    if (!changed && !x.moved) return;
    if (!x.moved) {
      x.moved = true;
      this.onTransientChange?.(new Set(x.originals.map((o) => o.item.id)));
    }
    x.now = changed ? { quad: result.quad, pivot: result.pivot } : x.start;
    const now = performance.now();
    if (!final && now - x.lastApply < TRANSFORM_FRAME_MS) return;
    x.lastApply = now;
    this.#previewTransform(x.originals, result.m, changed);
    this.changed();
  }

  /** Show the selection transformed by `m` (reference space) without sending anything. */
  #previewTransform(originals: readonly Entry[], m: Mat3, changed = true): void {
    for (const o of originals) {
      if (!this.store.has(o.item.id)) continue;
      const item = changed ? transformItem(o.item, conjugate(m, this.#toRef(o.item))) : o.item;
      this.store.put(item, o.state);
    }
  }

  #xformUp(s: ClientSample, mods: Modifiers): void {
    const x = this.#xform;
    if (!x) return;
    this.#xformMove(s, mods, true);
    this.#xform = null;
    if (!x.moved) {
      this.changed();
      return;
    }
    if (x.handle === "pivot") {
      if (this.#frame) this.#frame = { ...this.#frame, pivot: x.now.pivot };
      this.changed();
      return;
    }
    this.#commitTransform(x.originals, x.now);
    this.onTransientChange?.(null);
  }

  /**
   * Send the previewed (already stored locally) transform of `originals`:
   * items that may no longer be modified or would leave the scene's extent
   * are restored; the rest become one undoable update.
   */
  #commitTransform(originals: readonly Entry[], frame: FrameState): void {
    const scene = this.scene;
    if (!scene) return;
    const before: ScribbleItem[] = [];
    const after: ScribbleItem[] = [];
    let rejected = false;
    for (const o of originals) {
      const cur = this.store.get(o.item.id);
      if (!cur || cur.item === o.item) continue;
      const candidate = cur.item;
      const ctx = this.#ctx(scene, o.item.author, o.item.expiresAt === null);
      const item =
        this.#modifiable(cur) &&
        inExtent(candidate.points, candidate.mode, ctx) &&
        (candidate.erase ?? []).every((mask) => inExtent(mask.points, candidate.mode, ctx))
          ? sanitizeItem(toWire(candidate), { ...ctx, allowExpired: true })
          : null;
      if (!item) {
        this.store.put(o.item, cur.state);
        rejected = true;
        continue;
      }
      before.push(o.item);
      after.push(item);
    }
    const refused = after.length ? this.#replaceItemsDetailed(after) : new Set<string>();
    if (refused.size) {
      for (const o of originals)
        if (refused.has(o.item.id)) this.store.put(o.item, this.store.get(o.item.id)?.state ?? o.state);
    }
    const kept = after.filter((i) => !refused.has(i.id));
    if (kept.length)
      this.history.record({ type: "update", before: before.filter((i) => !refused.has(i.id)), after: kept });
    if (rejected || refused.size) this.notify("warn", "Notify.TransformPartial");
    const entries = this.selectedEntries();
    this.#frame =
      entries.length && !rejected && !refused.size
        ? { key: this.#selectionKey(entries), quad: frame.quad, pivot: frame.pivot }
        : null;
    this.changed();
  }

  /** Apply a reference-space transform to the whole selection at once (flip, rotate, scale buttons). */
  transformSelection(m: Mat3): boolean {
    if (this.#xform || !changesItems(m)) return false;
    const frame = this.selectionFrame();
    if (!frame || !frame.entries.every((e) => this.#modifiable(e))) return false;
    this.#previewTransform(frame.entries, m);
    this.#commitTransform(frame.entries, transformFrame(frame, m));
    return true;
  }

  flipSelection(axis: "h" | "v"): boolean {
    const f = this.selectionFrame();
    return !!f && this.transformSelection(flipAbout(axis, f.quad, f.pivot));
  }

  rotateSelection(deg: number): boolean {
    const f = this.selectionFrame();
    return !!f && Number.isFinite(deg) && deg !== 0 && this.transformSelection(rotateAbout(deg, f.pivot));
  }

  scaleSelection(factor: number): boolean {
    const f = this.selectionFrame();
    if (!f || !Number.isFinite(factor) || factor <= 0 || factor === 1) return false;
    return this.transformSelection(scaleAbout(Math.max(0.05, Math.min(20, factor)), f.pivot));
  }

  deleteSelected(): boolean {
    const entries = this.selectedEntries().filter((e) => this.#modifiable(e));
    if (!entries.length) return false;
    const items = entries.map((e) => e.item);
    this.selection.clear();
    this.#frame = null;
    this.#removeItems(items);
    this.history.record({ type: "delete", items });
    this.changed();
    return true;
  }

  duplicateSelected(): boolean {
    const entries = this.selectedEntries().filter((e) => this.#modifiable(e));
    if (!entries.length) return false;
    const now = this.now();
    const copies = entries.map((entry) => {
      const space = this.space(entry.item.mode);
      const offset = space ? 18 / space.cssPerUnit() : 20;
      return {
        ...translateItem(entry.item, offset, offset),
        id: randomId(16),
        author: game.user.id,
        createdAt: now,
        revision: 0,
      };
    });
    this.commitBatch(copies);
    this.selection.clear();
    for (const copy of copies) if (this.store.has(copy.id)) this.selection.add(copy.id);
    this.#frame = null;
    this.changed();
    return true;
  }

  recolorSelected(color: string): boolean {
    const entries = this.selectedEntries().filter((e) => e.item.color !== color && this.#modifiable(e));
    if (!entries.length) return false;
    const before = entries.map((e) => e.item);
    const after = before.map((item) => ({ ...item, color, revision: item.revision + 1 }));
    const refused = this.#replaceItemsDetailed(after);
    const kept = after.filter((i) => !refused.has(i.id));
    if (kept.length)
      this.history.record({ type: "update", before: before.filter((i) => !refused.has(i.id)), after: kept });
    this.changed();
    return kept.length > 0;
  }

  /** Commit a text item from the text editor. */
  commitText(req: TextRequest, text: string, textWidth?: number): boolean {
    if (this.scene?.id !== req.scene) return false;
    const clean = cleanText(text);
    const width =
      typeof textWidth === "number" && Number.isFinite(textWidth)
        ? Math.max(1, Math.min(req.target.mode === "screen" ? 4000 : 100_000, textWidth))
        : undefined;
    if (req.original) {
      const entry = this.store.get(req.original.id);
      if (
        !entry ||
        !this.#modifiable(entry) ||
        entry.item.revision !== req.original.revision ||
        entry.item.text !== req.original.text ||
        entry.item.textWidth !== req.original.textWidth
      ) {
        this.notify("warn", "Text.Conflict");
        return false;
      }
      const before = entry.item;
      if (clean === before.text && width === before.textWidth) return true;
      if (before.expiresAt === null && !activeGM()) {
        this.notify("warn", "Notify.NoGM");
        return false;
      }
      if (!clean.trim()) {
        this.#removeItems([before]);
        this.history.record({ type: "delete", items: [before] });
        this.selectedId = null;
      } else {
        const after = { ...before, text: clean, revision: before.revision + 1 };
        if (width === undefined) delete after.textWidth;
        else after.textWidth = width;
        if (!this.#replaceItems([after])) return false;
        this.history.record({ type: "update", before: [before], after: [after] });
      }
      this.changed();
      return true;
    }
    if (!clean.trim()) return true;
    if (!this.can(req.target.mode)) {
      this.notify("warn", req.target.mode === "map" ? "Notify.NoMapPermission" : "Notify.NoScreenPermission");
      return false;
    }
    const p = req.point;
    const item = this.makeItem(req.target, "text", "text", req.size, [p.x, p.y, 0.5], { text: clean, style: {} });
    item.color = req.color;
    if (width !== undefined) item.textWidth = width;
    if (this.prefs.halo) item.style.halo = true;
    this.commit(item);
    if (!this.store.has(item.id)) return false;
    this.selectedId = item.id;
    this.changed();
    return true;
  }

  setEditingText(id: string | null): void {
    this.editingTextId = id;
    this.onTextEditingChange?.(id);
    this.changed();
  }

  editText(id: string | null = this.selectedId): boolean {
    if (!id) return false;
    const entry = this.store.get(id);
    if (!entry || entry.item.kind !== "text" || !this.#modifiable(entry)) return false;
    const item = entry.item;
    const space = this.space(item.mode);
    if (!space || !this.onTextRequest) return false;
    this.cancelGesture();
    this.selectedId = id;
    const point = { x: item.points[0]!, y: item.points[1]! };
    const pos = space.toClient(point.x, point.y, item.anchor);
    this.onTextRequest({
      target: { mode: item.mode, space, anchor: item.anchor },
      cx: pos.x,
      cy: pos.y,
      size: item.size,
      color: item.color,
      scene: item.scene,
      point,
      original: item,
    });
    return true;
  }

  editTextAt(s: ClientSample): boolean {
    const hit = this.#selectHit(s);
    return hit?.item.kind === "text" ? this.editText(hit.item.id) : false;
  }

  resetTextWidth(): boolean {
    const entry = this.selectedEntry();
    if (!entry || entry.item.kind !== "text" || !this.#modifiable(entry)) return false;
    return this.commitText(
      {
        target: { mode: entry.item.mode, space: this.space(entry.item.mode)!, anchor: entry.item.anchor },
        cx: 0,
        cy: 0,
        size: entry.item.size,
        color: entry.item.color,
        scene: entry.item.scene,
        point: { x: entry.item.points[0]!, y: entry.item.points[1]! },
        original: entry.item,
      },
      entry.item.text ?? "",
    );
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
      const mask: EraseMask = { size: r * 2, points: mpts };
      if (this.prefs.eraserTip === "rect") {
        mask.tip = "rect";
        mask.ang = this.prefs.eraserAngle;
        mask.asp = this.prefs.eraserAspect;
      }
      if (this.prefs.eraserHardness < 0.99) mask.hrd = this.prefs.eraserHardness;
      after.push({
        ...original.item,
        erase: [...masks, mask],
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

  /** Replace items everywhere (erase masks, transforms, undo/redo of an update). */
  #replaceItems(items: ScribbleItem[]): boolean {
    return this.scene ? this.#replaceItemsDetailed(items).size === 0 : false;
  }

  /** {@link #replaceItems}, returning the ids the GM's writer refused (budget). */
  #replaceItemsDetailed(items: ScribbleItem[]): Set<string> {
    const refused = new Set<string>();
    if (!this.scene) {
      for (const item of items) refused.add(item.id);
      return refused;
    }
    const outgoing: WireItem[] = [];
    for (const item of items) {
      const entry = this.store.get(item.id);
      if (item.expiresAt === null) {
        if (this.isRelay) {
          const refusal = this.writer.write(this.scene, item);
          if (refusal) {
            refused.add(item.id);
            this.notify("warn", "Notify.Budget");
            if (entry) this.store.put(entry.item, entry.state);
            continue;
          }
        } else outgoing.push(toWire(item));
        // Optimistic local display until the Scene update confirms it.
        this.store.put(item, "stored");
      } else {
        this.store.put(item, entry?.state === "live" ? "live" : "temp");
        outgoing.push(toWire(item));
      }
    }
    this.#sendUpdates(outgoing);
    return refused;
  }

  /** One `u` per item for small changes; `U` batches (bounded in count and size) for selections. */
  #sendUpdates(wires: WireItem[]): void {
    if (wires.length === 1) {
      this.net.send({ t: "u", item: wires[0]! });
      return;
    }
    let batch: WireItem[] = [];
    let chars = 0;
    const flush = () => {
      if (batch.length === 1) this.net.send({ t: "u", item: batch[0]! });
      else if (batch.length) this.net.send({ t: "U", items: batch });
      batch = [];
      chars = 0;
    };
    for (const wire of wires) {
      const size = JSON.stringify(wire).length;
      if (batch.length && (batch.length >= MAX_UPDATE_BATCH || chars + size > UPDATE_CHUNK_CHARS)) flush();
      batch.push(wire);
      chars += size;
    }
    flush();
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

  /** Undo goes to the paint while the paint tool is active (or when it is all there is to undo). */
  get #mediaUndo(): boolean {
    return this.media.canUndo && (this.prefs.tool === "paint" || !this.history.canUndo);
  }

  get canUndo(): boolean {
    return this.history.canUndo || this.media.canUndo;
  }

  undo(): Command | null {
    this.cancelGesture();
    if (this.#mediaUndo) {
      this.media.undo();
      this.changed();
      return null;
    }
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
        case "media":
          return false;
      }
    });
  }

  /** Count of items a scope would remove right now (for the clear menu). */
  clearCount(scope: ClearScope): number {
    if (scope === "media") return this.media.chunkCount;
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
    if (scope === "media") {
      this.media.clearLocal();
      if (this.isRelay) this.media.relayClear(this.scene);
    }
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
    if (!here && !relay && msg.t !== "mu" && !(msg.t === "c" && msg.scope === "media")) return;
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
        if (msg.t === "s" && existing && existing.state !== "live") return;
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
        if (msg.from > have || msg.from >= LIMITS.maxPointsPerItem) return;
        const room = LIMITS.maxPointsPerItem - msg.from;
        const pts = decodePoints(msg.pts, zKindOf(entry.item.kind), room);
        if (!pts) return;
        const ref = sceneRef(scene);
        if (!inExtent(pts, entry.item.mode, { mapExtent: { w: ref.w, h: ref.h } })) return;
        const points = entry.item.points.slice(0, msg.from * 3).concat(pts);
        if (!points.length) return;
        let angles: number[] | undefined;
        if (msg.ang) {
          const decoded = decodeAngles(msg.ang, pts.length / 3);
          if (!decoded || decoded.length !== pts.length / 3 || (entry.item.angles?.length ?? 0) < msg.from) return;
          angles = (entry.item.angles ?? []).slice(0, msg.from).concat(decoded);
        }
        // Dynamics channels follow the same rule as angles: aligned with the points or dropped.
        const channel = (text: string | undefined, have: number[] | undefined): number[] | undefined => {
          if (!text) return undefined;
          const decoded = decodeUnits(text, pts.length / 3);
          if (!decoded || decoded.length !== pts.length / 3 || (have?.length ?? 0) < msg.from) return undefined;
          return (have ?? []).slice(0, msg.from).concat(decoded);
        };
        const tilt = channel(msg.tl, entry.item.tilt);
        const speed = channel(msg.sp, entry.item.speed);
        this.store.put({ ...entry.item, points, angles, tilt, speed }, "live");
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
      case "u":
        this.#receiveUpdate(msg.item, sender, scene, here, relay);
        return;
      case "U":
        for (const wire of msg.items) this.#receiveUpdate(wire, sender, scene, here, relay);
        return;
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
        if (scope === "media") {
          this.media.clearLocal(scene);
          if (relay) this.media.relayClear(scene);
        }
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
      case "ms":
      case "mp":
      case "me":
      case "mu":
      case "mq":
      case "mr":
        this.media.receive(msg as MediaMessage, sender, scene, here, may);
        return;
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

  /** An item replaced by its author or a manager (`u`, or one entry of `U`). */
  #receiveUpdate(wire: WireItem, sender: FoundryUser, scene: FoundryScene, here: boolean, relay: boolean): void {
    if (!wire || typeof wire !== "object") return;
    const id = (wire as { id?: unknown }).id;
    if (typeof id !== "string") return;
    const th = settings.thresholds();
    const entry = here ? this.store.get(id) : undefined;
    const storedRaw = relay ? rawItems(scene)[id] : undefined;
    const current = entry?.item ?? (storedRaw ? readStored(scene, id, storedRaw, this.now()) : null);
    if (!current || !mayModify(sender.id, sender.role, current.author, th)) return;
    if (current.expiresAt !== null && this.now() >= goneAt(current)) return;
    // An update keeps the current author's identity and lifetime even if it was queued.
    if ((wire.expiresAt === null) !== (current.expiresAt === null)) return;
    const item = sanitizeItem(
      { ...wire, createdAt: current.createdAt, expiresAt: current.expiresAt, fadeDuration: current.fadeDuration },
      { ...this.#ctx(scene, current.author, current.expiresAt === null), allowExpired: true },
    );
    if (!item || item.mode !== current.mode || item.kind !== current.kind) return;
    if (item.expiresAt === null) {
      if (relay && storedRaw) {
        const refusal = this.writer.write(scene, item);
        if (refusal) this.net.send({ t: "n", to: sender.id, id: item.id, reason: refusal }, scene.id);
      }
      if (here && entry) this.store.put(item, entry.state);
    } else if (here && entry) this.store.put(item, entry.state === "live" ? "live" : "temp");
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
    if (this.effective().tool === "paint") {
      const id = this.prefs.mediaBrush;
      const cur = this.prefs.mediaSizes[id];
      const step = Math.max(1, Math.round(cur * 0.12));
      const next = Math.max(MEDIA_UI_SIZE.min, Math.min(MEDIA_UI_SIZE.max, cur + Math.sign(delta) * step));
      this.setPrefs({ mediaSizes: { ...this.prefs.mediaSizes, [id]: next } });
      return;
    }
    const key = sizeKey(this.prefs);
    const cur = this.prefs.sizes[key];
    const step = Math.max(1, Math.round(cur * 0.12));
    const sizes = { ...this.prefs.sizes, [key]: cur + Math.sign(delta) * step };
    this.setPrefs({ sizes });
  }

  /** Rotate the active brush or rectangular eraser nib angle (degrees). */
  nudgeAngle(delta: number, step = 15): void {
    const { tool } = this.effective();
    const wrap = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
    if (tool === "eraser") {
      this.setPrefs({ eraserTip: "rect", eraserAngle: wrap(this.prefs.eraserAngle + Math.sign(delta) * step) });
      return;
    }
    const id = activeBrushId(this.prefs);
    if (!id) return;
    const brush = BRUSHES[id];
    const cur = resolveBrushParams(brush, this.prefs.brushParams[id]).angle;
    const next = Math.round(wrap(cur + Math.sign(delta) * step));
    const params = { ...this.prefs.brushParams, [id]: { ...(this.prefs.brushParams[id] ?? {}), ang: next } };
    this.setPrefs({ brushParams: params });
  }

  /** Swap foreground and secondary colour (X key). */
  swapColors(): void {
    const cur = this.color();
    const sec = this.prefs.secondaryColor;
    this.setPrefs({ color: sec, secondaryColor: cur });
  }

  destroy(): void {
    this.detach();
    this.media.destroy();
    this.net.destroy();
    this.#listeners.clear();
  }
}
