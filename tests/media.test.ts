import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { quantizePoints } from "../src/core/codec.ts";
import { MODULE_ID } from "../src/constants.ts";
import { flagKey, readMedia } from "../src/foundry/media-store.ts";
import {
  decodeBake,
  decodeBakeFile,
  decodeBakeState,
  encodeBake,
  encodeBakeFile,
  MAX_BAKE_FILE_BYTES,
} from "../src/media/bake.ts";
import { MEDIA_BRUSHES } from "../src/media/brushes.ts";
import { strokeChunks } from "../src/media/controller.ts";
import { DAB_FLOATS, DabWalker, GATHER_FLOATS, Reservoir } from "../src/media/dabs.ts";
import { MediaEngine } from "../src/media/engine.ts";
import type { EngineOut } from "../src/media/engine.ts";
import { fromHalf, toHalf } from "../src/media/half.ts";
import { CHUNK, CHUNK_CELLS, GPU_WET_CHUNKS, PIG, PIG_CHANNELS } from "../src/media/layout.ts";
import { sanitizeStroke, strokeToWire } from "../src/media/ops.ts";
import type { MediaStroke } from "../src/media/ops.ts";
import { paperTile } from "../src/media/paper.ts";
import { GLAZE_REF, mixHex, pigmentOf } from "../src/media/pigment.ts";
import { CpuBackend } from "../src/media/sim/cpu.ts";
import type { SimBackend } from "../src/media/sim/backend.ts";
import { PROTOCOL_VERSION, parseMessage } from "../src/net/protocol.ts";

const require = createRequire(import.meta.url);
const spectral = require("spectral.js") as {
  Color: new (rgb: number[] | string) => { sRGB: number[] };
  mix: (...pairs: [unknown, number][]) => { sRGB: number[] };
};

const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const dist = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

/** A small engine with a manual clock. */
function engine(paper: "cold" | "xuan" | "canvas" = "cold") {
  const out: EngineOut[] = [];
  const be = new CpuBackend();
  const eng = new MediaEngine(be, (m) => out.push(m));
  let now = 0;
  eng.now = () => now;
  eng.handle({ t: "init", paper, seed: 3, drying: 1, backend: "cpu", clock: 0 });
  const run = (steps: number) => {
    for (let i = 0; i < steps; i++) {
      now += 50;
      eng.tick();
    }
  };
  const paint = (id: string, brush: keyof typeof MEDIA_BRUSHES, color: string, pts: number[], size = 24, at = 100) => {
    eng.handle({ t: "stroke", id, brush, color, size, pigment: 0.8, water: 0.6, seed: 7, at });
    eng.handle({ t: "points", id, pts: Float32Array.from(pts) });
    eng.handle({ t: "end", id });
  };
  return { eng, be, out, run, paint, advance: (ms: number) => (now += ms) };
}

const line = (x0: number, x1: number, y: number, step = 4) => {
  const pts: number[] = [];
  for (let x = x0; x <= x1; x += step) pts.push(x, y, 0.6);
  return pts;
};

describe("half floats", () => {
  it("round-trips within half precision and saturates safely", () => {
    for (const v of [0, 1, 0.5, 1e-3, 123.4, 4096, 65504]) {
      const back = fromHalf(toHalf(v));
      assert.ok(Math.abs(back - v) <= Math.max(1e-7, Math.abs(v) * 1e-3), `${v} → ${back}`);
    }
    assert.equal(fromHalf(toHalf(Number.NaN)), 0);
    assert.equal(fromHalf(toHalf(1e9)), 65504);
    assert.equal(fromHalf(0x7c00), 0, "infinity decodes as 0");
  });
});

