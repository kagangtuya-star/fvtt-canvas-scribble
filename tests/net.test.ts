import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIVE_BATCH_MS, MODULE_ID, SOCKET_NAME } from "../src/constants.ts";
import { quantizePoints } from "../src/core/codec.ts";
import { toWire } from "../src/core/sanitize.ts";
import { MapSpace } from "../src/core/space.ts";
import { rawItems } from "../src/foundry/persistence.ts";
import { LiveSender, Net } from "../src/net/net.ts";
import type { Inbound } from "../src/net/net.ts";
import {
  MAX_BATCH,
  MAX_LIVE_BATCH,
  MAX_MESSAGE_CHARS,
  PROTOCOL_VERSION,
  messageCost,
  parseMessage,
} from "../src/net/protocol.ts";
import { stats } from "../src/render/stats.ts";
import { Session } from "../src/session.ts";
import { DEFAULT_PREFS } from "../src/state/prefs.ts";
import { FreehandGesture } from "../src/tools/gestures.ts";
import type { ToolHost } from "../src/tools/gestures.ts";
import { ALICE, BOB, GM, SCENE, makeItem } from "./helpers.ts";

const env = (m: Record<string, unknown>) => ({ v: PROTOCOL_VERSION, scene: SCENE, ...m });

describe("parseMessage", () => {
  it("accepts every well-formed message type", () => {
    const item = toWire(makeItem());
    const points = { t: "p", id: item.id, from: 3, pts: "1AA" };
    const good = [
      env({ t: "s", item }),
      env(points),
      env({ t: "b", updates: [points, { t: "s", item }] }),
      env({ t: "e", item, persist: true }),
      env({ t: "x", id: item.id }),
      env({ t: "d", ids: [item.id] }),
      env({ t: "u", item }),
      env({ t: "c", scope: "allTemp" }),
      env({ t: "q" }),
      env({ t: "r", to: ALICE, items: [item] }),
      env({ t: "n", to: ALICE, id: item.id, reason: "budget" }),
    ];
    for (const m of good) assert.ok(parseMessage(m), JSON.stringify(m).slice(0, 60));
  });

  it("rejects wrong versions, scenes and shapes", () => {
    const bad = [
      null,
      [],
      { ...env({ t: "q" }), v: 2 },
      { ...env({ t: "q" }), scene: "../../etc" },
      env({ t: "zz" }),
      env({ t: "s", item: "nope" }),
      env({ t: "p", id: "x", from: -1, pts: "1" }),
      env({ t: "p", id: "x", from: 1.5, pts: "1" }),
      env({ t: "b", updates: [] }),
      env({ t: "b", updates: [{ t: "e", item: {} }] }),
      env({ t: "b", updates: Array.from({ length: MAX_LIVE_BATCH + 1 }, () => ({ t: "s", item: {} })) }),
      env({ t: "d", ids: Array.from({ length: MAX_BATCH + 1 }, (_, i) => `id${i}`) }),
      env({ t: "d", ids: ["ok", { evil: 1 }] }),
      env({ t: "c", scope: "everything" }),
      env({ t: "r", to: ALICE, items: Array.from({ length: MAX_BATCH + 1 }, () => ({})) }),
    ];
    for (const m of bad) assert.equal(parseMessage(m), null, JSON.stringify(m)?.slice(0, 80));
  });

  it("normalises persist to a boolean", () => {
    const m = parseMessage(env({ t: "e", item: toWire(makeItem()), persist: "yes" }));
    assert.equal(m?.t === "e" && m.persist, false);
  });

  it("charges points and items", () => {
    const item = toWire(makeItem());
    assert.deepEqual(messageCost(parseMessage(env({ t: "p", id: "a", from: 0, pts: "x".repeat(60) }))!), [1, 10, 0]);
    assert.equal(messageCost(parseMessage(env({ t: "e", item }))!)[2], 1);
    const update = { t: "p", id: "a", from: 0, pts: "x".repeat(60), ang: "a".repeat(12) };
    assert.deepEqual(messageCost(parseMessage(env({ t: "b", updates: [update, update] }))!), [1, 24, 0]);
    assert.equal(
      messageCost(parseMessage(env({ t: "d", ids: Array.from({ length: 25 }, (_, i) => `id${i}`) }))!)[2],
      3,
    );
  });
});

