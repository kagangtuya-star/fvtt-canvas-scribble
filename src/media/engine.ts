import { decodeBakeState, encodeBake, MAX_COVERAGE } from "./bake.ts";
import type { BakeStroke } from "./bake.ts";
import { MEDIA_BRUSHES, MEDIA_BRUSH_IDS, PAPER_IDS } from "./brushes.ts";
import type { MediaBrushId, PaperId } from "./brushes.ts";
import { addDabChunk, DabWalker, DAB, DAB_FLOATS, GATHER_FLOATS, MAX_DABS_PER_BATCH, Reservoir } from "./dabs.ts";
import type { Dab } from "./dabs.ts";
import {
  CHUNK,
  GPU_WET_CHUNKS,
  MAX_CATCHUP_STEPS,
  MAX_MEDIA_CHUNKS,
  STEP_MS,
  chunkKey,
  parseChunkKey,
} from "./layout.ts";
import { paperTile } from "./paper.ts";
import type { ChunkSnapshot, SimBackend } from "./sim/backend.ts";
import { WET_SECONDS } from "./sim/physics.ts";

/**
 * The wet-media engine: owns a simulation backend, turns strokes into dabs,
 * runs the physics clock, tracks which chunks are wet, and reports displays,
 * dry chunks, bakes and undo results. It runs inside a worker (see
 * `worker.ts`) or, as a fallback and in tests, on the calling thread.
 */

export type EngineIn =
  | { t: "init"; paper: PaperId; seed: number; drying: number; backend: "auto" | "cpu" | "gpu"; clock: number }
  | { t: "paper"; paper: PaperId; seed: number }
  | { t: "drying"; factor: number }
  | { t: "clock"; offset: number }
  | {
      t: "stroke";
      id: string;
      brush: MediaBrushId;
      color: string;
      size: number;
      pigment: number;
      water: number;
      seed: number;
      at?: number;
    }
  | { t: "points"; id: string; pts: Float32Array }
  | { t: "end"; id: string }
  | { t: "undo"; id: string; req: number }
  | { t: "dryAll" }
  /** Dry everything now and bake every chunk that was wet (scene change, "dry now"). */
  | { t: "flush"; req: number }
  | { t: "clear" }
  | { t: "bake"; key: string; req: number }
  | { t: "retryBake"; key: string }
  | { t: "load"; key: string; data: Uint8Array; at: number; revision?: string }
  | { t: "view"; x0: number; y0: number; x1: number; y1: number }
  | { t: "remove"; key: string }
  | { t: "destroy" };

export type EngineOut =
  | { t: "ready"; backend: "cpu" | "gpu"; note?: string }
  | { t: "display"; key: string; data: Uint8ClampedArray | null }
  | { t: "dry"; key: string; touched: number }
  /** `data` is null when the chunk is still wet or unknown; `empty` when it holds no paint at all. */
  | { t: "baked"; req: number; key: string; data: Uint8Array | null; empty: boolean; at: number }
  | { t: "flushed"; req: number; ok?: boolean }
  | { t: "loaded"; key: string; ok: boolean; revision?: string; invalid?: boolean }
  | { t: "undone"; req: number; ok: boolean; removed?: string[] }
  | { t: "stats"; chunks: number; wet: number; stepMs: number; backend: string; queued: number }
  | { t: "limit" }
  | { t: "error"; message: string };

/** Margin (cells) around a dab within which chunks are allocated so water can flow across borders. */
const FLOW_MARGIN = 16;
/** Strokes that keep undo snapshots. */
const UNDO_DEPTH = 6;
/** Dabs processed per tick at most (the rest wait, so a huge paste cannot stall the worker). */
const MAX_DABS_PER_TICK = 1024;
const MAX_DABS_PER_STROKE = 8192;
const DISPLAY_INTERVAL_MS = { cpu: 140, gpu: 66 } as const;
const CPU_WET_CHUNKS = 16;
const MAX_JOURNAL_DABS = 16_384;
const MAX_JOURNAL_PER_CHUNK = 1024;
const MAX_UNDO_CHUNKS = 40;
const DISPLAY_PIXEL_BUDGET = 4 * 1024 * 1024;
const DISPLAYS_PER_TICK = 4;

