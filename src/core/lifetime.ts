import type { ScribbleItem } from "./types.ts";

/**
 * Lifetime model. Every client evaluates the same absolute server-time
 * timestamps, so an item fades at the same moment everywhere, regardless of
 * when its socket message arrived.
 *
 *   createdAt ── visible ── expiresAt ── fading (fadeDuration) ── gone
 */

export type LifeState = "visible" | "fading" | "gone";

type Timed = Pick<ScribbleItem, "expiresAt" | "fadeDuration">;

export function lifeState(item: Timed, now: number): LifeState {
  if (item.expiresAt === null || now < item.expiresAt) return "visible";
  return now < item.expiresAt + item.fadeDuration ? "fading" : "gone";
}

/** Opacity multiplier in [0, 1] (smooth ease-out over the fade). */
export function lifeAlpha(item: Timed, now: number): number {
  if (item.expiresAt === null || now < item.expiresAt) return 1;
  if (item.fadeDuration <= 0) return 0;
  const t = (now - item.expiresAt) / item.fadeDuration;
  if (t >= 1) return 0;
  const u = 1 - t;
  return u * u * (3 - 2 * u);
}

/** Server time at which the item disappears completely (`Infinity` for permanent items). */
export const goneAt = (item: Timed): number =>
  item.expiresAt === null ? Infinity : item.expiresAt + Math.max(0, item.fadeDuration);

export const isGone = (item: Timed, now: number): boolean => now >= goneAt(item);

/** Lifetime presets offered in the UI (ms; 0 = permanent). */
export const LIFETIME_PRESETS: readonly number[] = [2000, 5000, 10_000, 30_000, 60_000, 0];

/** Fade presets (ms). */
export const FADE_PRESETS: readonly number[] = [0, 250, 500, 1000, 2000];

/** Short human label: "2s", "1m", "1m30s", "∞". */
export function formatLifetime(ms: number): string {
  if (ms <= 0) return "∞";
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return rest ? `${m}m${rest}s` : `${m}m`;
}

/** Parse "5", "5s", "1.5s", "2m", "1m30s", "90" (seconds) → ms; `null` if invalid. "∞"/"inf"/"0" → 0. */
export function parseLifetime(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (s === "∞" || s === "inf" || s === "0") return 0;
  const m = /^(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s?)?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  const ms = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 1000;
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}
