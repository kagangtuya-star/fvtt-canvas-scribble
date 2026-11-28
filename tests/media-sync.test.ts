import assert from "node:assert/strict";
import { it } from "node:test";
import type { TestContext } from "node:test";
import { MODULE_ID } from "../src/constants.ts";
import { bakePath, MediaWriter, readMedia } from "../src/foundry/media-store.ts";
import type { MediaChunkMeta } from "../src/foundry/media-store.ts";
import { decodeBake, decodeBakeFile, encodeBakeFile } from "../src/media/bake.ts";
import { MediaController } from "../src/media/controller.ts";
import type { MediaHost } from "../src/media/controller.ts";
import type { EngineIn, EngineOut } from "../src/media/engine.ts";
import { strokeToWire } from "../src/media/ops.ts";
import type { Message } from "../src/net/protocol.ts";

const NOW = 123_000;
const KEY = "0_0";
const FLAG = `flags.${MODULE_ID}.media.chunks`;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setGlobal(t: TestContext, key: string, value: unknown) {
  const before = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, key, before);
    else Reflect.deleteProperty(globalThis, key);
  });
}

function setup(t: TestContext, updates: (data: Record<string, unknown>) => Promise<void> = async () => {}) {
  const uploads: string[] = [];
  const files = new Map<string, Uint8Array>();
  const chunks: Record<string, MediaChunkMeta> = {};
  const game = {
    user: { id: "gm" },
    users: { activeGM: { id: "gm" } },
    world: { id: "test" },
    release: { generation: 13 },
  };
  setGlobal(t, "game", { ...game, settings: { get: () => undefined } });
  const picker: FilePickerStatic = {
    async upload(_source, dir, file) {
      uploads.push(file.name);
      const path = `${dir}/${file.name}`;
      files.set(path, new Uint8Array(await file.arrayBuffer()));
      return { status: "success", path };
    },
    async createDirectory() {},
  };
  setGlobal(t, "foundry", {
    applications: { apps: { FilePicker: picker } },
  });
  const scene = {
    id: "Scene1",
    flags: { [MODULE_ID]: { media: { chunks } } },
    async update(data: Record<string, unknown>) {
      await updates(data);
      for (const [path, value] of Object.entries(data)) {
        if (path.startsWith(`${FLAG}.-=`)) delete chunks[path.slice(FLAG.length + 3)];
        else if (path.startsWith(`${FLAG}.`)) chunks[path.slice(FLAG.length + 1)] = value as MediaChunkMeta;
        else if (path === `flags.${MODULE_ID}.media.-=chunks`)
          for (const key of Object.keys(chunks)) delete chunks[key];
      }
    },
  } as unknown as FoundryScene;
  return { scene, uploads, chunks, files, picker };
}

function controller(t: TestContext, scene: FoundryScene, options: { inline?: boolean; fetch?: typeof fetch } = {}) {
  const messages: EngineIn[] = [];
  const outbound: Partial<Message>[] = [];
  const destinations: (string | undefined)[] = [];
  let listener: ((event: { data: EngineOut }) => void) | undefined;
  setGlobal(
    t,
    "Worker",
    options.inline
      ? undefined
      : class {
          postMessage(msg: EngineIn) {
            messages.push(msg);
          }
          addEventListener(type: string, cb: typeof listener) {
            if (type === "message") listener = cb;
          }
          terminate() {}
        },
  );
  setGlobal(t, "fetch", options.fetch ?? (async () => new Response(Uint8Array.of(1))));
  const notices: { level: string; key: string }[] = [];
  const host = {
    scene,
    isRelay: true,
    now: () => NOW,
    net: {
      send: (msg: Partial<Message>, sceneId?: string) => {
        outbound.push(msg);
        destinations.push(sceneId);
      },
    },
    log: () => {},
    notify: (level: string, key: string): void => {
      notices.push({ level, key });
    },
  };
  const media = new MediaController(host as unknown as MediaHost);
  t.after(() => media.destroy());
  media.attach(scene);
  const begin = () =>
    media.begin({ brush: "ink", color: "#102030", size: 24, pigment: 0.8, water: 0.6 }, [100, 100, 0.7])!;
  return {
    host,
    media,
    messages,
    outbound,
    destinations,
    notices,
    begin,
    emit: (data: EngineOut) => listener?.({ data }),
  };
}

