import type { ScribbleItem } from "../src/core/types.ts";

export const SCENE = "SceneAaaaaaaaaa1";
export const ALICE = "AliceBbbbbbbbbb2";
export const BOB = "BobCcccccccccccc3";
export const GM = "GmUserAaaaaaaaa1";

let counter = 0;

/** A valid in-memory item; override any field. */
export function makeItem(over: Partial<ScribbleItem> = {}): ScribbleItem {
  counter++;
  return {
    schemaVersion: 1,
    id: `Item${String(counter).padStart(12, "0")}`,
    author: ALICE,
    scene: SCENE,
    mode: "map",
    kind: "stroke",
    tool: "pen",
    color: "#ff0000",
    opacity: 1,
    size: 4,
    points: [0, 0, 0.5, 10, 10, 0.5, 20, 0, 0.5],
    style: {},
    createdAt: 1_000_000,
    expiresAt: 1_060_000,
    fadeDuration: 500,
    layer: "above",
    visibility: "all",
    revision: 0,
    ...over,
  };
}

/** Line of `n` points along x. */
export function line(n: number, step = 1, y = 0, z = 0.5): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i * step, y, z);
  return out;
}
