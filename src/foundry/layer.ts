import { LAYER_NAME } from "../constants.ts";
import { k } from "../i18n.ts";
import type { Session } from "../session.ts";
import { TOOL_IDS } from "../state/prefs.ts";
import type { ToolId } from "../state/prefs.ts";
import { interactionLayerClass } from "./compat.ts";

/**
 * The module's canvas layer (`canvas.canvasScribble`, interface group).
 *
 * It owns no placeables: activating it routes the primary mouse button to
 * CanvasScribble (see input/pointer.ts) and shows the quick palette; its
 * children hold the "top" map container. Core keys that Foundry dispatches
 * to the active layer (undo, dismiss, cycle view) are handled here.
 */

export interface LayerHooks {
  /** Created at "setup"; the layer class is registered earlier, at "init". */
  readonly session: Session;
  onActivate(active: boolean): void;
  openClearMenu(anchor: HTMLElement | null): void;
  toggleHidden(hidden: boolean): void;
  isHidden(): boolean;
}

const TOOL_ICONS: Record<ToolId, string> = {
  draw: "fa-solid fa-pen-nib",
  highlight: "fa-solid fa-highlighter",
  arrow: "fa-solid fa-arrow-trend-up",
  shape: "fa-regular fa-square",
  laser: "fa-solid fa-wand-sparkles",
  text: "fa-solid fa-font",
  eraser: "fa-solid fa-eraser",
};

const TOOL_LABELS: Record<ToolId, string> = {
  draw: "Tools.Draw",
  highlight: "Tools.Highlight",
  arrow: "Tools.Arrow",
  shape: "Tools.Shape",
  laser: "Tools.Laser",
  text: "Tools.Text",
  eraser: "Tools.Eraser",
};

let hooks: LayerHooks | null = null;
/** Set while CanvasScribble itself drives `ui.controls` (avoid feedback loops). */
let syncing = false;

export function layerHooks(): LayerHooks | null {
  return hooks;
}

/** Keep the scene-control tool highlight in sync with the palette. */
export function syncControlTool(tool: ToolId): void {
  const controls = ui.controls as {
    control?: { name: string } | null;
    tool?: { name: string } | null;
    activate?(o: object): unknown;
  };
  if (!controls?.activate || controls.control?.name !== LAYER_NAME || controls.tool?.name === tool) return;
  syncing = true;
  try {
    void Promise.resolve(controls.activate({ control: LAYER_NAME, tool })).finally(() => (syncing = false));
  } catch {
    syncing = false;
  }
}

export function defineLayer(h: LayerHooks): unknown {
  hooks = h;
  const Base = interactionLayerClass() as unknown as new () => any;

  class CanvasScribbleLayer extends Base {
    static get layerOptions() {
      // InteractionLayer.layerOptions is a getter returning a fresh object.
      return Object.assign((Base as any).layerOptions, { name: LAYER_NAME, zIndex: 750 });
    }

    static prepareSceneControls() {
      const tools: Record<string, object> = {};
      let order = 1;
      for (const id of TOOL_IDS) {
        tools[id] = {
          name: id,
          order: order++,
          title: k(TOOL_LABELS[id]),
          icon: TOOL_ICONS[id],
          onChange: (_event: Event, active: boolean) => {
            if (!active || syncing) return;
            if (h.session.prefs.tool !== id) h.session.setPrefs({ tool: id });
          },
        };
      }
      tools.undo = {
        name: "undo",
        order: order++,
        title: k("Controls.Undo"),
        icon: "fa-solid fa-rotate-left",
        button: true,
        onChange: () => h.session.undo(),
      };
      tools.redo = {
        name: "redo",
        order: order++,
        title: k("Controls.Redo"),
        icon: "fa-solid fa-rotate-right",
        button: true,
        onChange: () => h.session.redo(),
      };
      tools.clear = {
        name: "clear",
        order: order++,
        title: k("Controls.Clear"),
        icon: "fa-solid fa-trash",
        button: true,
        onChange: (event: Event) => h.openClearMenu((event?.target as HTMLElement | null)?.closest?.("button") ?? null),
      };
      tools.visibility = {
        name: "visibility",
        order: order++,
        title: k("Controls.Hide"),
        icon: "fa-solid fa-eye-slash",
        toggle: true,
        active: h.isHidden(),
        onChange: (_event: Event, active: boolean) => h.toggleHidden(active),
      };
      return {
        name: LAYER_NAME,
        order: 25,
        title: k("Controls.Group"),
        icon: "fa-solid fa-signature",
        layer: LAYER_NAME,
        visible: h.session.can("screen") || h.session.can("map"),
        onChange: (_event: Event, active: boolean) => {
          if (active) (canvas as any)[LAYER_NAME]?.activate();
        },
        tools,
        activeTool: h.session.prefs.tool,
      };
    }

    _activate() {
      h.onActivate(true);
    }

    _deactivate() {
      h.session.cancelGesture();
      h.onActivate(false);
    }

    _onUndoKey(_event: KeyboardEvent) {
      h.session.undo();
      return true;
    }

    _onDismissKey(_event: KeyboardEvent) {
      return h.session.cancelGesture();
    }

    _onCycleViewKey(_event: KeyboardEvent) {
      h.session.setPrefs({ mode: h.session.prefs.mode === "screen" ? "map" : "screen" });
      return true;
    }

    _onDeleteKey(_event: KeyboardEvent) {
      return false;
    }
  }

  Object.defineProperty(CanvasScribbleLayer, "name", { value: "CanvasScribbleLayer" });
  return CanvasScribbleLayer;
}
