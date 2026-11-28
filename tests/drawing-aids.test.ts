import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { buildConstraint, LineConstraint } from "../src/assist/constraint.ts";
import { nearestOnCurve, sampleCurve } from "../src/assist/curve.ts";
import { normalizeGuides } from "../src/assist/guides-model.ts";
import { smoothPolyline } from "../src/brush/recorder.ts";
import { StrokeStabilizer } from "../src/brush/stabilizer.ts";
import { symmetryTransforms } from "../src/brush/symmetry.ts";
import { LIMITS, MODULE_ID, SOCKET_NAME } from "../src/constants.ts";
import { apply, fromQuad, invert, multiply, rotate, scale, translate } from "../src/core/matrix.ts";
import type { Pt } from "../src/core/matrix.ts";
import { ScreenSpace } from "../src/core/space.ts";
import { itemBounds } from "../src/core/store.ts";
import type { Entry } from "../src/core/store.ts";
import { MAX_UPDATE_BATCH, messageCost, parseMessage } from "../src/net/protocol.ts";
import { Session } from "../src/session.ts";
import { DEFAULT_PREFS, normalizePrefs } from "../src/state/prefs.ts";
import { regionHit } from "../src/tools/lasso.ts";
import { frameTransform, transformItem } from "../src/tools/transform.ts";
import { ALICE, BOB, GM, SCENE, makeItem } from "./helpers.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const square: Pt[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

describe("matrix", () => {
  it("composes, inverts and maps a quad onto another (homography)", () => {
    const m = multiply(translate(5, 7), rotate(Math.PI / 2));
    const [x, y] = apply(m, 1, 0);
    close(x, 5);
    close(y, 8);
    const inv = invert(m)!;
    const [bx, by] = apply(inv, x, y);
    close(bx, 1);
    close(by, 0);

    const dst: Pt[] = [
      { x: 10, y: 10 },
      { x: 120, y: 0 },
      { x: 90, y: 140 },
      { x: -5, y: 90 },
    ];
    const h = fromQuad(square, dst)!;
    square.forEach((p, i) => {
      const [qx, qy] = apply(h, p.x, p.y);
      close(qx, dst[i]!.x, 1e-6);
      close(qy, dst[i]!.y, 1e-6);
    });
  });
});

describe("transformItem", () => {
  it("turns a rotated ellipse into a closed polygon and keeps quarter turns axis-aligned", () => {
    const ellipse = makeItem({ kind: "shape", tool: "ellipse", points: [0, 0, 0.5, 40, 20, 0.5] });
    const turned = transformItem(ellipse, rotate(Math.PI / 4, 20, 10));
    assert.equal(turned.tool, "polygon");
    assert.equal(turned.style.closed, true);
    const xs = turned.points.filter((_, i) => i % 3 === 0);
    const ys = turned.points.filter((_, i) => i % 3 === 1);
    // An ellipse rotated by 45° has equal extents along x and y.
    close(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0.5);
    assert.equal(transformItem(ellipse, rotate(Math.PI / 2, 20, 10)).tool, "ellipse");
  });

  it("scales size by sqrt|det| and mirrors nib angles", () => {
    const flat = makeItem({ tool: "flat", points: [0, 0, 0.5, 10, 0, 0.5], size: 10, style: { brush: { ang: 30 } } });
    const mirrored = transformItem(flat, [-2, 0, 0, 0, 2, 0, 0, 0, 1]);
    assert.equal(mirrored.size, 20);
    assert.equal(mirrored.style.brush?.ang, 150);
    assert.equal(mirrored.revision, flat.revision + 1);
  });

  it("keeps eraser masks aligned with text that stays upright", () => {
    const text = makeItem({
      kind: "text",
      tool: "text",
      text: "Masked",
      points: [10, 20, 0.5],
      erase: [{ size: 8, points: [13, 24, 0.5], tip: "rect", ang: 35 }],
    });
    const shifted = transformItem(text, translate(30, -10));
    assert.deepEqual(shifted.erase![0]!.points.slice(0, 2), [43, 14]);
    const resized = transformItem(text, multiply(rotate(Math.PI / 2), scale(2, 2)));
    const mask = resized.erase![0]!;
    close(mask.points[0]! - resized.points[0]!, 6, 0.1);
    close(mask.points[1]! - resized.points[1]!, 8, 0.1);
    assert.equal(mask.size, 16);
    assert.equal(mask.ang, 35);
  });
});