describe("live brush transport", () => {
  it("batches twelve-way symmetry and persists every final while the preview budget is exhausted", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const wire = socket();
    const receiver = new Net(wire, users, GM);
    const gm = users.get(GM)!;
    const gmUsers = Object.assign(new Map(users), { activeGM: gm });
    const oldGame = Object.getOwnPropertyDescriptor(globalThis, "game");
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: { users: gmUsers, user: gm, time: { serverTime: 1_000_000 } },
    });
    const scene: FoundryScene = {
      id: SCENE,
      name: "Test scene",
      flags: { [MODULE_ID]: { items: {} } },
      getFlag(scope, key) {
        return this.flags[scope]?.[key];
      },
      canUserModify: () => true,
      async update(values) {
        const saved = rawItems(scene);
        const prefix = `flags.${MODULE_ID}.items.`;
        for (const [key, value] of Object.entries(values)) {
          if (key.startsWith(prefix)) saved[key.slice(prefix.length)] = value;
        }
      },
    };
    const relay = new Session(wire);
    relay.scene = scene;
    t.after(() => {
      relay.destroy();
      if (oldGame) Object.defineProperty(globalThis, "game", oldGame);
      else Reflect.deleteProperty(globalThis, "game");
    });
    const sender = new Net(wire, users, BOB);
    sender.scene = SCENE;
    const live = new LiveSender(sender);
    const received: Inbound[] = [];
    receiver.onMessage((message) => received.push(message));
    const items = Array.from({ length: 12 }, () => makeItem({ points: [0, 0, 0.5], expiresAt: null }));
    for (const item of items) live.start(item);
    while (wire.sent.length) wire.deliver(wire.sent.shift(), BOB);

    for (let i = 1; i <= 24; i++) {
      for (const [j, item] of items.entries()) {
        const next = { ...item, points: [...item.points, i, i, 0.5] };
        items[j] = next;
        live.push(next);
      }
      t.mock.timers.tick(LIVE_BATCH_MS);
      assert.equal(wire.sent.length, 1);
      assert.equal(parseMessage(wire.sent[0])?.t, "b");
      wire.deliver(wire.sent.shift(), BOB);
    }
    assert.equal(received.filter(({ msg }) => msg.t === "p").length, 24 * 12);

    const before = stats.dropped;
    for (let i = 0; i < 250; i++) wire.deliver(env({ t: "p", id: items[0]!.id, from: 0, pts: "1" }), BOB);
    assert.ok(stats.dropped > before);
    // A detailed twelve-way stroke also exceeds the ordinary single-item point burst.
    const points = Array.from({ length: 2500 }, (_, i) => [i, i % 2 ? 20 : 40, 0.5]).flat();
    for (const item of items) live.end({ ...item, points }, true);
    while (wire.sent.length) wire.deliver(wire.sent.shift(), BOB);
    const finals = received.flatMap(({ msg }) => (msg.t === "e" && msg.persist ? [msg.item.id] : []));
    assert.deepEqual(
      finals,
      items.map((item) => item.id),
    );
    t.mock.timers.tick(120);
    await Promise.resolve();
    assert.deepEqual(Object.keys(rawItems(scene)), finals);
  });

  it("shows QuickShape before pen-up and restores the live stroke when drawing resumes", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const gameStub = { users, user: users.get(GM), time: { serverTime: 1_000_000 } };
    const oldGame = Object.getOwnPropertyDescriptor(globalThis, "game");
    Object.defineProperty(globalThis, "game", { value: gameStub, configurable: true });
    const wire = socket();
    const receiver = new Session(wire);
    receiver.scene = { id: SCENE } as FoundryScene;
    t.after(() => {
      receiver.destroy();
      if (oldGame) Object.defineProperty(globalThis, "game", oldGame);
      else Reflect.deleteProperty(globalThis, "game");
    });
    const sender = new Net(wire, users, BOB);
    sender.scene = SCENE;
    const live = new LiveSender(sender);
    const item = makeItem({ author: BOB });
    let started = false;
    let preview = item;
    const host: ToolHost = {
      prefs: DEFAULT_PREFS,
      now: () => item.createdAt,
      pressureMode: () => "off",
      makeItem: (_target, kind, tool, size, points) => ({ ...item, kind, tool, size, points }),
      live(next) {
        preview = next;
        if (!started) live.start(next);
        else live.push(next);
        started = true;
      },
      commit: (next) => live.end(next, false),
      cancel: (id) => live.cancel(id),
    };
    const space = new MapSpace(
      { sceneX: 0, sceneY: 0, sceneWidth: 4000, sceneHeight: 3000, refW: 4000, refH: 3000, gridSize: 100 },
      { zoom: () => 1, toCanvas: (x, y) => ({ x, y }), toClient: (x, y) => ({ x, y }) },
    );
    const sample = (x: number, y = 0) => ({ cx: x, cy: y, time: x, pressure: 0.5, pointerType: "mouse" });
    const mods = { shift: false, alt: false };
    const gesture = new FreehandGesture(
      host,
      { mode: "map", space },
      { kind: "stroke", tool: "pen", size: 5 },
      sample(0),
    );
    const deliver = () => {
      while (wire.sent.length) wire.deliver(wire.sent.shift(), BOB);
    };

    gesture.move(
      Array.from({ length: 20 }, (_, i) => sample((i + 1) * 10)),
      mods,
    );
    t.mock.timers.tick(LIVE_BATCH_MS);
    deliver();
    assert.equal(receiver.store.get(item.id)?.item.kind, "stroke");
    gesture.move([sample(207, 1)], mods);
    t.mock.timers.tick(LIVE_BATCH_MS);
    deliver();
    assert.deepEqual(receiver.store.get(item.id)?.item.points, quantizePoints(preview.points), "replaces the old tail");

    t.mock.timers.tick(400);
    t.mock.timers.tick(LIVE_BATCH_MS);
    deliver();
    assert.equal(receiver.store.get(item.id)?.state, "live");
    assert.equal(receiver.store.get(item.id)?.item.tool, "line");
    assert.deepEqual(receiver.store.get(item.id)?.item.points, preview.points);

    gesture.move([sample(220, 20)], mods);
    t.mock.timers.tick(LIVE_BATCH_MS);
    deliver();
    assert.equal(receiver.store.get(item.id)?.item.kind, "stroke");
    gesture.up(sample(220, 20), mods);
    deliver();
    assert.equal(receiver.store.get(item.id)?.state, "temp");
  });
});

