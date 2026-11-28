import { BRUSHES, DEFAULT_PALETTE, SIZE_PRESETS, UI_SIZE, resolveBrushParams } from "../brush/brushes.ts";
import { FADE_PRESETS, LIFETIME_PRESETS, formatLifetime, parseLifetime } from "../core/lifetime.ts";
import { FILL_PATTERNS } from "../core/types.ts";
import type { BrushId, MapLayer } from "../core/types.ts";
import { userColor } from "../foundry/compat.ts";
import { t, tf } from "../i18n.ts";
import type { Session } from "../session.ts";
import { activeBrushId, brushOpacity, pushRecent, sizeKey, TOOL_IDS } from "../state/prefs.ts";
import type { Prefs, ToolId } from "../state/prefs.ts";
import { buildAidsMenu, buildBrushStudio } from "./brush-studio.ts";
import { h, icon, iconButton, themeClass } from "./dom.ts";
import { Popover, togglePopover } from "./popover.ts";

/**
 * Quick palette: a compact bar docked above the hotbar (or dragged anywhere).
 * Mode, tool, contextual variants, Brush Studio, Drawing Aids, colour, size &
 * opacity, lifetime, layer, undo/redo and the clear menu.
 */

export const TOOL_ICON: Record<ToolId, string> = {
  draw: "fa-solid fa-pen-nib",
  highlight: "fa-solid fa-highlighter",
  arrow: "fa-solid fa-arrow-trend-up",
  shape: "fa-regular fa-square",
  laser: "fa-solid fa-wand-sparkles",
  text: "fa-solid fa-font",
  eraser: "fa-solid fa-eraser",
  select: "fa-solid fa-arrow-pointer",
  eyedropper: "fa-solid fa-eye-dropper",
};

/** Curated quick-access brushes shown directly on the bar; all 16 live in Brush Studio. */
const QUICK_BRUSHES: readonly Exclude<BrushId, "highlighter">[] = [
  "pen",
  "pressure",
  "flat",
  "calligraphy",
  "bristle",
  "pencil",
  "airbrush",
];

const SHAPE_ICON = {
  line: "fa-solid fa-minus",
  rect: "fa-regular fa-square",
  ellipse: "fa-regular fa-circle",
  polygon: "fa-solid fa-draw-polygon",
} as const;