describe("frame transform", () => {
  const drag = (handle: Parameters<typeof frameTransform>[0]["handle"], origin: Pt) => ({
    handle,
    origin,
    quad: square,
    pivot: { x: 50, y: 50 },
  });

  it("scales proportionally from a corner, freely with Shift and from the centre with Alt", () => {
    const r = frameTransform(drag("se", { x: 100, y: 100 }), { x: 200, y: 150 }, {})!;
    close(r.quad[2]!.x - r.quad[0]!.x, r.quad[2]!.y - r.quad[0]!.y, 1e-6);
    close(r.quad[0]!.x, 0);
    const free = frameTransform(drag("se", { x: 100, y: 100 }), { x: 200, y: 150 }, { shift: true })!;
    close(free.quad[2]!.x, 200);
    close(free.quad[2]!.y, 150);
    const centred = frameTransform(drag("e", { x: 100, y: 50 }), { x: 150, y: 50 }, { alt: true })!;
    close(centred.quad[0]!.x, -50);
    close(centred.quad[1]!.x, 150);
  });

  it("skews with Ctrl on an edge and distorts with Ctrl on a corner", () => {
    const skew = frameTransform(drag("s", { x: 50, y: 100 }), { x: 80, y: 100 }, { ctrl: true })!;
    close(skew.quad[0]!.x, 0);
    close(skew.quad[3]!.x, 30);
    close(skew.quad[2]!.x, 130);
    const distort = frameTransform(drag("ne", { x: 100, y: 0 }), { x: 130, y: -20 }, { ctrl: true })!;
    close(distort.quad[1]!.x, 130);
    close(distort.quad[1]!.y, -20);
    close(distort.quad[3]!.x, 0);
    const [mx, my] = apply(distort.m, 100, 0);
    close(mx, 130, 1e-6);
    close(my, -20, 1e-6);
    // A self-intersecting quad is refused.
    assert.equal(frameTransform(drag("ne", { x: 100, y: 0 }), { x: -50, y: 150 }, { ctrl: true }), null);
  });
});

describe("dejitter, stabilizer & smoothing", () => {
  it("feels the same at every zoom (filters work in CSS px)", () => {
    const run = (u: number) => {
      const s = new StrokeStabilizer({ mode: "lazy", strength: 0.5, dejitter: 0.6, unitsPerPx: u });
      const out: number[] = [];
      for (let i = 0; i < 30; i++) {
        const p = s.filter(i * 6 * u, Math.sin(i) * 3 * u, i * 8);
        out.push(p.x / u, p.y / u);
      }
      return out;
    };
    const a = run(1);
    const b = run(0.25);
    a.forEach((v, i) => close(v, b[i]!, 1e-6));
  });

  it("catches up to the last raw point on lift", () => {
    const s = new StrokeStabilizer({ mode: "lazy", strength: 1, unitsPerPx: 1 });
    s.filter(0, 0, 0);
    s.filter(200, 0, 16);
    const tail = s.catchUp();
    assert.ok(tail.length > 1);
    assert.deepEqual(tail.at(-1), { x: 200, y: 0 });
    assert.deepEqual(s.catchUp(), []);
  });

  it("time-averages a resting pointer towards it", () => {
    const s = new StrokeStabilizer({ mode: "average", strength: 0.5, unitsPerPx: 1 });
    s.filter(0, 0, 0);
    const first = s.filter(100, 0, 16).x;
    let last = first;
    for (let t = 32; t < 600; t += 16) last = s.filter(100, 0, t).x;
    assert.ok(first < 100 && last > first);
    close(last, 100, 0.5);
  });

  it("smooths a polyline while keeping its endpoints and point count", () => {
    const zig = [0, 0, 0.5, 10, 8, 0.5, 20, -8, 0.5, 30, 8, 0.5, 40, 0, 0.5];
    const out = smoothPolyline(zig, 1);
    assert.equal(out.length, zig.length);
    assert.deepEqual(out.slice(0, 3), zig.slice(0, 3));
    assert.deepEqual(out.slice(-3), zig.slice(-3));
    assert.ok(Math.abs(out[4]!) < 8);
    assert.deepEqual(smoothPolyline(zig, 0), zig);
  });
});

