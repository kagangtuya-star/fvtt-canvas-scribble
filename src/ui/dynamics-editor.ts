import { BRUSHES } from "../brush/brushes.ts";
import {
  compileCurve,
  curveControlPoints,
  CURVE_PRESETS,
  encodeCurvePoints,
  MAX_CURVE_POINTS,
  PRESET_CODE,
  presetOf,
} from "../brush/curve.ts";
import { defaultDynamics, dynamicsTargets, MAX_DYN_SOURCES, sanitizeDynamics, TARGET_INFO } from "../brush/dynamics.ts";
import { DYN_COMBINES, DYN_DIRECTIONS, DYN_RANDOMS, DYN_SENSORS } from "../core/types.ts";
import type { BrushId, DynCombine, DynSource, DynTarget, DynTargetSpec, DynamicsSpec } from "../core/types.ts";
import { t } from "../i18n.ts";
import type { Session } from "../session.ts";
import { h, icon } from "./dom.ts";

/**
 * Brush Studio "Dynamics" section: per target (size, flow, …) a list of
 * sensors with response curves, the output range and how sensors combine;
 * plus a curve editor with a live marker of the sensor value while the user
 * test-draws on the studio preview.
 *
 * The popover is rebuilt after every preference change, so the selection
 * (target, source) lives in module state; edits are previewed live and
 * committed on release.
 */

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Selection that survives popover rebuilds. */
const ui: { target: DynTarget; source: number } = { target: "size", source: 0 };

/** Sensor values sampled from the test stroke (for the curve marker). */
export interface SensorReading {
  p: number;
  t: number;
  v: number;
  /** Stroke heading (radians) and heading of the first sample. */
  tan: number;
  tan0: number;
}

export type SliderRow = (
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  fmt: (v: number) => string,
  onLive: (v: number) => void,
  onCommit: (v: number) => void,
) => HTMLElement;

export interface DynamicsSection {
  element: HTMLElement;
  /** Show where the latest test-stroke sample falls on the selected curve (null hides it). */
  monitor(reading: SensorReading | null): void;
}

const clone = (spec: DynamicsSpec): DynamicsSpec => JSON.parse(JSON.stringify(spec)) as DynamicsSpec;

function readingFor(src: DynSource, r: SensorReading): number | null {
  const TAU = Math.PI * 2;
  switch (src.s) {
    case "p":
      return r.p;
    case "t":
      return r.t;
    case "v":
      return r.v;
    case "d": {
      if (src.dm === "axial") return null;
      const a = (src.dm === "rel" ? r.tan - r.tan0 : r.tan) % TAU;
      return (a < 0 ? a + TAU : a) / TAU;
    }
    default:
      return null;
  }
}

/* -------------------------------------------- */
/*  Curve editor                                */
/* -------------------------------------------- */

interface CurveEditor {
  element: HTMLElement;
  setMarker(x: number | null): void;
}

const CW = 248;
const CH = 112;
const PAD = 8;

