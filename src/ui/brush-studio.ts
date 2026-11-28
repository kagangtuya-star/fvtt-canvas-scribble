import { BRUSHES, DRAW_BRUSHES, diffBrushOverride, resolveBrushParams } from "../brush/brushes.ts";
import type { BrushCategory } from "../brush/brushes.ts";
import { ctx2d, paintItemLayer } from "../brush/paint.ts";
import { StrokeRecorder } from "../brush/recorder.ts";
import type { InputSample } from "../brush/recorder.ts";
import { STABILIZER_MODES } from "../brush/stabilizer.ts";
import { SYMMETRY_MODES } from "../brush/symmetry.ts";
import { ANGLE_MODES, BLEND_MODES, SCHEMA_VERSION } from "../core/types.ts";
import type { AngleMode, BlendMode, BrushId, BrushOverride, ScribbleItem } from "../core/types.ts";
import { randomId } from "../core/util.ts";
import { t, tf } from "../i18n.ts";
import type { Session } from "../session.ts";
import { activeBrushId, brushBlend, brushOpacity, normalizePrefs } from "../state/prefs.ts";
import type { BrushPreset, Prefs } from "../state/prefs.ts";
import { h, icon } from "./dom.ts";
import { buildDynamicsSection } from "./dynamics-editor.ts";
import type { DynamicsSection } from "./dynamics-editor.ts";

/**
 * Brush Studio & Drawing Aids popovers:
 *  - Full categorized brush gallery (Ink / Flat & Rectangular / Dry / Wet / FX)
 *  - Live stroke preview canvas driven by the real Canvas 2D painter
 *  - Parameter sliders: opacity, blend mode, nib angle, angle mode, aspect,
 *    corner roundness, hardness, flow, spacing, scatter, grain
 *  - Dynamics: sensor → parameter mappings with response curves; the preview
 *    doubles as a test pad (draw on it with the pen, the stroke stays while
 *    the settings change)
 *  - Custom preset management (save, apply, delete, JSON export/import)
 *  - Drawing Aids: Stabilizer (Off / 1€ / Lazy), Symmetry, QuickShape, Grid Snap
 */

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const CATEGORIES: readonly BrushCategory[] = ["ink", "flat", "dry", "wet", "fx"];

/** Build a smooth pressure-wave test stroke for the live studio preview (with tilt and speed sweeps). */
function previewPoints(
  w: number,
  hgt: number,
): { points: number[]; angles?: number[]; tilt: number[]; speed: number[] } {
  const pts: number[] = [];
  const tilt: number[] = [];
  const speed: number[] = [];
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const x = 18 + f * (w - 36);
    const y = hgt / 2 + Math.sin(f * Math.PI * 2) * (hgt * 0.24);
    const p = 0.22 + Math.sin(f * Math.PI) * 0.72;
    pts.push(x, y, p);
    tilt.push(f);
    speed.push(0.5 + 0.45 * Math.cos(f * Math.PI * 3));
  }
  return { points: pts, tilt, speed };
}

/** The user's test stroke on the preview; kept across popover rebuilds (per brush). */
let trial: { brush: BrushId; points: number[]; angles?: number[]; tilt?: number[]; speed?: number[] } | null = null;
/** Studio scroll position, restored after a rebuild. */
let studioScroll = 0;

