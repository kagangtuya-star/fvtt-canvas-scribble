# Development

## Requirements

- Node.js ≥ 22.18 (the build strips TypeScript types with Node's built-in `module.stripTypeScriptTypes`; tests run
  `.ts` files directly with `node --test`).
- `npm ci` installs the runtime dependencies (`perfect-freehand`, `lazy-brush`, `roughjs`, `simplex-noise`, `fflate`;
  each vendored into the build with its license) and the dev tools (TypeScript, Prettier, `@types/node`, and
  `spectral.js`, the reference the pigment tables and tests are checked against).

## Commands

| Command                           | What it does                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `npm run typecheck`               | `tsc --noEmit` over `src/`, `tests/`, `dev/`                                              |
| `npm test`                        | unit tests (`node --test tests/*.test.ts`)                                                |
| `npm run lint:i18n`               | both language files have the same keys and placeholders; every key used in `src/` exists  |
| `npm run format` / `format:check` | Prettier                                                                                  |
| `npm run build`                   | `src/` → `dist/` (one `.js` per `.ts`, runtime dependencies vendored with their licenses) |
| `npm run validate`                | checks `dist/module.json` and that every referenced file exists                           |
| `npm run check`                   | typecheck + i18n + tests + build + validate (what CI runs)                                |
| `npm run package`                 | build, then `release/module.zip` + `release/module.json`                                  |
| `npm run harness`                 | build plus the browser harness into `dist-dev/`                                           |
| `npm run watch`                   | harness build on every change                                                             |

To try the module in Foundry, copy or link `dist/` to `Data/modules/canvas-scribble/`.

## Release versions

Publish a GitHub Release with a tag such as `v1.0.2` or `1.0.2`. The Release workflow passes `RELEASE_TAG` and
`MODULE_REPO` to both build and packaging. They generate the version and repository, manifest, download and issue
URLs in `dist/module.json`, `release/module.json` and the manifest inside `release/module.zip`.
Prerelease and build suffixes such as `v1.1.0-beta.1+build.2` are accepted; the download URL preserves the exact tag.
The stable update URL uses GitHub's latest release.

The source `module.json` contains module metadata without a version. Without `RELEASE_TAG`, builds use the version
in `package.json`; releases do not require updating `package.json` or the lockfile. Neither script writes back to
source JSON files. To preview a release locally, set both environment variables and run `npm run package`, or build
first and run `node tools/package.mjs --repo owner/name --tag v1.0.2`.

## Layout

```
src/
  main.ts              hooks, wiring, public API (game.modules.get("canvas-scribble").api)
  session.ts           per-client controller: tools, items, network handling, permissions, history
  constants.ts         ids and hard limits
  core/                platform-independent model: types, codec, sanitize, store, history, lifetime,
                       permissions, coordinate spaces, geometry
  brush/               brush registry, perfect-freehand wrapper, input recorder, Canvas2D painters, shapes
  tools/               gestures (freehand, shape, polygon, laser, eraser) and hit tests
  render/              PIXI integration: tile cache, item sprites, laser trails, renderer, stats
  net/                 protocol (message shapes, validation, cost) and socket wrapper (rate limits)
  foundry/             compat layer, settings, keybindings, canvas layer + scene controls, Scene persistence
  media/               wet-media paint: brushes, pigment optics, papers, dab exchange, engine (worker), bakes,
                       controller; sim/ holds the CPU reference and the WebGL2 backend
  input/               pointer capture
  ui/                  palette, popovers, clear menu, cursor, text editor, name tags, debug panel
  types/foundry.d.ts   the slice of Foundry / PIXI typings the module uses
tests/                 node:test suites
dev/                   browser harness (Foundry stand-in) and brush gallery — never shipped
tools/                 build, package, manifest and i18n checks
```

## Data model

`ScribbleItem` (`src/core/types.ts`) carries `schemaVersion`, `id`, `author`, `scene`, `mode` (`map` | `screen`),
`kind` (`stroke` | `shape` | `area` | `text` | `laser`), `tool`, colour, opacity, size, flat `[x, y, z]` points, style
flags, optional text, `createdAt` / `expiresAt` (server time; `expiresAt: null` = permanent) / `fadeDuration`, map
`layer`, screen `anchor`, scene `level`, partial-eraser masks and a `revision`.

