# Hospital Simms — Technical Plan

Companion to `GAME_DESIGN.md`. Covers stack, architecture, project layout, and the build order (milestones M0–M4) for V1.

> **Status (2026-07-17):** M0–M4, the full-codebase audit, Persistence Phase 1 (save/load, `docs/PERSISTENCE_PLAN.md`), the §6 DoD checks (SSOT audit / 60fps profile / QA playthrough — all passed), GDD §12 Expansion 1, the §2.6 art pass, and the Vercel deploy are all **shipped** — V1 is complete and live at https://hospital-sims.vercel.app (git-connected auto-deploy). This document remains the architecture contract; current state and the invariant ledger live in `docs/HANDOFF.md`.

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | Sim logic benefits enormously from typed state machines and enums |
| Bundler/dev | Vite | Instant HMR, zero-config TS, trivial static deploy |
| Renderer | PixiJS v8 | Fast WebGL 2D, container/z-sorting model fits isometric depth sorting |
| UI | DOM overlay (HTML/CSS, no framework to start) | HUD, menus, and panels are forms and lists — the DOM is better at those than in-canvas UI, and it keeps Pixi scene graph purely for the world |
| State/sim | Hand-rolled fixed-timestep simulation, no ECS library | V1 entity counts are small (≤ ~200 actors); plain classes + systems are simpler to debug than an ECS. Revisit if post-V1 scale demands it |
| Tests | Vitest | Sim systems (pathfinding, dispatcher, economy) are pure logic — unit-test them headlessly |
| Deploy | Vercel static | It's a static site after `vite build` |

No backend, no accounts, no network play. Save/load (SHIPPED — Persistence Phase 1) is a versioned JSON snapshot in `localStorage` slots plus file export/import; see `docs/PERSISTENCE_PLAN.md` and `src/sim/save.ts`.

## 2. Architecture

### 2.1 Sim/render split — the load-bearing decision

The simulation is **deterministic, fixed-timestep (10 ticks/sec), and renderer-free**. Rendering interpolates between the last two sim states for smooth movement at any frame rate. Nothing in `sim/` may import Pixi.

```
┌───────────────────────────── main loop (rAF) ─────────────────────────────┐
│  accumulator pattern:                                                     │
│    sim.applyCommands()          // always, even at speed 0 (see §2.2)     │
│    while (acc >= TICK_MS / speed) sim.tick()   // max 10 ticks/frame      │
│    renderer.draw(interpolation alpha)                                     │
│  acc is clamped (spiral-of-death guard) and the game auto-pauses on tab   │
│  blur — a throttled rAF must not cause a catch-up burst or silent skip.   │
└────────────────────────────────────────────────────────────────────────────┘

  sim/  (pure TS, unit-testable)          render/ (Pixi)         ui/ (DOM)
  ─────────────────────────────           ──────────────         ─────────
  World: grid, rooms, entities            IsoTileLayer           HUD
  Systems, run in order each tick:        RoomLayer              BuildMenu
    SpawnSystem                           ActorLayer (z-sorted)  HirePanel
    DecaySystem (health/patience)         SelectionHighlight     InspectPanel
    ThoughtsSystem (mood → thoughts)      GhostPreview (build)   Toasts
    DispatcherSystem                                             DailyReport
    WayfindingSystem (rescue, timeout,
      wander-step setup — runs BEFORE
      movement; wrong-turn rolls fire
      INSIDE movement, per tile stepped)
    MovementSystem (follows paths)
    TreatmentSystem
    EconomySystem
    (reputation + clock live on World itself:
     applyReputation / GameClock in tick() —
     never grew into standalone systems)
```

Benefits: game speed (1×/2×/3×) is just running more ticks per frame; pause is zero ticks; the whole sim is testable in Vitest with no browser; determinism makes bug reports reproducible (seeded RNG).

### 2.2 Communication

