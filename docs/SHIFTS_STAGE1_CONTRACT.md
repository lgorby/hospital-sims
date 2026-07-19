# Staff Shifts — Stage 1 CONTRACT (two-shift coverage)

**Status:** **NOT READY (2026-07-19, both reviews).** Six MAJORs across two
lenses. The epic is harder than this draft assumed in two independent ways —
economic and mechanical — and the reframe needs an owner decision (see the
block below). **No code.**

> ## REVIEW OUTCOME — the two ways this draft is wrong
>
> ### A. ECONOMICALLY INERT (design review, arithmetic verified)
> **2× payroll does not bite.** Reference roster $3,060/day against ~$12,200/day
> profit — **payroll is ~20% of revenue**, and a doctor bills ~$3,750/day-shift
> for a $300 salary. Doubling payroll still leaves ~$9,170/day profit. So "24/7
> costs a punishing 2×" — the owner's premise and the reason I called this a
> whole-economy rebalance — is **false at current tuning.** Likely measured
> outcome: a NON-CHOICE (24/7 strictly better, still hugely profitable).
> - Root cause: the game's economy has **labor at ~20% of revenue**; reality
>   (research §9) is ~55%. Shifts as a cost mechanic cannot bite until that gap
>   closes — which is a real M4 fee/arrival rebalance, not a footnote.
> - I ALSO repeated the observation mistake: pointed the probe at the mature,
>   cash-rich REFERENCE arm (where affordability is trivial) and named SOLVENCY
>   as the deciding metric (passes vacuously). The real decision lives in the
>   EARLY game; the real metrics are **incremental night-shift ROI** and
>   **night-staff utilisation**, on a starter build.
> - Night is ACTIVE harm, not passive: patients spawn regardless of coverage
>   (`spawn.ts:81`), so ~30% of arrivals — over half of it the **18:30–22:00
>   evening rush** — rot at a closed hospital, die/AMA, and spiral reputation.
>   I framed the risk backwards ("day-only too safe").
> - Confirmed RIGHT: the arrival peak sits inside the day window (§9 Q4 holds).
>
> ### B. MECHANICALLY UNDERSPECIFIED (code review, verified against source)
> Taking a staffer off-shift cleanly is far more than "AND `onShift` into the
> dispatch filters":
> 1. **Gathering promotion is not gated.** `promoteGatheredReservations`
>    (`dispatcher.ts:811-834`) promotes a gathering bay to active whenever
>    patient+staff are in the room — never consulting `onShift`. So an off-shift
>    nurse still STARTS AND COMPLETES treatment, and the headline ratio-nurse
>    case works BOTH bays past shift end. My "finish then leave like `firing`"
>    model is FALSE — `firing` actively CANCELS gathering; `onShift` exclusion
>    cancels nothing. This negates the feature.
> 2. **No trigger sends staff home.** `releaseReservation` has no `onShift`
>    branch; there is no `updateStaff` sweep in the tick loop. Off-shift staff go
>    idle and stand there forever. Walk-home is NEW machinery.
> 3. **Off-floor is new STATE, not field-free.** Payroll needs staff in
>    `world.staff` (to charge), but `isTileClaimed` (`world.ts:338`) and the
>    renderer (`renderer.ts:459,836`) also iterate all staff — so off-shift staff
>    still claim tiles and render. Can't `removeStaff` (stops payroll, no re-mint
>    path). Needs a new home/off-floor marker beyond `shift`, with its own save
>    migration + `isTileClaimed`/renderer exclusions. §5's "only `shift`" and
>    §11's "no render work" are both false.
> 4. **Clock starts at MIDNIGHT (night); first staffer auto-assigns `day`** →
>    off-shift for ticks 0–1200. A new game cannot check anyone in for the first
>    6 game-hours, and `edRatio`'s 1200-tick characterization inverts (its lone
>    day nurse is off the whole window). A premise change, not a re-tune.
> 5. `onShift` window constants (360/1110/1080/390) are balance numbers with no
>    `data/balance.ts` home (SSOT). Plus: the toggle must go through the
>    CommandQueue (not `staffUpdated`); `readStaff` needs `saveVersion` threaded.
>
> ### THE REFRAME (needs an owner call — see the session report)
> Stage 1 as drafted is both inert and heavy. The honest options are a scope
> decision, not a fix: (i) lead with the ECONOMY re-tune (make labor ~50% of
> cost) so shifts bite, measured on the early-game arm; (ii) reframe shifts as a
> FATIGUE/quality mechanic first (research: errors rise on 12h, staff PREFER
> them — a real trade-off) rather than a cost mechanic; (iii) a lighter shift
> model that does not send staff off-floor. Do not iterate the contract until the
> framing is chosen.

