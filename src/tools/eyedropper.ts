import { sampleCanvasPixel } from "../foundry/compat.ts";

/** Sample the displayed colour, including tokens, fog, lighting and blended marks. */
export async function sampleColorAt(cx: number, cy: number, signal?: AbortSignal): Promise<string | null> {
  const pixel = await sampleCanvasPixel(cx, cy, signal);
  if (!pixel || pixel.length < 4 || pixel[3] === 0) return null;
  const [r, g, b] = pixel;
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
