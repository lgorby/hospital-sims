---
name: run-hospital-simms
description: Run, launch, screenshot, and drive the Hospital Simms game — start the Vite dev server, spawn patients, fast-forward the sim, click/inspect entities, and take screenshots headlessly via the driver script.
---

# Run Hospital Simms

Browser game (Vite + PixiJS canvas + DOM-overlay UI). Drive it headlessly with
`.claude/skills/run-hospital-simms/driver.mjs` — a stdin-scripted
playwright-core runner that uses the **system Edge/Chrome** (no Playwright
browser download needed). All paths below are relative to the repo root.

## Prerequisites

- Node + npm (`npm install` — `playwright-core` is a pinned devDependency; the
  driver launches the system browser, so no `playwright install` step).
- Microsoft Edge or Chrome installed (standard Windows paths are auto-detected;
  override with `HS_BROWSER=<path to chromium exe>` if needed).

## Run (agent path)

Start the dev server in the background (leave it running):

```bash
npm run dev   # Vite, http://localhost:5173, ready in ~1s
```

Then pipe commands to the driver (Bash heredoc). This exact script spawns 5 flu
patients, fast-forwards an hour, verifies the HUD moved, inspects an entity,
and screenshots:

```bash
node .claude/skills/run-hospital-simms/driver.mjs <<'EOF'
goto
hud
debug
button Spawn 5 flu
button Fast-forward 1 hour
debug
wait 1500
hud
ss after-spawn
click 320 650
inspect
quit
EOF
```

Expected: `cash` drops a few dollars (wages), `tick` jumps ~220, and the
screenshot shows patients seated in the waiting room with hint toasts
("Nobody can run triage — hire a Nurse").

Driver commands (one per line on stdin; `#` comments allowed):

| Command | Effect |
|---|---|
| `goto [url]` | Load the game (default localhost:5173), wait for HUD |
| `hud` | Print clock / cash / rep / tick chips |
| `ss <name>` | Screenshot → `.claude/skills/run-hospital-simms/shots/<name>.png` |
| `debug` | Toggle the backtick debug panel (spawn/force/fast-forward buttons) |
| `button <text>` | Click first `<button>` containing `<text>` (e.g. `button Staff`) |
| `click <x> <y>` | Canvas click at page coords (selects entity → inspect panel) |
| `inspect` | Print the open `#inspect` panel's text, or `(closed)` |
| `key <key>` | Press a key (Playwright name: `Backquote`, `1`…) |
| `eval <js>` | Evaluate JS in the page, print JSON |
| `wait <ms>` / `waitticks <n>` | Sleep / wait for the sim to advance n ticks |
| `quit` | Close browser (implicit at EOF) |

Useful coords at the default 1280×800 viewport and starting camera: reception
room ≈ `80 560`, waiting room ≈ `320 650`. HUD is top bar, build bar is bottom.

## Direct invocation (sim internals)

`src/sim/` is renderer-free and deterministic — for changes to sim systems the
fastest handle is a Vitest test, not the browser:

```bash
npx vitest run test/reviewGate.test.ts   # one file
npm test                                 # all 119
```

## Run (human path)

`npm run dev` → open http://localhost:5173 in a browser. Backtick opens the
debug panel. Useless headless without the driver.

## Test / build / lint

```bash
npm test        # Vitest, headless sim tests
npm run build   # tsc --noEmit && vite build
npm run lint
```

## Gotchas

- **HUD chips are classes, not ids**: `.hud-clock`, `.hud-cash`, `.hud-rep`,
  `.hud-tick` (`Hud.chip` in `src/ui/hud.ts`). The inspect panel is
  `#inspect`, hidden via the `hidden` class.
- **The sim runs fine headless.** The loop auto-pauses on `document.hidden`,
  but a headless page counts as visible — ticks advance normally. Don't open
  a second tab in the same context; that could background the first.
- **Spawned patients need travel time.** `Spawn 5 flu` puts them at the map
  entrance; they take ~1 game hour to check in and sit down. Click
  `Fast-forward 1 hour` (debug panel) before expecting anyone at the waiting
  room coords — clicking there too early selects the empty room or nothing.
- **UI reacts on render frames**, so the driver bakes a 300 ms settle into
  `click`/`button`. Reads immediately after an un-settled action race the
  frame and see stale state.
- **The inspect panel swallows canvas clicks.** It opens bottom-left over the
  world; a `click` landing on it (roughly x<280, y>550) hits `data-ui` DOM and
  changes nothing. Close it first (`button ✕`) or click elsewhere.
- **Runs are not wall-clock reproducible.** The seed is fixed (1337 in
  `main.ts`) but the tick at which your debug click lands varies, so entity
  positions differ slightly between runs. Assert on HUD deltas and panel text,
  not exact pixels.
- **Favicon 404** appears as `[page-error]` noise on every `goto`. Harmless.

## Troubleshooting

- `Cannot find module 'playwright-core'` → `npm install` (it was once only an
  extraneous package; it's now a pinned devDependency — don't remove it).
- `browserType.launch: Executable doesn't exist` → set
  `HS_BROWSER=C:\path\to\msedge.exe` (or chrome.exe) before running the driver.
- `[error] goto: page.waitForSelector: Timeout` with `hud` printing `?` →
  the dev server isn't up or crashed; check the `npm run dev` output.
