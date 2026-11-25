import { BRUSHES } from "../brush/brushes.ts";
import type { Session } from "../session.ts";
import { sizeKey } from "../state/prefs.ts";
import { h } from "./dom.ts";

/**
 * Brush cursor over the board: a ring the size of the stroke on screen, in
 * the current colour (dashed for the eraser, a dot for the laser, an I-beam
 * for text). The system cursor is hidden only while the ring is shown.
 */
export class BrushCursor {
  readonly element: HTMLElement;
  readonly #session: Session;
  #visible = false;
  #x = 0;
  #y = 0;

  constructor(session: Session) {
    this.#session = session;
    this.element = h("div", { id: "canvas-scribble-cursor", "aria-hidden": "true" });
    this.element.hidden = true;
    document.body.append(this.element);
  }

  update(cx: number, cy: number, over: boolean, pointerType: string): void {
    // Pens and fingers have no hover cursor worth replacing.
    const show = over && pointerType !== "touch";
    this.#x = cx;
    this.#y = cy;
    if (show !== this.#visible) {
      this.#visible = show;
      this.element.hidden = !show;
      document.body.classList.toggle("canvas-scribble-cursor", show);
    }
    if (show) this.refresh();
  }

  /** Re-read size/colour (prefs or zoom changed). */
  refresh(): void {
    if (!this.#visible) return;
    const s = this.#session;
    const { tool, mode } = s.effective();
    const key = sizeKey({ ...s.prefs, tool });
    const space = s.space(mode);
    let d = s.prefs.sizes[key];
    if (space) {
      const scale = key in BRUSHES ? BRUSHES[key as keyof typeof BRUSHES].widthScale : 1;
      d = space.widthFor(d, scale) * space.cssPerUnit();
    }
    if (tool === "text") d = 2;
    d = Math.max(4, Math.min(400, d));
    const el = this.element;
    el.dataset.tool = tool;
    el.dataset.mode = mode;
    el.style.setProperty("--cs-color", s.color());
    el.style.width = el.style.height = `${d}px`;
    el.style.transform = `translate(${this.#x - d / 2}px, ${this.#y - d / 2}px)`;
  }

  hide(): void {
    this.update(this.#x, this.#y, false, "mouse");
  }

  destroy(): void {
    document.body.classList.remove("canvas-scribble-cursor");
    this.element.remove();
  }
}
