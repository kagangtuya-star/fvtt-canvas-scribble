import type { WireItem } from "../core/types.ts";
import type { WireStroke } from "../media/ops.ts";

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
 *   p  points     live points replacing the tail from index `from`
 *   b  batch      live starts, snapshots and points sharing one envelope
 *   e  end        final canonical item; `persist` asks the GM to store it
 *   x  cancel     live item abandoned
 *   d  delete     items removed (temporary: applied by everyone; stored: by the GM)
 *   u  update     item replaced (partial eraser, undo/redo of erasing)
 *   U  updates    several items replaced at once (multi-item transform, recolour)
 *   c  clear      tiered clear (see ClearScope)
 *   q  query      late joiner asks peers for their temporary items
 *   r  reply      a peer's own temporary items, addressed to `to`
 *   n  nack       the GM refused to store an item (budget/permission)
 *
 * Wet media (strokes are simulation inputs; dry results arrive as GM bakes in the Scene flags):
 *   ms  media start   stroke header and first points
 *   mp  media points  live points replacing the tail from index `from`
 *   me  media end     the complete stroke (receivers add what they missed)
 *   mu  media undo    the author undid a stroke
 *   mq / mr           late joiner asks for recent wet strokes / a peer replies with its own
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
  | "permanent"
  /** The scene's wet-media paint. */
  | "media";

export const CLEAR_SCOPES: readonly ClearScope[] = [
  "mine",
  "screen",
  "mapTemp",
  "allTemp",
  "minePermanent",
  "permanent",
  "media",
];

export type NackReason = "permission" | "budget" | "count" | "invalid";

type Envelope = { v: number; scene: string };
export type LiveUpdate =
  | { t: "s"; item: WireItem }
  | { t: "p"; id: string; from: number; pts: string; ang?: string; tl?: string; sp?: string };

export type Message =
  | (Envelope & LiveUpdate)
  | (Envelope & { t: "b"; updates: LiveUpdate[] })
  | { v: number; t: "e"; scene: string; item: WireItem; persist?: boolean }
  | { v: number; t: "x"; scene: string; id: string }
  | { v: number; t: "d"; scene: string; ids: string[] }
  | { v: number; t: "u"; scene: string; item: WireItem }
  | { v: number; t: "U"; scene: string; items: WireItem[] }
  | { v: number; t: "c"; scene: string; scope: ClearScope }
  | { v: number; t: "q"; scene: string }
  | { v: number; t: "r"; scene: string; to: string; items: WireItem[] }
  | { v: number; t: "n"; scene: string; to: string; id: string; reason: NackReason }
  | { v: number; t: "ms"; scene: string; s: WireStroke }
  | { v: number; t: "mp"; scene: string; id: string; from: number; pts: string }
  | { v: number; t: "me"; scene: string; s: WireStroke }
  | { v: number; t: "mu"; scene: string; id: string }
  | { v: number; t: "mq"; scene: string }
  | { v: number; t: "mr"; scene: string; to: string; strokes: WireStroke[] };

export type MessageType = Message["t"];

const ID = /^[A-Za-z0-9_-]{1,32}$/;
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Upper bound for a single raw message (characters of JSON). */
export const MAX_MESSAGE_CHARS = 256 * 1024;
/** Items in one `r` reply / ids in one `d` delete. */
export const MAX_BATCH = 200;
/** Items in one `U` batch update. */
export const MAX_UPDATE_BATCH = 50;
/** The largest symmetry preset produces twelve live items per gesture. */
export const MAX_LIVE_BATCH = 12;
/** Strokes in one `mr` reply. */
export const MAX_STROKE_BATCH = 20;

function isLiveUpdate(raw: unknown): raw is LiveUpdate {
  if (!isObj(raw)) return false;
  if (raw.t === "s") return isObj(raw.item);
  return (
    raw.t === "p" &&
    isId(raw.id) &&
    Number.isInteger(raw.from) &&
    (raw.from as number) >= 0 &&
    typeof raw.pts === "string" &&
    (raw.ang === undefined || typeof raw.ang === "string") &&
    (raw.tl === undefined || typeof raw.tl === "string") &&
    (raw.sp === undefined || typeof raw.sp === "string")
  );
}

/**
 * Structural validation of an inbound payload. Item contents are checked
 * separately by `sanitizeItem`; this only guarantees the envelope's shape.
 */
