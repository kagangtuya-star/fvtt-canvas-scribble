import { MODULE_ID } from "../constants.ts";
import { randomId } from "../core/util.ts";
import { PAPER_IDS } from "../media/brushes.ts";
import type { PaperId } from "../media/brushes.ts";
import { encodeBakeFile, MAX_BAKE_BYTES, MAX_BAKE_FILE_BYTES } from "../media/bake.ts";
import { MAX_MEDIA_CHUNKS, parseChunkKey } from "../media/layout.ts";
import { deletion, filePicker, worldId } from "./compat.ts";

/**
 * Paint checkpoints live in files, not in the Scene document:
 *
 *   worlds/<world>/canvas-scribble/<scene>/<cx>_<cy>_<f>.json  immutable bake (see media/bake.ts)
 *   flags.canvas-scribble.media.paper                       the scene's paper
 *   flags.canvas-scribble.media.chunks.c<cx>_<cy>           { r: revision, t: baked at, n: bytes, f: file id }
 *
 * The file path is always derived from the world, scene and chunk key; the
 * flags never carry a path, so an edited flag cannot point clients at
 * arbitrary files. Only the active GM uploads and writes (FilePicker needs
 * the upload permission; the scene budget and chunk count are checked here).
 */

export const FLAG_MEDIA = "media";

export interface MediaChunkMeta {
  /** Revision (increments with every bake; used as a cache buster). */
  r: number;
  /** Server time of the bake. */
  t: number;
  /** File size (bytes). */
  n: number;
  /** Absent for legacy bakes stored at the unsuffixed path. */
  f?: string;
  /** Absent for legacy PNG uploads. New data files are excluded from image optimization. */
  format?: "json";
}

export interface MediaFlags {
  paper: PaperId | null;
  chunks: Map<string, MediaChunkMeta>;
  clearedAt: number;
  saved: string[];
}

const SCENE_ID = /^[A-Za-z0-9]{1,32}$/;
const FLAG_KEY = /^c(-?\d{1,6}_-?\d{1,6})$/;
const FILE_ID = /^[A-Za-z0-9]{16}$/;

export const flagKey = (key: string): string => `c${key}`;

/** Validated media flags of a scene. */
export function readMedia(scene: FoundryScene): MediaFlags {
  const raw = (scene.flags?.[MODULE_ID] as Record<string, unknown> | undefined)?.[FLAG_MEDIA];
  const out: MediaFlags = { paper: null, chunks: new Map(), clearedAt: 0, saved: [] };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.clearedAt === "number" && Number.isFinite(r.clearedAt) && r.clearedAt >= 0) out.clearedAt = r.clearedAt;
  if (Array.isArray(r.saved))
    out.saved = r.saved.filter((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(id)).slice(-512);
  if (typeof r.paper === "string" && (PAPER_IDS as readonly string[]).includes(r.paper)) out.paper = r.paper as PaperId;
  const chunks = r.chunks;
  if (!chunks || typeof chunks !== "object") return out;
  for (const [k, v] of Object.entries(chunks as Record<string, unknown>)) {
    const m = FLAG_KEY.exec(k);
    if (!m || !parseChunkKey(m[1]!) || !v || typeof v !== "object") continue;
    const meta = v as Record<string, unknown>;
    const rev = meta.r;
    const at = meta.t;
    const n = meta.n;
    const file = meta.f;
    const format = meta.format;
    if (format !== undefined && format !== "json") continue;
    if (!Number.isInteger(rev) || (rev as number) < 1 || (rev as number) > 1e9) continue;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) continue;
    if (
      !Number.isInteger(n) ||
      (n as number) < 1 ||
      (n as number) > (format === "json" ? MAX_BAKE_FILE_BYTES : MAX_BAKE_BYTES)
    )
      continue;
    if (file !== undefined && (typeof file !== "string" || !FILE_ID.test(file))) continue;
    out.chunks.set(m[1]!, {
      r: rev as number,
      t: at,
      n: n as number,
      ...(file ? { f: file } : {}),
      ...(format ? { format } : {}),
    });
    if (out.chunks.size >= MAX_MEDIA_CHUNKS) break;
  }
  return out;
}