describe("symmetry modes", () => {
  it("rotates mirror axes and builds kaleidoscopes of 2n transforms", () => {
    assert.equal(symmetryTransforms("kaleido6", 0, 0).length, 12);
    assert.equal(symmetryTransforms("kaleido3", 0, 0).length, 6);
    // A vertical mirror rotated by 90° becomes a horizontal one.
    const m = symmetryTransforms("vertical", 0, 0, 90)[1]!;
    const [x, y] = apply(m, 3, 4);
    close(x, 3);
    close(y, -4);
  });
});

describe("rulers", () => {
  it("locks a perspective stroke towards the vanishing point closest to its direction", () => {
    const rulers = [
      {
        id: "p2",
        kind: "perspective" as const,
        mode: "map" as const,
        on: true,
        vps: [
          { x: -1000, y: 0 },
          { x: 1000, y: -1000 },
        ],
        parallels: true,
      },
    ];
    const c = buildConstraint(rulers, { x: 0, y: 0 }, 1) as LineConstraint;
    assert.ok(c instanceof LineConstraint);
    assert.equal(c.locked, false);
    assert.deepEqual(c.project(3, -2), { x: 3, y: -2 });
    const p = c.project(30, -26); // roughly towards the second VP
    assert.equal(c.locked, true);
    close(p.x, -p.y, 1e-9);
    // Later points stay on that line.
    const q = c.project(10, 50);
    close(q.x, -q.y, 1e-9);
  });

  it("samples a continuous curve and follows it from a nearby start, keeping the offset when parallel", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      { x: 200, y: 0 },
    ];
    const curve = sampleCurve(pts, false, 2);
    for (let i = 2; i < curve.xy.length; i += 2)
      assert.ok(Math.hypot(curve.xy[i]! - curve.xy[i - 2]!, curve.xy[i + 1]! - curve.xy[i - 1]!) < 6);
    const hit = nearestOnCurve(curve, 100, 60)!;
    close(hit.x, 100, 1);
    close(hit.y, 50, 1);
    const ruler = {
      id: "c",
      kind: "curve" as const,
      mode: "map" as const,
      on: true,
      pts,
      closed: false,
      parallel: false,
    };
    const c = buildConstraint([ruler], { x: 100, y: 60 }, 1)!;
    const on = c.project(150, 70);
    const near = nearestOnCurve(curve, on.x, on.y)!;
    assert.ok(near.distance < 0.5);
    const par = buildConstraint([{ ...ruler, parallel: true }], { x: 100, y: 60 }, 1)!;
    const off = par.project(100, 60);
    close(Math.hypot(off.x - 100, off.y - 50), 10, 1);
    // Far from every curve and without perspective rulers: no constraint.
    assert.equal(buildConstraint([ruler], { x: 100, y: 400 }, 1), null);
  });

  it("validates stored guides", () => {
    const g = normalizeGuides({
      [SCENE]: {
        symmetry: { map: { x: 10, y: 20 }, screen: { x: "bad" } },
        rulers: [
          { id: "r1", kind: "perspective", mode: "map", vps: [{ x: 1, y: 2 }, 5, { x: 3, y: 4 }] },
          {
            id: "r1",
            kind: "curve",
            mode: "map",
            pts: [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ],
          },
          { id: "r2", kind: "curve", mode: "screen", pts: [{ x: 0, y: 0 }] },
          { id: "bad id!", kind: "perspective", vps: [{ x: 0, y: 0 }] },
          {
            id: "r3",
            kind: "curve",
            pts: [
              { x: 0, y: 0 },
              { x: 2e6, y: 0 },
              { x: 5, y: 5 },
            ],
            closed: true,
          },
        ],
      },
      "../evil": {},
    });
    assert.deepEqual(Object.keys(g), [SCENE]);
    const s = g[SCENE]!;
    assert.deepEqual(s.symmetry, { map: { x: 10, y: 20 } });
    assert.deepEqual(
      s.rulers.map((r) => r.id),
      ["r1", "r3"],
    );
    assert.equal(s.rulers[0]!.kind === "perspective" && s.rulers[0]!.vps.length, 2);
    assert.equal(s.rulers[1]!.kind === "curve" && s.rulers[1]!.pts.length, 2);
  });
});

