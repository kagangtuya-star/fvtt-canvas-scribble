import { LAYER_NAME, MODULE_ID } from "../constants.ts";
import { k } from "../i18n.ts";
import type { HoldMode, Session } from "../session.ts";

/**
 * Keybindings (all editable in Configure Controls). Hold keys draw while
 * pressed, whatever layer is active; they are released on keyup, on window
 * blur and when the page is hidden, so a missed keyup can never leave a
 * mode stuck on.
 *
 * Defaults avoid core bindings (v13: Q/E zoom, R ruler, T target, C sheet,
 * WASD pan, Space pause, F waypoint, U unconstrained, Alt highlight).
 */

const layerActive = (): boolean => !!(canvas as any)?.[LAYER_NAME]?.active;

export function registerKeybindings(getSession: () => Session | null, ui: { onHoldChange(): void }): void {
  const register = (key: string, config: Parameters<FoundryGame["keybindings"]["register"]>[2]) =>
    game.keybindings.register(MODULE_ID, key, config);
  const PRIORITY = CONST.KEYBINDING_PRECEDENCE?.PRIORITY ?? 0;
  const NORMAL = CONST.KEYBINDING_PRECEDENCE?.NORMAL ?? 1;
  let heldCode: string | null = null;

  const hold = (mode: HoldMode, keyName: string, defaults: { key: string; modifiers?: string[] }[]) =>
    register(`hold${keyName}`, {
      name: k(`Keys.Hold${keyName}.Name`),
      hint: k(`Keys.Hold${keyName}.Hint`),
      editable: defaults,
      precedence: NORMAL,
      repeat: false,
      onDown: (ctx) => {
        const s = getSession();
        if (!s || !canvas?.ready || ctx.repeat) return false;
        if (s.hold === mode) return true;
        s.cancelGesture();
        s.hold = mode;
        heldCode = ctx.event?.code ?? null;
        ui.onHoldChange();
        return true;
      },
      onUp: () => {
        const s = getSession();
        if (!s || s.hold !== mode) return false;
        release();
        return true;
      },
    });

  const release = () => {
    const s = getSession();
    if (!s || !s.hold) return;
    // A stroke in progress is finished by its pointerup; the hold only changes what the *next* stroke does.
    s.hold = null;
    heldCode = null;
    ui.onHoldChange();
  };

  hold("screen", "Screen", [{ key: "KeyZ" }]);
  hold("map", "Map", [{ key: "KeyX" }]);
  hold("laser", "Laser", [{ key: "KeyV" }]);
  hold("eraser", "Eraser", []);

  register("undo", {
    name: k("Keys.Undo.Name"),
    hint: k("Keys.Undo.Hint"),
    editable: [{ key: "KeyZ", modifiers: ["Alt"] }],
    precedence: NORMAL,
    onDown: () => {
      const s = getSession();
      if (!s?.scene) return false;
      s.undo();
      return true;
    },
  });

  register("redo", {
    name: k("Keys.Redo.Name"),
    hint: k("Keys.Redo.Hint"),
    editable: [
      { key: "KeyZ", modifiers: ["Control", "Shift"] },
      { key: "KeyY", modifiers: ["Control"] },
    ],
    precedence: PRIORITY,
    onDown: () => {
      const s = getSession();
      if (!s?.scene || !layerActive()) return false;
      s.redo();
      return true;
    },
  });

  register("sizeDown", {
    name: k("Keys.SizeDown.Name"),
    editable: [{ key: "BracketLeft" }],
    precedence: PRIORITY,
    repeat: true,
    onDown: () => {
      const s = getSession();
      if (!s || (!layerActive() && !s.hold)) return false;
      s.nudgeSize(-1);
      return true;
    },
  });

  register("sizeUp", {
    name: k("Keys.SizeUp.Name"),
    editable: [{ key: "BracketRight" }],
    precedence: PRIORITY,
    repeat: true,
    onDown: () => {
      const s = getSession();
      if (!s || (!layerActive() && !s.hold)) return false;
      s.nudgeSize(1);
      return true;
    },
  });

  register("angleLeft", {
    name: k("Keys.AngleLeft.Name"),
    editable: [{ key: "Comma" }],
    precedence: PRIORITY,
    repeat: true,
    onDown: (ctx) => {
      const s = getSession();
      if (!s || (!layerActive() && !s.hold)) return false;
      s.nudgeAngle(-1, ctx.isShift ? 5 : 15);
      return true;
    },
  });

  register("angleRight", {
    name: k("Keys.AngleRight.Name"),
    editable: [{ key: "Period" }],
    precedence: PRIORITY,
    repeat: true,
    onDown: (ctx) => {
      const s = getSession();
      if (!s || (!layerActive() && !s.hold)) return false;
      s.nudgeAngle(1, ctx.isShift ? 5 : 15);
      return true;
    },
  });

  register("eyedropper", {
    name: k("Keys.Eyedropper.Name"),
    editable: [{ key: "KeyI" }],
    precedence: PRIORITY,
    onDown: () => {
      const s = getSession();
      if (!s || !layerActive()) return false;
      s.setPrefs({ tool: "eyedropper" });
      return true;
    },
  });

  register("swapColors", {
    name: k("Keys.SwapColors.Name"),
    editable: [{ key: "KeyX", modifiers: ["Shift"] }],
    precedence: PRIORITY,
    onDown: () => {
      const s = getSession();
      if (!s || !layerActive()) return false;
      s.swapColors();
      return true;
    },
  });

  register("duplicate", {
    name: k("Keys.Duplicate.Name"),
    editable: [{ key: "KeyD", modifiers: ["Control"] }],
    precedence: PRIORITY,
    onDown: () => {
      const s = getSession();
      if (!s || !layerActive()) return false;
      return s.duplicateSelected();
    },
  });

  register("selectAll", {
    name: k("Keys.SelectAll.Name"),
    editable: [{ key: "KeyA", modifiers: ["Control"] }],
    precedence: PRIORITY,
    onDown: () => {
      const s = getSession();
      if (!s?.scene || !layerActive() || s.effective().tool !== "select") return false;
      s.selectAll();
      return true;
    },
  });

  register("cancel", {
    name: k("Keys.Cancel.Name"),
    hint: k("Keys.Cancel.Hint"),
    editable: [{ key: "Escape" }],
    precedence: PRIORITY,
    onDown: () => getSession()?.dismiss() ?? false,
  });

  register("finish", {
    name: k("Keys.Finish.Name"),
    editable: [{ key: "Enter" }],
    precedence: PRIORITY,
    onDown: () => getSession()?.finishGesture() ?? false,
  });

  register("toggleLayer", {
    name: k("Keys.Toggle.Name"),
    hint: k("Keys.Toggle.Hint"),
    editable: [],
    precedence: NORMAL,
    onDown: () => {
      const layer = (canvas as any)?.[LAYER_NAME];
      if (!layer) return false;
      if (layer.active) (canvas as any).tokens?.activate();
      else layer.activate();
      return true;
    },
  });

  // Safety net for hold keys: keyup by physical code and focus loss.
  window.addEventListener(
    "keyup",
    (e) => {
      if (heldCode && e.code === heldCode) release();
    },
    true,
  );
  window.addEventListener("blur", release);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) release();
  });
}