- Map coordinates are scene-relative units against a reference scene size stored once per scene
  (`flags.canvas-scribble.ref`), so marks follow when the scene is resized.
- Screen coordinates are relative to one of nine viewport anchors, with 1000 units = the shorter viewport side.
- On the wire and in flags, points are quantised (0.1 unit; pressure 1/255; laser time 1 ms), delta + zig-zag + varint
  encoded and base64'd (`src/core/codec.ts`), about 4 characters per point.
- `sanitizeItem` validates every untrusted item (schema version, ids, scene, enums, colours, ranges, extents, clock skew,
  lifetime, text control characters, mask count) and always sets `author` from the authenticated sender.
- Text keeps its original string (including explicit newlines). Optional `textWidth` is a wrapping width in space
  units; absent means natural width, preserving compatibility with existing schema-1 items. `core/text-layout.ts`
  shares font metrics, line layout and padded bounds between the painter, editor and hit tests. Font loading
  invalidates these derived caches. Width changes do not change the font size; uniform scaling changes both.
- The native textarea edits a local draft. Existing items keep their ids, authors and lifetimes; commits use one
  history `update` and the existing `u` message/GM writer. Unchanged drafts do nothing, Escape cancels, and clearing
  an existing text is an undoable delete. Stale/deleted/expired or unauthorized drafts are refused locally and kept
  for copying. The renderer excludes the edited id from both sprites and tiles until editing ends.

## Network

Socket `module.canvas-scribble`, envelope `{ v, t, scene, … }` (`src/net/protocol.ts`):

| `t`                       | Meaning                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `s`                       | live item starts                                                                             |
| `p`                       | live points replacing the tail from index `from`                                             |
| `b`                       | up to 12 live `s`/`p` updates in one 33 ms batch; `s` can replace an existing live preview   |
| `e`                       | final canonical item; `persist: true` asks the active GM to store it                         |
| `x`                       | live item cancelled                                                                          |
| `d`                       | items deleted                                                                                |
| `u`                       | item replaced (partial erase, undo / redo of an erase, layer change)                         |
| `c`                       | tiered clear (`mine`, `screen`, `mapTemp`, `allTemp`, `minePermanent`, `permanent`, `media`) |
| `q` / `r`                 | late joiner asks for temporary marks / a peer replies with its own                           |
| `ms` / `mp` / `me` / `mu` | wet-media stroke start / points / end / undo                                                 |
| `mq` / `mr`               | late joiner asks for wet-media strokes / a peer replays its own recent ones                  |
| `n`                       | the GM refused to store an item (permission, budget, count)                                  |

Receivers drop messages from themselves or unknown users, over 256 KB, or malformed, and apply per-sender token buckets
for messages, points and items. Preview traffic has its own budget so it cannot crowd out final items. Each handler
re-checks the sender's role against the world permission settings and whether they may modify the target item.

**Permanent marks.** The author sends `e` with `persist`; the active GM validates, checks the budget and batches a Scene
update (60 ms); every client then reads the flags (`updateScene`) and shows the mark from the tile cache. The GM's
`SceneWriter` also knows items that are queued or being written, so a delete (for example an immediate undo) that
arrives before the write lands is still applied.

## Wet media (paint tool)

The paint tool simulates the medium instead of drawing a shape: a stroke is a list of input points, and what ends up
on the map is the result of brush ↔ paper exchange and fluid physics. Code in `src/media/`.

- **Grid.** World-anchored cells of 2 map units (`layout.ts`), in chunks of 128 × 128 cells, created on demand. A chunk
  is _wet_ (awake: water, saturation, oil, outflows, suspended pigment) or _dry_ (deposited pigment only).
