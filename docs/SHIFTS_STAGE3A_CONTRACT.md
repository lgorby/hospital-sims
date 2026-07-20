# SHIFTS Stage 3a — Staff Fatigue & the Lounge Payoff (CONTRACT)

**Status:** **v2 — both split-lens pre-impl reviews folded (2026-07-20).** Design
lens + mechanical lens both returned READY-WITH-FIXES; the mechanical lens verified
the core (bit-identical fatigue term, single hook, deaths raw-skill, null-shift
inertness). Every MAJOR/MINOR/NIT is folded (see "### Review outcome").
Parent: `SHIFTS_PLAN.md` §5. This is **Stage 3a: fatigue + the lounge-rest payoff**
only. Night differential + agency = a separate **Stage 3b** (§7). Stage 2 is
committed local (SAVE_VERSION 14, `2613f6d`).

### Review outcome — what changed from v1 (all findings folded)

- **[DESIGN-MAJOR] the lounge payoff was routed AWAY from the bottleneck** (the
  Stage-2 trap): (a) time-based accrual capped everyone equally regardless of load;
  (b) folding the penalty inside `attentionSkill`'s clamp (`stats.min`) let it be
  swallowed on high-load bays; (c) skip-under-capture means captured nurses never
  lunch. Folded: **accrual is LOAD-WEIGHTED** (owner-ratified — tire faster while
  treating; §3), and the **penalty is a SEPARATE duration MULTIPLIER** on
  `treatmentDurationTicks`, NOT inside the skill clamp (§4). (c) stays a MEASURED
  risk: if the probe shows the lounge still doesn't pay off, the blocker is the
  Stage-2 skip-under-capture debt — reported with data, NOT patched here (owner
  chose against pre-emption).
- **[DESIGN-MAJOR] "no death spike" was an over-claim** — slower treatment → longer
  queues → more waiting-room decay → indirect deaths/walkouts. Reframed as a
  MEASURED expectation (fatigue-ON-no-lounge shows higher walkouts than +lounge);
  only the SUCCESS-probability pin is a true guarantee (§4, §6).
- **[DESIGN-MAJOR] no early-game/solo arm** — the fragile 1-nurse starter (which
  can never lunch under the cap) could death-spiral under an unavoidable afternoon
  slowdown. Added an early-game/solo arm + a realistic-roster arm to the probe,
  spread-first bounds (§6).
- **[DESIGN-MAJOR] legibility** — a ≤40% (often less) duration change with only an
  inspect number is invisible. Added a committed "tired" signal: a Duty-line state +
  the Fatigue inspect line (§4.1).
- **[MECH-MAJOR] the save border REJECTS, not clamps** — every other `save.ts` field
  fails on out-of-range (the untrusted-input invariant); clamping would launder
  corruption. §5.
- **[MECH-MINOR] a DEDICATED per-member fatigue step** — accrual/recovery must NOT
  sit behind `updateStaffBreaks`'s `onBreak` early-`continue` or `tryStartLunch`'s
  `!onFloor` return, or recovery for home staff never runs. §3.
- **[MINORs/NITs]** recovery is SHIFT-gated not roster-gated (24/7 doesn't
  death-spiral on un-recovered fatigue — prose fix, §3); scope = treatment-step
  duration ONLY (triage/check-in/clean/repair unaffected — stated §4); the
  `fatigue` scalar-vs-`BALANCE.shifts.fatigue`-block name collision (§4); `world.ts`
  mint sites (incl. the mint-night twin) init `fatigue: 0` (§9); the off-shift-on-
  floor "frozen" window is intended (§3); 12h-preference bonus deferred to 3b (§7).

**Save impact:** **SAVE_VERSION 14 → 15** — a new saved `Staff.fatigue` field.
Owed only for the field (no new room/role/condition); a v<15 save defaults
`fatigue = 0` (inert). The bump also earns the other direction cleanly.

