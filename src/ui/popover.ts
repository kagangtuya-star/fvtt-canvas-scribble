import { h, themeClass } from "./dom.ts";

/**
 * A small floating panel anchored to a button (one open at a time). Closes
 * on outside pointerdown, Escape, or when the anchor disappears.
 */
let current: Popover | null = null;

export class Popover {
  readonly element: HTMLElement;
  readonly #anchor: HTMLElement;
  readonly #onClose: (() => void) | null;
  readonly #outside = (e: PointerEvent) => {
    const t = e.target as Node | null;
    if (t && (this.element.contains(t) || this.#anchor.contains(t))) return;
    this.close();
  };
  readonly #key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    e.preventDefault();
    this.close();
    this.#anchor.focus?.();
  };

  constructor(
    anchor: HTMLElement,
    content: HTMLElement,
    opts: { className?: string; onClose?: () => void; label?: string } = {},
  ) {
    current?.close();
    current = this;
    this.#anchor = anchor;
    this.#onClose = opts.onClose ?? null;
    this.element = h("div", {
      class: `cs-popover themed ${themeClass()} ${opts.className ?? ""}`.trim(),
      role: "dialog",
      "aria-label": opts.label ?? null,
    });
    this.element.append(content);
    document.body.append(this.element);
    anchor.setAttribute("aria-expanded", "true");
    this.position();
    window.addEventListener("pointerdown", this.#outside, true);
    window.addEventListener("keydown", this.#key, true);
  }

  static get open(): Popover | null {
    return current;
  }

  static closeAll(): void {
    current?.close();
  }

  isFor(anchor: HTMLElement): boolean {
    return this.#anchor === anchor;
  }

  /** Place above the anchor (below when there is no room), clamped to the viewport. */
  position(): void {
    const a = this.#anchor.getBoundingClientRect();
    const el = this.element;
    el.style.left = "0px";
    el.style.top = "0px";
    const r = el.getBoundingClientRect();
    const margin = 8;
    let left = a.left + a.width / 2 - r.width / 2;
    left = Math.max(margin, Math.min(window.innerWidth - r.width - margin, left));
    let top = a.top - r.height - 8;
    let below = false;
    if (top < margin) {
      top = a.bottom + 8;
      below = true;
    }
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.classList.toggle("below", below);
  }

  close(): void {
    if (current === this) current = null;
    window.removeEventListener("pointerdown", this.#outside, true);
    window.removeEventListener("keydown", this.#key, true);
    this.#anchor.setAttribute("aria-expanded", "false");
    this.element.remove();
    this.#onClose?.();
  }
}

/** Toggle a popover for an anchor: closes it when it is already open. */
export function togglePopover(
  anchor: HTMLElement,
  build: () => HTMLElement,
  opts?: ConstructorParameters<typeof Popover>[2],
): Popover | null {
  if (current?.isFor(anchor)) {
    current.close();
    return null;
  }
  return new Popover(anchor, build(), opts);
}
