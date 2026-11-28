import type { Pt } from "../core/matrix.ts";
import type { Mode } from "../core/types.ts";

/**
 * Per-user, per-scene drawing guides: the symmetry centre and the rulers.
 * Stored in a hidden client setting and validated on every read, like the
 * tool preferences. Coordinates are in the mode's space: map units for map
 * guides, screen units around the viewport centre (anchor [0, 0]) for screen
 * guides.
 */

export type RulerKind = "perspective" | "curve";

interface RulerBase {
  id: string;
  mode: Mode;
  /** Snapping enabled. */
  on: boolean;
}

/** One-, two- or three-point perspective. */
export interface PerspectiveRuler extends RulerBase {
  kind: "perspective";
  /** Vanishing points (1..3). */
  vps: Pt[];
  /** Also offer the parallel directions (horizontal + vertical for 1 VP, vertical for 2 VPs). */
  parallels: boolean;
}

export interface CurveRuler extends RulerBase {
  kind: "curve";
  /** Control points (2..64), passed through by a centripetal Catmull–Rom spline. */
  pts: Pt[];
  closed: boolean;
  /** Keep the stroke's starting offset (parallel / concentric lines) instead of snapping onto the curve. */
  parallel: boolean;
}

export type Ruler = PerspectiveRuler | CurveRuler;

export interface SceneGuides {
  /** Custom symmetry centre per mode (absent = viewport centre). */
  symmetry: Partial<Record<Mode, Pt>>;
  rulers: Ruler[];
}

export const GUIDE_LIMITS = { rulers: 16, curvePoints: 64, scenes: 40, extent: 1e6 } as const;

export const emptyGuides = (): SceneGuides => ({ symmetry: {}, rulers: [] });

const ID = /^[A-Za-z0-9_-]{1,32}$/;

function pt(v: unknown): Pt | null {
  if (!v || typeof v !== "object") return null;
  const { x, y } = v as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const e = GUIDE_LIMITS.extent;
  if (Math.abs(x) > e || Math.abs(y) > e) return null;
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
}

function pts(v: unknown, max: number): Pt[] {
  if (!Array.isArray(v)) return [];
  const out: Pt[] = [];
  for (const p of v.slice(0, max)) {
    const q = pt(p);
    if (q) out.push(q);
  }
  return out;
}

export function normalizeRuler(raw: unknown): Ruler | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID.test(r.id)) return null;
  const mode: Mode = r.mode === "screen" ? "screen" : "map";
  const on = r.on !== false;
  if (r.kind === "perspective") {
    const vps = pts(r.vps, 3);
    if (!vps.length) return null;
    return { id: r.id, kind: "perspective", mode, on, vps, parallels: r.parallels !== false };
  }
  if (r.kind === "curve") {
    const list = pts(r.pts, GUIDE_LIMITS.curvePoints);
    if (list.length < 2) return null;
    return { id: r.id, kind: "curve", mode, on, pts: list, closed: r.closed === true, parallel: r.parallel === true };
  }
  return null;
}

export function normalizeSceneGuides(raw: unknown): SceneGuides {
  const out = emptyGuides();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const sym = r.symmetry && typeof r.symmetry === "object" ? (r.symmetry as Record<string, unknown>) : {};
  for (const mode of ["map", "screen"] as const) {
    const p = pt(sym[mode]);
    if (p) out.symmetry[mode] = p;
  }
  if (Array.isArray(r.rulers)) {
    const seen = new Set<string>();
    for (const item of r.rulers) {
      const ruler = normalizeRuler(item);
      if (!ruler || seen.has(ruler.id)) continue;
      seen.add(ruler.id);
      out.rulers.push(ruler);
      if (out.rulers.length >= GUIDE_LIMITS.rulers) break;
    }
  }
  return out;
}

/** Validate the whole stored record `{ [sceneId]: SceneGuides }` (newest scenes kept). */
export function normalizeGuides(raw: unknown): Record<string, SceneGuides> {
  const out: Record<string, SceneGuides> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const entries = Object.entries(raw as Record<string, unknown>).filter(([id]) => ID.test(id));
  for (const [id, value] of entries.slice(-GUIDE_LIMITS.scenes)) out[id] = normalizeSceneGuides(value);
  return out;
}

/** Is there anything worth storing? */
export const guidesEmpty = (g: SceneGuides): boolean => !g.rulers.length && !g.symmetry.map && !g.symmetry.screen;
