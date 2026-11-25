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
- English and Simplified Chinese.

### Known issues

- Only tested in a browser harness that imitates Foundry's APIs, not yet in a running Foundry v13 or v14 server (see
  [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)).
- Switching to a new zoom tier rebuilds the visible permanent-annotation tiles; a dense 512 px tile can take 15–30 ms to
  rasterise on the CPU, which shows as a brief hitch on that frame (the previous tier stays visible meanwhile).
- Text uses the browser's fonts (Signika, then system CJK fonts); it is not editable after placing (erase and re-type).
