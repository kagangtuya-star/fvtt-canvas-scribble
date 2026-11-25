import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { LIMITS, MODULE_ID } from "../src/constants.ts";
import { toWire } from "../src/core/sanitize.ts";
import { SceneWriter, readStored, sceneRef, storedBytes } from "../src/foundry/persistence.ts";
import { ALICE, BOB, SCENE, makeItem } from "./helpers.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = globalThis as any;

/** Scene stand-in that applies flat update keys like Foundry (including `-=` deletion). */
function fakeScene(items: Record<string, unknown> = {}) {
  const updates: Record<string, unknown>[] = [];
  const scene: any = {
    id: SCENE,
    width: 3000,
    height: 2000,
    flags: { [MODULE_ID]: { items: { ...items } } },
    updates,
    async update(data: Record<string, unknown>) {
      updates.push(data);
      const flags = scene.flags[MODULE_ID];
      for (const [key, value] of Object.entries(data)) {
        const path = key.split(".").slice(2);
        if (path[0] === "items") {
          flags.items ??= {};
          if (path[1]!.startsWith("-=")) delete flags.items[path[1]!.slice(2)];
          else flags.items[path[1]!] = value;
        } else flags[path[0]!] = value;
      }
    },
  };
  return scene;
}

const flush = () => new Promise((r) => setTimeout(r, 120));

describe("persistence", () => {
  before(() => {
    G.game = { release: { generation: 13 } };
  });
  after(() => {
    delete G.game;
  });

  it("reads stored items with their stored author, and only permanent map items", () => {
    const perm = makeItem({ author: BOB, expiresAt: null });
    const temp = makeItem({ author: BOB });
    const screen = makeItem({ author: BOB, mode: "screen", expiresAt: null });
    const scene = fakeScene();
    assert.equal(readStored(scene, perm.id, toWire(perm), 0)?.author, BOB);
    assert.equal(readStored(scene, temp.id, toWire(temp), 0), null);
    assert.equal(readStored(scene, screen.id, toWire(screen), 0), null);
    assert.equal(readStored(scene, "OtherIdAaaaaaaa1", toWire(perm), 0), null, "key must match the id");
    assert.equal(readStored(scene, perm.id, { ...toWire(perm), author: "bad id!" }, 0), null);
  });

  it("falls back to the scene size when no reference size is stored", () => {
    assert.deepEqual(sceneRef(fakeScene()), { w: 3000, h: 2000 });
  });

  it("batches writes and deletions into one scene update with a reference size", async () => {
    const scene = fakeScene();
    const writer = new SceneWriter(() => 1024 * 1024);
    const a = makeItem({ expiresAt: null });
    const b = makeItem({ expiresAt: null });
    assert.equal(writer.write(scene, a), null);
    assert.equal(writer.write(scene, b), null);
    await flush();
    assert.equal(scene.updates.length, 1);
    assert.deepEqual(scene.flags[MODULE_ID].ref, { w: 3000, h: 2000 });
    assert.equal(storedBytes(scene).count, 2);
    writer.delete(scene, [a.id]);
    await flush();
    assert.ok(Object.keys(scene.updates[1]).some((k) => k.endsWith(`-=${a.id}`)));
    assert.deepEqual(Object.keys(scene.flags[MODULE_ID].items), [b.id]);
  });

  it("exposes queued and in-flight items, and deletes them after the write lands", async () => {
    const scene = fakeScene();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const update = scene.update;
    scene.update = async (data: Record<string, unknown>) => {
      await gate;
      return update(data);
    };
    const writer = new SceneWriter(() => 1e9);
    const a = makeItem({ expiresAt: null, author: BOB });
    writer.write(scene, a);
    assert.equal(writer.queued(scene, a.id)?.author, BOB, "queued");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(writer.queued(scene, a.id)?.author, BOB, "in flight");
    writer.delete(scene, [a.id]);
    release();
    await flush();
    await flush();
    assert.equal(writer.queued(scene, a.id), undefined);
    assert.deepEqual(Object.keys(scene.flags[MODULE_ID].items), []);
  });

  it("refuses writes over the byte budget", () => {
    const scene = fakeScene();
    const item = makeItem({ expiresAt: null });
    const writer = new SceneWriter(() => 100);
    assert.equal(writer.write(scene, item), "budget");
  });

  it("refuses writes over the item count", () => {
    const items: Record<string, unknown> = {};
    for (let i = 0; i < LIMITS.maxPersistentItems; i++)
      items[`Stored${String(i).padStart(10, "0")}`] = { author: ALICE };
    const scene = fakeScene(items);
    const writer = new SceneWriter(() => 1e9);
    assert.equal(writer.write(scene, makeItem({ expiresAt: null })), "count");
  });

  it("uses the v14 deletion operator when available", async () => {
    G.game = { release: { generation: 14 } };
    G._del = Symbol("del");
    try {
      const a = makeItem({ expiresAt: null });
      const scene = fakeScene({ [a.id]: toWire(a) });
      const writer = new SceneWriter(() => 1e9);
      writer.delete(scene, [a.id]);
      await flush().catch(() => {});
      const keys = Object.keys(scene.updates[0] ?? {});
      assert.deepEqual(keys, [`flags.${MODULE_ID}.items.${a.id}`]);
      assert.equal(scene.updates[0][keys[0]!], G._del);
    } finally {
      delete G._del;
      G.game = { release: { generation: 13 } };
    }
  });
});