- **sim → render/ui:** an `EventBus` (typed pub/sub). Sim emits domain events (`patientDied`, `treatmentComplete`, `cashChanged`, `roomBuilt`…). Renderer and UI subscribe. Renderer additionally reads world state directly each frame for positions (events for changes, polling for continuous values).
- **ui → sim:** a `CommandQueue`. UI pushes commands (`BuildRoom`, `SellRoom`, `HireStaff`, `FireStaff`); sim drains the queue at the start of each tick. Keeps mutations single-threaded through one entry point — also exactly the shape needed later for save-compatible replays.
- **Pause is not a dead sim.** `SetSpeed`/pause live in the **loop layer**, outside the sim tick — so the game can always unpause. While paused, the loop still calls `sim.applyCommands()` every frame (commands execute at speed 0: rooms appear, staff are hired/fired) — it just never calls `sim.tick()`, so no time passes. The renderer draws the mutated state on the next frame. This is what makes the GDD's "build and hire while paused" actually work.

### 2.3 Core sim model

```ts
// Coordinates: grid space (col, row). Rendering converts to iso screen space.
type Tile = { walkable: boolean; roomId: RoomId | null; object: PlacedObject | null }

class World {
  grid: Tile[][]            // 40×40
  rooms: Map<RoomId, Room>
  patients: Map<EntityId, Patient>
  staff: Map<EntityId, Staff>
  clock: GameClock
  economy: Economy
  reputation: number
  rng: SeededRng
}
```

