import { t } from "../i18n.ts";
import type { Session } from "../session.ts";
import { h, iconButton, themeClass } from "./dom.ts";

/**
 * Lightweight screen-space overlays for professional drawing aids:
 *  1. Symmetry guide axes (vertical, horizontal, quad, N-fold radial) with a
 *     draggable centre pin on the map.
 *  2. Selection transform box with corner scale handles, rotation handle and
 *     quick action buttons (duplicate, recolour, delete).
 */
export class GuidesOverlay {
  readonly element: HTMLElement;
  readonly #svg: SVGSVGElement;
  readonly #selBox: HTMLElement;
  readonly #session: Session;
  readonly #off: () => void;
  #active = false;

  constructor(session: Session) {
    this.#session = session;
    this.#svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.#svg.setAttribute("class", "cs-sym-svg");
    this.#selBox = h("div", { class: `cs-select-box themed ${themeClass()}` });
    this.#selBox.hidden = true;
    this.element = h("div", { id: "canvas-scribble-guides", "aria-hidden": "true" }, this.#svg, this.#selBox);
    this.element.hidden = true;
    document.body.append(this.element);
    this.#off = session.onChange(() => this.refresh());
  }

  setActive(active: boolean): void {
    this.#active = active;
    this.refresh();
  }

  refresh(): void {
    const s = this.#session;
    const sym = s.prefs.symmetry;
    const sel = s.selectedEntry();
    const show = this.#active && (sym !== "none" || !!sel);
    this.element.hidden = !show;
    if (!show) return;

    this.#renderSymmetry(sym);
    this.#renderSelection(sel);
  }

  #renderSymmetry(mode: Session["prefs"]["symmetry"]): void {
    const svg = this.#svg;
    while (svg.firstChild) svg.firstChild.remove();
    if (mode === "none") return;

    const s = this.#session;
    const vp = s.viewport();
    let cx = vp.left + vp.width / 2;
    let cy = vp.top + vp.height / 2;
    if (s.prefs.mode === "map" && s.symmetryCenter && s.map()) {
      const c = s.map()!.toClient(s.symmetryCenter.x, s.symmetryCenter.y);
      cx = c.x;
      cy = c.y;
    }

    const R = Math.hypot(window.innerWidth, window.innerHeight);
    const addLine = (x1: number, y1: number, x2: number, y2: number) => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      line.setAttribute("class", "cs-sym-line");
      svg.append(line);
    };

    if (mode === "vertical" || mode === "quad") addLine(cx, cy - R, cx, cy + R);
    if (mode === "horizontal" || mode === "quad") addLine(cx - R, cy, cx + R, cy);
    if (mode.startsWith("radial")) {
      const n = Number(mode.slice(6));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        addLine(cx, cy, cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      }
    }
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", String(cy));
    dot.setAttribute("r", "5");
    dot.setAttribute("class", "cs-sym-center");
    svg.append(dot);
  }

  #renderSelection(entry: ReturnType<Session["selectedEntry"]>): void {
    const box = this.#selBox;
    if (!entry) {
      box.hidden = true;
      return;
    }
    const s = this.#session;
    const space = s.space(entry.item.mode);
    if (!space) {
      box.hidden = true;
      return;
    }
    const [x0, y0, x1, y1] = entry.bounds;
    const p0 = space.toClient(x0, y0, entry.item.anchor);
    const p1 = space.toClient(x1, y1, entry.item.anchor);
    const left = Math.min(p0.x, p1.x);
    const top = Math.min(p0.y, p1.y);
    const w = Math.max(16, Math.abs(p1.x - p0.x));
    const hgt = Math.max(16, Math.abs(p1.y - p0.y));

    box.hidden = false;
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;
    box.style.width = `${Math.round(w)}px`;
    box.style.height = `${Math.round(hgt)}px`;

    box.replaceChildren();
    const bindHandle = (el: HTMLElement, mode: "scale" | "rotate") => {
      el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (!s.startTransformHandle(mode, e.clientX, e.clientY)) return;
        const move = (ev: PointerEvent) => {
          s.pointerMove(
            [{ cx: ev.clientX, cy: ev.clientY, time: ev.timeStamp, pressure: 0.5, pointerType: ev.pointerType }],
            { shift: ev.shiftKey, alt: ev.altKey },
          );
        };
        const up = (ev: PointerEvent) => {
          window.removeEventListener("pointermove", move, true);
          window.removeEventListener("pointerup", up, true);
          s.pointerUp(
            { cx: ev.clientX, cy: ev.clientY, time: ev.timeStamp, pressure: 0.5, pointerType: ev.pointerType },
            { shift: ev.shiftKey, alt: ev.altKey },
          );
        };
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", up, true);
      });
    };

    for (const corner of ["nw", "ne", "sw", "se"]) {
      const handle = h("div", { class: `cs-handle cs-handle-${corner}`, "data-tooltip": t("Select.Scale") });
      bindHandle(handle, "scale");
      box.append(handle);
    }
    const rot = h("div", { class: "cs-handle cs-handle-rot", "data-tooltip": t("Select.Rotate") });
    bindHandle(rot, "rotate");
    box.append(rot);

    const actions = h(
      "div",
      { class: "cs-select-actions" },
      iconButton("fa-solid fa-clone", t("Select.Duplicate"), () => s.duplicateSelected()),
      iconButton("fa-solid fa-fill-drip", t("Select.Recolor"), () => s.recolorSelected(s.color())),
      iconButton("fa-solid fa-trash", t("Select.Delete"), () => s.deleteSelected()),
    );
    box.append(actions);
  }

  destroy(): void {
    this.#off();
    this.element.remove();
  }
}
