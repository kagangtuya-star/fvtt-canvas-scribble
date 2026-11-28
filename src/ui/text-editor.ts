import { LIMITS } from "../constants.ts";
import { layoutText, TEXT_FONT, TEXT_LINE_HEIGHT } from "../core/text-layout.ts";
import { t } from "../i18n.ts";
import type { Session, TextRequest } from "../session.ts";
import { h, iconButton } from "./dom.ts";

/** Native caret, selection and IME while editing; canonical items change only on commit. */
export class TextEditor {
  readonly #session: Session;
  #open: {
    el: HTMLTextAreaElement;
    root: HTMLElement;
    viewport: HTMLElement;
    surface: HTMLElement;
    req: TextRequest;
    width?: number;
    stopResize?: () => void;
  } | null = null;

  constructor(session: Session) {
    this.#session = session;
    // Registered before PointerInput, so an outside click commits before selecting/drawing.
    window.addEventListener(
      "pointerdown",
      (e) => {
        const o = this.#open;
        if (!o || o.root.contains(e.target as Node)) return;
        if (!this.commit()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          o.el.focus();
        }
      },
      true,
    );
  }

  open(req: TextRequest): void {
    if (!this.commit()) return;
    const el = h("textarea", {
      class: "cs-text-input",
      rows: 1,
      maxlength: LIMITS.maxTextLength,
      placeholder: t("Text.Placeholder"),
      "aria-label": t("Tools.Text"),
      "aria-description": t("Text.Hint"),
      spellcheck: "false",
    });
    el.value = req.original?.text ?? "";
    const surface = h("div", { class: "cs-text-surface" }, el);
    const viewport = h("div", { class: "cs-text-viewport" }, surface);
    const resize = h("div", { class: "cs-text-resize", "data-tooltip": t("Text.Resize") });
    const actions = h(
      "div",
      { class: "cs-text-actions" },
      iconButton("fa-solid fa-check", t("Text.Done"), () => this.commit()),
      iconButton("fa-solid fa-xmark", t("Text.Cancel"), () => this.cancel()),
      iconButton("fa-solid fa-arrows-left-right", t("Text.AutoWidth"), () => {
        if (this.#open) this.#open.width = undefined;
        this.refresh();
        el.focus();
      }),
    );
    const root = h("div", { class: "cs-text-editor", style: `--cs-color:${req.color}` }, viewport, resize, actions);
    el.addEventListener("input", () => this.refresh());
    el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        this.cancel();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.commit();
      }
    });
    el.addEventListener("blur", () => {
      setTimeout(() => {
        if (this.#open?.el === el && !root.contains(document.activeElement) && !this.#open.stopResize) this.commit();
      }, 0);
    });
    resize.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const o = this.#open;
      if (!o) return;
      e.preventDefault();
      const start = e.clientX;
      const width = o.width ?? layoutText({ text: el.value, size: req.size }).width;
      const unit = this.#space(req).cssPerUnit();
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        o.width = Math.max(
          1,
          Math.min(req.target.mode === "screen" ? 4000 : 100_000, width + (ev.clientX - start) / unit),
        );
        this.refresh();
      };
      const stop = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", up, true);
        o.stopResize = undefined;
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        stop();
        el.focus();
      };
      o.stopResize = stop;
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", up, true);
    });
    document.body.append(root);
    this.#open = { el, root, viewport, surface, req, width: req.original?.textWidth };
    this.#session.setEditingText(req.original?.id ?? null);
    this.refresh();
    requestAnimationFrame(() => {
      if (this.#open?.el === el) el.focus();
    });
  }

  #space(req: TextRequest) {
    return this.#session.space(req.target.mode) ?? req.target.space;
  }

  /** Re-anchor from space coordinates after canvas pan, zoom, resize or font loading. */
  refresh(): void {
    const o = this.#open;
    if (!o) return;
    const { req, el, root, viewport, surface } = o;
    if (this.#session.scene?.id !== req.scene) {
      this.cancel();
      return;
    }
    const space = this.#space(req);
    const pos = space.toClient(req.point.x, req.point.y, req.target.anchor);
    const unit = space.cssPerUnit();
    const unitY = Math.abs(space.toClient(req.point.x, req.point.y + 1, req.target.anchor).y - pos.y);
    const layout = layoutText({ text: el.value, size: req.size, textWidth: o.width });
    const width = o.width === undefined ? Math.max(layout.width, req.size * 2) + 2 / unit : layout.width;
    root.style.left = `${pos.x}px`;
    root.style.top = `${pos.y}px`;
    // Lay out at the exact same font size/width as Canvas, then transform the result.
    // Measuring a scaled font can change fallback emoji metrics and wrapping thresholds.
    el.style.font = `600 ${req.size}px/${TEXT_LINE_HEIGHT} ${TEXT_FONT}`;
    el.style.transform = `scale(${unit}, ${unitY})`;
    el.style.color = req.color;
    el.style.opacity = String(req.original?.opacity ?? 1);
    el.wrap = o.width === undefined ? "off" : "soft";
    el.style.whiteSpace = o.width === undefined ? "pre" : "break-spaces";
    el.style.width = `${width}px`;
    el.style.height = `${layout.height}px`;
    const height = Math.max(layout.height, el.scrollHeight);
    el.style.height = `${height}px`;
    surface.style.width = `${width * unit}px`;
    surface.style.height = `${height * unitY}px`;
    // Only the viewport is constrained, never the canonical width or line breaks.
    viewport.style.width = `${Math.min(width * unit, Math.max(40, window.innerWidth - Math.max(0, pos.x) - 16))}px`;
    viewport.style.maxHeight = `${Math.max(req.size * unitY * TEXT_LINE_HEIGHT, window.innerHeight - Math.max(0, pos.y) - 16)}px`;
  }

  get isOpen(): boolean {
    return !!this.#open;
  }

  commit(): boolean {
    const o = this.#open;
    if (!o) return true;
    if (!this.#session.commitText(o.req, o.el.value, o.width)) return false;
    this.cancel();
    return true;
  }

  cancel(): void {
    const o = this.#open;
    if (!o) return;
    this.#open = null;
    o.stopResize?.();
    o.root.remove();
    this.#session.setEditingText(null);
  }
}
