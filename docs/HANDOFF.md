# Handoff — Hospital Simms

**Last updated:** 2026-07-19 — **the OUTPATIENT STREAM shipped and is LIVE
(SAVE_VERSION 11, one-way)**; docs restructured; Departments Stage 2a still
blocked; the layout lesson opened (`docs/LAYOUT_PLAN.md`) with its Part B cut
by review.

## Read order

This file is **orientation only** and is meant to be read end-to-end in one
pass. Three companions carry the weight it used to:

| Doc | What it is | When to read |
|---|---|---|
| `docs/INVARIANTS.md` | The do-not-regress list — every rule an adversarial review established, each backed by a regression test. | **Before changing sim behaviour.** |
| `docs/CHANGELOG.md` | Shipped work: the per-commit table and completed epics, including superseded scoping kept for provenance. | On demand, when you need *why* a decision was made. |
| `docs/IMAGING_PLAN.md` | Why radiology is empty — the research, the chain inversion, and the missing outpatient channel. Blocks Departments Stage 2a. | Before any imaging or Departments work. |
| `docs/LAYOUT_PLAN.md` | The layout lesson — distance as a hidden throughput cost, plus §3's measurement-validity warning about the balance fixture. | Before any balance work. |
| `docs/GAME_DESIGN.md` · `docs/TECH_PLAN.md` | The two contracts — design (Flow rules 1–14, rosters, balance) and architecture (sim/render split, §3.1 SSOT, §2.6 art contract). | Before writing code. |

Both contracts were hardened by independent adversarial review before any code
was written, and every milestone since has been reviewed the same way.

> **Why the split (2026-07-19):** this file had grown to 108 KB / 745 lines and
> no longer fit in a single read — the exact failure an orientation doc exists
> to prevent. It was also carrying stale facts unnoticed: the "playable
> end-to-end" paragraph still claimed 178 tests and SAVE_VERSION 2 against an
> actual 655 and v10. Nothing was deleted in the split; it moved and was
> cross-linked. Keep this file short — if it stops fitting in one read, split
> again rather than letting it rot.

## What this project is

An isometric hospital tycoon game — RCT/Theme Hospital DNA. Patients arrive,
check in, get triaged, wait (health and patience decay), get treated by the
right staff in the right room, and are discharged, die, or walk out. The player
builds rooms and hires staff; money and reputation are the score.

## Current state (verified 2026-07-19)

**Live at https://hospital-sims.vercel.app** — pushing to `master`
auto-deploys, so **a push is a release decision for the owner, not routine
hygiene.**

| | |
|---|---|
| Tests | **690** (686 passed, 4 skipped), 49 files — `npm test` |
| Gates | lint, `tsc --noEmit`, `vite build` all green; CI runs the full gate on every push to `master` and every PR |
| `SAVE_VERSION` | **11** (`src/sim/save.ts:31`), v1–v11 loadable — **DEPLOYED, so one-way** |
| Content | **16 conditions — 14 emergency + 2 ELECTIVE referrals** · 15 room types (14 buildable, `resp` retired) · 11 staff roles |
| Working tree | clean. `d172f58` and earlier are pushed (LIVE). **`8ec700d`, `2288399`, `f9ecbbb` and this doc update are committed but NOT PUSHED** — owner held the deploy 2026-07-19 |

**SAVE_VERSION 11 is deployed, which makes it one-way.** Saves written by the
live build cannot be opened by the previous one — that is the bump doing its
job, but a rollback alone no longer undoes it: anyone who played post-deploy
could not load their save. Existing v1–v10 saves load fine. The v11 bump adds
NO field in either direction; it is owed to new CONTENT (two condition ids),
because an older deployed build would die on
`asOneOf(o.condition, CONDITION_IDS)` instead of refusing cleanly.

**THE GAME NOW HAS TWO DEMAND CHANNELS.** Emergency walk-ins, and scheduled
outpatient referrals that check in, skip triage, take one imaging study, pay
and leave. Referrals are **room-gated** — they only arrive for modalities the
player has built, which makes the stream opt-in and concentrates it on a
single-scanner player. Measured effect: MRI utilisation 3.9% → 16.8%, nucMed
3.3% → 13.5%, radTech 24% → 47.5%.

Playable end-to-end: title screen (New Game / Continue / Load / Import) →
`?seed=<n>` boots deterministically (the `/run-hospital-simms` driver relies on
this), `?load=<slot>` boots a save. Conditions arrive on a reputation-shifted
weighted mix; build bar has Basics · Imaging · Treatment · Comfort dropdowns,
mutually exclusive with the hire panel and thought log. Midnight daily report,
bankruptcy lose-state, first-run checklist, Space/1/2/3 shortcuts, staged Esc
peel. Save/load: 3 localStorage slots + midnight autosave + file export/import.

