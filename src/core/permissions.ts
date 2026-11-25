/**
 * Role-based permissions. The thresholds are world settings (GM-only); every
 * client evaluates them for the *authenticated* sender of a message, never
 * for a role or user id claimed inside a payload.
 */

/** Foundry `CONST.USER_ROLES`. */
export const ROLES = { NONE: 0, PLAYER: 1, TRUSTED: 2, ASSISTANT: 3, GAMEMASTER: 4 } as const;

export type Action =
  /** Temporary drawing in screen space. */
  | "screen"
  /** Temporary drawing in map space. */
  | "map"
  /** Permanent map annotations (stored in the Scene). */
  | "permanent"
  /** Erase/clear other users' items. */
  | "manage";

export type PermissionThresholds = Record<Action, number>;

export const DEFAULT_THRESHOLDS: PermissionThresholds = {
  screen: ROLES.PLAYER,
  map: ROLES.PLAYER,
  permanent: ROLES.TRUSTED,
  manage: ROLES.ASSISTANT,
};

export function allowed(role: number, action: Action, thresholds: PermissionThresholds): boolean {
  if (role >= ROLES.GAMEMASTER) return true;
  const min = thresholds[action] ?? DEFAULT_THRESHOLDS[action];
  return role >= Math.max(ROLES.PLAYER, min);
}

/** May `actor` remove/modify an item authored by `author`? */
export function mayModify(
  actorId: string,
  actorRole: number,
  author: string,
  thresholds: PermissionThresholds,
): boolean {
  return actorId === author || allowed(actorRole, "manage", thresholds);
}
