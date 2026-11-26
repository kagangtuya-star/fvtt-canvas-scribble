# Development

## Requirements

- Node.js ≥ 22.18 (the build strips TypeScript types with Node's built-in `module.stripTypeScriptTypes`; tests run
  `.ts` files directly with `node --test`).
- `npm ci` installs the only runtime dependency (`perfect-freehand`, vendored into the build) and the dev tools
  (TypeScript, Prettier, `@types/node`).

## Commands

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over `src/`, `tests/`, `dev/` |
| `npm test` | unit tests (`node --test tests/*.test.ts`) |
| `npm run lint:i18n` | both language files have the same keys and placeholders; every key used in `src/` exists |
| `npm run format` / `format:check` | Prettier |
| `npm run build` | `src/` → `dist/` (one `.js` per `.ts`, perfect-freehand vendored with its license) |
| `npm run validate` | checks `dist/module.json` and that every referenced file exists |
| `npm run check` | typecheck + i18n + tests + build + validate (what CI runs) |
| `npm run package` | build, then `release/module.zip` + `release/module.json` |
| `npm run harness` | build plus the browser harness into `dist-dev/` |
| `npm run watch` | harness build on every change |

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

## Network

Socket `module.canvas-scribble`, envelope `{ v, t, scene, … }` (`src/net/protocol.ts`):

| `t` | Meaning |
|---|---|
| `s` | live item starts |
| `p` | live points from index `from` (batched every 33 ms) |
| `e` | final canonical item; `persist: true` asks the active GM to store it |
| `x` | live item cancelled |
| `d` | items deleted |
| `u` | item replaced (partial erase, undo / redo of an erase, layer change) |
| `c` | tiered clear (`mine`, `screen`, `mapTemp`, `allTemp`, `minePermanent`, `permanent`) |
| `q` / `r` | late joiner asks for temporary marks / a peer replies with its own |
| `n` | the GM refused to store an item (permission, budget, count) |

Receivers drop messages from themselves or unknown users, over 256 KB, or malformed, and apply per-sender token buckets
for messages, points and items. Each handler re-checks the sender's role against the world permission settings and
whether the sender may modify the target item's author.

**Permanent marks.** The author sends `e` with `persist`; the active GM validates, checks the budget and batches a Scene
update (60 ms); every client then reads the flags (`updateScene`) and shows the mark from the tile cache. The GM's
`SceneWriter` also knows items that are queued or being written, so a delete (for example an immediate undo) that
arrives before the write lands is still applied.

## Rendering

- **Tile cache** (stored marks): 512 px canvases (508 px inner + 2 px bleed), resolution tier = next power of two of
  device pixels per unit (1/16 … 8). Visible tiles are built nearest-first within a 6 ms frame budget (at least one per
  frame); the shown tier only switches when all visible tiles of the new tier are ready. New marks are painted onto
  existing tiles in place when they are the newest; other changes rebuild the affected tiles. Least-recently-used
  tiles are evicted.
- **Item sprites** (live, temporary, pending): each item rasterised once into its own canvas, sized to its bounds
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
