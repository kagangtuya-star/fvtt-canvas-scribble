# Changelog

All notable changes to CanvasScribble are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] — unreleased

First release.

### Added

- Map scribbles (world space, scene-relative units; temporary or permanent) and screen scribbles (viewport space, nine
  anchors, always temporary).
- Brushes: pen, pressure pen, pencil (pressure and tilt), marker, monoline, soft, chalk, highlighter; area highlight
  (lasso fill).
- Tools: arrows (straight / freehand path, single / double head), line, rectangle, ellipse, polygon with snapping
  modifiers, laser pointer, text, whole-mark and partial eraser.
- Lifetime and fade on Foundry server time; permanent map annotations stored in Scene flags with a per-scene budget.
- Live multiplayer streaming over a compact socket protocol, late-join synchronisation of temporary marks, name tags.
- Per-user undo / redo, tiered clearing with confirmation.
- Role-based permissions checked by every receiving client against the authenticated sender.
- Map layers below tokens, above tokens and on top (above fog); v14 scene levels respected.
- Quick palette (dockable / floating), colour, size and lifetime popovers, brush-sized cursor.
- Hold-to-draw keys (screen, map, laser, eraser), size keys, cancel / finish keys; all rebindable.
- Pen pressure and tilt, simulated pressure for mouse and touch, palm rejection.
- Debug panel with render, cache and network counters.
- Wet-media paint tool: physically simulated watercolour, wash, ink, gouache, oil, water, smudge and sponge brushes
  on five papers — spectral Kubelka–Munk pigment mixing, bristle reservoirs that pick up and drag wet paint,
  virtual-pipe surface flow, capillary spread along paper fibres, edge darkening, granulation, re-wetting, wet/dry
  state and drying, ink build-up. Runs in a worker (CPU reference, WebGL2 backend after a parity self-test); strokes
  are synchronised as inputs; dried paint is baked by the GM into files referenced from Scene flags.
- English and Simplified Chinese.

### Fixed

- Wet media: reconcile late bakes per chunk, replay recent paint on scene return, and prevent older saves from
  overwriting newer paint or resurrecting cleared or undone paint. Reserve slots before applying GPU dabs, and cap
  live simulation and display work.

### Known issues

- Wet media: the WebGL2 backend has only been checked with a software renderer (SwiftShader). Large wet areas can
  still update slowly on the CPU; it starts drying older paint early after reaching 16 wet chunks.
- Wet media: every client simulates strokes itself; small floating-point differences between machines can show while
  paint is wet and converge when the GM's bake of the dried area is loaded.
- Wet media: there is no redo for paint, and undo only works while no later stroke touched the same areas. Paint made
  while no GM is online is not saved. Clearing or replacing paint leaves the old files on disk.

- Only tested in a browser harness that imitates Foundry's APIs, not yet in a running Foundry v13 or v14 server (see
  [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)).
- Switching to a new zoom tier rebuilds the visible permanent-annotation tiles; a dense 512 px tile can take 15–30 ms to
  rasterise on the CPU, which shows as a brief hitch on that frame (the previous tier stays visible meanwhile).
- Text uses the browser's fonts (Signika, then system CJK fonts); it is not editable after placing (erase and re-type).
