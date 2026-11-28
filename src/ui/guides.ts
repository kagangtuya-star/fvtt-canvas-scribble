import { nearestOnCurve, sampleCurve } from "../assist/curve.ts";
import type { CurveRuler, PerspectiveRuler } from "../assist/guides-model.ts";
import { foldOf, symmetryAxes } from "../brush/symmetry.ts";
import type { Pt } from "../core/matrix.ts";
import type { Mode, ScribbleItem } from "../core/types.ts";
import { t } from "../i18n.ts";
import type { Session } from "../session.ts";
import { FRAME_HANDLES, HANDLE_LOCAL, framePoint } from "../tools/transform.ts";
import type { TransformHandle } from "../tools/transform.ts";
import { h, iconButton, themeClass } from "./dom.ts";

/**
 * Screen-space overlays of the drawing aids:
 *  1. Symmetry axes with a draggable centre pin (double-click resets it)
 *     and an axis-rotation handle.
 *  2. Perspective and curve rulers; in ruler edit mode their points can be
 *     dragged, curves get new points by clicking the curve and lose them
 *     with Alt+click.
 *  3. The selection's free-transform frame: scale handles on corners and
 *     edges (Shift frees the proportions, Alt scales from the centre, Ctrl
 *     skews on an edge and distorts on a corner, Ctrl+Alt+Shift drags a
 *     symmetric perspective), a rotation handle, the pivot and quick actions.
 *  4. The marquee / lasso being dragged.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
type Attrs = Record<string, string | number>;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const CURSOR: Record<string, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

interface DragHandlers {
  start(e: PointerEvent): boolean;
  move(e: PointerEvent): void;
  end(e: PointerEvent): void;
  cancel?(): void;
}

/** Pointer drag on an overlay element (window listeners, primary button only). */
function draggable(el: Element, handlers: DragHandlers): void {
  el.addEventListener("pointerdown", (event) => {
    const e = event as PointerEvent;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (!handlers.start(e)) return;
    const id = e.pointerId;
    const off = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId === id) handlers.move(ev);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      off();
      handlers.end(ev);
    };
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      off();
      handlers.cancel?.();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
  });
}

const sample = (e: PointerEvent) => ({
  cx: e.clientX,
  cy: e.clientY,
  time: e.timeStamp,
  pressure: 0.5,
  pointerType: e.pointerType,
});
const mods = (e: PointerEvent) => ({ shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey });

export class GuidesOverlay {
  readonly element: HTMLElement;
  readonly #svg: SVGSVGElement;
  readonly #actions: HTMLElement;
  readonly #session: Session;
  readonly #off: () => void;
  #active = false;
  #actionsKey = "";
  #numeric = false;

  constructor(session: Session) {
    this.#session = session;
    this.#svg = svg("svg", { class: "cs-sym-svg", "aria-hidden": "true" });
    this.#actions = h("div", { class: `cs-select-actions themed ${themeClass()}` });
    this.#actions.hidden = true;
    this.element = h("div", { id: "canvas-scribble-guides" }, this.#svg as unknown as Node, this.#actions);
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
    const mode = s.effective().mode;
    const sym = s.prefs.symmetry !== "none";
    const frame = s.selectionFrame();
    const region = s.selectionRegion();
    const rulers = (s.prefs.rulers || s.rulerEdit) && s.rulersFor(mode).length > 0;
    const show = this.#active && (sym || !!frame || !!region || rulers);
    this.element.hidden = !show;
    while (this.#svg.firstChild) this.#svg.firstChild.remove();
    if (!show) {
      this.#actions.hidden = true;
      return;
    }
    if (rulers) this.#renderRulers(mode);
    if (sym) this.#renderSymmetry(mode);
    this.#renderSelection(frame);
    if (region) this.#renderRegion(region);
  }

  #client(mode: Mode, p: Pt): Pt | null {
    return this.#session.fromRefSpace(mode, p);
  }

  #line(x1: number, y1: number, x2: number, y2: number, cls: string): void {
    this.#svg.append(svg("line", { x1, y1, x2, y2, class: cls }));
  }

  /* -------------------------------------------- */
  /*  Symmetry                                    */
  /* -------------------------------------------- */

  #renderSymmetry(mode: Mode): void {
    const s = this.#session;
    const sym = s.prefs.symmetry;
    const c = this.#client(mode, s.symmetryCenterFor(mode));
    if (!c) return;
    const R = Math.hypot(window.innerWidth, window.innerHeight);
    const angle = s.prefs.symmetryAngle;
    const rays = sym.startsWith("radial");
    for (const a of symmetryAxes(sym, angle)) {
      const dx = Math.cos(a) * R;
      const dy = Math.sin(a) * R;
      if (rays) this.#line(c.x, c.y, c.x + dx, c.y + dy, "cs-sym-line");
      else this.#line(c.x - dx, c.y - dy, c.x + dx, c.y + dy, "cs-sym-line");
    }

