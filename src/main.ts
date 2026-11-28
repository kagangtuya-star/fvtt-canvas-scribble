import { LAYER_NAME, MODULE_ID } from "./constants.ts";
import { clearTextLayoutCache } from "./core/text-layout.ts";
import { registerKeybindings } from "./foundry/keybindings.ts";
import { defineLayer, syncControlTool } from "./foundry/layer.ts";
import * as settings from "./foundry/settings.ts";
import { PointerInput } from "./input/pointer.ts";
import type { ClearScope } from "./net/protocol.ts";
import { SceneRenderer } from "./render/renderer.ts";
import { stats } from "./render/stats.ts";
import { Session } from "./session.ts";
import type { Prefs, ToolId } from "./state/prefs.ts";
import { TOOL_IDS } from "./state/prefs.ts";
import { openClearMenu, runClear } from "./ui/clear-menu.ts";
import { BrushCursor } from "./ui/cursor.ts";
import { GuidesOverlay } from "./ui/guides.ts";
import { DebugPanel, NameTags } from "./ui/overlay.ts";
import { Palette } from "./ui/palette.ts";
import { TextEditor } from "./ui/text-editor.ts";

/**
 * Module entry: wires settings, the canvas layer, input, rendering, UI and
 * the public API (`game.modules.get("canvas-scribble").api`).
 */

interface App {
  session: Session;
  palette: Palette;
  cursor: BrushCursor;
  guides: GuidesOverlay;
  input: PointerInput;
  text: TextEditor;
  names: NameTags;
  debug: DebugPanel;
  renderer: SceneRenderer | null;
  hidden: boolean;
}

let app: App | null = null;

const layer = (): { active: boolean; activate(o?: object): unknown } | undefined => (canvas as any)?.[LAYER_NAME];

function paletteWanted(a: App): boolean {
  if (!canvas?.ready || !a.session.scene) return false;
  if (!a.session.can("screen") && !a.session.can("map")) return false;
  switch (settings.paletteSetting()) {
    case "never":
      return false;
    case "always":
      return true;
    default:
      return !!layer()?.active || !!a.session.hold;
  }
}

function refreshUI(): void {
  if (!app) return;
  app.palette.show(paletteWanted(app));
  app.palette.render();
  app.cursor.refresh();
  app.guides.setActive(boardEnabled());
}

function setHidden(hidden: boolean): void {
  if (!app) return;
  app.hidden = hidden;
  if (app.renderer) app.renderer.hidden = hidden;
  refreshUI();
}

function boardEnabled(): boolean {
  if (!app || !canvas?.ready || !app.session.scene || app.hidden) return false;
  return !!layer()?.active || !!app.session.hold;
}

Hooks.once("init", () => {
  settings.registerSettings();
  registerKeybindings(() => app?.session ?? null, {
    onHoldChange: () => {
      refreshUI();
      app?.cursor.refresh();
    },
  });
  const layerClass = defineLayer({
    get session() {
      return app!.session;
    },
    onActivate: () => refreshUI(),
    openClearMenu: (anchor) => app && openClearMenu(app.session, anchor),
    toggleHidden: (hidden) => setHidden(hidden),
    isHidden: () => app?.hidden ?? false,
  });
  CONFIG.Canvas.layers[LAYER_NAME] = { layerClass, group: "interface" };
});

