import type { ScribbleItem } from "../core/types.ts";
import { hexToNumber } from "../core/util.ts";

/**
 * Laser pointer trails. A laser item's `z` values are milliseconds since
 * `createdAt`, so every client fades the same segment at the same server
 * time. Trails are redrawn every frame into one Graphics per root; they are
 * never rasterised or cached.
 */

/** Mix a colour towards white (0 = colour, 1 = white). */
function lighten(color: number, k: number): number {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  const mix = (c: number) => Math.round(c + (255 - c) * k);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

/** Opacity of a trail point by age (1 = fresh, 0 = gone). */
export function trailAlpha(age: number, trail: number): number {
  if (age <= 0) return 1;
  if (age >= trail) return 0;
  const t = 1 - age / trail;
  return t * Math.sqrt(t);
}

/** Server time at which the last point of a laser trail has faded. */
export function laserGoneAt(item: ScribbleItem): number {
  const n = item.points.length;
  const last = n >= 3 ? item.points[n - 1]! : 0;
  return item.createdAt + last + item.fadeDuration;
}

/**
 * Draw the trails of `items` (in the Graphics' own unit space).
 * `live` ids keep their tip dot even when the pointer rests.
 */
export function drawLasers(
  g: PIXI.Graphics,
  items: Iterable<ScribbleItem>,
  now: number,
  live: ReadonlySet<string>,
): number {
  g.clear();
  let drawn = 0;
  for (const item of items) {
    const p = item.points;
    const n = p.length / 3;
    if (!n) continue;
    const trail = Math.max(100, item.fadeDuration);
    const color = hexToNumber(item.color);
    const core = lighten(color, 0.65);
    const w = item.size;
    // Find the first point still inside the trail window.
    let start = n - 1;
    while (start > 0 && now - (item.createdAt + p[(start - 1) * 3 + 2]!) < trail) start--;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = Math.max(1, start); i < n; i++) {
        const a = trailAlpha(now - (item.createdAt + p[i * 3 + 2]!), trail) * item.opacity;
        if (a <= 0.01) continue;
        const width = w * (0.35 + 0.65 * a);
        if (pass === 0)
          g.lineStyle({
            width: width * 2.8,
            color,
            alpha: a * 0.28,
            cap: PIXI.LINE_CAP.ROUND,
            join: PIXI.LINE_JOIN.ROUND,
          });
        else g.lineStyle({ width, color: core, alpha: a, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
        g.moveTo(p[(i - 1) * 3]!, p[(i - 1) * 3 + 1]!);
        g.lineTo(p[i * 3]!, p[i * 3 + 1]!);
        drawn++;
      }
    }
    // Tip: a glowing dot while the pointer is down (or just released).
    const tipAge = now - (item.createdAt + p[(n - 1) * 3 + 2]!);
    const tipAlpha = live.has(item.id) ? 1 : trailAlpha(tipAge, trail);
    if (tipAlpha > 0.01) {
      const x = p[(n - 1) * 3]!;
      const y = p[(n - 1) * 3 + 1]!;
      g.lineStyle({ width: 0, color: 0 });
      g.beginFill(color, 0.22 * tipAlpha * item.opacity);
      g.drawCircle(x, y, w * 2.4);
      g.endFill();
      g.beginFill(color, 0.9 * tipAlpha * item.opacity);
      g.drawCircle(x, y, w * 0.95);
      g.endFill();
      g.beginFill(core, tipAlpha * item.opacity);
      g.drawCircle(x, y, w * 0.5);
      g.endFill();
      drawn++;
    }
  }
  return drawn;
}
