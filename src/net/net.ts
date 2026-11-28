import { LIMITS, LIVE_BATCH_MS, SOCKET_NAME } from "../constants.ts";
import { encodeAngles, encodePoints } from "../core/codec.ts";
import { toWire, zKindOf } from "../core/sanitize.ts";
import type { ScribbleItem } from "../core/types.ts";
import { RateLimiter } from "../core/util.ts";
import { stats } from "../render/stats.ts";
import { MAX_LIVE_BATCH, MAX_MESSAGE_CHARS, PROTOCOL_VERSION, messageCost, parseMessage } from "./protocol.ts";
import type { LiveUpdate, Message } from "./protocol.ts";

type Outbound = Message extends infer M ? (M extends Message ? Omit<M, "v" | "scene"> : never) : never;

export interface SocketLike {
  on(event: string, fn: (...args: any[]) => void): void;
  off?(event: string, fn: (...args: any[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

export interface Inbound {
  msg: Exclude<Message, { t: "b" }>;
  /** Authenticated sender (resolved from the id the server attached). */
  sender: FoundryUser;
}

const rateLimits = () => ({
  messages: new RateLimiter(LIMITS.rate.messages.rate, LIMITS.rate.messages.burst),
  points: new RateLimiter(LIMITS.rate.points.rate, LIMITS.rate.points.burst),
  items: new RateLimiter(LIMITS.rate.items.rate, LIMITS.rate.items.burst),
});

/**
 * Socket wrapper: outbound stamping, inbound envelope validation, sender
 * resolution and per-sender rate limiting. Messages from unknown users,
 * from ourselves, or over budget are dropped before any handler sees them.
 */
export class Net {
  readonly #socket: SocketLike;
  readonly #users: { get(id: string): FoundryUser | undefined };
  readonly #selfId: string;
  readonly #limits = rateLimits();
  // Preview traffic must never spend the budget needed to commit the final items.
  readonly #previewLimits = rateLimits();
  // On pen-up all companions arrive together, even for a long, detailed stroke.
  readonly #finalPoints = new RateLimiter(LIMITS.rate.points.rate, LIMITS.rate.points.burst * MAX_LIVE_BATCH);
  readonly #warned = new Map<string, number>();
  readonly #listener: (payload: unknown, senderId?: unknown) => void;
  #handler: ((input: Inbound) => void) | null = null;
  scene = "";
  /** Debug log hook. */
  log: ((text: string, data?: unknown) => void) | null = null;

  constructor(socket: SocketLike, users: { get(id: string): FoundryUser | undefined }, selfId: string) {
    this.#socket = socket;
    this.#users = users;
    this.#selfId = selfId;
    this.#listener = (payload, senderId) => this.#receive(payload, senderId);
    socket.on(SOCKET_NAME, this.#listener);
  }

  onMessage(fn: (input: Inbound) => void): void {
    this.#handler = fn;
  }

  send(msg: Outbound, scene = this.scene): void {
    if (!scene) return;
    const full = { ...msg, v: PROTOCOL_VERSION, scene } as Message;
    let size = 0;
    try {
      size = JSON.stringify(full).length;
    } catch {
      return;
    }
    if (size > MAX_MESSAGE_CHARS) {
      this.log?.("outbound message too large, not sent", { t: full.t, size });
      return;
    }
    stats.socketOut++;
    stats.socketOutBytes += size;
    this.#socket.emit(SOCKET_NAME, full);
  }

  #receive(payload: unknown, senderId: unknown): void {
    stats.socketIn++;
    if (typeof senderId !== "string" || senderId === this.#selfId) return;
    const sender = this.#users.get(senderId);
    if (!sender) return this.#drop(senderId, "unknown sender");
    let size = 0;
    try {
      size = JSON.stringify(payload).length;
    } catch {
      return this.#drop(senderId, "unserialisable");
    }
    stats.socketInBytes += size;
    if (size > MAX_MESSAGE_CHARS) return this.#drop(senderId, "oversized");
    const msg = parseMessage(payload);
    if (!msg) return this.#drop(senderId, "malformed");
    // Messages for other scenes still reach the handler: the active GM stores
    // permanent items for scenes it is not viewing.
    const [m, p, i] = messageCost(msg);
    const now = performance.now();
    const preview = msg.t === "s" || msg.t === "p" || msg.t === "b" || msg.t === "ms" || msg.t === "mp";
    const limits = preview ? this.#previewLimits : this.#limits;
    if (!limits.messages.take(senderId, m, now)) return this.#drop(senderId, "rate: messages");
    const points = msg.t === "e" || msg.t === "me" ? this.#finalPoints : limits.points;
    if (p && !points.take(senderId, p, now)) return this.#drop(senderId, "rate: points");
    if (i && !limits.items.take(senderId, i, now)) return this.#drop(senderId, "rate: items");
    try {
      if (msg.t === "b") {
        for (const update of msg.updates) {
          this.#handler?.({ msg: { ...update, v: msg.v, scene: msg.scene }, sender });
        }
      } else this.#handler?.({ msg, sender });
    } catch (err) {
      console.error("CanvasScribble | error handling socket message", err);
    }
  }

  #drop(senderId: string, reason: string): void {
    stats.dropped++;
    const now = performance.now();
    const last = this.#warned.get(senderId) ?? -Infinity;
    if (now - last > 5000) {
      this.#warned.set(senderId, now);
      this.log?.(`dropped message from ${senderId}: ${reason}`);
    }
  }

  destroy(): void {
    this.#socket.off?.(SOCKET_NAME, this.#listener);
    this.#handler = null;
  }
}

/**
 * Starts items individually, batches preview changes across all live items,
 * and sends the canonical item on end so receivers converge after a dropped preview.
 */
export class LiveSender {
  readonly #net: Net;
  readonly #sent = new Map<string, ScribbleItem>();
  readonly #dirty = new Map<string, ScribbleItem>();
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(net: Net) {
    this.#net = net;
  }

  start(item: ScribbleItem): void {
    this.#sent.set(item.id, item);
    this.#net.send({ t: "s", item: toWire(item) });
  }

  /** Schedule changes for this item and its companions in one preview batch. */
  push(item: ScribbleItem): void {
    if (!this.#sent.has(item.id)) return;
    this.#dirty.set(item.id, item);
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#flush();
    }, LIVE_BATCH_MS);
  }

  #flush(): void {
    let batch: LiveUpdate[] = [];
    let size = 128; // Envelope and separators.
    const send = () => {
      if (batch.length === 1) this.#net.send(batch[0]!);
      else if (batch.length) this.#net.send({ t: "b", updates: batch });
      batch = [];
      size = 128;
    };
    for (const [id, item] of this.#dirty) {
      const previous = this.#sent.get(id)!;
      const update = this.#previewUpdate(previous, item);
      if (!update) continue;
      this.#sent.set(id, item);
      const chars = JSON.stringify(update).length + 1;
      if (batch.length >= MAX_LIVE_BATCH || size + chars > MAX_MESSAGE_CHARS) send();
      batch.push(update);
      size += chars;
    }
    this.#dirty.clear();
    send();
  }

  #previewUpdate(previous: ScribbleItem, item: ScribbleItem): LiveUpdate | null {
    if (previous.kind !== item.kind || previous.tool !== item.tool || !!previous.angles !== !!item.angles)
      return { t: "s", item: toWire(item) };
    const a = previous.points;
    const b = item.points;
    let i = 0;
    while (
      i < Math.min(a.length, b.length) &&
      a[i] === b[i] &&
      a[i + 1] === b[i + 1] &&
      a[i + 2] === b[i + 2] &&
      previous.angles?.[i / 3] === item.angles?.[i / 3]
    )
      i += 3;
    if (i === a.length && i === b.length) return null;
    const pts = encodePoints(b.slice(i), zKindOf(item.kind));
    const ang = item.angles && encodeAngles(item.angles.slice(i / 3));
    return { t: "p", id: item.id, from: i / 3, pts, ...(ang ? { ang } : {}) };
  }

  end(item: ScribbleItem, persist: boolean): void {
    this.#stop(item.id);
    this.#net.send({ t: "e", item: toWire(item), persist });
  }

  cancel(id: string): void {
    if (!this.#sent.has(id)) return;
    this.#stop(id);
    this.#net.send({ t: "x", id });
  }

  #stop(id: string): void {
    this.#sent.delete(id);
    this.#dirty.delete(id);
    if (this.#dirty.size === 0 && this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  clear(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#dirty.clear();
    this.#sent.clear();
  }
}
