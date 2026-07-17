# Handoff — Hospital Simms

**Last updated:** 2026-07-17 (after commit `d4567a3`)
**State: M0, M1, M2 complete and committed. Next milestone: M3.**

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

**The game is playable now:** `npm run dev` → localhost:5173. Flu patients arrive on the GDD's day-curve, queue at the pre-built reception, get triaged and treated if you build a Triage Bay + Exam Room and hire a Nurse + Doctor (Staff button). Backtick opens the debug panel (spawn, force outcomes, fast-forward, walkability overlay). 74 Vitest tests, lint and build green. Fixed seed 1337 in `main.ts` (new-game flow randomizes it in M4).

## Architecture in five sentences

1. `src/sim/` is a pure-TS, deterministic, fixed-timestep (10 tps) simulation — no Pixi, no DOM, fully unit-testable; `World.tick()` runs systems in order: spawn → decay → dispatcher → movement → treatment → economy.
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

## Working agreements (user-established)

1. **Per milestone:** implement → **independent adversarial review agent** (fresh context, docs as contract, ordered findings with severity + file:line) → fix ALL findings → add a regression test per major → build/test/lint green → **commit** → next milestone. The user explicitly wants the review step; don't skip it.
2. SSOT/DRY per tech plan §3.1 — the ESLint `no-magic-numbers` scoping to `ui/` + `sim/systems/` is the enforcement teeth; extend, don't weaken.
3. Balance changes edit `src/sim/data/balance.ts`, not the GDD (GDD numbers are initial values by declaration).
4. User cares about game feel: they requested the wayfinding/atrium mechanic, the character upgrade, and the overlap fix. Visual polish requests are welcome mid-milestone.

## Next: M3 — full V1 roster (tech plan milestone definition is authoritative)

Remaining scope (some M3 items landed early — noted):

- **Open the condition roster:** spawn all 6 conditions (`spawn.ts` currently hardcodes `'flu'`; roster + acuity-weighted mix per GDD §3). Multi-step paths (fracture: X-ray→casting; pneumonia: X-ray→resp) will exercise re-queueing — the machinery exists (`stepIndex`, per-step billing) but has never run multi-step end-to-end.
- **Dual-staff ER** (chest pain: doctor + nurse) — dispatcher supports N roles; needs the deadlock-free contention TEST from the tech plan's M3 list.
- **Wayfinding system** (GDD §3 "Getting lost", §5 atrium rules, §6 wayfinding table — all specced): `wayfinding.ts` system, lost as a **movement sub-state** (`lost: {since} | null` on the movement side, NOT a lifecycle stage), precomputed aura grid recomputed on build/sell/greeter-change, wrong-turn rolls, staff-proximity rescue, self-recovery, 60-min reservation timeout (compose with Flow rules 7/8 — `cancelReservation` already exists).
- **Atrium gameplay:** guidance aura (staffed), comfort aura (patience ×0.75), greeter posting (reuse the receptionist `post` duty pattern).
- **UI:** inspection panels (patient/staff/room, Fire/Sell buttons — selection already exists), **click-to-jump toasts** (toast carries entity/tile ref; camera pans), **aura coverage overlay** in build mode (reuse `showWalkOverlay` tile-tint pattern), **thought log** (`patientThought` events → capped scrollback).
- **Already done early:** reputation→arrival coupling, time-of-day curve, skill affecting speed/success, Flow-rule-5 missing-facility hints, room quality from size, priority aging.
- **M3 tests named in the tech plan:** multi-step re-queue, dual-staff reservation (deadlock-free), release on death mid-walk (exists), priority aging under load, wayfinding (aura rescue re-path; timeout release; aura invalidation on atrium sell / greeter fire).

After M3: M4 = daily report, bankruptcy lose-state, first-run checklist, headless balance harness, polish, save/load stretch. Then the art pass (tech plan §2.6 contract — `characterKey()` lookups are atlas-ready).

## Gotchas

- **Windows + PowerShell 5.1.** No `&&`/`||` chaining (use `if ($?) { }`). Use the Write/Edit tools for file content — a `Get-Content`/`Set-Content` round-trip once mangled UTF-8 `§` chars.
- `as const` balance tables produce literal types — widen explicitly where mutated (`cash: number = BALANCE...`).
- The dev server may already be running in a background task; Vite HMR picks up edits.
- Queue slot tiles clamp at obstacles and stack (documented); reception's door orientation matters for queue room (see `newGame.ts` comment).
- `debugWalkTo` command is test/debug-only; idle clicks select patients.
- Review agents: give them the docs as contract + explicit hunt list + severity format; they've each earned their cost (picking off-by-half-tile, pause deadlock, spawn-rate inflation ×1.8, reservation stalls).