**Why this milestone:** Stage 2's probe measured the lounge as NOT a throughput
lever — because a brief lunch on a slack hospital changes nothing. Stage 3a is the
loop that makes the lounge matter: **staff tire while working; a lunch rests them,
and a lounge lunch rests them MORE than leaving the building; tired staff work
slower.** So building a lounge now measurably speeds up a busy hospital. It also
resolves the Stage-2 known debt (a never-rested captured/solo staffer) by CAPPING
fatigue — bad but bounded, turning it into hire-slack pressure.

---

## 0. Owner decisions — RATIFIED 2026-07-20

1. **Scope = fatigue + the lounge-rest loop** (Stage 3a). Night differential +
   agency deferred to 3b. Don't build all four levers at once (the observation lesson).
2. **Fatigue slows work — DURATION ONLY.** A tired staffer treats more slowly (a
   skill-for-duration penalty, the ED-B1 `attentionSkill` precedent). The SUCCESS
   roll keeps RAW skill (`treatment.ts:18`), so deaths stay tied to a health/acuity
   story, never to staffing arithmetic. Fatigue is visible as TIME, the currency
   players read.
3. **Fatigue is CAPPED** (`fatigueMax`). A never-rested staffer (a solo-of-a-role
   or a captured ratio nurse — the Stage-2 debt) sits at the cap: slower, but
   bounded. Hire slack so they CAN lunch → fatigue drops → they speed back up. The
   debt becomes the intended "staff up so people can rest" pressure — no
   break-pre-emption machinery (which Stage 2 deferred and 3a keeps deferred).

"Morale" in 3a = the restorative payoff of the lounge (rest quality). A fuller
morale/quit system is a later stage (the owner did NOT pick a quit mechanic).

## 1. The model in five sentences

1. Each real-hired staffer (shift ≠ null) carries a `fatigue` meter that rises
   while she is on-duty and available, and falls while she rests.
2. She rests two ways: a **lunch** (a lounge lunch restores more than an off-floor
   one — the payoff) and going **off-shift** (recovering at home overnight).
3. Fatigue slows her TREATMENT (a duration penalty folded into the same
   skill-for-duration the attention penalty already uses); it never touches the
   success/death roll.
4. Fatigue is capped, so an un-rested staffer is bad-but-bounded — the pressure to
   hire enough slack that everyone can take their lunch.
5. **Inert for null-shift (test) rosters** by construction (fatigue only accrues
   when `shift !== null`), so every existing fixture stays bit-identical.

## 2. State (data)

`Staff` gains:
```ts
fatigue: number; // 0..BALANCE.shifts.fatigue.max, SAVED. Default 0. Inert if shift===null.
```
`BALANCE.shifts` gains a `fatigue` block (INITIAL values; the probe tunes them):
```ts
fatigue: {
  max: 100,                       // the cap (hire-slack bound)
  basePerGameHour: 4,             // accrual while on-duty (present, any duty)
  workPerGameHour: 6,             // + this PER active treatment reservation (load-weighted)
  recoveryPerGameHour: 20,        // recovery while off-shift (home) — faster than accrual
  loungeRest: 45,                 // fatigue removed by an on-site lounge lunch
  offFloorRest: 20,               // …by leaving the building to eat (less — the payoff gap)
  durationFactor: 0.4,            // duration MULTIPLIER at full fatigue = 1 + this (see §4)
  tiredThreshold: 60,             // ≥ this % → the inspect "(tired)" marker (§4.1)
}
```

## 3. Accrual, recovery, rest (mechanics)

A **DEDICATED per-member step `updateFatigue(world, member)`** in
**`updateStaffBreaks`** (SHIFTS Stage 2, `staffBreaks.ts`), called as the FIRST
statement in the per-member loop body — **structurally BEFORE** the existing
`if (onBreak) { advanceBreak; continue }` and `tryStartLunch`'s `!onFloor` return
(mechanical review: else recovery for home staff never runs). It reads the gates
directly, so the early exits don't hide it. No new system, no tick-order change.
Ordering is irrelevant to lunch-commit: a just-committed luncher has
`onBreak !== null` → the accrual gate fails → she doesn't accrue.

