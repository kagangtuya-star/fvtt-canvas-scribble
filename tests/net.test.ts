import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SOCKET_NAME } from "../src/constants.ts";
import { toWire } from "../src/core/sanitize.ts";
import { Net } from "../src/net/net.ts";
import type { Inbound } from "../src/net/net.ts";
import { MAX_BATCH, MAX_MESSAGE_CHARS, PROTOCOL_VERSION, messageCost, parseMessage } from "../src/net/protocol.ts";
import { stats } from "../src/render/stats.ts";
import { ALICE, BOB, GM, SCENE, makeItem } from "./helpers.ts";

const env = (m: Record<string, unknown>) => ({ v: PROTOCOL_VERSION, scene: SCENE, ...m });

describe("parseMessage", () => {
  it("accepts every well-formed message type", () => {
    const item = toWire(makeItem());
    const good = [
      env({ t: "s", item }),
      env({ t: "p", id: item.id, from: 3, pts: "1AA" }),
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
    assert.equal(
      messageCost(parseMessage(env({ t: "d", ids: Array.from({ length: 25 }, (_, i) => `id${i}`) }))!)[2],
      3,
    );
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
