const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 16-character random id (same alphabet and length as Foundry document ids). */
export function randomId(length = 16): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}

/** Deterministic 32-bit hash of a string (FNV-1a). Seeds procedural textures per item. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small, fast seeded PRNG (mulberry32); identical sequences on every client. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** Token bucket rate limiter, keyed (e.g. per user). */
export class RateLimiter {
  readonly #rate: number;
  readonly #burst: number;
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(ratePerSecond: number, burst: number) {
    this.#rate = ratePerSecond;
    this.#burst = burst;
  }

  /** Try to take `cost` tokens; returns false when the key is over its budget. */
  take(key: string, cost = 1, now = performance.now()): boolean {
    let b = this.#buckets.get(key);
    if (!b) {
      b = { tokens: this.#burst, at: now };
      this.#buckets.set(key, b);
    }
    b.tokens = Math.min(this.#burst, b.tokens + ((now - b.at) / 1000) * this.#rate);
    b.at = now;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  forget(key: string): void {
    this.#buckets.delete(key);
  }
}

/** Relative luminance of `#rrggbb` (0 = black, 1 = white). */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

export const hexToNumber = (hex: string): number => Number.parseInt(hex.slice(1), 16);
