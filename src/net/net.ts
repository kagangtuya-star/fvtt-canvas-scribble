import { LIMITS, LIVE_BATCH_MS, SOCKET_NAME } from "../constants.ts";
import { encodePoints } from "../core/codec.ts";
import { toWire, zKindOf } from "../core/sanitize.ts";
import type { ScribbleItem } from "../core/types.ts";
import { RateLimiter } from "../core/util.ts";
import { stats } from "../render/stats.ts";
import { MAX_MESSAGE_CHARS, PROTOCOL_VERSION, messageCost, parseMessage } from "./protocol.ts";
import type { Message } from "./protocol.ts";

type Outbound = Message extends infer M ? (M extends Message ? Omit<M, "v" | "scene"> : never) : never;

export interface SocketLike {
  on(event: string, fn: (...args: any[]) => void): void;
  off?(event: string, fn: (...args: any[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

export interface Inbound {
  msg: Message;
  /** Authenticated sender (resolved from the id the server attached). */
  sender: FoundryUser;
}

/**
 * Socket wrapper: outbound stamping, inbound envelope validation, sender
 * resolution and per-sender rate limiting. Messages from unknown users,
 * from ourselves, or over budget are dropped before any handler sees them.
 */
export class Net {
  readonly #socket: SocketLike;
  readonly #users: { get(id: string): FoundryUser | undefined };
  readonly #selfId: string;
  readonly #limits = {
    messages: new RateLimiter(LIMITS.rate.messages.rate, LIMITS.rate.messages.burst),
    points: new RateLimiter(LIMITS.rate.points.rate, LIMITS.rate.points.burst),
    items: new RateLimiter(LIMITS.rate.items.rate, LIMITS.rate.items.burst),
  };
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
    if (!this.#limits.messages.take(senderId, m, now)) return this.#drop(senderId, "rate: messages");
    if (p && !this.#limits.points.take(senderId, p, now)) return this.#drop(senderId, "rate: points");
    if (i && !this.#limits.items.take(senderId, i, now)) return this.#drop(senderId, "rate: items");
    try {
      this.#handler?.({ msg, sender });
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
 * Streams a live item: one `s` message, then `p` batches of new points every
 * {@link LIVE_BATCH_MS}, then the final `e` (or `x`). The end message carries
 * the canonical item, so receivers that missed a batch still converge.
 */
export class LiveSender {
  readonly #net: Net;
  readonly #live = new Map<string, { item: ScribbleItem; sent: number; timer: ReturnType<typeof setTimeout> | null }>();

  constructor(net: Net) {
    this.#net = net;
  }

  start(item: ScribbleItem): void {
    this.#live.set(item.id, { item, sent: item.points.length / 3, timer: null });
    this.#net.send({ t: "s", item: toWire(item) });
  }

  /** The live item changed (points appended); schedule a batch. */
  push(item: ScribbleItem): void {
    const s = this.#live.get(item.id);
    if (!s) return;
    s.item = item;
    if (s.timer) return;
    s.timer = setTimeout(() => {
      s.timer = null;
      this.#flush(item.id);
    }, LIVE_BATCH_MS);
  }

  #flush(id: string): void {
    const s = this.#live.get(id);
    if (!s) return;
    const n = s.item.points.length / 3;
    if (n <= s.sent) return;
    const pts = encodePoints(s.item.points.slice(s.sent * 3), zKindOf(s.item.kind));
    this.#net.send({ t: "p", id, from: s.sent, pts });
    s.sent = n;
  }

  end(item: ScribbleItem, persist: boolean): void {
    this.#stop(item.id);
    this.#net.send({ t: "e", item: toWire(item), persist });
  }

  cancel(id: string): void {
    if (!this.#live.has(id)) return;
    this.#stop(id);
    this.#net.send({ t: "x", id });
  }

  #stop(id: string): void {
    const s = this.#live.get(id);
    if (s?.timer) clearTimeout(s.timer);
    this.#live.delete(id);
  }

  clear(): void {
    for (const id of [...this.#live.keys()]) this.#stop(id);
  }
}
