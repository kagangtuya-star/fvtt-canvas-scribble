/**
 * Browser harness: boots CanvasScribble inside the Foundry stand-in from
 * dev/sim.ts, with real PIXI 7 and the module's real source. Open several
 * tabs with different `?user=` to test multiplayer (BroadcastChannel acts as
 * the server). Exposes `window.__cs` for scripted QA.
 *
 *   harness.html?user=gm|alice|bob&lang=en|zh&fog=1&zoom=0.5&gen=13|14&theme=light
 */
import { clearSimFiles, createCanvas, createGame, createSceneControls, defineCanvasClasses, netLog } from "./sim.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = globalThis as any;
const params = new URLSearchParams(location.search);

async function boot() {
  if (params.get("theme") === "light") {
    document.body.classList.replace("theme-dark", "theme-light");
  }
  const { scene, me } = await createGame();
  document.title = `CanvasScribble harness — ${me.name}`;
  const classes = defineCanvasClasses();
  await import("../src/main.ts");
  G.Hooks.callAll("init");
  G.Hooks.callAll("i18nInit");
  G.Hooks.callAll("setup");
  const controls = createSceneControls();
  const canvas = await createCanvas(scene, classes);
  await canvas.draw();
  canvas.tokens = canvas.tokens ?? canvas.layers.find((l: any) => l.name === "tokens");
  controls.render();
  canvas.tokens?.activate();
  G.game.ready = true;
  G.Hooks.callAll("ready");
  buildPanel(me);
}

function buildPanel(me: { id: string; name: string }) {
  const panel = document.getElementById("harness-panel")!;
  const link = (q: Record<string, string>, label: string) => {
    const p = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(q)) p.set(k, v);
    return `<a href="?${p}" target="_blank">${label}</a>`;
  };
  panel.innerHTML = `<b>${me.name}</b> · open: ${link({ user: "gm" }, "GM")} ${link({ user: "alice" }, "Alice")} ${link({ user: "bob" }, "Bob")}
    · <button data-a="fog">fog</button> <button data-a="redraw">redraw</button> <button data-a="reset">reset scene</button>`;
  panel.addEventListener("click", async (e) => {
    const a = (e.target as HTMLElement).dataset.a;
    if (a === "fog") G.canvas.fog.visible = !G.canvas.fog.visible;
    if (a === "redraw") await G.canvas.draw();
    if (a === "reset") {
      localStorage.removeItem("cs-harness-scene");
      await clearSimFiles();
      location.reload();
    }
  });
}

/* -------------------------------------------- */
/*  Scripted input (real DOM events)            */
/* -------------------------------------------- */

interface StrokeOptions {
  pointerType?: "mouse" | "pen" | "touch";
  pressure?: (t: number) => number;
  shift?: boolean;
  alt?: boolean;
  /** ms between samples (event timestamps are synthetic but ordered). */
  dt?: number;
  button?: number;
  /** Don't release at the end. */
  hold?: boolean;
}

function fire(type: string, x: number, y: number, o: StrokeOptions, pressure: number) {
  const board = document.getElementById("board")!;
  const ev = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    pointerId: o.pointerType === "touch" ? 11 : o.pointerType === "pen" ? 7 : 1,
    pointerType: o.pointerType ?? "mouse",
    pressure,
    button: type === "pointermove" ? -1 : (o.button ?? 0),
    buttons: type === "pointerup" ? 0 : 1,
    shiftKey: !!o.shift,
    altKey: !!o.alt,
    isPrimary: true,
  });
  board.dispatchEvent(ev);
}

async function stroke(points: [number, number][], o: StrokeOptions = {}) {
  const n = points.length;
  const p = (i: number) => (o.pressure ? o.pressure(i / Math.max(1, n - 1)) : o.pointerType === "pen" ? 0.6 : 0.5);
  fire("pointerdown", points[0]![0], points[0]![1], o, p(0));
  for (let i = 1; i < n; i++) {
    fire("pointermove", points[i]![0], points[i]![1], o, p(i));
    if (o.dt) await new Promise((r) => setTimeout(r, o.dt));
  }
  if (!o.hold) fire("pointerup", points[n - 1]![0], points[n - 1]![1], o, 0);
  // rAF never fires in a hidden tab; don't hang scripted QA on it.
  await new Promise((r) => {
    requestAnimationFrame(() => r(null));
    setTimeout(r, 100);
  });
}

/** Points along a sine wave between two client points. */
function wave(x0: number, y0: number, x1: number, y1: number, amp = 30, count = 60): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const nx = -(y1 - y0);
    const ny = x1 - x0;
    const len = Math.hypot(nx, ny) || 1;
    const s = Math.sin(t * Math.PI * 2) * amp;
    out.push([x0 + (x1 - x0) * t + (nx / len) * s, y0 + (y1 - y0) * t + (ny / len) * s]);
  }
  return out;
}

function key(code: string, type: "keydown" | "keyup", mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) {
  window.dispatchEvent(
    new KeyboardEvent(type, {
      code,
      key: code.replace(/^Key/, "").toLowerCase(),
      ctrlKey: !!mods.ctrl,
      shiftKey: !!mods.shift,
      altKey: !!mods.alt,
      bubbles: true,
    }),
  );
}

G.__cs = {
  get api() {
    return G.game.modules.get("canvas-scribble").api;
  },
  get session() {
    return G.game.modules.get("canvas-scribble").api.session;
  },
  stroke,
  wave,
  key,
  netLog,
  /** Store summary for assertions. */
  summary() {
    const s = G.game.modules.get("canvas-scribble").api.session;
    const out: Record<string, number> = {};
    for (const e of s.store.values()) {
      const k = `${e.item.mode}:${e.state}`;
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  },
  sceneFlags() {
    return G.canvas.scene.flags;
  },
};

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "beforeend",
    `<pre style="color:#f88;position:fixed;top:40px;left:120px;z-index:999">${String(err?.stack ?? err)}</pre>`,
  );
});