it("reserves pending and in-flight bake revisions and gives each published version its own file", async (t) => {
  const revisions: number[] = [];
  const started = deferred();
  const release = deferred();
  const { scene, uploads } = setup(t, async (data) => {
    revisions.push((data[`${FLAG}.c${KEY}`] as MediaChunkMeta).r);
    if (revisions.length === 1) {
      started.resolve();
      await release.promise;
    }
  });
  const png = new Uint8Array(100);
  const writer = new MediaWriter(() => encodeBakeFile(png).byteLength + 50);
  await writer.store(scene, KEY, png, NOW);
  const firstWrite = writer.drain();
  await started.promise;
  try {
    assert.equal(await writer.store(scene, "1_0", png, NOW + 1), "budget", "the in-flight file counts toward budget");
    assert.equal(await writer.store(scene, KEY, png, NOW + 1), null);
  } finally {
    release.resolve();
    await firstWrite;
    await writer.drain();
  }
  assert.deepEqual(revisions, [1, 2]);
  assert.equal(new Set(uploads).size, 2);
  const meta = readMedia(scene).chunks.get(KEY)!;
  assert.equal(bakePath(scene.id, KEY, meta.f, meta.format)?.split("/").at(-1), uploads[1]);
});

it("does not publish the second half of an earlier clear-and-save after another clear", async (t) => {
  const changes: Record<string, unknown>[] = [];
  const deleting = deferred();
  const release = deferred();
  const { scene, chunks } = setup(t, async (data) => {
    changes.push(data);
    if (changes.length === 1) {
      deleting.resolve();
      await release.promise;
    }
  });
  chunks.c0_0 = { r: 1, t: NOW - 1, n: 1 };
  const writer = new MediaWriter(() => 150);
  writer.clear(scene);
  await writer.store(scene, KEY, Uint8Array.of(1), NOW);
  const first = writer.drain();
  await deleting.promise;
  try {
    writer.clear(scene);
  } finally {
    release.resolve();
    await first;
    await writer.drain();
  }
  assert.equal(readMedia(scene).chunks.size, 0);
  assert.equal(
    changes.some((data) => `${FLAG}.c${KEY}` in data),
    false,
  );
});

it("replays a known wet stroke after changing away from the scene and returning", async (t) => {
  const { scene } = setup(t);
  const { host, media, messages } = controller(t, scene);
  const s = strokeToWire({
    id: "peerStroke",
    brush: "ink",
    color: "#102030",
    size: 24,
    pigment: 0.8,
    water: 0.6,
    seed: 7,
    points: [220, 100, 0.6, 420, 100, 0.6],
    at: NOW,
  });
  const sender = { id: "peer" } as FoundryUser;
  media.receive({ t: "me", s, v: 1, scene: scene.id }, sender, scene, true, () => true);
  media.detach();
  host.scene = { id: "Scene2", flags: {} } as FoundryScene;
  media.attach(host.scene);
  media.detach();
  host.scene = scene;
  media.attach(scene);
  await tick();
  assert.equal(messages.filter((m) => m.t === "stroke" && m.id === s.id).length, 2, "the peer need not answer mq");
  media.receive({ t: "mr", strokes: [s], to: "gm", v: 1, scene: scene.id }, sender, scene, true, () => true);
  assert.equal(messages.filter((m) => m.t === "stroke" && m.id === s.id).length, 2);

  media.detach();
  host.scene = { id: "Scene2", flags: {} } as FoundryScene;
  media.attach(host.scene);
  media.clearLocal(scene);
  media.detach();
  host.scene = scene;
  media.attach(scene);
  await tick();
  assert.equal(
    messages.filter((m) => m.t === "stroke" && m.id === s.id).length,
    2,
    "off-scene clear drops replay data",
  );
});

it("persists successful removal of a baked stroke and never broadcasts a rejected undo", async (t) => {
  const { scene, chunks } = setup(t);
  chunks.c0_0 = { r: 1, t: NOW - 1, n: 1 };
  const { media, messages, outbound, begin, emit } = controller(t, scene);
  await tick();
  emit({ t: "loaded", key: KEY, ok: true, revision: "1:" });
  media.end(begin());
  media.undo();
  const first = messages.findLast((m) => m.t === "undo")!;
  assert.equal(first.t, "undo");
  emit({ t: "undone", req: first.req, ok: false });
  assert.equal(
    outbound.some((m) => m.t === "mu"),
    false,
  );
  const id = begin();
  media.end(id);
  media.undo();
  const second = messages.findLast((m) => m.t === "undo")!;
  assert.equal(second.t, "undo");
  emit({ t: "undone", req: second.req, ok: true, removed: [KEY] });
  await media.writer.drain();
  assert.equal(readMedia(scene).chunks.has(KEY), false);
  assert.deepEqual(
    outbound.find((m) => m.t === "mu"),
    { t: "mu", id },
  );
});

