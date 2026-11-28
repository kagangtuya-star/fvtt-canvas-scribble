import { encodePoints, quantizePoints } from "../core/codec.ts";
import type { Action } from "../core/permissions.ts";
import type { Bounds } from "../core/geometry.ts";
import { hashString, randomId } from "../core/util.ts";
import { activeGM, dataUrl } from "../foundry/compat.ts";
import { bakePath, MediaWriter, readMedia } from "../foundry/media-store.ts";
import type { MediaChunkMeta, MediaRefusal } from "../foundry/media-store.ts";
import { sceneRef } from "../foundry/persistence.ts";
import * as settings from "../foundry/settings.ts";
import { LIVE_BATCH_MS } from "../constants.ts";
import type { Net } from "../net/net.ts";
import { MAX_MESSAGE_CHARS, MAX_STROKE_BATCH } from "../net/protocol.ts";
import type { Message } from "../net/protocol.ts";
import { COVERAGE_AGE_MS, decodeBakeFile, MAX_BAKE_BYTES, MAX_BAKE_FILE_BYTES } from "./bake.ts";
import { MEDIA_BRUSHES } from "./brushes.ts";
import type { MediaBrushId, PaperId } from "./brushes.ts";
import type { EngineIn, EngineOut } from "./engine.ts";
import { CELL_UNITS, CHUNK, chunkKey } from "./layout.ts";
import { MAX_MEDIA_POINTS, MAX_MEDIA_SIZE, sanitizePoints, sanitizeStroke, strokeToWire } from "./ops.ts";
import type { MediaStroke, WireStroke } from "./ops.ts";

/**
 * Main-thread side of the wet-media simulation.
 *
 * - Runs the {@link MediaEngine} in a module worker (inline as a fallback).
 * - Streams local strokes as inputs (`ms`/`mp`/`me`), applies validated
 *   remote strokes, undo (`mu`) and late-join replays (`mq`/`mr`).
 * - Loads the GM's bakes from the Scene flags; on the active GM, bakes chunks
 *   when they dry and stores them through {@link MediaWriter}.
 *
 * Clients simulate the same inputs, but arrival order and timing differ
 * slightly, so wet paint may differ in detail between clients. Once a chunk
 * dries, everyone loads the GM's bake and the result converges.
 */

export type MediaMessage = Extract<Message, { t: "ms" | "mp" | "me" | "mu" | "mq" | "mr" }>;

export interface MediaHost {
  readonly net: Net;
  readonly scene: FoundryScene | null;
  readonly isRelay: boolean;
  now(): number;
  can(action: Action): boolean;
  notify(level: "info" | "warn" | "error", key: string, data?: Record<string, unknown>): void;
  log(text: string, data?: unknown): void;
}

export interface StrokeSpec {
  brush: MediaBrushId;
  color: string;
  /** Diameter in map units. */
  size: number;
  pigment: number;
  water: number;
}

export interface MediaStats {
  backend: string;
  chunks: number;
  wet: number;
  stepMs: number;
  queued: number;
  note?: string;
}

/** Own strokes kept for late joiners (ms). Longer than any drying time at default speed. */
const LOG_MS = COVERAGE_AGE_MS;
const LOG_MAX = 200;
const LOG_POINTS = 40_000;
const REMOTE_LOG_MAX = 600;
/** Own strokes that can be undone (the engine keeps snapshots for the last six strokes). */
const UNDO_MAX = 6;
/** Remote strokes without news for this long are ended. */
const REMOTE_STALE_MS = 15_000;
const FETCH_PARALLEL = 3;
/** Remembered stroke authors (undo routing, replay protection). */
const AUTHORS_MAX = 2000;

interface LocalStroke {
  stroke: MediaStroke;
  /** Points (count) already sent. */
  sent: number;
  ended: boolean;
  endedAt: number;
}

interface RemoteStroke {
  author: string;
  count: number;
  seen: number;
  ended: boolean;
}

interface Link {
  post(msg: EngineIn): void;
  destroy(): void;
}

type View = Extract<EngineIn, { t: "view" }>;
interface BakeRequest {
  scene: FoundryScene;
  epoch: number;
  /** A bake cannot replace base pigment the engine has not loaded. */
  missing: Set<string>;
  writes?: Promise<boolean>[];
  failed?: boolean;
}
const revisionOf = (meta: MediaChunkMeta): string => `${meta.r}:${meta.f ?? ""}${meta.format ? `:${meta.format}` : ""}`;
const EMPTY_VIEW: View = { t: "view", x0: 0, y0: 0, x1: -1, y1: -1 };

export function paperSeed(sceneId: string): number {
  return hashString(`paper:${sceneId}`) >>> 0;
}

/** Chunk keys a stroke's footprint can reach. */
export function strokeChunks(points: readonly number[], size: number): string[] {
  if (points.length < 3) return [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 2 < points.length; i += 3) {
    x0 = Math.min(x0, points[i]!);
    x1 = Math.max(x1, points[i]!);
    y0 = Math.min(y0, points[i + 1]!);
    y1 = Math.max(y1, points[i + 1]!);
  }
  const span = CHUNK * CELL_UNITS;
  const r = size / 2;
  const out: string[] = [];
  for (let cy = Math.floor((y0 - r) / span); cy <= Math.floor((y1 + r) / span); cy++)
    for (let cx = Math.floor((x0 - r) / span); cx <= Math.floor((x1 + r) / span); cx++) out.push(chunkKey(cx, cy));
  return out;
}