/** Folder of a scene's bakes, or null without a world id or with an unexpected scene id. */
export function bakeDir(sceneId: string): string | null {
  const world = worldId();
  if (!world || !SCENE_ID.test(sceneId)) return null;
  return `worlds/${world}/${MODULE_ID}/${sceneId}`;
}

export function bakePath(sceneId: string, key: string, file?: string, format: "png" | "json" = "png"): string | null {
  const dir = bakeDir(sceneId);
  return dir &&
    parseChunkKey(key) &&
    (file === undefined || FILE_ID.test(file)) &&
    (format === "png" || format === "json")
    ? `${dir}/${key}${file ? `_${file}` : ""}.${format}`
    : null;
}

export type MediaRefusal = "budget" | "count" | "upload" | "unavailable";

interface SceneQueue {
  scene: FoundryScene;
  generation: number;
  sets: Map<string, MediaChunkMeta>;
  deletes: Set<string>;
  clear: boolean;
  clearedAt: number | null;
  saved: Set<string>;
  paper: PaperId | null;
  failures: number;
}

/**
 * The active GM's bake store: uploads bake files one at a time and batches
 * the flag updates.
 */
export class MediaWriter {
  readonly #budget: () => number;
  readonly #dirs = new Set<string>();
  readonly #pending = new Map<string, SceneQueue>();
  readonly #inflight = new Map<string, SceneQueue>();
  /** Clear generation per scene: uploads started before a clear are not recorded. */
  readonly #generation = new Map<string, number>();
  readonly #removed = new Map<string, Map<string, number>>();
  readonly #failedUploads = new Set<string>();
  #uploads: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writing: Promise<void> = Promise.resolve();
  onError: ((err: unknown) => void) | null = null;

  constructor(budgetBytes: () => number) {
    this.#budget = budgetBytes;
  }