Hooks.once("setup", () => {
  const session = new Session(game.socket);
  const a: App = {
    session,
    palette: new Palette(session, {
      openClearMenu: (anchor) => openClearMenu(session, anchor),
      hidden: () => app?.hidden ?? false,
    }),
    cursor: new BrushCursor(session),
    guides: new GuidesOverlay(session),
    input: null as unknown as PointerInput,
    text: new TextEditor(session),
    names: new NameTags(session),
    debug: new DebugPanel(session),
    renderer: null,
    hidden: false,
  };
  a.input = new PointerInput(session, () => (canvas?.app?.view as HTMLElement | undefined) ?? null, boardEnabled);
  a.input.onPointer = (cx, cy, over, type) => a.cursor.update(cx, cy, over, type);
  session.onTextRequest = (req) => a.text.open(req);
  session.onTextEditingChange = (id) => a.renderer?.setEditingText(id);
  session.onRefresh = () => a.renderer?.refresh();
  session.media.onDisplay = (key, data) => a.renderer?.media.show(key, data);
  session.onChange(() => {
    a.cursor.refresh();
    a.palette.show(paletteWanted(a));
    if (layer()?.active) syncControlTool(session.prefs.tool);
  });
  session.log = (text, data) => {
    if (settings.debugEnabled()) console.debug(`CanvasScribble | ${text}`, data ?? "");
  };
  settings.onSettingsChange(() => {
    session.rebuildSpaces();
    session.media.settingsChanged();
    a.renderer?.refresh();
    a.debug.show(settings.debugEnabled());
    refreshUI();
  });
  app = a;
  const fontsChanged = () => {
    clearTextLayoutCache();
    session.store.refreshTextBounds();
    a.text.refresh();
    a.guides.refresh();
  };
  void document.fonts.ready.then(fontsChanged);
  document.fonts.addEventListener("loadingdone", fontsChanged);
  a.debug.show(settings.debugEnabled());

  const module = game.modules.get(MODULE_ID);
  if (module) module.api = api;
});

Hooks.on("canvasReady", () => {
  if (!app) return;
  const a = app;
  a.renderer?.destroy();
  a.renderer = null;
  const scene = canvas.scene;
  if (!scene) {
    a.session.detach();
    refreshUI();
    return;
  }
  a.session.attach(scene);
  const top = (canvas as any)[LAYER_NAME] as PIXI.Container | undefined;
  if (top && canvas.primary && canvas.overlay) {
    a.renderer = new SceneRenderer(a.session, {
      primary: canvas.primary,
      top,
      overlay: canvas.overlay,
      ticker: canvas.app.ticker,
    });
    a.renderer.hidden = a.hidden;
    for (const [key, data] of a.session.media.displays()) a.renderer.media.show(key, data);
    a.debug.attach(a.renderer);
    a.renderer.onFrame = (info) => {
      a.debug.frame(info);
      a.names.update(settings.showNames(), a.hidden);
    };
  }
  refreshUI();
});

Hooks.on("canvasTearDown", () => {
  if (!app) return;
  app.text.cancel();
  app.renderer?.destroy();
  app.renderer = null;
  app.debug.attach(null);
  app.session.detach();
  app.palette.show(false);
  app.cursor.hide();
  app.guides.setActive(false);
  app.names.update(false, true);
});

Hooks.on("updateScene", (scene: FoundryScene, changes: Record<string, unknown>) =>
  app?.session.onSceneUpdate(scene, changes),
);
Hooks.on("canvasPan", () => {
  app?.cursor.refresh();
  app?.guides.refresh();
  app?.text.refresh();
});
Hooks.on("userConnected", (user: FoundryUser, connected: boolean) => {
  if (!connected) app?.session.onUserGone(user.id);
});
Hooks.on("renderSceneControls", () => {
  // The palette docks above the hotbar; re-dock if the UI was re-rendered.
  if (app?.palette.shown) app.palette.show(true);
});
window.addEventListener("resize", () => {
  if (!app) return;
  app.session.updateViewport();
  app.cursor.refresh();
  app.guides.refresh();
  app.text.refresh();
});

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

const api = {
  /** The live session (store, history, prefs). */
  get session(): Session | null {
    return app?.session ?? null;
  },
  /** Render/socket counters. */
  stats,
  undo: () => app?.session.undo(),
  redo: () => app?.session.redo(),
  /** Clear a scope; risky scopes ask for confirmation. */
  clear: (scope: ClearScope) => (app ? runClear(app.session, scope) : Promise.resolve()),
  setTool: (tool: ToolId) => {
    if (TOOL_IDS.includes(tool)) app?.session.setPrefs({ tool });
  },
  setMode: (mode: Prefs["mode"]) => app?.session.setPrefs({ mode }),
  /** Activate the CanvasScribble layer (optionally with a tool). */
  activate: (tool?: ToolId) => {
    if (tool) api.setTool(tool);
    layer()?.activate();
  },
  /** Hide or show every scribble for this client. */
  setHidden,
};

export type CanvasScribbleApi = typeof api;
