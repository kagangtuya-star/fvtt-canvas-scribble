export const MODULE_ID = "canvas-scribble";
export const I18N_PREFIX = "CANVAS_SCRIBBLE";
export const SOCKET_NAME = `module.${MODULE_ID}`;

/** Name of the canvas layer (`canvas.canvasScribble`) and of its scene-control group. */
export const LAYER_NAME = "canvasScribble";

/**
 * Hard limits. They protect every client from runaway input, from oversized
 * documents and from malicious socket payloads; the receiving side enforces
 * them again (see `net/net.ts`, `core/sanitize.ts`).
 */
export const LIMITS = {
  /** Points of one stored item; longer freehand input is chained into consecutive items. */
  maxPointsPerItem: 4000,
  /** Erase masks attached to one item (partial eraser). */
  maxMasksPerItem: 64,
  /** Points of one erase mask. */
  maxPointsPerMask: 2000,
  /** Characters of a text item. */
  maxTextLength: 240,
  /** Longest lifetime of a temporary item (ms). */
  maxLifetimeMs: 60 * 60 * 1000,
  /** Longest fade (ms). */
  maxFadeMs: 5000,
  /** Temporary items kept per author in one scene; the oldest are dropped first. */
  maxTemporaryPerAuthor: 300,
  /** Temporary items kept in total in one scene. */
  maxTemporaryTotal: 1500,
  /** Commands kept in the local undo history. */
  maxHistory: 100,
  /** Permanent items per scene. */
  maxPersistentItems: 3000,
  /** Inbound rate limits per sender (token buckets: rate per second, burst). */
  rate: {
    messages: { rate: 60, burst: 180 },
    points: { rate: 4000, burst: 12000 },
    items: { rate: 20, burst: 60 },
  },
  /** Scene padding allowed around the scene rectangle for map points (fraction of the scene size). */
  mapMargin: 1,
  /** Screen coordinates are kept within ±this many units (1000 = shorter viewport side). */
  screenExtent: 4000,
  /** Clock skew tolerated between createdAt and the receiver's server time (ms). */
  clockSkewMs: 30_000,
} as const;

/** Socket batching interval for live points (ms). See docs/DEVELOPMENT.md → Network. */
export const LIVE_BATCH_MS = 33;

/** How long a pending permanent item waits for the GM write before it is dropped (ms). */
export const PENDING_TIMEOUT_MS = 15_000;
