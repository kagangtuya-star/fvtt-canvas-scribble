# AGENTS.md — CanvasScribble (`canvas-scribble`)

Foundry VTT v13/v14 module: map (world space) and screen (viewport space) drawing, annotations and laser pointer.
Architecture, protocol and harness details: `docs/DEVELOPMENT.md`; version notes and test status:
`docs/COMPATIBILITY.md`.

## Commands

- `npm run typecheck` — strict `tsc --noEmit` (src, tests, dev)
- `npm test` — `node --test tests/*.test.ts` (Node ≥ 22.18, runs TypeScript directly)
- `npm run lint:i18n` — `lang/en.json` and `lang/zh-CN.json` parity; every `t("…")` key used in `src/` must exist.
  Dynamic keys (brushes, tools, scopes…) are listed in `tools/check-i18n.mjs` — update it when adding ids.
- `npm run format:check` / `npm run format` — Prettier (printWidth 120)
- `npm run build` → `dist/`; `npm run validate`; `npm run package` → `release/module.zip`
- `npm run harness` → `dist-dev/` (serve it, e.g. `python3 -m http.server 8791 --directory dist-dev`; `.claude/launch.json`
  has a `harness` entry). Open `harness.html?user=gm|alice|bob` in several tabs for multiplayer; `brushes.html` for
  the brush gallery. `window.__cs` drives scripted input.

## Rules specific to this repo

- No bundler: each `src/**/*.ts` becomes one `dist/scripts/**/*.js` by type stripping. Use only erasable TypeScript
  (no enums, namespaces, parameter properties, decorators) and `.ts` import specifiers.
- Runtime dependencies (`perfect-freehand`, `lazy-brush`, `roughjs`, `simplex-noise`, `fflate`) are vendored by the
  build with their LICENSEs. Do not add dependencies without the user's approval.
- Wet media (`src/media/`): `sim/cpu.ts` is the reference; `sim/gpu.ts` must implement the same equations (keep
  `gpuSelfTest` passing for every paper). Physics constants live in `sim/physics.ts`.
- Version-dependent Foundry calls go in `src/foundry/compat.ts`; Foundry/PIXI typings the code needs are declared in
  `src/types/foundry.d.ts` (no foundry-vtt-types dependency).
- Security model: never trust `author`, role or permission fields from socket payloads or flags. The sender comes from
  the socket's server-attached user id; `sanitizeItem` always sets `author` from context. Every receiver re-checks
  permissions (`src/core/permissions.ts`).
- Only the active GM writes Scene flags (`SceneWriter`, batched). Keep the per-scene budget/count checks.
- Adding a brush or tool id touches: `core/types.ts` (ids), `brush/brushes.ts` (registry), `state/prefs.ts` (sizes),
  both language files, `tools/check-i18n.mjs`, and the gallery uses `BRUSH_IDS` automatically.
- Brush dynamics (`brush/dynamics.ts`, `brush/curve.ts`): items without `style.brush.dyn` must keep the painters'
  original code path (no visual change to existing marks). Adding a sensor, target, combine/direction/random mode or
  curve preset touches `core/types.ts`, `TARGET_INFO` / `sanitizeDynamics`, the painter support list
  (`dynamicsTargets`), both language files and `tools/check-i18n.mjs`. Per-point channels (`angles`, `tilt`,
  `speed`) must stay parallel to `points` everywhere (recorder, simplification, codec, sanitize, live `p` deltas).
- The harness (`dev/`) imitates Foundry; results there are "tested in harness", not "tested in Foundry". Keep
  `docs/COMPATIBILITY.md` honest when reporting status.
- Never push, create repositories or releases, or publish to the Foundry package directory without explicit
  authorisation from the user.
