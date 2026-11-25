/**
 * A small, faithful-where-it-matters stand-in for the Foundry VTT v13 runtime,
 * used by the browser harness (dev/harness.html). It is NOT Foundry: it only
 * reproduces the API surface CanvasScribble touches, with the same semantics
 * (layer activation, canvas groups and their sort/tear-down behaviour, scene
 * controls callbacks, keybinding precedence, socket sender ids, Scene flag
 * updates with `-=` deletion, GM-only document writes).
 *
 * Several harness tabs talk to each other through BroadcastChannel, which
 * plays the role of the Foundry server: it relays module socket messages with
 * the sender's user id and propagates Scene updates to every client.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = globalThis as any;
const params = new URLSearchParams(location.search);

export const USERS = [
  { id: "GmUserAaaaaaaaa1", name: "Gamemaster", role: 4, color: "#e0a030" },
  { id: "AliceBbbbbbbbbb2", name: "Alice", role: 1, color: "#3d8be8" },
  { id: "BobCcccccccccccc3", name: "Bob", role: 2, color: "#4caf6a" },
];

const SCENE_ID = "SceneDddddddddd1";
const STORE_KEY = "cs-harness-scene";

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

class SimHooks {
  #events = new Map<string, { fn: (...a: any[]) => any; once: boolean; id: number }[]>();
  #id = 0;
  on(name: string, fn: (...a: any[]) => any) {
    const list = this.#events.get(name) ?? [];
    list.push({ fn, once: false, id: ++this.#id });
    this.#events.set(name, list);
    return this.#id;
  }
  once(name: string, fn: (...a: any[]) => any) {
    const list = this.#events.get(name) ?? [];
    list.push({ fn, once: true, id: ++this.#id });
    this.#events.set(name, list);
    return this.#id;
  }
  off(name: string, idOrFn: any) {
    const list = this.#events.get(name) ?? [];
    this.#events.set(
      name,
      list.filter((h) => h.id !== idOrFn && h.fn !== idOrFn),
    );
  }
  callAll(name: string, ...args: any[]) {
    for (const h of [...(this.#events.get(name) ?? [])]) {
      if (h.once) this.off(name, h.id);
      try {
        h.fn(...args);
      } catch (err) {
        console.error(`Hook ${name} failed`, err);
      }
    }
    return true;
  }
}

/* -------------------------------------------- */
/*  Utilities                                   */
/* -------------------------------------------- */

function setPath(obj: any, path: string, value: any) {
  const parts = path.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (typeof o[p] !== "object" || o[p] === null) o[p] = {};
    o = o[p];
  }
  const last = parts.at(-1)!;
  if (last.startsWith("-=")) {
    // v14 deprecates the `-=` prefix in favour of the `_del` operator.
    if (G.game?.release?.generation >= 14) console.warn("[sim] deprecated `-=` deletion key under v14:", path);
    delete o[last.slice(2)];
  } else if (value?.__simDeletion === true) delete o[last];
  else o[last] = value;
}

/** Apply a Foundry-style dotted update (supports `-=key` deletion). */
export function applyUpdate(target: any, data: Record<string, any>) {
  for (const [k, v] of Object.entries(data)) setPath(target, k, structuredClone(v));
}

function expand(data: Record<string, any>) {
  const out: any = {};
  for (const [k, v] of Object.entries(data)) setPath(out, k.replace(/\.-=/, ".-="), v);
  return out;
}

/* -------------------------------------------- */
/*  "Server": BroadcastChannel relay            */
/* -------------------------------------------- */

const channel = new BroadcastChannel("cs-harness");
const socketListeners = new Map<string, Set<(...a: any[]) => void>>();
const presence = new Map<string, number>();
export const netLog: { dir: "in" | "out"; event: string; size: number; t: number }[] = [];

function post(msg: any) {
  channel.postMessage(msg);
}

/* -------------------------------------------- */
/*  Canvas layers                               */
/* -------------------------------------------- */