type Targets = Map<string, [number, number]>;
type View = Extract<EngineIn, { t: "view" }>;

interface DabJob {
  stroke: Stroke;
  dab: Dab;
  n: number;
}

interface ReplayDab {
  entry: BakeStroke;
  oil: boolean;
  packed: Float32Array | null;
}

interface UndoSnapshot {
  state: ChunkSnapshot | null;
  previous: number;
  wetUntil: number;
  covered?: BakeStroke;
}

interface Stroke {
  id: string;
  seq: number;
  at: number;
  emitted: number;
  walker: DabWalker;
  reservoir: Reservoir;
  oil: boolean;
  ended: boolean;
  /** Chunks touched (keys) and their state before this stroke. */
  chunks: Set<string>;
  snapshots: Map<string, UndoSnapshot> | null;
  conflicted: boolean;
}

interface ChunkMeta {
  cx: number;
  cy: number;
  /** Local time (ms) until which the chunk is simulated. */
  wetUntil: number;
  /** Server time of the last change (bakes older than this are ignored). */
  touched: number;
  /** Sequence of the last stroke that touched it. */
  lastSeq: number;
  /** Display out of date. */
  dirty: boolean;
  shownAt: number;
  needsBake: boolean;
  wet: boolean;
  legacyAt: number;
  coverage: Map<string, BakeStroke>;
  journal: ReplayDab[];
  /** Coverage required to replace this chunk after dropping old replay data. */
  lost: Map<string, BakeStroke>;
  cold: Uint8Array | null;
}

export class MediaEngine {
  readonly #post: (msg: EngineOut, transfer?: Transferable[]) => void;
  readonly #backend: SimBackend;
  readonly #strokes = new Map<string, Stroke>();
  readonly #queue: DabJob[] = [];
  readonly #meta = new Map<string, ChunkMeta>();
  readonly #wet = new Set<string>();
  readonly #records: ReplayDab[] = [];
  #recordEnd = 0;
  #undoChunks = 0;
  #view: View | null = null;
  #displayEdge = CHUNK;
  #displayCursor = 0;
  readonly #dabBuf = new Float32Array(MAX_DABS_PER_BATCH * DAB_FLOATS);
  readonly #gatherBuf = new Float32Array(MAX_DABS_PER_BATCH * GATHER_FLOATS);
  #seq = 0;
  #offset = 0;
  #drying = 1;
  #lastStep = 0;
  #stepMs = 0;
  #statsAt = 0;
  #paper: PaperId = "cold";
  /** Performance clock (injectable for tests). */
  now: () => number = () => performance.now();

  constructor(backend: SimBackend, post: (msg: EngineOut, transfer?: Transferable[]) => void) {
    this.#backend = backend;
    this.#post = post;
  }

  get backend(): SimBackend {
    return this.#backend;
  }