- **Patient / Staff** are classes with an explicit state-machine field (discriminated union, e.g. `{ kind: 'waiting', since: Tick } | { kind: 'inTreatment', roomId, step } | …`). Patient transitions are validated by `World.setPatientStage` against `LEGAL_STAGE_TRANSITIONS` (declared beside the type, audit #5) — violations are *counted and warned*, never thrown (prod degrades gracefully; tests assert `world.stageViolations` is empty).
- **Room** holds type, rect footprint, door tile, equipment tiles, quality score, and a single `occupancy` slot (V1 rooms treat one patient at a time; waiting room is the exception with chair-count capacity). Room defs carry a `kind: 'treatment' | 'open'` — **open** rooms (the atrium) have no walls/door, keep their tiles publicly walkable, and take no occupancy slot; they exist for their auras (GDD §5 atrium rules).
- **Lostness is a movement sub-state, not a lifecycle state.** The patient's stage machine (waiting/inTreatment/…) is unchanged; the movement component carries `lost: { since: Tick } | null`. This keeps every existing release/re-queue rule working without new lifecycle transitions.
- **Auras are a precomputed grid.** `World` holds an `auraGrid` (guidance/comfort flags per tile), recomputed on room build/sell, greeter hire/fire/assignment, **and a posted greeter's arrival at / departure from the help desk** (guidance requires posted + *arrived*, matching the reception-desk rule; comfort needs no greeter). The per-tile wrong-turn roll and patience-decay modifier are O(1) lookups; staff-proximity rescue (radius 3) is the only per-tick spatial check, and only runs for lost patients.
- **Treatment paths** are data, not code: `conditions.ts` exports the roster from the GDD as a typed table. Adding a condition post-V1 should be a data edit.

### 2.4 Pathfinding

- A* on the tile grid, 4-directional, walkability from `Tile.walkable` (room interiors walkable only via their door).
- Paths recomputed on room build/sell (invalidate paths crossing changed tiles — V1 can afford the blunt "recompute all active paths" approach).
- **A\* failure is a first-class outcome:** no path → cancel the task, release all reservations (GDD Flow rule 8), re-queue the patient, fire a hint toast. Actors never stand frozen waiting for a path that can't exist.
- **Build-time reachability:** placement validation runs a BFS from the entrance — the new room's door must be reachable, and the build is rejected if it would sever any existing door's connectivity (GDD §5 placement validation).
- Movement system advances actors along paths at role-specific speeds; renderer interpolates.

### 2.5 Isometric rendering

- Standard 2:1 diamond projection: `screenX = (col − row) * TILE_W/2`, `screenY = (col + row) * TILE_H/2` (TILE_W=64, TILE_H=32).
- Layers (Pixi containers): ground → room floors → a single **depth-sorted layer** for walls, equipment, and actors, sorted by `(col + row)`.
- **Multi-tile objects don't get one sprite.** A single `(col+row)` anchor only sorts correctly for 1-tile footprints; a 2×1 X-ray machine or trauma bed drawn as one sprite will pop through actors walking beside it. Rule: every object spanning >1 tile is **sliced into per-tile sprites** (one column of the object per tile), each sorted by its own tile's key. M1's depth-sorting demo must include a sliced multi-tile object, not just capsule people, or it proves nothing.
- Camera: pan (middle-drag / WASD / edge scroll), zoom (wheel, 3 fixed steps). Camera is a transform on the world container.
- Picking: inverse iso transform mouse → tile for *ground* clicks; actors and tall objects (walls, machines) get explicit Pixi hit areas checked **first**, so clicking the upper body of an X-ray machine selects the machine — not the tile visually behind it.
- **DOM/canvas input routing:** pointer events originating on UI elements (`closest('[data-ui]')`) never reach world handlers — no pan/zoom/pick through a menu. Drag operations (camera pan, build rect) use pointer capture, so a drag that ends over a DOM panel completes or cancels cleanly instead of leaking.
- Placeholder art is **generated at runtime** (Pixi Graphics → textures): colored diamonds, extruded wall quads, capsule-people with role-colored bodies. Zero asset pipeline until the art pass.

### 2.6 Art pipeline & asset contract

Placeholder art and final art satisfy the **same contract**, so upgrading characters is an asset drop, not a refactor. `render/sprites.ts` is the single texture source (§3.1): it answers `textureFor(actorKind, facing, frame)` and `textureFor(objectId, tileSlice)` — today from runtime-generated Graphics, later from a loaded sprite atlas. Nothing else in the renderer knows which backend is active.

**Character sprite contract:**
- **Facings:** 4 diagonals — NE, NW, SE, SW (actors walk tile diagonals in 2:1 iso; N/S/E/W sets look wrong). NE/NW may be mirrored from SE/SW to halve the art budget.
- **Frames:** 4–8 frame walk cycle per facing + 1 idle frame.
- **Anchor:** at the feet (bottom-center), so the depth-sort key stays the actor's tile.
- **Scale:** consistent with the 64×32 tile — standing height ~48–64 px, one pixel density across all sprites.
- **Variety via palette swaps (DRY):** one base body rig; roles are outfit/color layers (teal nurse, white-coat doctor, navy rad tech, green RT, volunteer polo, patient gown) and patients get hair/skin-tone swaps. One rig, dozens of distinct people. Role colors live in `sim/data/roles.ts` — the same SSOT the placeholder generator already reads.
- **Format:** Pixi spritesheet (atlas PNG + JSON). A `manifest.ts` maps contract keys → atlas frame names; swapping art = swapping the atlas + manifest.

**Sourcing policy (in order of preference):**
1. **CC0 packs** (itch.io, OpenGameArt, Kenney) — license-safe, no obligations; expect pixel-editing for diagonal facings and medical wardrobe.
2. **CC-BY packs** (e.g., LPC collection) — fine, but requires a credits screen; track attributions in `docs/CREDITS.md` from the first asset onward.
3. **AI-assisted generation** — for style exploration and base frames; walk cycles need hand cleanup (Aseprite) for frame consistency. Generated assets get the same manifest treatment.
4. **Commission** — the small brief the palette-swap scheme enables: one rig, one walk cycle, 2 facings (+2 mirrored), outfit layers.

No GPL-only art (viral licensing), no assets without a stated license. **Timing:** M0–M3 run on placeholders by design (they make sim bugs more visible); the art pass is late-M4 or post-V1, once real gameplay has exercised the contract. **Status:** the art pass shipped as a procedural upgrade (`e653acd`) — 4 diagonal facings, soft-shaded rooms/walls/props, still 100% runtime-generated; a real atlas is still a future drop-in behind the same `characterKey`/`propKey` contract.

### 2.7 View rotation (scoped, not built — GDD §11 item 16)

Owner-requested 90° camera rotation is a **rendering-architecture milestone**, deliberately out of the input-polish pass. What it touches (all currently assume ONE orientation):

- **`iso.ts` projection + picking.** `toScreen`/`toTileFractional` are one hardcoded 2:1 transform and its exact inverse. Rotation needs these parameterized by orientation (0/90/180/270) — 4 forward transforms and 4 inverses that stay exact (picking is `test/iso.test.ts`'s contract).
- **Depth sort.** `depthKey = col + row` orders draw-back-to-front for the current view only. Each orientation has a different back-to-front axis (e.g. `col − row`, `−col − row`), so `depthKey` must become orientation-aware — and everything that sets `zIndex` (props, actors, walls, bubbles) reads it.
- **Walls.** `wallGraphic` maps each boundary edge to a fixed N/W-far / S/E-near screen quad + z-bias. Under rotation the same grid edge faces a different screen direction, so the far/near classification and quad geometry must re-derive per orientation.
- **Character facings.** The art pass added 4 sprite facings for ONE camera angle. Rotating the camera 90° remaps which world-direction a given screen-facing shows. Options: regenerate/keep all facings and pick by `(travelDirection − cameraOrientation)`, or accept that the existing 4 facings rotate with the camera (cheaper, likely correct since facing is derived from the grid step in `facingFromStep`, which itself becomes orientation-aware).

Done right it's centralized (nearly everything routes through `toScreen`/`depthKey`/`characterKey`), but it is a genuine milestone with its own pre-implementation review — not a polish tweak. The camera **input** layer (pan/zoom) is independent and already continuous.

## 3. Project layout

```
hospital-simms/
├── docs/                    # GDD + this plan
├── index.html
├── vite.config.ts
├── src/
│   ├── main.ts              # bootstrap: create sim, renderer, UI, main loop
│   ├── loop.ts              # fixed-timestep accumulator
│   ├── events.ts            # typed EventBus
│   ├── commands.ts          # CommandQueue + command types
│   ├── sim/
│   │   ├── world.ts
│   │   ├── clock.ts
│   │   ├── rng.ts
│   │   ├── entities/        # patient.ts, staff.ts, room.ts
│   │   ├── systems/         # spawn.ts, decay.ts, dispatcher.ts, movement.ts,
│   │   │                    # wayfinding.ts, treatment.ts, economy.ts
│   │   ├── path/astar.ts
│   │   ├── dailyStats.ts    # M4: DayTally/DayReport + dayNet
│   │   └── data/            # conditions.ts, rooms.ts, roles.ts, balance.ts, names.ts, thoughts.ts
│   ├── render/
│   │   ├── renderer.ts      # Pixi app, layers, camera, input, actor sync (monolithic by choice)
│   │   ├── iso.ts           # projection math + picking
│   │   └── sprites.ts       # runtime placeholder texture generation
│   └── ui/
│       ├── hud.ts  buildMenu.ts  hirePanel.ts  inspect.ts  toasts.ts  dailyReport.ts
│       ├── thoughtLog.ts  debugPanel.ts  checklist.ts  title.ts  gameOver.ts
│       ├── format.ts  modal.ts  dom.ts   # shared UI helpers (audit #6/#9)
│       └── ui.css
└── test/                    # vitest: unit + integration + the M4 balance harness
```

### 3.1 SSOT & DRY conventions (enforced from M0)

These are the rules that keep one fact in one place. They are not aspirational — milestone reviews and the DoD check them.

**1. `sim/data/` is the single source of truth for all game content.**
Every cost, salary, payout, duration, decay rate, footprint, and treatment path lives in the data tables (`rooms.ts`, `conditions.ts`, `roles.ts`, `balance.ts`) and **nowhere else**. The build menu renders costs *from* `ROOM_DEFS`; the hire panel renders salaries *from* `ROLE_DEFS`; the daily report reads fees *from* `CONDITION_DEFS`. If a literal dollar amount or game-minute count appears in `ui/` or `render/`, it's a bug. Adding a condition or room type must be a data-table edit plus (at most) a sprite — never a code change in dispatcher, UI, or economy.

**2. Types are derived from the data, not written beside it.**
Tables are `as const`; unions come from them: `type RoomType = keyof typeof ROOM_DEFS`, `type ConditionId = keyof typeof CONDITION_DEFS`. A new table row automatically flows into every switch and lookup the compiler checks — no parallel enum to keep in sync.

**3. The `World` is the runtime SSOT; render and UI are projections.**
Renderer and UI never keep authoritative copies of sim state — no `hud.cash` field that can drift from `world.economy.cash`. They read world state (continuous values, polled per frame) or react to events (changes), and any cached display value is invalidated by the event that changes it. Anything a player sees must be traceable to one field in `World` or one pure function over it.

**4. Derived values are computed, never stored.**
`effectivePriority`, room quality, treatment duration, success probability, arrival rate — each is one pure function in `sim/` (e.g. `successChance(staff, patient)`), called by both the sim *and* any UI that displays it (inspection panel showing odds uses the same function the treatment roll uses). Storing a derived value creates a second source that can go stale.

**5. One module per piece of math or protocol.**
- Iso projection: `render/iso.ts` exports exactly one forward transform and one inverse; picking is the inverse of the same function that placed the sprite. No re-derived projection math anywhere else.
- Time: the sim's unit is the **tick**. `clock.ts` owns all conversions (`gameMinutesToTicks`, etc.); data tables author durations in game-minutes and are converted **once at load**. No scattered `* 60 * 10` literals.
- Events and commands: single typed definitions in `events.ts` / `commands.ts`; payload shapes are declared once and imported everywhere.
- Entity state machines: legal transitions declared in one table per entity (used by both the transition guard and any debug UI), not implied by scattered `if`s.

**6. Tests import the real data.**
Vitest fixtures use the actual `sim/data/` tables (or factory helpers over them) — never re-declared local copies of room defs or balance numbers that silently diverge from the game.

**7. The GDD is descriptive; the code is authoritative.**
Once implementation starts, numbers in `GAME_DESIGN.md` are the *initial* values and rationale; `balance.ts` is the SSOT. Balance changes update the code, not the doc (the doc gets a pointer, not a mirror).

## 4. Milestones

Each milestone ends **runnable and demonstrable**. Estimates assume focused sessions; treat as sequencing, not deadlines.

### M0 — Scaffold & iso world (the "empty lot")
- Vite + TS strict + PixiJS + Vitest scaffold; ESLint/Prettier (including `no-magic-numbers` scoped to `ui/` and `sim/systems/`, allowlisting 0/1-style values — the lint teeth behind §3.1 rule 1).
- `sim/data/` tables stubbed with `as const` + derived types (§3.1 rules 1–2) *before* any consumer exists, so every later milestone builds on the SSOT pattern instead of retrofitting it.
- 40×40 iso grid rendered with generated placeholder tiles; camera pan/zoom; tile hover highlight + coordinate readout.
- Fixed-timestep loop running with a visible tick counter; pause/1×/2×/3× buttons wired through the loop layer (speed lives outside the sim; the command queue drains even while paused — prove it here with a debug command).
- **Demo:** scroll around an empty lot; clock runs; speed controls work.

### M1 — Building & walking (the "aquarium")
- Room placement: drag-rect ghost preview → validate (bounds, overlap, min size) → build with walls/door; sell-back. Two room types wired (exam room, waiting room).
- A* pathfinding + movement system.
- Debug spawn button: a patient walks from entrance to a clicked tile. Depth sorting proven with actors walking behind/in front of walls **and a sliced multi-tile object** (§2.5).
- **Tests:** astar (including no-path), room validation (including entrance-reachability BFS).
- **Demo:** build rooms, watch a wandering patient path around them correctly.

### M2 — The core loop, minimal (the "vertical slice")
- One condition end-to-end: **Flu**. Reception, triage, waiting room, exam room; receptionist, nurse, doctor.
- Full patient state machine, dispatcher (acuity+wait ordering), treatment timer, discharge/death/AMA outcomes, health/patience decay with mood bubbles.
- Hire panel (fixed candidate pool) + fire from inspection panel; salaries charging, treatment revenue, cash HUD.
- New-game start state: reception + waiting room pre-built, one receptionist hired (GDD §9 first-run).
- Procedural names for patients and staff (`sim/data/names.ts`, seeded RNG) shown in panels and toasts from the first playable build.
- **Debug panel** (dev-only, toggled with backtick): spawn a chosen condition, force death/AMA/complication on a selected patient, fast-forward one game-day, toggle tile overlays (walkability; auras once M3 lands). Interactive balancing starts here, not at M4.
- **Tests:** dispatcher assignment, decay-to-death, economy math, treatment-failure complication path (health penalty + re-queue).
- **Demo:** the game is *playable and losable* — under-hire and people die, cash can run out.

### M3 — Full V1 roster (the "real game")
- All 6 conditions, all 8 room types, all 6 roles; multi-step paths (fracture, pneumonia) with re-queueing; dual-staff ER treatment (chest pain); acuity-weighted spawn mix + reputation case-mix shift (GDD §3).
- **Room props** for the new types (X-ray machine, ER trauma bed, nebulizer station, atrium help desk) plus visible waiting-room chairs — fixed auto-placement, data-driven in `rooms.ts` like the exam bed, each respecting the interior-connectivity backstop and the §2.5 multi-tile slicing rule. No rearrange UI (post-V1).
- Wayfinding: wrong turns, lost wander + ❓ bubble, atrium (open-plan room kind) with guidance/comfort auras, volunteer greeter, staff-proximity rescue, self-recovery, 60-min reservation timeout.
- Reputation system + arrival-rate coupling; time-of-day arrival curve; skill affecting speed/success.
- Inspection panels for patient/staff/room; notification toasts with **click-to-jump camera** (toast carries an entity/tile ref; camera pans to it); room quality from size.
- **Aura coverage overlay** in build mode (atrium ghost radius + all existing coverage tinted) — reuses the M2 debug-overlay tile-tint layer.
- **Thought log** UI: sim emits `patientThought` events at mood-bubble moments; the log is a capped scrollback rendered from them (pure projection, per §3.1 rule 3).
- **Tests:** multi-step path re-queue, dual-staff reservation (deadlock-free), **reservation release on death/AMA mid-walk** (no leaked staff), priority aging (no low-acuity starvation), reputation math, wayfinding (lost → aura rescue re-path; lost → 60-min timeout releases reservation and re-queues with the accumulated wait clock; aura grid invalidation on atrium sell / greeter fire). **Added at the M3 gate:** aura invalidation on atrium *build* and on greeter *arrival*; comfort-aura patience math (×0.75, stacking with standing ×1.5); per-step billing survives AMA/death after step 1; staff-proximity rescue (distinct from aura rescue); wrong-turn chance is 0 inside an aura and scales with the wayfinding stat; a lost patient's patience decays even in stage `reserved`; firing one of two gathered ER staff cancels per Flow rule 8; spawn mix follows the balance weights; fixed-seed determinism replay (two identical runs, identical event logs).
- **Intra-M3 order (dependencies):** 1) roster + spawn mix + multi-step + dual-staff (data/dispatcher only) → 2) props + greeter post generalization → 3) aura grid + invalidation hooks → 4) `wayfinding.ts` (needs the grid) → 5) comfort aura in decay → 6) UI last (staff/room selection → inspection panels; event tile snapshots → click-to-jump; aura grid → overlay; `patientThought` events → thought log).
- **Demo:** full V1 loop with meaningful build/hire strategy.