describe("prefs migration", () => {
  it("turns the old one-euro stabilizer into dejitter", () => {
    const p = normalizePrefs({ stabilizer: "one-euro", stabilizerStrength: 0.7 });
    assert.equal(p.stabilizer, "off");
    assert.equal(p.dejitter, 0.7);
    assert.equal(normalizePrefs({ symmetry: "kaleido4", symmetryAngle: 500 }).symmetry, "kaleido4");
    assert.equal(DEFAULT_PREFS.stabilizerFinish, true);
  });
});

describe("batch update protocol", () => {
  it("parses U messages within limits and charges their points", () => {
    const item = { id: "a", points: "x".repeat(60) };
    const msg = parseMessage({ v: 1, t: "U", scene: SCENE, items: [item, item] })!;
    assert.equal(msg.t, "U");
    assert.deepEqual(messageCost(msg), [1, 20, 1]);
    assert.equal(parseMessage({ v: 1, t: "U", scene: SCENE, items: [] }), null);
    assert.equal(parseMessage({ v: 1, t: "U", scene: SCENE, items: [1] }), null);
    const many = Array.from({ length: MAX_UPDATE_BATCH + 1 }, () => item);
    assert.equal(parseMessage({ v: 1, t: "U", scene: SCENE, items: many }), null);
  });
});

describe("region hit", () => {
  const entry = (points: number[], over = {}): Entry => {
    const item = makeItem({ points, ...over });
    return { item, state: "temp", bounds: itemBounds(item) } as Entry;
  };
  const lasso = [0, 0, 0.5, 100, 0, 0.5, 100, 100, 0.5, 0, 100, 0.5];

  it("selects touched or fully contained items", () => {
    const inside = entry([10, 10, 0.5, 50, 50, 0.5]);
    const crossing = entry([50, 50, 0.5, 300, 50, 0.5]);
    const across = entry([-50, 50, 0.5, 150, 50, 0.5]);
    const outside = entry([200, 200, 0.5, 300, 300, 0.5]);
    assert.equal(regionHit(inside, lasso, "contain"), true);
    assert.equal(regionHit(crossing, lasso, "touch"), true);
    assert.equal(regionHit(crossing, lasso, "contain"), false);
    assert.equal(regionHit(across, lasso, "touch"), true);
    assert.equal(regionHit(outside, lasso, "touch"), false);
    const filled = entry([-100, -100, 0.5, 300, 300, 0.5], { kind: "shape", tool: "rect", style: { fill: true } });
    assert.equal(regionHit(filled, [40, 40, 0.5, 60, 40, 0.5, 60, 60, 0.5], "touch"), true);
  });

  it("examines the segments between vertices for a concave lasso", () => {
    const concave = [
      [0, 0],
      [100, 0],
      [100, 100],
      [70, 100],
      [70, 30],
      [30, 30],
      [30, 100],
      [0, 100],
    ].flatMap(([x, y]) => [x!, y!, 0.5]);
    const crossing = entry([10, 80, 0.5, 90, 80, 0.5]);
    const gap = entry([30, 80, 0.5, 70, 80, 0.5]);
    const edge = entry([30, 30, 0.5, 70, 30, 0.5]);
    assert.equal(regionHit(crossing, concave, "touch"), true);
    assert.equal(regionHit(crossing, concave, "contain"), false);
    assert.equal(regionHit(gap, concave, "contain"), false);
    assert.equal(regionHit(edge, concave, "contain"), true);
  });
});

