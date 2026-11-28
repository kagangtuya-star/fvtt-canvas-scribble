import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { MODULE_ID } from "../src/constants.ts";
import { quantizePoints } from "../src/core/codec.ts";
import { sanitizeItem, toWire } from "../src/core/sanitize.ts";
import { ScreenSpace } from "../src/core/space.ts";
import { cleanText, layoutText } from "../src/core/text-layout.ts";
import type { MeasureText } from "../src/core/text-layout.ts";
import { Session } from "../src/session.ts";
import type { TextRequest } from "../src/session.ts";
import { scaleItem } from "../src/tools/select.ts";
import { ALICE, BOB, GM, SCENE, makeItem } from "./helpers.ts";

const glyphs = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const measure: MeasureText = (text, size) => ({
  width: [...glyphs.segment(text)].reduce((w, { segment }) => w + (/^[a-z ]$/i.test(segment) ? size / 2 : size), 0),
  fontBoundingBoxAscent: size * 0.9,
  fontBoundingBoxDescent: size * 0.2,
});

describe("text layout", () => {
  it("uses measured glyph widths and preserves explicit, blank and trailing lines", () => {
    const layout = layoutText({ text: "中文ab\n\n末行\n", size: 20 }, measure);
    assert.equal(layout.width, 60);
    assert.equal(layout.height, 100);
    assert.deepEqual(
      layout.lines.map((l) => l.text),
      ["中文ab", "", "末行", ""],
    );
    assert.ok(layout.bounds[2] >= 60);
  });

  it("wraps to an explicit width without splitting emoji or losing whitespace", () => {
    const text = "中文👩‍💻 ab 末\n尾";
    const layout = layoutText({ text, size: 20, textWidth: 40 }, measure);
    assert.equal(layout.width, 40);
    assert.deepEqual(
      layout.lines.map((l) => l.text),
      ["中文", "👩‍💻 a", "b 末", "尾"],
    );
    assert.equal(
      layout.lines
        .slice(0, -1)
        .map((l) => l.text)
        .join(""),
      text.split("\n")[0],
    );
    assert.equal(layoutText({ text: "中文", size: 20, textWidth: 1 }, measure).lines.length, 2);
  });

  it("includes glyph overhang, ascenders, descenders and halo in raster bounds", () => {
    const layout = layoutText({ text: "f", size: 20 }, () => ({
      width: 10,
      actualBoundingBoxLeft: 5,
      actualBoundingBoxRight: 25,
      actualBoundingBoxAscent: 30,
      actualBoundingBoxDescent: 12,
    }));
    assert.ok(layout.bounds[0] < -5 && layout.bounds[1] < 0);
    assert.ok(layout.bounds[2] > 25 && layout.bounds[3] > layout.lines[0]!.baseline + 12);
  });

  it("normalizes pasted line endings without removing manual newlines or spaces", () => {
    assert.equal(cleanText(" a\r\nb\rc\t\u0000\n"), " a\nb\nc\n");
  });

  it("round-trips optional wrapping widths and keeps old text in automatic layout", () => {
    const ctx = { author: ALICE, scene: SCENE, now: 1_000_000, allowPermanent: true };
    const item = makeItem({ kind: "text", tool: "text", text: "中文\nabc", textWidth: 80, points: [0, 0, 0.5] });
    assert.equal(sanitizeItem(toWire(item), ctx)?.textWidth, 80);
    const wire = toWire(item);
    delete wire.textWidth;
    assert.equal(sanitizeItem(wire, ctx)?.textWidth, undefined);
    assert.equal(sanitizeItem({ ...wire, textWidth: Infinity }, ctx)?.textWidth, undefined);
    assert.equal(sanitizeItem({ ...wire, textWidth: -10 }, ctx)?.textWidth, 1);
    assert.equal(sanitizeItem({ ...wire, mode: "screen", textWidth: 1e9 }, ctx)?.textWidth, 4000);
    assert.equal(scaleItem(item, 0, 0, 2, 2).textWidth, 160);
    assert.equal(scaleItem(item, 0, 0, 2, 2).size, item.size * 2);
  });
});

