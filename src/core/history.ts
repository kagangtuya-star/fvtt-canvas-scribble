import { LIMITS } from "../constants.ts";
import type { ScribbleItem } from "./types.ts";

/**
 * Per-user undo/redo (command pattern). Each command records only the items
 * it touched — never snapshots of the whole scene — and its inverse is
 * applied through a {@link HistoryExecutor}, which routes the change to the
 * right place (local store, socket, GM write for permanent items).
 *
 * History is local to one client and one user, so Ctrl+Z only ever reverts
 * your own operations; an executor refuses operations the user may not do.
 */
export type Command =
  | { type: "create"; items: ScribbleItem[] }
  | { type: "delete"; items: ScribbleItem[] }
  | { type: "update"; before: ScribbleItem[]; after: ScribbleItem[] };

export interface HistoryExecutor {
  /** Re-create items exactly as recorded (ids, authors, timing). */
  restore(items: ScribbleItem[]): void;
  remove(items: ScribbleItem[]): void;
  replace(items: ScribbleItem[]): void;
  /** Can this item still be shown (not expired, same scene)? */
  usable(item: ScribbleItem): boolean;
}

export class History {
  readonly #undo: Command[] = [];
  readonly #redo: Command[] = [];
  readonly #limit: number;

  constructor(limit: number = LIMITS.maxHistory) {
    this.#limit = limit;
  }

  record(cmd: Command): void {
    if (cmd.type !== "update" && cmd.items.length === 0) return;
    this.#undo.push(cmd);
    if (this.#undo.length > this.#limit) this.#undo.shift();
    this.#redo.length = 0;
  }

  clear(): void {
    this.#undo.length = 0;
    this.#redo.length = 0;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  get size(): { undo: number; redo: number } {
    return { undo: this.#undo.length, redo: this.#redo.length };
  }

  /** Undo the newest command that still refers to usable items. Returns the applied command. */
  undo(exec: HistoryExecutor): Command | null {
    while (this.#undo.length) {
      const cmd = this.#undo.pop()!;
      if (!this.#apply(cmd, exec, true)) continue; // stale (e.g. expired temporary items): skip it
      this.#redo.push(cmd);
      return cmd;
    }
    return null;
  }

  redo(exec: HistoryExecutor): Command | null {
    while (this.#redo.length) {
      const cmd = this.#redo.pop()!;
      if (!this.#apply(cmd, exec, false)) continue;
      this.#undo.push(cmd);
      return cmd;
    }
    return null;
  }

  /** Drop commands whose items are all unusable (expired). */
  prune(exec: HistoryExecutor): void {
    const live = (c: Command) =>
      (c.type === "update" ? c.after : c.items).some((i) => exec.usable(i)) || c.type === "delete";
    for (const stack of [this.#undo, this.#redo]) {
      for (let i = stack.length - 1; i >= 0; i--) if (!live(stack[i]!)) stack.splice(i, 1);
    }
  }

  #apply(cmd: Command, exec: HistoryExecutor, inverse: boolean): boolean {
    switch (cmd.type) {
      case "create": {
        const items = cmd.items.filter((i) => exec.usable(i));
        if (!items.length) return false;
        if (inverse) exec.remove(items);
        else exec.restore(items);
        return true;
      }
      case "delete": {
        const items = cmd.items.filter((i) => exec.usable(i));
        if (!items.length) return false;
        if (inverse) exec.restore(items);
        else exec.remove(items);
        return true;
      }
      case "update": {
        const target = inverse ? cmd.before : cmd.after;
        const items = target.filter((i) => exec.usable(i));
        if (!items.length) return false;
        exec.replace(items);
        return true;
      }
    }
  }
}