it("does not replay a stroke if its undo is still in flight while returning to the scene", async (t) => {
  const { scene } = setup(t);
  const { host, media, messages, outbound, destinations, begin, emit } = controller(t, scene);
  const id = begin();
  media.end(id);
  media.undo();
  const undo = messages.findLast((m) => m.t === "undo")!;
  media.detach();
  host.scene = { id: "Scene2", flags: {} } as FoundryScene;
  media.attach(host.scene);
  media.detach();
  host.scene = scene;
  media.attach(scene);
  await tick();
  assert.equal(messages.filter((m) => m.t === "stroke" && m.id === id).length, 1);
  emit({ t: "undone", req: undo.req, ok: true, removed: [KEY] });
  const i = outbound.findIndex((m) => m.t === "mu" && m.id === id);
  assert.ok(i >= 0);
  assert.equal(destinations[i], scene.id);
  await media.writer.drain();
});

it("does not publish a pre-clear worker result, or remove paint drawn after the clear", async (t) => {
  const { scene, chunks, uploads } = setup(t);
  chunks.c0_0 = { r: 1, t: NOW - 1, n: 1 };
  const { media, messages, begin, emit } = controller(t, scene);
  media.end(begin());
  await tick();
  emit({ t: "loaded", key: KEY, ok: true, revision: "1:" });
  emit({ t: "dry", key: KEY, touched: NOW });
  const bake = messages.findLast((m) => m.t === "bake")!;
  assert.equal(bake.t, "bake");
  media.clearLocal();
  media.relayClear(scene);
  media.end(begin());
  emit({ t: "baked", req: bake.req, key: KEY, data: Uint8Array.of(1), empty: false, at: NOW });
  await media.writer.drain();
  media.onSceneUpdate(scene, { flags: { [MODULE_ID]: { media: {} } } });
  assert.deepEqual(uploads, []);
  assert.equal(
    messages.some((m) => m.t === "remove" && m.key === KEY),
    false,
  );
});

it("refuses unconfirmed uploads instead of publishing references to missing files", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { scene, picker } = setup(t);
  const writer = new MediaWriter(() => 1024);
  const errors: unknown[] = [];
  writer.onError = (err) => errors.push(err);
  for (const response of [undefined, false, {}, { status: "success" }, { path: "wrong.png" }] as const) {
    let attempts = 0;
    picker.upload = async () => {
      attempts++;
      return response;
    };
    const storing = writer.store(scene, KEY, Uint8Array.of(1), NOW);
    await tick();
    t.mock.timers.tick(250);
    await tick();
    t.mock.timers.tick(500);
    assert.equal(await storing, "upload");
    assert.equal(attempts, 3);
    assert.equal(await writer.drain(), false, "an unsuccessful upload must not be reported as persisted");
    assert.equal(readMedia(scene).chunks.size, 0);
  }
  assert.equal(errors.length, 5);
  writer.clear(scene);
  assert.equal(await writer.drain(), true, "clearing paint also discards failed upload state");
});

it("retries a transient upload and publishes only its confirmed file", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { scene, picker, uploads } = setup(t);
  const upload = picker.upload;
  let attempts = 0;
  picker.upload = async (...args) => (++attempts === 1 ? undefined : upload(...args));
  const writer = new MediaWriter(() => 1024);
  const storing = writer.store(scene, KEY, Uint8Array.of(1), NOW);
  await tick();
  assert.equal(readMedia(scene).chunks.size, 0);
  t.mock.timers.tick(250);
  assert.equal(await storing, null);
  assert.equal(await writer.drain(), true);
  assert.equal(attempts, 2);
  assert.equal(uploads.length, 1);
  const meta = readMedia(scene).chunks.get(KEY)!;
  assert.equal(bakePath(scene.id, KEY, meta.f, meta.format)!.split("/").at(-1), uploads[0]);
});