### M4 — Feel & finish (the "ship it")
- Daily report modal; bankruptcy lose-state + game-over screen; new-game flow.
- Balance pass driven by a **headless sim harness** (run N days at various build/hire configs in Vitest, assert survivability envelope — this is the payoff of the renderer-free sim).
- Polish: hover cursors, build-mode affordances, keyboard shortcuts, mood-bubble tuning, title screen, guided first-run checklist (GDD §9).
- Stretch (only if time allows): save/load to localStorage — note this is *not* free: entities are classes with Maps and in-flight paths, so each needs an explicit `toJSON`/`fromJSON` pair (budget a session for it). Deploy to Vercel. *(Both SHIPPED post-M4: save/load as Persistence Phase 1 — explicit per-entity serializers exactly as budgeted; Vercel deploy live at https://hospital-sims.vercel.app with git-connected auto-deploy.)*
- **Demo:** a stranger can open the URL and play 3 in-game days without instruction.

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Isometric depth-sorting bugs (actors popping through walls/machines) | Single sorted layer, `(col+row)` key, **multi-tile objects sliced per tile** (§2.5); prove both in M1 before any gameplay exists |
| Dispatcher deadlocks (dual-staff ER reserves a doctor while a nurse is never free) | All-or-nothing reservation: acquire every required resource atomically or release and retry next tick; unit test the contention cases in M3 |
| Reserved staff leak when a patient dies/AMAs mid-walk | Every terminal patient event releases all reservations (GDD Flow rule 7); dedicated M3 test: death-during-walk with dual-staff reserved |
| Low-acuity starvation under acuity-first dispatch | Priority aging (GDD Flow rule 6); M4 harness asserts acuity-5 patients get treated under sustained load |
| Lostness stalls throughput invisibly (reserved rooms idle while their patient wanders) | 60-min reservation timeout (GDD §3) + ❓ bubbles + lost-count in daily report; M4 harness asserts a zero-atrium large hospital degrades but doesn't deadlock |
| Wayfinding makes determinism fragile (per-tile and per-5-min rng draws mean any iteration reorder shifts every later roll) | All rolls through `world.rng` in fixed system order; fixed-seed replay test added to the M3 list |
| A patient lost en route to a check-in queue slot stalls the desk for everyone behind them | Check-in queue walks never roll wrong turns (GDD §3 M3-gate ruling) |
| Balance is unfun (too easy/too brutal) | Headless sim harness in M4 + all tuning in one `balance.ts` file |
| Scope creep toward Theme Hospital's full feature set | GDD §11 is the parking lot; nothing enters V1 without cutting something else |
| Pixi v8 API drift vs. training-data knowledge | Pin the version; consult current docs when wiring the renderer in M0 |

## 6. Definition of done (V1)

- All M0–M4 non-stretch items complete; Vitest suite green.
- SSOT audit (§3.1) passes: no game-content literal (cost, fee, salary, duration, rate) exists outside `sim/data/`; a grep of `ui/` and `render/` for numeric game constants turns up only layout values.
- 60fps with 100 concurrent patients + 20 staff on a mid-range laptop.
- A full session — new game → build → hire → survive or go bankrupt — with no console errors.

**Deploy (stretch) — DONE (2026-07-17):** live at **https://hospital-sims.vercel.app**. Parked until after the art pass by owner ruling (a first public URL is more shareable with real art than placeholder rectangles), then shipped. Host **Vercel** (root-domain URLs suit the `?seed=` sharing story), public repo `lgorby/hospital-sims`, git-connected auto-deploy off `master`. The `vite build` output is a pure static site portable to any host — see `docs/HANDOFF.md` "Next" for the full deploy record (team/project, backup branch, CLAUDE.md handling).