export function defineCanvasClasses() {
  const PIXI = G.PIXI;

  class CanvasLayer extends PIXI.Container {
    static get layerOptions() {
      return { name: "", baseClass: CanvasLayer };
    }
    get name() {
      return (this.constructor as any).layerOptions.name;
    }
    get hookName() {
      return this.constructor.name;
    }
    async draw() {
      await this.tearDown();
      await this._draw({});
      return this;
    }
    async _draw(_o: any) {}
    async tearDown() {
      await this._tearDown({});
      for (const c of this.removeChildren()) c.destroy({ children: true });
      return this;
    }
    async _tearDown(_o: any) {}
  }

  class InteractionLayer extends CanvasLayer {
    #active = false;
    get active() {
      return this.#active;
    }
    static override get layerOptions() {
      return Object.assign(super.layerOptions, { baseClass: InteractionLayer, zIndex: 0 });
    }
    activate({ tool }: { tool?: string } = {}) {
      const was = this.#active;
      this.#active = true;
      for (const layer of G.canvas.layers) if (layer !== this && layer instanceof InteractionLayer) layer.deactivate();
      const control = (this.constructor as any).layerOptions.name;
      if (control !== G.ui.controls.control?.name || (tool && tool !== G.ui.controls.tool?.name))
        G.ui.controls.activate({ control, tool });
      if (was) return this;
      this.zIndex = this.getZIndex();
      this.eventMode = "static";
      this._activate();
      G.Hooks.callAll(`activate${this.hookName}`, this);
      return this;
    }
    _activate() {}
    deactivate() {
      if (!this.#active) return this;
      this.#active = false;
      this.eventMode = "passive";
      this._deactivate();
      return this;
    }
    _deactivate() {}
    getZIndex() {
      return (this.constructor as any).layerOptions.zIndex;
    }
    _onUndoKey(_e: any) {
      return false;
    }
    _onDismissKey(_e: any) {
      return false;
    }
    _onCycleViewKey(_e: any) {
      return false;
    }
    _onDeleteKey(_e: any) {
      return false;
    }
  }

  /** Token layer stand-in: a "select" tool and a few tokens in the primary group. */
  class TokenLayer extends InteractionLayer {
    static override get layerOptions() {
      return Object.assign(super.layerOptions, { name: "tokens", zIndex: 200 });
    }
    static prepareSceneControls() {
      return {
        name: "tokens",
        order: 1,
        title: "Token Controls",
        icon: "fa-solid fa-user-large",
        layer: "tokens",
        onChange: (_e: any, active: boolean) => active && G.canvas.tokens.activate(),
        tools: {
          select: { name: "select", order: 1, title: "Select Tokens", icon: "fa-solid fa-expand" },
          ruler: { name: "ruler", order: 2, title: "Measure", icon: "fa-solid fa-ruler" },
        },
        activeTool: "select",
      };
    }
  }

  G.foundry = {
    canvas: { layers: { CanvasLayer, InteractionLayer } },
    applications: { api: { DialogV2: { confirm: simConfirm } } },
    utils: {
      escapeHTML: (s: string) =>
        s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!),
      isSubclass: (cls: any, parent: any) => cls === parent || cls.prototype instanceof parent,
    },
  };
  return { CanvasLayer, InteractionLayer, TokenLayer };
}

/* -------------------------------------------- */
/*  Dialog                                      */
/* -------------------------------------------- */

async function simConfirm(o: any): Promise<boolean> {
  if (G.__harnessAutoConfirm !== undefined) return G.__harnessAutoConfirm;
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "sim-dialog application themed theme-dark";
    wrap.innerHTML = `<header class="window-header"><h1 class="window-title">${o.window?.title ?? ""}</h1></header>
      <section class="window-content">${o.content ?? ""}</section>
      <footer class="form-footer"><button data-r="yes" type="button"><i class="${o.yes?.icon ?? ""}"></i> ${o.yes?.label ?? "Yes"}</button>
      <button data-r="no" type="button" autofocus>No</button></footer>`;
    wrap.addEventListener("click", (e) => {
      const r = (e.target as HTMLElement).closest("button")?.dataset.r;
      if (!r) return;
      wrap.remove();
      resolve(r === "yes");
    });
    document.body.append(wrap);
  });
}

