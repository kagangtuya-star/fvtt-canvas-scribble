import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIMITS } from "../src/constants.ts";
import { History } from "../src/core/history.ts";
import type { HistoryExecutor } from "../src/core/history.ts";
import { ItemStore, itemBounds } from "../src/core/store.ts";
import type { StoreEvent } from "../src/core/store.ts";
import type { ScribbleItem } from "../src/core/types.ts";
import { ALICE, BOB, makeItem } from "./helpers.ts";

describe("ItemStore", () => {
  it("emits add/update/remove/reset and keeps sequence on update", () => {
    const store = new ItemStore();
    const events: StoreEvent["type"][] = [];
    store.on((e) => events.push(e.type));
    const item = makeItem();
    const a = store.put(item, "live");
    const b = store.put({ ...item, revision: 1 }, "temp");
    assert.equal(a.seq, b.seq);
    store.remove(item.id);
    store.put(makeItem(), "temp");
    store.reset();
    assert.deepEqual(events, ["add", "update", "remove", "add", "reset"]);
    assert.equal(store.size, 0);
  });

  it("orders by createdAt, then insertion", () => {
    const store = new ItemStore();
    const late = store.put(makeItem({ createdAt: 20 }), "temp");
    const early = store.put(makeItem({ createdAt: 10 }), "temp");
    const tie = store.put(makeItem({ createdAt: 20 }), "temp");
    assert.deepEqual(
      store.ordered().map((e) => e.item.id),
      [early.item.id, late.item.id, tie.item.id],
    );
  });

  it("sweeps only temporary items that are completely gone", () => {
    const store = new ItemStore();
    const gone = store.put(makeItem({ expiresAt: 100, fadeDuration: 50 }), "temp");
    const fading = store.put(makeItem({ expiresAt: 100, fadeDuration: 500 }), "temp");
    store.put(makeItem({ expiresAt: 100, fadeDuration: 0 }), "live");
    store.put(makeItem({ expiresAt: null }), "stored");
    const removed = store.sweep(200);
    assert.deepEqual(
      removed.map((e) => e.item.id),
      [gone.item.id],
    );
    assert.ok(store.has(fading.item.id));
    assert.equal(store.size, 3);
  });

  it("bounds temporary items per author (oldest first)", () => {
    const store = new ItemStore();
    const first = store.put(makeItem({ author: BOB, createdAt: 0 }), "temp");
    for (let i = 1; i <= LIMITS.maxTemporaryPerAuthor; i++) store.put(makeItem({ author: BOB, createdAt: i }), "temp");
    store.put(makeItem({ author: ALICE, createdAt: 0 }), "temp");
    assert.ok(!store.has(first.item.id));
    assert.equal(store.size, LIMITS.maxTemporaryPerAuthor + 1);
  });

  it("pads bounds for stroke width, arrow heads and text", () => {
    const plain = itemBounds(makeItem({ size: 4, points: [0, 0, 0.5, 10, 0, 0.5] }));
    assert.ok(plain[0] < 0 && plain[2] > 10);
    const arrow = itemBounds(makeItem({ kind: "shape", tool: "arrow", size: 4, points: [0, 0, 0.5, 10, 0, 0.5] }));
    assert.ok(arrow[2] - arrow[0] > plain[2] - plain[0]);
    const text = itemBounds(
      makeItem({ kind: "text", tool: "text", size: 20, text: "hello\nworld", points: [100, 100, 0.5] }),
    );
    assert.ok(text[3] - text[1] >= 40 && text[2] - text[0] > 50);
  });
});

/** Minimal executor over a Map, recording calls. */
function harness() {
  const items = new Map<string, ScribbleItem>();
  const calls: string[] = [];
  let now = 0;
  const exec: HistoryExecutor = {
    restore: (list) => list.forEach((i) => (calls.push(`restore ${i.id}`), items.set(i.id, i))),
    remove: (list) => list.forEach((i) => (calls.push(`remove ${i.id}`), items.delete(i.id))),
    replace: (list) => list.forEach((i) => (calls.push(`replace ${i.id}@${i.revision}`), items.set(i.id, i))),
    usable: (i) => i.expiresAt === null || now < i.expiresAt + i.fadeDuration,
  };
  return { items, calls, exec, setNow: (t: number) => (now = t) };
}

describe("History", () => {
  it("undoes and redoes create, delete and update", () => {
    const { items, exec } = harness();
    const h = new History();
    const a = makeItem({ createdAt: 0, expiresAt: 1000 });
    items.set(a.id, a);
    h.record({ type: "create", items: [a] });
    const a2 = { ...a, revision: 1 };
    items.set(a.id, a2);
    h.record({ type: "update", before: [a], after: [a2] });
    items.delete(a.id);
    h.record({ type: "delete", items: [a2] });

    h.undo(exec);
    assert.equal(items.get(a.id)?.revision, 1);
    h.undo(exec);
    assert.equal(items.get(a.id)?.revision, 0);
    h.undo(exec);
    assert.ok(!items.has(a.id));
    assert.equal(h.undo(exec), null);
    h.redo(exec);
    h.redo(exec);
    assert.equal(items.get(a.id)?.revision, 1);
    h.redo(exec);
    assert.ok(!items.has(a.id));
  });

  it("skips commands whose temporary items expired", () => {
    const { exec, setNow, calls } = harness();
    const h = new History();
    const old = makeItem({ expiresAt: 100, fadeDuration: 0 });
    const fresh = makeItem({ expiresAt: 10_000, fadeDuration: 0 });
    h.record({ type: "create", items: [fresh] });
    h.record({ type: "create", items: [old] });
    setNow(500);
    const cmd = h.undo(exec);
    assert.equal(cmd?.type, "create");
    assert.deepEqual(calls, [`remove ${fresh.id}`]);
  });

  it("clears redo on a new command and respects the limit", () => {
    const { exec } = harness();
    const h = new History(3);
    for (let i = 0; i < 5; i++) h.record({ type: "create", items: [makeItem({ expiresAt: null })] });
    assert.equal(h.size.undo, 3);
    h.undo(exec);
    assert.equal(h.size.redo, 1);
    h.record({ type: "create", items: [makeItem({ expiresAt: null })] });
    assert.equal(h.size.redo, 0);
  });

  it("prunes commands that only refer to expired items", () => {
    const { exec, setNow } = harness();
    const h = new History();
    h.record({ type: "create", items: [makeItem({ expiresAt: 100, fadeDuration: 0 })] });
    h.record({ type: "create", items: [makeItem({ expiresAt: null })] });
    setNow(1000);
    h.prune(exec);
    assert.equal(h.size.undo, 1);
  });
});
