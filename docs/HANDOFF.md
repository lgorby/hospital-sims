# Handoff — Hospital Simms

**Last updated:** 2026-07-17 (after the M3 commit)
**State: M0–M3 complete and committed. Next milestone: M4 (feel & finish).**

## What this project is

An isometric hospital tycoon game — RCT/Theme Hospital DNA. Patients arrive, check in, get triaged, wait (health and patience decay), get treated by the right staff in the right room, and are discharged, die, or walk out. The player builds rooms and hires staff; money and reputation are the score.

Two documents are the contract; read them before writing code:
- `docs/GAME_DESIGN.md` — the design: core loop, condition/room/staff rosters, **Flow & edge rules 1–14** (canonical answers to every lifecycle edge case), balance defaults, roadmap.
- `docs/TECH_PLAN.md` — the architecture: sim/render split, §3.1 SSOT rules, §2.6 art contract, milestones M0–M4 with per-milestone test lists, risk table.

Both were hardened by independent adversarial reviews before any code was written, and every milestone since has been reviewed the same way.

## Where things stand

| Commit | Contents |
|---|---|
| `3c2f3bd` | M0 (scaffold, iso world, loop) + M1 (rooms, A*, walking) + fixes from two code reviews |
| `f6ecf05` | M2 (playable vertical slice) + fixes from the M2 review (12 findings) |
| `d4567a3` | Placeholder-plus characters + V1 collision model (Flow rule 14) |
| `8ede235` | M3 gate: two adversarial pre-M3 reviews (code gaps + plan gaps): 11 code fixes with 12 regression tests, and 19 plan rulings written into the GDD/tech plan (look for "M3-gate ruling" / "M3 ruling" markers) |
| *(M3)* | Full V1 roster: 6 conditions with weighted spawn mix + rep case-mix shift, multi-step + dual-staff paths, room props, atrium/greeter/aura grid, complete wayfinding system, comfort auras, inspection panels, click-to-jump toasts, aura overlay, thought log, A* per-walker path variety + fixes from the M3 adversarial review (3 major, 5 minor) |

**The full V1 loop is playable now:** `npm run dev` → localhost:5173. All 6 conditions arrive on a reputation-shifted weighted mix; fractures/pneumonia re-queue between X-ray and their second step; chest pain takes a doctor+nurse ER team. Patients take wrong turns on long walks (❓ wander) unless atriums with posted greeters cover the routes; comfort auras slow patience decay. Click anything for its inspection panel (Fire/Sell), click toasts/thoughts to jump the camera, select an atrium or place one to see aura coverage. Backtick opens the debug panel (per-condition spawn, force outcomes, fast-forward, walkability overlay). 119 Vitest tests, lint and build green. Fixed seed 1337 in `main.ts` (new-game flow randomizes it in M4).

## Architecture in five sentences

1. `src/sim/` is a pure-TS, deterministic, fixed-timestep (10 tps) simulation — no Pixi, no DOM, fully unit-testable; `World.tick()` runs systems in order: spawn → decay → thoughts → dispatcher → wayfinding → movement → treatment → economy (wrong-turn rolls fire inside movement, per tile stepped; wayfinding runs before movement so wander steps and recoveries apply the same tick).
2. `src/loop.ts` owns speed/pause (NOT the sim) and drains the CommandQueue every frame even at speed 0 ("build while paused"); it has an injectable `LoopHost` so tests can hand-crank frames.
3. `src/render/` (PixiJS v8) is a projection: iso projection math only in `iso.ts`, all textures runtime-generated in `sprites.ts` behind a lookup contract an atlas will later satisfy, actors synced by diffing world maps each frame.
4. `src/ui/` is DOM overlay (`data-ui` attribute guards input routing); it reads World directly or reacts to events, never caches authoritative state.
5. Rooms use **edge walls** (footprint tiles stay walkable; walls live on boundary edges, crossed only at the door; open-plan rooms like the atrium have no walls) — this is load-bearing for pathfinding, validation, and rendering.

## Invariants the reviews established (do not regress)