/* -------------------------------------------- */
/*  Scene controls (minimal clone of v13)       */
/* -------------------------------------------- */

class SimSceneControls {
  controls: Record<string, any> = {};
  #control = "tokens";
  #tools: Record<string, string> = {};
  element = document.getElementById("scene-controls")!;

  get control() {
    return this.controls[this.#control] ?? null;
  }
  get tool() {
    const c = this.control;
    return c ? (c.tools[this.#tools[this.#control] ?? c.activeTool] ?? null) : null;
  }

  prepare() {
    const controls: Record<string, any> = {};
    for (const { layerClass } of Object.values(G.CONFIG.Canvas.layers) as any[]) {
      if (!layerClass.prepareSceneControls) continue;
      const c = layerClass.prepareSceneControls();
      if (c && c.visible !== false) controls[c.name] = c;
    }
    G.Hooks.callAll("getSceneControlButtons", controls);
    for (const c of Object.values(controls)) {
      this.#tools[c.name] ||= c.activeTool;
      for (const [k, t] of Object.entries(c.tools as Record<string, any>)) if (t.visible === false) delete c.tools[k];
    }
    this.controls = controls;
  }

  render() {
    this.prepare();
    const el = this.element;
    const layers = Object.values(this.controls).sort((a, b) => a.order - b.order);
    const tools = Object.values(this.control?.tools ?? {}).sort((a: any, b: any) => a.order - b.order) as any[];
    el.innerHTML = `<menu id="scene-controls-layers" class="flexcol">${layers
      .map(
        (c) =>
          `<li><button type="button" class="control ui-control layer icon ${c.icon}" data-control="${c.name}" data-tooltip="${G.game.i18n.localize(c.title)}" aria-label="${G.game.i18n.localize(c.title)}" aria-pressed="${c.name === this.#control}"></button></li>`,
      )
      .join("")}</menu><menu id="scene-controls-tools" class="flexcol">${tools
      .map((t) => {
        const active = t.toggle ? !!t.active : !t.button && t.name === this.#tools[this.#control];
        const cls = [t.button ? "button" : "", t.toggle ? "toggle" : ""].join(" ");
        return `<li><button type="button" class="control ui-control tool icon ${cls} ${t.icon}" data-tool="${t.name}" data-tooltip="${G.game.i18n.localize(t.title)}" aria-label="${G.game.i18n.localize(t.title)}" aria-pressed="${active}"></button></li>`;
      })
      .join("")}</menu>`;
    el.querySelectorAll<HTMLButtonElement>("button.layer").forEach((b) =>
      b.addEventListener("click", (e) => this.activate({ event: e, control: b.dataset.control })),
    );
    el.querySelectorAll<HTMLButtonElement>("button.tool").forEach((b) =>
      b.addEventListener("click", (e) => {
        const tool = this.control.tools[b.dataset.tool!];
        if (tool.button) return tool.onChange?.(e, true);
        if (tool.toggle) {
          tool.active = !tool.active;
          b.setAttribute("aria-pressed", String(tool.active));
          return tool.onChange?.(e, tool.active);
        }
        this.activate({ event: e, tool: tool.name });
      }),
    );
  }

  async activate({ event, control, tool }: { event?: any; control?: string; tool?: string } = {}) {
    const priorControl = this.control;
    const priorTool = this.tool;
    control ??= this.#control;
    const controlChange = control !== this.#control;
    if (controlChange) this.#control = control;
    if (tool) this.#tools[this.#control] = tool;
    const toolChange = controlChange || (tool && priorTool?.name !== tool);
    if (toolChange && priorTool) priorTool.onChange?.(event, false);
    if (controlChange && priorControl) priorControl.onChange?.(event, false);
    this.render();
    if (controlChange) this.control?.onChange?.(event, true);
    if (toolChange) {
      this.tool?.onChange?.(event, true);
      this.control?.onToolChange?.(event, this.tool, true);
    }
    G.Hooks.callAll("renderSceneControls", this);
  }
}

/* -------------------------------------------- */
/*  Notifications                               */
/* -------------------------------------------- */

const notifications = {
  log: [] as { level: string; text: string }[],
  push(level: string, text: string) {
    this.log.push({ level, text });
    const box = document.getElementById("notifications")!;
    const li = document.createElement("li");
    li.className = `notification ${level}`;
    li.textContent = text;
    box.append(li);
    setTimeout(() => li.remove(), 4000);
  },
  info(t: string) {
    this.push("info", t);
  },
  warn(t: string) {
    this.push("warning", t);
  },
  error(t: string) {
    this.push("error", t);
  },
};

/* -------------------------------------------- */
/*  Keybindings (precedence + modifiers)        */
/* -------------------------------------------- */

interface Binding {
  action: string;
  key: string;
  modifiers: string[];
  onDown?: (ctx: any) => any;
  onUp?: (ctx: any) => any;
  precedence: number;
  repeat: boolean;
  order: number;
}

class SimKeybindings {
  bindings: Binding[] = [];
  #order = 0;
  register(module: string, action: string, config: any) {
    for (const e of config.editable ?? []) {
      this.bindings.push({
        action: `${module}.${action}`,
        key: e.key,
        modifiers: e.modifiers ?? [],
        onDown: config.onDown,
        onUp: config.onUp,
        precedence: config.precedence ?? 1,
        repeat: !!config.repeat,
        order: this.#order++,
      });
    }
  }
  /** Core bindings that reach the active layer (subset of v13 ClientKeybindings). */
  registerCore() {
    const layerCall = (method: string) => () => G.canvas?.activeLayer?.[method]?.({}) ?? false;
    this.register("core", "dismiss", {
      editable: [{ key: "Escape" }],
      onDown: layerCall("_onDismissKey"),
      precedence: 2,
    });
    this.register("core", "undo", {
      editable: [{ key: "KeyZ", modifiers: ["Control"] }],
      onDown: layerCall("_onUndoKey"),
      precedence: 1,
    });
    this.register("core", "cycleView", {
      editable: [{ key: "Tab" }],
      onDown: layerCall("_onCycleViewKey"),
      precedence: 1,
    });
  }
  handle(e: KeyboardEvent, up: boolean) {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const mods = (b: Binding) => {
      const want = new Set(b.modifiers);
      return (
        want.has("Control") === (e.ctrlKey || e.metaKey) &&
        want.has("Shift") === e.shiftKey &&
        want.has("Alt") === e.altKey
      );
    };
    const matches = this.bindings
      .filter((b) => b.key === e.code && (up ? true : mods(b)))
      .sort((a, b) => a.precedence - b.precedence || a.order - b.order);
    for (const b of matches) {
      if (!up && e.repeat && !b.repeat) continue;
      const ctx = {
        key: e.code,
        event: e,
        isShift: e.shiftKey,
        isControl: e.ctrlKey,
        isAlt: e.altKey,
        up,
        repeat: e.repeat,
      };
      const fn = up ? b.onUp : b.onDown;
      if (!fn) continue;
      if (fn(ctx)) {
        e.preventDefault();
        return;
      }
    }
  }
}

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

class SimSettings {
  #defs = new Map<string, any>();
  #prefix = `cs-harness-settings:`;
  register(module: string, key: string, config: any) {
    this.#defs.set(`${module}.${key}`, config);
  }
  #storageKey(id: string) {
    const def = this.#defs.get(id);
    return def?.scope === "world" ? `${this.#prefix}world:${id}` : `${this.#prefix}${G.game.user.id}:${id}`;
  }
  get(module: string, key: string) {
    const id = `${module}.${key}`;
    const def = this.#defs.get(id);
    if (!def) throw new Error(`setting ${id} not registered`);
    const raw = localStorage.getItem(this.#storageKey(id));
    return raw === null ? structuredClone(def.default) : JSON.parse(raw);
  }
  async set(module: string, key: string, value: any) {
    const id = `${module}.${key}`;
    const def = this.#defs.get(id);
    if (def?.scope === "world" && !G.game.user.isGM) throw new Error("only a GM may change world settings");
    localStorage.setItem(this.#storageKey(id), JSON.stringify(value));
    def?.onChange?.(value);
    if (def?.scope === "world") post({ type: "setting", id, value });
    return value;
  }
  defs() {
    return this.#defs;
  }
  applyRemote(id: string, value: any) {
    this.#defs.get(id)?.onChange?.(value);
  }
}

/* -------------------------------------------- */
/*  Scene document                              */
/* -------------------------------------------- */

function loadSceneData(): any {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { flags: {} };
}

class SimScene {
  id = SCENE_ID;
  name = "Harbour District";
  width = 3000;
  height = 2000;
  flags: any;
  constructor() {
    this.flags = loadSceneData().flags ?? {};
  }
  get dimensions() {
    return { sceneWidth: this.width, sceneHeight: this.height };
  }
  getFlag(scope: string, key: string) {
    return this.flags?.[scope]?.[key];
  }
  canUserModify(user: any) {
    return user.isGM;
  }
  async update(data: Record<string, any>) {
    // Emulates the server: only GMs may update scenes.
    if (!G.game.user.isGM) throw new Error("User lacks permission to update Scene");
    await new Promise((r) => setTimeout(r, Number(params.get("latency") ?? 20)));
    this.#apply(data);
    localStorage.setItem(STORE_KEY, JSON.stringify({ flags: this.flags }));
    post({ type: "sceneUpdate", data });
    return this;
  }
  #apply(data: Record<string, any>) {
    const doc: any = { flags: this.flags };
    applyUpdate(doc, data);
    this.flags = doc.flags;
    G.Hooks.callAll("updateScene", this, expand(data), {}, G.game.user.id);
  }
  applyRemote(data: Record<string, any>) {
    this.#apply(data);
  }
}

/* -------------------------------------------- */
/*  Boot                                        */
/* -------------------------------------------- */

export async function createGame() {
  const userKey = (params.get("user") ?? "gm").toLowerCase();
  const me = USERS.find((u) => u.name.toLowerCase().startsWith(userKey) || u.id === userKey) ?? USERS[0]!;
  const lang = params.get("lang") ?? "en";
  const langData = await (await fetch(`lang/${lang === "zh" ? "zh-CN" : "en"}.json`)).json();
  const strings = new Map<string, string>();
  const flat = (o: any, p = "") => {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? `${p}.${k}` : k;
      if (v && typeof v === "object") flat(v, key);
      else strings.set(key, String(v));
    }
  };
  flat(langData);
  for (const [k, v] of Object.entries({
    "USER.RolePlayer": "Player",
    "USER.RoleTrusted": "Trusted Player",
    "USER.RoleAssistant": "Assistant GM",
    "USER.RoleGamemaster": "Game Master",
  }))
    strings.set(k, v);

  const users = USERS.map((u) => ({
    ...u,
    isGM: u.role >= 4,
    get active() {
      return u.id === me.id || (presence.get(u.id) ?? 0) > Date.now() - 3000;
    },
    isSelf: u.id === me.id,
  }));
  const userCollection: any = {
    get: (id: string) => users.find((u) => u.id === id),
    [Symbol.iterator]: () => users[Symbol.iterator](),
    contents: users,
    get activeGM() {
      return users.filter((u) => u.isGM && u.active).sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
    },
  };
  const scene = new SimScene();
  const settings = new SimSettings();
  const keybindings = new SimKeybindings();
  const skew = Number(params.get("skew") ?? 0);
  // v14: the `_del` deletion operator (a plain marker here so it survives structured cloning).
  if (Number(params.get("gen") ?? 13) >= 14) G._del = Object.freeze({ __simDeletion: true });

  G.game = {
    ready: false,
    user: users.find((u) => u.id === me.id),
    userId: me.id,
    users: userCollection,
    release: { generation: Number(params.get("gen") ?? 13), build: 999 },
    version: `${params.get("gen") ?? 13}.999`,
    time: {
      get serverTime() {
        return Date.now() + skew;
      },
    },
    i18n: {
      lang,
      localize: (key: string) => strings.get(key) ?? key,
      format: (key: string, data: Record<string, unknown> = {}) =>
        (strings.get(key) ?? key).replace(/\{(\w+)\}/g, (_m, k) => String(data[k] ?? `{${k}}`)),
      has: (key: string) => strings.has(key),
    },
    settings,
    keybindings,
    socket: {
      on(event: string, fn: (...a: any[]) => void) {
        const set = socketListeners.get(event) ?? new Set();
        set.add(fn);
        socketListeners.set(event, set);
      },
      off(event: string, fn: (...a: any[]) => void) {
        socketListeners.get(event)?.delete(fn);
      },
      emit(event: string, payload: unknown) {
        const size = JSON.stringify(payload).length;
        netLog.push({ dir: "out", event, size, t: performance.now() });
        post({ type: "socket", event, payload, sender: me.id });
      },
    },
    modules: new Map([["canvas-scribble", { id: "canvas-scribble", active: true, api: undefined }]]),
    scenes: { get: (id: string) => (id === scene.id ? scene : undefined) },
  };
  G.Hooks = new SimHooks();
  G.CONFIG = { Canvas: { layers: {} } };
  G.CONST = {
    USER_ROLES: { NONE: 0, PLAYER: 1, TRUSTED: 2, ASSISTANT: 3, GAMEMASTER: 4 },
    KEYBINDING_PRECEDENCE: { PRIORITY: 0, NORMAL: 1, DEFERRED: 2 },
  };
  G.ui = { notifications, controls: null };
  keybindings.registerCore();
  window.addEventListener("keydown", (e) => keybindings.handle(e, false));
  window.addEventListener("keyup", (e) => keybindings.handle(e, true));

  // Server relay.
  channel.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m.type === "socket") {
      netLog.push({ dir: "in", event: m.event, size: JSON.stringify(m.payload).length, t: performance.now() });
      for (const fn of socketListeners.get(m.event) ?? []) fn(m.payload, m.sender);
    } else if (m.type === "sceneUpdate") scene.applyRemote(m.data);
    else if (m.type === "presence") {
      const was = presence.has(m.user);
      presence.set(m.user, Date.now());
      if (!was) G.Hooks.callAll("userConnected", userCollection.get(m.user), true);
    } else if (m.type === "leave") {
      presence.delete(m.user);
      G.Hooks.callAll("userConnected", userCollection.get(m.user), false);
    } else if (m.type === "setting") settings.applyRemote(m.id, m.value);
  });
  const ping = () => post({ type: "presence", user: me.id });
  ping();
  setInterval(ping, 1000);
  window.addEventListener("beforeunload", () => post({ type: "leave", user: me.id }));
  return { scene, me };
}