---

_Original draft below, retained for provenance; superseded by the reframe above._

**Status (superseded):** CONTRACT DRAFT (2026-07-19).
**Parent:** `docs/SHIFTS_PLAN.md` — this is Stage 1 of 3.
**Owner ask (Stage-1 slice):** *"a 12.5 hour shift limit (30 minutes for
lunches)… rotation of staff every 12 hours so there will be some overlap."*
Stage 1 delivers the shift CLOCK, coverage, and the economic rebalance. Lunches
+ the lounge are Stage 2; fatigue/differential/agency are Stage 3.
**Save impact:** **SAVE_VERSION 11 → 12** (a per-staffer `shift` field, §5).

---

## 1. What Stage 1 is, in one sentence

Every staffer belongs to a **day** or **night** shift and is only available
during it; off-shift staff go home; **payroll is charged for the whole roster**,
so covering 24/7 costs ~2× the staff — and a new player who cannot afford that
runs day-only and forgoes night arrivals until revenue grows.

Stage 1 does NOT add lunches, breaks, fatigue, night differential, or a
scheduling UI beyond a per-staffer day/night toggle. Those are later stages.

## 2. The shift model — derived from the clock, no per-staffer counter

Two shifts, each **12.5 game-hours** (owner: 12h + 30-min meal), staggered 12h
apart so each changeover has a **30-min overlap** where both shifts are present:

| shift | on-floor window | overlap windows (both present) |
|---|---|---|
| **day** | 06:00 → 18:30 | 06:00–06:30 and 18:00–18:30 |
| **night** | 18:00 → 06:30 | (the same two windows) |

- **`onShift(staff, clock)` is pure clock arithmetic** on `minuteOfDay`
  (`clock.ts:41-43`) plus the staffer's `shift` enum — no per-staffer tick
  counter, so it is deterministic and free. day = `minuteOfDay ∈ [360, 1110]`;
  night = `minuteOfDay ∈ [1080, 1440) ∪ [0, 390]` (the wrap).
- The 30-min overlap is the owner's "some overlap." **In Stage 1 it is purely a
  staffing window** — both shifts available, smoother handoff of in-flight work.
  It gains a continuity/quality meaning only in Stage 3; Stage 1 adds no
  mechanic to it, deliberately.
- **Why 06:00/18:00 and not midnight:** the day shift should straddle the
  arrival peak so "day-only" is the viable starter posture. §8 measures the
  `timeOfDayMultiplier` curve to confirm the window is aligned; if the peak sits
  elsewhere, the window moves — a data choice, not a code change.

## 3. Availability — enforced INDEPENDENTLY of idle (the load-bearing subtlety)

The ED anti-capture guard means **a ratio nurse never returns to `idle` while
any bay is live** (`dispatcher.ts:186-196`). So a shift boundary gated on
idleness would let her **work indefinitely past her shift.** The boundary is
therefore enforced the way `firing` already is — by exclusion from dispatch, not
by waiting for an idle moment:

- **`onShift(s)` is ANDed into two filters:** `idleStaff` (`dispatcher.ts:118`)
  and the `availableStaff` `eligible` predicate (`dispatcher.ts:174`, beside the
  existing `s.firing` exclusion). This covers all four dispatch consumers —
  triage, treatment, jobs, standing posts.
