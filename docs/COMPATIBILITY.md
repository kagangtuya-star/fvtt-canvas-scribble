# Compatibility

`module.json` declares `minimum: 13`, `maximum: 14`. Every version-dependent call goes through
[`src/foundry/compat.ts`](../src/foundry/compat.ts); the rest of the code uses APIs that exist unchanged in both
generations.

## Test status

**Not yet run in a real Foundry VTT server, neither v13 nor v14.** All runtime testing so far used the browser harness
in `dev/` — a stand-in that implements the subset of Foundry's client API the module uses (hooks, settings,
keybindings, scene controls, sockets relayed between tabs, Scene document updates, the canvas group / layer
structure with real PIXI 7) — plus Node unit tests of the platform-independent code.

The API names and shapes the module relies on were checked against the community type definitions
`@league-of-foundry-developers/foundry-vtt-types` 13.346.0-beta and 14.370.0-beta (local copies, not a running core).

| Area | Status |
|---|---|
| Unit tests (codec, validation, permissions, store, history, spaces, protocol, rate limits, persistence, prefs, tiles, hit tests, brushes) | **Tested** — `npm test`, 89 tests |
| Module boot, layer registration, scene controls, palette, popovers, dialogs | **Tested in harness** (v13 and v14 mode) |
| Drawing on map and screen, every tool, hold keys, Tab / Esc / Enter / Ctrl+Z / Ctrl+Y / `[` `]` | **Tested in harness** (keys through a simulated keybinding dispatcher) |
| Multiplayer: live streaming, late-join sync, GM relay of permanent marks, undo / redo across clients, clears | **Tested in harness** (three users in three tabs, `BroadcastChannel` as the server) |
| Server-side style permission checks, forged messages, rate limiting | **Tested in harness and unit tests** |
| Fog of war and token stacking of the three map layers | **Tested in harness** (simulated fog overlay; tokens at elevation 0 and 10) |
| Tile cache tiers, crispness when zooming, LRU, redraw / teardown | **Tested in harness** |
| v14 `_del` deletion operator for Scene flags | **Tested in harness and unit tests** (simulated operator) |
| v14 scene levels (`canvas.level`) | **Tested in harness** with a manually set `canvas.level`; the real v14 level switching flow is **unverified** |
| WebGL rendering | **Unverified** — the harness browser had no WebGL, so the PIXI Canvas2D renderer was used |
| Real Foundry keybinding precedence, core dialogs, sidebar / hotbar layout, other modules | **Unverified** |
| Touch devices, real pen hardware (pressure, tilt, eraser end) | **Unverified** — only synthetic pointer events with pressure values |

## Version differences handled

| Topic | v13 | v14 | Where |
|---|---|---|---|
| Deleting a key in a document update | `flags.x.items.-=id: null` | `flags.x.items.id: _del` (`-=` deprecated) | `compat.deletion` |
| Scene levels | — | marks remember `canvas.level.id`; marks of other levels are hidden; the "below tokens" layer sits at the viewed level's ground elevation (`canvas.primary.background.elevation`) | `compat.viewedLevel`, `SceneRenderer#syncGround` |
| Version detection | `game.release.generation` | same | `compat.generation` |

Shared by both: `foundry.canvas.layers.InteractionLayer`, `prepareSceneControls()` returning a controls record,
`ui.controls.activate({ control, tool })`, `foundry.applications.api.DialogV2.confirm`, `game.users.activeGM`,
`game.time.serverTime`, `game.socket` with the sender id passed to listeners, `canvas.primary` sort layers.

## Integration notes

- **Canvas placement.** Map marks live in three containers: inside `canvas.primary` with sort layer 650 (between
  drawings 600 and tokens 700, at the ground elevation), inside `canvas.primary` at elevation ∞ with sort layer 750
  (above every token and overhead tile, below weather), and inside the module's own interaction layer in the
  `interface` group (above fog). Screen marks live in `canvas.overlay`.
- **Input.** Window capture-phase listeners take pointer events that land on the canvas view, and only while the layer
  is active or a hold key is down, and only for the primary button (and a pen's eraser button). Right / middle
  buttons, HTML UI and other layers' interactions are untouched.
- **Keybindings.** Hold keys use `game.keybindings` with `onDown` / `onUp`; they are released on `keyup`, window blur
  and tab visibility changes so a key can never get stuck. Core Ctrl+Z, Esc, Tab and Delete reach the layer through
  `_onUndoKey`, `_onDismissKey`, `_onCycleViewKey` and `_onDeleteKey`.
- **Sockets.** The module requires `"socket": true`. Messages are addressed by scene id; clients ignore other scenes,
  except the active GM, which stores permanent marks for scenes it is not viewing.
