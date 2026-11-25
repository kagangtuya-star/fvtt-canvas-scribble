import { MODULE_ID } from "../constants.ts";
import { DEFAULT_THRESHOLDS, ROLES } from "../core/permissions.ts";
import type { PermissionThresholds } from "../core/permissions.ts";
import { k } from "../i18n.ts";
import { normalizePrefs } from "../state/prefs.ts";
import type { Prefs } from "../state/prefs.ts";

/**
 * Module settings.
 *
 * World (GM): role thresholds, the per-scene storage budget, fog policy.
 * Client: pen pressure, map size behaviour, palette visibility, confirmation,
 * debug overlay, plus the hidden tool preferences.
 */

export const SETTING = {
  permScreen: "permScreen",
  permMap: "permMap",
  permPermanent: "permPermanent",
  permManage: "permManage",
  budget: "storageBudgetKB",
  playerFog: "playerFog",
  pressure: "pressure",
  followZoom: "followZoom",
  palette: "palette",
  confirmOwnClear: "confirmOwnClear",
  showNames: "showNames",
  debug: "debug",
  prefs: "prefs",
} as const;

export type PressureSetting = "auto" | "simulate" | "never";
export type PaletteSetting = "auto" | "always" | "never";

const roleChoices = (): Record<number, string> => ({
  [ROLES.PLAYER]: "USER.RolePlayer",
  [ROLES.TRUSTED]: "USER.RoleTrusted",
  [ROLES.ASSISTANT]: "USER.RoleAssistant",
  [ROLES.GAMEMASTER]: "USER.RoleGamemaster",
});

type Listener = () => void;
const listeners = new Set<Listener>();

/** Notify on any setting change of this module (UI refresh). */
export function onSettingsChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const changed = () => {
  for (const fn of listeners) fn();
};

export function registerSettings(): void {
  const reg = (key: string, config: FoundrySettingConfig) => game.settings.register(MODULE_ID, key, config);
  const role = (key: string, label: string, def: number) =>
    reg(key, {
      name: k(`Settings.${label}.Name`),
      hint: k(`Settings.${label}.Hint`),
      scope: "world",
      config: true,
      type: Number,
      choices: roleChoices(),
      default: def,
      onChange: changed,
    });
  role(SETTING.permScreen, "PermScreen", DEFAULT_THRESHOLDS.screen);
  role(SETTING.permMap, "PermMap", DEFAULT_THRESHOLDS.map);
  role(SETTING.permPermanent, "PermPermanent", DEFAULT_THRESHOLDS.permanent);
  role(SETTING.permManage, "PermManage", DEFAULT_THRESHOLDS.manage);
  reg(SETTING.budget, {
    name: k("Settings.Budget.Name"),
    hint: k("Settings.Budget.Hint"),
    scope: "world",
    config: true,
    type: Number,
    range: { min: 128, max: 8192, step: 128 },
    default: 1024,
    onChange: changed,
  });
  reg(SETTING.playerFog, {
    name: k("Settings.PlayerFog.Name"),
    hint: k("Settings.PlayerFog.Hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: changed,
  });
  reg(SETTING.pressure, {
    name: k("Settings.Pressure.Name"),
    hint: k("Settings.Pressure.Hint"),
    scope: "client",
    config: true,
    type: String,
    choices: {
      auto: k("Settings.Pressure.Auto"),
      simulate: k("Settings.Pressure.Simulate"),
      never: k("Settings.Pressure.Never"),
    },
    default: "auto",
    onChange: changed,
  });
  reg(SETTING.followZoom, {
    name: k("Settings.FollowZoom.Name"),
    hint: k("Settings.FollowZoom.Hint"),
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: changed,
  });
  reg(SETTING.palette, {
    name: k("Settings.Palette.Name"),
    hint: k("Settings.Palette.Hint"),
    scope: "client",
    config: true,
    type: String,
    choices: {
      auto: k("Settings.Palette.Auto"),
      always: k("Settings.Palette.Always"),
      never: k("Settings.Palette.Never"),
    },
    default: "auto",
    onChange: changed,
  });
  reg(SETTING.confirmOwnClear, {
    name: k("Settings.ConfirmOwnClear.Name"),
    hint: k("Settings.ConfirmOwnClear.Hint"),
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: changed,
  });
  reg(SETTING.showNames, {
    name: k("Settings.ShowNames.Name"),
    hint: k("Settings.ShowNames.Hint"),
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: changed,
  });
  reg(SETTING.debug, {
    name: k("Settings.Debug.Name"),
    hint: k("Settings.Debug.Hint"),
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: changed,
  });
  reg(SETTING.prefs, {
    scope: "client",
    config: false,
    type: Object,
    default: {},
  });
}

const get = (key: string): unknown => {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch {
    return undefined;
  }
};

export function thresholds(): PermissionThresholds {
  const n = (key: string, def: number) => {
    const v = Number(get(key));
    return Number.isFinite(v) && v >= ROLES.PLAYER ? v : def;
  };
  return {
    screen: n(SETTING.permScreen, DEFAULT_THRESHOLDS.screen),
    map: n(SETTING.permMap, DEFAULT_THRESHOLDS.map),
    permanent: n(SETTING.permPermanent, DEFAULT_THRESHOLDS.permanent),
    manage: n(SETTING.permManage, DEFAULT_THRESHOLDS.manage),
  };
}

export const budgetBytes = (): number => Math.max(128, Number(get(SETTING.budget)) || 1024) * 1024;
export const playerFog = (): boolean => get(SETTING.playerFog) === true;
export const pressureSetting = (): PressureSetting => (get(SETTING.pressure) as PressureSetting) ?? "auto";
export const followZoom = (): boolean => get(SETTING.followZoom) === true;
export const paletteSetting = (): PaletteSetting => (get(SETTING.palette) as PaletteSetting) ?? "auto";
export const confirmOwnClear = (): boolean => get(SETTING.confirmOwnClear) === true;
export const showNames = (): boolean => get(SETTING.showNames) !== false;
export const debugEnabled = (): boolean => get(SETTING.debug) === true;

export function loadPrefs(): Prefs {
  return normalizePrefs(get(SETTING.prefs));
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Persist preferences (debounced: sliders and wheel resizing fire often). */
export function savePrefs(prefs: Prefs): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void game.settings.set(MODULE_ID, SETTING.prefs, prefs).catch(() => undefined);
  }, 400);
}