- **An off-shift staffer holding a live reservation finishes it, then leaves** —
  exactly the `firing` deferred-removal flow (`world.ts:1103-1128`,
  `releaseReservation`'s last-release branch `world.ts:1980-1994`). The
  dispatcher stops EXTENDING her the moment she goes off-shift (she is excluded
  from `availableStaff`), her live bays drain, and on the last release she walks
  home instead of standing idle.
- **`rolePool` (`dispatcher.ts:227-233`) must also exclude off-shift staff** —
  otherwise a fully-off-shift role reads as a pool it is not, and the
  anti-capture guard mis-fires. This is a required companion edit.

**Regression (§7 #3):** a ratio nurse holding a bay at her shift boundary
actually goes off shift after the bay completes — the exact hazard, pinned.

## 4. Off-shift behaviour — walk home, and standing posts vacate

- **Off-shift clinical staff walk home off-map** (to `BALANCE.map.entrance`,
  then despawn from the floor — freeing their tile), reusing `setWalkerTarget` +
  the entrance. They re-appear at their next shift start. (Alternative: stand
  idle off-pool — rejected: a crowd of idle off-shift staff standing in rooms
  reads as broken and blocks tiles.)
- **Standing posts (receptionist, greeter) un-post at the boundary** — the
  `sellRoom` un-post block (`world.ts:1006-1012`) is the precedent: set
  `duty = idle`, clear path/target, then walk home. `postStandingStaff` already
  re-derives posts from `idleStaff` each tick, so an off-shift receptionist is
  simply never re-posted.
- **Consequence, made visible on purpose:** a hospital with no night
  receptionist stalls check-in at night (`processCheckIn` needs a posted,
  arrived receptionist, `dispatcher.ts:349-363`). That IS the 24/7 coverage
  pressure — Stage 1 surfaces it rather than hiding it. §9 Q2 asks whether it
  needs a mitigation or is the intended teach.

## 5. Save — SAVE_VERSION 12

- New field `shift: 'day' | 'night'` on `Staff` (`staff.ts:41-58`). It breaks
  `SavedStaff` compile by design (`save.ts:145-154`), forcing the schema
  addition: `SavedStaff` + `writeStaff` (`:828-844`) + `readStaff` (`:846-863`).
- **Migration for v<12 (the honest hard part):** shifts change how EVERY loaded
  save behaves — there is no default that preserves 24/7 coverage, because 24/7
  coverage is exactly what the feature removes. Recommendation: **assign existing
  staff alternating by id parity** (`saveVersion < 12 ? (id % 2 ? 'night' :
  'day') : asOneOf(o.shift, …)`), so a loaded save gets rough round-the-clock
  coverage rather than empty nights. Documented as a behaviour change on load,
  the outpatient/departments precedent. §9 Q1 puts the alternative (an
  all-`day` default, or a per-save "shifts enabled" opt-in flag) to review.
- Adds NO role and NO condition, so no candidate-mint re-pin — but a new field on
  the construction/hire path may still shift draws; the re-pin is derived
  mechanically from what goes red, never predicted (`INVARIANTS.md:161/278`).

## 6. Shift assignment — auto, with a toggle

- **`shift` auto-assigned at hire**, alternating within role so coverage balances
  (`addStaffMember`/`hireStaff`, `world.ts:1037-1083`): count existing staff of
  that role, assign `day` if even, `night` if odd.
- **A per-staffer day/night toggle in the hire panel** (`hirePanel.ts:69` row)
  and/or the inspect card Duty line (`inspect.ts:263-277`) — the minimum control
  a player needs to rebalance coverage. A full scheduling view is deferred.
- The toggle emits `staffUpdated` (the existing re-render event).

## 7. Payroll — whole roster (6a), and this is the point

**No change to `economy.ts:5-15`** — it already charges every hired staffer
hourly, unconditionally. That is the design: you pay a night nurse whether or not
you also employ a day nurse, so covering 24/7 costs ~2× and covering day-only
costs 1× but forgoes night arrivals. Charging only on-shift staff (6b) was
rejected in the plan — it removes the tension the owner asked for.

**This is the whole-economy rebalance, and its numbers are MEASURED, not
asserted (§8).**

## 8. Balance — the measurement protocol, numbers DEFERRED to the probe

**The observation lesson, applied from the start.** This contract does NOT
assert that the economy survives 2× payroll — it specifies the probe that will
decide it, with the deciding metrics named up front, and **no Stage-1 balance
number ships until the probe has run on both layout arms** (LAYOUT_PLAN §3.4).

**The probe (`test/shiftProbe.test.ts`, to be built with the implementation):**
run the reference and compact builds under three staffing postures —
1. **DAY-ONLY** (1× roster, day shift only): the starter posture. Measures
   arrivals forgone at night and whether it is profitable.
2. **24/7** (2× roster, both shifts): the endgame posture. Measures whether 2×
   payroll is solvent at current arrival/fee tuning.
3. **BASELINE** (today's always-on 1× roster, no shifts): the control.

**Deciding metrics, stated before measuring** (the metric that would falsify
the design, printed up front — the observation mistake was omitting it):
- **profit/day** under each posture — does 24/7 (2× payroll) bankrupt the
  reference build? Does day-only clear a profit?
- **night arrival share forgone** by day-only — how many patients does a
  day-only player actually give up (the `timeOfDayMultiplier` night dip may make
  this small, which would make day-only *too* safe — a different failure).
- **deaths + walkouts during unstaffed night hours** — the cost of running
  day-only, and whether it is a real risk or a free lunch.
- **is "day-only → 24/7" a viable progression**, or a trap (day-only never earns
  enough to afford 24/7) / a non-choice (24/7 is strictly better or strictly
  worse)?

**The companion re-tune question the probe answers:** if 2× payroll bankrupts
the reference build, does Stage 1 also need an arrival/fee re-tune (a real M4
touch), or does the player simply run leaner? **Decide from the measurement, not
here.** The harness's $3,060/day envelope (`harness.test.ts:96`) and its
downstream per-condition floors will move; they are re-tuned WITH the change and
proven green (§9 has this as a gate).

## 9. Open questions a reviewer must settle

1. **The v11→v12 migration default** (§5) — alternating-by-parity (rough
   coverage, behaviour changes on load), all-`day` (nights empty on load), or a
   per-save "shifts enabled" opt-in flag (old saves keep 24/7, but shifts become
   opt-in, which the owner did not ask for). Which is least bad?
2. **Night check-in stall** (§4) — a hospital with no night receptionist cannot
   check patients in at night. Intended coverage teach, or does it need a
   mitigation (e.g. a lower-throughput night self-check-in)?
3. **Shift-assignment control** — is auto + a per-staffer toggle enough for
   Stage 1, or does the coverage decision need a real scheduling view to be
   legible?
4. **Is the day window (06:00–18:30) aligned with the arrival peak?** If the
   peak sits at night, "day-only" is wrong as the starter posture. §8 measures
   it; the reviewer should confirm the assumption before code.
5. **Does off-shift walk-home interact badly with in-flight patients?** A patient
   walking to a room whose staffer just went off-shift — does the reserve-then-
   walk model handle it, or can a patient be stranded at an unstaffed room?
   (The dispatcher stops assigning off-shift staff, so a NEW reservation cannot
   form; but a gathering reservation whose staffer goes off-shift mid-walk needs
   tracing — likely the `firing`/cancel-gathering path, `world.ts:1103-1126`.)
6. **Is the measurement protocol (§8) sufficient**, and are the deciding metrics
   the right ones? This is the contract's most important section — a reviewer
   should attack it as hard as the design.

## 10. Regressions required (one per major claim)

1. **`onShift` correctness** — day/night boundaries and both overlap windows
   evaluate correctly across a full game-day (unit test on the pure function).
2. **Off-shift exclusion** — an off-shift staffer is not returned by
   `availableStaff`/`idleStaff` and takes no new work.
3. **Anti-capture-independent boundary** — a ratio nurse holding a live bay at
   her shift boundary finishes it and goes off shift (does NOT work past it
   because she never idles). THE load-bearing subtlety.
4. **Off-shift walk-home** — an off-shift staffer leaves the floor and re-appears
   at her next shift start; her tile frees.
5. **Standing-post vacate** — an off-shift receptionist un-posts; a hospital with
   day-only reception cannot check in at night (the coverage pressure, pinned).
6. **Gathering interruption** — a patient gathering to a room whose staffer goes
   off-shift mid-walk is re-dispatched or cleanly cancelled, never stranded (§9
   Q5).
7. **v11→v12 back-compat** — a v11 save loads with shifts assigned; use the REAL
   downgrade helper (`save.test.ts:840-860`), not the version-stamp tamper lines.
8. **Payroll unchanged in mechanism** — the whole roster is still charged (a
   determinism/accrual check; the re-pin from the new field is derived, not
   predicted).
9. **Harness re-tuned green** — the roster and its per-condition floors are
   updated for the shift world and pass; this lands WITH the change, not after
   (the regression-of-record rule).

## 11. Files touched (estimate, for the review's blast-radius check)

- `src/sim/entities/staff.ts` — `shift` field + the `onShift` pure function
  (or in `formulas.ts`/`clock.ts` — SSOT: a derived pure function).
- `src/sim/systems/dispatcher.ts` — `onShift` AND into `idleStaff`/`availableStaff`/`rolePool`.
- `src/sim/world.ts` — shift auto-assign at hire; off-shift walk-home transition;
  standing-post vacate.
- `src/sim/save.ts` — `SavedStaff` field, write/read, `SAVE_VERSION 12`, migration.
- `src/ui/hirePanel.ts` + `src/ui/inspect.ts` — the day/night toggle + display.
- `test/` — `shiftProbe.test.ts` (new), the 9 regressions, harness re-tune.

**No render-side work** (staff sprites unchanged; off-shift = absent). **No new
role, no new room, no new condition** (all of that is Stage 2+).
