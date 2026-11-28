import { MediaEngine } from "./engine.ts";
import type { EngineIn, EngineOut } from "./engine.ts";
import { createBackend } from "./sim/select.ts";

/**
 * Worker entry of the wet-media simulation. Loaded as a module worker from
 * `surface.ts`; the physics never runs on Foundry's render thread.
 */

const scope = globalThis as unknown as {
  postMessage(msg: EngineOut, transfer?: Transferable[]): void;
  addEventListener(type: "message", fn: (e: MessageEvent<EngineIn>) => void): void;
};

let engine: MediaEngine | null = null;
const early: EngineIn[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

const post = (msg: EngineOut, transfer?: Transferable[]) => scope.postMessage(msg, transfer ?? []);

function schedule(): void {
  if (timer !== null || !engine) return;
  timer = setTimeout(() => {
    timer = null;
    if (!engine) return;
    try {
      engine.tick();
    } catch (err) {
      post({ t: "error", message: String((err as Error)?.stack ?? err) });
    }
    if (engine.busy) schedule();
  }, 16);
}

function handle(msg: EngineIn): void {
  if (!engine) {
    if (msg.t !== "init") {
      early.push(msg);
      return;
    }
    const { backend, note } = createBackend(msg.backend);
    engine = new MediaEngine(backend, post);
    engine.handle(msg);
    post({ t: "ready", backend: backend.kind, ...(note ? { note } : {}) });
    for (const m of early.splice(0)) engine.handle(m);
    schedule();
    return;
  }
  try {
    engine.handle(msg);
  } catch (err) {
    post({ t: "error", message: String((err as Error)?.stack ?? err) });
  }
  if (msg.t === "destroy") {
    engine = null;
    return;
  }
  schedule();
}

scope.addEventListener("message", (e) => handle(e.data));