it("retains failed flag writes and retries them without uploading another bake", async (t) => {
  let failing = true;
  let attempts = 0;
  const { scene, uploads } = setup(t, async () => {
    attempts++;
    if (failing) throw new Error("Scene write unavailable");
  });
  const writer = new MediaWriter(() => 1024);
  await writer.store(scene, KEY, Uint8Array.of(1), NOW);
  assert.equal(await writer.drain(), false);
  assert.equal(attempts, 3, "persistent failures stop after a bounded number of attempts");
  assert.equal(readMedia(scene).chunks.size, 0);
  failing = false;
  assert.equal(await writer.drain(), true);
  assert.equal(readMedia(scene).chunks.size, 1);
  assert.equal(uploads.length, 1);
});

it("does not resurrect a failed flag write after an in-flight clear", async (t) => {
  const started = deferred();
  const release = deferred();
  let first = true;
  const { scene } = setup(t, async () => {
    if (!first) return;
    first = false;
    started.resolve();
    await release.promise;
    throw new Error("Scene write unavailable");
  });
  const writer = new MediaWriter(() => 1024);
  await writer.store(scene, KEY, Uint8Array.of(1), NOW);
  const drained = writer.drain();
  await started.promise;
  writer.clear(scene);
  release.resolve();
  assert.equal(await drained, true);
  assert.equal(readMedia(scene).chunks.size, 0);
});

it("preserves a newer bake when an older flag write fails", async (t) => {
  const started = deferred();
  const release = deferred();
  let first = true;
  const { scene, uploads } = setup(t, async () => {
    if (!first) return;
    first = false;
    started.resolve();
    await release.promise;
    throw new Error("Scene write unavailable");
  });
  const writer = new MediaWriter(() => 1024);
  await writer.store(scene, KEY, Uint8Array.of(1), NOW);
  const drained = writer.drain();
  await started.promise;
  await writer.store(scene, KEY, Uint8Array.of(2), NOW + 1);
  release.resolve();
  assert.equal(await drained, true);
  const meta = readMedia(scene).chunks.get(KEY)!;
  assert.equal(meta.r, 2);
  assert.equal(bakePath(scene.id, KEY, meta.f, meta.format)!.split("/").at(-1), uploads[1]);
});

it("waits for Scene persistence before reporting Dry now as saved", async (t) => {
  const unload = new Set<(event: BeforeUnloadEvent) => void>();
  setGlobal(t, "addEventListener", (_type: string, listener: (event: BeforeUnloadEvent) => void) =>
    unload.add(listener),
  );
  setGlobal(t, "removeEventListener", (_type: string, listener: (event: BeforeUnloadEvent) => void) =>
    unload.delete(listener),
  );
  const started = deferred();
  const release = deferred();
  const { scene } = setup(t, async () => {
    started.resolve();
    await release.promise;
  });
  const { media, messages, begin, emit, notices } = controller(t, scene);
  media.end(begin());
  let settled = false;
  const saving = media.dryNow().then((ok) => {
    settled = true;
    return ok;
  });
  await tick();
  const flush = messages.findLast((m) => m.t === "flush")!;
  assert.equal(flush.t, "flush");
  emit({ t: "baked", req: flush.req, key: KEY, data: Uint8Array.of(1), empty: false, at: NOW });
  emit({ t: "flushed", req: flush.req });
  await started.promise;
  assert.equal(settled, false);
  assert.equal(unload.size, 1, "refresh is guarded while the Scene write is in flight");
  let prevented = false;
  const event = {
    preventDefault: () => {
      prevented = true;
    },
    returnValue: "unchanged",
  } as unknown as BeforeUnloadEvent;
  for (const listener of unload) listener(event);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, "");
  assert.equal(
    notices.some((n) => n.key === "Notify.MediaSaved"),
    false,
  );
  release.resolve();
  assert.equal(await saving, true);
  assert.equal(unload.size, 0, "refresh is allowed once persistence completes");
  assert.equal(readMedia(scene).chunks.size, 1);
  assert.equal(notices.at(-1)?.key, "Notify.MediaSaved");
});