  #queue(scene: FoundryScene): SceneQueue {
    let q = this.#pending.get(scene.id);
    if (!q) {
      q = {
        scene,
        generation: this.#generation.get(scene.id) ?? 0,
        sets: new Map(),
        deletes: new Set(),
        clear: false,
        clearedAt: null,
        saved: new Set(),
        paper: null,
        failures: 0,
      };
      this.#pending.set(scene.id, q);
    }
    return q;
  }

  /** Current metadata including queued changes. */
  #current(scene: FoundryScene): Map<string, MediaChunkMeta> {
    const chunks = readMedia(scene).chunks;
    for (const q of [this.#inflight.get(scene.id), this.#pending.get(scene.id)]) {
      if (!q) continue;
      if (q.clear) chunks.clear();
      for (const k of q.deletes) chunks.delete(k);
      for (const [k, v] of q.sets) chunks.set(k, v);
    }
    return chunks;
  }

  /** Check the budget for a bake of `bytes` replacing the chunk's previous bake. */
  check(scene: FoundryScene, key: string, bytes: number): MediaRefusal | null {
    if (!filePicker() || !bakeDir(scene.id)) return "unavailable";
    const chunks = this.#current(scene);
    const before = chunks.get(key);
    if (!before && chunks.size >= MAX_MEDIA_CHUNKS) return "count";
    let used = 0;
    for (const m of chunks.values()) used += m.n;
    if (used - (before?.n ?? 0) + bytes > this.#budget()) return "budget";
    return null;
  }

  /** Upload a bake and record it. Resolves with a refusal reason, or null when stored. */
  store(
    scene: FoundryScene,
    key: string,
    png: Uint8Array,
    bakedAt: number,
    onQueued?: (meta: MediaChunkMeta) => void,
  ): Promise<MediaRefusal | null> {
    if (!parseChunkKey(key) || png.byteLength < 1 || png.byteLength > MAX_BAKE_BYTES) return Promise.resolve("upload");
    const data = encodeBakeFile(png);
    const token = `${scene.id}/${key}`;
    const refusal = this.check(scene, key, data.byteLength);
    if (refusal) {
      this.#failedUploads.add(token);
      return Promise.resolve(refusal);
    }
    const gen = this.#generation.get(scene.id) ?? 0;
    const removal = this.#removed.get(scene.id)?.get(key);
    const current = () =>
      (this.#generation.get(scene.id) ?? 0) === gen && this.#removed.get(scene.id)?.get(key) === removal;
    const task = this.#uploads.then(async () => {
      if (!current()) return null;
      const again = this.check(scene, key, data.byteLength);
      if (again) return again;
      const f = randomId(16);
      for (let attempt = 0; ; attempt++) {
        if (!current()) return null;
        try {
          await this.#upload(scene.id, `${key}_${f}`, data);
          break;
        } catch (err) {
          // A previously created directory may have been removed since the last upload.
          this.#dirs.clear();
          if (attempt >= 2) throw err;
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      if (!current()) return null;
      const prev = this.#current(scene).get(key);
      const q = this.#queue(scene);
      q.failures = 0;
      q.deletes.delete(key);
      const meta: MediaChunkMeta = {
        r: (prev?.r ?? 0) + 1,
        t: Math.round(bakedAt),
        n: data.byteLength,
        f,
        format: "json",
      };
      q.sets.set(key, meta);
      this.#failedUploads.delete(token);
      onQueued?.(meta);
      this.#schedule();
      return null;
    });
    const result = task.then(
      (refusal) => {
        if (refusal && current()) this.#failedUploads.add(token);
        return refusal;
      },
      (err) => {
        if (current()) this.#failedUploads.add(token);
        this.onError?.(err);
        return "upload" as const;
      },
    );
    this.#uploads = result;
    return result;
  }

  async #upload(sceneId: string, key: string, data: Uint8Array): Promise<void> {
    const fp = filePicker();
    const dir = bakeDir(sceneId);
    if (!fp || !dir) throw new Error("Paint storage unavailable");
    await this.#ensureDir(fp, dir);
    const file = new File([data as BlobPart], `${key}.json`, { type: "application/json" });
    const result = await fp.upload("data", dir, file, {}, { notify: false });
    if (
      !result ||
      typeof result !== "object" ||
      result.path !== `${dir}/${file.name}` ||
      (result.status !== undefined && result.status !== "success")
    )
      throw new Error(`Paint upload did not confirm the expected file: ${dir}/${file.name}`);
  }

  async #ensureDir(fp: FilePickerStatic, dir: string): Promise<void> {
    if (this.#dirs.has(dir)) return;
    const parts = dir.split("/");
    for (let i = 2; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      if (this.#dirs.has(path)) continue;
      try {
        await fp.createDirectory("data", path, {});
      } catch {
        // Exists already (or the server refused; the upload reports the real failure).
      }
      this.#dirs.add(path);
    }
  }

  remove(scene: FoundryScene, keys: Iterable<string>): void {
    const q = this.#queue(scene);
    q.failures = 0;
    let removed = this.#removed.get(scene.id);
    if (!removed) this.#removed.set(scene.id, (removed = new Map()));
    for (const key of keys) {
      this.#failedUploads.delete(`${scene.id}/${key}`);
      removed.set(key, (removed.get(key) ?? 0) + 1);
      q.sets.delete(key);
      q.deletes.add(key);
    }
    this.#schedule();
  }

  /** Forget every bake of a scene. The files stay on disk. */
  clear(scene: FoundryScene, at = game.time?.serverTime ?? Date.now()): void {
    for (const token of this.#failedUploads) if (token.startsWith(`${scene.id}/`)) this.#failedUploads.delete(token);
    const generation = (this.#generation.get(scene.id) ?? 0) + 1;
    this.#generation.set(scene.id, generation);
    this.#removed.delete(scene.id);
    const q = this.#queue(scene);
    q.generation = generation;
    q.sets.clear();
    q.deletes.clear();
    q.clear = true;
    q.clearedAt = at;
    q.saved.clear();
    q.failures = 0;
    this.#schedule();
  }

  setPaper(scene: FoundryScene, paper: PaperId): void {
    this.#queue(scene).paper = paper;
    this.#schedule();
  }

  /** Publish bounded receipts only after the associated files and Scene references are durable. */
  acknowledge(scene: FoundryScene, ids: readonly string[]): void {
    const known = new Set(readMedia(scene).saved);
    const fresh = ids.slice(-512).filter((id) => !known.has(id));
    if (!fresh.length) return;
    const q = this.#queue(scene);
    for (const id of fresh) q.saved.add(id);
    this.#schedule();
  }

  #schedule(delay = 250): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#writing = this.#writing.then(() => this.#flush());
    }, delay);
  }

  /** Preserve a failed write without overwriting newer edits or reviving cleared paint. */
  #retry(q: SceneQueue): void {
    if (q.generation !== (this.#generation.get(q.scene.id) ?? 0)) return;
    q.failures++;
    const next = this.#pending.get(q.scene.id);
    if (!next) this.#pending.set(q.scene.id, q);
    else {
      next.paper ??= q.paper;
      next.clearedAt ??= q.clearedAt;
      if (!next.clear) for (const id of q.saved) next.saved.add(id);
      if (!next.clear) {
        for (const [key, meta] of q.sets) if (!next.sets.has(key) && !next.deletes.has(key)) next.sets.set(key, meta);
        for (const key of q.deletes) if (!next.sets.has(key)) next.deletes.add(key);
        next.clear = q.clear;
      }
      next.failures = q.failures;
    }
    if (q.failures < 3) this.#schedule(1000);
  }

  async #flush(): Promise<void> {
    const queues = [...this.#pending.values()];
    this.#pending.clear();
    for (const q of queues) this.#inflight.set(q.scene.id, q);
    for (const q of queues) {
      const current = () => q.generation === (this.#generation.get(q.scene.id) ?? 0);
      const base = `flags.${MODULE_ID}.${FLAG_MEDIA}`;
      const data: Record<string, unknown> = {};
      const stored = readMedia(q.scene).chunks;
      if (q.clear && stored.size) Object.assign(data, deletion(base, "chunks"));
      else
        for (const key of q.deletes) if (stored.has(key)) Object.assign(data, deletion(`${base}.chunks`, flagKey(key)));
      for (const [key, meta] of q.sets) data[`${base}.chunks.${flagKey(key)}`] = meta;
      if (q.paper) data[`${base}.paper`] = q.paper;
      if (q.clearedAt !== null) data[`${base}.clearedAt`] = q.clearedAt;
      if (q.clear || q.saved.size) {
        const before = q.clear ? [] : readMedia(q.scene).saved;
        data[`${base}.saved`] = [...new Set([...before, ...q.saved])].slice(-512);
      }
      try {
        if (!current() || !Object.keys(data).length) continue;
        // A deletion and new keys under the same object cannot share one update: clear first.
        if (q.clear && stored.size && q.sets.size) {
          await q.scene.update(deletion(base, "chunks"), { render: false, animate: false });
          if (!current()) continue;
          delete data[Object.keys(deletion(base, "chunks"))[0]!];
        }
        await q.scene.update(data, { render: false, animate: false });
      } catch (err) {
        this.#retry(q);
        this.onError?.(err);
      } finally {
        this.#inflight.delete(q.scene.id);
      }
    }
  }

  /** Wait for uploads and flag writes, retrying failed writes a bounded number of times. */
  async drain(): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.#uploads;
      if (this.#timer) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
      if (this.#pending.size) this.#writing = this.#writing.then(() => this.#flush());
      await this.#writing;
      if (!this.#pending.size) return !this.#failedUploads.size;
    }
    return false;
  }
}