- **Flow rule 7:** any terminal patient event (death/AMA/discharge) releases everything they hold — queue slot, seat, reservation (room + staff) — from ANY stage.
- **Flow rule 8:** a reservation participant who stops without reaching the room ⇒ `cancelReservation` (release + re-queue + hint toast). Never a silent stall; `promoteGatheredReservations` checks this every tick.
- **Build validation** (`src/sim/build.ts`): bounds/size/overlap/cash, no actors (patients AND staff) on footprint, door must open onto corridor **or open-plan tile**, entrance-reachability BFS for the new door + every existing door + every person's standing tile (no trapping).
- **Sell validation:** room must be unreserved and empty of people; selling a waiting room re-seats its waiters.
- **Check-in desk works only while a receptionist is posted and arrived** — mid-check-in staffing loss reverts the patient to the desk slot.
- **`treatmentDurationTicks` has a quality floor** (0.7×) — without it, oversized flat-cost rooms are an infinite-throughput exploit.
- **Spawn is per-tick Bernoulli** (`rate/ticksPerHour`) — exact expected rate. An accumulator+jitter scheme was rejected for inflating slow rates ×1.8.
- **Collision (Flow rule 14):** walkers pass through in motion; standing spots are exclusive (`isTileClaimed` in destination pickers); hard blocking is deliberately post-V1.
- **Rule-8 cancellation is a recovery, not a spin (M3 gate):** the dispatcher never reserves a room the patient can't path to (`canReachRoom`), a cancelled patient carries a `dispatchHoldUntil` retry hold, and the layout hint is `hintOnce` per patient. Regression: `test/reviewGate.test.ts`.
- **Flow rule 3 (M3 gate):** patience decays only when `walkerArrived` — purposeful walking is free. M3 lostness must count as waiting via the lost sub-state, NOT by weakening this gate.
- **Flow rule 6 (M3 gate):** the wait clock (`waitingSince`) survives every re-queue — reservations stash it in `Reservation.patientWaitingSince` and every re-queue path restores it. Only new queue classes (check-in→triage→treatment) and terminal events reset it.
- **Flow rules 4/14 (M3 gate):** overflow waiters and released staff get real standing destinations via `world.nearestFreeStandingTile` (BFS; excludes walled-room interiors, door tiles, and claimed spots). Nobody loiters on the desk slot or inside treatment rooms.
- **Check-in routing (M3 gate):** staffed receptions beat unstaffed ones; patients queued at a dead desk migrate when a staffed desk has capacity.
- **Lost walkers stay wanderers (M3 review):** `recomputePaths` and `assignWaitingSpot` skip lost patients — the retained target is a RECOVERY destination, never an active walk. Only `tryRecover` re-paths.
- **Arrival ends the walk (M3 review):** `onPatientTileStep` never rolls on the destination tile, and promotion to `active` defensively clears `lost` — treatment can never run on a lost patient (rule 3 decay would leak).
- **Aura grid is signature-cached per tick** (`auraCheckedTick`, invalidated end-of-tick and per command) — has* getters are cheap enough for the per-frame overlay; don't add per-query signature scans back.
- **Prop strip length lives ONLY in `PROP_STYLE[id].tiles`** — placement and render slicing both read it (§3.1 rule 5).

## Working agreements (user-established)

1. **Per milestone:** implement → **independent adversarial review agent** (fresh context, docs as contract, ordered findings with severity + file:line) → fix ALL findings → add a regression test per major → build/test/lint green → **commit** → next milestone. The user explicitly wants the review step; don't skip it.
2. SSOT/DRY per tech plan §3.1 — the ESLint `no-magic-numbers` scoping to `ui/` + `sim/systems/` is the enforcement teeth; extend, don't weaken.
3. Balance changes edit `src/sim/data/balance.ts`, not the GDD (GDD numbers are initial values by declaration).
4. User cares about game feel: they requested the wayfinding/atrium mechanic, the character upgrade, and the overlap fix. Visual polish requests are welcome mid-milestone.

## Next: M4 — feel & finish (tech plan milestone definition is authoritative)

- **Daily report modal** at midnight (per-day counters: treated/died/left/lost, revenue, expenses, rep change) — this also unlocks the **day-close reputation bonus** (+10 for avg door-to-first-treatment wait < 2h; constants staged in `balance.ts`, deferred here by M3-gate ruling).
- **Bankruptcy lose-state** (cash below −$10,000 for a full game day; constants staged) + game-over screen; **new-game flow** (randomize + display seed — `main.ts` currently pins 1337).
- **Guided first-run checklist** (GDD §9), title screen, hover cursors, keyboard shortcuts, polish.
- **Headless balance harness**: run N days at various build/hire configs in Vitest, assert survivability envelope — the renderer-free sim's payoff. The M4 harness also owes two risk-table assertions: acuity-5 patients get treated under sustained load, and a zero-atrium large hospital degrades but doesn't deadlock.
- **Stretch:** save/load to localStorage (entities need explicit toJSON/fromJSON — budget a session); deploy.
- Then the art pass (tech plan §2.6 contract — `characterKey()` and the prop-slice lookups are atlas-ready).

## Gotchas

- **Windows + PowerShell 5.1.** No `&&`/`||` chaining (use `if ($?) { }`). Use the Write/Edit tools for file content — a `Get-Content`/`Set-Content` round-trip once mangled UTF-8 `§` chars.
- `as const` balance tables produce literal types — widen explicitly where mutated (`cash: number = BALANCE...`).
- The dev server may already be running in a background task; Vite HMR picks up edits.
- Queue slot tiles clamp at obstacles and stack (documented); reception's door orientation matters for queue room (see `newGame.ts` comment).
- `debugWalkTo` command is test/debug-only; idle clicks select patients.
- Review agents: give them the docs as contract + explicit hunt list + severity format; they've each earned their cost (picking off-by-half-tile, pause deadlock, spawn-rate inflation ×1.8, reservation stalls).