it("settles a cancelled Dry now without reporting cleared paint as saved", async (t) => {
  const { scene } = setup(t);
  const { media, messages, begin, notices } = controller(t, scene);
  media.end(begin());
  const saving = media.dryNow();
  await tick();
  assert.ok(messages.some((m) => m.t === "flush"));
  media.clearLocal();
  media.relayClear(scene);
  assert.equal(await saving, false);
  assert.equal(readMedia(scene).chunks.size, 0);
  assert.equal(
    notices.some((n) => n.key === "Notify.MediaSaved"),
    false,
  );
});

it("does not report success when an earlier automatic bake upload fails during Dry now", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const { scene, picker } = setup(t);
  picker.upload = async () => undefined;
  const { media, messages, begin, emit, notices } = controller(t, scene);
  media.end(begin());
  emit({ t: "dry", key: KEY, touched: NOW });
  const bake = messages.findLast((m) => m.t === "bake")!;
  assert.equal(bake.t, "bake");
  emit({ t: "baked", req: bake.req, key: KEY, data: Uint8Array.of(1), empty: false, at: NOW });
  const saving = media.dryNow();
  await tick();
  const flush = messages.findLast((m) => m.t === "flush")!;
  assert.equal(flush.t, "flush");
  // The earlier bake already marked the chunk as baked, so this flush produces no new bake.
  emit({ t: "flushed", req: flush.req });
  t.mock.timers.tick(250);
  await tick();
  t.mock.timers.tick(500);
  assert.equal(await saving, false);
  assert.equal(
    notices.some((n) => n.key === "Notify.MediaSaved"),
    false,
  );
  assert.ok(messages.some((m) => m.t === "retryBake" && m.key === KEY));
});

it("reports an unsuccessful engine flush instead of confirming a save", async (t) => {
  const { scene } = setup(t);
  const { media, messages, begin, emit, notices } = controller(t, scene);
  media.end(begin());
  const saving = media.dryNow();
  await tick();
  const flush = messages.findLast((m) => m.t === "flush")!;
  assert.equal(flush.t, "flush");
  emit({ t: "flushed", req: flush.req, ok: false });
  assert.equal(await saving, false);
  assert.equal(notices.at(-1)?.key, "Notify.MediaSaveFailed");
});

it("retries a failed upload of dry paint and restores it in a new controller", async (t) => {
  const { scene, picker, files } = setup(t);
  const upload = picker.upload;
  let failing = true;
  picker.upload = async (...args) => (failing ? undefined : upload(...args));
  t.mock.method(console, "error", () => {});
  const { media, host, begin, notices } = controller(t, scene, {
    inline: true,
    fetch: async (input) => {
      const path = String(input).split("?")[0]!.replace(/^\/+/, "");
      const bytes = files.get(path);
      return bytes ? new Response(new Uint8Array(bytes)) : new Response("", { status: 404 });
    },
  });
  media.view([0, 0, 250, 250]);
  media.end(begin());
  assert.equal(await media.dryNow(), false);
  assert.equal(readMedia(scene).chunks.size, 0);
  assert.ok(notices.some((n) => n.key === "Notify.MediaSaveFailed"));
  failing = false;
  assert.equal(await media.dryNow(), true, "already dry pigment remains available for saving");
  assert.equal(readMedia(scene).chunks.size, 1);
  assert.equal(await media.dryNow(), true);
  assert.equal(files.size, 1, "already saved chunks do not need another upload");
  const display = new Map(media.displays());
  assert.equal(display.size, 1);
  media.destroy();
  const restored = new MediaController(host as unknown as MediaHost);
  t.after(() => restored.destroy());
  const shown = deferred();
  restored.onDisplay = (_key, data) => {
    if (data) shown.resolve();
  };
  restored.view([0, 0, 250, 250]);
  restored.attach(scene);
  await shown.promise;
  const restoredDisplay = new Map(restored.displays());
  assert.deepEqual([...restoredDisplay.keys()], [...display.keys()]);
  for (const [key, expected] of display) {
    const actual = restoredDisplay.get(key)!;
    assert.equal(actual.length, expected.length);
    let error = 0;
    for (let i = 0; i < actual.length; i++) error = Math.max(error, Math.abs(actual[i]! - expected[i]!));
    assert.ok(error <= 1, `display differs beyond binary16 bake precision: ${error}/255`);
  }
});

