# Handoff — Hospital Simms

**Last updated:** 2026-07-17 (after the Expansion 1 commit)
**State: M0–M4 + audit + save/load + V1 DoD checks (SSOT/perf/QA, all passed) + Expansion 1 (GDD §12: 6 rooms, 2 roles, 8 conditions, category dropdowns) complete. Next: deploy (Vercel) + art pass; Phase 2 (seed challenges) unblocked; balance-watch the expansion roster.**

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
| `16ade07` | Full V1 roster: 6 conditions with weighted spawn mix + rep case-mix shift, multi-step + dual-staff paths, room props, atrium/greeter/aura grid, complete wayfinding system, comfort auras, inspection panels, click-to-jump toasts, aura overlay, thought log, A* per-walker path variety + fixes from the M3 adversarial review (3 major, 5 minor) |
| `7e27b63` | `/run-hospital-simms` skill: headless browser driver (playwright-core + system Edge) for driving the live game |
| `12e6aef` | M4 feel & finish: daily report modal + per-day tally (`src/sim/dailyStats.ts`), day-close wait bonus, bankruptcy lose-state + game-over screen, title screen + `?seed=` new-game flow, first-run checklist, keyboard shortcuts (Space/1/2/3), hover cursors, headless balance harness + balance pass (arrivals 3.0→1.5/h, wait-bonus threshold 120→240m), `debugSetCash` + fixes from the M4 adversarial review (2 major, 3 minor, 4 nit) |
| *(audit)* | Full-codebase audit (owner-requested, 14 findings fixed): triage lost-timeout strand bug (MAJOR), stage-transition guard table (`setPatientStage` + `stageViolations`), EventBus handler isolation + rAF-chain protection, Pixi-init failure screen, GDD §5 waiting-room-quality patience decay implemented, shared `ui/dom.ts`·`ui/modal.ts`·renderer `pickAt`, `BALANCE.stats` scale SSOT, debug-command payload guards, entrance-overflow standing spots, tech-plan drift corrections + `docs/PERSISTENCE_PLAN.md` |
| *(save/load)* | Persistence Phase 1 (plan §1): `SeededRng.getState/setState`, explicit per-entity serializers + grid RLE in `src/sim/save.ts` (`serializeWorld`/`saveToString`/`loadWorld`), border validation of shape AND referential integrity, localStorage slots (3 manual + midnight autosave) + file export/import (`src/ui/saveStore.ts`, `src/ui/saveLoad.ts`), `?load=<slot>` boot path, title Continue/Load/Import + fixes from the save/load adversarial review (2 major, 6 minor, 2 nit) |
| *(expansion 1)* | V1 DoD sweep (SSOT audit clean of majors; perf PASS 60fps @110 patients; hostile QA playthrough: zero game errors) + GDD §12 Expansion 1: ultrasound/CT/MRI/nucMed/dialysis/surgery, sonographer+surgeon, 8 conditions (imaging→consult chains, imaging→OR dual-staff, dialysis, CT→ER), `SAVE_VERSION` 2 with v1 loadable (candidate-pool top-up migration), §9 bottom-bar category dropdowns (mutually exclusive), aura-overlay render caching, staff-age fix, checklist load-seeding + fixes from two parallel adversarial reviews (1 major, 5 minor, ~10 nit) |