  #serverNow(): number {
    return Date.now() + this.#offset;
  }

  handle(msg: EngineIn): void {
    switch (msg.t) {
      case "init":
        this.#offset = msg.clock;
        this.#drying = msg.drying;
        this.#backend.setDrying(msg.drying);
        this.#setPaper(msg.paper, msg.seed);
        this.#lastStep = this.now();
        return;
      case "paper":
        this.#setPaper(msg.paper, msg.seed);
        return;
      case "drying":
        this.#drying = Math.max(0.05, Math.min(10, msg.factor));
        this.#backend.setDrying(this.#drying);
        return;
      case "clock":
        this.#offset = msg.offset;
        return;
      case "stroke":
        this.#startStroke(msg);
        return;
      case "points": {
        const s = this.#strokes.get(msg.id);
        if (!s || s.ended) return;
        // Keep ordering but don't let an input burst accumulate unbounded work.
        if (s.emitted < MAX_DABS_PER_STROKE) {
          const dabs = s.walker.push(msg.pts);
          const overflow = this.#queue.length + dabs.length - MAX_JOURNAL_DABS;
          if (overflow > 0) this.#flushDabs(overflow);
          for (const dab of dabs) this.#queue.push({ stroke: s, dab, n: ++s.emitted });
        }
        return;
      }
      case "end": {
        const s = this.#strokes.get(msg.id);
        if (!s || s.ended) return;
        for (const dab of s.walker.finish()) this.#queue.push({ stroke: s, dab, n: ++s.emitted });
        s.ended = true;
        return;
      }
      case "undo": {
        const removed = this.#undo(msg.id);
        this.#post({ t: "undone", req: msg.req, ok: !!removed, ...(removed?.length ? { removed } : {}) });
        return;
      }
      case "dryAll":
        this.#flushDabs(Infinity);
        for (const [key, m] of this.#meta) if (m.wet) this.#dry(key, m);
        return;
      case "flush": {
        let ok = false;
        try {
          this.#flushDabs(Infinity);
          for (const [key, m] of this.#meta) if (m.wet) this.#dry(key, m);
          for (const [key, m] of this.#meta) if (m.needsBake) this.#postBake(msg.req, key);
          this.#displays(true);
          ok = true;
        } finally {
          this.#post({ t: "flushed", req: msg.req, ok });
        }
        return;
      }
      case "clear":
        this.#queue.length = 0;
        this.#strokes.clear();
        this.#records.length = 0;
        this.#recordEnd = this.#undoChunks = 0;
        this.#displayCursor = 0;
        for (const key of this.#meta.keys()) this.#post({ t: "display", key, data: null });
        this.#meta.clear();
        this.#wet.clear();
        this.#backend.clear();
        return;
      case "bake":
        this.#postBake(msg.req, msg.key);
        return;
      case "retryBake": {
        const m = this.#meta.get(msg.key);
        if (m) m.needsBake = true;
        return;
      }
      case "load":
        this.#load(msg);
        return;
      case "view": {
        const before = this.#view;
        const previousEdge = this.#displayEdge;
        const chunks = Math.max(0, msg.x1 - msg.x0 + 1) * Math.max(0, msg.y1 - msg.y0 + 1);
        this.#displayEdge = CHUNK;
        while (this.#displayEdge > 16 && chunks * this.#displayEdge ** 2 * 2 > DISPLAY_PIXEL_BUDGET)
          this.#displayEdge /= 2;
        this.#view = msg;
        for (const [key, m] of this.#meta) {
          const was = !before || this.#inView(m, before);
          const visible = this.#inView(m, msg);
          if (visible && (!was || previousEdge !== this.#displayEdge)) m.dirty = true;
          if (was && !visible) this.#post({ t: "display", key, data: null });
        }
        return;
      }
      case "remove": {
        const xy = parseChunkKey(msg.key);
        if (!xy) return;
        this.#backend.remove(xy[0], xy[1]);
        this.#meta.delete(msg.key);
        this.#wet.delete(msg.key);
        this.#post({ t: "display", key: msg.key, data: null });
        return;
      }
      case "destroy":
        this.#backend.destroy();
        return;
    }
  }

  #setPaper(paper: PaperId, seed: number): void {
    this.#paper = PAPER_IDS.includes(paper) ? paper : "cold";
    this.#backend.setPaper(paperTile(this.#paper, seed >>> 0));
  }

  #startStroke(msg: Extract<EngineIn, { t: "stroke" }>): void {
    if (this.#strokes.has(msg.id) || !MEDIA_BRUSH_IDS.includes(msg.brush)) return;
    const brush = MEDIA_BRUSHES[msg.brush];
    const stroke: Stroke = {
      id: msg.id,
      seq: ++this.#seq,
      at: msg.at ?? this.#serverNow(),
      emitted: 0,
      walker: new DabWalker(msg.size, brush, MAX_DABS_PER_STROKE),
      reservoir: new Reservoir({
        brush: msg.brush,
        color: msg.color,
        pigment: msg.pigment,
        water: msg.water,
        seed: msg.seed,
      }),
      oil: brush.oil > 0,
      ended: false,
      chunks: new Set(),
      snapshots: new Map(),
      conflicted: false,
    };
    this.#strokes.set(msg.id, stroke);
    // Older strokes lose their undo snapshots; finished old strokes are forgotten.
    const list = [...this.#strokes.values()].sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < list.length - UNDO_DEPTH; i++) {
      const old = list[i]!;
      this.#dropSnapshots(old);
      if (old.ended && !this.#queue.some((q) => q.stroke === old)) this.#strokes.delete(old.id);
    }
  }

  /* -------------------------------------------- */
  /*  Clock                                       */
  /* -------------------------------------------- */

  /** Run due work: dabs, physics steps, drying, displays. */
  tick(): void {
    const t0 = this.now();
    this.#flushDabs(MAX_DABS_PER_TICK);
    let steps = Math.floor((t0 - this.#lastStep) / STEP_MS);
    if (steps > 0) {
      this.#lastStep += steps * STEP_MS;
      // Long pauses (hidden tab) are not replayed: time just passes, the wet timers still expire.
      if (steps > MAX_CATCHUP_STEPS) {
        steps = MAX_CATCHUP_STEPS;
        this.#lastStep = t0;
      }
      const wet: [number, number][] = [];
      for (const key of this.#wet) {
        const m = this.#meta.get(key)!;
        wet.push([m.cx, m.cy]);
      }
      if (wet.length) {
        for (let i = 0; i < steps; i++) this.#backend.step(wet);
        for (const m of this.#meta.values()) if (m.wet) m.dirty = true;
      }
      const now = this.now();
      // A quiet chunk stays awake while a neighbour is still active: water may yet cross the border.
      const quiet = new Map<string, boolean>();
      const isQuiet = (cx: number, cy: number) => {
        const k = chunkKey(cx, cy);
        let q = quiet.get(k);
        if (q === undefined) {
          q = !this.#meta.get(k)?.wet || this.#backend.quiet(cx, cy);
          quiet.set(k, q);
        }
        return q;
      };
      const dry: [string, ChunkMeta][] = [];
      for (const [key, m] of this.#meta) {
        if (!m.wet) continue;
        const { cx, cy } = m;
        const settled =
          isQuiet(cx, cy) && isQuiet(cx - 1, cy) && isQuiet(cx + 1, cy) && isQuiet(cx, cy - 1) && isQuiet(cx, cy + 1);
        if (now >= m.wetUntil || settled) dry.push([key, m]);
      }
      for (const [key, m] of dry) this.#dry(key, m);
    }
    this.#displays();
    const ms = this.now() - t0;
    this.#stepMs = this.#stepMs * 0.9 + ms * 0.1;
    if (t0 - this.#statsAt > 1000) {
      this.#statsAt = t0;
      this.#post({
        t: "stats",
        chunks: this.#meta.size,
        wet: this.#wet.size,
        stepMs: Math.round(this.#stepMs * 10) / 10,
        backend: this.#backend.kind,
        queued: this.#queue.length,
      });
    }
  }

  /** Whether any work is pending (the worker can idle otherwise). */
  get busy(): boolean {
    if (this.#queue.length) return true;
    for (const m of this.#meta.values()) if (m.wet || m.dirty) return true;
    return false;
  }

  #metaFor(cx: number, cy: number): ChunkMeta {
    const key = chunkKey(cx, cy);
    let m = this.#meta.get(key);
    if (!m) {
      m = {
        cx,
        cy,
        wetUntil: 0,
        touched: 0,
        lastSeq: 0,
        dirty: false,
        shownAt: 0,
        needsBake: false,
        wet: false,
        legacyAt: 0,
        coverage: new Map(),
        journal: [],
        lost: new Map(),
        cold: null,
      };
      this.#meta.set(key, m);
    }
    return m;
  }

  #covered(coverage: Map<string, BakeStroke>, legacyAt: number, [id, n, at]: BakeStroke): boolean {
    return (coverage.get(id)?.[1] ?? 0) >= n || at < legacyAt;
  }

  #targets(job: DabJob): Targets {
    const { stroke, dab, n } = job;
    const targets: Targets = new Map();
    // Center and mask calculations must agree with the packed Float32 coordinates.
    const x = Math.fround(dab.x);
    const y = Math.fround(dab.y);
    const r = Math.min(dab.r + FLOW_MARGIN, CHUNK * 2 - 1);
    const entry: BakeStroke = [stroke.id, n, stroke.at];
    for (let cy = Math.floor((y - r) / CHUNK); cy <= Math.floor((y + r) / CHUNK); cy++) {
      for (let cx = Math.floor((x - r) / CHUNK); cx <= Math.floor((x + r) / CHUNK); cx++) {
        const key = chunkKey(cx, cy);
        const m = this.#meta.get(key);
        if (!m || !this.#covered(m.coverage, m.legacyAt, entry)) targets.set(key, [cx, cy]);
      }
    }
    return targets;
  }

  get #capacity(): number {
    return this.#backend.kind === "gpu" ? GPU_WET_CHUNKS : CPU_WET_CHUNKS;
  }

  #makeRoom(targets: Targets): void {
    let total = this.#wet.size;
    for (const key of targets.keys()) if (!this.#wet.has(key)) total++;
    for (const key of this.#wet) {
      if (total <= this.#capacity) break;
      if (targets.has(key)) continue;
      const m = this.#meta.get(key)!;
      this.#dry(key, m);
      this.#compact(m);
      total--;
    }
  }

  #materialize(m: ChunkMeta): void {
    if (!m.cold || this.#backend.has(m.cx, m.cy)) return;
    const state = decodeBakeState(m.cold);
    if (state) this.#backend.importDeposit(m.cx, m.cy, state.halves);
  }

  #activate(key: string, m: ChunkMeta, oil: boolean): void {
    if (!m.wet) this.#materialize(m);
    m.cold = null;
    this.#backend.ensure(m.cx, m.cy);
    this.#wet.delete(key);
    this.#wet.add(key);
    m.wet = true;
    const wetFor = ((oil ? WET_SECONDS.oil : WET_SECONDS.water) * 1000) / this.#drying;
    m.wetUntil = Math.max(m.wetUntil, this.now() + wetFor);
    m.touched = this.#serverNow();
    m.dirty = true;
    m.needsBake = true;
  }

  #dropSnapshots(stroke: Stroke): void {
    if (!stroke.snapshots) return;
    for (const snap of stroke.snapshots.values()) if (snap.state) this.#undoChunks--;
    stroke.snapshots = null;
  }

  #snapshot(stroke: Stroke, key: string, m: ChunkMeta): void {
    if (stroke.chunks.has(key)) {
      if (m.lastSeq !== stroke.seq) stroke.conflicted = true;
      return;
    }
    stroke.chunks.add(key);
    if (!stroke.snapshots) return;
    this.#materialize(m);
    const be = this.#backend;
    const state = be.has(m.cx, m.cy) ? be.snapshot(m.cx, m.cy) : null;
    stroke.snapshots.set(key, {
      state,
      previous: m.lastSeq,
      wetUntil: m.wet ? m.wetUntil : 0,
      covered: m.coverage.get(stroke.id),
    });
    if (state) this.#undoChunks++;
    for (const previous of this.#strokes.values()) {
      if (this.#undoChunks <= MAX_UNDO_CHUNKS) break;
      this.#dropSnapshots(previous);
    }
  }

  #record(record: ReplayDab): void {
    if (this.#records.length === MAX_JOURNAL_DABS) this.#records[this.#recordEnd]!.packed = null;
    this.#records[this.#recordEnd] = record;
    this.#recordEnd = (this.#recordEnd + 1) % MAX_JOURNAL_DABS;
  }

  #flushDabs(limit: number): void {
    const queue = this.#queue;
    const end = Math.min(limit, queue.length);
    const be = this.#backend;
    const buf = this.#dabBuf;
    const g = this.#gatherBuf;
    let i = 0;
    let refused = false;
    while (i < end) {
      const stroke = queue[i]!.stroke;
      const union: Targets = new Map();
      const batch: { job: DabJob; targets: Targets }[] = [];
      // Snapshots are taken after the preceding stroke's deposits. Reserve the entire batch before gathering.
      while (i < end && batch.length < MAX_DABS_PER_BATCH && queue[i]!.stroke === stroke) {
        const job = queue[i]!;
        const targets = this.#targets(job);
        let needed = union.size;
        for (const key of targets.keys()) if (!union.has(key)) needed++;
        if (batch.length && needed > this.#capacity) break;
        for (const [key, xy] of targets) union.set(key, xy);
        batch.push({ job, targets });
        i++;
      }
      const remaining = MAX_MEDIA_CHUNKS - this.#meta.size;
      if (remaining < union.size) {
        let admitted = 0;
        for (const key of union.keys()) {
          if (this.#meta.has(key) || admitted++ < remaining) continue;
          union.delete(key);
          for (const d of batch) d.targets.delete(key);
          refused = true;
        }
      }
      this.#makeRoom(union);
      for (const [key, [cx, cy]] of union) {
        const m = this.#metaFor(cx, cy);
        this.#snapshot(stroke, key, m);
        this.#activate(key, m, stroke.oil);
        m.lastSeq = stroke.seq;
      }
      batch.forEach(({ job }, k) => stroke.reservoir.pack(job.dab, buf, k * DAB_FLOATS));
      be.gather(buf, batch.length, g);
      let count = 0;
      batch.forEach(({ job, targets }, k) => {
        const o = count * DAB_FLOATS;
        stroke.reservoir.pack(job.dab, buf, o);
        stroke.reservoir.exchange(g, k * GATHER_FLOATS);
        if (!targets.size) return;
        for (const [cx, cy] of targets.values()) addDabChunk(buf, o, cx, cy);
        const entry: BakeStroke = [stroke.id, job.n, stroke.at];
        const record = { entry, oil: stroke.oil, packed: buf.slice(o, o + DAB_FLOATS) };
        this.#record(record);
        for (const key of targets.keys()) {
          const m = this.#meta.get(key)!;
          m.coverage.set(stroke.id, entry);
          if (m.coverage.size > MAX_COVERAGE) m.coverage.delete(m.coverage.keys().next().value!);
          m.journal.push(record);
          if (m.journal.length > MAX_JOURNAL_PER_CHUNK) {
            const old = m.journal.shift()!.entry;
            m.lost.set(old[0], old);
            if (m.lost.size > MAX_COVERAGE) m.lost.delete(m.lost.keys().next().value!);
          }
        }
        count++;
      });
      if (count) be.applyDabs(buf, count);
    }
    queue.splice(0, i);
    if (refused) this.#post({ t: "limit" });
  }

  #dry(key: string, m: ChunkMeta): void {
    this.#backend.settle(m.cx, m.cy);
    m.wet = false;
    m.wetUntil = 0;
    this.#wet.delete(key);
    m.dirty = true;
    this.#post({ t: "dry", key, touched: m.touched });
  }

  #displays(force = false): void {
    const now = this.now();
    const interval = DISPLAY_INTERVAL_MS[this.#backend.kind];
    const chunks = [...this.#meta];
    const cursor = this.#displayCursor % (chunks.length || 1);
    let submitted = 0;
    for (let i = 0; i < chunks.length; i++) {
      const index = (cursor + i) % chunks.length;
      const [key, m] = chunks[index]!;
      if (!m.dirty || (!force && m.wet && now - m.shownAt < interval)) continue;
      const visible = !this.#view || this.#inView(m, this.#view);
      if (visible && submitted >= DISPLAYS_PER_TICK) {
        // Compact settled chunks even when their display update has to wait.
        this.#compact(m);
        continue;
      }
      m.dirty = false;
      m.shownAt = now;
      if (visible) {
        this.#materialize(m);
        const pixels = this.#backend.display(m.cx, m.cy);
        const data = pixels && this.#scaleDisplay(pixels);
        this.#post({ t: "display", key, data }, data ? [data.buffer] : []);
        submitted++;
        this.#displayCursor = index + 1;
      }
      this.#compact(m);
    }
  }

  #compact(m: ChunkMeta): void {
    if (m.wet || !this.#backend.has(m.cx, m.cy)) return;
    m.cold ??= this.#encode(m);
    this.#backend.remove(m.cx, m.cy);
  }

  #scaleDisplay(data: Uint8ClampedArray): Uint8ClampedArray {
    const edge = this.#displayEdge;
    if (edge === CHUNK) return data;
    const step = CHUNK / edge;
    const area = step * step;
    const out = new Uint8ClampedArray(edge * edge * 8);
    for (let y = 0; y < edge * 2; y++) {
      for (let x = 0; x < edge; x++) {
        const i = (y * edge + x) * 4;
        const origin = (y * CHUNK + x) * step * 4;
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let dy = 0; dy < step; dy++)
            for (let dx = 0; dx < step; dx++) sum += data[origin + (dy * CHUNK + dx) * 4 + c]!;
          out[i + c] = sum / area;
        }
      }
    }
    return out;
  }

  #inView(m: ChunkMeta, view: View): boolean {
    return m.cx >= view.x0 && m.cx <= view.x1 && m.cy >= view.y0 && m.cy <= view.y1;
  }

  /* -------------------------------------------- */
  /*  Undo, bake, load                            */
  /* -------------------------------------------- */

  #undo(id: string): string[] | null {
    const s = this.#strokes.get(id);
    if (!s?.snapshots || s.conflicted) return null;
    for (const key of s.chunks) {
      const m = this.#meta.get(key);
      if (!m || m.lastSeq !== s.seq) return null;
    }
    // Pending dabs of the stroke are dropped with it.
    for (let i = this.#queue.length - 1; i >= 0; i--) if (this.#queue[i]!.stroke === s) this.#queue.splice(i, 1);
    const removed: string[] = [];
    for (const key of s.chunks) {
      const xy = parseChunkKey(key)!;
      const m = this.#meta.get(key)!;
      const snap = s.snapshots.get(key)!;
      if (!snap.state) {
        this.#backend.remove(xy[0], xy[1]);
        this.#meta.delete(key);
        this.#wet.delete(key);
        this.#post({ t: "display", key, data: null });
        removed.push(key);
        continue;
      }
      const targets: Targets = new Map([[key, xy]]);
      this.#makeRoom(targets);
      m.cold = null;
      this.#backend.restore(xy[0], xy[1], snap.state);
      m.wet = true;
      this.#wet.add(key);
      m.wetUntil = snap.wetUntil;
      m.lastSeq = snap.previous;
      m.touched = this.#serverNow();
      m.needsBake = true;
      if (snap.covered) m.coverage.set(id, snap.covered);
      else m.coverage.delete(id);
      m.lost.delete(id);
      m.journal = m.journal.filter((r) => r.entry[0] !== id);
      m.dirty = true;
      if (!snap.wetUntil) this.#dry(key, m);
    }
    s.ended = true;
    this.#dropSnapshots(s);
    this.#strokes.delete(id);
    return removed;
  }

  #encode(m: ChunkMeta): Uint8Array | null {
    const halves = this.#backend.exportDeposit(m.cx, m.cy);
    if (!halves.some((value) => (value & 0x7fff) !== 0)) return null;
    return encodeBake(halves, { legacyAt: m.legacyAt, strokes: [...m.coverage.values()] });
  }

  #postBake(req: number, key: string): void {
    const xy = parseChunkKey(key);
    const m = this.#meta.get(key);
    const at = m?.touched ?? 0;
    if (!xy || !m || m.wet) {
      this.#post({ t: "baked", req, key, data: null, empty: false, at });
      return;
    }
    m.cold ??= this.#encode(m);
    m.needsBake = false;
    const data = m.cold?.slice() ?? null;
    this.#post({ t: "baked", req, key, data, empty: !data, at }, data ? [data.buffer as ArrayBuffer] : []);
  }

  #load({ key, data, at, revision }: Extract<EngineIn, { t: "load" }>): void {
    const reply = (ok: boolean, invalid = false) =>
      this.#post({ t: "loaded", key, ok, ...(revision ? { revision } : {}), ...(invalid ? { invalid: true } : {}) });
    const xy = parseChunkKey(key);
    const state = decodeBakeState(data);
    if (!xy || !state) {
      this.#post({ t: "error", message: `invalid bake ${key}` });
      reply(false, true);
      return;
    }
    const m = this.#meta.get(key);
    const coverage = new Map((state.coverage?.strokes ?? []).map((entry) => [entry[0], entry]));
    const legacyAt = state.coverage?.legacyAt ?? at;
    const included = (entry: BakeStroke) => this.#covered(coverage, legacyAt, entry);
    const replay = m?.journal.filter((r) => !included(r.entry)) ?? [];
    // An older checkpoint must never replace local strokes we can no longer replay.
    if (replay.some((r) => !r.packed) || (m && [...m.lost.values()].some((entry) => !included(entry)))) {
      reply(false);
      return;
    }
    const meta = this.#metaFor(xy[0], xy[1]);
    if (
      meta.lastSeq &&
      (replay.length ||
        legacyAt > meta.legacyAt ||
        [...coverage.values()].some((entry) => !this.#covered(meta.coverage, meta.legacyAt, entry)))
    )
      meta.lastSeq = 0;
    this.#backend.remove(xy[0], xy[1]);
    this.#wet.delete(key);
    meta.wet = false;
    meta.wetUntil = 0;
    meta.touched = at;
    meta.dirty = true;
    meta.needsBake = false;
    meta.cold = data;
    meta.legacyAt = legacyAt;
    meta.coverage = coverage;
    meta.journal = replay;
    meta.lost.clear();
    if (replay.length) {
      this.#makeRoom(new Map([[key, xy]]));
      this.#backend.importDeposit(xy[0], xy[1], state.halves);
      this.#activate(
        key,
        meta,
        replay.some((r) => r.oil),
      );
      for (let i = 0; i < replay.length; i += MAX_DABS_PER_BATCH) {
        const count = Math.min(MAX_DABS_PER_BATCH, replay.length - i);
        for (let j = 0; j < count; j++) {
          const record = replay[i + j]!;
          const o = j * DAB_FLOATS;
          this.#dabBuf.set(record.packed!, o);
          this.#dabBuf[o + DAB.chunksLo] = this.#dabBuf[o + DAB.chunksHi] = 0;
          addDabChunk(this.#dabBuf, o, xy[0], xy[1]);
          meta.coverage.set(record.entry[0], record.entry);
        }
        this.#backend.applyDabs(this.#dabBuf, count);
      }
    } else if (!this.#view) this.#backend.importDeposit(xy[0], xy[1], state.halves);
    reply(true);
  }
}