For each `shift !== null` staffer (null-shift is inert — no accrue, no touch):
- **Accrue** while `onShift && onFloor && onBreak === null` (on the clock, present,
  not on lunch — accrues in EVERY duty state, incl. `reserved`/`post`/`job`; you
  tire while working, not only while idle). **LOAD-WEIGHTED** (owner-ratified): rate
  `= basePerGameHour + workPerGameHour × activeTreatmentLoad`, where
  `activeTreatmentLoad = reservationsOfStaff(id).filter(r => r.phase==='active' &&
  r.kind==='treatment').length`. So an idle staffer tires slowly (base), a nurse
  running 2 bays tires fast — fatigue tracks the load the lounge relieves.
  `fatigue = min(max, fatigue + rate·dt)`.
- **Recover** while `!onShift && !onFloor` (truly off-shift, gone home):
  `fatigue = max(0, fatigue - recoveryPerGameHour·dt)`. **SHIFT-gated, so it is
  GUARANTEED** — every staffer has exactly one shift and is off it ~11.5h/day, so
  she recovers nightly even in a 1-deep 24/7 hospital (mechanical review corrected
  v1's wrong "needs rotation" rationale: recovery is NOT roster-gated; only the
  LUNCH/cap is headcount-gated). Gated on `!onShift` so it never double-counts with
  an off-floor LUNCH (on-shift + off-floor, handled below).
- **The off-shift-on-floor window FREEZES fatigue** (draining a live bay past her
  boundary, or walking home: `!onShift && onFloor` → neither accrue nor recover).
  Intended, bounded, deterministic (mechanical review NIT — ratified).
- **Lunch rest** at completion (`advanceBreak` `using`→end): lounge
  `fatigue -= loungeRest`, off-floor `-= offFloorRest` (floored at 0). The gap IS
  the payoff. An aborted lunch rests nothing (consistent with §3.5).

`dt` conversions use the existing `meterDecayPerTick`/game-hour idiom
(`formulas.ts`). `fatigue` is a saved float accumulator (JSON round-trips floats
exactly — byte-identity holds).

Determinism: accrual/recovery/rest are pure arithmetic, no rng. Null-shift staff
never accrue (the `shift !== null` gate), so their `fatigue` stays 0 and every
null-shift fixture is bit-identical. Fatigue DOES change treatment durations for
SHIFTED rosters, which re-phases downstream rng — so shift-using suites re-baseline
WITH this change (the harness uses null-shift `STANDARD_STAFF`, so it is untouched;
`shiftProbe` is gated).

## 4. Effect — a duration MULTIPLIER, outside the skill clamp (the one hook)

The treatment-step duration is computed in **`promoteGatheredReservations`**
(`dispatcher.ts`) as `treatmentDurationTicks(step.dur, meanAttentionSkill, quality)`.
The fatigue penalty is applied as a **separate MULTIPLIER on that duration** — NOT
folded into `attentionSkill` (design review: inside the `stats.min` clamp it gets
swallowed on high-load bays, exactly where throughput is measured). `attentionSkill`
stays `(skill, load)`, unchanged. Add an optional multiplier param to
`treatmentDurationTicks` (default 1 → every existing caller and null-shift staffer
bit-identical), and a pure derivation in `formulas.ts`:
```ts
// f = BALANCE.shifts.fatigue (name the block `f`, the value `fatigue` — no collision)
fatigueDurationMultiplier(fatigue) = 1 + f.durationFactor * (fatigue / f.max)  // 1.0 at 0
treatmentDurationTicks(baseGameMin, avgSkill, quality, fatigueMult = 1) =
  max(1, round(gameMinutesToTicks(baseGameMin) * skillMod * qualityMod * fatigueMult))
```
The dispatcher passes `fatigueDurationMultiplier(meanFatigue(members))`. At full
fatigue (`durationFactor 0.4`) a treatment runs **1.4× longer** — visible slowness,
independent of the load penalty, never swallowed by the clamp.