describe("pigment optics", () => {
  it("mixes opaque body colour like spectral.js (blue + yellow = green)", () => {
    for (const [a, b] of [
      ["#0000ff", "#ffff00"],
      ["#c02030", "#2060c0"],
      ["#ffffff", "#101010"],
    ] as const) {
      const ours = rgb(mixHex([a, b], [40, 40], "body"));
      const ref = spectral.mix([new spectral.Color(a), 1], [new spectral.Color(b), 1]).sRGB.map(Math.round);
      assert.ok(dist(ours, ref) <= 14, `${a}+${b}: ${ours} vs ${ref}`);
    }
    const [r, g, b] = rgb(mixHex(["#0000ff", "#ffff00"], [40, 40], "body"));
    assert.ok(g > r && g > b, "subtractive mixing gives green");
  });

  it("shows the chosen colour for a reference glaze and darkens as layers accumulate", () => {
    const hex = "#1f4ea8";
    const p = pigmentOf(hex, "glaze", 1);
    // A reference wash over white reproduces the swatch.
    const one = rgb(mixHex([hex], [GLAZE_REF], "glaze"));
    assert.ok(dist(one, rgb(hex)) <= 18, `${one} vs ${rgb(hex)}`);
    const two = rgb(mixHex([hex], [2 * GLAZE_REF], "glaze"));
    const four = rgb(mixHex([hex], [4 * GLAZE_REF], "glaze"));
    const lum = (c: number[]) => c[0]! * 0.2126 + c[1]! * 0.7152 + c[2]! * 0.0722;
    assert.ok(lum(two) < lum(one) && lum(four) < lum(two), "more ink, darker");
    assert.ok(p.s < 0.2, "glazes scatter little");
  });
});

describe("brush reservoir", () => {
  it("deposits while it has paint and runs out evenly across the bristles", () => {
    const brush = MEDIA_BRUSHES.gouache;
    const res = new Reservoir({ brush: "gouache", color: "#c02030", pigment: 0.8, water: 0.3, seed: 9 });
    const walker = new DabWalker(24, brush);
    const dabs = walker.push(line(0, 2000, 50, 6));
    walker.finish(dabs);
    const buf = new Float32Array(DAB_FLOATS);
    const gather = new Float32Array(GATHER_FLOATS);
    for (let b = 0; b < 8; b++) gather[b * 16] = 1; // full contact, dry paper
    const start = res.load[PIG.A]!;
    for (const d of dabs.slice(0, 120)) {
      res.pack(d, buf, 0);
      res.exchange(gather, 0);
    }
    const bands = Array.from({ length: 8 }, (_, b) => res.load[b * PIG_CHANNELS + PIG.A]!);
    assert.ok(Math.max(...bands) < start, "the load drains");
    assert.ok(Math.max(...bands) - Math.min(...bands) < 0.25 * Math.max(...bands), `bands even: ${bands}`);
  });
});