/** In-memory socket: `deliver` simulates the server relaying a payload with its sender id. */
function socket() {
  const handlers: ((payload: unknown, sender?: unknown) => void)[] = [];
  const sent: unknown[] = [];
  return {
    on: (event: string, fn: (payload: unknown, sender?: unknown) => void) => {
      assert.equal(event, SOCKET_NAME);
      handlers.push(fn);
    },
    off: () => (handlers.length = 0),
    emit: (_event: string, payload: unknown) => sent.push(payload),
    deliver: (payload: unknown, sender: unknown) => handlers.forEach((h) => h(payload, sender)),
    sent,
  };
}

const users = new Map<string, FoundryUser>(
  [GM, ALICE, BOB].map((id, i) => [
    id,
    { id, name: id, role: [4, 1, 2][i]!, isGM: i === 0, active: true } as unknown as FoundryUser,
  ]),
);

describe("Net", () => {
  it("stamps version and scene on outbound messages", () => {
    const s = socket();
    const net = new Net(s, users, ALICE);
    net.send({ t: "q" });
    assert.equal(s.sent.length, 0, "nothing is sent without a scene");
    net.scene = SCENE;
    net.send({ t: "q" });
    assert.deepEqual(s.sent[0], { t: "q", v: PROTOCOL_VERSION, scene: SCENE });
  });

  it("refuses to send oversized messages", () => {
    const s = socket();
    const net = new Net(s, users, ALICE);
    net.scene = SCENE;
    net.send({ t: "p", id: "a", from: 0, pts: "x".repeat(MAX_MESSAGE_CHARS) });
    assert.equal(s.sent.length, 0);
  });

  it("resolves the sender from the server-attached id, not the payload", () => {
    const s = socket();
    const net = new Net(s, users, GM);
    const got: Inbound[] = [];
    net.onMessage((m) => got.push(m));
    s.deliver({ ...env({ t: "q" }), authorId: GM, role: 4, sender: GM }, ALICE);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.sender.id, ALICE);
  });

  it("drops own, unknown-sender, oversized and malformed messages", () => {
    const s = socket();
    const net = new Net(s, users, GM);
    const got: Inbound[] = [];
    net.onMessage((m) => got.push(m));
    const before = stats.dropped;
    s.deliver(env({ t: "q" }), GM);
    s.deliver(env({ t: "q" }), "IntruderXxxxxxx9");
    s.deliver(env({ t: "q" }), undefined);
    s.deliver({ ...env({ t: "q" }), pad: "x".repeat(MAX_MESSAGE_CHARS) }, ALICE);
    s.deliver(env({ t: "nope" }), ALICE);
    assert.equal(got.length, 0);
    assert.equal(stats.dropped - before, 3);
  });

  it("rate-limits a flooding sender without affecting others", () => {
    const s = socket();
    const net = new Net(s, users, GM);
    const got: string[] = [];
    net.onMessage((m) => got.push(m.sender.id));
    for (let i = 0; i < 1000; i++) s.deliver(env({ t: "x", id: `Spam${i}` }), BOB);
    s.deliver(env({ t: "q" }), ALICE);
    const fromBob = got.filter((id) => id === BOB).length;
    assert.ok(fromBob < 300, `${fromBob} of 1000 accepted`);
    assert.ok(got.includes(ALICE));
  });

  it("isolates handler errors", () => {
    const s = socket();
    const net = new Net(s, users, GM);
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      net.onMessage(() => {
        throw new Error("boom");
      });
      assert.doesNotThrow(() => s.deliver(env({ t: "q" }), ALICE));
    } finally {
      console.error = orig;
    }
    assert.equal(errors.length, 1);
  });
});
