import { I18N_PREFIX } from "./constants.ts";

/** Localize `CANVAS_SCRIBBLE.<key>`; missing keys fall back to the key itself. */
export function t(key: string): string {
  return game.i18n.localize(`${I18N_PREFIX}.${key}`);
}

/** Localize `CANVAS_SCRIBBLE.<key>` with `{placeholders}`. */
export function tf(key: string, data: Record<string, unknown>): string {
  return game.i18n.format(`${I18N_PREFIX}.${key}`, data);
}

/** Full key for settings/keybinding registration (Foundry localizes these itself). */
export const k = (key: string): string => `${I18N_PREFIX}.${key}`;