function setup(t: TestContext) {
  const users = Object.assign(
    new Map([
      [ALICE, { id: ALICE, role: 1, active: true }],
      [BOB, { id: BOB, role: 1, active: true }],
      [GM, { id: GM, role: 4, active: true, isGM: true }],
    ]),
    { activeGM: undefined as unknown },
  );
  const game = {
    user: users.get(ALICE),
    users,
    time: { serverTime: 1_000_000 },
    i18n: { localize: (key: string) => key, format: (key: string) => key },
  };
  for (const [key, value] of Object.entries({
    game,
    canvas: { app: { view: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }) } } },
    ui: { notifications: { warn() {}, info() {} } },
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => (old ? Object.defineProperty(globalThis, key, old) : Reflect.deleteProperty(globalThis, key)));
  }
  const sent: Record<string, any>[] = [];
  const session = new Session({ on() {}, off() {}, emit: (_e, payload) => sent.push(payload as Record<string, any>) });
  session.scene = { id: SCENE, flags: { [MODULE_ID]: { items: {} } }, async update() {} } as unknown as FoundryScene;
  session.net.scene = SCENE;
  session.rebuildSpaces();
  const space = session.space("screen") as ScreenSpace;
  t.after(() => session.destroy());
  const mk = (id: string, cx: number, cy: number) => {
    const a = space.fromClient(cx, cy, [0, 0]);
    const b = space.fromClient(cx + 40, cy + 20, [0, 0]);
    const item = makeItem({ id, mode: "screen", anchor: [0, 0], points: [a.x, a.y, 0.5, b.x, b.y, 0.5] });
    session.store.put(item, "temp");
    return item;
  };
  const makePeer = () => {
    let receive: (payload: unknown, sender: string) => void;
    const alice = game.user;
    game.user = users.get(BOB);
    const peer = new Session({
      on(event, listener) {
        assert.equal(event, SOCKET_NAME);
        receive = listener;
      },
      off() {},
      emit() {},
    });
    game.user = alice;
    peer.scene = session.scene;
    peer.net.scene = SCENE;
    t.after(() => peer.destroy());
    return { peer, deliver: (msg: unknown) => receive(msg, ALICE) };
  };
  return { session, sent, space, mk, makePeer };
}

const point = (x: number, y: number, time = 0) => ({ cx: x, cy: y, time, pressure: 0.5, pointerType: "mouse" });
const mods = { shift: false, alt: false, ctrl: false };