it("retries failed bake loads and restores the same revision without a warning", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { scene, chunks } = setup(t);
  chunks.c0_0 = { r: 1, t: NOW, n: 1 };
  let attempts = 0;
  const { messages, notices } = controller(t, scene, {
    fetch: async () => (++attempts === 1 ? new Response("", { status: 404 }) : new Response(Uint8Array.of(1))),
  });
  await tick();
  assert.equal(
    messages.some((m) => m.t === "load"),
    false,
  );
  t.mock.timers.tick(250);
  await tick();
  assert.equal(attempts, 2);
  assert.ok(messages.some((m) => m.t === "load" && m.revision === "1:"));
  assert.deepEqual(notices, []);
});

it("reports failed bake loads after bounded retries and keeps their scene references", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warning = t.mock.method(console, "warn", () => {});
  const { scene, chunks } = setup(t);
  chunks.c0_0 = { r: 1, t: NOW, n: 1 };
  let attempts = 0;
  const { messages, notices } = controller(t, scene, {
    fetch: async () => {
      attempts++;
      return new Response("", { status: 404 });
    },
  });
  await tick();
  t.mock.timers.tick(250);
  await tick();
  t.mock.timers.tick(500);
  await tick();
  assert.equal(attempts, 3);
  assert.deepEqual(notices, [{ level: "warn", key: "Notify.MediaMissing" }]);
  assert.equal(warning.mock.callCount(), 1);
  assert.equal(
    messages.some((m) => m.t === "load"),
    false,
  );
  assert.equal(readMedia(scene).chunks.size, 1);
});

it("cancels stale load retries when paint is cleared", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { scene, chunks } = setup(t);
  chunks.c0_0 = { r: 1, t: NOW, n: 1 };
  let attempts = 0;
  const { media, messages, notices } = controller(t, scene, {
    fetch: async () => {
      attempts++;
      return new Response("", { status: 404 });
    },
  });
  await tick();
  media.clearLocal();
  t.mock.timers.tick(250);
  await tick();
  assert.equal(attempts, 1);
  assert.equal(
    messages.some((m) => m.t === "load"),
    false,
  );
  assert.deepEqual(notices, []);
});

it("stores lossless data outside image upload optimization and budgets the actual file size", async (t) => {
  const { scene, picker, files } = setup(t);
  const upload = picker.upload;
  let converted = 0;
  picker.upload = async (source, dir, file, ...rest) => {
    if (file.type.startsWith("image/") || /\.(png|jpe?g)$/i.test(file.name)) {
      converted++;
      return { path: `${dir}/${file.name.replace(/\.[^.]+$/, ".webp")}` };
    }
    assert.equal(file.type, "application/json");
    assert.ok(file.name.endsWith(".json"));
    return upload(source, dir, file, ...rest);
  };
  const png = Uint8Array.from({ length: 256 }, (_, i) => i);
  const size = encodeBakeFile(png).length;
  const tooSmall = new MediaWriter(() => size - 1);
  assert.equal(await tooSmall.store(scene, KEY, png, NOW), "budget");
  const writer = new MediaWriter(() => size);
  assert.equal(await writer.store(scene, KEY, png, NOW), null);
  assert.equal(await writer.drain(), true);
  const meta = readMedia(scene).chunks.get(KEY)!;
  assert.equal(meta.format, "json");
  assert.equal(meta.n, size);
  const data = files.get(bakePath(scene.id, KEY, meta.f, meta.format)!)!;
  assert.equal(data.length, meta.n);
  assert.deepEqual(decodeBakeFile(data), png);
  assert.equal(converted, 0);
});

it("recreates deleted upload directories instead of repeatedly trusting the directory cache", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { scene, picker, files } = setup(t);
  const dirs = new Set<string>();
  const upload = picker.upload;
  let refused = 0;
  picker.createDirectory = async (_source, path) => {
    dirs.add(path);
  };
  picker.upload = async (source, dir, file, ...rest) => {
    if (!dirs.has(dir)) {
      refused++;
      throw new Error("Upload directory does not exist");
    }
    return upload(source, dir, file, ...rest);
  };
  const writer = new MediaWriter(() => 1024);
  await writer.store(scene, KEY, Uint8Array.of(1), NOW);
  assert.equal(await writer.drain(), true);
  dirs.clear();
  files.clear();
  const storing = writer.store(scene, KEY, Uint8Array.of(2), NOW + 1);
  await tick();
  assert.equal(refused, 1);
  t.mock.timers.tick(250);
  assert.equal(await storing, null);
  assert.equal(await writer.drain(), true);
  const meta = readMedia(scene).chunks.get(KEY)!;
  assert.equal(meta.r, 2);
  assert.deepEqual(decodeBakeFile(files.get(bakePath(scene.id, KEY, meta.f, meta.format)!)!), Uint8Array.of(2));
});

