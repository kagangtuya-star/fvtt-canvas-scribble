import { LIMITS } from "../constants.ts";
import { TEXT_FONT, TEXT_LINE_HEIGHT } from "../brush/paint.ts";
import { t } from "../i18n.ts";
import type { Session, TextRequest } from "../session.ts";
import { h } from "./dom.ts";

/**
 * Inline text entry for the Text tool: a borderless textarea at the click
 * point, styled like the result. Enter commits, Shift+Enter adds a line,
 * Escape cancels, clicking elsewhere commits.
 */
export class TextEditor {
  readonly #session: Session;
  #open: { el: HTMLTextAreaElement; req: TextRequest } | null = null;

  constructor(session: Session) {
    this.#session = session;
  }

  open(req: TextRequest): void {
    this.commit();
    const space = req.target.space;
    const px = req.size * space.cssPerUnit();
    const el = h("textarea", {
      class: "cs-text-input",
      rows: 1,
      maxlength: LIMITS.maxTextLength,
      placeholder: t("Text.Placeholder"),
      "aria-label": t("Tools.Text"),
      spellcheck: "false",
      style: [
        `left:${req.cx}px`,
        `top:${req.cy}px`,
        `font: 600 ${px}px/${TEXT_LINE_HEIGHT} ${TEXT_FONT}`,
        `color:${req.color}`,
        `--cs-color:${req.color}`,
      ].join(";"),
    }) as HTMLTextAreaElement;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
      el.style.width = "auto";
      el.style.width = `${Math.max(px * 4, Math.min(window.innerWidth - req.cx - 16, el.scrollWidth + px))}px`;
    };
    el.addEventListener("input", fit);
    el.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep Foundry keybindings out of the editor
      if (e.key === "Escape") {
        e.preventDefault();
        this.cancel();
      } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.commit();
      }
    });
    el.addEventListener("blur", () => setTimeout(() => this.commit(), 0));
    document.body.append(el);
    this.#open = { el, req };
    fit();
    requestAnimationFrame(() => el.focus());
  }

  get isOpen(): boolean {
    return !!this.#open;
  }

  commit(): void {
    const o = this.#open;
    if (!o) return;
    this.#open = null;
    const text = o.el.value;
    o.el.remove();
    if (text.trim()) this.#session.commitText(o.req, text);
  }

  cancel(): void {
    const o = this.#open;
    if (!o) return;
    this.#open = null;
    o.el.remove();
  }
}