- **Pigment** (`pigment.ts`, `spectral-tables.ts`). Twelve channels per cell: absorption K in 8 spectral groups,
  scattering S, amount A, granulation G, staining F. Colours are turned into K/S with the spectral reflectance model
  of spectral.js (tables generated by `tools/gen-spectral.mjs`). Display uses two-constant Kubelka–Munk for a layer
  of finite thickness: reflectance R and transmittance T per group, projected to sRGB. Body paint (gouache, oil)
  scatters and covers; glazes (watercolour, ink) mostly absorb, so layers darken and mix subtractively.
- **Brush** (`dabs.ts`, `brushes.ts`). Strokes are resampled into dabs at fixed spacing (deterministic). The brush is
  a reservoir of 8 bristle bands, each holding pigment and water. Each dab deposits from the bands and picks up the
  wet paint under them (gathered before the batch), so wet colour is dragged along and mixed; as the load runs out a
  contact threshold on the paper relief produces dry-brush breaks. Bands even out between dabs (wicking).
- **Paper** (`paper.ts`). A periodic 256² tile per scene (seeded by the scene id): relief, absorbency, fibre
  direction. Papers differ in absorption, capacity, capillary diffusion and anisotropy, how much pigment the capillary
  flow carries, how long pigment stays mobile in damp fibres (`bleed`), tooth and evaporation.
