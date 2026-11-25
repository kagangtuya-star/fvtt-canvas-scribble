import { LIMITS, MODULE_ID } from "../constants.ts";
import { sanitizeItem, toWire, wireSize } from "../core/sanitize.ts";
import type { ScribbleItem, WireItem } from "../core/types.ts";
import { deletion } from "./compat.ts";

/**
 * Permanent map annotations live in the Scene document:
 *
 *   flags.canvas-scribble.items.<id> = WireItem   (one key per item)
 *   flags.canvas-scribble.ref        = { w, h }   (reference scene size of the coordinates)
 *
 * One key per item keeps every write a small diff (adding a stroke never
 * resends the others). Only the active GM writes: players send their
 * permanent items over the socket, the GM re-validates them (author forced
 * to the authenticated sender, role, budget) and batches the writes.
 */

export const FLAG_ITEMS = "items";
export const FLAG_REF = "ref";

export interface SceneRef {
  w: number;
  h: number;
}

type SceneLike = FoundryScene & {
  dimensions?: { sceneWidth?: number; sceneHeight?: number };
  width?: number;
  height?: number;
};

function flagsOf(scene: FoundryScene): Record<string, unknown> {
  return (scene.flags?.[MODULE_ID] ?? {}) as Record<string, unknown>;
}

/** Raw stored items (unvalidated). */
export function rawItems(scene: FoundryScene): Record<string, unknown> {
  const items = flagsOf(scene)[FLAG_ITEMS];
  return items && typeof items === "object" ? (items as Record<string, unknown>) : {};
}

