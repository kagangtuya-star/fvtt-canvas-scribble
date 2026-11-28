import { LIMITS } from "../constants.ts";
import type { Bounds } from "./geometry.ts";

export const TEXT_FONT = `"Signika", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`;
export const TEXT_LINE_HEIGHT = 1.25;
export const textFont = (size: number): string => `600 ${size}px ${TEXT_FONT}`;

export interface TextSource {
  text?: string;
  size: number;
  /** Absent means natural width, with only explicit newlines. */
  textWidth?: number;
}

export interface TextMeasure {
  width: number;
  actualBoundingBoxLeft?: number;
  actualBoundingBoxRight?: number;
  actualBoundingBoxAscent?: number;
  actualBoundingBoxDescent?: number;
  fontBoundingBoxAscent?: number;
  fontBoundingBoxDescent?: number;
}

export type MeasureText = (text: string, size: number) => TextMeasure;
export interface TextLayout {
  lines: { text: string; baseline: number }[];
  width: number;
  height: number;
  /** Local bounds including the logical box, glyph overhang and halo. */
  bounds: Bounds;
}

let context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
const cache = new Map<string, TextLayout>();
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** DOM-free callers get a conservative fallback; browsers always measure glyphs. */
const measureText: MeasureText = (text, size) => {
  if (!context) {
    if (typeof OffscreenCanvas !== "undefined") context = new OffscreenCanvas(1, 1).getContext("2d");
    else if (typeof document !== "undefined") context = document.createElement("canvas").getContext("2d");
  }
  if (context?.measureText) {
    context.font = textFont(size);
    context.textBaseline = "alphabetic";
    return context.measureText(text);
  }
  return { width: [...segmenter.segment(text)].length * size };
};

export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .slice(0, LIMITS.maxTextLength);
}

export function clearTextLayoutCache(): void {
  cache.clear();
}

/** Shared by the editor, painter, raster allocation and selection hit tests. */
export function layoutText(source: TextSource, measure: MeasureText = measureText): TextLayout {
  const { size } = source;
  const text = source.text ?? "";
  const width = source.textWidth;
  const key = JSON.stringify([text, size, width]);
  if (measure === measureText) {
    const saved = cache.get(key);
    if (saved) return saved;
  }
  const rows: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (width === undefined || !paragraph) {
      rows.push(paragraph);
      continue;
    }
    let row = "";
    for (const { segment } of segmenter.segment(paragraph)) {
      if (row && measure(row + segment, size).width > width) {
        rows.push(row);
        row = "";
      }
      row += segment;
    }
    rows.push(row);
  }
  const lineHeight = size * TEXT_LINE_HEIGHT;
  const font = measure("Mg国", size);
  const ascent = font.fontBoundingBoxAscent ?? size * 0.9;
  const descent = font.fontBoundingBoxDescent ?? size * 0.25;
  const baseline = (lineHeight - ascent - descent) / 2 + ascent;
  let naturalWidth = size * 0.5;
  const height = rows.length * lineHeight;
  const bounds: Bounds = [0, 0, width ?? naturalWidth, height];
  const lines = rows.map((row, i) => {
    const m = measure(row, size);
    const y = i * lineHeight + baseline;
    naturalWidth = Math.max(naturalWidth, m.width);
    bounds[0] = Math.min(bounds[0], -(m.actualBoundingBoxLeft ?? 0));
    bounds[1] = Math.min(bounds[1], y - (m.actualBoundingBoxAscent ?? ascent));
    bounds[2] = Math.max(bounds[2], m.width, m.actualBoundingBoxRight ?? m.width);
    bounds[3] = Math.max(bounds[3], y + (m.actualBoundingBoxDescent ?? descent));
    return { text: row, baseline: y };
  });
  const logicalWidth = width ?? naturalWidth;
  bounds[2] = Math.max(bounds[2], logicalWidth);
  const pad = size * 0.09 + 2;
  const result: TextLayout = {
    lines,
    width: logicalWidth,
    height,
    bounds: [bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad],
  };
  if (measure === measureText) {
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
  }
  return result;
}