it("saves new paint over a confirmed missing legacy checkpoint and reloads the replacement", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { scene, chunks, files } = setup(t);
  chunks.c0_0 = { r: 3, t: NOW - 10, n: 100 };
  let misses = 0;
  const { media, host, begin, notices } = controller(t, scene, {
    inline: true,
    fetch: async (input) => {
      const path = String(input).split("?")[0]!.replace(/^\/+/, "");
      const data = files.get(path);
      if (data) return new Response(new Uint8Array(data));
      misses++;
      return new Response("", { status: 404 });
    },
  });
  media.view([0, 0, 250, 250]);
  media.end(begin());
  assert.equal(await media.dryNow(), true);
  assert.equal(misses, 3);
  assert.ok(notices.some((n) => n.key === "Notify.MediaMissing"));
  const meta = readMedia(scene).chunks.get(KEY)!;
  assert.equal(meta.r, 4);
  assert.equal(meta.format, "json");
  const png = decodeBakeFile(files.get(bakePath(scene.id, KEY, meta.f, meta.format)!)!)!;
  assert.ok(decodeBake(png)?.some((v) => v !== 0));
  media.destroy();
  const restored = new MediaController(host as unknown as MediaHost);
  t.after(() => restored.destroy());
  const shown = deferred();
  restored.onDisplay = (_key, data) => {
    if (data) shown.resolve();
  };
  restored.view([0, 0, 250, 250]);
  restored.attach(scene);
  await shown.promise;
  assert.equal([...restored.displays()].length, 1);
  assert.equal(misses, 3, "the replacement loads from JSON without requesting the missing PNG again");
});

it("does not treat temporary server failures as deleted paint or overwrite its checkpoint", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { scene, chunks, files } = setup(t);
  chunks.c0_0 = { r: 3, t: NOW - 10, n: 100 };
  const { media, begin, notices } = controller(t, scene, {
    inline: true,
    fetch: async () => new Response("", { status: 500 }),
  });
  media.end(begin());
  assert.equal(await media.dryNow(), false);
  assert.equal(files.size, 0);
  assert.equal(readMedia(scene).chunks.get(KEY)!.r, 3);
  assert.ok(notices.some((n) => n.key === "Notify.MediaLoadFailed"));
  assert.equal(
    notices.some((n) => n.key === "Notify.MediaMissing"),
    false,
  );
});

it("allows new paint after a legacy image upload was replaced by unreadable image data", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { scene, chunks, files } = setup(t);
  chunks.c0_0 = { r: 3, t: NOW - 10, n: 100 };
  const { media, begin, notices } = controller(t, scene, {
    inline: true,
    fetch: async () => new Response(Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80])),
  });
  media.end(begin());
  assert.equal(await media.dryNow(), true);
  assert.ok(notices.some((n) => n.key === "Notify.MediaLoadFailed"));
  assert.equal(readMedia(scene).chunks.get(KEY)!.r, 4);
  assert.equal(files.size, 1);
});

it("rechecks a missing checkpoint only when its flag revision changes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const { scene, chunks } = setup(t);
  chunks.c0_0 = { r: 3, t: NOW, n: 100 };
  let calls = 0;
  const { media, messages } = controller(t, scene, {
    fetch: async () => (++calls <= 3 ? new Response("", { status: 404 }) : new Response(Uint8Array.of(1))),
  });
  await tick();
  t.mock.timers.tick(250);
  await tick();
  t.mock.timers.tick(500);
  await tick();
  const changes = { flags: { [MODULE_ID]: { media: {} } } };
  media.onSceneUpdate(scene, changes);
  await tick();
  assert.equal(calls, 3, "unrelated scene updates do not repeatedly fetch a known missing file");
  chunks.c0_0 = { r: 4, t: NOW + 1, n: 100 };
  media.onSceneUpdate(scene, changes);
  await tick();
  assert.equal(calls, 4);
  assert.ok(messages.some((m) => m.t === "load" && m.revision === "4:"));
});
