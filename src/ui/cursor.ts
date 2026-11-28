import { BRUSHES, resolveBrushParams } from "../brush/brushes.ts";
import type { Session } from "../session.ts";
import { activeBrushId, sizeKey } from "../state/prefs.ts";
import { h } from "./dom.ts";
import { EyedropperPreview } from "./eyedropper-preview.ts";

/**
 * Brush cursor over the board: displays the true nib geometry on screen
 * (circle for round brushes, rotated rectangle/rounded-rect for flat,
 * calligraphy, bristle, pixel, chisel and rectangular eraser nibs; dot for
 * laser; I-beam for text). System cursor stays visible for select/eyedropper.
 */
export class BrushCursor {
  readonly element: HTMLElement;
  readonly #session: Session;
  readonly #eyedropper = new EyedropperPreview();
  readonly #onLeave = () => this.hide();
  #visible = false;
  #over = false;
  #pointerType = "mouse";
  #x = 0;
  #y = 0;

  constructor(session: Session) {
    this.#session = session;
    this.element = h("div", { id: "canvas-scribble-cursor", "aria-hidden": "true" });
    this.element.hidden = true;
    document.body.append(this.element);
    window.addEventListener("blur", this.#onLeave);
    document.addEventListener("pointerleave", this.#onLeave);
  }

  update(cx: number, cy: number, over: boolean, pointerType: string): void {
    this.#x = cx;
    this.#y = cy;
    this.#over = over;
    this.#pointerType = pointerType;
    this.refresh();
  }

  /** Re-read tool, size/nib shape/angle/colour (prefs or zoom changed). */
  refresh(): void {
    const s = this.#session;
    const { tool, mode } = s.effective();
    const hover = this.#over && this.#pointerType !== "touch";
    this.#eyedropper.update(this.#x, this.#y, hover && tool === "eyedropper");
    const show = hover && tool !== "select" && tool !== "eyedropper";
    if (show !== this.#visible) {
      this.#visible = show;
      this.element.hidden = !show;
      document.body.classList.toggle("canvas-scribble-cursor", show);
    }
    if (!show) return;
    const key = sizeKey({ ...s.prefs, tool });
    const space = s.space(mode);
    let d = tool === "paint" ? s.prefs.mediaSizes[s.prefs.mediaBrush] : s.prefs.sizes[key];
    if (space) {
      const scale = tool !== "paint" && key in BRUSHES ? BRUSHES[key as keyof typeof BRUSHES].widthScale : 1;
      d = space.widthFor(d, scale) * space.cssPerUnit();
    }
    if (tool === "text") d = 2;
    d = Math.max(4, Math.min(400, d));

    let w = d;
    let hgt = d;
    let angle = 0;
    let radius = "50%";
    let nibShape = "round";

    const brushId = activeBrushId({ ...s.prefs, tool });
    if (brushId) {
      const brush = BRUSHES[brushId];
      const params = resolveBrushParams(brush, s.prefs.brushParams[brushId]);
      if (brush.tip === "rect" || brush.tip === "bristle") {
        nibShape = "rect";
        hgt = Math.max(3, d * params.aspect);
        angle = params.angleMode === "fixed" ? params.angle : params.angle;
        const rPx = Math.round((Math.min(w, hgt) / 2) * params.corner);
        radius = `${rPx}px`;
      }
    } else if (tool === "eraser" && s.prefs.eraserTip === "rect") {
      nibShape = "rect";
      hgt = Math.max(3, d * s.prefs.eraserAspect);
      angle = s.prefs.eraserAngle;
      radius = "1px";
    }

    const el = this.element;
    el.dataset.tool = tool;
    el.dataset.mode = mode;
    el.dataset.nib = nibShape;
    el.style.setProperty("--cs-color", s.color());
    el.style.width = `${w}px`;
    el.style.height = `${hgt}px`;
    el.style.borderRadius = radius;
    el.style.transform = `translate(${this.#x - w / 2}px, ${this.#y - hgt / 2}px) rotate(${angle}deg)`;
  }

  hide(): void {
    this.update(this.#x, this.#y, false, "mouse");
  }

  destroy(): void {
    window.removeEventListener("blur", this.#onLeave);
    document.removeEventListener("pointerleave", this.#onLeave);
    this.#eyedropper.destroy();
    document.body.classList.remove("canvas-scribble-cursor");
    this.element.remove();
  }
}