export function buildBrushStudio(session: Session): HTMLElement {
  const wrap = h("div", { class: "cs-studio" });
  const p = session.prefs;
  const brushId: BrushId = activeBrushId(p) ?? p.brush;
  const brush = BRUSHES[brushId];
  const resolved = resolveBrushParams(brush, p.brushParams[brushId]);
  const curOpacity = brushOpacity(p, brushId);
  const curBlend = brushBlend(p, brushId);

  // 1. Live stroke preview canvas
  const PW = 264;
  const PH = 64;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = h("canvas", { class: "cs-studio-preview" }) as HTMLCanvasElement;
  canvas.width = PW * dpr;
  canvas.height = PH * dpr;
  canvas.style.width = `${PW}px`;
  canvas.style.height = `${PH}px`;
  canvas.style.touchAction = "none";
  canvas.dataset.tooltip = t("Studio.DynTry");
  const sample = previewPoints(PW, PH);
  const previewSize = Math.min(26, Math.max(3, session.prefs.sizes[brushId] * brush.widthScale));
  let lastOverride: BrushOverride | undefined;
  let dynSection: DynamicsSection | null = null;

  const renderPreview = (override?: BrushOverride, opacity = curOpacity) => {
    lastOverride = override;
    const c = ctx2d(canvas);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, canvas.width, canvas.height);
    const size = previewSize;
    const stroke = trial?.brush === brushId ? trial : sample;
    // The preview stores what a real stroke would: dynamics equal to the built-in response are dropped.
    const ov = diffBrushOverride(brush, override ?? session.prefs.brushParams[brushId]);
    const dummy: ScribbleItem = {
      schemaVersion: SCHEMA_VERSION,
      id: "studio-preview",
      author: "me",
      scene: "preview",
      mode: "screen",
      kind: "stroke",
      tool: brushId,
      color: session.color(),
      opacity,
      size,
      points: stroke.points,
      ...(stroke.angles ? { angles: stroke.angles } : {}),
      ...(stroke.tilt ? { tilt: stroke.tilt } : {}),
      ...(stroke.speed ? { speed: stroke.speed } : {}),
      style: { halo: session.prefs.halo && brush.halo, ...(ov ? { brush: ov } : {}) },
      createdAt: 0,
      expiresAt: null,
      fadeDuration: 0,
      layer: "top",
      visibility: "all",
      revision: 0,
    };
    const layer = document.createElement("canvas");
    layer.width = canvas.width;
    layer.height = canvas.height;
    paintItemLayer(ctx2d(layer), dummy, { scale: dpr, ox: 0, oy: 0 });
    c.globalAlpha = opacity;
    c.drawImage(layer, 0, 0);
    c.globalAlpha = 1;
  };
  renderPreview();
  wrap.append(canvas);

  // Test pad: draw on the preview with the current settings.
  let rec: StrokeRecorder | null = null;
  const toSample = (e: PointerEvent): InputSample => {
    const r = canvas.getBoundingClientRect();
    return {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      time: e.timeStamp,
      pressure: e.pressure,
      pointerType: e.pointerType || "mouse",
      tiltX: e.tiltX,
      tiltY: e.tiltY,
      twist: e.twist,
      altitudeAngle: (e as PointerEvent & { altitudeAngle?: number }).altitudeAngle,
    };
  };
  const monitor = () => {
    const pts = trial?.points;
    if (!dynSection || !pts || pts.length < 3) return;
    const n = pts.length / 3;
    const heading = (i: number, j: number) => Math.atan2(pts[j * 3 + 1]! - pts[i * 3 + 1]!, pts[j * 3]! - pts[i * 3]!);
    dynSection.monitor({
      p: pts[(n - 1) * 3 + 2]!,
      t: trial?.tilt?.at(-1) ?? 0,
      v: trial?.speed?.at(-1) ?? 0,
      tan: n > 1 ? heading(Math.max(0, n - 3), n - 1) : 0,
      tan0: n > 1 ? heading(0, Math.min(n - 1, 2)) : 0,
    });
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    rec = new StrokeRecorder({
      width: previewSize,
      streamline: brush.streamline,
      pressureMode: session.pressureMode(),
      usesPressure: true,
      usesTilt: false,
      recordAngles: brush.recordsAngles,
      recordTilt: true,
      recordSpeed: true,
      dynamics: diffBrushOverride(brush, lastOverride ?? session.prefs.brushParams[brushId])?.dyn,
      unitsPerPx: 1,
      minDistance: 0.6,
      tolerance: 0.35,
    });
    rec.add(toSample(e));
    trial = { brush: brushId, ...rec.previewData() };
    canvas.setPointerCapture?.(e.pointerId);
    renderPreview(lastOverride);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!rec) return;
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) rec.add(toSample(ev));
    trial = { brush: brushId, ...rec.previewData() };
    renderPreview(lastOverride);
    monitor();
  });
  const endTrial = () => {
    if (!rec) return;
    rec.finishTip(false);
    const done = rec.finishWithAngles();
    rec = null;
    if (done.points.length >= 6) trial = { brush: brushId, ...done };
    renderPreview(lastOverride);
    dynSection?.monitor(null);
  };
  canvas.addEventListener("pointerup", endTrial);
  canvas.addEventListener("pointercancel", endTrial);
  canvas.addEventListener("dblclick", () => {
    trial = null;
    renderPreview(lastOverride);
  });

  // 2. Categorized Brush Picker (when in draw mode)
  if (p.tool === "draw") {
    const picker = h("div", { class: "cs-studio-brushes" });
    for (const cat of CATEGORIES) {
      const list = DRAW_BRUSHES.filter((id) => BRUSHES[id].category === cat);
      if (!list.length) continue;
      const row = h("div", { class: "cs-cat-row" }, h("span", { class: "cs-cat-name" }, t(`BrushCat.${cap(cat)}`)));
      const chips = h("div", { class: "cs-cat-chips" });
      for (const id of list) {
        const b = BRUSHES[id];
        const btn = h(
          "button",
          {
            type: "button",
            class: `cs-preset ${p.brush === id ? "active" : ""}`,
            "data-tooltip": t(`Brush.${cap(id)}`),
          },
          icon(b.icon),
          h("span", {}, t(`Brush.${cap(id)}`)),
        );
        btn.addEventListener("click", () => session.setPrefs({ brush: id as Prefs["brush"] }));
        chips.append(btn);
      }
      row.append(chips);
      picker.append(row);
    }
    wrap.append(picker);
  }

  // Helper to commit a parameter patch cleanly
  const patchParam = (patch: Partial<BrushOverride>) => {
    const nextOv = { ...(session.prefs.brushParams[brushId] ?? {}), ...patch };
    session.setPrefs({ brushParams: { ...session.prefs.brushParams, [brushId]: nextOv } });
  };

  const sliderRow = (
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    fmt: (v: number) => string,
    onLive: (v: number) => void,
    onCommit: (v: number) => void,
  ) => {
    const out = h("output", { class: "cs-studio-val" }, fmt(value));
    const input = h("input", {
      type: "range",
      min,
      max,
      step,
      value,
      "aria-label": label,
    }) as HTMLInputElement;
    input.addEventListener("input", () => {
      const v = Number(input.value);
      out.textContent = fmt(v);
      onLive(v);
    });
    input.addEventListener("change", () => onCommit(Number(input.value)));
    return h("label", { class: "cs-studio-row" }, h("span", {}, label), input, out);
  };

  // 3. Core Studio Controls
  const controls = h("div", { class: "cs-studio-controls" });
  controls.append(
    sliderRow(
      t("Studio.Opacity"),
      5,
      100,
      1,
      Math.round(curOpacity * 100),
      (v) => `${v}%`,
      (v) => renderPreview(undefined, v / 100),
      (v) => session.setPrefs({ opacities: { ...session.prefs.opacities, [brushId]: v / 100 } }),
    ),
  );

  // Blend mode selector
  const blendSel = h("select", { class: "cs-studio-select", "aria-label": t("Studio.Blend") }) as HTMLSelectElement;
  for (const bm of BLEND_MODES) {
    const opt = h("option", { value: bm }, t(`Blend.${cap(bm)}`)) as HTMLOptionElement;
    if (bm === curBlend) opt.selected = true;
    blendSel.append(opt);
  }
  blendSel.addEventListener("change", () =>
    session.setPrefs({ blends: { ...session.prefs.blends, [brushId]: blendSel.value as BlendMode } }),
  );
  controls.append(h("label", { class: "cs-studio-row" }, h("span", {}, t("Studio.Blend")), blendSel));

  // Rectangular / Flat / Dab nib controls
  const isNib = brush.renderer === "chisel" || brush.renderer === "dab";
  if (isNib && !brush.pixelAligned) {
    controls.append(
      sliderRow(
        t("Studio.Angle"),
        -180,
        180,
        5,
        Math.round(resolved.angle),
        (v) => `${v}°`,
        (v) => renderPreview({ ...session.prefs.brushParams[brushId], ang: v }),
        (v) => patchParam({ ang: v }),
      ),
    );
    const amSel = h("select", { class: "cs-studio-select", "aria-label": t("Studio.AngleMode") }) as HTMLSelectElement;
    for (const am of ANGLE_MODES) {
      const opt = h("option", { value: am }, t(`AngleMode.${cap(am)}`)) as HTMLOptionElement;
      if (am === resolved.angleMode) opt.selected = true;
      amSel.append(opt);
    }
    amSel.addEventListener("change", () => patchParam({ am: amSel.value as AngleMode }));
    controls.append(h("label", { class: "cs-studio-row" }, h("span", {}, t("Studio.AngleMode")), amSel));

    controls.append(
      sliderRow(
        t("Studio.Aspect"),
        5,
        100,
        1,
        Math.round(resolved.aspect * 100),
        (v) => `${v}%`,
        (v) => renderPreview({ ...session.prefs.brushParams[brushId], asp: v / 100 }),
        (v) => patchParam({ asp: v / 100 }),
      ),
    );
    if (brush.tip === "rect") {
      controls.append(
        sliderRow(
          t("Studio.Corner"),
          0,
          100,
          5,
          Math.round(resolved.corner * 100),
          (v) => `${v}%`,
          (v) => renderPreview({ ...session.prefs.brushParams[brushId], cor: v / 100 }),
          (v) => patchParam({ cor: v / 100 }),
        ),
      );
    }
  }

  if (brush.renderer === "dab" && !brush.pixelAligned) {
    controls.append(
      sliderRow(
        t("Studio.Hardness"),
        0,
        100,
        5,
        Math.round(resolved.hardness * 100),
        (v) => `${v}%`,
        (v) => renderPreview({ ...session.prefs.brushParams[brushId], hrd: v / 100 }),
        (v) => patchParam({ hrd: v / 100 }),
      ),
      sliderRow(
        t("Studio.Flow"),
        5,
        100,
        5,
        Math.round(resolved.flow * 100),
        (v) => `${v}%`,
        (v) => renderPreview({ ...session.prefs.brushParams[brushId], flw: v / 100 }),
        (v) => patchParam({ flw: v / 100 }),
      ),
      sliderRow(
        t("Studio.Spacing"),
        8,
        200,
        2,
        Math.round(resolved.spacing * 100),
        (v) => `${v}%`,
        (v) => renderPreview({ ...session.prefs.brushParams[brushId], spc: v / 100 }),
        (v) => patchParam({ spc: v / 100 }),
      ),
      sliderRow(
        t("Studio.Scatter"),
        0,
        250,
        5,
        Math.round(resolved.scatter * 100),
        (v) => `${v}%`,
        (v) => renderPreview({ ...session.prefs.brushParams[brushId], sct: v / 100 }),
        (v) => patchParam({ sct: v / 100 }),
      ),
    );
  }

  if (brush.grainKind !== "none" || brush.renderer === "pencil" || brush.renderer === "watercolor") {
    controls.append(
      sliderRow(
        t("Studio.Grain"),
        0,
        100,
        5,
        Math.round(resolved.grain * 100),
        (v) => `${v}%`,
        (v) => renderPreview({ ...session.prefs.brushParams[brushId], grn: v / 100 }),
        (v) => patchParam({ grn: v / 100 }),
      ),
    );
  }
  wrap.append(controls);

  // 4. Dynamics (sensor → parameter mappings with response curves)
  dynSection = buildDynamicsSection(session, brushId, sliderRow, (dyn) =>
    renderPreview({ ...(session.prefs.brushParams[brushId] ?? {}), ...(dyn ? { dyn } : {}) }),
  );
  wrap.append(dynSection.element);

  // 5. Custom Presets & Reset bar
  const presetBar = h("div", { class: "cs-studio-presets" });
  const presetActions = h("div", { class: "cs-presets" });

  const resetBtn = h(
    "button",
    { type: "button", class: "cs-preset" },
    icon("fa-solid fa-rotate-left"),
    t("Studio.Reset"),
  );
  resetBtn.addEventListener("click", () => {
    const bp = { ...session.prefs.brushParams };
    const op = { ...session.prefs.opacities };
    const bl = { ...session.prefs.blends };
    delete bp[brushId];
    delete op[brushId];
    delete bl[brushId];
    session.setPrefs({ brushParams: bp, opacities: op, blends: bl });
  });
  presetActions.append(resetBtn);

  if (brushId !== "highlighter") {
    const saveBtn = h(
      "button",
      { type: "button", class: "cs-preset" },
      icon("fa-solid fa-bookmark"),
      t("Studio.SavePreset"),
    );
    saveBtn.addEventListener("click", () => {
      const name = window.prompt(
        t("Studio.PresetName"),
        `${t(`Brush.${cap(brushId)}`)} ${session.prefs.presets.length + 1}`,
      );
      if (!name?.trim()) return;
      const preset: BrushPreset = {
        id: randomId(10),
        name: name.trim().slice(0, 40),
        base: brushId,
        size: session.prefs.sizes[brushId],
        opacity: curOpacity,
        blend: curBlend,
        params: { ...(session.prefs.brushParams[brushId] ?? {}) },
      };
      session.setPrefs({ presets: [...session.prefs.presets, preset] });
    });
    presetActions.append(saveBtn);
  }

  const exportBtn = h(
    "button",
    { type: "button", class: "cs-preset", "data-tooltip": t("Studio.Export") },
    icon("fa-solid fa-file-export"),
  );
  exportBtn.addEventListener("click", () => {
    const json = JSON.stringify(session.prefs.presets, null, 2);
    void navigator.clipboard?.writeText(json).catch(() => undefined);
    window.prompt(t("Studio.ExportPrompt"), json);
  });
  const importBtn = h(
    "button",
    { type: "button", class: "cs-preset", "data-tooltip": t("Studio.Import") },
    icon("fa-solid fa-file-import"),
  );
  importBtn.addEventListener("click", () => {
    const raw = window.prompt(t("Studio.ImportPrompt"));
    if (!raw?.trim()) return;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const cleaned = normalizePrefs({ presets: [...session.prefs.presets, ...parsed] }).presets;
      session.setPrefs({ presets: cleaned });
    } catch {
      /* ignore invalid JSON */
    }
  });
  presetActions.append(exportBtn, importBtn);
  presetBar.append(presetActions);

  if (session.prefs.presets.length) {
    const list = h("div", { class: "cs-presets cs-preset-list" });
    for (const pr of session.prefs.presets) {
      const item = h("div", { class: "cs-preset-chip" });
      const apply = h("button", { type: "button", class: "cs-preset" }, icon(BRUSHES[pr.base].icon), pr.name);
      apply.addEventListener("click", () => {
        session.setPrefs({
          tool: "draw",
          brush: pr.base,
          sizes: { ...session.prefs.sizes, [pr.base]: pr.size },
          opacities: { ...session.prefs.opacities, [pr.base]: pr.opacity },
          blends: { ...session.prefs.blends, [pr.base]: pr.blend },
          brushParams: { ...session.prefs.brushParams, [pr.base]: pr.params },
        });
      });
      const del = h(
        "button",
        { type: "button", class: "cs-preset cs-preset-del", "aria-label": t("Select.Delete") },
        "×",
      );
      del.addEventListener("click", () => {
        session.setPrefs({ presets: session.prefs.presets.filter((x) => x.id !== pr.id) });
      });
      item.append(apply, del);
      list.append(item);
    }
    presetBar.append(h("span", { class: "cs-label" }, t("Studio.Presets")), list);
  }
  wrap.append(presetBar);

  // The popover is rebuilt after every change: keep the scroll position.
  wrap.addEventListener("scroll", () => (studioScroll = wrap.scrollTop), { passive: true });
  requestAnimationFrame(() => {
    if (wrap.isConnected) wrap.scrollTop = studioScroll;
  });
  return wrap;
}