/** Current scene rectangle size (document dimensions, valid for scenes that are not viewed). */
export function sceneSize(scene: FoundryScene): SceneRef {
  const s = scene as SceneLike;
  const w = s.dimensions?.sceneWidth ?? s.width ?? 4000;
  const h = s.dimensions?.sceneHeight ?? s.height ?? 3000;
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

/** Reference size of stored coordinates; falls back to the current size. */
export function sceneRef(scene: FoundryScene): SceneRef {
  const ref = flagsOf(scene)[FLAG_REF] as Partial<SceneRef> | undefined;
  if (ref && Number.isFinite(ref.w) && Number.isFinite(ref.h) && ref.w! > 0 && ref.h! > 0)
    return { w: ref.w!, h: ref.h! };
  return sceneSize(scene);
}

const USER_ID = /^[A-Za-z0-9]{1,32}$/;

/**
 * Validate one stored item. Stored data was written by a GM after
 * validation, but Scene flags can be edited by any scene owner, so it is
 * checked again; the stored author is kept (it is not a socket claim).
 */
export function readStored(scene: FoundryScene, id: string, raw: unknown, now: number): ScribbleItem | null {
  if (!raw || typeof raw !== "object") return null;
  const author = (raw as { author?: unknown }).author;
  if (typeof author !== "string" || !USER_ID.test(author)) return null;
  const ref = sceneRef(scene);
  const item = sanitizeItem(raw, {
    author,
    scene: scene.id,
    now,
    allowPermanent: true,
    allowExpired: true,
    mapExtent: { w: ref.w, h: ref.h },
  });
  if (!item || item.id !== id || item.mode !== "map" || item.expiresAt !== null) return null;
  return item;
}

/** Approximate stored bytes of the module's items in a scene. */
export function storedBytes(scene: FoundryScene): { bytes: number; count: number } {
  const items = rawItems(scene);
  let bytes = 0;
  let count = 0;
  for (const value of Object.values(items)) {
    if (!value) continue;
    count++;
    try {
      bytes += JSON.stringify(value).length;
    } catch {
      /* ignore */
    }
  }
  return { bytes, count };
}

export type WriteRefusal = "budget" | "count";

interface Pending {
  scene: FoundryScene;
  sets: Map<string, WireItem>;
  deletes: Set<string>;
  /** Stored usage when the batch was opened (computed once per batch). */
  base: { bytes: number; count: number };
  addedBytes: number;
  addedCount: number;
}

/**
 * Batches Scene flag writes on the active GM (several strokes per update,
 * at most one update in flight per scene).
 */
export class SceneWriter {
  readonly #pending = new Map<string, Pending>();
  /** Batches currently being written (their items are not in the Scene flags yet). */
  #writing: Pending[] = [];
  readonly #budget: () => number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inflight: Promise<void> = Promise.resolve();
  onError: ((err: unknown) => void) | null = null;

  constructor(budgetBytes: () => number) {
    this.#budget = budgetBytes;
  }

  #batch(scene: FoundryScene): Pending {
    let p = this.#pending.get(scene.id);
    if (!p) {
      p = { scene, sets: new Map(), deletes: new Set(), base: storedBytes(scene), addedBytes: 0, addedCount: 0 };
      this.#pending.set(scene.id, p);
    }
    return p;
  }

  /** Queue an item write. Returns a refusal reason when the scene's budget would be exceeded. */
  write(scene: FoundryScene, item: ScribbleItem): WriteRefusal | null {
    const wire = toWire(item);
    const size = wireSize(wire);
    const p = this.#batch(scene);
    const existing = rawItems(scene)[item.id];
    const isNew = !existing && !p.sets.has(item.id);
    if (isNew) {
      const used = p.base;
      if (used.count + p.addedCount + 1 > LIMITS.maxPersistentItems) return "count";
      if (used.bytes + p.addedBytes + size > this.#budget()) return "budget";
      p.addedBytes += size;
      p.addedCount++;
    } else if (existing) {
      // Updates may grow an item (partial erase masks); they still respect the budget.
      let before = 0;
      try {
        before = JSON.stringify(existing).length;
      } catch {
        /* ignore */
      }
      const used = p.base;
      if (size > before && used.bytes + p.addedBytes + (size - before) > this.#budget()) return "budget";
      p.addedBytes += Math.max(0, size - before);
    }
    p.deletes.delete(item.id);
    p.sets.set(item.id, wire);
    this.#schedule();
    return null;
  }

  /** An item queued or being written for a scene (not yet visible in its flags). */
  queued(scene: FoundryScene, id: string): WireItem | undefined {
    const pending = this.#pending.get(scene.id)?.sets.get(id);
    if (pending) return pending;
    for (const p of this.#writing) if (p.scene.id === scene.id && p.sets.has(id)) return p.sets.get(id);
    return undefined;
  }

  delete(scene: FoundryScene, ids: Iterable<string>): void {
    const p = this.#batch(scene);
    for (const id of ids) {
      p.sets.delete(id);
      p.deletes.add(id);
    }
    this.#schedule();
  }

  #schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#inflight = this.#inflight.then(() => this.#flush());
    }, 60);
  }

  async #flush(): Promise<void> {
    const batches = [...this.#pending.values()];
    this.#pending.clear();
    this.#writing = batches;
    for (const p of batches) {
      const data: Record<string, unknown> = {};
      const base = `flags.${MODULE_ID}.${FLAG_ITEMS}`;
      const stored = rawItems(p.scene);
      for (const id of p.deletes) if (id in stored) Object.assign(data, deletion(base, id));
      for (const [id, wire] of p.sets) data[`${base}.${id}`] = wire;
      if (p.sets.size && !flagsOf(p.scene)[FLAG_REF]) data[`flags.${MODULE_ID}.${FLAG_REF}`] = sceneSize(p.scene);
      if (!Object.keys(data).length) continue;
      try {
        await p.scene.update(data, { render: false, animate: false });
      } catch (err) {
        this.onError?.(err);
      }
    }
    this.#writing = [];
  }

  /** Wait for queued writes (tests, scene change). */
  async drain(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.#inflight = this.#inflight.then(() => this.#flush());
    }
    await this.#inflight;
  }
}
