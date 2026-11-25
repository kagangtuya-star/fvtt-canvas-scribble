/** Counters for the debug overlay. Cheap enough to keep updated in production. */
export const stats = {
  itemSprites: 0,
  tiles: 0,
  textures: 0,
  texturePixels: 0,
  tileBuilds: 0,
  itemRasters: 0,
  lastFrameMs: 0,
  rasterMsWindow: 0,
  socketIn: 0,
  socketOut: 0,
  socketInBytes: 0,
  socketOutBytes: 0,
  dropped: 0,
};

export type Stats = typeof stats;

export function trackTexture(pixels: number, delta: 1 | -1): void {
  stats.textures += delta;
  stats.texturePixels += pixels * delta;
}