describe("multi-selection session", () => {
  it("marquee-selects, transforms every item in one U message and undoes them together", (t) => {
    const { session, sent, mk } = setup(t);
    const a = mk("itemAaaaaaaa1", 100, 100);
    const b = mk("itemBbbbbbbb2", 200, 150);
    mk("itemCccccccc3", 700, 700);
    session.prefs.tool = "select";
    assert.equal(session.pointerDown(point(50, 50), mods), true);
    session.pointerMove([point(300, 300)], mods);
    session.pointerUp(point(300, 300), mods);
    assert.deepEqual([...session.selection].sort(), [a.id, b.id]);

    sent.length = 0;
    assert.equal(session.flipSelection("h"), true);
    const batch = sent.filter((m) => m.t === "U");
    assert.equal(batch.length, 1);
    assert.equal(batch[0]!.items.length, 2);
    const flippedA = session.store.get(a.id)!.item;
    assert.notDeepEqual(flippedA.points, a.points);
    assert.equal(flippedA.revision, a.revision + 1);

    session.undo();
    assert.deepEqual(session.store.get(a.id)!.item.points, a.points);
    assert.deepEqual(session.store.get(b.id)!.item.points, b.points);
  });

  it("adds with Shift, removes with Ctrl and refuses another player's marks", (t) => {
    const { session, mk } = setup(t);
    const a = mk("itemAaaaaaaa1", 100, 100);
    const b = mk("itemBbbbbbbb2", 400, 400);
    session.store.put({ ...session.store.get(b.id)!.item, author: BOB }, "temp");
    session.prefs.tool = "select";
    session.pointerDown(point(110, 105), mods);
    session.pointerUp(point(110, 105), mods);
    assert.deepEqual([...session.selection], [a.id]);
    session.pointerDown(point(410, 405), { ...mods, shift: true });
    session.pointerUp(point(410, 405), { ...mods, shift: true });
    assert.equal(session.selection.has(b.id), false);
    session.pointerDown(point(110, 105), { ...mods, ctrl: true });
    session.pointerUp(point(110, 105), { ...mods, ctrl: true });
    assert.equal(session.selection.size, 0);
  });

  it("delivers all rate-paced recolour and queued undo chunks to a second client in order", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    t.mock.method(performance, "now", () => Date.now());
    const { session, sent, makePeer } = setup(t);
    const { peer, deliver } = makePeer();
    const points = Array.from({ length: LIMITS.maxPointsPerItem }, (_, i) => [
      i % 2 ? -750 : 750,
      i / 8 - 250,
      0.5,
    ]).flat();
    const items = Array.from({ length: 60 }, () =>
      makeItem({ mode: "screen", anchor: [0, 0], points, createdAt: 920_000, expiresAt: 1_060_000 }),
    );
    for (const item of items) {
      session.store.put(item, "temp");
      peer.store.put(item, "temp");
    }
    const seen = new Map<string, string[]>();
    peer.store.on((event) => {
      if (event.type !== "update") return;
      const { id, color } = event.entry.item;
      const colors = seen.get(id) ?? [];
      colors.push(color);
      seen.set(id, colors);
    });
    const relay = () => {
      for (const msg of sent.splice(0)) deliver(msg);
    };
    session.prefs.mode = "screen";
    assert.equal(session.selectAll(), items.length);
    assert.equal(session.recolorSelected("#00ff00"), true);
    relay();
    assert.ok(seen.size > 0 && seen.size < items.length, "the operation must exceed the burst budget");
    assert.equal(session.undo()?.type, "update");
    for (let i = 0; i < 200; i++) {
      t.mock.timers.tick(1000);
      relay();
    }
    for (const item of items) {
      assert.deepEqual(seen.get(item.id), ["#00ff00", item.color], item.id);
      const result = peer.store.get(item.id)!.item;
      assert.equal(result.createdAt, item.createdAt);
      assert.equal(result.expiresAt, item.expiresAt);
    }
  });

  it("uses the same normalised geometry locally, remotely and in transform history", (t) => {
    const { session, sent, makePeer } = setup(t);
    const { peer, deliver } = makePeer();
    const item = makeItem({ mode: "screen", anchor: [0, 0], size: 100 });
    session.store.put(item, "temp");
    peer.store.put(item, "temp");
    session.selectedId = item.id;
    assert.equal(session.scaleSelection(6), true);
    assert.equal(sent.length, 1);
    deliver(sent.shift()!);
    const scaled = session.store.get(item.id)!.item;
    assert.equal(scaled.size, 400);
    assert.deepEqual(peer.store.get(item.id)!.item, scaled);
    assert.equal(session.undo()?.type, "update");
    assert.equal(session.redo()?.type, "update");
    assert.deepEqual(session.store.get(item.id)!.item, scaled);
  });

  it("keeps the wrap handle and frame on the resized text during and after a drag", (t) => {
    const { session, space } = setup(t);
    const item = makeItem({
      kind: "text",
      tool: "text",
      mode: "screen",
      anchor: [1, 1],
      text: "A wrapping annotation with several words",
      textWidth: 120,
      size: 20,
      points: [-300, -300, 0.5],
    });
    session.store.put(item, "temp");
    session.selectedId = item.id;
    const initial = session.selectionFrame()!;
    const start = space.toClient(initial.quad[1]!.x, initial.pivot.y, [0, 0]);
    assert.equal(session.startTransformHandle("width-right", start.x, start.y), true);
    session.pointerMove([point(start.x - 40, start.y)], mods);
    const during = session.selectionFrame()!;
    close(during.quad[1]!.x, initial.quad[1]!.x - 40);
    assert.ok(during.quad[2]!.y > initial.quad[2]!.y);
    session.pointerUp(point(start.x - 40, start.y), mods);
    assert.equal(session.store.get(item.id)!.item.textWidth, 80);
    assert.deepEqual(session.selectionFrame()!.quad, during.quad);
  });

  it("does not send or record a handle click or a drag returned to its origin", (t) => {
    const { session, sent, mk, space } = setup(t);
    const item = mk("itemAaaaaaaa1", 100, 100);
    session.selectedId = item.id;
    const corner = session.selectionFrame()!.quad[2]!;
    const { x, y } = space.toClient(corner.x, corner.y);
    assert.equal(session.startTransformHandle("se", x, y), true);
    session.pointerUp(point(x, y), mods);
    assert.equal(session.startTransformHandle("se", x, y), true);
    session.pointerMove([point(x + 50, y + 50)], mods);
    assert.notEqual(session.store.get(item.id)!.item, item);
    session.pointerUp(point(x, y), mods);
    assert.equal(session.store.get(item.id)!.item, item);
    assert.equal(session.history.canUndo, false);
    assert.equal(sent.length, 0);
  });
});

