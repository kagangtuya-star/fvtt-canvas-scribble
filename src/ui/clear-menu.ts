import { confirm, escapeHTML } from "../foundry/compat.ts";
import { confirmOwnClear } from "../foundry/settings.ts";
import { t, tf } from "../i18n.ts";
import type { ClearScope } from "../net/protocol.ts";
import type { Session } from "../session.ts";
import { h, icon } from "./dom.ts";
import { Popover, togglePopover } from "./popover.ts";

/**
 * Tiered clearing. Scopes that touch other people's marks or permanent
 * annotations always ask for confirmation; clearing your own temporary
 * marks is instant (and undoable) unless the client setting asks otherwise.
 */

interface ScopeInfo {
  scope: ClearScope;
  icon: string;
  risky: boolean;
}

const SCOPES: ScopeInfo[] = [
  { scope: "mine", icon: "fa-solid fa-user", risky: false },
  { scope: "screen", icon: "fa-solid fa-display", risky: true },
  { scope: "mapTemp", icon: "fa-solid fa-map", risky: true },
  { scope: "allTemp", icon: "fa-solid fa-users", risky: true },
  { scope: "minePermanent", icon: "fa-solid fa-thumbtack", risky: true },
  { scope: "permanent", icon: "fa-solid fa-dumpster", risky: true },
  { scope: "media", icon: "fa-solid fa-paintbrush", risky: true },
];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export async function runClear(session: Session, scope: ClearScope): Promise<void> {
  const info = SCOPES.find((s) => s.scope === scope)!;
  const count = session.clearCount(scope);
  const needsConfirm = info.risky || confirmOwnClear();
  if (needsConfirm) {
    const name = t(`Clear.${cap(scope)}.Name`);
    const body =
      `<p>${escapeHTML(tf("Clear.Confirm", { name, count }))}</p>` +
      (scope === "permanent" || scope === "minePermanent" || scope === "media"
        ? `<p class="notification warning">${escapeHTML(t("Clear.PermanentWarning"))}</p>`
        : "");
    const ok = await confirm(t("Clear.Title"), body, t("Clear.Yes"));
    if (!ok) return;
  }
  const removed = session.clear(scope);
  if (scope === "mine" && removed === 0) session.notify("info", "Clear.NothingMine");
}

export function openClearMenu(session: Session, anchor: HTMLElement | null): void {
  const target = anchor ?? document.getElementById("canvas-scribble-palette") ?? document.body;
  togglePopover(
    target,
    () => {
      const list = h("div", { class: "cs-menu cs-clear" });
      list.append(h("span", { class: "cs-label" }, t("Clear.Title")));
      for (const info of SCOPES) {
        if (!session.mayClear(info.scope)) continue;
        const count = session.clearCount(info.scope);
        const b = h(
          "button",
          {
            type: "button",
            class: `cs-menu-item ${info.risky ? "risky" : ""}`,
            disabled: count === 0 && info.scope !== "permanent",
          },
          icon(info.icon),
          h(
            "span",
            { class: "cs-item-text" },
            h("strong", {}, t(`Clear.${cap(info.scope)}.Name`)),
            h("small", {}, t(`Clear.${cap(info.scope)}.Hint`)),
          ),
          h("span", { class: "cs-count" }, String(count)),
        );
        b.addEventListener("click", () => {
          Popover.closeAll();
          void runClear(session, info.scope);
        });
        list.append(b);
      }
      return list;
    },
    { label: t("Clear.Title"), className: "cs-clear-pop" },
  );
}