**Scope: treatment-STEP duration ONLY** (mechanical review). Triage duration
(flat), check-in (flat), and facility jobs (raw `worker.skill`) are deliberately
UNAFFECTED in 3a — a tired triage nurse / receptionist / janitor still works at full
speed. Stated so the probe doesn't chase the wrong knob if triage is the choke.

**The SUCCESS roll (`treatment.ts:18`, raw skill) is UNTOUCHED** — deaths stay
health/acuity-tied (owner decision 2). Fatigue changes only how LONG a bay is held.
The one true guarantee is the success-probability pin; aggregate deaths are NOT
guaranteed unchanged (slower bays → longer queues → indirect waiting-room decay —
a real, measured cost of not resting staff, §6), so that is measured, not asserted.

### 4.1 Legibility (committed, render-only)

A ≤40% duration change is invisible without a signal (design review). SHIPPED:
- **Staff inspect card:** a **Fatigue line** (`Fatigue 72%`) AND a **Duty-line
  "(tired)" marker** once `fatigue ≥ fatigueTiredThreshold` (a BALANCE %, e.g. 60),
  mirroring the Stage-2 "On lunch" state. So a player can SEE which staff are worn
  down and correlate it with building a lounge.
- (A daily-report "treatment time lost to fatigue" line is a cheap 3b add — noted,
  not built in 3a.)

## 5. Save & compat (SAVE_VERSION 15)

- `Staff.fatigue` appended to `SavedStaff` (after `lunchedThisShift`), `writeStaff`/
  `readStaff` threaded; read-time default `saveVersion < 15 ? 0 : asNumber(...)`.
- **Border**: `fatigue` finite and within `[0, fatigue.max]` — **REJECT** on
  violation (`fail(...)`, the untrusted-input house convention, mirroring
  `onBreak.ticksRemaining` — NOT a clamp, which would launder corruption; mechanical
  review MAJOR).
- Migration v<15: `fatigue = 0` — a loaded save plays identically until staff start
  a shift and tire (bounded, intended).
- Regenerate the byte-identity fixture for v15 (added field changes the payload).
- No new role/room/condition. The field is the whole bump.

## 6. Balance — MEASURE it (extend the staff-break probe)

Extend `test/staffBreakProbe.test.ts` (`STAFF_BREAK_PROBE=1`): the Stage-2 probe
runs OFF / NO-LOUNGE / LOUNGE arms on a busy 24/7 build. With fatigue live:
- **Deciding metric = throughput + walkouts** (NOT deaths — thrice-burned,
  5-seed-unfalsifiable). **Measure the discharges/day AND walkouts/day 5-seed spread
  FIRST** (fatigue OFF vs ON-no-lounge, binding arm), then pre-register a bound
  strictly above it: "LOUNGE recovers ≥ N discharges/day (or −M walkouts/day) on the
  busy arm, both layout arms, else the lever is un-measurable — re-tune the rest gap
  / `durationFactor` or declare skip-under-capture the real blocker (a Stage-2-debt
  decision, reported with data, not patched here)."
- **Instrument the MECHANISM**: report mean effective treatment duration
  rested-vs-fatigued on the binding rooms, so a null result is diagnosable (effect
  too small vs noise vs bottleneck-elsewhere), not just a shrug.
- **Add an EARLY-GAME / SOLO arm** (design review MAJOR): 1 nurse + 1 doctor + the
  receptionist, starter rooms, low rep (reuse the `economyProbe` early-game fixture).
  A solo-of-a-role never lunches → tires to the cap every afternoon. Pre-register
  that rep/walkouts/deaths with fatigue ON stay within a stated bound of OFF — else
  soften the penalty/accrual for low headcount (the fragile 1-nurse starter must not
  be tipped into a death-spiral by an unavoidable slowdown).