describe("CPU simulation", () => {
  it("conserves pigment while water flows, and dries into deposits", () => {
    const { be, run, paint } = engine();
    paint("a", "watercolor", "#1f4ea8", line(20, 300, 100));
    run(2);
    const before = be.totals();
    assert.ok(before.pigment > 0 && before.water > 0);
    run(80);
    const mid = be.totals();
    assert.ok(Math.abs(mid.pigment - before.pigment) / before.pigment < 1e-3, `${mid.pigment} vs ${before.pigment}`);
    assert.ok(mid.water < before.water, "water absorbs and evaporates");
  });

  it("lets wet colours mix and keeps dry layers separate", () => {
    const { eng, be, run, paint } = engine("canvas");
    paint("blue", "oil", "#2060c0", line(20, 200, 60));
    run(2);
    paint("yellow", "oil", "#f0d020", line(20, 200, 60));
    run(4);
    const p = be.probe(50, 30)!;
    // Both pigments are in the same cell (K in the blue and the red groups).
    assert.ok(p.P[0]! + p.D[0]! > 0 && p.P[7]! + p.D[7]! > 0);
    eng.handle({ t: "dryAll" });
    assert.ok(be.quiet(0, 0));
  });

  it("undoes the newest stroke unless later paint touched it", () => {
    const { eng, be, out, run, paint } = engine();
    paint("a", "watercolor", "#1f4ea8", line(20, 120, 40));
    run(2);
    const afterA = be.totals().pigment;
    paint("b", "watercolor", "#e0c020", line(20, 120, 40));
    run(2);
    eng.handle({ t: "undo", id: "a", req: 1 });
    assert.deepEqual(out.filter((m) => m.t === "undone").at(-1), { t: "undone", req: 1, ok: false });
    eng.handle({ t: "undo", id: "b", req: 2 });
    assert.equal(out.filter((m) => m.t === "undone").at(-1)?.ok, true);
    assert.ok(Math.abs(be.totals().pigment - afterA) / afterA < 0.05);
  });

  it("takes back the paint that flowed into a neighbouring chunk on undo", () => {
    const { eng, be, out, run, paint } = engine("xuan");
    // Ends a few cells before the chunk border (cell 128): only the flow crosses it.
    paint("a", "wash", "#1f4ea8", line(200, 240, 100), 24);
    run(80);
    const spilled = () => {
      let a = 0;
      for (let y = 30; y < 70; y++)
        for (let x = 128; x < 150; x++) a += be.probe(x, y)!.P[PIG.A]! + be.probe(x, y)!.D[PIG.A]!;
      return a;
    };
    assert.ok(be.has(1, 0) && spilled() > 0, "the wash spreads over the border");
    eng.handle({ t: "undo", id: "a", req: 1 });
    assert.deepEqual(out.filter((m) => m.t === "undone").at(-1)?.removed, ["0_0", "1_0"]);
    assert.ok(!be.has(1, 0) || spilled() === 0);
    assert.equal(be.totals().pigment, 0);
  });

  it("bakes dry chunks into a validated PNG that loads elsewhere", () => {
    const a = engine();
    a.paint("a", "ink", "#101010", line(20, 200, 60));
    a.run(3);
    a.eng.handle({ t: "flush", req: 5 });
    const baked = a.out.find((m) => m.t === "baked" && m.key === "0_0") as Extract<EngineOut, { t: "baked" }>;
    assert.ok(baked?.data && !baked.empty);
    const halves = decodeBake(baked.data);
    assert.ok(halves && halves.length === PIG_CHANNELS * CHUNK_CELLS);
    const b = engine();
    b.eng.handle({ t: "load", key: "0_0", data: baked.data, at: 1 });
    assert.deepEqual(
      b.out.find((m) => m.t === "loaded"),
      { t: "loaded", key: "0_0", ok: true },
    );
    assert.deepEqual(b.be.exportDeposit(0, 0), halves);
    assert.equal(a.be.has(0, 0), false, "the dry chunk no longer occupies full simulation planes");
  });

  it("rejects corrupt bakes", () => {
    const valid = encodeBake(new Uint16Array(PIG_CHANNELS * CHUNK_CELLS));
    assert.ok(decodeBake(valid));
    const broken = valid.slice();
    broken[broken.length - 20] ^= 0xff;
    assert.equal(decodeBake(broken), null);
    assert.equal(decodeBake(valid.slice(0, 40)), null);
    assert.equal(decodeBake(new Uint8Array(100)), null);
  });

  it("builds periodic paper tiles", () => {
    const tile = paperTile("xuan", 1);
    assert.ok(tile.props.aniso > 0.5);
    assert.ok(tile.h.every((v) => v >= 0 && v <= 1));
  });
});

const bakedChunk = (out: EngineOut[], key = "0_0") => {
  const bake = out.findLast((m) => m.t === "baked" && m.key === key);
  assert.ok(bake?.t === "baked" && bake.data, `missing bake for ${key}`);
  return bake.data;
};

