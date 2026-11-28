import { DYN_COMBINES, DYN_DIRECTIONS, DYN_RANDOMS, DYN_SENSORS, DYN_TARGETS } from "../core/types.ts";
import type {
  DynCombine,
  DynSensor,
  DynSource,
  DynTarget,
  DynTargetSpec,
  DynamicsSpec,
  ScribbleItem,
} from "../core/types.ts";
import type { BrushDefinition } from "./brushes.ts";
import { compileCurve, parseCurve } from "./curve.ts";
import type { CurveFn } from "./curve.ts";
import { seededNoise2D } from "./texture.ts";

/**
 * Brush dynamics: sensors (pressure, tilt, drawing speed, direction, random)
 * mapped through response curves onto brush parameters.
 *
 * The stroke stores raw, normalised sensor data (pressure in the points, tilt
 * and speed in parallel channels); the mapping travels with the item in
 * `style.brush.dyn` and is evaluated by the painter per dab / footprint /
 * outline point. Direction comes from the stroke geometry and random from
 * the item id, so every client draws the same mark and transforms (rotate,
 * mirror) stay consistent.
 *
 * Per target:  f = combine(curve_i(sensor_i)) ∈ [0, 1]
 *   scale targets:  value = base × lerp(lo, hi, f)
 *   angle:          value = base + lerp(lo, hi, f)   (degrees)
 *
 * Items without `dyn` keep the brush's built-in response (the painters'
 * original code path), so existing marks never change.
 */

export interface TargetInfo {
  readonly kind: "scale" | "offset";
  /** Range of `lo` / `hi`. */
  readonly min: number;
  readonly max: number;
  /** Defaults for a newly enabled target. */
  readonly lo: number;
  readonly hi: number;
}

export const TARGET_INFO: Readonly<Record<DynTarget, TargetInfo>> = {
  size: { kind: "scale", min: 0, max: 2, lo: 0.25, hi: 1 },
  flw: { kind: "scale", min: 0, max: 2, lo: 0.2, hi: 1 },
  hrd: { kind: "scale", min: 0, max: 2, lo: 0.3, hi: 1 },
  ang: { kind: "offset", min: -180, max: 180, lo: -30, hi: 30 },
  asp: { kind: "scale", min: 0.05, max: 2, lo: 0.3, hi: 1 },
  sct: { kind: "scale", min: 0, max: 2, lo: 0, hi: 1 },
  spc: { kind: "scale", min: 0.25, max: 4, lo: 0.5, hi: 2 },
};

/** Sensors per target. */
export const MAX_DYN_SOURCES = 4;

const round2 = (v: number) => Math.round(v * 100) / 100 + 0;

const optNum = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function sanitizeSource(raw: unknown): DynSource | null {
  if (!isObj(raw)) return null;
  if (typeof raw.s !== "string" || !(DYN_SENSORS as readonly string[]).includes(raw.s)) return null;
  const s = raw.s as DynSensor;
  const out: DynSource = { s, c: parseCurve(raw.c) ?? "lin" };
  if (s === "d") {
    out.dm =
      typeof raw.dm === "string" && (DYN_DIRECTIONS as readonly string[]).includes(raw.dm)
        ? (raw.dm as DynSource["dm"])
        : "abs";
  }
  if (s === "r") {
    out.rm =
      typeof raw.rm === "string" && (DYN_RANDOMS as readonly string[]).includes(raw.rm)
        ? (raw.rm as DynSource["rm"])
        : "dab";
    if (out.rm === "smooth") out.f = round2(optNum(raw.f, 0.05, 4) ?? 0.5);
  }
  return out;
}

/**
 * Validate untrusted dynamics (socket payloads, flags, preferences, imported
 * presets). Unknown fields are dropped, values clamped; the result is in
 * canonical key order. `undefined` when `raw` is not an object.
 */
export function sanitizeDynamics(raw: unknown): DynamicsSpec | undefined {
  if (!isObj(raw)) return undefined;
  const out: DynamicsSpec = {};
  for (const target of DYN_TARGETS) {
    const r = raw[target];
    if (!isObj(r) || !Array.isArray(r.src)) continue;
    const info = TARGET_INFO[target];
    const src: DynSource[] = [];
    for (const s of r.src.slice(0, MAX_DYN_SOURCES)) {
      const clean = sanitizeSource(s);
      if (clean) src.push(clean);
    }
    if (!src.length) continue;
    const spec: DynTargetSpec = {
      lo: round2(optNum(r.lo, info.min, info.max) ?? info.lo),
      hi: round2(optNum(r.hi, info.min, info.max) ?? info.hi),
      src,
    };
    if (typeof r.m === "string" && r.m !== "mul" && (DYN_COMBINES as readonly string[]).includes(r.m))
      spec.m = r.m as DynCombine;
    // Keep `m` before `src` so equal specs serialise identically.
    out[target] = { lo: spec.lo, hi: spec.hi, ...(spec.m ? { m: spec.m } : {}), src: spec.src };
  }
  return out;
}

/** Stable serialisation for comparisons. */
export const canonicalDynamics = (spec: DynamicsSpec | undefined): string =>
  JSON.stringify(sanitizeDynamics(spec) ?? null);

/** Parameters a brush's renderer can modulate. */
export function dynamicsTargets(brush: BrushDefinition): readonly DynTarget[] {
  if (brush.pixelAligned || brush.renderer === "mono") return [];
  if (brush.renderer === "dab") return DYN_TARGETS;
  if (brush.renderer === "chisel") return ["size", "asp", "ang"];
  return ["size"];
}

/**
 * The brush's built-in response expressed as dynamics: the starting point
 * when a user first edits dynamics. Marks without `dyn` are still painted by
 * the original formulas.
 */
