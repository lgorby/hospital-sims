# SHIFTS Stage-1 — Implementation Plan (the mechanics)

**Status:** **v2 — both split-lens pre-impl reviews folded (2026-07-19).** Mechanical
lens + design lens both returned READY-WITH-FIXES; every MAJOR and MINOR is folded
below (see "### Review outcome"). Parent contract: `docs/SHIFTS_STAGE1_CONTRACT.md`.
This is the *mechanical* build that turns the inert plumbing live, grounded in a fresh
code map (line refs verified against the tree; the contract's refs have drifted — §2).

**Owner decisions already locked** (do not re-litigate): wage factor **0.6×**, clock
**opens 06:00**, migration **= mint a night roster**, SAVE_VERSION **13** (already
bumped). Two forks the reviews surfaced were **owner-decided (2026-07-19):** the player
**chooses the shift at hire** (default day, §D), and the daily report + autosave **fire at
06:00** with the day rollover (§A). One remaining item stays flagged **[OWNER]** in §E (the
mint-night load-notification wording / marginal-arm measurement).

### Review outcome — what changed from v1 (all findings folded)
- **[MECH-MAJOR] `hasActive` must read reservations, not `duty`.** `duty` is a single
  witness that stays pinned to a *gathering* bay while a *second* bay promotes to
  active (`promoteGatheredReservations` never rebinds `duty`), so a `duty`-based check
  would walk a nurse home while her other bay is mid-treatment. Use
  `reservationsOfStaff(m.id)` (`world.ts:449`) and **always cancel gathering
  reservations** (mirror `fireStaff` exactly — it cancels gathers even when an active
  bay remains). Rewritten in §B.
- **[MECH-MAJOR] mint-night migration must live in `loadWorld`, not `restoreInto`.**
  `restoreInto` never receives `saveVersion`; `loadWorld` has `version` in scope
  (`save.ts:1901`) and runs after `restorePrivateState` restores `nextEntityId`.
  Rewritten in §E.
- **[MECH-MAJOR] clock offset must be its OWN constant, not `shifts.day.startMinute`.**
  The mandated probe re-run sweeps the day *window* by mutating `shifts.day.startMinute`;
  if the clock reads that field, the sweep moves tick-0 too and the window arm measures
  the wrong thing. Use `BALANCE.time.dayStartMinute`, pinned equal to the shift start by
  a test. §A.
- **[MECH-MAJOR] the clock re-base DIVERGES the spawn RNG stream.** `updateSpawn` draws
  every tick against an `hourOfDay`-dependent threshold (`spawn.ts:79-81`), so re-basing
  `hourOfDay` re-baselines every spawn-dependent suite (harness, economyProbe). Daily
  *expected totals* stay phase-invariant; exact per-seed streams do not. Build order
  fixed (§4): the re-baseline lands WITH the clock change, not "green after an isolated
  step."
- **[MECH-MAJOR] off-shift `duty.kind==='job'` (EVS/maintenance mid-clean/repair)** is
  not covered by a reservation check → gets yanked mid-job. Treat `job` like an active
  bay (defer walk-home until it releases). §B.
- **[DESIGN-MAJOR] the post-mechanics probe re-run needs a PRE-REGISTERED metric +
  bound**, not "within a tolerable bound" (unfalsifiable — the HANDOFF lesson). §5/§6.
- **[DESIGN-MAJOR] hire-time shift must be VISIBLE + correctable at the hire panel**, and
  the parity heuristic mis-directs the binding-arm 2nd hire to night. **Owner-decided: the
  player CHOOSES the shift at hire** (day/night selector in the hire panel, default day),
  carried on the `hireStaff` command. §D.
- **[DESIGN-MAJOR] mint-night was measured on a HEALTHY save only** and ships silently
  (+~20% payroll, doubled headcount) to marginal live saves. Add a **marginal migration
  arm** to the probe re-run and a **one-time load notification** with the escape hatch.
  §E **[OWNER]**.
- **[MINORs folded]** build.ts occupancy also iterates staff (§C); `setStaffShift` guards
  a missing id (§D); walk-home path-failure + respawn null fallbacks, sequential batch
  respawn placement (§B); autosave ALSO moves to 06:00, add a `dayEnded`-once +
  attribution regression (§A); broaden the night-unstaffed signal to the no-night-
  receptionist stall + connect the exodus to the shift change (§F); restate the
  anti-capture regression (§5 #3); deterministic twin names, id-order iteration (§E);
  `GAME_MINUTES_PER_DAY` not `24*60`, fix the `isDayRollover` call-site list (§A). And
  update the contract's stale "Locked decisions" wage bullet (done — see §2).

---

## 1. What is already wired (inert) vs. what this plan builds

**ALREADY WIRED (inert, do not rebuild):**
- `Staff.shift: ShiftId | null` (default `null`) and `Staff.onFloor: boolean` (default
  `true`, **saved** — closes the M1 walk-home determinism hazard) — `staff.ts:57,65`,
  init `world.ts:1053-1054`.
- `onShift(shift, minuteOfDay)` — `formulas.ts:216-222` (null=always-on; midnight-wrapping
  night window). ANDed into `idleStaff` (`dispatcher.ts:121`), `availableStaff` eligible
  (`:179`), `rolePool` (`:237`). Because off-floor⟺off-shift, off-floor staff are already
  auto-excluded from all three pools, `postStandingStaff`, and `processCheckIn`.
- Wage: `shiftWageMultiplier(shift)` (`formulas.ts:226-228`) applied ONCE in payroll
  (`economy.ts:12-15`); `wageFactor = 0.6` (`balance.ts:80`); pinned by
  `economyStage1.test.ts` "SHIFTS wage mechanism".
- Save schema: `SAVE_VERSION = 13`, `SavedStaff.shift`/`.onFloor`, `writeStaff`,
  `readStaff` (**already receives `saveVersion`**; read-time defaults present).

**THIS PLAN BUILDS:** `updateShifts` reconciliation + tick insertion · walk-home
(trigger + completion → `onFloor=false`) + respawn · off-floor exclusion (`isTileClaimed`,
renderer, `pickAt`, `build.ts`) · gather-cancel at boundary · hire default-day + setup
receptionist day + `setStaffShift` command + hire-panel toggle · clock 06:00 re-base ·
mint-night migration + load notification · night-unstaffed signal · the 9 regressions +
harness re-tune + the pre-registered post-mechanics probe re-run.

---

## 2. Corrections to the contract (verified against the tree)

1. **Wage at hire: assign `shift` ONLY; do NOT pre-scale `salaryPerDay`.** The wage
   factor lives in exactly one place (`economy.ts` multiplies by `shiftWageMultiplier`).
   Pre-scaling at hire AND multiplying in economy is the exact double-count the probe
   review fixed. The `economyStage1.test.ts` SSOT pin guards this. **The contract's
   "Locked decisions" bullet still says "salary = round(base × 0.6) at the hire path" —
   that is now stale and this plan supersedes it** (contract updated with a pointer here).
2. **`readStaff` already threads `saveVersion`** — contract MAJOR B5's "required companion
   edit" is done.
3. **`restoreInto` has no `saveVersion`** — the migration goes in `loadWorld` (§E).
4. **The clock offset is its own constant** `BALANCE.time.dayStartMinute`, NOT
   `shifts.day.startMinute` (§A) — else the probe window sweep is confounded.
5. **Drifted refs** (contract → actual): `promoteGatheredReservations` 810 → **819-886** ·
   `availableStaff` 174 → **179** · `rolePool` 227 → **232-242** · `fireStaff` 1112 →
   **1087-1130** · `releaseReservation` 1996 → **1998-2013** · tick order 2169-70 →
   **insert between 2171 and 2172** · `readStaff` 860 → **881-903** · `SavedStaff` 246 →
   **257-275**. Accurate: `isTileClaimed` 339, `renderer` 459/836, `sellRoom` un-post
   1006-1012, `decay.ts` 35-37, `clock.ts` 41-43. The command lives in `src/commands.ts`.

---

## 3. The design, workstream by workstream

### A. Clock 06:00 re-base (Owner Fork 1 A — ratified)

**Goal:** tick 0 = 06:00 (day-shift open), so a new hospital opens in the morning with
day staff on duty and "day-only" is viable from tick 0.

**Mechanism (one edit).** A dedicated constant `BALANCE.time.dayStartMinute = 360`,
applied once in `GameClock.minuteOfDay`:
```ts
get minuteOfDay(): number {
  return (ticksToGameMinutes(this.tick % TICKS_PER_DAY) + BALANCE.time.dayStartMinute) % GAME_MINUTES_PER_DAY;
}
```
It **must equal** `BALANCE.shifts.day.startMinute` (co-phase-lock) but is a SEPARATE
field — a test pins `BALANCE.time.dayStartMinute === BALANCE.shifts.day.startMinute` so
they can't drift, while the probe's window sweep (which mutates `shifts.day`) leaves the
clock phase fixed and actually measures "shift moves against fixed arrivals."

**Day rollover stays on the RAW tick boundary.** `dayOfTick`/`day` remain `tick %
TICKS_PER_DAY`. **Rename `isMidnight` → `isDayRollover`**; call sites are `world.ts:2183`
(the `closeDay` gate) and `world.ts:2212` (`checkBankruptcy` day attribution — semantics
unchanged since `dayOfTick` is untouched), plus `clock.test.ts` (references by name). The
daily report **and the midnight autosave** are both `dayEnded` subscribers, so **both now
fire at 06:00** (the day-shift open) — a deliberate, acknowledged consequence, thematically
a "morning report." (Decoupling the report to displayed-midnight via a second gate was
considered and rejected for Stage 1: more machinery for a cosmetic beat; 06:00 = start of
the working day is a natural report time.)

**RNG-stream consequence (build order).** `updateSpawn` draws every tick against a
`timeOfDayMultiplier(hourOfDay)` threshold (`spawn.ts:79-81`), so re-basing `hourOfDay`
diverges the exact spawn/condition stream. **Daily expected totals are phase-invariant**
(the curve integrates the same over a raw-tick day, so the shipped economy *magnitudes*
hold), but per-seed outcomes shift — so harness per-condition floors, `economyProbe`, and
any day-ticking suite **re-baseline WITH this change** (RNG re-pins derived mechanically
from what goes red, never predicted — INVARIANTS). Update the stale `spawn.ts:88-97`
draw-order comment ("the clock starts at hour 0…").

**Save:** no new field, no bump. A loaded pre-re-base save shifts +6h in displayed
time-of-day and re-phases its future spawns/shifts — deterministic, folded into the v13
story. Round-trip within one build is exact (offset is a pure function of tick).

**Tests:** `clock.test.ts` (tick 0 → `Day 1, 06:00`; rollover still at `TICKS_PER_DAY`);
`dayStartMinute === shifts.day.startMinute` drift-pin; **`dayEnded` fires exactly once per
`TICKS_PER_DAY` and attributes the day that ended** (the `:2212` `day-1` logic preserved
across the rename); a save→load→run determinism guard under the offset.

### B. `updateShifts` — the per-tick reconciliation (the heart)

New system `updateShifts(world)` in `src/sim/systems/shifts.ts`, inserted in `tick()`
**between `updatePatientNeeds` (2171) and `updateDispatcher` (2172)**. Idempotent, no
stored previous-tick state. Per staffer each tick:
```
onDuty = onShift(m.shift, minuteOfDay)
res    = reservationsOfStaff(m.id)                       // world.ts:449 — the TRUTH, not m.duty
busy   = res.some(r => r.phase === 'active') || m.duty.kind === 'job'   // live bay OR live job
if onDuty:
    if !m.onFloor:  respawn (see below)
else (off duty):
    for r of res: if r.phase === 'gathering' cancelReservation(r, {hint:false})  // ALWAYS, mirror fireStaff 1118-1120
    if m.duty.kind === 'post': un-post (duty=idle, path=[], target=null)          // mirror sellRoom 1006-1012
    if busy: continue                                     // let the live bay/job finish; walk home on release, next tick
    if m.onFloor:
        if walkerArrived(m) && samePoint(m.at, entrance): m.onFloor=false; path=[]; target=null   // home
        else: setWalkerTarget(m, entrance)                // idempotent: findPath re-issues; see fallback
```
- **Gather-cancel is unconditional** for an off-duty staffer (even with an active bay),
  exactly like `fireStaff` — so the ungated `promoteGatheredReservations` (which runs
  *after* `updateShifts`) can never promote an off-shift gather; the patient re-queues via
  `cancelReservation`.
- **`busy` covers both an active reservation AND `duty.kind==='job'`** — an off-shift
  EVS/maintenance worker finishes her clean/repair before walking home (never yanked
  mid-job; `progressJobs` requeue is avoided).
- **Anti-capture boundary:** a ratio nurse holding a live bay at her boundary is off-duty
  + `busy` → deferred; already excluded from NEW work by the gate; her bay drains; on
  release she goes idle; next tick she walks home. She takes no new dispatch after the
  boundary and never abandons a live bay.
- **`updateShifts` is the SOLE owner of walk-home** — `releaseReservation` is unchanged
  (its last-release branch sets `duty=idle`; the sweep catches the now-idle off-shift
  staffer next tick). DRY, zero blast radius there.
- **Walk-home fallback:** if `findPath` to the entrance fails (`setWalkerTarget` leaves
  `target=null`), do NOT re-issue every tick forever — after a failed attempt, blink the
  staffer off-floor (`onFloor=false`) rather than leaving her stuck on-floor claiming a
  tile. (Rare; a walled-in entrance.)
- **Respawn:** place at `nearestFreeStandingTile(entrance) ?? entrance` (explicit fallback
  so `at` is always defined), `onFloor=true`, `duty=idle`, `path=[]`, `target=null`.
  **Batch respawns place sequentially** (each updates occupancy before the next) so a whole
  night crew coming on at 18:00 doesn't stack on one tile. **[OWNER, game-feel]** optionally
  spawn at the entrance and *walk* to a standing tile (mirror walk-home) to avoid a door
  pop-in — a small polish the owner values; specced as a follow-up, not a blocker.

### C. Off-floor exclusion (every all-staff iteration)

Off-floor staff stay in `world.staff` (payroll still charges them) but must vanish from
every iteration that places them in the world:
- **`isTileClaimed`** (`world.ts:339`): `if ('onFloor' in person && !person.onFloor) continue;`
  (compiles + narrows the `Patient | Staff` union — Patient has no `onFloor`).
- **Renderer sprite loop** (`renderer.ts:836-848`): skip `!onFloor`, destroy the sprite
  (reuse the removed-staff destroy path).
- **`pickAt`** (`renderer.ts:459-463`): skip `!onFloor` (not clickable while home).
- **Build/expand occupancy** (`build.ts:76-79`, `world.ts:893-895`): both iterate
  `[...patients, ...staff]` and veto on `person.at`. An off-floor staffer parked at the
  entrance would still veto a build over the entrance tile. **Exclude off-floor here too**
  (cheap, correct — the plan's earlier "only three iterations" claim was wrong).

### D. Hire, setup, and the `setStaffShift` command  **[OWNER-DECIDED: player chooses at hire]**

**Owner call: the player CHOOSES the shift at the moment of hire** (not an auto-heuristic).
So neither parity nor silent default — the hire panel presents an explicit day/night choice.

- **The hire panel carries the choice.** A day/night selector in the hire panel, **default
  selection = day** (the safe starter posture — a player who doesn't engage still gets the
  viable day-only start), whose value rides the `hireStaff` command:
  `{ type:'hireStaff'; candidateId; shift }`. `hireStaff(candidateId, shift)` sets
  `member.shift = shift` after `addStaffMember`. **Salary untouched** (§2.1); economy
  applies 0.6× dynamically. `addStaffMember` keeps `shift=null` so test rosters stay
  always-on.
- **Setup receptionist → day** (`newGame.ts:28`): capture the return, set `.shift='day'`,
  so a new game opens day-staffed at 06:00.
- **`setStaffShift` command** (hard rule 3, for rebalancing an existing staffer):
  `{ type:'setStaffShift'; staffId; shift }` in `commands.ts`, a `case` in `applyCommand`
  (~`world.ts:686`), a private `setStaffShift(staffId, shift)` that **guards a missing id**
  (`const m = this.staff.get(staffId); if (!m) return;`), sets `m.shift`, emits
  `staffUpdated`. The next-tick sweep moves the staffer on/off floor to match.
- **UI:** the hire-panel shift selector (above) AND a day/night toggle on the inspect card
  (rebalance an existing staffer). Each staffer's shift is visible in both. A full
  scheduling view stays deferred.

### E. Save migration — mint a night roster (v<13 load) **[OWNER: load signal]**

In **`loadWorld`** (has `version`), AFTER `restoreInto` returns (so `nextEntityId` is
restored), gated `version < 13`:
```
for each restored staffer, iterated in ID ORDER (sort — do not trust Map order):
    s.shift = 'day'
    mint a night twin with a DETERMINISTIC name derived from s (no world.rng draw),
      same role/skill/salary, shift='night', onFloor=true
```
Reproduces the measured table: N day (0.6×) + N night twins (0.6×) = **1.2× baseline
payroll** ($3,060 → $3,672), coverage + rep preserved. Deterministic twin names keep the
post-load RNG stream un-perturbed; iterating in id order makes the mint deterministic. If
`staffHired` firing at load is a problem for any listener, mint via the entity path that
does not emit (or suppress during load).
- **One-time load notification** (the biggest player-facing change gets legibility): for
  v<13 saves, surface "Shifts added — a night crew was hired so the hospital runs 24/7;
  payroll rose ~20%. Reassign or dismiss staff to run day-only." — turns a silent
  roster-double into a legible decision and names the escape hatch.
- **Test:** a REAL v12→v13 downgrade (`save.test.ts` downgrade-helper precedent): existing
  staff → day, a night twin per staffer, payroll ≈ 1.2×, `onFloor` reconstructed, twins
  deterministic across two loads.

### F. Night-unstaffed signal (render-side)

A HUD/roster line shown when **night arrivals are present AND (no on-floor on-duty
clinical staff OR no posted night receptionist)** — the reception-only stall
(`processCheckIn` needs a posted receptionist) is an equally-dead night the narrow
"clinical only" trigger would miss. Wording should tie the 18:00 exodus to the shift change
so the walk-home reads as end-of-shift, not staff quitting. Pure world read; no sim/save
change.

---

## 4. Build order (each step gate-green before the next)

1. **Clock re-base** (§A) — lands WITH the spawn-stream re-baseline: update `clock.test.ts`
   + the determinism/`dayEnded` guards, and re-pin any spawn-dependent suite (harness,
   `economyProbe`) that goes red, mechanically from the diff. (NOT an isolated "stays
   green" step — MECH-MAJOR 4.)
2. **`updateShifts` + off-floor exclusions + gather-cancel** (§B, §C) — behind still-null
   defaults so the suite stays green until rosters get shifts.
3. **Hire default-day + setup day + `setStaffShift` + hire-panel toggle** (§D).
4. **Mint-night migration + load notification + downgrade test** (§E).
5. **Night-unstaffed signal** (§F).
6. **Regressions + harness re-tune** (§5), then the **pre-registered** post-mechanics
   probe re-run (§5 #6 / §6).

## 5. Regressions the implementation must own

1. **`onShift` correctness** — both boundaries + both 30-min overlaps across a game-day.
2. **Off-shift exclusion** — absent from `availableStaff`/`idleStaff`/`rolePool`, takes no
   new work.
3. **Anti-capture boundary** — a ratio nurse holding a live bay at her boundary **takes NO
   new dispatch after the boundary AND completes her already-active bay, then walks home**
   (assert pool-exclusion at the boundary + eventual walk-home on last release — NOT
   "off-floor at the boundary tick," which contradicts the design). THE subtlety (extend
   `edRatio.test.ts`).
4. **Gathering cancellation** — a patient gathering to an off-shift staffer is
   re-dispatched/cleanly cancelled, never stranded; `promoteGatheredReservations` never
   promotes an off-shift staffer; the gather is cancelled EVEN when the staffer also holds
   an active bay.
5. **Job not abandoned** — an off-shift EVS/maintenance worker mid-job finishes it before
   walking home.
6. **Walk-home + off-floor** — an off-shift idle staffer leaves the floor (`onFloor=false`,
   tile freed, not rendered/clickable/veto-ing builds) and reappears on-shift.
7. **Standing-post vacate + night stall** — an off-shift receptionist un-posts; a day-only
   reception cannot check in at night.
8. **v12→v13 mint-night migration** — real downgrade helper; day + deterministic night
   twins; payroll 1.2×; `onFloor` reconstructed.
9. **Payroll mechanism unchanged** — whole roster charged, wage factor applied ONCE (the
   SSOT pin + a hired-staffer variant).
10. **Harness re-tuned green** — roster + per-condition floors updated for the shift world.
11. **Clock**: tick-0 = 06:00; `dayEnded` once per day + correct attribution;
   `dayStartMinute === shifts.day.startMinute`.
12. **`setStaffShift`** command round-trip (incl. missing-id no-op).

**The post-mechanics probe re-run — PRE-REGISTERED (DESIGN-MAJOR 1):** it exists to close
the carried-open MAJOR (gate-only probe under-counts day-only night harm). Do NOT freeze on
a vague "tolerable bound." Protocol: (a) tag every patient by arrival-shift; (b) metric =
day-only deaths+walkouts of patients who **arrived during the day shift but were stranded
past the 18:30 boundary**, plus the multi-day day-only net trajectory; (c) **measure the
seed spread FIRST** (baseline deaths run 0.0–0.6 at 5 seeds — likely needs more seeds to
clear the noise floor), THEN set a numeric pass/fail bound that the spread can actually
falsify; (d) add the **four migration arms** (the open provenance MINOR) INCLUDING a
**marginal/tight build**, not just the cash-rich REFERENCE, to check mint-night doesn't
sink a marginal live save. Write the bound into the contract before freezing "day-only is
acceptable pressure."

## 6. Risks / open decisions for review

- Clock re-base blast radius (audit done: spawn stream diverges — re-baseline with it;
  economy gate tick-based, safe; report+autosave move to 06:00, acknowledged).
- Mint-night doubles headcount + payroll on load — measure a marginal arm + ship the load
  signal (§E).
- Default-day hire heuristic **[OWNER]** vs the drafted parity — this plan changes it;
  confirm.
- `updateShifts` as sole walk-home owner — verify no off-shift idle path escapes the
  next-tick sweep (job completion inside the dispatcher is covered by the `busy` job-check).
- Respawn placement collisions (sequential placement) + the pop-in polish **[OWNER]**.

## 7. Files touched

`src/sim/clock.ts` (offset + rename) · `src/sim/systems/shifts.ts` (NEW) · `src/sim/world.ts`
(tick insert; `isTileClaimed`; hire default-day; setup day; `setStaffShift` + `applyCommand`
case; `isDayRollover` sites; build/expand occupancy exclusion) · `src/sim/newGame.ts` · 
`src/sim/data/balance.ts` (`time.dayStartMinute`) · `src/commands.ts` · `src/sim/save.ts`
(mint-night in `loadWorld` + load notification) · `src/render/renderer.ts` (off-floor
exclusion; night-unstaffed signal) · `src/ui/hirePanel.ts` + `src/ui/inspect.ts` (shift
display + toggle) · `test/` (the 12 regressions, harness re-tune, probe re-run + migration
arms). **No new role, room, or condition. SAVE_VERSION stays 13.**