describe("wet-media checkpoint reconciliation", () => {
  it("imports delayed base pigment and reapplies the newer stroke exactly once", () => {
    const gm = engine();
    gm.paint("base", "ink", "#102030", [80, 90, 0.7]);
    gm.eng.handle({ t: "flush", req: 1 });
    const client = engine();
    client.paint("later", "ink", "#b04020", [140, 90, 0.7], 24, 300);
    client.run(1);
    client.eng.handle({ t: "load", key: "0_0", data: bakedChunk(gm.out), at: 200, revision: "1" });
    assert.deepEqual(
      client.out.findLast((m) => m.t === "loaded"),
      {
        t: "loaded",
        key: "0_0",
        ok: true,
        revision: "1",
      },
    );
    const mass = () => client.be.totals().pigment;
    const after = mass();
    assert.ok(client.be.probe(40, 45)!.D[PIG.A]! > 0, "the older pigment was imported");
    assert.ok(client.be.probe(70, 45)!.P[PIG.A]! > 0, "the new mark survived");
    client.eng.handle({ t: "load", key: "0_0", data: bakedChunk(gm.out), at: 200 });
    assert.ok(Math.abs(mass() - after) < 1e-6, "the new mark was not duplicated");
  });

  it("replays the unbaked end of a cross-chunk stroke without painting over the baked end", () => {
    const gm = engine();
    const pts = line(200, 400, 100);
    gm.paint("across", "ink", "#102030", pts);
    gm.eng.handle({ t: "flush", req: 1 });
    const left = bakedChunk(gm.out);
    assert.equal(decodeBakeState(left)?.coverage?.strokes[0]?.[0], "across");
    const client = engine();
    client.eng.handle({ t: "load", key: "0_0", data: left, at: 200 });
    client.paint("across", "ink", "#102030", pts);
    client.eng.handle({ t: "flush", req: 2 });
    client.eng.handle({ t: "bake", key: "0_0", req: 3 });
    assert.deepEqual(bakedChunk(client.out), left);
    assert.ok(decodeBake(bakedChunk(client.out, "1_0"))?.some((x) => x !== 0));
  });

  it("refuses undo with a snapshot taken before a legacy base arrived", () => {
    const gm = engine();
    gm.paint("base", "ink", "#102030", [80, 90, 0.7]);
    gm.eng.handle({ t: "flush", req: 1 });
    const legacy = encodeBake(decodeBake(bakedChunk(gm.out))!);
    const client = engine();
    client.paint("local", "ink", "#b04020", [140, 90, 0.7], 24, 100);
    client.run(1);
    client.eng.handle({ t: "load", key: "0_0", data: legacy, at: 200 });
    client.eng.handle({ t: "undo", id: "local", req: 2 });
    assert.deepEqual(
      client.out.findLast((m) => m.t === "undone"),
      { t: "undone", req: 2, ok: false },
    );
    assert.ok(client.be.probe(40, 45)!.D[PIG.A]! > 0, "undo must preserve the newly loaded base");
  });

  it("keeps the preceding stroke when two strokes are processed in the same tick", () => {
    const { eng, be, out, run, paint } = engine();
    paint("a", "ink", "#102030", [100, 100, 0.6]);
    paint("b", "ink", "#b04020", [100, 100, 0.6]);
    run(1);
    const before = be.totals().pigment;
    eng.handle({ t: "undo", id: "b", req: 1 });
    assert.ok(be.totals().pigment > 0 && be.totals().pigment < before);
    eng.handle({ t: "undo", id: "a", req: 2 });
    assert.deepEqual(
      out.findLast((m) => m.t === "undone"),
      { t: "undone", req: 2, ok: true, removed: ["0_0"] },
    );
    assert.equal(be.totals().pigment, 0);
  });

  it("streams dry display data only when visible and restores it at the right resolution", () => {
    const { eng, be, out, run, paint } = engine();
    eng.handle({ t: "view", x0: 1, y0: 0, x1: 1, y1: 0 });
    paint("a", "ink", "#102030", [100, 100, 0.6]);
    eng.handle({ t: "flush", req: 1 });
    assert.equal(be.has(0, 0), false);
    const display = () => out.findLast((m) => m.t === "display" && m.key === "0_0");
    assert.equal(display(), undefined);
    eng.handle({ t: "view", x0: 0, y0: 0, x1: 31, y1: 31 });
    run(1);
    const zoomedOut = display();
    assert.ok(zoomedOut?.t === "display" && zoomedOut.data?.length === 32 * 32 * 8);
    eng.handle({ t: "view", x0: 0, y0: 0, x1: 0, y1: 0 });
    run(1);
    const full = display();
    assert.ok(full?.t === "display" && full.data?.length === CHUNK * CHUNK * 8);
    eng.handle({ t: "view", x0: 1, y0: 0, x1: 1, y1: 0 });
    assert.deepEqual(display(), { t: "display", key: "0_0", data: null });
  });
});