function curveEditor(code: string, onLive: (code: string) => void, onCommit: (code: string) => void): CurveEditor {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = h("canvas", {
    class: "cs-curve",
    "aria-label": t("Studio.DynCurve"),
    "data-tooltip": t("Studio.DynCurveHint"),
  }) as HTMLCanvasElement;
  canvas.width = CW * dpr;
  canvas.height = CH * dpr;
  canvas.style.width = `${CW}px`;
  canvas.style.height = `${CH}px`;
  let pts = curveControlPoints(code);
  let current = code;
  let marker: number | null = null;
  let drag = -1;

  const toPx = (x: number, y: number): [number, number] => [PAD + x * (CW - 2 * PAD), CH - PAD - y * (CH - 2 * PAD)];
  const fromPx = (px: number, py: number): [number, number] => [
    Math.min(1, Math.max(0, (px - PAD) / (CW - 2 * PAD))),
    Math.min(1, Math.max(0, (CH - PAD - py) / (CH - 2 * PAD))),
  ];

  const draw = () => {
    const c = canvas.getContext("2d");
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, CW, CH);
    c.strokeStyle = "rgba(128, 128, 128, 0.28)";
    c.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const [x0, y0] = toPx(i / 4, 0);
      const [, y1] = toPx(i / 4, 1);
      c.beginPath();
      c.moveTo(x0, y0);
      c.lineTo(x0, y1);
      const [gx0, gy] = toPx(0, i / 4);
      const [gx1] = toPx(1, i / 4);
      c.moveTo(gx0, gy);
      c.lineTo(gx1, gy);
      c.stroke();
    }
    const fn = compileCurve(current);
    c.strokeStyle = "#f0a830";
    c.lineWidth = 2;
    c.beginPath();
    for (let i = 0; i <= 96; i++) {
      const [x, y] = toPx(i / 96, fn(i / 96));
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
    if (current.startsWith("p:")) {
      for (const [x, y] of pts) {
        const [px, py] = toPx(x, y);
        c.beginPath();
        c.arc(px, py, 4, 0, Math.PI * 2);
        c.fillStyle = "#ffffff";
        c.fill();
        c.strokeStyle = "#333333";
        c.lineWidth = 1.5;
        c.stroke();
      }
    }
    if (marker !== null) {
      const [mx, my] = toPx(marker, fn(marker));
      const [, top] = toPx(0, 1);
      const [, bottom] = toPx(0, 0);
      c.strokeStyle = "rgba(80, 170, 255, 0.85)";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(mx, top);
      c.lineTo(mx, bottom);
      c.stroke();
      c.beginPath();
      c.arc(mx, my, 3.5, 0, Math.PI * 2);
      c.fillStyle = "rgba(80, 170, 255, 1)";
      c.fill();
    }
  };

  const local = (e: PointerEvent | MouseEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const nearest = (px: number, py: number): number => {
    let best = -1;
    let bestD = 9;
    pts.forEach(([x, y], i) => {
      const [qx, qy] = toPx(x, y);
      const d = Math.hypot(qx - px, qy - py);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
  const update = () => {
    current = encodeCurvePoints(pts);
    draw();
    onLive(current);
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const [px, py] = local(e);
    // Editing a preset turns it into editable control points.
    if (!current.startsWith("p:")) pts = curveControlPoints(current);
    drag = nearest(px, py);
    if (drag < 0) {
      if (pts.length >= MAX_CURVE_POINTS) return;
      const p = fromPx(px, py);
      pts.push(p);
      pts.sort((a, b) => a[0] - b[0]);
      drag = pts.indexOf(p);
    }
    canvas.setPointerCapture?.(e.pointerId);
    update();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag < 0) return;
    const [x, y] = fromPx(...local(e));
    const lo = drag > 0 ? pts[drag - 1]![0] + 1 / 255 : 0;
    const hi = drag < pts.length - 1 ? pts[drag + 1]![0] - 1 / 255 : 1;
    pts[drag] = [Math.min(hi, Math.max(lo, x)), y];
    update();
  });
  const release = () => {
    if (drag < 0) return;
    drag = -1;
    onCommit(current);
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  const remove = (e: MouseEvent) => {
    e.preventDefault();
    if (!current.startsWith("p:") || pts.length <= 2) return;
    const i = nearest(...local(e));
    if (i < 0) return;
    pts.splice(i, 1);
    update();
    onCommit(current);
  };
  canvas.addEventListener("dblclick", remove);
  canvas.addEventListener("contextmenu", remove);

  draw();
  return {
    element: canvas,
    setMarker(x) {
      marker = x;
      draw();
    },
  };
}

/* -------------------------------------------- */
/*  Section                                     */
/* -------------------------------------------- */

export function buildDynamicsSection(
  session: Session,
  brushId: BrushId,
  sliderRow: SliderRow,
  preview: (dyn: DynamicsSpec | undefined) => void,
): DynamicsSection {
  const brush = BRUSHES[brushId];
  const targets = dynamicsTargets(brush);
  const wrap = h("div", { class: "cs-studio-dyn" });
  wrap.append(h("span", { class: "cs-label" }, t("Studio.Dynamics")));
  const noop: DynamicsSection = { element: wrap, monitor: () => undefined };
  if (!targets.length) {
    wrap.append(h("p", { class: "cs-studio-hint" }, t("Studio.DynUnsupported")));
    return noop;
  }

  const stored = session.prefs.brushParams[brushId]?.dyn;
  const commit = (dyn: DynamicsSpec | undefined) => {
    const bp = { ...session.prefs.brushParams };
    const ov = { ...(bp[brushId] ?? {}) };
    if (dyn) ov.dyn = sanitizeDynamics(dyn) ?? {};
    else delete ov.dyn;
    bp[brushId] = ov;
    session.setPrefs({ brushParams: bp });
  };

  const toggle = h("input", { type: "checkbox", "aria-label": t("Studio.DynCustom") }) as HTMLInputElement;
  toggle.checked = stored !== undefined;
  toggle.addEventListener("change", () => commit(toggle.checked ? defaultDynamics(brush) : undefined));
  wrap.append(
    h(
      "label",
      { class: "cs-studio-row cs-studio-check", "data-tooltip": t("Studio.DynHint") },
      toggle,
      h("span", {}, t("Studio.DynCustom")),
    ),
  );
  if (stored === undefined) return noop;

  const spec = clone(stored);
  if (!targets.includes(ui.target)) ui.target = targets[0]!;
  const target = ui.target;
  const info = TARGET_INFO[target];
  const tspec: DynTargetSpec | undefined = spec[target];

  // Target chips (mapped targets are marked).
  const chips = h("div", { class: "cs-cat-chips cs-dyn-targets", role: "tablist" });
  for (const id of targets) {
    const mapped = !!spec[id]?.src.length;
    const btn = h(
      "button",
      {
        type: "button",
        role: "tab",
        class: `cs-preset ${id === target ? "active" : ""} ${mapped ? "cs-dyn-mapped" : ""}`.trim(),
        "aria-selected": String(id === target),
      },
      t(`Dyn.Target.${cap(id)}`),
    );
    btn.addEventListener("click", () => {
      ui.target = id;
      ui.source = 0;
      session.changed();
    });
    chips.append(btn);
  }
  wrap.append(chips);

  const withTarget = (next: DynTargetSpec | undefined): DynamicsSpec => {
    const out = clone(spec);
    if (next && next.src.length) out[target] = next;
    else delete out[target];
    return out;
  };
  const fmt = (v: number) => (info.kind === "offset" ? `${Math.round(v)}°` : `${Math.round(v * 100)}%`);
  const step = info.kind === "offset" ? 1 : 0.01;

  if (tspec?.src.length) {
    const range = (key: "lo" | "hi", label: string) =>
      sliderRow(
        label,
        info.min,
        info.max,
        step,
        tspec[key],
        fmt,
        (v) => preview(withTarget({ ...tspec, [key]: v })),
        (v) => commit(withTarget({ ...tspec, [key]: v })),
      );
    wrap.append(range("lo", t("Studio.DynLo")), range("hi", t("Studio.DynHi")));

    if (tspec.src.length > 1) {
      const sel = h("select", { class: "cs-studio-select", "aria-label": t("Studio.DynCombine") }) as HTMLSelectElement;
      for (const m of DYN_COMBINES) {
        const opt = h("option", { value: m }, t(`Dyn.Combine.${cap(m)}`)) as HTMLOptionElement;
        if (m === (tspec.m ?? "mul")) opt.selected = true;
        sel.append(opt);
      }
      sel.addEventListener("change", () => commit(withTarget({ ...tspec, m: sel.value as DynCombine })));
      wrap.append(h("label", { class: "cs-studio-row" }, h("span", {}, t("Studio.DynCombine")), sel));
    }
  }

  // Sources.
  const sources = tspec?.src ?? [];
  if (ui.source >= sources.length) ui.source = Math.max(0, sources.length - 1);
  const setSource = (i: number, next: DynSource | null) => {
    const src = sources.slice();
    if (next) src[i] = next;
    else src.splice(i, 1);
    const base = tspec ?? { lo: info.lo, hi: info.hi, src: [] };
    commit(withTarget({ ...base, src }));
  };
  const list = h("div", { class: "cs-dyn-sources" });
  sources.forEach((src, i) => {
    const row = h("div", { class: `cs-dyn-source ${i === ui.source ? "active" : ""}`.trim() });
    const sensor = h("select", { class: "cs-studio-select", "aria-label": t("Studio.DynSensor") }) as HTMLSelectElement;
    for (const s of DYN_SENSORS) {
      const opt = h("option", { value: s }, t(`Dyn.Sensor.${cap(s)}`)) as HTMLOptionElement;
      if (s === src.s) opt.selected = true;
      sensor.append(opt);
    }
    sensor.addEventListener("change", () => {
      ui.source = i;
      setSource(i, { s: sensor.value as DynSource["s"], c: src.c });
    });
    row.append(sensor);
    if (src.s === "d" || src.s === "r") {
      const modes = src.s === "d" ? DYN_DIRECTIONS : DYN_RANDOMS;
      const group = src.s === "d" ? "Dir" : "Rand";
      const cur = src.s === "d" ? (src.dm ?? "abs") : (src.rm ?? "dab");
      const mode = h("select", { class: "cs-studio-select", "aria-label": t("Studio.DynMode") }) as HTMLSelectElement;
      for (const m of modes) {
        const opt = h("option", { value: m }, t(`Dyn.${group}.${cap(m)}`)) as HTMLOptionElement;
        if (m === cur) opt.selected = true;
        mode.append(opt);
      }
      mode.addEventListener("change", () => {
        ui.source = i;
        setSource(
          i,
          src.s === "d" ? { ...src, dm: mode.value as DynSource["dm"] } : { ...src, rm: mode.value as DynSource["rm"] },
        );
      });
      row.append(mode);
    }
    const edit = h(
      "button",
      {
        type: "button",
        class: "cs-preset cs-dyn-edit",
        "aria-label": t("Studio.DynCurve"),
        "data-tooltip": t("Studio.DynCurve"),
      },
      icon("fa-solid fa-bezier-curve"),
    );
    edit.addEventListener("click", () => {
      ui.source = i;
      session.changed();
    });
    const del = h(
      "button",
      {
        type: "button",
        class: "cs-preset cs-preset-del",
        "aria-label": t("Studio.DynRemove"),
        "data-tooltip": t("Studio.DynRemove"),
      },
      "×",
    );
    del.addEventListener("click", () => setSource(i, null));
    row.append(edit, del);
    list.append(row);
  });
  if (sources.length < MAX_DYN_SOURCES) {
    const add = h("button", { type: "button", class: "cs-preset" }, icon("fa-solid fa-plus"), t("Studio.DynAdd"));
    add.addEventListener("click", () => {
      const used = new Set(sources.map((s) => s.s));
      const s = DYN_SENSORS.find((x) => !used.has(x)) ?? "p";
      ui.source = sources.length;
      setSource(sources.length, { s, c: "lin" });
    });
    list.append(add);
  }
  wrap.append(list);

  // Curve of the selected source.
  const selected = sources[ui.source];
  if (!selected) return { element: wrap, monitor: () => undefined };
  const idx = ui.source;
  if (selected.s === "r" && selected.rm === "smooth") {
    wrap.append(
      sliderRow(
        t("Studio.DynFreq"),
        0.05,
        4,
        0.05,
        selected.f ?? 0.5,
        (v) => v.toFixed(2),
        (v) => {
          const src = sources.slice();
          src[idx] = { ...selected, f: v };
          preview(withTarget({ ...tspec!, src }));
        },
        (v) => setSource(idx, { ...selected, f: v }),
      ),
    );
  }
  const presetSel = h("select", { class: "cs-studio-select", "aria-label": t("Studio.DynCurve") }) as HTMLSelectElement;
  const curPreset = presetOf(selected.c);
  for (const p of CURVE_PRESETS) {
    const opt = h("option", { value: p }, t(`Dyn.Curve.${cap(p)}`)) as HTMLOptionElement;
    if (p === curPreset) opt.selected = true;
    presetSel.append(opt);
  }
  if (!curPreset) {
    const opt = h("option", { value: "" }, t("Dyn.Curve.Custom")) as HTMLOptionElement;
    opt.selected = true;
    presetSel.append(opt);
  }
  presetSel.addEventListener("change", () => {
    const code = PRESET_CODE[presetSel.value as (typeof CURVE_PRESETS)[number]];
    if (code) setSource(idx, { ...selected, c: code });
  });
  wrap.append(h("label", { class: "cs-studio-row" }, h("span", {}, t("Studio.DynCurve")), presetSel));

  const liveWith = (code: string): DynamicsSpec => {
    const src = sources.slice();
    src[idx] = { ...selected, c: code };
    return withTarget({ ...tspec!, src });
  };
  const editor = curveEditor(
    selected.c,
    (code) => preview(liveWith(code)),
    (code) => setSource(idx, { ...selected, c: code }),
  );
  wrap.append(editor.element, h("p", { class: "cs-studio-hint" }, t("Studio.DynCurveHint")));
  return {
    element: wrap,
    monitor(reading) {
      editor.setMarker(reading ? readingFor(selected, reading) : null);
    },
  };
}