export function buildAidsMenu(session: Session): HTMLElement {
  const p = session.prefs;
  const wrap = h("div", { class: "cs-aids" });

  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    unit: string,
    set: (v: number) => void,
  ) => {
    const out = h("output", { class: "cs-studio-val" }, `${value}${unit}`);
    const sl = h("input", { type: "range", min, max, step, value, "aria-label": label }) as HTMLInputElement;
    sl.addEventListener("input", () => (out.textContent = `${sl.value}${unit}`));
    sl.addEventListener("change", () => set(Number(sl.value)));
    return h("label", { class: "cs-studio-row" }, h("span", {}, label), sl, out);
  };
  const toggle = (cls: string, label: string, on: boolean, click: () => void, hint?: string) => {
    const b = h(
      "button",
      {
        type: "button",
        class: `cs-preset ${on ? "active" : ""}`,
        "aria-pressed": String(on),
        "data-tooltip": hint ?? null,
      },
      icon(cls),
      label,
    );
    b.addEventListener("click", click);
    return b;
  };

  // Stabilizer: dejitter (always-on smoothing of hand tremor), the stabilizer proper, post-smoothing.
  wrap.append(
    slider(t("Aids.Dejitter"), Math.round(p.dejitter * 100), 0, 100, 5, "%", (v) =>
      session.setPrefs({ dejitter: v / 100 }),
    ),
  );
  const stabRow = h("div", { class: "cs-presets" });
  for (const mode of STABILIZER_MODES) {
    const b = h(
      "button",
      { type: "button", class: `cs-preset ${p.stabilizer === mode ? "active" : ""}` },
      t(`Stabilizer.${cap(mode)}`),
    );
    b.addEventListener("click", () => session.setPrefs({ stabilizer: mode }));
    stabRow.append(b);
  }
  wrap.append(h("span", { class: "cs-label" }, t("Aids.Stabilizer")), stabRow);
  if (p.stabilizer !== "off") {
    wrap.append(
      slider(t("Aids.Strength"), Math.round(p.stabilizerStrength * 100), 5, 100, 5, "%", (v) =>
        session.setPrefs({ stabilizerStrength: v / 100 }),
      ),
      h(
        "div",
        { class: "cs-presets" },
        toggle(
          "fa-solid fa-flag-checkered",
          t("Aids.Finish"),
          p.stabilizerFinish,
          () => session.setPrefs({ stabilizerFinish: !p.stabilizerFinish }),
          t("Aids.FinishHint"),
        ),
      ),
    );
  }
  wrap.append(
    slider(t("Aids.Smoothing"), Math.round(p.smoothing * 100), 0, 100, 5, "%", (v) =>
      session.setPrefs({ smoothing: v / 100 }),
    ),
  );

  // Symmetry
  const symRow = h("div", { class: "cs-presets" });
  for (const sym of SYMMETRY_MODES) {
    const b = h(
      "button",
      { type: "button", class: `cs-preset ${p.symmetry === sym ? "active" : ""}` },
      t(`Symmetry.${cap(sym)}`),
    );
    b.addEventListener("click", () => session.setPrefs({ symmetry: sym }));
    symRow.append(b);
  }
  wrap.append(h("span", { class: "cs-label" }, t("Aids.Symmetry")), symRow);
  if (p.symmetry !== "none") {
    const mode = session.effective().mode;
    wrap.append(
      slider(t("Aids.Angle"), p.symmetryAngle, -180, 180, 5, "°", (v) => session.setPrefs({ symmetryAngle: v })),
      h(
        "div",
        { class: "cs-presets" },
        toggle("fa-solid fa-crosshairs", t("Aids.ResetCenter"), false, () => {
          session.setSymmetryCenter(mode, null);
          session.setPrefs({ symmetryAngle: 0 });
        }),
      ),
      h("p", { class: "cs-hint" }, t("Aids.SymmetryHint")),
    );
  }

  // Toggles: QuickShape & Grid Snap
  const toggles = h(
    "div",
    { class: "cs-presets" },
    toggle("fa-solid fa-shapes", t("Aids.QuickShape"), p.quickShape, () =>
      session.setPrefs({ quickShape: !p.quickShape }),
    ),
    toggle("fa-solid fa-magnet", t("Aids.GridSnap"), p.gridSnap, () => session.setPrefs({ gridSnap: !p.gridSnap })),
  );
  wrap.append(h("span", { class: "cs-label" }, t("Aids.Snap")), toggles);

  // Rulers
  wrap.append(
    h("span", { class: "cs-label" }, t("Aids.Rulers")),
    h(
      "div",
      { class: "cs-presets" },
      toggle(
        "fa-solid fa-ruler-combined",
        t("Aids.RulersOn"),
        p.rulers,
        () => session.setPrefs({ rulers: !p.rulers }),
        t("Aids.RulersHint"),
      ),
      toggle(
        "fa-solid fa-pen-ruler",
        t("Aids.EditRulers"),
        session.rulerEdit,
        () => session.setRulerEdit(!session.rulerEdit),
        t("Aids.EditHint"),
      ),
    ),
  );
  const add = h("div", { class: "cs-presets" });
  for (const [preset, cls, key] of [
    ["perspective1", "fa-solid fa-1", "Aids.AddPerspective1"],
    ["perspective2", "fa-solid fa-2", "Aids.AddPerspective2"],
    ["perspective3", "fa-solid fa-3", "Aids.AddPerspective3"],
    ["curve", "fa-solid fa-bezier-curve", "Aids.AddCurve"],
  ] as const) {
    const b = h(
      "button",
      { type: "button", class: "cs-preset", "data-tooltip": t(key), "aria-label": t(key) },
      icon(cls),
    );
    b.addEventListener("click", () => {
      if (session.addRuler(preset) && !session.rulerEdit) session.setRulerEdit(true);
    });
    add.append(b);
  }
  wrap.append(add);
  const rulers = session.rulersFor(session.effective().mode);
  if (rulers.length) {
    const list = h("div", { class: "cs-ruler-list" });
    rulers.forEach((r, i) => {
      const name =
        r.kind === "curve" ? `${t("Aids.Curve")} ${i + 1}` : `${tf("Aids.Perspective", { n: r.vps.length })} ${i + 1}`;
      const row = h(
        "div",
        { class: "cs-ruler-row" },
        toggle(r.on ? "fa-solid fa-eye" : "fa-solid fa-eye-slash", name, r.on, () =>
          session.updateRuler(r.id, { on: !r.on }),
        ),
      );
      if (r.kind === "curve") {
        row.append(
          toggle("fa-solid fa-circle-notch", t("Aids.Closed"), r.closed, () =>
            session.updateRuler(r.id, { closed: !r.closed }),
          ),
          toggle(
            "fa-solid fa-grip-lines",
            t("Aids.Parallel"),
            r.parallel,
            () => session.updateRuler(r.id, { parallel: !r.parallel }),
            t("Aids.ParallelHint"),
          ),
        );
      } else {
        row.append(
          toggle(
            "fa-solid fa-hashtag",
            t("Aids.Parallels"),
            r.parallels,
            () => session.updateRuler(r.id, { parallels: !r.parallels }),
            t("Aids.ParallelsHint"),
          ),
        );
      }
      const del = h(
        "button",
        {
          type: "button",
          class: "cs-preset cs-preset-del",
          "aria-label": t("Aids.RemoveRuler"),
          "data-tooltip": t("Aids.RemoveRuler"),
        },
        "×",
      );
      del.addEventListener("click", () => session.removeRuler(r.id));
      row.append(del);
      list.append(row);
    });
    wrap.append(list);
  }
  wrap.append(h("p", { class: "cs-hint" }, t("Aids.AltHint")));

  return wrap;
}