    // Axis rotation handle (radial modes are rotation-invariant: only mirrors need it).
    if (!rays || foldOf(sym) === 0) {
      const a = (angle * Math.PI) / 180;
      const hx = c.x + Math.cos(a) * 56;
      const hy = c.y + Math.sin(a) * 56;
      this.#line(c.x, c.y, hx, hy, "cs-sym-arm");
      const knob = svg("circle", { cx: hx, cy: hy, r: 5, class: "cs-sym-knob cs-grab" });
      const tip = svg("title");
      tip.textContent = t("Aids.AngleHandle");
      knob.append(tip);
      draggable(knob, {
        start: () => true,
        move: (e) => {
          let deg = (Math.atan2(e.clientY - c.y, e.clientX - c.x) * 180) / Math.PI;
          if (e.shiftKey) deg = Math.round(deg / 15) * 15;
          s.setPrefs({ symmetryAngle: Math.round(deg * 10) / 10 });
        },
        end: () => undefined,
      });
      this.#svg.append(knob);
    }

    const pin = svg("circle", { cx: c.x, cy: c.y, r: 6, class: "cs-sym-center cs-grab" });
    const tip = svg("title");
    tip.textContent = t("Aids.CenterHandle");
    pin.append(tip);
    draggable(pin, {
      start: () => true,
      move: (e) => {
        const p = s.toRefSpace(mode, e.clientX, e.clientY);
        if (p) s.setSymmetryCenter(mode, p);
      },
      end: () => undefined,
    });
    pin.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      s.setSymmetryCenter(mode, null);
    });
    this.#svg.append(pin);
  }

  /* -------------------------------------------- */
  /*  Rulers                                      */
  /* -------------------------------------------- */

  #renderRulers(mode: Mode): void {
    for (const r of this.#session.rulersFor(mode)) {
      if (r.kind === "perspective") this.#renderPerspective(mode, r);
      else this.#renderCurve(mode, r);
    }
  }

  #pointHandle(mode: Mode, rulerId: string, index: number, p: Pt, removable: boolean): void {
    const s = this.#session;
    const knob = svg("circle", { cx: p.x, cy: p.y, r: 6, class: "cs-ruler-handle cs-grab" });
    draggable(knob, {
      start: (e) => {
        if (removable && e.altKey) {
          s.removeRulerPoint(rulerId, index);
          return false;
        }
        return true;
      },
      move: (e) => {
        const q = s.toRefSpace(mode, e.clientX, e.clientY);
        if (q) s.moveRulerPoint(rulerId, index, q);
      },
      end: (e) => {
        const q = s.toRefSpace(mode, e.clientX, e.clientY);
        if (q) s.moveRulerPoint(rulerId, index, q, true);
      },
    });
    this.#svg.append(knob);
  }

  #renderPerspective(mode: Mode, r: PerspectiveRuler): void {
    const s = this.#session;
    const vps = r.vps.map((p) => this.#client(mode, p)).filter((p): p is Pt => !!p);
    if (!vps.length) return;
    const R = Math.hypot(window.innerWidth, window.innerHeight) * 2;
    const cls = `cs-ruler-line ${r.on ? "" : "off"}`;
    // Horizon: through the first two vanishing points, or horizontal through a single one.
    const a = vps[0]!;
    const b = vps[1] ?? { x: a.x + 1, y: a.y };
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const hx = ((b.x - a.x) / len) * R;
    const hy = ((b.y - a.y) / len) * R;
    this.#line(a.x - hx, a.y - hy, a.x + hx, a.y + hy, `${cls} cs-ruler-horizon`);
    for (const vp of vps) {
      for (let i = 0; i < 24; i++) {
        const ang = (i / 24) * Math.PI * 2;
        this.#line(vp.x, vp.y, vp.x + Math.cos(ang) * R, vp.y + Math.sin(ang) * R, `${cls} cs-ruler-ray`);
      }
    }
    if (s.rulerEdit) vps.forEach((p, i) => this.#pointHandle(mode, r.id, i, p, false));
  }

  #renderCurve(mode: Mode, r: CurveRuler): void {
    const s = this.#session;
    const pts = r.pts.map((p) => this.#client(mode, p)).filter((p): p is Pt => !!p);
    if (pts.length < 2) return;
    const curve = sampleCurve(pts, r.closed, 4);
    let d = "";
    for (let i = 0; i + 1 < curve.xy.length; i += 2)
      d += `${i ? "L" : "M"}${curve.xy[i]!.toFixed(1)} ${curve.xy[i + 1]!.toFixed(1)}`;
    this.#svg.append(svg("path", { d, class: `cs-ruler-curve ${r.on ? "" : "off"}` }));
    if (!s.rulerEdit) return;
    // Clicking the curve inserts a control point there.
    const hit = svg("path", { d, class: "cs-ruler-hit cs-grab" });
    const tip = svg("title");
    tip.textContent = t("Aids.CurveHint");
    hit.append(tip);
    hit.addEventListener("pointerdown", (event) => {
      const e = event as PointerEvent;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const near = nearestOnCurve(curve, e.clientX, e.clientY);
      const q = s.toRefSpace(mode, e.clientX, e.clientY);
      if (near && q) s.insertRulerPoint(r.id, curve.seg[near.index] ?? pts.length - 2, q);
    });
    this.#svg.append(hit);
    pts.forEach((p, i) => this.#pointHandle(mode, r.id, i, p, true));
  }

  /* -------------------------------------------- */
  /*  Selection frame                             */
  /* -------------------------------------------- */

  #renderSelection(frame: ReturnType<Session["selectionFrame"]>): void {
    const s = this.#session;
    const editing = frame?.entries.some((e) => e.item.id === s.editingTextId);
    if (!frame || editing) {
      this.#actions.hidden = true;
      this.#actionsKey = "";
      return;
    }
    const quad = frame.quad.map((p) => this.#client(frame.mode, p));
    if (quad.some((p) => !p)) {
      this.#actions.hidden = true;
      return;
    }
    const q = quad as Pt[];
    this.#svg.append(svg("polygon", { points: q.map((p) => `${p.x},${p.y}`).join(" "), class: "cs-sel-frame" }));
    const single = frame.entries.length === 1 ? frame.entries[0]!.item : null;
    const textOnly = frame.entries.every((e) => e.item.kind === "text");
    const busy = s.transforming;

    const bind = (el: SVGElement, handle: TransformHandle) =>
      draggable(el, {
        start: (e) => s.startTransformHandle(handle, e.clientX, e.clientY, mods(e)),
        move: (e) => s.pointerMove([sample(e)], mods(e)),
        end: (e) => s.pointerUp(sample(e), mods(e)),
        cancel: () => {
          s.cancelGesture();
          s.changed();
        },
      });

    // Rotation handle: outward from the top edge.
    const top = framePoint(q, 0.5, 0);
    const mid = framePoint(q, 0.5, 0.5);
    if (!textOnly) {
      const dx = top.x - mid.x;
      const dy = top.y - mid.y;
      const len = Math.hypot(dx, dy) || 1;
      const rx = top.x + (dx / len) * 24;
      const ry = top.y + (dy / len) * 24;
      this.#line(top.x, top.y, rx, ry, "cs-sel-arm");
      const rot = svg("circle", { cx: rx, cy: ry, r: 6, class: "cs-handle-svg cs-handle-rot cs-grab" });
      const tip = svg("title");
      tip.textContent = t("Select.Rotate");
      rot.append(tip);
      bind(rot, "rotate");
      this.#svg.append(rot);
    }

    for (const handle of FRAME_HANDLES) {
      const local = HANDLE_LOCAL[handle];
      const edge = local.x === 0.5 || local.y === 0.5;
      let bound: TransformHandle = handle;
      if (single?.kind === "text" && edge) {
        if (handle === "w") bound = "width-left";
        else if (handle === "e") bound = "width-right";
        else continue;
      } else if (textOnly && edge) continue;
      const p = framePoint(q, local.x, local.y);
      const knob = svg("rect", {
        x: p.x - 5,
        y: p.y - 5,
        width: 10,
        height: 10,
        rx: 2,
        class: `cs-handle-svg cs-grab ${edge ? "edge" : "corner"}`,
        style: `cursor: ${CURSOR[handle]}`,
      });
      const tip = svg("title");
      tip.textContent = bound.startsWith("width-")
        ? t("Text.Resize")
        : t(edge ? "Select.EdgeHint" : "Select.CornerHint");
      knob.append(tip);
      bind(knob, bound);
      this.#svg.append(knob);
    }

    if (!textOnly) {
      const pv = this.#client(frame.mode, frame.pivot);
      if (pv) {
        this.#line(pv.x - 7, pv.y, pv.x + 7, pv.y, "cs-sel-pivot-line");
        this.#line(pv.x, pv.y - 7, pv.x, pv.y + 7, "cs-sel-pivot-line");
        const knob = svg("circle", { cx: pv.x, cy: pv.y, r: 4, class: "cs-sel-pivot cs-grab" });
        const tip = svg("title");
        tip.textContent = t("Select.Pivot");
        knob.append(tip);
        bind(knob, "pivot");
        this.#svg.append(knob);
      }
    }

    // Quick actions below the frame.
    if (busy) {
      this.#actions.hidden = true;
      return;
    }
    const key = `${frame.entries.map((e) => `${e.item.id}:${e.item.revision}`).join(",")}|${this.#numeric}`;
    if (key !== this.#actionsKey) {
      this.#actionsKey = key;
      this.#buildActions(single);
    }
    const ys = q.map((p) => p.y);
    const xs = q.map((p) => p.x);
    this.#actions.hidden = false;
    const w = this.#actions.offsetWidth || 200;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2));
    const barH = this.#actions.offsetHeight || 32;
    let topY = Math.max(...ys) + 14;
    // No room below (e.g. over the palette): above the frame instead.
    if (topY + barH > window.innerHeight - 72) topY = Math.min(...ys) - barH - 30;
    topY = Math.max(8, Math.min(window.innerHeight - barH - 8, topY));
    this.#actions.style.left = `${Math.round(left)}px`;
    this.#actions.style.top = `${Math.round(topY)}px`;
  }

  #buildActions(single: ScribbleItem | null): void {
    const s = this.#session;
    const bar = this.#actions;
    bar.className = `cs-select-actions themed ${themeClass()}`;
    const row = h(
      "div",
      { class: "cs-select-row" },
      iconButton("fa-solid fa-clone", t("Select.Duplicate"), () => s.duplicateSelected()),
      iconButton("fa-solid fa-fill-drip", t("Select.Recolor"), () => s.recolorSelected(s.color())),
      iconButton("fa-solid fa-left-right", t("Select.FlipH"), () => s.flipSelection("h")),
      iconButton("fa-solid fa-up-down", t("Select.FlipV"), () => s.flipSelection("v")),
      iconButton("fa-solid fa-rotate-right", t("Select.Rotate90"), () => s.rotateSelection(90)),
      iconButton(
        "fa-solid fa-sliders",
        t("Select.Numeric"),
        () => {
          this.#numeric = !this.#numeric;
          this.refresh();
        },
        { pressed: this.#numeric },
      ),
      iconButton("fa-solid fa-trash", t("Select.Delete"), () => s.deleteSelected()),
    );
    if (single?.kind === "text") {
      row.prepend(
        iconButton("fa-solid fa-pen-to-square", t("Text.Edit"), () => s.editText()),
        iconButton("fa-solid fa-arrows-left-right", t("Text.AutoWidth"), () => s.resetTextWidth(), {
          disabled: single.textWidth === undefined,
        }),
      );
    }
    bar.replaceChildren(row);
    if (!this.#numeric) return;
    const scale = h("input", {
      type: "number",
      min: 5,
      max: 2000,
      step: 5,
      value: 100,
      class: "cs-num",
      "aria-label": t("Select.ScaleField"),
    }) as HTMLInputElement;
    const angle = h("input", {
      type: "number",
      min: -360,
      max: 360,
      step: 15,
      value: 0,
      class: "cs-num",
      "aria-label": t("Select.AngleField"),
    }) as HTMLInputElement;
    const apply = () => {
      const f = Number(scale.value) / 100;
      const deg = Number(angle.value);
      if (Number.isFinite(f) && f > 0 && f !== 1) s.scaleSelection(f);
      if (Number.isFinite(deg) && deg) s.rotateSelection(deg);
    };
    for (const input of [scale, angle]) {
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") apply();
      });
    }
    bar.append(
      h(
        "div",
        { class: "cs-select-row cs-select-numeric" },
        h("label", {}, h("span", {}, t("Select.ScaleField")), scale, "%"),
        h("label", {}, h("span", {}, t("Select.AngleField")), angle, "°"),
        iconButton("fa-solid fa-check", t("Select.Apply"), apply),
      ),
    );
  }

  /* -------------------------------------------- */
  /*  Marquee / lasso                             */
  /* -------------------------------------------- */

  #renderRegion(region: { shape: "rect" | "lasso"; pts: readonly number[] }): void {
    const p = region.pts;
    if (region.shape === "rect") {
      if (p.length < 4) return;
      const x = Math.min(p[0]!, p[2]!);
      const y = Math.min(p[1]!, p[3]!);
      this.#svg.append(
        svg("rect", { x, y, width: Math.abs(p[2]! - p[0]!), height: Math.abs(p[3]! - p[1]!), class: "cs-sel-region" }),
      );
      return;
    }
    const points: string[] = [];
    for (let i = 0; i + 1 < p.length; i += 2) points.push(`${p[i]},${p[i + 1]}`);
    this.#svg.append(svg("polygon", { points: points.join(" "), class: "cs-sel-region" }));
  }

  destroy(): void {
    this.#off();
    this.element.remove();
  }
}