it("applies a wide stroke across more chunks than the GPU atlas can hold without losing its leading dabs", () => {
  const used = new Set<string>();
  const be = new CpuBackend();
  let settled = 0;
  const backend = new Proxy(be, {
    get(target, property) {
      if (property === "kind") return "gpu";
      if (property === "ensure" || property === "settle")
        return (cx: number, cy: number) => {
          const key = `${cx}_${cy}`;
          if (property === "ensure") {
            used.add(key);
            assert.ok(used.size <= GPU_WET_CHUNKS, "the engine never asks the backend to evict a reserved slot");
          } else {
            used.delete(key);
            settled++;
          }
          target[property](cx, cy);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SimBackend;
  const out: EngineOut[] = [];
  const eng = new MediaEngine(backend, (m) => out.push(m));
  eng.handle({ t: "init", paper: "cold", seed: 3, drying: 1, backend: "gpu", clock: 0 });
  eng.handle({
    t: "stroke",
    id: "wide",
    brush: "wash",
    color: "#102030",
    size: 600,
    pigment: 0.8,
    water: 0.6,
    seed: 7,
  });
  eng.handle({ t: "points", id: "wide", pts: Float32Array.from(line(200, 4400, 256, 200)) });
  eng.handle({ t: "end", id: "wide" });
  eng.handle({ t: "flush", req: 1 });
  assert.ok(settled > 0, "the test exceeds atlas capacity");
  const halves = decodeBake(bakedChunk(out, "0_1"));
  assert.ok(halves?.[PIG.A * CHUNK_CELLS + 100], "flush saves the first dab even if the batch had to settle it early");
});

describe("wet-media strokes on the wire", () => {
  const ctx = { mapExtent: { w: 4000, h: 3000 }, now: 1_000_000 };
  const stroke: MediaStroke = {
    id: "abcDEF123",
    brush: "watercolor",
    color: "#1f4ea8",
    size: 24,
    pigment: 0.6,
    water: 0.5,
    seed: 123456,
    points: quantizePoints([10, 10, 0.5, 40, 12, 0.7]),
    at: 1_000_000,
  };

  it("round-trips through sanitizeStroke", () => {
    const back = sanitizeStroke(JSON.parse(JSON.stringify(strokeToWire(stroke))), ctx);
    assert.deepEqual(back, stroke);
  });

  it("rejects malformed or out-of-range strokes", () => {
    const wire = strokeToWire(stroke);
    for (const bad of [
      { ...wire, b: "flamethrower" },
      { ...wire, c: "red" },
      { ...wire, z: 0 },
      { ...wire, z: 10_000 },
      { ...wire, l: 2 },
      { ...wire, w: -1 },
      { ...wire, sd: 1.5 },
      { ...wire, at: ctx.now + 10 * 3600_000 },
      { ...wire, id: "../etc" },
      { ...wire, pts: "garbage" },
    ])
      assert.equal(sanitizeStroke(bad, ctx), null, JSON.stringify(bad).slice(0, 60));
  });

  it("parses the media messages and bounds replies", () => {
    const env = (m: Record<string, unknown>) => ({ v: PROTOCOL_VERSION, scene: "scene1", ...m });
    const wire = strokeToWire(stroke);
    assert.ok(parseMessage(env({ t: "ms", s: wire })));
    assert.ok(parseMessage(env({ t: "me", s: wire })));
    assert.ok(parseMessage(env({ t: "mp", id: "abc", from: 2, pts: wire.pts })));
    assert.ok(parseMessage(env({ t: "mu", id: "abc" })));
    assert.ok(parseMessage(env({ t: "mq" })));
    assert.ok(parseMessage(env({ t: "mr", to: "user1", strokes: [wire] })));
    assert.equal(parseMessage(env({ t: "mp", id: "abc", from: -1, pts: wire.pts })), null);
    assert.equal(parseMessage(env({ t: "ms", s: "x" })), null);
    assert.equal(parseMessage(env({ t: "mr", to: "user1", strokes: new Array(21).fill(wire) })), null);
  });

  it("finds the chunks a stroke can reach", () => {
    assert.deepEqual(strokeChunks([10, 10, 0.5], 4), ["0_0"]);
    assert.deepEqual(strokeChunks([250, 10, 0.5, 262, 10, 0.5], 4), ["0_0", "1_0"]);
    assert.deepEqual(strokeChunks([-5, -5, 0.5], 2), ["-1_-1"]);
  });
});

describe("bake data files", () => {
  it("round-trips every byte without image decoding or color conversion", () => {
    const png = Uint8Array.from({ length: 20_000 }, (_, i) => i % 256);
    const data = encodeBakeFile(png);
    assert.deepEqual(decodeBakeFile(data), png);
    assert.equal(JSON.parse(new TextDecoder().decode(data)).version, 1);
  });

  it("rejects malformed, unknown and oversized envelopes", () => {
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    for (const value of [
      null,
      {},
      { format: "other", version: 1, png: "AA==" },
      { format: "canvas-scribble-media", version: 2, png: "AA==" },
      { format: "canvas-scribble-media", version: 1, png: "invalid!" },
      { format: "canvas-scribble-media", version: 1, png: "" },
    ]) {
      assert.equal(decodeBakeFile(bytes(value)), null);
    }
    assert.equal(decodeBakeFile(new Uint8Array(MAX_BAKE_FILE_BYTES + 1)), null);
  });
});

describe("media scene flags", () => {
  const scene = (media: unknown) => ({ id: "scene1", flags: { [MODULE_ID]: { media } } }) as unknown as FoundryScene;

  it("keeps only valid chunk records and papers", () => {
    const flags = readMedia(
      scene({
        paper: "xuan",
        chunks: {
          [flagKey("0_0")]: { r: 2, t: 100, n: 5000 },
          [flagKey("-3_7")]: { r: 1, t: 100, n: 10 },
          "c../../x": { r: 1, t: 1, n: 1 },
          [flagKey("1_1")]: { r: 0, t: 1, n: 1 },
          [flagKey("2_2")]: { r: 1, t: 1, n: 99_999_999 },
          [flagKey("3_3")]: "nope",
        },
      }),
    );
    assert.equal(flags.paper, "xuan");
    assert.deepEqual([...flags.chunks.keys()].sort(), ["-3_7", "0_0"]);
    assert.equal(readMedia(scene({ paper: "papyrus" })).paper, null);
    assert.equal(readMedia(scene(undefined)).chunks.size, 0);
  });

  it("validates data-file formats and applies their encoded size limit", () => {
    const flags = readMedia(
      scene({
        chunks: {
          c0_0: { r: 1, t: 100, n: MAX_BAKE_FILE_BYTES, f: "1234567890abcdef", format: "json" },
          c1_0: { r: 1, t: 100, n: MAX_BAKE_FILE_BYTES + 1, format: "json" },
          c2_0: { r: 1, t: 100, n: MAX_BAKE_FILE_BYTES },
          c3_0: { r: 1, t: 100, n: 100, format: "../../webp" },
        },
      }),
    );
    assert.deepEqual([...flags.chunks.keys()], ["0_0"]);
    assert.equal(flags.chunks.get("0_0")!.format, "json");
  });
});