export class MediaController {
  readonly #host: MediaHost;
  readonly writer: MediaWriter;
  #link: Link | null = null;
  #ready = false;
  #sceneId = "";
  #paper: PaperId | null = null;
  #req = 0;
  readonly #local = new Map<string, LocalStroke>();
  readonly #localStash = new Map<string, LocalStroke[]>();
  readonly #undo: string[] = [];
  readonly #remote = new Map<string, RemoteStroke>();
  readonly #authors = new Map<string, string>();
  /** Recent received inputs, so returning to a scene does not depend on the author being online. */
  readonly #recentRemote = new Map<string, Map<string, { stroke: MediaStroke; author: string }>>();
  readonly #clearTimes = new Map<string, number>();
  /** Latest bake metadata of the viewed scene, and the revision loaded into the engine. */
  #bakes = new Map<string, MediaChunkMeta>();
  readonly #loaded = new Map<string, string>();
  /** Confirmed missing/corrupt checkpoints must not prevent painting a replacement. References stay intact. */
  readonly #unavailable = new Map<string, string>();
  readonly #ownBakes = new Map<string, Set<string>>();
  readonly #suppressed = new Map<string, string>();
  readonly #loading = new Map<string, { revision: string; done: Promise<void> }>();
  readonly #fetchQueue: { scene: string; key: string; meta: MediaChunkMeta; epoch: number; done: () => void }[] = [];
  #fetching = 0;
  #epoch = 0;
  #clearedAt = -1;
  #view: View | null = null;
  readonly #bakeScenes = new Map<number, BakeRequest>();
  readonly #flushes = new Map<number, (ok?: boolean) => void>();
  readonly #undoReqs = new Map<number, { scene: FoundryScene; epoch: number; id: string; mine: boolean }>();
  readonly #displays = new Map<string, Uint8ClampedArray>();
  #sendTimer: ReturnType<typeof setTimeout> | null = null;
  #housekeeping: ReturnType<typeof setInterval> | null = null;
  #warnedNoGM = 0;
  stats: MediaStats | null = null;
  /** Chunk display updates (the renderer's media layer). */
  onDisplay: ((key: string, data: Uint8ClampedArray | null) => void) | null = null;
  /** State changed (undo availability, stats). */
  onChange: (() => void) | null = null;

  constructor(host: MediaHost) {
    this.#host = host;
    this.writer = new MediaWriter(settings.mediaBudgetBytes);
    this.writer.onError = (err) => {
      console.error("CanvasScribble | media store failed", err);
      host.notify("error", "Notify.MediaUploadFailed");
    };
  }

  /* -------------------------------------------- */
  /*  Engine link                                 */
  /* -------------------------------------------- */

  get started(): boolean {
    return !!this.#link;
  }

  /** Current chunk displays (a new renderer shows them at once). */
  displays(): IterableIterator<[string, Uint8ClampedArray]> {
    return this.#displays.entries();
  }

  view([minX, minY, maxX, maxY]: Bounds): void {
    const span = CHUNK * CELL_UNITS;
    const view: View = {
      t: "view",
      x0: Math.floor(minX / span),
      y0: Math.floor(minY / span),
      x1: Math.floor(maxX / span),
      y1: Math.floor(maxY / span),
    };
    const prev = this.#view;
    if (prev && prev.x0 === view.x0 && prev.y0 === view.y0 && prev.x1 === view.x1 && prev.y1 === view.y1) return;
    this.#view = view;
    this.#link?.post(view);
  }

  #post(msg: EngineIn): void {
    if (!this.#link) this.#start();
    this.#link!.post(msg);
  }

  #start(): void {
    const init: EngineIn = {
      t: "init",
      paper: this.#paper ?? settings.mediaPaper(),
      seed: paperSeed(this.#sceneId),
      drying: settings.mediaDrying(),
      backend: settings.mediaBackend(),
      clock: this.#clockOffset(),
    };
    this.#link = this.#workerLink(init) ?? this.#inlineLink(init);
    this.#link.post(this.#view ?? EMPTY_VIEW);
    this.#housekeeping = setInterval(() => this.#housekeep(), 2000);
  }