- **Add a REALISTIC-ROSTER arm** (not only ≥2-per-role-forced): confirm the lounge
  payoff is reachable at rosters the Stage-1 2× economy actually supports, not just a
  lab-forced one.
- **The cap holds**: max observed `fatigue` ≤ `fatigue.max`; a never-rested staffer
  plateaus, not runaway.
- **Recovery works**: a day worker's fatigue falls overnight (multi-day trace),
  even 1-deep.
- **Death expectation (measured, not guaranteed)**: fatigue-ON-no-lounge shows
  HIGHER walkouts/queue than +lounge on the busy arm (the indirect cost); deaths
  stay OFF the pass/fail threshold.
- Both layout arms (`LAYOUT_PLAN` §3.4). No number ships until the probe runs.

## 7. Deferred to Stage 3b (do not build now)

- **Night differential** (+10–15% pay for the night shift) — an economy lever.
- **Agency / overtime** (a ~2× emergency gap-filler) — a late-game hiring lever.
- **A morale/quit system** (chronically exhausted/underpaid staff leave) — a new
  failure mode; its own milestone. 3a's "morale" is the lounge-rest payoff only.
- **12h-shift-preference morale bonus** (the research trade-off) — a balance nicety;
  can layer on later without new state.

## 8. Tests / regressions

1. **Accrual**: an on-duty shifted staffer's fatigue rises over on-shift ticks.
2. **Cap**: fatigue never exceeds `fatigue.max`, however long she works un-rested.
3. **Recovery**: an off-shift (home) staffer's fatigue falls toward 0.
4. **Lunch rest**: a completed lunch drops fatigue; a LOUNGE lunch drops it MORE
   than an off-floor lunch (the payoff gap, pinned).
5. **Duration effect (non-vacuous)**: a fatigued staffer's `attentionSkill`/duration
   is worse than a rested one's; reverting the fatigue term restores equality.
6. **Death roll untouched**: `successChance` inputs are independent of fatigue
   (raw skill), pinned.
7. **Null-shift inert**: a null-shift staffer never accrues fatigue (stays 0), so
   fixtures/harness are bit-identical.
8. **Save v14→v15**: real downgrade helper; `fatigue` defaults 0; border clamps
   out-of-range; round-trip.

## 9. Files (anticipated)

`src/sim/entities/staff.ts` (`fatigue`) · `src/sim/data/balance.ts`
(`shifts.fatigue`) · `src/sim/world.ts` (both `Staff` mint sites — `addStaffMember`
AND the `migrateMintNightRoster` twin — init `fatigue: 0`) ·
`src/sim/systems/staffBreaks.ts` (`updateFatigue` per-member step + lunch-rest in
`advanceBreak`) · `src/sim/formulas.ts` (`fatigueDurationMultiplier`,
`treatmentDurationTicks` optional mult) · `src/sim/systems/dispatcher.ts` (pass the
mean fatigue multiplier at the treatment-duration site) · `src/sim/save.ts`
(SAVE_VERSION 15, `SavedStaff`, border REJECT, round-trip, fixture regen) ·
`src/ui/inspect.ts` (Fatigue line + "(tired)" Duty marker) · `test/staffBreaks.test.ts`
(+ the probe extension). The v<15 read default + these `: 0` inits together keep an
old/migrated roster inert.

## 10. Open questions for the pre-impl reviews

1. Accrue on `onShift && onFloor && !onBreak`, or also while walking to/from a
   post (idle-but-present)? Recommend the former (available-and-present).
2. Should `loungeRest` scale by the lounge's room QUALITY (bigger/nicer lounge rests
   more — a quality lever and a reason to expand it)? Recommend a flat rest for 3a,
   note quality-scaling as a cheap 3b add.
3. Recovery gated on `!onShift && !onFloor` — does any state (mid-walk-home, on-shift
   but idle-off-floor) fall through a gap and neither accrue nor recover? Enumerate.
4. Does the duration change perturb any NON-gated shift-using suite (beyond the
   gated probe)? Derive the re-pin set mechanically from what goes red.
