# CanvasScribble

English · [简体中文](README_ZH.md)

Freehand drawing, annotations, and a laser pointer for Foundry VTT (v13–v14). Draw on the **map** (moves with pan and zoom, optionally saved to the scene) or on the **screen** (pinned to the viewport, fades out automatically).

## Map vs. Screen

| | Map | Screen |
|---|---|---|
| Anchored to | Scene coordinates | Viewport (9-point anchor, survives resize) |
| Pan & zoom | Moves and scales with the map | Stays put while the map moves |
| Lifetime | Temporary (seconds–1 h) or permanent (saved in Scene) | Temporary only |
| Layer | Below tokens, above tokens, or top (above fog) | Always on top |

## Tools

- **Draw** — Pen, Pressure pen, Pencil (pressure + tilt), Marker, Monoline, Soft brush, and Chalk. Hold `Shift` for straight lines.
- **Highlight** — Highlighter stroke or lasso area fill.
- **Arrow** — Straight or freehand, single- or double-headed.
- **Shape** — Line, rectangle, ellipse, and polygon (`Shift` snaps 15° / square / circle; `Alt` draws from center; double-click, right-click, or `Enter` closes a polygon).
- **Laser** — Glowing trail behind the pointer. Ephemeral and excluded from undo history.
- **Text** — Click and type; `Enter` adds a line, `Ctrl/Cmd+Enter` or clicking outside commits, and `Esc` cancels. Text grows to fit by default. Double-click with Select (or click with Text) to edit again. Drag the text to move it, side handles to set a wrapping width, or corner handles to scale the font; use “Restore automatic text width” to remove wrapping.
- **Eraser** — Whole-mark or partial (masked) erasing.
- **Paint** (wet media, map only) — Watercolour, wash, ink, gouache, oil, clear water, blender and sponge brushes on a choice of papers (cold press, hot press, rough, xuan, canvas). The paint is simulated rather than drawn: pigments mix subtractively, a loaded brush drags and blends wet colour, watercolour spreads along the paper fibres and darkens at its edges, granulating pigment settles into the paper's tooth, ink builds up layer by layer, and paint stays workable until it dries (oil much longer than water). Pigment and water amounts are set per stroke; *Dry now* dries everything at once.

Strokes stream live to other players (~33 ms batches, with optional name tags), and late joiners receive any active temporary marks. Lifetimes and fades run on Foundry's server clock so marks disappear at the same moment for everyone. Each user has their own undo/redo stack and a scoped clear menu (clearing others' marks or permanent annotations always asks for confirmation). Mouse, touch, and stylus are all supported, with hardware pressure/tilt, palm rejection, and velocity-based simulation when no pen is present.

## Controls

Open **CanvasScribble** in the left toolbar to bring up the palette above the hotbar. Drag the left grip (`⠿`) to float it anywhere; double-click the grip to dock it again. Use `Shift` + scroll wheel or `[` / `]` to resize the brush, and `Tab` to switch between Screen and Map.

You can also draw without leaving the Token layer (or any other layer) by holding a key and dragging with the left button. All shortcuts can be changed in **Configure Controls**.

| Key | Action |
|---|---|
| Hold `Z` | Draw on screen |
| Hold `X` | Draw on map |
| Hold `V` | Laser pointer |
| `Alt+Z` | Undo your last scribble from any layer (`Ctrl+Z` also works when active) |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo (layer active) |
| `[` / `]` | Thinner / thicker |
| `Tab` | Switch Screen / Map (layer active) |
| `Esc` | Cancel stroke or polygon in progress |
| `Enter` | Finish polygon |

*(Hold-to-erase and toggle-layer bindings are available but unbound by default.)*

## Permissions & Persistence

GMs set the minimum role for each action in World Settings (GMs can always do everything, and everyone can always erase their own marks):

| Action | Default |
|---|---|
| Screen drawing | Player |
| Map drawing (incl. laser) | Player |
| Permanent annotations | Trusted Player |
| Erase / clear others' marks | Assistant GM |
| Wet-media paint | Trusted Player |

Permissions are re-checked on every receiving client against the sender ID attached by Foundry's server—author or role fields inside socket payloads are ignored.

Because players cannot write to Scene documents directly, permanent annotations are saved into `flags.canvas-scribble.items.<id>` by the active GM's client. If no GM is connected or the user lacks permission, the mark falls back to a 60-second temporary map mark with a notice instead of being lost. Permanent marks are capped at 1 MB (configurable) and 3,000 items per scene.

Paint saves automatically while it is wet. Strokes are recorded locally from pen down for refresh recovery; the active GM saves the viewed scene after strokes and approximately every 10 seconds, including wetness and moving pigment. Reload resumes the saved simulation; time spent closed does not dry the paint. *Dry now* ends the flow and saves stable deposits. Checkpoint files live in `worlds/<world>/canvas-scribble/`, referenced by Scene flags (32 MB per scene by default). Server saves need an active GM; local recovery is limited to the same browser and reports a warning if storage is unavailable or full. The simulation runs in a background worker; a WebGL2 GPU backend is used when it passes a self-test against the CPU reference, otherwise the CPU runs it (client setting *Paint simulation*).

## Install

**From a GitHub Release:** in Foundry VTT, open **Add-on Modules → Install Module**, paste the `module.json` URL from the latest release into **Manifest URL**, and enable the module in your world.

**From source** (requires Node.js `>= 22.18`):

```bash
npm ci
npm run build
```

Copy or symlink `dist/` to `Data/modules/canvas-scribble`.

## Compatibility & Notes

- Targets Foundry VTT **v13** and **v14** (`minimum: 13`, `maximum: 14`).
- So far the module has only been tested with Node unit tests and a browser harness imitating Foundry's APIs, not on a live v13/v14 server. See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for details and [CHANGELOG.md](CHANGELOG.md#known-issues) for known issues.
- Everything is stored and sent as compact vector data (quantized delta-varint paths, ~4 chars/point), never bitmaps. Permanent marks render through a 512 px tiled cache with power-of-two zoom tiers; temporary and live strokes render as cached sprites.

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for architecture and harness notes.

```bash
npm ci           # install dependencies
npm run check    # typecheck, i18n check, unit tests, build, manifest validation
npm run harness  # build browser test harness into dist-dev/
npm run package  # build dist/ -> release/module.zip
```

Publish a GitHub release tagged `vX.Y.Z` (or `X.Y.Z`); [`.github/workflows/release.yml`](.github/workflows/release.yml) automatically derives the module version from the tag, fills in the repository URLs and attaches `module.json` and `module.zip`. No source JSON version edits are needed. Local `npm run package` uses `package.json`'s version and leaves those URL fields empty.

## License

MIT ([LICENSE](LICENSE)). Freehand geometry uses [perfect-freehand](https://github.com/steveruizok/perfect-freehand) (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
