import { LIMITS } from "../constants.ts";
import { boundsOf } from "./geometry.ts";
import type { Bounds } from "./geometry.ts";
import { goneAt } from "./lifetime.ts";
import type { ScribbleItem } from "./types.ts";

/**
 * Where an item currently lives:
 *  - `live`: being drawn right now (local or remote), points still arriving
 *  - `temp`: finished temporary item (memory only, expires)
 *  - `pending`: permanent item waiting for the GM's Scene write
 *  - `stored`: permanent item read from the Scene flags
 */
export type EntryState = "live" | "temp" | "pending" | "stored";

export interface Entry {
  readonly item: ScribbleItem;
  readonly state: EntryState;
  /** Bounds of the item's points in space units, padded by half the stroke size. */
  readonly bounds: Bounds;
  /** Local insertion order; stable z-order for items with equal createdAt. */
  readonly seq: number;
}

export type StoreEvent =
  | { type: "add"; entry: Entry }
  | { type: "update"; entry: Entry; previous: Entry }
  | { type: "remove"; entry: Entry }
  | { type: "reset" };

/** Bounds used for culling and hit tests: geometry padded by the stroke/arrow/text extent. */
export function itemBounds(item: ScribbleItem): Bounds {
  let pad = item.size * 0.75 + 2;
  if (item.kind === "shape" && item.tool === "arrow") pad += item.size * 5;
  if (item.style.head && item.style.head !== "none") pad += item.size * 5;
  if (item.tool === "highlighter") pad += item.size * 1.5;
  if (item.kind === "text") {
    const lines = (item.text ?? "").split("\n");
    const longest = Math.max(...lines.map((l) => l.length), 1);
    const [x, y] = [item.points[0] ?? 0, item.points[1] ?? 0];
    const w = longest * item.size * 0.62 + item.size;
    const h = lines.length * item.size * 1.25 + item.size * 0.5;
    return [x - item.size * 0.3, y - item.size * 0.3, x + w, y + h];
  }
  return boundsOf(item.points, pad);
}

/**
 * In-memory index of the items of the viewed scene, for both spaces. The
 * renderer and the hit tests read it; network, persistence and history write
 * it. Change notifications are synchronous.
 */
export class ItemStore {
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<(e: StoreEvent) => void>();
  #seq = 0;

  get size(): number {
    return this.#entries.size;
  }

  on(fn: (e: StoreEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(e: StoreEvent): void {
    for (const fn of this.#listeners) fn(e);
  }

  get(id: string): Entry | undefined {
    return this.#entries.get(id);
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  values(): IterableIterator<Entry> {
    return this.#entries.values();
  }

  /** Entries in drawing order (oldest first). */
  ordered(filter?: (e: Entry) => boolean): Entry[] {
    const list = [...this.#entries.values()].filter((e) => !filter || filter(e));
    return list.sort((a, b) => a.item.createdAt - b.item.createdAt || a.seq - b.seq);
  }

  /** Insert or replace. Returns the stored entry. */
  put(item: ScribbleItem, state: EntryState): Entry {
    const previous = this.#entries.get(item.id);
    const entry: Entry = { item, state, bounds: itemBounds(item), seq: previous?.seq ?? ++this.#seq };
    this.#entries.set(item.id, entry);
    if (previous) this.#emit({ type: "update", entry, previous });
    else this.#emit({ type: "add", entry });
    if (!previous && (state === "temp" || state === "live")) this.#enforceTemporaryLimits(item.author);
    return entry;
  }

  remove(id: string): Entry | undefined {
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    this.#entries.delete(id);
    this.#emit({ type: "remove", entry });
    return entry;
  }

  /** Remove everything (scene change). */
  reset(): void {
    this.#entries.clear();
    this.#emit({ type: "reset" });
  }

  /** Drop temporary items that are completely gone at `now`. Returns removed entries. */
  sweep(now: number): Entry[] {
    const removed: Entry[] = [];
    for (const entry of [...this.#entries.values()]) {
      if (entry.state !== "temp") continue;
      if (now >= goneAt(entry.item)) {
        this.remove(entry.item.id);
        removed.push(entry);
      }
    }
    return removed;
  }

  /** Keep the number of temporary items bounded; the oldest go first. */
  #enforceTemporaryLimits(author: string): void {
    // Count first: sorting on every insert would make bulk inserts (late-join sync) quadratic.
    let mineCount = 0;
    let tempCount = 0;
    for (const e of this.#entries.values()) {
      if (e.state !== "temp" && e.state !== "live") continue;
      if (e.item.author === author) mineCount++;
      if (e.state === "temp") tempCount++;
    }
    if (mineCount <= LIMITS.maxTemporaryPerAuthor && tempCount <= LIMITS.maxTemporaryTotal) return;
    const temps = this.ordered((e) => e.state === "temp" || e.state === "live");
    const mine = temps.filter((e) => e.item.author === author);
    let excess = mine.length - LIMITS.maxTemporaryPerAuthor;
    for (const e of mine) {
      if (excess-- <= 0) break;
      if (e.state === "temp") this.remove(e.item.id);
    }
    const all = this.ordered((e) => e.state === "temp");
    let total = all.length - LIMITS.maxTemporaryTotal;
    for (const e of all) {
      if (total-- <= 0) break;
      this.remove(e.item.id);
    }
  }
}