const LAYER_ICON: Record<MapLayer, string> = {
  below: "fa-solid fa-layer-group fa-flip-vertical",
  above: "fa-solid fa-layer-group",
  top: "fa-solid fa-cloud-sun",
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const labeled = (label: string, value: string) => tf("Palette.Labeled", { label, value });

export interface PaletteHooks {
  openClearMenu(anchor: HTMLElement): void;
  hidden(): boolean;
}

export class Palette {
  readonly element: HTMLElement;
  readonly #session: Session;
  readonly #hooks: PaletteHooks;
  readonly #bar: HTMLElement;
  #shown = false;
  #off: () => void;
  #drag: { dx: number; dy: number; id: number } | null = null;

  constructor(session: Session, hooks: PaletteHooks) {
    this.#session = session;
    this.#hooks = hooks;
    this.#bar = h("div", { class: "cs-bar" });
    const grip = h(
      "div",
      {
        class: "cs-grip",
        "data-tooltip": t("Palette.Drag"),
        "aria-label": t("Palette.Drag"),
        role: "separator",
      },
      icon("fa-solid fa-grip-vertical"),
    );
    grip.addEventListener("pointerdown", (e) => this.#dragStart(e));
    grip.addEventListener("dblclick", () => {
      this.#session.setPrefs({ palette: null });
      this.#mount();
    });
    this.element = h(
      "section",
      {
        id: "canvas-scribble-palette",
        class: `cs-palette themed ${themeClass()}`,
        role: "toolbar",
        "aria-label": t("Palette.Label"),
      },
      grip,
      this.#bar,
    );
    this.element.hidden = true;
    this.#off = session.onChange(() => this.render());
  }

  get shown(): boolean {
    return this.#shown;
  }

  show(on: boolean): void {
    if (on === this.#shown && this.element.isConnected) return;
    this.#shown = on;
    if (!on) {
      Popover.closeAll();
      this.element.hidden = true;
      return;
    }
    this.#mount();
    this.element.hidden = false;
    this.render();
  }

  /** Docked in #ui-bottom above the hotbar, or floating at the saved position. */
  #mount(): void {
    const pos = this.#session.prefs.palette;
    this.element.classList.toggle("floating", !!pos);
    if (pos) {
      if (this.element.parentElement !== document.body) document.body.append(this.element);
      this.#place(pos.x, pos.y);
      return;
    }
    this.element.style.left = "";
    this.element.style.top = "";
    const bottom = document.getElementById("ui-bottom");
    const hotbar = document.getElementById("hotbar");
    if (bottom) {
      if (hotbar && hotbar.parentElement === bottom) bottom.insertBefore(this.element, hotbar);
      else if (this.element.parentElement !== bottom) bottom.append(this.element);
    } else if (this.element.parentElement !== document.body) document.body.append(this.element);
  }

  #place(x: number, y: number): void {
    const r = this.element.getBoundingClientRect();
    const w = r.width || 400;
    const hgt = r.height || 40;
    const cx = Math.max(4, Math.min(window.innerWidth - w - 4, x));
    const cy = Math.max(4, Math.min(window.innerHeight - hgt - 4, y));
    this.element.style.left = `${Math.round(cx)}px`;
    this.element.style.top = `${Math.round(cy)}px`;
  }

  #dragStart(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = this.element.getBoundingClientRect();
    this.#drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
    if (this.element.parentElement !== document.body) {
      document.body.append(this.element);
      this.element.classList.add("floating");
    }
    this.#place(r.left, r.top);
    const move = (ev: PointerEvent) => {
      if (!this.#drag || ev.pointerId !== this.#drag.id) return;
      this.#place(ev.clientX - this.#drag.dx, ev.clientY - this.#drag.dy);
      Popover.open?.position();
    };
    const up = (ev: PointerEvent) => {
      if (!this.#drag || ev.pointerId !== this.#drag.id) return;
      this.#drag = null;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      const rr = this.element.getBoundingClientRect();
      this.#session.setPrefs({ palette: { x: rr.left, y: rr.top } });
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  render(): void {
    if (!this.#shown) return;
    const s = this.#session;
    const p = s.prefs;
    const { tool, mode } = s.effective();
    const bar = this.#bar;
    const openAnchor = Popover.open ? bar.querySelector<HTMLElement>("[aria-expanded=true]")?.dataset.pop : undefined;
    bar.replaceChildren();
    this.element.classList.toggle("compact", p.compact);
    this.element.classList.toggle("holding", !!s.hold);
    this.element.dataset.mode = mode;

    // Mode switch
    const modes = h("div", { class: "cs-group cs-segment", role: "radiogroup", "aria-label": t("Palette.Mode") });
    for (const m of ["screen", "map"] as const) {
      const allowed = s.can(m);
      modes.append(
        iconButton(
          m === "screen" ? "fa-solid fa-display" : "fa-solid fa-map",
          t(`Mode.${cap(m)}.Hint`),
          () => s.setPrefs({ mode: m }),
          {
            pressed: mode === m,
            disabled: !allowed || (m === "map" && !s.map()),
            extra: "cs-mode",
            data: { mode: m },
          },
        ),
      );
    }
    bar.append(modes);

    // Tool chip
    const toolBtn = iconButton(
      TOOL_ICON[tool],
      labeled(t("Palette.Tool"), t(`Tools.${cap(tool)}`)),
      (e) => togglePopover(e.currentTarget as HTMLElement, () => this.#toolMenu(), { label: t("Palette.Tool") }),
      { extra: "cs-chip cs-tool", data: { pop: "tool" } },
    );
    bar.append(h("div", { class: "cs-group" }, toolBtn));

    if (!p.compact) {
      const variants = this.#variants(tool, p);
      if (variants) bar.append(variants);
    }

    // Colour, size, Studio/Aids, lifetime, layer
    const style = h("div", { class: "cs-group" });
    const color = s.color();
    const colorBtn = h(
      "button",
      {
        type: "button",
        class: "ui-control cs-btn cs-swatch-btn",
        "aria-label": t("Palette.Color"),
        "data-tooltip": t("Palette.Color"),
        "data-pop": "color",
        style: `--cs-color:${color}`,
      },
      h("span", { class: "cs-swatch", inert: true }),
    );
    colorBtn.addEventListener("click", () =>
      togglePopover(colorBtn, () => this.#colorMenu(), { label: t("Palette.Color") }),
    );
    style.append(colorBtn);

    if (tool !== "select" && tool !== "eyedropper" && (tool !== "laser" || !p.compact)) {
      const size = p.sizes[sizeKey({ ...p, tool })];
      const sizeBtn = h(
        "button",
        {
          type: "button",
          class: "ui-control cs-btn cs-size-btn",
          "aria-label": tf("Palette.SizeValue", { size }),
          "data-tooltip": t("Palette.Size"),
          "data-pop": "size",
        },
        h("span", {
          class: "cs-dot",
          style: `--cs-dot:${Math.max(3, Math.min(20, 3 + Math.sqrt(size) * 2.6))}px`,
          inert: true,
        }),
        h("span", { class: "cs-num", inert: true }, String(size)),
      );
      sizeBtn.addEventListener("click", () =>
        togglePopover(sizeBtn, () => this.#sizeMenu(), { label: t("Palette.Size") }),
      );
      style.append(sizeBtn);
    }

    // Brush Studio button (draw & highlighter)
    if (tool === "draw" || (tool === "highlight" && p.highlight === "stroke")) {
      const studioBtn = iconButton(
        "fa-solid fa-sliders",
        t("Palette.Studio"),
        (e) =>
          togglePopover(e.currentTarget as HTMLElement, () => buildBrushStudio(s), {
            className: "cs-popover-wide",
            label: t("Palette.Studio"),
          }),
        { extra: "cs-chip", data: { pop: "studio" } },
      );
      style.append(studioBtn);
    }

    // Drawing Aids button (stabilizer, symmetry, quickShape, gridSnap)
    if (!p.compact && (tool === "draw" || tool === "shape" || tool === "highlight" || tool === "arrow")) {
      const aidsActive = p.stabilizer !== "off" || p.symmetry !== "none" || p.gridSnap;
      const aidsBtn = iconButton(
        "fa-solid fa-compass-drafting",
        t("Palette.Aids"),
        (e) => togglePopover(e.currentTarget as HTMLElement, () => buildAidsMenu(s), { label: t("Palette.Aids") }),
        { pressed: aidsActive, extra: "cs-chip", data: { pop: "aids" } },
      );
      style.append(aidsBtn);
    }

    if (tool !== "eraser" && tool !== "select" && tool !== "eyedropper") {
      const life = tool === "laser" ? p.laserTrail : s.lifetimeFor(mode);
      const lifeBtn = h(
        "button",
        {
          type: "button",
          class: `ui-control cs-btn cs-chip-text ${life === 0 ? "permanent" : ""}`,
          "aria-label": labeled(t(tool === "laser" ? "Palette.Trail" : "Palette.Lifetime"), formatLifetime(life)),
          "data-tooltip": t(tool === "laser" ? "Palette.Trail" : "Palette.Lifetime"),
          "data-pop": "life",
        },
        icon(life === 0 ? "fa-solid fa-thumbtack" : "fa-regular fa-hourglass-half"),
        h("span", { inert: true }, formatLifetime(life)),
      );
      lifeBtn.addEventListener("click", () =>
        togglePopover(lifeBtn, () => this.#lifeMenu(), { label: t("Palette.Lifetime") }),
      );
      style.append(lifeBtn);
    }
    if (mode === "map" && tool !== "laser" && tool !== "eraser" && tool !== "select" && tool !== "eyedropper") {
      const permanent = s.lifetimeFor("map") === 0;
      const layer = permanent ? p.layer.permanent : p.layer.temporary;
      const layerBtn = iconButton(
        LAYER_ICON[layer],
        labeled(t("Palette.Layer"), t(`Layer.${cap(layer)}.Name`)),
        (e) => togglePopover(e.currentTarget as HTMLElement, () => this.#layerMenu(), { label: t("Palette.Layer") }),
        { extra: "cs-chip", data: { pop: "layer" } },
      );
      style.append(layerBtn);
    }
    bar.append(style);

    // History and clearing
    const actions = h(
      "div",
      { class: "cs-group" },
      iconButton("fa-solid fa-rotate-left", t("Controls.Undo"), () => s.undo(), { disabled: !s.history.canUndo }),
      iconButton("fa-solid fa-rotate-right", t("Controls.Redo"), () => s.redo(), { disabled: !s.history.canRedo }),
      iconButton(
        "fa-solid fa-trash",
        t("Controls.Clear"),
        (e) => this.#hooks.openClearMenu(e.currentTarget as HTMLElement),
        {
          data: { pop: "clear" },
        },
      ),
      iconButton(
        p.compact ? "fa-solid fa-angles-right" : "fa-solid fa-angles-left",
        t(p.compact ? "Palette.Expand" : "Palette.Collapse"),
        () => s.setPrefs({ compact: !p.compact }),
      ),
    );
    bar.append(actions);
    if (this.#hooks.hidden())
      bar.append(
        h(
          "span",
          { class: "cs-hidden-flag", "data-tooltip": t("Controls.HiddenNotice") },
          icon("fa-solid fa-eye-slash"),
        ),
      );
    if (s.hold) bar.append(h("span", { class: "cs-hold" }, t(`Hold.${cap(s.hold)}`)));

    // Keep an open popover attached to its re-rendered anchor.
    if (openAnchor) {
      const anchor = bar.querySelector<HTMLElement>(`[data-pop="${openAnchor}"]`);
      Popover.closeAll();
      if (anchor) anchor.click();
    }
    if (this.element.classList.contains("floating") && p.palette) this.#place(p.palette.x, p.palette.y);
  }

  #variants(tool: ToolId, p: Prefs): HTMLElement | null {
    const s = this.#session;
    const group = h("div", { class: "cs-group cs-variants", role: "radiogroup" });
    const opt = (iconCls: string, label: string, pressed: boolean, apply: () => void) =>
      group.append(iconButton(iconCls, label, apply, { pressed }));
    switch (tool) {
      case "draw": {
        const list = QUICK_BRUSHES.includes(p.brush) ? QUICK_BRUSHES : [...QUICK_BRUSHES.slice(0, 6), p.brush];
        for (const b of list) {
          opt(BRUSHES[b].icon, t(`Brush.${cap(b)}`), p.brush === b, () => s.setPrefs({ brush: b }));
        }
        break;
      }
      case "highlight":
        opt("fa-solid fa-highlighter", t("Highlight.Stroke"), p.highlight === "stroke", () =>
          s.setPrefs({ highlight: "stroke" }),
        );
        opt("fa-solid fa-draw-polygon", t("Highlight.Area"), p.highlight === "area", () =>
          s.setPrefs({ highlight: "area" }),
        );
        if (p.highlight === "area") {
          group.append(h("span", { class: "cs-sep" }));
          opt("fa-solid fa-wand-magic-sparkles", t("Style.Sketchy"), p.roughness > 0, () =>
            s.setPrefs({ roughness: p.roughness > 0 ? 0 : 1.4 }),
          );
          const nextPat = FILL_PATTERNS[(FILL_PATTERNS.indexOf(p.fillPattern) + 1) % FILL_PATTERNS.length]!;
          opt(
            "fa-solid fa-grip-lines",
            labeled(
              t("Style.Pattern"),
              t(`FillPattern.${cap(p.fillPattern === "cross-hatch" ? "CrossHatch" : p.fillPattern)}`),
            ),
            p.fillPattern !== "solid",
            () => s.setPrefs({ fillPattern: nextPat }),
          );
        }
        break;
      case "arrow":
        opt("fa-solid fa-arrow-right-long", t("Arrow.Straight"), p.arrow === "straight", () =>
          s.setPrefs({ arrow: "straight" }),
        );
        opt("fa-solid fa-route", t("Arrow.Path"), p.arrow === "path", () => s.setPrefs({ arrow: "path" }));
        group.append(h("span", { class: "cs-sep" }));
        opt("fa-solid fa-arrows-left-right", t("Arrow.Both"), p.head === "both", () =>
          s.setPrefs({ head: p.head === "both" ? "end" : "both" }),
        );
        opt("fa-solid fa-ellipsis", t("Style.Dash"), p.dash, () => s.setPrefs({ dash: !p.dash }));
        break;
      case "shape": {
        for (const v of ["line", "rect", "ellipse", "polygon"] as const) {
          opt(SHAPE_ICON[v], t(`Shape.${cap(v)}`), p.shape === v, () => s.setPrefs({ shape: v }));
        }
        group.append(h("span", { class: "cs-sep" }));
        opt("fa-solid fa-fill-drip", t("Style.Fill"), p.fill, () => s.setPrefs({ fill: !p.fill }));
        opt("fa-solid fa-ellipsis", t("Style.Dash"), p.dash, () => s.setPrefs({ dash: !p.dash }));
        opt("fa-solid fa-wand-magic-sparkles", t("Style.Sketchy"), p.roughness > 0, () =>
          s.setPrefs({ roughness: p.roughness > 0 ? 0 : 1.4 }),
        );
        const nextPat = FILL_PATTERNS[(FILL_PATTERNS.indexOf(p.fillPattern) + 1) % FILL_PATTERNS.length]!;
        opt(
          "fa-solid fa-grip-lines",
          labeled(
            t("Style.Pattern"),
            t(`FillPattern.${cap(p.fillPattern === "cross-hatch" ? "CrossHatch" : p.fillPattern)}`),
          ),
          p.fillPattern !== "solid",
          () => s.setPrefs({ fillPattern: nextPat, fill: true }),
        );
        break;
      }
      case "eraser":
        opt("fa-solid fa-eraser", t("Eraser.Stroke"), p.eraser === "stroke", () => s.setPrefs({ eraser: "stroke" }));
        opt("fa-solid fa-scissors", t("Eraser.Partial"), p.eraser === "partial", () =>
          s.setPrefs({ eraser: "partial" }),
        );
        if (p.eraser === "partial") {
          group.append(h("span", { class: "cs-sep" }));
          opt("fa-solid fa-square", t("Eraser.RectNib"), p.eraserTip === "rect", () =>
            s.setPrefs({ eraserTip: p.eraserTip === "rect" ? "round" : "rect" }),
          );
          opt("fa-solid fa-cloud", t("Eraser.SoftNib"), p.eraserHardness < 0.9, () =>
            s.setPrefs({ eraserHardness: p.eraserHardness < 0.9 ? 1 : 0.3 }),
          );
        }
        break;
      case "text":
        break;
      default:
        return null;
    }
    if (tool === "draw" || tool === "shape" || tool === "arrow" || tool === "text") {
      group.append(h("span", { class: "cs-sep" }));
      opt("fa-solid fa-circle-half-stroke", t("Style.Halo"), p.halo, () => s.setPrefs({ halo: !p.halo }));
    }
    return group;
  }

  /* -------------------------------------------- */
  /*  Popover contents                            */
  /* -------------------------------------------- */

  #toolMenu(): HTMLElement {
    const s = this.#session;
    const list = h("div", { class: "cs-menu cs-tools" });
    for (const id of TOOL_IDS) {
      const active = s.prefs.tool === id;
      const b = h(
        "button",
        { type: "button", class: `cs-menu-item ${active ? "active" : ""}`, "aria-pressed": String(active) },
        icon(TOOL_ICON[id]),
        h("span", {}, t(`Tools.${cap(id)}`)),
      );
      b.addEventListener("click", () => {
        s.setPrefs({ tool: id });
        Popover.closeAll();
      });
      list.append(b);
    }
    return list;
  }

  #colorMenu(): HTMLElement {
    const s = this.#session;
    const p = s.prefs;
    const current = s.color();
    const wrap = h("div", { class: "cs-colors" });
    const swatch = (c: string | null, label: string) => {
      const value = c ?? userColor(game.user);
      const b = h("button", {
        type: "button",
        class: `cs-color ${current === value && (c === null) === (p.color === null) ? "active" : ""} ${c === null ? "player" : ""}`,
        style: `--cs-color:${value}`,
        "aria-label": label,
        "data-tooltip": label,
      });
      b.addEventListener("click", () => {
        s.setPrefs({ color: c });
        if (s.selectedId) s.recolorSelected(value);
      });
      return b;
    };
    const grid = h("div", { class: "cs-color-grid" });
    grid.append(swatch(null, t("Color.Player")));
    for (const c of DEFAULT_PALETTE) grid.append(swatch(c, c));
    wrap.append(grid);
    if (p.recent.length) {
      const recent = h("div", { class: "cs-color-grid recent" }, h("span", { class: "cs-label" }, t("Color.Recent")));
      for (const c of p.recent) recent.append(swatch(c, c));
      wrap.append(recent);
    }
    const custom = h("input", { type: "color", value: current, "aria-label": t("Color.Custom") }) as HTMLInputElement;
    custom.addEventListener("change", () => {
      const c = custom.value.toLowerCase();
      s.setPrefs({ color: c, recent: pushRecent(p, c) });
      if (s.selectedId) s.recolorSelected(c);
    });
    const swapBtn = h(
      "button",
      {
        type: "button",
        class: "cs-preset cs-swap-btn",
        "data-tooltip": t("Color.Swap"),
        style: `--cs-sec:${p.secondaryColor}`,
      },
      h("span", { class: "cs-sec-swatch" }),
      icon("fa-solid fa-repeat"),
    );
    swapBtn.addEventListener("click", () => s.swapColors());
    const pickBtn = h(
      "button",
      { type: "button", class: "cs-preset", "data-tooltip": t("Tools.Eyedropper") },
      icon("fa-solid fa-eye-dropper"),
    );
    pickBtn.addEventListener("click", () => {
      s.setPrefs({ tool: "eyedropper" });
      Popover.closeAll();
    });
    wrap.append(
      h(
        "div",
        { class: "cs-color-footer" },
        h("label", { class: "cs-custom" }, h("span", {}, t("Color.Custom")), custom),
        swapBtn,
        pickBtn,
      ),
    );
    return wrap;
  }

  #sizeMenu(): HTMLElement {
    const s = this.#session;
    const { tool, mode } = s.effective();
    const key = sizeKey({ ...s.prefs, tool });
    const value = s.prefs.sizes[key];
    const max = key === "text" ? 96 : key === "eraser" ? 160 : UI_SIZE.max;
    const wrap = h("div", { class: "cs-size" });
    const preview = h("div", { class: "cs-size-preview" });
    const dot = h("span", { class: "cs-size-dot" });
    preview.append(dot);
    const num = h("output", { class: "cs-size-num" }, String(value));
    const slider = h("input", {
      type: "range",
      min: UI_SIZE.min,
      max,
      step: 1,
      value,
      "aria-label": t("Palette.Size"),
    }) as HTMLInputElement;
    const brushId = activeBrushId({ ...s.prefs, tool });
    const paint = (v: number, op = brushId ? brushOpacity(s.prefs, brushId) : 1) => {
      const space = s.space(mode);
      const scale = key in BRUSHES ? BRUSHES[key as keyof typeof BRUSHES].widthScale : 1;
      const css = space ? space.widthFor(v, scale) * space.cssPerUnit() : v;
      const d = Math.max(2, Math.min(68, css));
      if (brushId && (BRUSHES[brushId].tip === "rect" || BRUSHES[brushId].tip === "bristle")) {
        const params = resolveBrushParams(BRUSHES[brushId], s.prefs.brushParams[brushId]);
        const hgt = Math.max(2, d * params.aspect);
        dot.style.width = `${d}px`;
        dot.style.height = `${hgt}px`;
        dot.style.borderRadius = `${Math.round((Math.min(d, hgt) / 2) * params.corner)}px`;
        dot.style.transform = `rotate(${params.angle}deg)`;
      } else if (key === "eraser" && s.prefs.eraserTip === "rect") {
        const hgt = Math.max(2, d * s.prefs.eraserAspect);
        dot.style.width = `${d}px`;
        dot.style.height = `${hgt}px`;
        dot.style.borderRadius = "1px";
        dot.style.transform = `rotate(${s.prefs.eraserAngle}deg)`;
      } else {
        dot.style.width = dot.style.height = `${d}px`;
        dot.style.borderRadius = "50%";
        dot.style.transform = "";
      }
      dot.style.opacity = String(op);
      dot.style.background = key === "eraser" ? "transparent" : s.color();
      dot.classList.toggle("eraser", key === "eraser");
      num.textContent = String(v);
    };
    paint(value);
    slider.addEventListener("input", () => paint(Number(slider.value)));
    slider.addEventListener("change", () => s.setPrefs({ sizes: { ...s.prefs.sizes, [key]: Number(slider.value) } }));
    const presets = h("div", { class: "cs-presets" });
    const list = key === "text" ? [14, 18, 24, 32, 48] : key === "eraser" ? [8, 16, 32, 64, 120] : SIZE_PRESETS;
    for (const v of list) {
      const b = h(
        "button",
        { type: "button", class: `cs-preset ${v === value ? "active" : ""}`, "aria-label": String(v) },
        String(v),
      );
      b.addEventListener("click", () => s.setPrefs({ sizes: { ...s.prefs.sizes, [key]: v } }));
      presets.append(b);
    }
    wrap.append(h("div", { class: "cs-size-row" }, preview, slider, num), presets);

    // Quick Opacity slider right in the size menu for brushes!
    if (brushId) {
      const opVal = Math.round(brushOpacity(s.prefs, brushId) * 100);
      const opNum = h("output", { class: "cs-size-num" }, `${opVal}%`);
      const opSlider = h("input", {
        type: "range",
        min: 5,
        max: 100,
        step: 1,
        value: opVal,
        "aria-label": t("Studio.Opacity"),
      }) as HTMLInputElement;
      opSlider.addEventListener("input", () => {
        opNum.textContent = `${opSlider.value}%`;
        paint(Number(slider.value), Number(opSlider.value) / 100);
      });
      opSlider.addEventListener("change", () =>
        s.setPrefs({ opacities: { ...s.prefs.opacities, [brushId]: Number(opSlider.value) / 100 } }),
      );
      wrap.append(
        h("div", { class: "cs-size-row" }, h("span", { class: "cs-label" }, t("Studio.Opacity")), opSlider, opNum),
      );
    }

    if (mode === "map" && key !== "eraser")
      wrap.append(h("p", { class: "cs-hint" }, t(s.map()?.followZoom ? "Size.HintZoom" : "Size.HintGrid")));
    return wrap;
  }

  #lifeMenu(): HTMLElement {
    const s = this.#session;
    const { tool, mode } = s.effective();
    const p = s.prefs;
    const wrap = h("div", { class: "cs-life" });
    if (tool === "laser") {
      const row = h("div", { class: "cs-presets" });
      for (const v of [600, 1200, 2000, 3000]) {
        const b = h(
          "button",
          { type: "button", class: `cs-preset ${p.laserTrail === v ? "active" : ""}` },
          formatLifetime(v),
        );
        b.addEventListener("click", () => s.setPrefs({ laserTrail: v }));
        row.append(b);
      }
      wrap.append(h("span", { class: "cs-label" }, t("Palette.Trail")), row);
      return wrap;
    }
    const current = s.lifetimeFor(mode);
    const row = h("div", { class: "cs-presets" });
    for (const v of LIFETIME_PRESETS) {
      if (v === 0 && (mode === "screen" || !s.can("permanent"))) continue;
      const b = h(
        "button",
        {
          type: "button",
          class: `cs-preset ${current === v ? "active" : ""} ${v === 0 ? "permanent" : ""}`,
          "data-tooltip": v === 0 ? t("Lifetime.PermanentHint") : null,
        },
        v === 0 ? icon("fa-solid fa-thumbtack") : null,
        formatLifetime(v),
      );
      b.addEventListener("click", () => s.setPrefs({ lifetime: { ...p.lifetime, [mode]: v } }));
      row.append(b);
    }
    const input = h("input", {
      type: "text",
      class: "cs-life-input",
      value: current ? formatLifetime(current) : "",
      placeholder: t("Lifetime.Custom"),
      "aria-label": t("Lifetime.Custom"),
      inputmode: "decimal",
    }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const ms = parseLifetime(input.value);
      if (ms === null || (ms === 0 && mode === "screen")) {
        input.classList.add("invalid");
        return;
      }
      s.setPrefs({ lifetime: { ...p.lifetime, [mode]: ms } });
    });
    const fades = h("div", { class: "cs-presets" });
    for (const v of FADE_PRESETS) {
      const b = h(
        "button",
        { type: "button", class: `cs-preset ${p.fade[mode] === v ? "active" : ""}` },
        v ? formatLifetime(v) : t("Lifetime.NoFade"),
      );
      b.addEventListener("click", () => s.setPrefs({ fade: { ...p.fade, [mode]: v } }));
      fades.append(b);
    }
    wrap.append(
      h("span", { class: "cs-label" }, tf("Lifetime.For", { mode: t(`Mode.${cap(mode)}.Name`) })),
      row,
      input,
      h("span", { class: "cs-label" }, t("Lifetime.Fade")),
      fades,
    );
    if (mode === "map" && !s.can("permanent")) wrap.append(h("p", { class: "cs-hint" }, t("Lifetime.NoPermanent")));
    return wrap;
  }

  #layerMenu(): HTMLElement {
    const s = this.#session;
    const p = s.prefs;
    const permanent = s.lifetimeFor("map") === 0;
    const current = permanent ? p.layer.permanent : p.layer.temporary;
    const list = h("div", { class: "cs-menu" });
    list.append(h("span", { class: "cs-label" }, t(permanent ? "Layer.ForPermanent" : "Layer.ForTemporary")));
    for (const layer of ["below", "above", "top"] as const) {
      const b = h(
        "button",
        {
          type: "button",
          class: `cs-menu-item ${current === layer ? "active" : ""}`,
          "aria-pressed": String(current === layer),
        },
        icon(LAYER_ICON[layer]),
        h(
          "span",
          { class: "cs-item-text" },
          h("strong", {}, t(`Layer.${cap(layer)}.Name`)),
          h("small", {}, t(`Layer.${cap(layer)}.Hint`)),
        ),
      );
      b.addEventListener("click", () => {
        s.setPrefs({ layer: { ...p.layer, [permanent ? "permanent" : "temporary"]: layer } });
        Popover.closeAll();
      });
      list.append(b);
    }
    return list;
  }

  destroy(): void {
    this.#off();
    Popover.closeAll();
    this.element.remove();
  }
}