export function defaultDynamics(brush: BrushDefinition): DynamicsSpec {
  if (!brush.pressure || !dynamicsTargets(brush).length) return {};
  const c = parseCurve(`pow:${brush.pressureCurve}`) ?? "lin";
  const th = brush.thinning;
  const size: DynTargetSpec = {
    lo: round2(Math.max(0.18, 1 - th)),
    hi: round2(Math.min(1.35, 1 + th)),
    src: [{ s: "p", c }],
  };
  if (brush.tilt) {
    size.m = "add";
    size.src.push({ s: "t", c: "p:0,0;255,179" });
  }
  const out: DynamicsSpec = { size: { lo: size.lo, hi: size.hi, ...(size.m ? { m: size.m } : {}), src: size.src } };
  if (brush.renderer === "dab") out.flw = { lo: 0.4, hi: 1.1, src: [{ s: "p", c }] };
  return out;
}

/** Custom dynamics of a stroke item (only for brushes that support them). */
export function itemDynamics(item: ScribbleItem, brush: BrushDefinition): DynamicsSpec | undefined {
  const dyn = item.style.brush?.dyn;
  return dyn && dynamicsTargets(brush).length ? dyn : undefined;
}

/** Sensors referenced by the mapped targets. */
export function dynamicsSensors(spec: DynamicsSpec | undefined): Set<DynSensor> {
  const out = new Set<DynSensor>();
  if (!spec) return out;
  for (const target of DYN_TARGETS) for (const s of spec[target]?.src ?? []) out.add(s.s);
  return out;
}

/** Largest multiplier a scale target can reach (1 when unmapped); used for culling bounds. */
export function dynamicsMaxScale(spec: DynamicsSpec | undefined, target: DynTarget): number {
  const t = spec?.[target];
  if (!t?.src.length) return 1;
  return Math.max(t.lo, t.hi);
}

/* -------------------------------------------- */
/*  Evaluation                                  */
/* -------------------------------------------- */

/** Sensor inputs at one dab / footprint / outline point. */
export interface DynFrame {
  /** Pressure 0..1. */
  p: number;
  /** Tilt 0..1. */
  t: number;
  /** Speed 0..1. */
  v: number;
  /** Stroke heading (radians). */
  tan: number;
  /** Heading of the first sample (radians), for `rel` direction. */
  tan0: number;
  /** Nib angle before dynamics (radians), for `axial` direction. */
  nib: number;
  /** Distance along the stroke (space units). */
  run: number;
  /** Dab / sample index. */
  i: number;
}

export type DynFn = (f: DynFrame) => number;
export type CompiledDynamics = Partial<Record<DynTarget, DynFn>>;

const TAU = Math.PI * 2;

/** Counter-based hash → [0, 1): independent of evaluation order. */
function hash01(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i | 0, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 8) / 16777216;
}

/** Raw (pre-curve) sensor reading 0..1. */
function sensorReader(src: DynSource, seed: number, width: number, noise: () => (x: number, y: number) => number) {
  switch (src.s) {
    case "p":
      return (f: DynFrame) => f.p;
    case "t":
      return (f: DynFrame) => f.t;
    case "v":
      return (f: DynFrame) => f.v;
    case "d": {
      if (src.dm === "axial") return (f: DynFrame) => Math.abs(Math.sin(f.tan - f.nib));
      const rel = src.dm === "rel";
      return (f: DynFrame) => {
        const a = (rel ? f.tan - f.tan0 : f.tan) % TAU;
        return (a < 0 ? a + TAU : a) / TAU;
      };
    }
    case "r": {
      if (src.rm === "stroke") {
        const v = hash01(seed, 0x7fffffff);
        return () => v;
      }
      if (src.rm === "smooth") {
        const n = noise();
        const k = (src.f ?? 0.5) / Math.max(1e-3, width);
        const row = (seed & 0xffff) * 0.0137;
        return (f: DynFrame) => Math.min(1, Math.max(0, n(f.run * k, row) * 0.5 + 0.5));
      }
      return (f: DynFrame) => hash01(seed, f.i);
    }
  }
}

/**
 * Compile dynamics for one item. `seed` should come from the item id;
 * `width` is the stroke width (space units, smooth-random frequency).
 */
export function compileDynamics(
  spec: DynamicsSpec,
  seed: number,
  width: number,
  targets: readonly DynTarget[] = DYN_TARGETS,
): CompiledDynamics {
  const out: CompiledDynamics = {};
  let noiseFn: ((x: number, y: number) => number) | null = null;
  const noise = () => (noiseFn ??= seededNoise2D(seed ^ 0x5d1c0de5));
  DYN_TARGETS.forEach((target, ti) => {
    const t = spec[target];
    if (!t?.src.length || !targets.includes(target)) return;
    const parts: { read: DynFn; curve: CurveFn }[] = t.src.slice(0, MAX_DYN_SOURCES).map((src, si) => ({
      read: sensorReader(src, (seed ^ Math.imul(ti * 8 + si + 1, 0x2545f491)) >>> 0, width, noise),
      curve: compileCurve(src.c),
    }));
    const m = t.m ?? "mul";
    const { lo, hi } = t;
    out[target] = (f) => {
      let acc = m === "mul" ? 1 : m === "min" ? 1 : 0;
      for (const part of parts) {
        const v = part.curve(part.read(f));
        if (m === "mul") acc *= v;
        else if (m === "min") acc = Math.min(acc, v);
        else if (m === "max") acc = Math.max(acc, v);
        else acc += v;
      }
      const g = acc < 0 ? 0 : acc > 1 ? 1 : acc;
      return lo + (hi - lo) * g;
    };
  });
  return out;
}
