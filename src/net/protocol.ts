import type { WireItem } from "../core/types.ts";

/**
 * Socket protocol (`module.canvas-scribble`). Messages are small JSON
 * objects; geometry travels as compact encoded point strings (see
 * core/codec.ts), never as images.
 *
 * The sender's identity is the user id Foundry's server attaches to every
 * relayed message; nothing in a payload identifies its author. Every
 * receiver re-validates permissions, limits and item content.
 *
 *   s  start      live item begins (style, first points)
 *   p  points     live points appended from index `from`
 *   e  end        final canonical item; `persist` asks the GM to store it
 *   x  cancel     live item abandoned
 *   d  delete     items removed (temporary: applied by everyone; stored: by the GM)
 *   u  update     item replaced (partial eraser, undo/redo of erasing)
 *   c  clear      tiered clear (see ClearScope)
 *   q  query      late joiner asks peers for their temporary items
 *   r  reply      a peer's own temporary items, addressed to `to`
 *   n  nack       the GM refused to store an item (budget/permission)
 */

export const PROTOCOL_VERSION = 1;

export type ClearScope =
  /** The sender's own temporary items (screen + map). */
  | "mine"
  /** Everyone's screen items. */
  | "screen"
  /** Everyone's temporary map items. */
  | "mapTemp"
  /** Everyone's temporary items (screen + map). */
  | "allTemp"
  /** The sender's own permanent items in the scene. */
  | "minePermanent"
  /** Every permanent item of the scene. */
  | "permanent";

export const CLEAR_SCOPES: readonly ClearScope[] = [
  "mine",
  "screen",
  "mapTemp",
  "allTemp",
  "minePermanent",
  "permanent",
];

export type NackReason = "permission" | "budget" | "count" | "invalid";

export type Message =
  | { v: number; t: "s"; scene: string; item: WireItem }
  | { v: number; t: "p"; scene: string; id: string; from: number; pts: string }
  | { v: number; t: "e"; scene: string; item: WireItem; persist?: boolean }
  | { v: number; t: "x"; scene: string; id: string }
  | { v: number; t: "d"; scene: string; ids: string[] }
  | { v: number; t: "u"; scene: string; item: WireItem }
  | { v: number; t: "c"; scene: string; scope: ClearScope }
  | { v: number; t: "q"; scene: string }
  | { v: number; t: "r"; scene: string; to: string; items: WireItem[] }
  | { v: number; t: "n"; scene: string; to: string; id: string; reason: NackReason };

export type MessageType = Message["t"];

const ID = /^[A-Za-z0-9_-]{1,32}$/;
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Upper bound for a single raw message (characters of JSON). */
export const MAX_MESSAGE_CHARS = 256 * 1024;
/** Items in one `r` reply / ids in one `d` delete. */
export const MAX_BATCH = 200;

/**
 * Structural validation of an inbound payload. Item contents are checked
 * separately by `sanitizeItem`; this only guarantees the envelope's shape.
 */
export function parseMessage(raw: unknown): Message | null {
  if (!isObj(raw) || raw.v !== PROTOCOL_VERSION || !isId(raw.scene)) return null;
  switch (raw.t) {
    case "s":
    case "u":
      return isObj(raw.item) ? (raw as unknown as Message) : null;
    case "e":
      if (!isObj(raw.item)) return null;
      return {
        v: PROTOCOL_VERSION,
        t: "e",
        scene: raw.scene,
        item: raw.item as unknown as WireItem,
        persist: raw.persist === true,
      };
    case "p":
      return isId(raw.id) && Number.isInteger(raw.from) && (raw.from as number) >= 0 && typeof raw.pts === "string"
        ? (raw as unknown as Message)
        : null;
    case "x":
      return isId(raw.id) ? (raw as unknown as Message) : null;
    case "d":
      return Array.isArray(raw.ids) && raw.ids.length <= MAX_BATCH && raw.ids.every(isId)
        ? (raw as unknown as Message)
        : null;
    case "c":
      return CLEAR_SCOPES.includes(raw.scope as ClearScope) ? (raw as unknown as Message) : null;
    case "q":
      return raw as unknown as Message;
    case "r":
      return isId(raw.to) && Array.isArray(raw.items) && raw.items.length <= MAX_BATCH
        ? (raw as unknown as Message)
        : null;
    case "n":
      return isId(raw.to) && isId(raw.id) && typeof raw.reason === "string" ? (raw as unknown as Message) : null;
    default:
      return null;
  }
}

/** Rate-limit cost of a message: [messages, points, items]. */
export function messageCost(msg: Message): [number, number, number] {
  switch (msg.t) {
    case "p":
      return [1, Math.ceil(msg.pts.length / 6), 0];
    case "s":
    case "e":
    case "u":
      return [1, Math.ceil(String(msg.item.points ?? "").length / 6), 1];
    case "r":
      return [1, msg.items.reduce((n, i) => n + Math.ceil(String(i?.points ?? "").length / 6), 0), msg.items.length];
    case "d":
      return [1, 0, Math.ceil(msg.ids.length / 10)];
    default:
      return [1, 0, 0];
  }
}
