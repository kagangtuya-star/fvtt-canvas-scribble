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
