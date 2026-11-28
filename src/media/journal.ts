import { MODULE_ID } from "../constants.ts";
import { sanitizeStroke, strokeToWire } from "./ops.ts";
import type { MediaStroke } from "./ops.ts";

/** Bounded input recovery log, isolated by world, scene and authenticated local user. */
const MAX_STROKES = 200;
const MAX_POINTS = 40_000;
const MAX_CHARS = 1024 * 1024;

export function journalKey(world: string, scene: string, user: string): string {
  return `${MODULE_ID}.wet-inputs.${world}.${scene}.${user}`;
}

export function readJournal(
  key: string,
  mapExtent: { w: number; h: number },
  clearedAt: number,
  now: number,
): MediaStroke[] {
  try {
    const text = globalThis.localStorage?.getItem(key);
    if (!text || text.length > MAX_CHARS) return [];
    const raw = JSON.parse(text);
    if (raw?.version !== 1 || !Array.isArray(raw.strokes) || raw.strokes.length > MAX_STROKES) return [];
    const strokes: MediaStroke[] = [];
    let points = 0;
    const ids = new Set<string>();
    for (const wire of raw.strokes) {
      // Recovery may happen long after a stroke's network clock-skew window has passed.
      const stroke = sanitizeStroke(wire, { mapExtent, now: wire?.at });
      if (!stroke || stroke.at < clearedAt || stroke.at > now || ids.has(stroke.id)) continue;
      points += stroke.points.length / 3;
      if (points > MAX_POINTS) return [];
      strokes.push(stroke);
      ids.add(stroke.id);
    }
    return strokes;
  } catch {
    return [];
  }
}

/** False means storage is unavailable/full or retaining every pending input would exceed the bound. */
export function writeJournal(key: string, strokes: readonly MediaStroke[]): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    if (!strokes.length) {
      storage.removeItem(key);
      return true;
    }
    if (strokes.length > MAX_STROKES || strokes.reduce((n, s) => n + s.points.length / 3, 0) > MAX_POINTS) return false;
    const text = JSON.stringify({ version: 1, strokes: strokes.map((s) => strokeToWire(s)) });
    if (text.length > MAX_CHARS) return false;
    storage.setItem(key, text);
    return true;
  } catch {
    return false;
  }
}