function setup(t: TestContext, gm = false) {
  const users = Object.assign(
    new Map([
      [ALICE, { id: ALICE, role: 1, active: true }],
      [BOB, { id: BOB, role: 1, active: true }],
      [GM, { id: GM, role: 4, active: true, isGM: true }],
    ]),
    { activeGM: undefined as unknown },
  );
  if (gm) users.activeGM = users.get(GM);
  const notices: string[] = [];
  const game = {
    user: users.get(gm ? GM : ALICE),
    users,
    time: { serverTime: 1_000_000 },
    i18n: { localize: (key: string) => key, format: (key: string) => key },
  };
  for (const [key, value] of Object.entries({
    game,
    canvas: {},
    ui: { notifications: { warn: (s: string) => notices.push(s), info() {} } },
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => (old ? Object.defineProperty(globalThis, key, old) : Reflect.deleteProperty(globalThis, key)));
  }
  const sent: Record<string, any>[] = [];
  let receive: (payload: unknown, sender?: unknown) => void = () => undefined;
  const session = new Session({
    on: (_event, fn) => {
      receive = fn;
    },
    off() {},
    emit: (_event, payload) => sent.push(payload as Record<string, any>),
  });
  const scene = { id: SCENE, flags: { [MODULE_ID]: { items: {} } }, async update() {} } as unknown as FoundryScene;
  session.scene = scene;
  session.net.scene = SCENE;
  const space = new ScreenSpace({ left: 0, top: 0, width: 1000, height: 1000 });
  t.mock.method(session, "space", () => space);
  t.after(() => session.destroy());
  const item = makeItem({
    kind: "text",
    tool: "text",
    text: "original\n中文",
    points: [100, 100, 0.5],
    mode: "screen",
    anchor: [-1, -1],
    layer: "top",
  });
  const request = (original = item): TextRequest => ({
    target: { mode: original.mode, space, anchor: original.anchor },
    cx: 100,
    cy: 100,
    size: original.size,
    color: original.color,
    scene: SCENE,
    point: { x: 100, y: 100 },
    original,
  });
  session.store.put(item, "temp");
  return {
    session,
    item,
    request,
    sent,
    notices,
    game,
    scene,
    deliver: (payload: unknown, sender = BOB) => receive(payload, sender),
  };
}

describe("text editing session", () => {
  it("updates the same item, keeps ownership and lifetime, and supports undo/redo", (t) => {
    const { session, item, request, sent } = setup(t);
    assert.equal(session.commitText(request(), "changed\n文字", 60), true);
    const next = session.store.get(item.id)!.item;
    assert.equal(session.store.size, 1);
    assert.equal(next.text, "changed\n文字");
    assert.equal(next.textWidth, 60);
    for (const key of ["id", "author", "createdAt", "expiresAt", "layer", "anchor"] as const)
      assert.deepEqual(next[key], item[key]);
    assert.equal(next.revision, 1);
    assert.equal(sent[0]?.t, "u");
    session.undo();
    assert.equal(session.store.get(item.id)?.item.text, item.text);
    assert.equal(session.store.get(item.id)?.item.textWidth, undefined);
    session.redo();
    assert.equal(session.store.get(item.id)?.item.textWidth, 60);
    session.selectedId = item.id;
    assert.equal(session.resetTextWidth(), true);
    assert.equal(session.store.get(item.id)?.item.textWidth, undefined);
  });

  it("records no update for unchanged text and makes clearing one undoable delete", (t) => {
    const { session, item, request, sent } = setup(t);
    assert.equal(session.commitText(request(), item.text!), true);
    assert.equal(sent.length, 0);
    assert.equal(session.history.size.undo, 0);
    assert.equal(session.commitText(request(), " \n"), true);
    assert.equal(session.store.has(item.id), false);
    session.undo();
    assert.equal(session.store.get(item.id)?.item.text, item.text);
  });

  it("refuses stale, deleted, expired and unauthorized edits without replacing the item", (t) => {
    const { session, item, request, notices, game } = setup(t);
    session.store.put({ ...item, text: "remote", revision: 1 }, "temp");
    assert.equal(session.commitText(request(), "draft"), false);
    assert.equal(session.store.get(item.id)?.item.text, "remote");
    session.store.remove(item.id);
    assert.equal(session.commitText(request(), "draft"), false);
    session.store.put({ ...item, expiresAt: 0, fadeDuration: 0 }, "temp");
    assert.equal(session.commitText(request(), "draft"), false);
    session.store.put({ ...item, author: BOB }, "temp");
    assert.equal(session.commitText(request(), "draft"), false);
    game.user!.role = 0;
    session.store.put(item, "temp");
    assert.equal(session.commitText(request(), "draft"), false);
    assert.ok(notices.some((n) => n.endsWith("Text.Conflict")));
  });

  it("creates at the original space point and rejects commits into another scene", (t) => {
    const { session, request } = setup(t);
    const req = request();
    delete req.original;
    req.cx = 900;
    req.cy = 800;
    assert.equal(session.commitText(req, "new\ntext"), true);
    assert.deepEqual(session.selectedEntry()?.item.points, quantizePoints([100, 100, 0.5]));
    assert.equal(session.commitText({ ...req, scene: "OtherScene" }, "wrong"), false);
  });

  it("edits through the Text tool and moves or wraps text through Select", (t) => {
    const { session, item } = setup(t);
    let opened: TextRequest | undefined;
    session.onTextRequest = (req) => {
      opened = req;
    };
    assert.equal(session.editText(item.id), true);
    assert.equal(opened?.original?.id, item.id);
    session.prefs.tool = "select";
    const mods = { shift: false, alt: false };
    const point = (x: number, y: number) => ({ cx: x, cy: y, time: 0, pressure: 0.5, pointerType: "mouse" });
    assert.equal(session.pointerDown(point(101, 101), mods), true);
    session.pointerUp(point(121, 131), mods);
    assert.deepEqual(session.store.get(item.id)?.item.points, quantizePoints([120, 130, 0.5]));
    const size = session.store.get(item.id)!.item.size;
    session.startTransformHandle("width-right", 150, 130);
    session.pointerUp(point(180, 130), mods);
    const next = session.store.get(item.id)!.item;
    assert.ok(next.textWidth! > 0);
    assert.equal(next.size, size);
    session.undo();
    assert.equal(session.store.get(item.id)?.item.textWidth, undefined);
    session.prefs.tool = "text";
    assert.equal(session.pointerDown(point(121, 131), mods), true);
    assert.equal(opened?.original?.id, item.id);
  });

  it("queues permanent edits through the active GM without changing the author", async (t) => {
    const { session, item, request, scene } = setup(t, true);
    const original = { ...item, mode: "map" as const, expiresAt: null };
    session.store.put(original, "stored");
    const wire = toWire(original);
    (scene.flags as any)[MODULE_ID].items[original.id] = wire;
    assert.equal(session.commitText(request(original), "permanent edit", 50), true);
    assert.equal(session.writer.queued(scene, item.id)?.text, "permanent edit");
    assert.equal(session.writer.queued(scene, item.id)?.author, ALICE);
    await session.writer.drain();
  });

  it("receives text updates with width, authenticates the owner and rejects another player's update", (t) => {
    const { session, item, deliver } = setup(t, true);
    const changed = toWire({ ...item, text: "remote\n中文", textWidth: 30, revision: 1, author: BOB });
    deliver({ v: 1, t: "u", scene: SCENE, item: changed }, ALICE);
    assert.equal(session.store.get(item.id)?.item.text, "remote\n中文");
    assert.equal(session.store.get(item.id)?.item.textWidth, 30);
    assert.equal(session.store.get(item.id)?.item.author, ALICE);
    deliver({ v: 1, t: "u", scene: SCENE, item: { ...changed, text: "forged", revision: 2 } }, BOB);
    assert.equal(session.store.get(item.id)?.item.text, "remote\n中文");
  });

  it("keeps the original and history when the GM refuses an edit over the storage budget", (t) => {
    const { session, item, request } = setup(t, true);
    const original = { ...item, mode: "map" as const, expiresAt: null };
    session.store.put(original, "stored");
    t.mock.method(session.writer, "write", () => "budget");
    assert.equal(session.commitText(request(original), "larger text", 500), false);
    assert.equal(session.store.get(item.id)?.item, original);
    assert.equal(session.history.size.undo, 0);
  });

  it("keeps a permanent draft uncommitted while no GM can persist it", (t) => {
    const { session, item, request } = setup(t);
    const original = { ...item, mode: "map" as const, expiresAt: null };
    session.store.put(original, "stored");
    assert.equal(session.commitText(request(original), "unsaved draft"), false);
    assert.equal(session.store.get(item.id)?.item, original);
    assert.equal(session.history.size.undo, 0);
  });
});
