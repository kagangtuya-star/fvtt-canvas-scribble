import { stats } from "../render/stats.ts";
import type { SceneRenderer } from "../render/renderer.ts";
import type { Session } from "../session.ts";
import { userColor } from "../foundry/compat.ts";
import { h } from "./dom.ts";

/**
 * Name tags next to other users' strokes while they draw, and the debug
 * panel (client setting). Both are plain DOM above the canvas.
 */
export class NameTags {
  readonly #root: HTMLElement;
  readonly #tags = new Map<string, HTMLElement>();
  readonly #session: Session;

  constructor(session: Session) {
    this.#session = session;
    this.#root = h("div", { id: "canvas-scribble-names", "aria-hidden": "true" });
    document.body.append(this.#root);
  }

  /** Called every frame by the renderer. */
  update(enabled: boolean, hidden: boolean): void {
    const s = this.#session;
    const seen = new Set<string>();
    if (enabled && !hidden) {
      for (const entry of s.store.values()) {
        const item = entry.item;
        if (entry.state !== "live" || item.author === game.user.id || item.points.length < 3) continue;
        const space = s.space(item.mode);
        if (!space) continue;
        const n = item.points.length;
        const p = space.toClient(item.points[n - 3]!, item.points[n - 2]!, item.anchor);
        let tag = this.#tags.get(item.id);
        if (!tag) {
          const user = game.users.get(item.author);
          tag = h("span", { class: "cs-name", style: `--cs-color:${userColor(user)}` }, user?.name ?? "?");
          this.#root.append(tag);
          this.#tags.set(item.id, tag);
        }
        tag.style.transform = `translate(${Math.round(p.x + 10)}px, ${Math.round(p.y + 10)}px)`;
        seen.add(item.id);
      }
    }
    for (const [id, tag] of this.#tags) {
      if (seen.has(id)) continue;
      tag.remove();
      this.#tags.delete(id);
    }
  }

  destroy(): void {
    this.#root.remove();
    this.#tags.clear();
  }
}

export class DebugPanel {
  readonly #el: HTMLElement;
  readonly #session: Session;
  #renderer: SceneRenderer | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #frames = 0;
  #frameMs = 0;
  #tier = 0;
  #worst = 0;

  constructor(session: Session) {
    this.#session = session;
    this.#el = h("pre", { id: "canvas-scribble-debug", "aria-live": "off" });
  }

  attach(renderer: SceneRenderer | null): void {
    this.#renderer = renderer;
  }

  frame(info: { tier: number; ms: number }): void {
    this.#frames++;
    this.#frameMs += info.ms;
    this.#worst = Math.max(this.#worst, info.ms);
    this.#tier = info.tier;
  }

  show(on: boolean): void {
    if (on && !this.#timer) {
      document.body.append(this.#el);
      this.#timer = setInterval(() => this.#paint(), 500);
      this.#paint();
    } else if (!on && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
      this.#el.remove();
    }
  }

  #paint(): void {
    const s = this.#session;
    const r = this.#renderer?.debugInfo() ?? {};
    const avg = this.#frames ? this.#frameMs / this.#frames : 0;
    const counts: Record<string, number> = {};
    for (const e of s.store.values()) counts[e.state] = (counts[e.state] ?? 0) + 1;
    const lines = [
      `CanvasScribble debug`,
      `scene     ${s.scene?.name ?? "-"}  relay:${s.isRelay ? "me" : "other"}`,
      `items     ${
        Object.entries(counts)
          .map(([k, v]) => `${k}:${v}`)
          .join(" ") || "0"
      }`,
      `render    avg ${avg.toFixed(2)}ms  max ${this.#worst.toFixed(2)}ms  tier ${this.#tier}`,
      `display   tiles:${r.tiles ?? 0} stored:${r.stored ?? 0} sprites:${r.sprites ?? 0} lasers:${r.lasers ?? 0}`,
      `textures  ${stats.textures}  ${((stats.texturePixels * 4) / 1048576).toFixed(1)} MB  builds:${stats.tileBuilds} rasters:${stats.itemRasters}`,
      `socket    in:${stats.socketIn} (${(stats.socketInBytes / 1024).toFixed(1)} KB)  out:${stats.socketOut} (${(stats.socketOutBytes / 1024).toFixed(1)} KB)  dropped:${stats.dropped}`,
      `history   undo:${s.history.size.undo} redo:${s.history.size.redo}`,
    ];
    this.#el.textContent = lines.join("\n");
    this.#frames = 0;
    this.#frameMs = 0;
    this.#worst = 0;
  }
}