**Live-deploy watch items** (neither is a known defect; both are consequences
of Departments Stage 1 worth checking against real play):
- Existing saves should **add a third exam room**. Stage 1 measured real
  room-capture for players who do not rebuild (doctor-blocked-in-exam
  27t → 564t). The capacity hints say so, but only once the player is blocked.
- The Stage-1 **capex risk** (`DEPARTMENTS_PLAN` §3.8 point 3) is unmeasured,
  not proven safe: serving 17% of arrival weight went from a $5,000 room to a
  $200/day hire, and a 5-day probe cannot see a one-time capital deletion.

## Owner decisions — RATIFIED 2026-07-19

All four previously-pending "adopt-unless-vetoed" items were **adopted** by the
owner. Recorded here as settled; each remains a one-line revert if ever
revisited.

1. The clean-day +2 cleanliness rep bonus **requires ≥1 arrival that day** (the
   wait-bonus "an empty hospital isn't fast" principle — ratified §4.2 didn't
   contemplate empty days). `cleanlinessRepDelta` in `formulas.ts`.
2. **Idle EVS stand where released** instead of wandering (matches all released
   staff; §4.4's "wander" overstated). No code — it is the absence of a wander
   system.
3. **The Stage-3 restroom balance pass** (root-caused from the owner's
   "bathrooms don't look used" report): `breakWatchdogGameMinutes` 30→120 — the
   old value covered a ~14-tile walk (walking costs ~2.1 game-min/tile), so the
   watchdog aborted nearly every legitimate restroom trip MID-WALK (harness
   trace: 373 claims → 23 completions; patients visibly walked toward the
   bathroom and turned around — the exact reported symptom); plus
   `bladderPerGameHour` 10→12 and `spawnMeterMin` 60→45 (time-to-seek
   ~4.5h→~3.1h). Post-fix: 128–169 visits per 5-day run (was 12–33). All three
   in `BALANCE.needs`.
4. Room `broken: boolean` became **`brokenSince: number | null`** (one field
   serves the flag AND the instance-keyed breakdown toast — design MINOR 8).

## Architecture in five sentences

1. `src/sim/` is a pure-TS, deterministic, fixed-timestep (10 tps) simulation — no Pixi, no DOM, fully unit-testable; `World.tick()` runs systems in order: spawn → decay → thoughts → dispatcher → wayfinding → movement → treatment → economy (wrong-turn rolls fire inside movement, per tile stepped; wayfinding runs before movement so wander steps and recoveries apply the same tick).
2. `src/loop.ts` owns speed/pause (NOT the sim) and drains the CommandQueue every frame even at speed 0 ("build while paused"); it has an injectable `LoopHost` so tests can hand-crank frames.
3. `src/render/` (PixiJS v8) is a projection: iso projection math only in `iso.ts`, all textures runtime-generated in `sprites.ts` behind a lookup contract an atlas will later satisfy, actors synced by diffing world maps each frame.
4. `src/ui/` is DOM overlay (`data-ui` attribute guards input routing); it reads World directly or reacts to events, never caches authoritative state.
5. Rooms use **edge walls** (footprint tiles stay walkable; walls live on boundary edges, crossed only at the door; open-plan rooms like the atrium have no walls) — this is load-bearing for pathfinding, validation, and rendering.

## Working agreements (user-established)

1. **Per milestone:** implement → **independent adversarial review agent** (fresh context, docs as contract, ordered findings with severity + file:line) → fix ALL findings → add a regression test per major → build/test/lint green → **commit** → next milestone. The user explicitly wants the review step; don't skip it.
2. SSOT/DRY per tech plan §3.1 — the ESLint `no-magic-numbers` scoping to `ui/` + `sim/systems/` is the enforcement teeth; extend, don't weaken.
3. Balance changes edit `src/sim/data/balance.ts`, not the GDD (GDD numbers are initial values by declaration).
4. User cares about game feel: they requested the wayfinding/atrium mechanic, the character upgrade, and the overlap fix. Visual polish requests are welcome mid-milestone.


## Next

### START HERE (session handoff, 2026-07-19 late — BUBBLES + OBSERVATION-MEASURE session)

**Everything committed, NOT PUSHED** (owner held the deploy). Working tree clean,
690 tests, all gates green on `master`.

| commit | what |
|---|---|
| `8ec700d` | The measurement layer — COMPACT arm in `utilisationProbe`, per-condition floors in `harness.test.ts`. GREEN ON THE PRE-CHANGE BUILD. |
| `2288399` | Three contracts + six adversarial reviews. |
| `f9ecbbb` | **SHIPPED: in-world thought bubbles.** Render-only, no save cost. The card-history HALF is still open (task: rewrite PATIENT_THOUGHTS, no bump needed). |
| `2ceccda`…`36a8f68` | OBSERVATION v2→v3→NOT READY, and the measurement scaffold's findings. |

**OBSERVATION — BANKED AT v4 (owner call).** Five review rounds; still not
buildable. The v3 review found the deciding defect by re-running the probe with
a column I'd omitted: **the ward discharges only 33–38% of its patients** — I
anchored on 68% occupancy, which was throttled inflow, not health. Diagnosis: a
**bed-throughput ceiling** (2 beds × 360-min ≈ 8/day vs 11 arrivals/day). Salvage
(exam-room assessment) tested and FAILED at 38.8%. **v4 must match rate to bed
capacity (~0.3, or shorter stays, or more beds) and actually measure revenue.**
Full v4 requirements + the falsified claims are in `OBSERVATION_PLAN.md`'s status
block. **The prototype + sweep probe live on branch `observation-measurement`**
(NOT merged — throwaway, but it is the v4 starting point; do not delete it).
Sound results worth keeping: expansion binds at elevated demand ($3k 3rd bed
pays back ~1.4 days); the nurseTech never contends.

**NOW STARTING: the STAFF-SHIFTS epic** (owner ask, the biggest on the board).
12.5h shifts (12h + 30min lunch), rotation every 12h with overlap. **Staff work
24/7 today**, so shifts mean ~2× headcount for the same coverage → payroll
roughly DOUBLES against an M4-tuned economy. A whole-economy rebalance, not a
feature. Couples to the STAFF LOUNGE (a lunch break is a shift concept) and the
NURSE-TECH role (both scoped as tasks). Research + code map running; plan next.

**LESSON THIS SESSION, in one line:** measure the DECIDING metric, not the
flattering one. Observation's 68% occupancy looked healthy and hid a 38%
discharge rate. Always print the number that would falsify the feature.

**SIX independent adversarial reviews ran this session (two per contract, split
lenses). NONE of the three contracts shipped as drafted.** That is the workflow
working, not failing — every "no" arrived before code. Read `2288399`'s message
for the full accounting; the load-bearing findings:

1. **A new room type IS a SAVE_VERSION bump** (this file used to say otherwise
   — fixed above). But a **per-patient thought ring is NOT**: `asRecord`
   (`save.ts:407-410`) does no unknown-key check, so an old build silently
   ignores an added field. Every bump in the `save.ts:33-138` policy log is
   owed to a concrete old-build FAILURE. Check for one before spending a bump.
2. **Splitting review lenses is what caught the biggest finding.** The
   code/save reviewer audited the thought-ring bump's MECHANICS carefully and
   never questioned whether it was NEEDED; the design reviewer killed it
   outright. Run both lenses.
3. **Reviewers who RUN the change beat reviewers who read it.** Two separate
   contracts had their central claim falsified by a reviewer applying the diff
   and running the suite. Ask for that explicitly.
4. **`REFERENCE_BUILD` deaths are 0.20/day with a per-seed spread of 0.0–0.6.**
   Any deaths-based threshold at 5 seeds is unfalsifiable. Measure the spread
   BEFORE setting a threshold — the `IMAGING_4B` contract set three that could
   not fire.

**OBSERVATION EPIC — the rewrite spine is settled, contract not yet rewritten**
(`docs/OBSERVATION_PLAN.md`, NOT READY, 12 + 13 findings). Do not implement the
committed draft. The path both reviewers converged on:
- **Native conditions (`tia`, `syncope`) instead of lengthening `chestPain`
  and `headInjury`.** Honours the owner's stroke ask with the research's own
  answer (acute stroke belongs in a thrombolysis pathway; TIA is the canonical
  obs protocol), dissolves the stranding failure, and makes the measurement
  clean by construction. A new condition id is free on a bump already spent.
- **Nurse-tech staffing, not nurse-only.** PROVEN by a reviewer: a nurse-only
  240-min ward starves the 3-nurse pool and `appendicitis` discharges ZERO
  (`INVARIANTS.md:60`). Owner asked for nurse techs independently; they are the
  root fix, not a patch on duration or roster.
- **`tilesPerProp: 6`, not 8.** At 8, expanding 4×4→5×4 costs money and adds
  ZERO beds — half of all expansions add nothing, gutting the owner's
  "expanded with the increase in beds" ask.
- Walkouts in the revert set (they moved most: 9→32 on one seed), re-baseline
  on a ward-present build, RNG re-pins derived mechanically not predicted.

**NEW OWNER ASKS 2026-07-19, none started, all scoped:**
- **Nurse techs** — a role DISTINCT from EVS (owner ruling: "two entirely
  different duties"). EVS attends a TILE, a nurse tech attends a PATIENT — new
  claim shape, not a mess-system reskin. Patient load **6–9**. The design prize:
  in reality the CNA is WHY observation runs at 1 RN : 5–8 beds, so techs are a
  CAPACITY LEVER ("do I need a nurse or a tech?"), not a chore tax.
- **12.5-hour shifts, 30-min lunches, rotation every 12h with overlap.**
  **THE BIGGEST ITEM ON THE BOARD.** Staff currently work 24/7; shifts mean
  ~2× headcount for the same coverage, so payroll roughly DOUBLES against an
  economy tuned at M4 for continuous staff. A whole-economy rebalance, not a
  feature — its own plan, research and measurement pass.
- **Staff lounge (Comfort dropdown)** — couples to shifts: a lunch break IS a
  shift concept, so designing the lounge alone makes it decoration. Note the
  three-way interaction already recorded below: a ratio nurse who never returns
  to `idle` never goes off shift and never takes a break either.

### START HERE (previous session, 2026-07-19 evening)

**Everything is committed AND PUSHED through `d172f58`; the working tree is
clean.** Pushing to `master` auto-deploys, so this session's work is **LIVE**.
Treat any future push the same way — it is a release decision for the owner.

**Shipped this session:** the docs split (this file was 108 KB and no longer
fit in one read); the Departments Stage 2a contract, reviewed twice and
BLOCKED by measurement; the utilisation probe and the layout/compact-arm
measurements; the follow-the-patient pulse; the radiology research; and **the
outpatient stream (SAVE_VERSION 11)**.

**What to know before touching anything:**
1. **SAVE_VERSION 11 is deployed and one-way.** Another bump is a real cost to
   live players — spend it deliberately.
2. **`edProbe` now carries TWO layout arms** (REFERENCE and COMPACT) plus a
   `§5b guard × layout` matrix and an outpatient-with-3rd-radTech arm. Run
   both arms for anything touching throughput or contention.
   `test/utilisationProbe.test.ts` (`UTIL_PROBE=1`) gives per-room and
   per-role utilisation, which nothing had before.
3. **The per-milestone workflow is not optional and it keeps paying.** This
   session it caught 8 MAJORs in one contract, 12 in another, and — twice —
   overturned conclusions a reviewer and I had agreed on. Two contracts
   returned NOT READY and were rewritten before a line of code was written.
4. **Live-drive player-facing work.** A stage-guard defect shipped past the
   entire 674-test suite and was caught only by driving the real game.

**Open threads, highest-value first**

0. **MEASUREMENT VALIDITY — read `LAYOUT_PLAN` §3 before ratifying any balance
   decision.** `REFERENCE_BUILD` is the fixture behind every balance number
   this project has recorded. A compact arm (same 13 rooms, same staffing,
   **identical payroll** — only placement differs) measured **discharged +34%,
   died −44%, profit/day +60%**, and — the finding inside the finding —
   **sprawl was HIDING staff contention** (OR gather blocked ×3.9,
   blocked-on-nurse ×7.5). The fixture does not just shift numbers, **it
   changes which resource binds.** `edProbe` now carries BOTH arms; run both
   for anything sensitive to throughput or contention, and state the layout
   with every measurement.
1. **The layout milestone, Part A only** — `docs/LAYOUT_IMPL_PLAN.md`.
   **PART B IS CUT** by both reviews (its two named beneficiaries are type-
   and data-excluded; it introduces an abandon livelock and blinds the §5b
   guard). Part A survives but needs a v2 first — the header lists the five
   fixes, including that the build ghost is TICK-keyed not input-keyed, and
   that `findPath` to an unbuilt rect paths through where the wall will be.
   The prize is real and measured: **distance is worth +34% throughput and the
   game teaches none of it.**
2. **The capacity-hint defect** — MEASURED. `capacity:triage` shows 85% of all
   ticks saying "build another one" while triage rooms are ACTIVE 17.3% of the
   time and a nurse is IDLE in 68% of those ticks; the slot is consumed by a
   GATHER, not by treatment. `capacity:xray` fires 0.4% and is NOT a defect.
   Remedy is entangled with (1) — the honest fix may be about the walk rather
   than the wording.
3. **Imaging §4A / §4B** (`IMAGING_PLAN`) — the chain inversion (every imaging
   chain runs imaging → ER; reality is the ED ORDERS imaging mid-stay) and
   adding imaging to conditions that realistically get it (chest pain, weight
   10, currently gets none). §4B is the cheapest lever in the epic and raises
   X-ray, the modality reality says should dominate.
4. **Departments Stage 2a — STILL BLOCKED**, though less firmly. MRI moved
   3.9% → 16.8% and `capacity:mri` now fires, so a second suite is closer to a
   real decision. **Its own contract must re-run its §6 arms before the block
   lifts** — do not lift it on the strength of the outpatient numbers alone.
   The 24 review findings are the v2 spec in `DEPARTMENTS_IMPL_PLAN` §9.
5. **Owner asks, scoped but not built:** buildable walls to contain patients
   (a NEW primitive — walls today exist only as room boundary edges, one of
   the five load-bearing architecture sentences); purchasable land (map dims
   are BAKED INTO SAVES); hospital awards (reuse `SCORE_METRICS` +
   `MidnightModalCoordinator` as a THIRD claimant, not a new `dayEnded`
   subscriber); staff lounge.
6. **The Stage-1 capex risk** (`DEPARTMENTS_PLAN` §3.8 point 3) — unmeasured.
7. **`ED_PLAN` §3b/§4** — Stage B2 and Stage C, both DRAFT.

> **THE LESSON, and it has now happened five times in a row.** Measurement
> beats reasoning, including reasoning that a reviewer and I agreed on:
> - Departments asked "do suites make capacity too cheap?" — one direction.
>   The answer was the other: unaffordable at any price, because they produce
>   nothing.
> - The layout fixture turned out to be worth ±34% throughput, and to change
>   WHICH resource binds.
> - A distance tiebreaker in `availableStaff` looked like an obvious fix,
>   measured as a wash, and was reverted.
> - The outpatient rate BOTH the plan and the design review proposed (1.0)
>   tripped the plan's own falsification condition; 0.5 shipped.
> - That review's remedy for it ("the pressure is the point — hire a third
>   radiographer") made deaths WORSE on both arms.
>
> **Measure the demand side before designing capacity for it, and measure the
> remedy before believing it.**

*(Resolved 2026-07-19: `ED_PLAN` §5b item 5, the ED out-competing the hospital
for nurses — anti-capture guard on ratio extension, bounded by role headcount.
Surgeries restored 8.6 → 10.4 against a 10.8 baseline with deaths, walkouts and
profit all improving. Detail in `CHANGELOG.md` and `ED_PLAN` §5b.)*

### The workflow that keeps paying for itself

Every stage runs: plan → **2 independent adversarial pre-impl reviews** →
implement → post-impl review → fix ALL findings with a regression each → gates
→ commit. That caught 13 MAJORs in Departments Stage 1 alone, including a
retire mechanism that would not have compiled.

It has also **twice overturned conclusions the model and both reviewers
agreed on**: the ED probe falsified `availableStaff`'s ordering, and a reviewer
falsified the model's own reading of the respiratory-therapy research.
**Measure; do not reason from the plan.**

### Findings from the Stage 2a code map (2026-07-19)

Recorded here because they are cheap to lose and expensive to rediscover. They
remain valid for a Stage 2a v2 — the code map was not what stopped the stage.

- **The shared-wall seam is the biggest unknown.** `drawRoom`
  (`renderer.ts:392-496`) walks `boundaryEdges(room.rect)` with exactly ONE
  skip — the door. Two adjacent rooms therefore render **two** walls at the
  seam, and there is no suppression mechanism anywhere. Suppressing it breaks
  the per-room independence of `drawRoom` AND needs a new invalidation path,
  because `roomBuilt`/`roomSold` fire only for the changed room — a neighbour's
  seam would go stale forever. Most likely item to blow the "UI/render only"
  budget.
- **Suites cannot open into each other.** `build.ts:127-129` requires a door's
  outside tile to be walkable and roomless-or-open-plan. Every suite needs its
  own corridor-facing door, so "adjacent" is geometrically constrained and the
  auto-placer must find a legal corridor edge. No "find a legal adjacent rect +
  door" routine exists — `placement.ts` is 63 lines of pure rect arithmetic
  with no world access.
- **`capacityNeeds` actively contradicts the feature.** `needs.ts:334-375`
  tells the player a `single` room that is busy should be **"build another
  one"** — for exactly the five types this feature covers. This is a required
  `src/sim/` change, which contradicts the "UI/render only" framing.
- **`buildRoom` returns `void`** (`world.ts:745`), so a caller cannot learn the
  new room id. If departments are STORED rather than derived, the sim build
  path needs a signature change or a new command.
- **Derived-vs-stored `departmentId` changes the blast radius by ~a file.**
  Stored costs SAVE_VERSION 11, a `SavedRoom` frozen-position addition,
  `writeRoom`/`readRoom`, byte-identity fixture regeneration, AND a new class
  of border validation (referential integrity) `save.ts` has never needed —
  compounded because `loadWorld` must not mutate restored state, so a dangling
  id cannot be repaired at load. Derived costs zero save changes.
- **Group actions make partial success reachable.** Sell/Close must fan out to
  N independently-gated commands; there is no transaction concept in the
  command queue and `sellRoom` is private with no batch entry point.

### Scoped, not built

- **DEPARTMENTS EPIC — `docs/DEPARTMENTS_PLAN.md`. STAGE 1 SHIPPED (see the
  commit table). STAGE 2 (the department model — the owner's "OR is a
  collection of operating rooms" / "xray is a collection of rooms" ask) is
  still DRAFT and needs its OWN pre-implementation review.** Owner asks 2026-07-19: the OR should be "a collection of
  different operating rooms inside of it", X-ray "a collection of rooms where
  there can be more than one xray machine in the entire entity", and — if
  patients aren't really seen there — respiratory therapy should lose its room
  entirely. **Deep research (24 sources, 98 claims, top 25 adversarially
  verified) says the game has ONE capacity axis and reality has THREE:**
  AREA-scaled (dialysis — CBC §1224.36.2 permits one open room, 80 sq ft +
  4-ft clearance per station; the game already has this right), EQUIPMENT-
  scaled (X-ray/CT/MRI/nucMed/OR — capacity is the MACHINE measured as
  per-scanner serial occupancy, so floor area buys nothing and you add a
  walled suite), and STAFF-HOUR-scaled (respiratory therapy — **AARC's
  methodology contains no spatial capacity unit at all**; RTs are mobile
  bedside providers and APEX standards PROHIBIT treating several patients at
  once). Two rows flagged weak, not laundered: the OR clearance-band claim
  passed only 2-1, and the ED per-station evidence was **REFUTED 0-3** (a 2018
  proposal, not adopted code). **The #1 blast-radius item: `save.ts:900`
  validates room type with `asOneOf(o.type, ROOM_TYPES)`, so deleting `resp`
  from `ROOM_DEFS` would make every LIVE save containing one refuse to load —
  the plan recommends RETIRE (keep loadable, drop from the build menu) over
  delete or migrate.** Stage 2's chosen shape deliberately avoids internal
  wall edges: a department is a SET of ordinary Rooms, so every existing wall,
  door, A*, reservation and capacity path is reused and the dispatcher needs
  no change at all (`roomsOfType` already returns them). The design prize is
  §5: suites add machines but NOT technicians, making "do I need a machine or
  a tech?" a real diagnosis (ED_PLAN §7.2's movable bottleneck).
- **STAFF LOUNGE — owner ask (2026-07-19), NOT SCOPED.** *"Add the option to
  create a staff lounge in the Comfort dropdown area. Staff need a place to
  take breaks and lunches."* The room itself is cheap — a `RoomDef` with
  `category: 'comfort'`; the build menu derives categories from
  `CATEGORY_LABELS`, so it appears automatically. **The real work is what a
  break MEANS**, and it needs its own plan + pre-implementation review:
  (1) a staff fatigue/hunger meter — the patient bladder/thirst precedent from
  Amenities Stage 1 (`decay.ts` + the rng-rolled spawn values); (2) a break
  SIDE-TRIP, which should follow `patientNeeds.ts`'s `needBreak` sub-state
  rather than inventing a new stage (stage stays put, the dispatcher skips
  on-break staff, claims derive from live break state — no bookkeeping to
  leak); (3) the balance question: does a staffer on break leave the available
  pool? **That interacts directly with ED B1's nurse capture** (`ED_PLAN` §5b
  item 5) — a ratio nurse who never returns to `idle` also never gets a break,
  which is either a bug to fix or, more interestingly, the pressure that makes
  the lounge matter. Decide that deliberately. (4) Morale/efficiency payoff vs
  pure decoration — a lounge with no mechanical effect is a money sink.
  Save impact: **a new room type is NOT "fine" — it is itself a bump.**
  (Corrected 2026-07-19; the previous wording here was wrong and would have
  misled a future session into shipping a save-breaking change.) `save.ts:917`
  validates room type with `asOneOf(o.type, ROOM_TYPES)`, so a save carrying a
  new type, opened by an older DEPLOYED build, dies on a shape error instead of
  the clean "newer than this game understands" refusal — the exact failure
  class that owed the v8→v9 (roles) and v10→v11 (condition ids) bumps. See the
  policy log at `save.ts:99-135`. A staff meter would be new saved state on top
  of that, but the bump is already owed by the room type alone.
- **Click a patient to read THEIR thoughts: SCOPED, not built (owner ask
  2026-07-18).** Today the inspect card shows a patient's condition, acuity,
  vitals bars, state and billed total plus a mood emoji (🙂/💢/💀) — but their
  actual thoughts go ONLY to the global 💭 Thoughts feed, mixed in with
  everyone else's. The owner wants to click a person and read what THAT person
  is thinking (the RCT "pick up a guest and read their thoughts" moment).
  **The design fork that decides the size of this — settle it before coding:**
  thoughts are EVENTS (`patientThought`), not state. Nothing anywhere stores a
  patient's thought history.
  - *(a) UI-only, cheap:* the thought log already retains a capped 100-entry
    scrollback carrying `patientId`; filter it per patient and render the last
    few on the card. No sim change, no save change, zero risk — but a patient's
    thoughts vanish once pushed out of the shared 100-entry window (a busy
    hospital churns it fast), and they are GONE on reload, so the card is empty
    for every patient after loading a save.
  - *(b) Sim state, honest:* a small ring buffer (3–5 entries) on `Patient`,
    written at the existing `emitThought` choke point. Survives reload, always
    populated, per-patient by construction — but it is new World state, so it
    is a **SAVE_VERSION bump** with the plan-rule-6 checklist, plus a decision
    about whether thought text or just the `ThoughtKey` is saved (keys are
    smaller and re-render through `THOUGHTS`, but the text is hash-picked from
    `patient.id + tick`, so persisting the key alone means re-picking the
    variant on load unless the tick is stored too).
  - Recommendation: **(b)** — (a) looks free but produces a card that is empty
    exactly when a player most wants it (after loading a save, or in the busy
    hospital that generates the most interesting thoughts). Pairs naturally
    with the banked "click a patient to highlight them" work, which the
    jump-target pulse already closed.
- **Per-room running costs: SCOPED, not built (FINANCE_PLAN §7 Q2, owner ask
  "fix them all" 2026-07-18 — explicitly carved out as a milestone).** This is
  the one thing standing between the finances window and a TRUE RCT ledger:
  RCT rides show *profit* because rides have running costs; ours show income
  only, so nothing in the game answers "is this room worth having". Adding
  them is a BALANCE change, not a display change — every room becomes a
  continuous drain, the M4-tuned economy shifts under it, and the harness's
  black-envelope assertion needs re-tuning. Shape when it lands: a
  `runningCostPerHour` (or per-tile derivation, so a bigger room costs more —
  the Stage-0 pricing precedent) in `ROOM_DEFS`/`balance.ts`; an hourly accrual
  in `updateEconomy` beside payroll, tallied through `tallyCash` into a NEW
  `FINANCE_CATEGORIES` expense row (the partition-guard test will demand it be
  classified — that is the table working as designed); a `Profit` line on the
  inspect card (§4.1) and a running-cost column in Departments, at which point
  the departmental block becomes real P&L; and a balance pass with the harness
  before it ships. No save bump needed for the cost table itself, but the new
  cash category means a `DayTally` key ⇒ SAVE_VERSION bump. Give it its own
  plan + pre-implementation review, like every prior epic.
- **Then, quick passes:** (1) capacity/contention hints
  ("expand your ER or build another" — the panel's `roomChanged`
  invalidation is pre-wired). Banked NITs (fix opportunistically): the
  trap-BFS doesn't re-check existing ATRIUM footprints; room/expand ghost
  validity keys omit cash while paused; patients stand in messes (V1
  collision, accepted); wage-accrual float dust (HUD rounds it); Stage-3
  live-drive: sparks decal reads subtle at default zoom (grey floor
  carries it), restroom "In use" line lists "(on the way)" walkers under
  an "In use" header, and REJECTED build/expand/sell modes stay armed
  after the reason toast (pre-existing; Esc is the exit).
- **Owner asks 2026-07-18 (answered + scoped, pending owner priorities):**
  (a) *Do patients bring family?* Not yet — GDD §11 item 15 (family &
  visitors) is designed at sketch level only; needs a milestone (non-patient
  walkers, seating pressure, leave-together logic). (b) *Wheelchair
  patients?* Not designed — would be a patient mobility variant (spawn mix
  flag, slower speed, sprite variant, maybe wheelchair-accessible standing
  spots); worth a small design doc before code; pairs naturally with
  (c) *patients sitting during exams* — a render/animation pass (seated
  pose on bed/chair while a reservation is active; the §2.6 art contract
  supports new poses as texture variants, no atlas break). (d) **AUDIO**
  (owner ask 2026-07-18): "overhead pages, critical patient arriving
  alerts, stroke alerts in rooms, missing patients, just the business of a
  hospital setting." The game has NO audio subsystem today, so this is a
  MILESTONE, not a sprinkle: a WebAudio layer driven by the EXISTING
  EventBus (the events are already there — patientSpawned by acuity/
  condition for arrival + stroke alerts, patientLost for "missing patient"
  pages, roomBroken, patientDied, dayEnded chimes), an ambient bed
  (murmur/PA-crackle overhead pages — procedural or licensed samples is a
  design choice), volume/mute settings persisted outside saves, and the
  browser autoplay-gesture rule (audio can only start after a click —
  title screen is the natural gate). Sim stays silent by design (audio is
  a render-side EventBus consumer — determinism untouched). Needs its own
  design pass (cue list, mixing, annoyance budget) before code. None
  started — awaiting owner priority call vs the quick passes above.
- **Input supported today = mouse + trackpad ONLY** (clarified 2026-07-17: an owner touchscreen report turned out to be finger-on-display, which the game doesn't handle — the fix above is wheel-based, i.e. mouse/trackpad). **Touchscreen / touch input is DEFERRED** — GDD §11 item 17: touch gestures emit *touch* pointer events the canvas ignores; adding one-finger pan/tap + two-finger pinch (via Pointer Events, coexisting with tap-select/drag-build) is a self-contained future pass that makes the game tablet-playable. Owner chose to build it later.
- **View rotation: SCOPED, not built** — GDD §11 item 16 + `TECH_PLAN.md` §2.7. It's a rendering-architecture milestone (orientation-aware `iso.ts` projection+picking, `depthKey`, wall far/near, and character facings), NOT input polish — give it its own milestone + pre-implementation review. Do not conflate with the camera-input pass above.
- **Optional art polish (art-review recommendations, not defects):** three green-family role colors cluster — nurse (teal), respiratory therapist (green), surgeon (dark green); RT vs surgeon differ only by the surgeon's mask. Reads fine in-world (cap/mask disambiguate) but nudging `ROLE_DEFS` colors apart in `roles.ts` would help at a glance. Also consider making staff role colors more hue-spread generally. Deferred pending an owner call + a visual check.
- **Owner-requested design backlog:** GDD §11 items 14 (roaming volunteers) and 15 (family & visitors), plus wall signage in item 8 — all designed at sketch level, none implemented.
- **Balance watch:** the M4 pass tuned arrivals to 1.5/h and the wait-bonus threshold to 240m against the harness's then-6-room reference build (see `balance.ts` comments); the harness build now includes an Expansion-1 wing (12 rooms, capital bankrolled — operating envelope only). Expansion roster numbers are initial values: watch stroke (acuity 1, 20m CT → 120m ER) death rates at low rep, and OR contention (gallstones+appendicitis share it) — via the harness.

### Operational facts

- **Deploy: DONE (2026-07-17).** Live at **https://hospital-sims.vercel.app** — Vercel, `hospital-sims` team, project `hospital-sims`, production branch `master` (= GitHub default; no master/main mismatch). Git integration connected → every push to `master` auto-deploys to production, other branches get preview URLs. Deployed via Vercel CLI (`vercel link` + `vercel deploy --prod`) after the dashboard import produced no build; git auto-deploy verified with a live push. **Public GitHub repo: `lgorby/hospital-sims`** — full tree tracked, including `CLAUDE.md` (initially kept private + scrubbed from pre-publish history via `git filter-branch`, then re-added on owner request so it syncs across machines — nothing private in it; it appears from commit `10d35e5` forward). Full pre-publish history preserved on branch `pre-public-master` (local + pushed to `origin` as an archive — never merge it into `master`; the histories intentionally diverge). `.vercel/` is gitignored (local link config). The build output is a pure static site (`vite build` → `dist/`), portable to any static host — a hosting choice, not a dependency. Redeploy manually if ever needed: `vercel deploy --prod --scope hospital-sims`.
- **CI: live (2026-07-17).** `.github/workflows/ci.yml` runs the full gate (lint + `npm test` + `tsc --noEmit` + `vite build`) on every push to `master` and every PR — closes the gap that Vercel builds on push but does NOT run tests/lint. First run green in 29s. A red check = a regression that can't silently land or deploy.

## Gotchas

- **Headless Chromium RESERVES `::-webkit-scrollbar` space but never PAINTS
  it** (found while verifying the finances scrollbar, 2026-07-18): the
  `/run-hospital-simms` driver's screenshots show a correctly-sized but empty
  band, which reads as a broken fix. Verify scrollbar//overlay-widget styling
  with a HEADED run (`HS_HEADED=1`) before believing a failure. Related CSS
  trap, since it cost a round: declaring `scrollbar-width` SILENTLY disables
  every `::-webkit-scrollbar*` rule in Chromium, and neither property reserves
  layout space under overlay scrollbars — `scrollbar-gutter: stable` is what
  reserves, the ::-webkit rules are what paint, and the two must not be mixed
  with `scrollbar-width`.
- **Windows + PowerShell 5.1.** No `&&`/`||` chaining (use `if ($?) { }`). Use the Write/Edit tools for file content — a `Get-Content`/`Set-Content` round-trip once mangled UTF-8 `§` chars (it happened AGAIN in the Stage-1 session — BOM + `—`→`â€"`; reverted via git checkout). Long commit messages: write to a scratch file and `git commit -F <file>` — multi-line here-strings to `git commit -m` have mis-parsed and leaked message text as pathspecs.
- `as const` balance tables produce literal types — widen explicitly where mutated (`cash: number = BALANCE...`).
- The dev server may already be running in a background task; Vite HMR picks up edits.
- Queue slot tiles clamp at obstacles and stack (documented); reception's door orientation matters for queue room (see `newGame.ts` comment).
- `debugWalkTo` command is test/debug-only; idle clicks select patients.
- Review agents: give them the docs as contract + explicit hunt list + severity format; they've each earned their cost (picking off-by-half-tile, pause deadlock, spawn-rate inflation ×1.8, reservation stalls, the v1 candidate-pool starvation).
- **Proven parallel-milestone workflow** (save/load + Expansion 1, owner-endorsed): orchestrator freezes a contract first (API skeleton / data-table ids / shared exports), then 2–3 parallel implementation agents with DISJOINT file ownership (sim+test / ui+main+index.html / render), each verifying tsc+lint scoped to its own files; then two parallel adversarial reviewers with split lenses (code/contract vs live-drive via `/run-hospital-simms`); fix ALL findings + regression test per major; gates; HANDOFF update; commit. Reviewers run only AFTER implementers finish — they diff the working tree.
