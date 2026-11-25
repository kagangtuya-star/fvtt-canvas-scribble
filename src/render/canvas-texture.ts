import { trackTexture } from "./stats.ts";

/**
 * A Canvas 2D surface uploaded to the GPU as a PIXI texture. The canvas is
 * the rasterised cache of structured items; it is never persisted.
 *
 * A DOM canvas is used (not OffscreenCanvas) because every PIXI v7 build
 * shipped with Foundry accepts it as a texture resource.
 */
export class CanvasTexture {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  #texture: PIXI.Texture | null = null;
  #pixels = 0;
  /** Optional sub-rectangle exposed by the texture (cache tiles hide their bleed padding). */
  readonly #frame: { x: number; y: number; w: number; h: number } | null;

  constructor(width: number, height: number, frame?: { x: number; y: number; w: number; h: number }) {
    this.#frame = frame ?? null;
    this.canvas = document.createElement("canvas");
    this.canvas.width = Math.max(1, Math.ceil(width));
    this.canvas.height = Math.max(1, Math.ceil(height));
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("CanvasScribble: 2D canvas context unavailable");
    this.ctx = ctx;
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  /** Resize and clear. A new GPU texture is created on the next {@link texture} call. */
  resize(width: number, height: number): void {
    const w = Math.max(1, Math.ceil(width));
    const h = Math.max(1, Math.ceil(height));
    if (w === this.canvas.width && h === this.canvas.height) {
      this.clear();
      return;
    }
    this.#release();
    this.canvas.width = w;
    this.canvas.height = h;
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** The PIXI texture for the canvas; call {@link upload} after drawing. */
  get texture(): PIXI.Texture {
    if (!this.#texture) {
      const base = new PIXI.BaseTexture(this.canvas);
      const f = this.#frame;
      this.#texture = f ? new PIXI.Texture(base, new PIXI.Rectangle(f.x, f.y, f.w, f.h)) : new PIXI.Texture(base);
      this.#pixels = this.canvas.width * this.canvas.height;
      trackTexture(this.#pixels, 1);
    }
    return this.#texture;
  }

  /** Re-upload the canvas content. */
  upload(): void {
    if (this.#texture) this.#texture.baseTexture.update();
  }

  #release(): void {
    if (!this.#texture) return;
    this.#texture.destroy(true);
    trackTexture(this.#pixels, -1);
    this.#texture = null;
    this.#pixels = 0;
  }

  destroy(): void {
    this.#release();
    // Free the backing store immediately instead of waiting for GC.
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