/* -------------------------------------------- */
/*  Canvas                                      */
/* -------------------------------------------- */

export async function createCanvas(scene: SimScene, classes: ReturnType<typeof defineCanvasClasses>) {
  const PIXI = G.PIXI;
  const view = document.getElementById("board") as HTMLCanvasElement;
  const app = new PIXI.Application({
    view,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    backgroundColor: 0x1b1b1b,
  });
  const grid = 100;
  const padding = 500;
  const dims = {
    size: grid,
    sceneX: padding,
    sceneY: padding,
    sceneWidth: scene.width,
    sceneHeight: scene.height,
    width: scene.width + 2 * padding,
    height: scene.height + 2 * padding,
    rect: new PIXI.Rectangle(0, 0, scene.width + 2 * padding, scene.height + 2 * padding),
    scale: { min: 0.1, max: 3 },
  };

  // stage (transformed) → primary, visibility (fog), interface; overlay is unbound.
  const stage = new PIXI.Container();
  app.stage.addChild(stage);
  const primary: any = new PIXI.Container();
  primary.sortDirty = true;
  const compare = (a: any, b: any) =>
    (a.elevation || 0) - (b.elevation || 0) ||
    (a.sortLayer || 0) - (b.sortLayer || 0) ||
    (a.sort || 0) - (b.sort || 0) ||
    a.zIndex - b.zIndex ||
    a._lastSortedIndex - b._lastSortedIndex;
  primary.sortChildren = function () {
    this.children.forEach((c: any, i: number) => (c._lastSortedIndex = i));
    this.children.sort(compare);
    this.sortDirty = false;
  };
  const visibility = new PIXI.Container();
  const iface: any = new PIXI.Container();
  iface.sortableChildren = true;
  const overlay = new PIXI.Container();
  stage.addChild(primary, visibility, iface);
  app.stage.addChild(overlay);
  app.ticker.add(
    () => {
      if (primary.sortDirty) primary.sortChildren();
      // Elevation comparison uses NaN-safe subtraction like Foundry (Infinity - Infinity → NaN → next key).
    },
    null,
    PIXI.UPDATE_PRIORITY.HIGH,
  );

  // Background: parchment map with grid, painted once.
  const bgCanvas = document.createElement("canvas");
  bgCanvas.width = scene.width / 2;
  bgCanvas.height = scene.height / 2;
  const g2 = bgCanvas.getContext("2d")!;
  const grad = g2.createLinearGradient(0, 0, bgCanvas.width, bgCanvas.height);
  grad.addColorStop(0, "#d9c8a2");
  grad.addColorStop(1, "#bfa77a");
  g2.fillStyle = grad;
  g2.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
  g2.fillStyle = "#7d9fb0";
  g2.beginPath();
  g2.ellipse(bgCanvas.width * 0.78, bgCanvas.height * 0.7, 260, 180, 0.3, 0, Math.PI * 2);
  g2.fill();
  g2.fillStyle = "#8a7356";
  for (const [x, y, w, h] of [
    [120, 120, 260, 160],
    [460, 90, 180, 220],
    [200, 420, 320, 140],
    [700, 260, 160, 160],
  ])
    g2.fillRect(x!, y!, w!, h!);
  g2.strokeStyle = "rgba(60,40,20,0.35)";
  g2.lineWidth = 1;
  for (let x = 0; x <= bgCanvas.width; x += grid / 2) {
    g2.beginPath();
    g2.moveTo(x, 0);
    g2.lineTo(x, bgCanvas.height);
    g2.stroke();
  }
  for (let y = 0; y <= bgCanvas.height; y += grid / 2) {
    g2.beginPath();
    g2.moveTo(0, y);
    g2.lineTo(bgCanvas.width, y);
    g2.stroke();
  }
  const bg: any = new PIXI.Sprite(PIXI.Texture.from(bgCanvas));
  bg.position.set(padding, padding);
  bg.scale.set(2);
  bg.elevation = 0;
  bg.sortLayer = 0;
  primary.addChild(bg);
  primary.background = bg;

  // Tokens (sortLayer 700) — one raised to elevation 10.
  const tokens: any[] = [];
  for (const [i, [x, y, color, elev]] of (
    [
      [900, 900, 0xc0392b, 0],
      [1300, 1100, 0x2980b9, 0],
      [1700, 900, 0x27ae60, 10],
    ] as const
  ).entries()) {
    const t: any = new PIXI.Graphics();
    t.beginFill(color).drawCircle(0, 0, 45).endFill();
    t.lineStyle(6, 0xffffff).drawCircle(0, 0, 45);
    t.position.set(x, y);
    t.sortLayer = 700;
    t.elevation = elev;
    t.name = `token${i}`;
    primary.addChild(t);
    tokens.push(t);
  }

  // Fog of war: darkness everywhere except a vision circle around the first token.
  const fog = new PIXI.Graphics();
  const drawFog = () => {
    fog.clear();
    fog.beginFill(0x000000, 0.88);
    fog.drawRect(0, 0, dims.width, dims.height);
    fog.beginHole();
    fog.drawCircle(tokens[0].x, tokens[0].y, 420);
    fog.endHole();
    fog.endFill();
  };
  drawFog();
  fog.visible = params.get("fog") === "1";
  visibility.addChild(fog);

  const layers: any[] = [];
  const canvas: any = {
    ready: false,
    scene,
    app,
    stage,
    dimensions: dims,
    primary,
    interface: iface,
    overlay,
    visibility,
    fog,
    tokens: null,
    layers,
    get activeLayer() {
      return layers.find((l) => l.active) ?? null;
    },
    get screenDimensions() {
      return [app.screen.width, app.screen.height];
    },
    canvasCoordinatesFromClient(p: { x: number; y: number }) {
      return stage.worldTransform.applyInverse(new PIXI.Point(p.x, p.y));
    },
    clientCoordinatesFromCanvas(p: { x: number; y: number }) {
      return stage.worldTransform.apply(new PIXI.Point(p.x, p.y));
    },
    pan({ x, y, scale }: { x?: number; y?: number; scale?: number }) {
      const s = scale ?? stage.scale.x;
      const cx = x ?? stage.pivot.x;
      const cy = y ?? stage.pivot.y;
      stage.scale.set(s);
      stage.pivot.set(cx, cy);
      stage.position.set(app.screen.width / 2, app.screen.height / 2);
      // worldTransform is normally refreshed by a render; a hidden tab never renders, but scripted QA still sends input.
      stage.transform.updateTransform(PIXI.Transform.IDENTITY);
      G.Hooks.callAll("canvasPan", canvas, { x: cx, y: cy, scale: s });
    },
    async draw() {
      if (canvas.ready) await canvas.tearDown();
      for (const [name, cfg] of Object.entries(G.CONFIG.Canvas.layers) as [string, any][]) {
        const layer = new cfg.layerClass();
        layer.zIndex = (cfg.layerClass as any).layerOptions.zIndex;
        canvas[name] = layer;
        layers.push(layer);
        iface.addChild(layer);
        await layer.draw();
      }
      canvas.ready = true;
      G.Hooks.callAll("canvasReady", canvas);
    },
    async tearDown() {
      G.Hooks.callAll("canvasTearDown", canvas);
      for (const layer of layers.splice(0)) {
        layer.deactivate?.();
        await layer.tearDown();
        iface.removeChild(layer);
        layer.destroy({ children: true });
      }
      // Primary group tear-down destroys non-layer children (tearDownChildren = true).
      for (const child of [...primary.children]) {
        if (child === bg || tokens.includes(child)) continue;
        primary.removeChild(child);
        child.destroy({ children: true });
      }
      canvas.ready = false;
    },
  };
  G.CONFIG.Canvas.layers.tokens = { layerClass: classes.TokenLayer, group: "interface" };
  G.canvas = canvas;
  canvas.pan({ x: padding + scene.width / 2, y: padding + scene.height / 2, scale: Number(params.get("zoom") ?? 0.5) });
  window.addEventListener("resize", () => canvas.pan({}));

  // Right-drag pans, wheel zooms (like Foundry).
  let drag: { x: number; y: number; px: number; py: number } | null = null;
  view.addEventListener("pointerdown", (e) => {
    if (e.button !== 2) return;
    drag = { x: e.clientX, y: e.clientY, px: stage.pivot.x, py: stage.pivot.y };
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const s = stage.scale.x;
    canvas.pan({ x: drag.px - (e.clientX - drag.x) / s, y: drag.py - (e.clientY - drag.y) / s });
  });
  window.addEventListener("pointerup", (e) => {
    if (e.button === 2) drag = null;
  });
  view.addEventListener("contextmenu", (e) => e.preventDefault());
  view.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const s = Math.min(dims.scale.max, Math.max(dims.scale.min, stage.scale.x * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      const before = canvas.canvasCoordinatesFromClient({ x: e.clientX, y: e.clientY });
      canvas.pan({ scale: s });
      const after = canvas.canvasCoordinatesFromClient({ x: e.clientX, y: e.clientY });
      canvas.pan({ x: stage.pivot.x + (before.x - after.x), y: stage.pivot.y + (before.y - after.y) });
    },
    { passive: false },
  );
  return canvas;
}

export function createSceneControls() {
  const c = new SimSceneControls();
  G.ui.controls = c;
  return c;
}