  #clockOffset(): number {
    return this.#host.now() - Date.now();
  }

  #workerLink(init: EngineIn): Link | null {
    if (typeof Worker === "undefined") return null;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "canvas-scribble-media" });
    } catch (err) {
      this.#host.log("media worker unavailable", err);
      return null;
    }
    // Messages are replayed on the inline engine if the worker fails before it is ready.
    const sent: EngineIn[] = [init];
    let fallback: Link | null = null;
    const link: Link = {
      post: (msg) => {
        if (fallback) return fallback.post(msg);
        if (!this.#ready) sent.push(msg);
        worker.postMessage(msg);
      },
      destroy: () => {
        if (fallback) fallback.destroy();
        else worker.terminate();
      },
    };
    worker.addEventListener("message", (e: MessageEvent<EngineOut>) => {
      if (fallback) return;
      if (e.data?.t === "ready") sent.length = 0;
      this.#receiveEngine(e.data);
    });
    worker.addEventListener("error", (e) => {
      if (this.#ready || fallback) {
        console.error("CanvasScribble | media worker error", e);
        return;
      }
      e.preventDefault?.();
      this.#host.log("media worker failed to start, running inline", e);
      worker.terminate();
      const [first, ...rest] = sent.splice(0);
      fallback = this.#inlineLink(first!);
      for (const msg of rest) fallback.post(msg);
    });
    worker.postMessage(init);
    return link;
  }

  /** The engine on the main thread (no module workers, CSP, tests). */
  #inlineLink(init: EngineIn): Link {
    const queue: EngineIn[] = [init];
    let engine: import("./engine.ts").MediaEngine | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dead = false;
    const schedule = () => {
      if (timer !== null || !engine || dead) return;
      timer = setTimeout(() => {
        timer = null;
        if (!engine || dead) return;
        try {
          engine.tick();
        } catch (err) {
          console.error("CanvasScribble | media engine error", err);
        }
        if (engine.busy) schedule();
      }, 16);
    };
    const handle = (msg: EngineIn) => {
      if (!engine) return queue.push(msg);
      try {
        engine.handle(msg);
      } catch (err) {
        console.error("CanvasScribble | media engine error", err);
      }
      schedule();
    };
    void Promise.all([import("./engine.ts"), import("./sim/select.ts")]).then(
      ([{ MediaEngine }, { createBackend }]) => {
        if (dead) return;
        const first = queue.shift() as Extract<EngineIn, { t: "init" }>;
        const { backend, note } = createBackend(first.backend);
        engine = new MediaEngine(backend, (out) => this.#receiveEngine(out));
        engine.handle(first);
        this.#receiveEngine({ t: "ready", backend: backend.kind, ...(note ? { note } : {}) });
        for (const msg of queue.splice(0)) handle(msg);
        schedule();
      },
    );
    return {
      post: handle,
      destroy: () => {
        dead = true;
        if (timer !== null) clearTimeout(timer);
        engine?.handle({ t: "destroy" });
        engine = null;
      },
    };
  }

  #receiveEngine(msg: EngineOut): void {
    switch (msg.t) {
      case "ready":
        this.#ready = true;
        this.stats = { backend: msg.backend, chunks: 0, wet: 0, stepMs: 0, queued: 0, note: msg.note };
        this.#host.log(`media engine ready (${msg.backend})`, msg.note);
        return;
      case "display":
        if (msg.data) this.#displays.set(msg.key, msg.data);
        else this.#displays.delete(msg.key);
        this.onDisplay?.(msg.key, msg.data);
        return;
      case "dry": {
        const scene = this.#host.scene;
        if (
          scene &&
          scene.id === this.#sceneId &&
          this.#host.isRelay &&
          !this.#missing(msg.key) &&
          !this.#flushes.size
        ) {
          const req = ++this.#req;
          this.#bakeScenes.set(req, { scene, epoch: this.#epoch, missing: new Set() });
          this.#post({ t: "bake", key: msg.key, req });
        }
        return;
      }
      case "baked":
        this.#stored(msg);
        return;
      case "flushed": {
        const done = this.#flushes.get(msg.req);
        this.#flushes.delete(msg.req);
        done?.(msg.ok !== false);
        return;
      }
      case "loaded":
        if (msg.ok && msg.revision && this.#expected(msg.key, msg.revision)) this.#loaded.set(msg.key, msg.revision);
        else if (!msg.ok && msg.revision && this.#expected(msg.key, msg.revision)) {
          if (msg.invalid) {
            this.#unavailable.set(msg.key, msg.revision);
            this.#post({ t: "retryBake", key: msg.key });
          }
          this.#host.notify("warn", "Notify.MediaLoadFailed");
        }
        return;
      case "undone": {
        const request = this.#undoReqs.get(msg.req);
        this.#undoReqs.delete(msg.req);
        if (!request) return;
        const { scene, id, mine } = request;
        const sameScene = scene.id === this.#sceneId;
        if (!msg.ok) {
          if (mine) this.#host.notify("info", "Notify.MediaUndoFailed");
          if (mine && sameScene && request.epoch !== this.#epoch) this.#replayLocal(scene.id);
          return;
        }
        if (sameScene && request.epoch === this.#epoch) {
          for (const key of msg.removed ?? []) {
            const meta = this.#bakes.get(key);
            if (meta) this.#suppressed.set(key, revisionOf(meta));
            this.#loaded.delete(key);
          }
        }
        if (msg.removed?.length && this.#host.isRelay) this.writer.remove(scene, msg.removed);
        if (mine) {
          if (sameScene) this.#local.delete(id);
          const stashed = this.#localStash.get(scene.id);
          if (stashed)
            this.#localStash.set(
              scene.id,
              stashed.filter((s) => s.stroke.id !== id),
            );
          this.#host.net.send({ t: "mu", id }, scene.id);
        }
        return;
      }
      case "stats":
        this.stats = { ...msg, note: this.stats?.note };
        return;
      case "limit":
        this.#host.notify("warn", "Notify.MediaTooMany");
        return;
      case "error":
        console.warn(`CanvasScribble | media engine: ${msg.message}`);
        return;
    }
  }

  /* -------------------------------------------- */
  /*  Scene lifecycle                             */
  /* -------------------------------------------- */

  /**
   * View a scene. A redraw of the same scene (configuration change, level
   * switch…) keeps the wet paint; switching scenes dries and bakes what the
   * GM leaves behind and starts empty.
   */
  attach(scene: FoundryScene): void {
    const parked = this.#parked;
    this.#parked = null;
    if (parked?.id === scene.id && this.#sceneId === scene.id) {
      void this.#syncFlags(scene).then(() => {
        if (this.#sceneId === scene.id) this.#replayRemote(scene);
      });
      return;
    }
    if (parked && this.#sceneId) this.#leave(parked);
    this.#sceneId = scene.id;
    this.#clearedAt = this.#clearTimes.get(scene.id) ?? -1;
    const flags = readMedia(scene);
    this.#paper = flags.paper ?? settings.mediaPaper();
    if (this.#link) {
      this.#post({ t: "paper", paper: this.#paper, seed: paperSeed(scene.id) });
      this.#post({ t: "drying", factor: settings.mediaDrying() });
      this.#post({ t: "clock", offset: this.#clockOffset() });
    }
    this.#bakes = new Map();
    const epoch = this.#epoch;
    void this.#syncFlags(scene).then(() => {
      if (this.#sceneId !== scene.id || this.#epoch !== epoch) return;
      this.#replayLocal(scene.id);
      this.#replayRemote(scene);
      this.#host.net.send({ t: "mq" });
    });
  }

  /** The canvas goes away; the paint is kept until another scene is viewed. */
  detach(): void {
    this.#stopSending();
    const scene = this.#host.scene;
    if (scene && scene.id === this.#sceneId) this.#parked = scene;
  }

  #parked: FoundryScene | null = null;

  #leave(scene: FoundryScene): void {
    this.#pruneLog();
    const strokes = [...(this.#localStash.get(scene.id) ?? []), ...[...this.#local.values()].filter((s) => s.ended)];
    if (strokes.length) {
      this.#localStash.delete(scene.id);
      this.#localStash.set(scene.id, strokes);
      if (this.#localStash.size > 6) this.#localStash.delete(this.#localStash.keys().next().value!);
    }
    if (this.#link && this.#host.isRelay) {
      // Wet paint the GM leaves behind is dried and baked now (the engine handles messages in order).
      const req = ++this.#req;
      this.#bakeScenes.set(req, { scene, epoch: this.#epoch, missing: this.#missingKeys() });
      this.#flushes.set(req, () => this.#bakeScenes.delete(req));
      this.#post({ t: "flush", req });
    }
    this.#resetScene();
    this.#authors.clear();
    this.#view = null;
    if (this.#link) {
      this.#post({ t: "clear" });
      this.#post(EMPTY_VIEW);
    }
    this.#sceneId = "";
  }

  #resetScene(): void {
    this.#stopSending();
    this.#local.clear();
    this.#undo.length = 0;
    this.#remote.clear();
    this.#loaded.clear();
    this.#unavailable.clear();
    this.#ownBakes.clear();
    this.#suppressed.clear();
    this.#loading.clear();
    this.#epoch++;
    for (const job of this.#fetchQueue.splice(0)) job.done();
    this.#bakes = new Map();
    for (const key of [...this.#displays.keys()]) this.onDisplay?.(key, null);
    this.#displays.clear();
    this.onChange?.();
  }

  /** World settings changed (drying speed, default paper). */
  settingsChanged(): void {
    const scene = this.#host.scene;
    if (!this.#link || !scene) return;
    this.#post({ t: "drying", factor: settings.mediaDrying() });
    const paper = readMedia(scene).paper ?? settings.mediaPaper();
    if (paper !== this.#paper) {
      this.#paper = paper;
      this.#post({ t: "paper", paper, seed: paperSeed(scene.id) });
    }
  }

  /** Scene flags changed. */
  onSceneUpdate(scene: FoundryScene, changes: Record<string, any>): void {
    if (scene.id !== this.#sceneId) return;
    const media = changes?.flags?.["canvas-scribble"];
    if (!media || typeof media !== "object") return;
    if (!Object.keys(media).some((k) => k === "media" || k.startsWith("media") || k.startsWith("-=media"))) return;
    void this.#syncFlags(scene);
  }

  async #syncFlags(scene: FoundryScene): Promise<void> {
    const flags = readMedia(scene);
    const paper = flags.paper ?? settings.mediaPaper();
    if (paper !== this.#paper) {
      this.#paper = paper;
      if (this.#link) this.#post({ t: "paper", paper, seed: paperSeed(scene.id) });
    }
    const before = this.#bakes;
    this.#bakes = flags.chunks;
    for (const key of before.keys()) {
      if (flags.chunks.has(key)) continue;
      const loaded = this.#loaded.has(key);
      this.#loaded.delete(key);
      this.#ownBakes.delete(key);
      this.#unavailable.delete(key);
      this.#loading.delete(key);
      const suppressed = this.#suppressed.delete(key);
      if (loaded && !suppressed && this.#link) this.#post({ t: "remove", key });
    }
    const jobs: Promise<void>[] = [];
    for (const [key, meta] of flags.chunks) {
      if (!this.#missing(key)) continue;
      if (this.#ownBakes.get(key)?.delete(revisionOf(meta))) {
        this.#loaded.set(key, revisionOf(meta));
        continue;
      }
      jobs.push(this.#queueFetch(scene.id, key, meta));
    }
    await Promise.all(jobs);
  }

  #queueFetch(sceneId: string, key: string, meta: MediaChunkMeta): Promise<void> {
    const revision = revisionOf(meta);
    const old = this.#loading.get(key);
    if (old?.revision === revision) return old.done;
    const epoch = this.#epoch;
    const done = new Promise<void>((resolve) => {
      this.#fetchQueue.push({ scene: sceneId, key, meta, epoch, done: resolve });
      this.#pump();
    });
    const job = { revision, done };
    this.#loading.set(key, job);
    void done.then(() => {
      if (this.#loading.get(key) === job) this.#loading.delete(key);
    });
    return done;
  }

  #pump(): void {
    while (this.#fetching < FETCH_PARALLEL && this.#fetchQueue.length) {
      const job = this.#fetchQueue.shift()!;
      this.#fetching++;
      void this.#fetchBake(job.scene, job.key, job.meta, job.epoch).finally(() => {
        this.#fetching--;
        job.done();
        this.#pump();
      });
    }
  }

  async #fetchBake(sceneId: string, key: string, meta: MediaChunkMeta, epoch: number): Promise<void> {
    const path = bakePath(sceneId, key, meta.f, meta.format);
    const revision = revisionOf(meta);
    const current = () => sceneId === this.#sceneId && epoch === this.#epoch && this.#expected(key, revision);
    if (!current()) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      if (!current()) return;
      let missing = false;
      let invalid = false;
      try {
        if (!path) throw new Error("Paint storage path unavailable");
        const res = await fetch(`${dataUrl(path)}?v=${meta.r}`);
        if (!res.ok) {
          missing = res.status === 404 || res.status === 410;
          throw new Error(`HTTP ${res.status}`);
        }
        const max = meta.format === "json" ? MAX_BAKE_FILE_BYTES : MAX_BAKE_BYTES;
        const length = Number(res.headers.get("content-length"));
        if (length > max) throw new Error("bake too large");
        const file = new Uint8Array(await res.arrayBuffer());
        if (file.byteLength > max) throw new Error("bake too large");
        const data = meta.format === "json" ? decodeBakeFile(file) : file;
        if (!data) {
          invalid = true;
          throw new Error("invalid bake data file");
        }
        if (current()) this.#post({ t: "load", key, data, at: meta.t, revision });
        return;
      } catch (err) {
        if (attempt === 2 && current()) {
          console.warn(`CanvasScribble | media bake ${key} not loaded (${path})`, err);
          if (missing || invalid) {
            this.#unavailable.set(key, revision);
            if (this.#link) this.#post({ t: "retryBake", key });
          }
          this.#host.notify("warn", missing ? "Notify.MediaMissing" : "Notify.MediaLoadFailed");
        }
      }
    }
  }

  #expected(key: string, revision: string): boolean {
    const meta = this.#bakes.get(key);
    return (
      !!meta &&
      meta.t >= this.#clearedAt &&
      revisionOf(meta) === revision &&
      this.#suppressed.get(key) !== revision &&
      this.#unavailable.get(key) !== revision
    );
  }

  #missing(key: string): boolean {
    const meta = this.#bakes.get(key);
    if (!meta || meta.t < this.#clearedAt) return false;
    const revision = revisionOf(meta);
    return (
      this.#suppressed.get(key) !== revision &&
      this.#loaded.get(key) !== revision &&
      this.#unavailable.get(key) !== revision
    );
  }

  #missingKeys(): Set<string> {
    return new Set([...this.#bakes.keys()].filter((key) => this.#missing(key)));
  }

  /* -------------------------------------------- */
  /*  GM bakes                                    */
  /* -------------------------------------------- */

  #stored(msg: Extract<EngineOut, { t: "baked" }>): void {
    const request = this.#bakeScenes.get(msg.req);
    if (!this.#flushes.has(msg.req)) this.#bakeScenes.delete(msg.req);
    if (!request) return;
    const { scene, epoch } = request;
    const sameView = () => scene.id === this.#sceneId && epoch === this.#epoch;
    if (!this.#host.isRelay || (sameView() ? this.#missing(msg.key) : request.missing.has(msg.key))) {
      request.failed = true;
      return;
    }
    if (!msg.data) {
      if (msg.empty) {
        if (sameView()) {
          const meta = this.#bakes.get(msg.key);
          if (meta) this.#suppressed.set(msg.key, revisionOf(meta));
          this.#loaded.delete(msg.key);
        }
        this.writer.remove(scene, [msg.key]);
      }
      return;
    }
    const at = this.#host.now();
    const queued = (meta: MediaChunkMeta) => {
      if (!sameView()) return;
      let revisions = this.#ownBakes.get(msg.key);
      if (!revisions) this.#ownBakes.set(msg.key, (revisions = new Set()));
      revisions.add(revisionOf(meta));
      if (revisions.size > 4) revisions.delete(revisions.values().next().value!);
    };
    const write = this.writer.store(scene, msg.key, msg.data, at, queued).then((refusal: MediaRefusal | null) => {
      if (!refusal) return true;
      if (sameView()) this.#post({ t: "retryBake", key: msg.key });
      const key =
        refusal === "budget"
          ? "Notify.MediaBudget"
          : refusal === "count"
            ? "Notify.MediaTooMany"
            : refusal === "unavailable"
              ? "Notify.MediaUnavailable"
              : "Notify.MediaUploadFailed";
      this.#host.notify("warn", key);
      return false;
    });
    (request.writes ??= []).push(write);
  }

  /** Dry all wet paint now (the GM also bakes it). */
  async dryNow(): Promise<boolean> {
    if (!this.#link) return true;
    const scene = this.#host.scene;
    if (scene && this.#host.isRelay) {
      const preventUnload = (event: BeforeUnloadEvent) => {
        event.preventDefault();
        event.returnValue = "";
      };
      globalThis.addEventListener?.("beforeunload", preventUnload);
      try {
        await this.#syncFlags(scene);
        if (scene.id !== this.#sceneId || !this.#link) return false;
        const req = ++this.#req;
        const request: BakeRequest = { scene, epoch: this.#epoch, missing: this.#missingKeys() };
        this.#bakeScenes.set(req, request);
        const flushed = new Promise<boolean>((resolve) => {
          this.#flushes.set(req, (ok = true) => {
            this.#bakeScenes.delete(req);
            resolve(ok);
          });
        });
        this.#post({ t: "flush", req });
        const ok = await flushed;
        const writes = await Promise.all(request.writes ?? []);
        const persisted = await this.writer.drain();
        const missing = scene.id === this.#sceneId ? this.#missingKeys().size : request.missing.size;
        const saved = ok && !request.failed && writes.every(Boolean) && persisted && !missing;
        this.#host.notify(saved ? "info" : "warn", saved ? "Notify.MediaSaved" : "Notify.MediaSaveFailed");
        return saved;
      } finally {
        globalThis.removeEventListener?.("beforeunload", preventUnload);
      }
    }
    this.#post({ t: "dryAll" });
    return true;
  }

  /** The scene's paper (GM). */
  paper(): PaperId {
    return this.#paper ?? settings.mediaPaper();
  }

  setPaper(paper: PaperId): boolean {
    const scene = this.#host.scene;
    if (!scene || !this.#host.isRelay) return false;
    this.writer.setPaper(scene, paper);
    this.#paper = paper;
    if (this.#link) this.#post({ t: "paper", paper, seed: paperSeed(scene.id) });
    this.onChange?.();
    return true;
  }

  /* -------------------------------------------- */
  /*  Local strokes                               */
  /* -------------------------------------------- */

  /** Start a local stroke at the first point(s); returns its id. */
  begin(spec: StrokeSpec, points: number[]): string | null {
    const scene = this.#host.scene;
    if (!scene || scene.id !== this.#sceneId || !MEDIA_BRUSHES[spec.brush]) return null;
    if (!activeGM() && performance.now() - this.#warnedNoGM > 60_000) {
      this.#warnedNoGM = performance.now();
      this.#host.notify("warn", "Notify.MediaNoGM");
    }
    const id = randomId(16);
    const pts = quantizePoints(points.slice(0, MAX_MEDIA_POINTS * 3), "pressure");
    const stroke: MediaStroke = {
      id,
      brush: spec.brush,
      color: spec.color,
      size: Math.max(1, Math.min(MAX_MEDIA_SIZE, Math.round(spec.size * 10) / 10)),
      pigment: Math.round(spec.pigment * 100) / 100,
      water: Math.round(spec.water * 100) / 100,
      seed: (Math.random() * 0xffffffff) >>> 0,
      points: pts,
      at: Math.round(this.#host.now()),
    };
    this.#local.set(id, { stroke, sent: pts.length / 3, ended: false, endedAt: 0 });
    this.#remember(id, game.user.id);
    this.#post({
      t: "stroke",
      id,
      brush: stroke.brush,
      color: stroke.color,
      size: stroke.size,
      pigment: stroke.pigment,
      water: stroke.water,
      seed: stroke.seed,
      at: stroke.at,
    });
    if (pts.length) this.#post({ t: "points", id, pts: Float32Array.from(pts) });
    this.#host.net.send({ t: "ms", s: strokeToWire(stroke) });
    return id;
  }

  /** Points left before the stroke is full. */
  room(id: string): number {
    const s = this.#local.get(id);
    return s && !s.ended ? MAX_MEDIA_POINTS - s.stroke.points.length / 3 : 0;
  }

  add(id: string, points: number[]): boolean {
    const s = this.#local.get(id);
    if (!s || s.ended) return false;
    const room = MAX_MEDIA_POINTS - s.stroke.points.length / 3;
    if (room <= 0) return false;
    const pts = quantizePoints(points.slice(0, room * 3), "pressure");
    if (!pts.length) return true;
    s.stroke.points.push(...pts);
    this.#post({ t: "points", id, pts: Float32Array.from(pts) });
    if (this.#sendTimer === null) this.#sendTimer = setTimeout(() => this.#flushLive(), LIVE_BATCH_MS);
    return points.length <= room * 3;
  }

  #flushLive(): void {
    this.#sendTimer = null;
    for (const [id, s] of this.#local) {
      if (s.ended) continue;
      const total = s.stroke.points.length / 3;
      if (total <= s.sent) continue;
      this.#host.net.send({ t: "mp", id, from: s.sent, pts: encodePoints(s.stroke.points.slice(s.sent * 3)) });
      s.sent = total;
    }
  }

  #stopSending(): void {
    if (this.#sendTimer !== null) clearTimeout(this.#sendTimer);
    this.#sendTimer = null;
  }

  end(id: string): void {
    const s = this.#local.get(id);
    if (!s || s.ended) return;
    s.ended = true;
    s.endedAt = Date.now();
    s.sent = s.stroke.points.length / 3;
    this.#post({ t: "end", id });
    this.#host.net.send({ t: "me", s: strokeToWire(s.stroke) });
    this.#undo.push(id);
    if (this.#undo.length > UNDO_MAX) this.#undo.shift();
    this.#pruneLog();
    this.onChange?.();
  }

  /** Abandon a stroke in progress (Escape): it is undone everywhere. */
  cancel(id: string): void {
    const s = this.#local.get(id);
    if (!s || s.ended) return;
    this.end(id);
    this.undo();
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  /** Undo the newest own stroke (if no later paint touched its chunks). */
  undo(): boolean {
    const id = this.#undo.pop();
    const scene = this.#host.scene;
    if (!id || !scene) return false;
    const req = ++this.#req;
    this.#undoReqs.set(req, { scene, epoch: this.#epoch, id, mine: true });
    this.#post({ t: "undo", id, req });
    this.onChange?.();
    return true;
  }

  #pruneLog(): void {
    const now = Date.now();
    let points = 0;
    let count = 0;
    for (const [id, s] of [...this.#local].reverse()) {
      if (!s.ended) continue;
      const next = s.stroke.points.length / 3;
      if (now - s.endedAt > LOG_MS || (!this.#undo.includes(id) && (count >= LOG_MAX || points + next > LOG_POINTS))) {
        this.#local.delete(id);
      } else {
        count++;
        points += next;
      }
    }
  }

  #replayLocal(sceneId: string): void {
    const strokes = this.#localStash.get(sceneId);
    this.#localStash.delete(sceneId);
    if (!strokes) return;
    const undoing = new Set(
      [...this.#undoReqs.values()].filter((r) => r.mine && r.scene.id === sceneId).map((r) => r.id),
    );
    const waiting: LocalStroke[] = [];
    for (const s of strokes) {
      if (Date.now() - s.endedAt > LOG_MS || s.stroke.at < this.#clearedAt || this.#authors.has(s.stroke.id)) continue;
      if (undoing.has(s.stroke.id)) {
        waiting.push(s);
        continue;
      }
      this.#local.set(s.stroke.id, s);
      this.#startRemote(s.stroke, game.user.id);
      this.#remote.get(s.stroke.id)!.ended = true;
      this.#post({ t: "end", id: s.stroke.id });
    }
    if (waiting.length) this.#localStash.set(sceneId, waiting);
  }

  /* -------------------------------------------- */
  /*  Clearing                                    */
  /* -------------------------------------------- */

  /** Forget cached strokes and remove all paint if the engine is holding this scene. */
  clearLocal(scene = this.#host.scene ?? this.#parked): void {
    if (!scene) return;
    this.#discardRecent(scene.id);
    this.#invalidateBakes(scene.id);
    for (const [req, undo] of this.#undoReqs) if (undo.scene.id === scene.id) this.#undoReqs.delete(req);
    if (scene.id !== this.#sceneId) return;
    this.#resetScene();
    // Keep the old revisions suppressed until the deletion is visible in the flags.
    this.#bakes = readMedia(scene).chunks;
    for (const [key, meta] of this.#bakes) this.#suppressed.set(key, revisionOf(meta));
    if (this.#link) this.#post({ t: "clear" });
  }

  #discardRecent(sceneId: string): void {
    const now = this.#host.now();
    this.#clearTimes.set(sceneId, now);
    for (const [id, at] of this.#clearTimes) if (now - at > LOG_MS) this.#clearTimes.delete(id);
    if (this.#sceneId === sceneId) this.#clearedAt = now;
    this.#recentRemote.delete(sceneId);
    this.#localStash.delete(sceneId);
  }

  /** GM: forget the stored bakes of a scene. */
  relayClear(scene: FoundryScene): void {
    this.#invalidateBakes(scene.id);
    this.writer.clear(scene);
  }

  #invalidateBakes(sceneId: string): void {
    for (const [req, request] of this.#bakeScenes) {
      if (request.scene.id !== sceneId) continue;
      this.#bakeScenes.delete(req);
      this.#flushes.get(req)?.(false);
      this.#flushes.delete(req);
    }
  }

  /** Chunks with paint (for the clear menu). */
  get chunkCount(): number {
    return Math.max(this.#displays.size, this.#bakes.size);
  }

  /* -------------------------------------------- */
  /*  Inbound                                     */
  /* -------------------------------------------- */

  receive(
    msg: MediaMessage,
    sender: FoundryUser,
    scene: FoundryScene,
    here: boolean,
    may: (a: Action) => boolean,
  ): void {
    const ref = sceneRef(scene);
    const ctx = { mapExtent: { w: ref.w, h: ref.h }, now: this.#host.now() };
    switch (msg.t) {
      case "ms":
      case "me": {
        if (!may("media")) return;
        const stroke = sanitizeStroke(msg.s, ctx);
        if (!stroke || stroke.at < (this.#clearTimes.get(scene.id) ?? -1)) return;
        if (!here) {
          if (this.#host.isRelay) this.#keepRemote(scene.id, stroke, sender.id);
          return;
        }
        const known = this.#authors.get(stroke.id);
        if (known !== undefined && known !== sender.id) return;
        const remote = this.#remote.get(stroke.id);
        if (!remote) {
          // Replays of an ended or undone stroke are ignored.
          if (known !== undefined) return;
          this.#startRemote(stroke, sender.id);
        } else if (stroke.points.length / 3 > remote.count) {
          const pts = stroke.points.slice(remote.count * 3);
          remote.count += pts.length / 3;
          this.#post({ t: "points", id: stroke.id, pts: Float32Array.from(pts) });
        }
        this.#keepRemote(scene.id, stroke, sender.id);
        const r = this.#remote.get(stroke.id)!;
        r.seen = performance.now();
        if (msg.t === "me" && !r.ended) {
          r.ended = true;
          this.#post({ t: "end", id: stroke.id });
        }
        return;
      }
      case "mp": {
        if (!may("media")) return;
        if (!here) {
          const kept = this.#recentRemote.get(scene.id)?.get(msg.id);
          if (!kept || kept.author !== sender.id) return;
          const have = kept.stroke.points.length / 3;
          if (msg.from > have) return;
          const pts = sanitizePoints(msg.pts, MAX_MEDIA_POINTS - msg.from, ctx);
          if (pts) this.#appendRemote(scene.id, msg.id, sender.id, pts.slice((have - msg.from) * 3));
          return;
        }
        const r = this.#remote.get(msg.id);
        if (!r || r.author !== sender.id || r.ended || msg.from > r.count) return;
        const pts = sanitizePoints(msg.pts, MAX_MEDIA_POINTS - msg.from, ctx);
        if (!pts) return;
        const fresh = pts.slice((r.count - msg.from) * 3);
        r.seen = performance.now();
        if (!fresh.length) return;
        r.count += fresh.length / 3;
        this.#appendRemote(scene.id, msg.id, sender.id, fresh);
        this.#post({ t: "points", id: msg.id, pts: Float32Array.from(fresh) });
        return;
      }
      case "mu": {
        const kept = this.#recentRemote.get(scene.id);
        if (kept?.get(msg.id)?.author === sender.id) kept.delete(msg.id);
        if (!here) return;
        if (this.#authors.get(msg.id) !== sender.id) return;
        this.#remote.delete(msg.id);
        const req = ++this.#req;
        if (this.#link) {
          this.#undoReqs.set(req, { scene, epoch: this.#epoch, id: msg.id, mine: false });
          this.#post({ t: "undo", id: msg.id, req });
        }
        return;
      }
      case "mq": {
        if (!here) return;
        this.#pruneLog();
        const wires: WireStroke[] = [];
        for (const s of this.#local.values()) if (s.ended) wires.push(strokeToWire(s.stroke));
        let batch: WireStroke[] = [];
        let size = 256;
        const flush = () => {
          if (batch.length) this.#host.net.send({ t: "mr", to: sender.id, strokes: batch });
          batch = [];
          size = 256;
        };
        for (const w of wires) {
          const chars = w.pts.length + 160;
          if (batch.length >= MAX_STROKE_BATCH || size + chars > MAX_MESSAGE_CHARS - 4096) flush();
          batch.push(w);
          size += chars;
        }
        flush();
        return;
      }
      case "mr": {
        if (!here || msg.to !== game.user.id || !may("media")) return;
        for (const wire of msg.strokes) {
          const stroke = sanitizeStroke(wire, ctx);
          if (!stroke || stroke.at < this.#clearedAt || this.#authors.has(stroke.id)) continue;
          this.#keepRemote(scene.id, stroke, sender.id);
          this.#startRemote(stroke, sender.id);
          this.#remote.get(stroke.id)!.ended = true;
          this.#post({ t: "end", id: stroke.id });
        }
        return;
      }
    }
  }

  #startRemote(stroke: MediaStroke, author: string): void {
    this.#remember(stroke.id, author);
    this.#remote.set(stroke.id, { author, count: stroke.points.length / 3, seen: performance.now(), ended: false });
    this.#post({
      t: "stroke",
      id: stroke.id,
      brush: stroke.brush,
      color: stroke.color,
      size: stroke.size,
      pigment: stroke.pigment,
      water: stroke.water,
      seed: stroke.seed,
      at: stroke.at,
    });
    if (stroke.points.length) this.#post({ t: "points", id: stroke.id, pts: Float32Array.from(stroke.points) });
  }

  #remember(id: string, author: string): void {
    this.#authors.set(id, author);
    if (this.#authors.size > AUTHORS_MAX) {
      const first = this.#authors.keys().next().value;
      if (first !== undefined) this.#authors.delete(first);
    }
  }

  #keepRemote(sceneId: string, stroke: MediaStroke, author: string): void {
    const kept = this.#recentRemote.get(sceneId) ?? new Map<string, { stroke: MediaStroke; author: string }>();
    const before = kept.get(stroke.id);
    if (before && before.author !== author) return;
    if (!before) kept.set(stroke.id, { stroke, author });
    else if (stroke.points.length > before.stroke.points.length) before.stroke.points = stroke.points;
    this.#trimRemote(kept);
    this.#recentRemote.delete(sceneId);
    this.#recentRemote.set(sceneId, kept);
    if (this.#recentRemote.size > 6) this.#recentRemote.delete(this.#recentRemote.keys().next().value!);
  }

  #appendRemote(sceneId: string, id: string, author: string, points: number[]): void {
    const kept = this.#recentRemote.get(sceneId);
    const entry = kept?.get(id);
    if (!kept || entry?.author !== author) return;
    entry.stroke.points.push(...points);
    this.#trimRemote(kept);
  }

  #trimRemote(kept: Map<string, { stroke: MediaStroke; author: string }>): void {
    let points = 0;
    const oldest = this.#host.now() - LOG_MS;
    for (const [id, entry] of kept) {
      if (entry.stroke.at < oldest) kept.delete(id);
      else points += entry.stroke.points.length / 3;
    }
    for (const [id, entry] of kept) {
      if (points <= LOG_POINTS && kept.size <= REMOTE_LOG_MAX) break;
      points -= entry.stroke.points.length / 3;
      kept.delete(id);
    }
  }

  #replayRemote(scene: FoundryScene): void {
    const kept = this.#recentRemote.get(scene.id);
    if (!kept) return;
    for (const { stroke, author } of kept.values()) {
      if (stroke.at < Math.max(this.#clearedAt, this.#host.now() - LOG_MS) || this.#authors.has(stroke.id)) continue;
      this.#startRemote(stroke, author);
      this.#remote.get(stroke.id)!.ended = true;
      this.#post({ t: "end", id: stroke.id });
    }
  }

  /** A user left: end their strokes in progress. */
  onUserGone(userId: string): void {
    for (const [id, r] of this.#remote) {
      if (r.author !== userId || r.ended) continue;
      r.ended = true;
      this.#post({ t: "end", id });
    }
  }

  #housekeep(): void {
    const now = performance.now();
    for (const [id, r] of this.#remote) {
      if (r.ended) {
        this.#remote.delete(id);
        continue;
      }
      if (now - r.seen < REMOTE_STALE_MS) continue;
      r.ended = true;
      this.#post({ t: "end", id });
    }
    if (this.#link) this.#post({ t: "clock", offset: this.#clockOffset() });
  }

  destroy(): void {
    for (const done of this.#flushes.values()) done(false);
    this.#flushes.clear();
    this.#bakeScenes.clear();
    this.#resetScene();
    if (this.#housekeeping) clearInterval(this.#housekeeping);
    this.#housekeeping = null;
    this.#link?.destroy();
    this.#link = null;
    this.#ready = false;
    this.#localStash.clear();
    this.#recentRemote.clear();
    this.#undoReqs.clear();
  }
}