export function parseMessage(raw: unknown): Message | null {
  if (!isObj(raw) || raw.v !== PROTOCOL_VERSION || !isId(raw.scene)) return null;
  const scene = raw.scene;
  switch (raw.t) {
    case "s":
    case "p":
      return isLiveUpdate(raw) ? { ...raw, v: PROTOCOL_VERSION, scene } : null;
    case "b":
      return Array.isArray(raw.updates) &&
        raw.updates.length > 0 &&
        raw.updates.length <= MAX_LIVE_BATCH &&
        raw.updates.every(isLiveUpdate)
        ? { t: "b", v: PROTOCOL_VERSION, scene: raw.scene, updates: raw.updates }
        : null;
    case "u":
      return isObj(raw.item) ? (raw as unknown as Message) : null;
    case "U":
      return Array.isArray(raw.items) &&
        raw.items.length > 0 &&
        raw.items.length <= MAX_UPDATE_BATCH &&
        raw.items.every(isObj)
        ? { v: PROTOCOL_VERSION, t: "U", scene, items: raw.items as unknown as WireItem[] }
        : null;
    case "e":
      if (!isObj(raw.item)) return null;
      return {
        v: PROTOCOL_VERSION,
        t: "e",
        scene: raw.scene,
        item: raw.item as unknown as WireItem,
        persist: raw.persist === true,
      };
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
    case "ms":
    case "me":
      return isObj(raw.s) ? { v: PROTOCOL_VERSION, t: raw.t, scene, s: raw.s as unknown as WireStroke } : null;
    case "mp":
      return isId(raw.id) && Number.isInteger(raw.from) && (raw.from as number) >= 0 && typeof raw.pts === "string"
        ? { v: PROTOCOL_VERSION, t: "mp", scene, id: raw.id, from: raw.from as number, pts: raw.pts }
        : null;
    case "mu":
      return isId(raw.id) ? { v: PROTOCOL_VERSION, t: "mu", scene, id: raw.id } : null;
    case "mq":
      return { v: PROTOCOL_VERSION, t: "mq", scene };
    case "mr":
      return isId(raw.to) &&
        Array.isArray(raw.strokes) &&
        raw.strokes.length <= MAX_STROKE_BATCH &&
        raw.strokes.every(isObj)
        ? { v: PROTOCOL_VERSION, t: "mr", scene, to: raw.to, strokes: raw.strokes as unknown as WireStroke[] }
        : null;
    default:
      return null;
  }
}

/** Rate-limit cost of a message: [messages, points, items]. */
export function messageCost(msg: Message): [number, number, number] {
  const points = (item: WireItem) =>
    Math.ceil(
      (String(item?.points ?? "").length +
        String(item?.angles ?? "").length +
        String(item?.tilt ?? "").length +
        String(item?.speed ?? "").length) /
        6,
    );
  const liveCost = (update: LiveUpdate): [number, number] =>
    update.t === "s"
      ? [points(update.item), 1]
      : [
          Math.ceil(
            (update.pts.length + (update.ang?.length ?? 0) + (update.tl?.length ?? 0) + (update.sp?.length ?? 0)) / 6,
          ),
          0,
        ];
  switch (msg.t) {
    case "p":
    case "s":
      return [1, ...liveCost(msg)];
    case "b": {
      let p = 0;
      let i = 0;
      for (const update of msg.updates) {
        const [pointCost, itemCost] = liveCost(update);
        p += pointCost;
        i += itemCost;
      }
      return [1, p, i];
    }
    case "e":
    case "u":
      return [1, points(msg.item), 1];
    case "r":
      return [1, msg.items.reduce((n, i) => n + points(i), 0), msg.items.length];
    case "U":
      return [1, msg.items.reduce((n, i) => n + points(i), 0), Math.ceil(msg.items.length / 10)];
    case "d":
      return [1, 0, Math.ceil(msg.ids.length / 10)];
    case "ms":
    case "me":
      return [1, Math.ceil(String(msg.s?.pts ?? "").length / 6), 1];
    case "mp":
      return [1, Math.ceil(msg.pts.length / 6), 0];
    case "mr":
      return [1, msg.strokes.reduce((n, s) => n + Math.ceil(String(s?.pts ?? "").length / 6), 0), msg.strokes.length];
    default:
      return [1, 0, 0];
  }
}