- **Physics** (`sim/cpu.ts`, constants in `sim/physics.ts`), every 50 ms: (A) virtual-pipe outflows from water and
  relief pressure, with surface tension at dry cells and viscosity from suspended pigment; (B) mass-conserving
  transport of water and suspended pigment; (C) capillary diffusion of saturation along the fibres carrying a capped
  share of pigment; (D) absorption, evaporation (faster at wet edges → edge darkening), settling (faster for
  granulating pigment in the paper's valleys, and once the cell dries), re-wetting lift of non-staining deposits.
  Oil keeps paint mobile far longer than water.
- **Backends.** `CpuBackend` is the reference: Float32 planes, only an activity rectangle per chunk is processed.
  `GpuBackend` (`sim/gpu.ts`) runs the same passes as WebGL2 fragment shaders over an atlas of RGBA32F textures
  (2×2 chunk slots, growing to 6×6). The engine reserves every chunk needed by a batch before gathering paint and
  can dry the oldest wet chunks early to fit it (up to 16 wet chunks on CPU and 36 on GPU). The GPU backend is only used
  after `gpuSelfTest` ran the same strokes on both and they agreed (state, gather and display); `auto` also
  skips software rasterisers. Setting _Paint simulation backend_ (client) forces `cpu` or `gpu`.
- **Engine** (`engine.ts`) runs in a module worker (`worker.ts`; inline fallback if workers are unavailable). It
  queues dabs, steps the wet chunks, dries a chunk when its wet time ends or it and its neighbours are quiet, posts
  chunk displays (R on top, T² below) and handles undo snapshots, bakes and loads. Dry chunks keep compressed
  deposits; display buffers cover the viewport only, with reduced resolution at low zoom and a cap per engine tick.
- **Display** (`render/media-layer.ts`). Per chunk a MULTIPLY sprite with T² and an ADD sprite with R reproduce the
  composite `R + T²·map` in the primary group (sort layer 645: under the "below" scribbles and tokens, under fog).
- **Network.** Strokes travel as inputs (`ms` start, `mp` points, `me` end, `mu` undo). Each client simulates locally,
  then reconciles with the GM's bakes. Late joiners load the bakes and ask (`mq`) peers for their recent strokes
  (`mr`, ≤ 20 per message). Each bake records which dabs it covers for that chunk so a cross-chunk stroke can replay
  where it is still missing. When a bake arrives after local paint, the engine reapplies the missing dabs from its
  bounded replay log; if that history is incomplete, it keeps the local paint. Clients cache recent inputs for scene
  switches; the GM also receives strokes from scenes it is not viewing. Receivers sanitize strokes and check the
  sender's `media` permission (default Trusted Player).
- **Persistence.** When a chunk dries, the active GM bakes its deposits (binary16 planes, deflate via fflate, inside a
  PNG), wraps the exact bytes in a versioned base64 JSON envelope and uploads it with `FilePicker` to
  `worlds/<world>/canvas-scribble/<scene>/<cx>_<cy>_<f>.json`. This prevents image-optimization modules from converting
  simulation data to WebP or altering its pixels. The Scene flag `flags.canvas-scribble.media` keeps
  `{ paper, chunks: { c<cx>_<cy>: { r, t, n, f, format: "json" } } }`. Each upload gets a new file ID.
  Paths are derived from validated IDs; older flags without `format` still load PNG, and those without `f` use
  `<cx>_<cy>.png`. The _Paint storage
  budget_ covers current Scene references, including pending writes (2048 chunks at most). Superseded or cleared
  files remain on disk.
  _Dry now_ waits for uploads and Scene flag writes before confirming a save and guards page refresh while saving.
  Uploads must confirm the expected file path. Failed uploads and flag writes receive bounded retries; failed flag
  writes remain queued, and failed uploads leave the dry chunk available for another _Dry now_. Failed bake loads
  are retried and report a warning even when debug logging is disabled. Confirmed HTTP 404/410 or corrupt files are
  skipped for that revision without deleting their references; new paint can replace the missing checkpoint.
  Permissions/network/server failures still block replacing an unloaded base. Upload retries invalidate the directory
  cache so a deleted folder can be recreated. Missing or converted old paint requires an intact backup to restore.

## Rendering

- **Tile cache** (stored marks below the first non-normal blend in each map layer): 512 px canvases (508 px inner + 2 px
  bleed), resolution tier = next power of two of device pixels per unit (1/16 … 8). Visible tiles are built nearest-first
  within a 6 ms frame budget (at least one per
  frame); the shown tier only switches when all visible tiles of the new tier are ready. New marks are painted onto
  existing tiles in place when they are the newest; other changes rebuild the affected tiles. Least-recently-used
  tiles are evicted.
- **Item sprites** (live, temporary, pending, and stored marks from the first blend upward): sprites blend against
  the scene in drawing order. Each item is rasterised into its own canvas, sized to its bounds
  (capped at 4096 px edge / 8 Mpx), re-rasterised only when it changes or the zoom tier changes; alpha follows the
  lifetime fade.
- **Laser**: one `Graphics` per root, redrawn each frame from point timestamps.

The debug panel (client setting) shows these counters live; `game.modules.get("canvas-scribble").api.stats` exposes
them to the console.

## Browser harness

`npm run harness`, then serve `dist-dev/` over HTTP with any static server (for example
`python3 -m http.server 8791 --directory dist-dev`) and open:

- `harness.html?user=gm|alice|bob` — one tab per user; tabs talk through `BroadcastChannel`, which plays the server
  (relays sockets with the sender id, applies Scene updates, tracks who is online). Only the GM may update the Scene,
  as in Foundry. Extra parameters: `lang=zh`, `theme=light`, `fog=1`, `zoom=0.5`, `gen=14` (v14 mode, `_del`),
  `latency=ms` (Scene update latency), `skew=ms` (server clock offset).
- `brushes.html` — every brush, shape and item kind rendered with the real painters on dark and light backgrounds.

The harness stores uploaded bakes in IndexedDB (`sim-data/`) and serves them through a patched `fetch`; _reset scene_
clears them.

`window.__cs` offers scripted input for QA: `stroke(points, { pointerType, pressure, shift, dt, hold })` dispatches real
`PointerEvent`s on the board, `wave(...)` makes test paths, `key(code, "keydown" | "keyup", mods)`, `summary()` counts
items by mode and state, `sceneFlags()`.

If Foundry's own stylesheet is available locally, link it into `dist-dev/foundry/` (`foundry2.css`, `all.min.css`) to
compare the UI with the real look; otherwise a Font Awesome fallback is loaded.

## Conventions

- Strict TypeScript, ES modules, `.ts` import specifiers (rewritten to `.js` by the build).
- Only erasable TypeScript syntax (no enums, namespaces or parameter properties) so types can be stripped.
- All user-facing strings go through `lang/*.json` under `CANVAS_SCRIBBLE.*`; run `npm run lint:i18n`.
- Version-dependent Foundry calls belong in `src/foundry/compat.ts`.
- Never trust identity, role or permission data from a payload; use the socket sender id.
