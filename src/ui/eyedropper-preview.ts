import { sampleColorAt } from "../tools/eyedropper.ts";
import { h } from "./dom.ts";

/** DOM-only preview: it cannot intercept input or appear in the sampled canvas. */
export class EyedropperPreview {
  readonly element: HTMLElement;
  readonly #code: HTMLElement;
  #active = false;
  #destroyed = false;
  #x = 0;
  #y = 0;
  #request: AbortController | null = null;
  #frame: number | null = null;

  constructor() {
    this.#code = h("span", { class: "cs-eyedropper-code" }, "—");
    this.element = h(
      "div",
      { id: "canvas-scribble-eyedropper", "aria-hidden": "true", inert: true },
      h("span", { class: "cs-eyedropper-swatch" }),
      this.#code,
    );
    this.element.hidden = true;
    document.body.append(this.element);
  }

  update(cx: number, cy: number, active: boolean): void {
    if (this.#destroyed) return;
    const moved = cx !== this.#x || cy !== this.#y;
    this.#x = cx;
    this.#y = cy;
    if (!active) {
      this.hide();
      return;
    }
    const started = !this.#active;
    this.#active = true;
    this.element.hidden = false;
    this.#position();
    if (started || moved) {
      // Replace a pending read before the next render, so fast movement samples
      // the latest pointer position instead of trailing behind or queuing reads.
      this.#cancel();
      this.#sample();
    }
  }

  #position(): void {
    const w = this.element.offsetWidth;
    const h = this.element.offsetHeight;
    const x = this.#x + 18 + w <= window.innerWidth - 8 ? this.#x + 18 : this.#x - 18 - w;
    const y = this.#y + 18 + h <= window.innerHeight - 8 ? this.#y + 18 : this.#y - 18 - h;
    const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - h - 8));
    this.element.style.transform = `translate(${left}px, ${top}px)`;
  }

  #sample(): void {
    if (!this.#active || this.#destroyed) return;
    const request = new AbortController();
    this.#request = request;
    void sampleColorAt(this.#x, this.#y, request.signal).then(
      (color) => this.#complete(request, color),
      () => this.#complete(request, null),
    );
  }

  #complete(request: AbortController, color: string | null): void {
    if (this.#request !== request) return;
    this.#request = null;
    this.#code.textContent = color?.toUpperCase() ?? "—";
    if (color) this.element.style.setProperty("--cs-color", color);
    else this.element.style.removeProperty("--cs-color");
    // Keep a stationary cursor current when tokens, lighting or paint change.
    // Only one read may be pending, and each read waits for a rendered frame.
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#sample();
    });
  }

  #cancel(): void {
    const request = this.#request;
    this.#request = null;
    request?.abort();
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
  }

  hide(): void {
    this.#active = false;
    this.#cancel();
    this.element.hidden = true;
    this.#code.textContent = "—";
    this.element.style.removeProperty("--cs-color");
  }

  destroy(): void {
    this.hide();
    this.#destroyed = true;
    this.element.remove();
  }
}