**V1 is playable end-to-end:** `npm run dev` → localhost:5173 shows the title screen; New Game navigates to `?seed=<random>` (seed shown in the HUD — a bare `?seed=1337` boots deterministically, which the `/run-hospital-simms` driver skill relies on). All 6 conditions arrive on a reputation-shifted weighted mix; wayfinding/atriums/auras as before. New in M4: a pausing daily-report modal at midnight (counters, money, avg door-to-first-treatment wait, day-close rep bonus ★), bankruptcy lose-state (below −$10k a full day → foreclosure screen → New Game), guided first-run checklist, Space/1/2/3 speed shortcuts (suppressed while a modal is open), Esc peels build-mode→selection, hover cursors. Backtick debug panel gains "Set cash to double debt limit" (drives the game-over path). 130 Vitest tests, lint and build green.

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
- **Day tallies increment at the same choke points that emit events** (M4): `killPatient`/`dischargePatient`/`patientLeavesAma`/`billFee`/`applyReputation` in world.ts, payroll in economy.ts, lost episodes in wayfinding.ts, first-treatment wait in the dispatcher's promotion (kind `treatment` only, `firstTreatedAtTick` once-guard — regression: `test/m4.test.ts` pipeline test). `repDelta` records the APPLIED (clamp-aware) delta.
- **`closeDay` order is load-bearing** (M4): wait bonus applied → report snapshotted → tally reset → `dayEnded` emitted. `dayEnded`'s payload is a `DayReport` (superset of the old `{day}`).
- **Bankruptcy** (M4): strictly below the threshold, sampled once per tick after all systems (intra-tick dips can't false-trigger); recovery resets the countdown; `gameOver` emits once and `tick()` becomes a no-op — commands still drain, so debug commands after game over are inert by construction.
- **A visible `.modal-overlay` owns the clock** (M4 review): keyboard speed shortcuts check for one before touching the loop; the game-over screen hides an open daily report.
- **Harness validity is mutation-checked, not assumed** (M4 review): the zero-atrium test probes reservation ages EVERY tick (a stuck reservation fails the bound even if it resolves by day end) and asserts a lost holder was actually observed; the acuity-5 test pins reputation at max for genuine overload (AMA assertion proves it). Room partitioning (one ER, X-ray throttle) means the aging *mechanism* is guarded by unit tests, not the harness — see the comment in `test/harness.test.ts` before "improving" either.
- **All patient stage writes go through `World.setPatientStage`** (audit #5): kind transitions validate against `LEGAL_STAGE_TRANSITIONS` (declared in `entities/patient.ts`), plus the semantic invariant that `waiting` requires `acuity !== null` (the audit-#1 strand-bug class). Violations are counted in `world.stageViolations` and console-warned, never thrown; the harness and audit tests assert the counter stays empty. Never assign `patient.stage` directly in sim code (test fixtures may).
- **Lost-timeout is reservation-kind-aware** (audit #1): a lost patient timing out of a TRIAGE reservation returns to `waitingTriage`, mirroring `cancelReservation`. Regression: `test/audit.test.ts`.
- **EventBus handlers are isolated** (audit #2): a throwing subscriber is caught + logged, siblings still run, and the loop schedules the next rAF *before* the frame body so no exception can sever the chain. Don't move `requestFrame` back to the end of `frame()`.
- **`BALANCE.stats` (1–5) is the scale SSOT** (audit #7) for acuity, skill, and wayfinding rolls, UI star rows, and the discharge-gain span. **Waiting-room quality slows seated patience decay** (audit #4, GDD §5): `waitingQualityMultiplier` in formulas.ts, floored like treatment duration.
- **Debug command payloads are guarded at the sim boundary** (audit #8): `debugSetCash` requires finite, `debugFastForward` clamps to 7 days — the CommandQueue is the public mutation API, so garbage must die at the border.
- **`loadWorld` never half-constructs** (save review MAJOR 1): the FULL payload — shape, then referential integrity (global id uniqueness, `nextEntityId` above every saved id, every reservation/stage/duty/queue/grid-tile reference resolves, rects in bounds) — is validated before `new World` exists; every failure is `{ok:false, reason}`, never a throw. File import is untrusted input by design (PC-to-PC). Regressions: `test/save.test.ts` border suites.
- **The round-trip gate's premises are asserted, not assumed** (save review MAJOR 2): at the save tick the scenario proves lost/queued/checking-in/at-entrance/leaving/dead patients, a firing staff member, a pending `dispatchHoldUntil`, both reservation kinds AND phases — then save→load→run-past-midnight must produce identical event logs and state. A balance change that hollows the scenario fails loudly; don't weaken the asserts.
- **The save payload string IS the contract:** slots store exactly `saveToString` output (no envelope); UI metadata (savedAt/day/cash/seed) lives in a separate meta key. Byte-identity of save→load→save is pinned by test and depends on serializer key/insertion order — don't reorder.
- **Adding a World-level mutable field requires a deliberate save decision** (plan rule 6): `SaveData` + `serializeWorld` + validate/restore in `loadWorld` + `SAVE_VERSION` bump. Entity fields are compile-enforced by the `Saved*` readers; World-level fields are NOT — the checklist is the guard.
- **Day derivation lives only in `clock.ts`** (`dayOfTick`) — the UI slot metadata uses it; never re-derive from `TICKS_PER_DAY`.
- **`isLoadableVersion` is the ONE version-acceptance policy** (Expansion 1): accepts 1..`SAVE_VERSION`; loadWorld's gate and the UI import pre-check both call it. The v1→v2 migration is a no-op EXCEPT `World.topUpCandidates()` (restore-time pool refill so predated roles are hireable) — a strict no-op on complete pools, proven by the untouched byte-identity test. Runs AFTER `restorePrivateState` (minted ids must come from the restored counter).
- **`auraCoversTile` (formulas.ts) is the one aura-membership formula** — `refreshAuras` fills its grid with it, the render ghost/hover preview asks it directly. **The render overlay is cache-keyed on `World.auraRevision`** (+ ghost rect / hovered tile only while placing an atrium) — a new overlay input must join the key. `auraRevision` is deliberately NOT saved (derived, resets on load).
- **Bottom-bar panels are mutually exclusive dropdowns** (§9 owner ruling): the `BottomBarDropdowns` coordinator owns ALL open/close state; panels register and never know each other. Its Escape listener is capture-phase and consumes the event ONLY when it closed a panel — that's what keeps M4's "Esc peels one layer" true; don't add independent Esc listeners.
- **Build-menu categories derive from `CATEGORY_LABELS`** (compile-complete `Record<RoomCategory, string>`, insertion order = display order) — a new category cannot be labeled yet invisible. `PROP_STYLE[*].tiles ≤ 2` is test-enforced (renderer strips slice single/west/east only).
- **The harness's black-envelope assertion measures the OPERATING envelope** (Expansion 1 ruling): the reference build's expansion wing is bankrolled in the fixture; capital costs are deliberately outside the assertion (see `test/harness.test.ts`). Every §12 condition must discharge ≥1 patient in the 5-day run — don't drop those per-condition asserts.

## Working agreements (user-established)

1. **Per milestone:** implement → **independent adversarial review agent** (fresh context, docs as contract, ordered findings with severity + file:line) → fix ALL findings → add a regression test per major → build/test/lint green → **commit** → next milestone. The user explicitly wants the review step; don't skip it.
2. SSOT/DRY per tech plan §3.1 — the ESLint `no-magic-numbers` scoping to `ui/` + `sim/systems/` is the enforcement teeth; extend, don't weaken.
3. Balance changes edit `src/sim/data/balance.ts`, not the GDD (GDD numbers are initial values by declaration).
4. User cares about game feel: they requested the wayfinding/atrium mechanic, the character upgrade, and the overlap fix. Visual polish requests are welcome mid-milestone.

## Next: V1 stretch + definition-of-done checks (tech plan §6)

- **Save/load Phase 1: DONE** (see commit table). Phases 2–3 (seed challenges, lockstep multiplayer) are scoped in `docs/PERSISTENCE_PLAN.md` — Phase 2 needs only the Phase-1 determinism guarantees, now in place. Owner rulings recorded from the save review: paused-modal close restores speed 0 (deliberate DailyReportModal deviation), `?load=` persists in the URL like `?seed=`, map dims are baked into saves (comment beside `BALANCE.map`).
- **Deploy** (Vercel, stretch).
- **Art pass** (tech plan §2.6 contract — `characterKey()` and the prop-slice lookups are atlas-ready).
- **V1 DoD still unchecked:** 60fps with 100 patients + 20 staff on a mid-range laptop (profile it); a manual full-session playthrough for console errors; the §3.1 SSOT grep audit.
- **Balance watch:** the M4 pass tuned arrivals to 1.5/h and the wait-bonus threshold to 240m against the harness's then-6-room reference build (see `balance.ts` comments); the harness build now includes an Expansion-1 wing (12 rooms, capital bankrolled — operating envelope only). Expansion roster numbers are initial values: watch stroke (acuity 1, 20m CT → 120m ER) death rates at low rep, and OR contention (gallstones+appendicitis share it) — via the harness.

## Gotchas

- **Windows + PowerShell 5.1.** No `&&`/`||` chaining (use `if ($?) { }`). Use the Write/Edit tools for file content — a `Get-Content`/`Set-Content` round-trip once mangled UTF-8 `§` chars.
- `as const` balance tables produce literal types — widen explicitly where mutated (`cash: number = BALANCE...`).
- The dev server may already be running in a background task; Vite HMR picks up edits.
- Queue slot tiles clamp at obstacles and stack (documented); reception's door orientation matters for queue room (see `newGame.ts` comment).
- `debugWalkTo` command is test/debug-only; idle clicks select patients.
- Review agents: give them the docs as contract + explicit hunt list + severity format; they've each earned their cost (picking off-by-half-tile, pause deadlock, spawn-rate inflation ×1.8, reservation stalls).
