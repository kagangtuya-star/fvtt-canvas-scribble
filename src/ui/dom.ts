/** Tiny DOM helpers (no framework: the UI is a handful of compact controls). */

type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value as EventListener);
    else if (key === "class") el.className = String(value);
    else if (key === "style") el.setAttribute("style", String(value));
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

export const icon = (cls: string): HTMLElement => h("i", { class: cls, "aria-hidden": "true", inert: true });

/** A compact icon button styled like Foundry's `.ui-control`. */
export function iconButton(
  cls: string,
  label: string,
  onClick: (e: MouseEvent) => void,
  opts: { pressed?: boolean; disabled?: boolean; extra?: string; data?: Record<string, string> } = {},
): HTMLButtonElement {
  const b = h("button", {
    type: "button",
    class: `ui-control icon cs-btn ${opts.extra ?? ""}`.trim(),
    "aria-label": label,
    "data-tooltip": label,
    "aria-pressed": opts.pressed === undefined ? null : String(opts.pressed),
    disabled: opts.disabled ?? false,
  });
  for (const [k, v] of Object.entries(opts.data ?? {})) b.dataset[k] = v;
  b.append(icon(cls));
  b.addEventListener("click", (e) => {
    e.preventDefault();
    onClick(e);
  });
  return b;
}

/** Foundry v13 interface theme of the page (`theme-dark` default). */
export function themeClass(): string {
  const b = document.body.classList;
  return b.contains("theme-light") ? "theme-light" : "theme-dark";
}
