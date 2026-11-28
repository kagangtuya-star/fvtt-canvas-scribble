/**
 * Every version-dependent call goes through this file (see docs/COMPATIBILITY.md).
 * Supported: Foundry VTT v13 and v14.
 */

/** Major version ("generation") of the running core. */
export function generation(): number {
  return game.release?.generation ?? Number.parseInt(String(game.version ?? "13"), 10);
}

/**
 * Update data that deletes `key` from the object at `path`.
 * v14 deprecates the `-=` key prefix in favour of the `_del` operator.
 */
export function deletion(path: string, key: string): Record<string, unknown> {
  const del = (globalThis as { _del?: unknown })._del;
  if (del !== undefined && generation() >= 14) return { [`${path}.${key}`]: del };
  return { [`${path}.-=${key}`]: null };
}

/** Id of the scene level being viewed (v14 scene levels), or `undefined`. */
export function viewedLevel(): string | undefined {
  const level = (canvas as { level?: { id?: string } | null }).level;
  return typeof level?.id === "string" ? level.id : undefined;
}

/** The InteractionLayer base class. */
export function interactionLayerClass(): InteractionLayerClass {
  return foundry.canvas.layers.InteractionLayer;
}

/** The core user role constants. */
export function userRoles(): { PLAYER: number; TRUSTED: number; ASSISTANT: number; GAMEMASTER: number } {
  return CONST.USER_ROLES;
}

/** A user's colour as `#rrggbb`. */
export function userColor(user: FoundryUser | undefined): string {
  const c = user?.color;
  const text = typeof c === "string" ? c : (c?.css ?? c?.toString?.() ?? "");
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : "#e0483e";
}

/** Whether a user is the active GM who performs Scene writes for others. */
export function activeGM(): FoundryUser | null {
  return game.users.activeGM ?? null;
}

/** Confirmation dialog (DialogV2 in both v13 and v14). Resolves `false` when dismissed. */
export async function confirm(title: string, content: string, yesLabel: string): Promise<boolean> {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2) return window.confirm(`${title}\n\n${content.replace(/<[^>]+>/g, "")}`);
  try {
    const result = await DialogV2.confirm({
      window: { title, icon: "fa-solid fa-triangle-exclamation" },
      content,
      rejectClose: false,
      modal: true,
      yes: { label: yesLabel, icon: "fa-solid fa-trash", default: false },
      no: { default: true },
    });
    return result === true;
  } catch {
    return false;
  }
}

/** Escape text for HTML templates. */
export function escapeHTML(text: string): string {
  const esc = foundry.utils?.escapeHTML;
  if (esc) return esc(text);
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Whether a v13+ scene-controls record API is present (`getSceneControlButtons` gets an object). */
export function controlsAreRecord(controls: unknown): controls is Record<string, unknown> {
  return !!controls && typeof controls === "object" && !Array.isArray(controls);
}

/** Map a CanvasScribble blend mode to the active PIXI version's Sprite `blendMode`. */
export function pixiBlendMode(blend: "normal" | "multiply" | "screen" | "overlay" | "lighter"): number | string {
  const bm = (globalThis as { PIXI?: { BLEND_MODES?: Record<string, number> } }).PIXI?.BLEND_MODES;
  if (bm) {
    switch (blend) {
      case "multiply":
        return bm.MULTIPLY ?? 2;
      case "screen":
        return bm.SCREEN ?? 3;
      case "overlay":
        return bm.OVERLAY ?? bm.NORMAL ?? 0;
      case "lighter":
        return bm.ADD ?? 1;
      default:
        return bm.NORMAL ?? 0;
    }
  }
  // PIXI v8 string blend modes
  return blend === "lighter" ? "add" : blend;
}

/** The FilePicker API (`foundry.applications.apps.FilePicker` in v13/v14; the v12 global as a fallback). */
export function filePicker(): FilePickerStatic | null {
  const fp = foundry.applications?.apps?.FilePicker;
  const impl = fp?.implementation ?? fp ?? (globalThis as { FilePicker?: FilePickerStatic }).FilePicker;
  return impl && typeof impl.upload === "function" ? impl : null;
}

/** Id of the running world (bake files live under `worlds/<id>/`). */
export function worldId(): string | null {
  const id = game.world?.id;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

/** URL of a file in the user data folder (honours a route prefix). */
export function dataUrl(path: string): string {
  const route = foundry.utils?.getRoute;
  return route ? route(path) : `/${path}`;
}

/**
 * Read one physical pixel of the next completed screen frame (PIXI 7 in v13/v14).
 * Reading inside postrender also works with preserveDrawingBuffer disabled.
 * Never extract primary or individual objects: that would bypass fog and composition.
 */
export function sampleCanvasPixel(
  cx: number,
  cy: number,
  signal?: AbortSignal,
): Promise<Uint8Array | Uint8ClampedArray | null> {
  const board = (globalThis as { canvas?: FoundryCanvas }).canvas;
  const app = board?.app;
  const renderer = app?.renderer;
  if (!board?.ready || !app || !renderer?.on || !renderer.off || signal?.aborted) return Promise.resolve(null);
  const scene = board.scene;
  const level = board.level?.id;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (pixel: Uint8Array | Uint8ClampedArray | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      renderer.off!("postrender", onRender);
      signal?.removeEventListener("abort", onAbort);
      resolve(pixel);
    };
    const onAbort = () => finish(null);
    const onRender = () => {
      if (
        (globalThis as { canvas?: FoundryCanvas }).canvas !== board ||
        !board.ready ||
        board.app !== app ||
        board.scene !== scene ||
        board.level?.id !== level
      ) {
        finish(null);
        return;
      }
      // Foundry also renders offscreen textures; those are not the displayed frame.
      if (renderer.renderingToScreen !== true) return;
      try {
        const view = app.view;
        const rect = view.getBoundingClientRect();
        if (
          !Number.isFinite(cx) ||
          !Number.isFinite(cy) ||
          rect.width <= 0 ||
          rect.height <= 0 ||
          view.width <= 0 ||
          view.height <= 0 ||
          cx < rect.left ||
          cy < rect.top ||
          cx >= rect.right ||
          cy >= rect.bottom
        ) {
          finish(null);
          return;
        }
        const px = Math.floor(((cx - rect.left) * view.width) / rect.width);
        const py = Math.floor(((cy - rect.top) * view.height) / rect.height);
        if (renderer.gl) {
          const res = renderer.resolution;
          if (renderer.gl.isContextLost() || !Number.isFinite(res) || res <= 0 || !renderer.extract) {
            finish(null);
            return;
          }
          // Extract's screen frame uses logical units and a bottom-left GL origin.
          // It binds the screen framebuffer and unpremultiplies alpha for us.
          const frame = new PIXI.Rectangle(px / res, (view.height - 1 - py) / res, 1 / res, 1 / res);
          finish(renderer.extract.pixels(undefined, frame));
        } else {
          // Canvas2D harness: getImageData uses physical pixels and a top-left origin.
          finish(view.getContext("2d")?.getImageData(px, py, 1, 1).data ?? null);
        }
      } catch {
        finish(null);
      }
    };
    // Paused rendering, a lost context or a background tab must not leave a pending pick.
    const timer = setTimeout(() => finish(null), 2000);
    signal?.addEventListener("abort", onAbort, { once: true });
    renderer.on!("postrender", onRender);
  });
}