describe("drawing aid gestures", () => {
  it("uses the snapped start for perspective lines and arrows, and respects Alt bypass", (t) => {
    const { session } = setup(t);
    const identity = (p: Pt) => p;
    Object.assign(session.scene!, { width: 1000, height: 1000 });
    Object.assign(canvas, {
      dimensions: { sceneX: 0, sceneY: 0, sceneWidth: 1000, sceneHeight: 1000, size: 100 },
      canvasCoordinatesFromClient: identity,
      clientCoordinatesFromCanvas: identity,
    });
    session.rebuildSpaces();
    session.prefs.mode = "map";
    session.prefs.gridSnap = true;
    session.prefs.shape = "line";
    session.prefs.arrow = "straight";
    session.guides.rulers = [
      { id: "vp", kind: "perspective", mode: "map", on: true, vps: [{ x: 300, y: 100 }], parallels: false },
    ];
    for (const tool of ["shape", "arrow"] as const) {
      session.prefs.tool = tool;
      session.pointerDown(point(24, 24), mods);
      session.pointerUp(point(170, 100, 16), mods);
      const item = session.store.ordered().at(-1)!.item;
      assert.deepEqual(item.points.slice(0, 2), [0, 0]);
      close(item.points[4]!, item.points[3]! / 3, 0.1);
      assert.equal(item.tool, tool === "shape" ? "line" : "arrow");
    }
    session.pointerDown(point(24, 24), { ...mods, alt: true });
    session.pointerUp(point(170, 100, 16), { ...mods, alt: true });
    assert.deepEqual(session.store.ordered().at(-1)!.item.points.slice(3, 5), [150, 100]);
  });

  it("keeps Shift brush lines attached to the perspective ruler through pointerup", (t) => {
    const { session } = setup(t);
    session.prefs.tool = "draw";
    session.prefs.mode = "screen";
    session.guides.rulers = [
      { id: "vp", kind: "perspective", mode: "screen", on: true, vps: [{ x: 300, y: 0 }], parallels: false },
    ];
    const shift = { ...mods, shift: true };
    session.pointerDown(point(500, 500), shift);
    session.pointerMove([point(530, 520, 16)], shift);
    session.pointerUp(point(600, 550, 32), shift);
    const pts = session.store.ordered().at(-1)!.item.points;
    for (let i = 1; i < pts.length; i += 3) assert.equal(pts[i], 0);
    assert.deepEqual(pts.slice(-3, -1), [100, 0]);
  });

  it("includes a subpixel pointerup endpoint, while preserving an opted-out stabilizer's lag", (t) => {
    const { session } = setup(t);
    session.prefs.tool = "draw";
    session.prefs.mode = "screen";
    session.prefs.stabilizerStrength = 1;
    for (const [mode, catchUp] of [
      ["lazy", true],
      ["off", false],
      ["lazy", false],
    ] as const) {
      session.prefs.stabilizer = mode;
      session.prefs.stabilizerFinish = catchUp;
      session.pointerDown(point(500, 500), mods);
      session.pointerMove([point(600, 500, 16)], mods);
      session.pointerUp(point(600.1, 500, 32), mods);
      const pts = session.store.ordered().at(-1)!.item.points;
      if (mode === "lazy" && !catchUp) assert.ok(pts.at(-3)! < 90);
      else assert.deepEqual(pts.slice(-3, -1), [100.1, 0]);
    }
  });
});
