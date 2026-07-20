# Staff Shifts — Stage 1 CONTRACT (two-shift coverage)

**Status:** **v2 REVIEWED (both split lenses, 2026-07-19) — MEASUREMENT-FIRST.**
The ECONOMIC objection is CLEARED (ECONOMY Stage-1 shipped; 2× payroll → ~6%
margin). The mechanical review returned READY-WITH-FIXES (save `onFloor`, per-tick
reconciliation, don't-gate-promote); the design review returned NOT-READY as
drafted because the contract pre-committed to the two levers the arithmetic says
break the starter (whole-roster payroll, morning window). **Resolution: a shift
probe measures the binding early-game arm BEFORE the numbers are written — the
same arc the economy epic took.** Full folded requirements in the "v2 REVIEW
OUTCOME → v3 REQUIREMENTS" block under "## v2 — MECHANICAL RESOLUTION". **The shift
probe HAS run (see "## MEASURED" below): the derived model is a PER-SHIFT WAGE
(~0.6×), which makes day-only survivable and 24/7 profitable with positive night
ROI — whole-roster payroll bankrupts the starter. Next: owner picks the wage
factor, measure the v12→v13 migration, review the probe, THEN implement.**

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

## v2 — MECHANICAL RESOLUTION (2026-07-19)

The reframe's **economic** objection is closed (ECONOMY Stage-1 shipped; 2× payroll
now drops the mature margin ~32%→~6%, measured). What remains is the **mechanical**
rewrite. This section resolves each of the first review's six MAJORs with a
concrete design grounded in the current code (line refs verified 2026-07-19), and
flags the two decisions that are genuinely the owner's.

### v2 REVIEW OUTCOME — both split-lens pre-impl reviews in (2026-07-19)

**Mechanical: READY-WITH-FIXES. Design: NOT-READY as drafted → measurement-first.**
The mechanical spine holds against the code; the balance framing repeats the
"assert the flattering arm" trap and must become a PROBE, exactly as the economy
epic did. Fold ALL of the below before implementing; **the numbers do not get
written until a shift probe runs.**

**MECHANICAL fixes (verified against source):**
1. **M1 — SAVE `onFloor` (one boolean); the "derived, not saved" claim is FALSE.**
   It violates the save→load→run determinism INVARIANT (`INVARIANTS.md:49-50`): a
   staffer WALKING home at save time is `onFloor=true` (claims tiles via
   `isTileClaimed`, `world.ts:339`) but derives to off-floor on load, so OTHER
   walkers' standing-spot/queue selection diverges → divergent event log. `firing`
   is save-safe only because it uses instant `removeStaff`; shifts cannot. So
   `SavedStaff` gains BOTH `shift` and `onFloor` (the payload already carries
   `at/path/target`, so restore is exact). (Alt: drop the walk — blink off-floor
   instantly — then it IS derivable; loses the polish.)
2. **M2 — make `updateShifts` a PER-TICK RECONCILIATION, not a boundary-only
   sweep.** The boundary sweep misses a staffer who goes idle AFTER the boundary
   via JOB completion (cleaning finishes in the dispatcher, not `releaseReservation`)
   — she loiters on-floor till her next shift. Per-tick reconciliation (every tick:
   off-shift + on-floor + idle + no `active` reservation → start walk home;
   on-shift + off-floor → respawn) is idempotent, closes the job gap, and avoids
   storing previous-tick `onShift` (itself an unsaved-state hazard).
3. **M3 — do NOT gate `promoteGatheredReservations` on `onShift`** (it can deadlock
   a bay: promote refuses, gather lingers to the 60-min timeout). Rely on dispatch
   exclusion (no new off-shift gathers) + cancel-at-reconciliation. Run
   `updateShifts` AFTER `updatePatientNeeds`, BEFORE `updateDispatcher`
   (`world.ts:2169-2170`).
4. **rolePool MUST exclude off-shift** (`dispatcher.ts:227-233`) or `rolePool > 1`
   counts an off-shift body, the anti-capture guard misfires and empties a night
   bay. Pin it in regression #3. The derivation/sweep key on **`active`**, not
   the ambiguous "live". Anti-capture, off-shift+firing, gathering-cancel-requeue,
   night-check-in-stall, respawn-overlap all CONFIRMED-OK.

**DESIGN reframe — measure, do not assert (the binding arm is the early game):**
5. **Payroll model is a PROBE OUTPUT, not a pre-commitment.** Whole-roster (6a)
   nails a day-only nurse to a full 24h wage for 12.5h — the specific thing that
   sinks the starter (real-number estimate: day-only starter ≈ **−$19/day** before
   the rep spiral). Measure 6a AGAINST a **per-shift wage (~0.6× day)**: day-only
   1×0.6 is genuinely cheaper than today, while 24/7 2×0.6 is STILL exactly 2×
   day-only — the owner's tension preserved WITHOUT nailing day-only to today's
   cost. Adopt whichever leaves day-only positive.
6. **The day WINDOW phase is a probe arm.** 06:00–18:30 strands the entire
   18:30–22:00 evening rush (1.0 — the game's 2nd-highest band) for the sleepy
   morning. Sweep 06:00–18:30 vs ~08:00–20:30 vs ~09:30–22:00; let VIABILITY, not
   the 7a–7p realism convention, pick the phase (make it a conscious measured
   trade if realism wins).
7. **Expand the probe metrics.** Add: (a) deaths+walkouts of patients who ARRIVED
   on-shift but were STRANDED at the 18:30 boundary (afternoon-peak 1.5 patients
   abandoned overnight — invisible to an "arrivals-forgone" metric); (b) a
   MULTI-DAY reputation trajectory for day-only (does it spiral or find a grim
   floor?); (c) a LOW-REP shock arm (level ≠ survivability — the economy lesson);
   (d) **incremental night-shift ROI as a hard number** (night marginal revenue −
   night marginal payroll) — if negative, "24/7 later" is a FICTION and 24/7's
   value must come from a named non-cash source, or Stage 3.
8. **Pre-register falsification:** day-only starter net > 0 across seeds AND
   night-shift marginal ROI > 0 (or a named reason 24/7 is worth it). If either
   fails, the feature ships with a mitigating lever, not as drawn.
9. **Reconsider the v12→v13 migration (MINOR).** Alternating-by-parity HALVES a
   healthy live save's coverage on load (3 always-on nurses → 2-day/1-night ≈ 1.5
   effective, same payroll), stacked on the economy re-baseline — a comfortable
   save can spiral on open. v11 is DEPLOYED. The **opt-in flag** (old saves keep
   24/7) deserves real weight, OR migrate by MINTING a night roster rather than
   splitting the day one. Measure what parity does to a healthy save first.
10. **Add a legible night-unstaffed SIGNAL** (render-side): a HUD/roster state
    "No staff on night shift — night arrivals are not being seen", so a dead night
    hospital reads as a DECISION, not a bug. Cheap, and it converts the pressure
    into a teach.
11. **Consideration (scope):** Stage-1 coverage-without-fatigue is a fiat wall;
    fatigue (Stage 3) is what NATURALIZES it. Stage 1 alone can measure "24/7 is
    never worth it" — that verdict must NOT kill the feature; consider pulling a
    small reputation/quality VALUE for night coverage earlier so 24/7 has a reason
    to exist within Stage 1. Owner call on staging.

**Owner Fork 1 (clock start) note:** option A (open at 06:00) is the right UX call
but is NOT a footnote — it adds a `startMinuteOfDay` offset to `minuteOfDay` and
must re-base `dayOfTick`/`display`/the `?seed` boot determinism together (the 24h
`closeDay` rollover can stay on the raw tick boundary — phase-invariant). And its
justification is "arrivals and shifts are CO-PHASE-LOCKED" (both clock-driven), not
merely "daily totals invariant" — it fixes the empty-floor open, NOT viability.

**NEXT STEP: build `test/shiftProbe.test.ts`** (the economyProbe pattern) with the
arms above — payroll-model × window-phase × posture (day-only/24-7/baseline) on the
early-game + reference arms — derive the payroll model and window from the binding
arm, THEN write the Stage-1 balance numbers and the mechanical implementation.
Everything below (and the original draft) is superseded by these requirements.

---

## MEASURED — the shift probe ran (2026-07-19)

`test/shiftProbe.test.ts` (gated `SHIFT_PROBE=1`), 5 seeds, against the SHIPPED
economy. The sim's `onShift` availability gate is live but INERT until a shift is
assigned (`shift` defaults null); the probe assigns shifts + sweeps `BALANCE.shifts`.
**Caveat:** the probe runs the availability gate only — off-shift staff take no NEW
work but do NOT yet walk home, and a gather formed before the boundary still
completes — so it OVER-counts off-shift coverage. A day-only net that is already
negative here is conservatively negative; a marginal-positive is an optimistic bound.

**Early-game (binding) arm, default 06:00–18:30 window, profit/day:**
| posture | whole-roster (6a) | per-shift (0.6×) |
|---|---|---|
| BASELINE (always-on 1×) | **+$253** | — |
| DAY-ONLY | **−$142** ❌ (every seed neg) | **+$70** ⚠ (2/5 seeds neg) |
| 24/7 | +$159 | **+$583** ✅ |
| **night ROI** (24/7 − day-only) | +$301 | +$513 |

**Mature (REFERENCE) arm, 6a:** baseline +$4,842 · day-only +$73 (rep drops to ~39)
· 24/7 +$1,672 (rep climbs to 613) · **night ROI +$1,598**.

### The four derived findings
1. **PAYROLL MODEL = per-shift wage (~0.6× day), NOT whole-roster (6a).** DECISIVE:
   6a nails a day-only nurse to a full 24h wage for 12.5h and **bankrupts the
   day-only starter (−$142/day, every seed)** and leaves even the mature day-only
   at a razor +$73. A per-shift wage rescues day-only (+$70) AND keeps 24/7 = 2×
   day-only (the owner's tension) — a shifted staffer's `salaryPerDay` becomes
   `round(base × shiftWageFactor)`.
2. **NIGHT ROI IS POSITIVE on both arms** (+$301–609 early, +$1,598 mature) — so
   **"24/7 later" is a REAL progression, not a trap.** Night coverage pays.
3. **DAY-ONLY is a marginal, rep-crashed floor** — even rescued to +$70 it is the
   lean/risky starter posture (the player is pulled toward 24/7, which pays). The
   falsification bound (day-only net > 0 across ALL seeds) is NOT fully met (2/5
   seeds slightly negative under the optimistic gate-only probe), so day-only is
   "survivable-but-tight", not "comfortable" — acceptable as the intended pressure,
   NOT as a safe default.
4. **WINDOW phase:** the later 09:30–22:00 window helps 24/7 and total revenue
   (evening-rush capture) but barely moves the throughput-capped day-only starter.
   Not load-bearing for viability — keep the realistic 06:00–18:30 default (or a
   modest later shift), a mid-game lever more than a starter one.

### THE REMAINING OWNER DIAL — the per-shift wage FACTOR
The factor trades day-only viability against how much 24/7 costs vs TODAY:
- **0.6×** (measured): day-only +$70 (viable), 24/7 = 1.2× today's payroll.
- **1.0×** (= 6a): day-only −$142 (bankrupt), 24/7 = 2× today's payroll (the owner's
  "punishing 2×" reading, but it kills the starter).
- ~0.7–0.8× sits between. **Recommend ~0.6**; a higher factor makes 24/7 bite harder
  at the cost of day-only viability. Owner call, informed by the curve above.

### A NEW finding (not a shifts blocker, but flagged)
The probe tracked REPUTATION (no prior probe did): **the 1-nurse starter crashes
its rep to 0 within ~3 days even at BASELINE** — it turns away ~11 patients/day, and
AMA walkouts (−8 rep each) tank it, after which it survives at a grim low-rep floor.
This is a PRE-EXISTING early-game fragility (the understaffed starter), independent
of shifts — an onboarding/tuning question for a later pass, not this contract.

### PROBE REVIEW (adversarial) — folded, and the migration measured
The probe was adversarially reviewed. **Verdict: the MODEL is sound to implement;
the day-only SAFETY framing is on probation until re-measured post-implementation.**
- **Per-shift wage (0.6×) vs 6a: CONFIRMED mechanically exact** (the −$142→+$70 gap
  is precisely the $212 payroll delta; revenue/discharges byte-identical; rep-
  independent). ADOPT. Night-ROI **sign** robust; magnitude is an unpaired 5-seed
  estimate (24/7 adds staff → different rng stream) — cite as approximate.
- **The 0.73 crossover:** day-only net ≈ `388 − 530·f`, so day-only is positive for
  any wage factor **< ~0.73**. 0.6 is a comfortable point below the cliff (day-only
  ≈ +$70; 0.52 → +$112; 0.65 → +$44). Owner picked **0.6**.
- **Day-only is measured at the REPUTATION FLOOR** (0.5× arrivals; the 1-nurse
  starter crashes rep by day 2–3) — `+$70` is "survives at the grim floor," NOT a
  healthy start. Do not present day-only as a safe default.
- **MAJOR — the stranded-at-boundary harm is UNDER-counted.** `nightDeaths`/`nightAMA`
  are deaths during night clock-hours (an arrivals-forgone proxy), and the gate-only
  probe omits gather-cancel + walk-home, so real day-only night deaths are HIGHER.
  **The §7a falsification metric is not yet met — RE-RUN the probe AFTER the
  mechanics exist, tagging patients by arrival-shift, and confirm day-only night
  harm is within a tolerable bound before freezing "day-only is acceptable
  pressure."** (The payroll-model + night-ROI conclusions survive the re-measure —
  they are cash/rep-independent.)
- Mature day-only "+$73" rests on one seed (median −$30, 3/5 negative) — directional
  only, not "mature day-only pays".

### Migration MEASURED (the deferred fork) → mint a night roster
On a HEALTHY mature save (REFERENCE, 5 days), when shifts turn on:
| migration | profit/d | payroll | end rep |
|---|---|---|---|
| none (unchanged) | +$4,532 | $3,060 | 523 |
| parity (split, full wage) | +$1,559 | $3,060 | 280 (coverage halved) |
| day-only + 0.6× | +$1,194 | $1,836 | **39 (rep crash)** |
| **mint night roster (0.6×)** | **+$4,166** | $3,672 | **493 (kept healthy)** |
**MINT A NIGHT ROSTER at the per-shift wage** — the only option that keeps a live
player whole (coverage + rep preserved, still strongly profitable, 1.2× payroll).
Parity halves coverage; day-only-discount crashes rep. Opt-in (zero disruption) is
the conservative fallback.

### Locked decisions (owner-ratified) → the implementation spec
- **Wage factor 0.6×** (a shifted staffer's salary = `round(base × 0.6)`), applied at
  the HIRE path (hireStaff / setupNewGame), NOT addStaffMember (or every test's
  always-on roster breaks). Below the 0.73 crossover.
- **Clock opens at 06:00** (day-shift start) — `startMinuteOfDay` offset in
  `clock.ts`; re-base `dayOfTick`/`display`/`?seed` boot; the 24h `closeDay`
  rollover stays on the raw tick boundary (phase-invariant).
- **Migration: mint a night roster** at the per-shift wage on v<13 load.
- **SAVE_VERSION 12 → 13**: `shift` AND `onFloor` become SavedStaff fields (the
  mechanical review's M1 — `onFloor` cannot be derived without breaking the
  save→load determinism invariant). Thread `saveVersion` into `readStaff`.
- **Mechanics:** per-tick reconciliation (M2), walk-home, off-floor exclusion from
  isTileClaimed/renderer/pickAt, gather-cancel at reconciliation, rolePool excludes
  off-shift. Night-unstaffed legible signal (render-side).
- **Then RE-RUN the shift probe** with the real mechanics to validate day-only harm,
  and re-tune the harness/economy for the shift wage model.

### The shift model (unchanged from the draft, restated)
Two fixed shifts, **day 06:00–18:30** and **night 18:00–06:30** (12.5 game-h each,
a 30-min overlap at each changeover). `onShift(shift, minuteOfDay)` is a PURE
clock function (`formulas.ts` or `clock.ts`, SSOT), no per-staffer counter:
day = `minuteOfDay ∈ [360, 1110]`, night = `[1080, 1440) ∪ [0, 390]`. The four
window constants live in **`BALANCE.shifts`** (resolves MAJOR B5's SSOT gap).
Rotation is the day↔night CHANGEOVER, not circadian rotation of one nurse (§9.1).

### The core new machinery: an `onFloor` transient + a shift-boundary sweep
The heart of the rewrite. A staffer has THREE availability states, not two:

| state | `onShift` | on the floor? | in dispatch pool? |
|---|---|---|---|
| **working shift** | yes | yes | yes |
| **off-shift, finishing a live bay** | no | yes | NO (new work) |
| **off-shift, gone home** | no | **no (`onFloor=false`)** | no |

- **`onFloor: boolean` is a TRANSIENT runtime field on `Staff`, NOT saved** — it is
  DERIVED (see Save below), so it adds no `SavedStaff` field. It defaults `true`.
- **Off-floor staff are excluded from the three all-staff iterations** the map
  cares about: `isTileClaimed` (`world.ts:339`), the renderer sprite loop
  (`renderer.ts:836`) and `pickAt` hit-test (`renderer.ts:459`). They REMAIN in
  `world.staff` so payroll (`economy.ts`) still charges them — that is the whole
  point (you pay for coverage you hire, on-shift or not). This resolves **MAJOR
  B3** (`removeStaff` was rejected because it stops payroll; `onFloor` keeps them
  paid but off the map).

### MAJOR B1 — gathering promotion is now gated (the negation-of-the-feature bug)
`promoteGatheredReservations` (`dispatcher.ts:810-833`) promotes a gathering bay to
active on arrival-in-room alone, consulting NO availability — so an off-shift nurse
would START and COMPLETE treatment. The `firing` model handles the identical case
in `fireStaff` (`world.ts:1112-1123`): it **cancels every `gathering`-phase
reservation** (`cancelReservation(r, {hint:false})`) and only defers (sets
`firing`) if an `active` reservation remains. **The off-shift transition reuses
this exact split:** at the boundary, a newly-off-shift staffer's `gathering`
reservations are CANCELLED (the patient re-queues to an on-shift staffer); an
`active` reservation is allowed to FINISH. Gating `promoteGatheredReservations`
additionally with `onShift` is the belt-and-braces guard so a mid-gather boundary
crossing can never promote.

### MAJOR B2 & B4 — the walk-home trigger and the off-floor transition
Two deterministic hooks, both reusing shipped precedents:
1. **At each shift-boundary tick** (twice per game-day, a deterministic gate like
   `updateEconomy`'s hourly one — a new `updateShifts(world)` system): for every
   staffer who JUST went off-shift — cancel gathering (above), un-post if posted
   (mirror the `sellRoom` un-post, `world.ts:1006-1012`), and if idle, start the
   walk home (`setWalkerTarget` to `BALANCE.map.entrance`). For every staffer who
   JUST came on-shift and is off-floor — respawn at the entrance (`onFloor=true`,
   idle), available again.
2. **Walk-home completion**: when an off-shift, walking-home staffer ARRIVES at the
   entrance, set `onFloor=false` (the analogue of the patient despawn at
   `decay.ts:35-37`, but MARK instead of delete — payroll must continue).
3. **The last-bay releaser**: an off-shift staffer finishing an `active` bay walks
   home when it releases — hook the `releaseReservation` last-release branch that
   already removes a `firing` staffer (`world.ts:1996-2000`): same site, but for
   off-shift the action is "start walk home", not "removeStaff".

### MAJOR B1-independent boundary (the anti-capture subtlety, preserved)
The ED ratio guard means a ratio nurse never returns to `idle` while a bay is live
(`dispatcher.ts:186-196`), so an idle-gated boundary would let her work forever.
The boundary is therefore enforced by **exclusion from the dispatch pools**, ANDing
`onShift` into `idleStaff` (`dispatcher.ts:118`), `availableStaff`'s `eligible`
(`dispatcher.ts:174`, beside `s.firing`) and `rolePool` (`dispatcher.ts:230`). She
is excluded from NEW work the instant she goes off-shift; her live bays drain; on
the last release she walks home. **The load-bearing regression** (§10 #3): a ratio
nurse holding a bay at her boundary finishes it and then goes off, never past it.

### MAJOR B4 — the midnight-start problem → **OWNER FORK 1**
The clock starts at tick 0 = **midnight**, which is inside the NIGHT window, so a
day-assigned starter is off-shift for the opening 6 game-hours — and a brand-new
"day-only" hospital would open with its staff already walked home (an empty-floor
first impression). Two clean resolutions; **this is the owner's call:**
- **(A) RECOMMENDED — open the game at the day-shift start.** Re-base so tick 0 is
  06:00 (a `startMinuteOfDay` offset in `clock.ts`). A new hospital opens in the
  MORNING with its day staff on duty — genre-standard (RCT/Theme Hospital open in
  the morning) and it makes "day-only" viable from tick 0. **Economy-SAFE: daily
  arrival totals are phase-invariant** (the `timeOfDayCurve` integrates to the same
  per-day total regardless of where tick 0 sits), so the just-shipped economy
  numbers hold. Blast radius (bounded): the midnight daily-report/`closeDay` gate
  (`world.ts:2181`), day numbering, the clock `display` string, `?seed` boot
  determinism, and clock tests — all re-based once, cleanly.
- **(B) Keep midnight start; auto-assign starter staff to `day`; accept the gap.**
  Midnight–06:00 is the quietest arrival block (`timeOfDayCurve` 0.3), so few
  patients are lost — but the new game still opens with an empty floor for ~2 real
  minutes, which reads as broken. Cheaper, worse first impression.

### MAJOR B5 — SSOT, the CommandQueue, and the save-read plumbing
- Window constants → `BALANCE.shifts` (above).
- The per-staffer day/night **toggle goes through the CommandQueue** (a new
  `setStaffShift` command), never a direct `staffUpdated` mutation (hard rule 3).
- `readStaff` (`save.ts:860-877`) does NOT currently receive `saveVersion` (unlike
  `readPatient`/`readReservation`). Threading it in is a REQUIRED companion edit
  for the read-time default — its one call site updates too.

### Shift assignment (resolves §9.5)
**Auto-assigned at hire, alternating within role, first = `day`** (`addStaffMember`,
`world.ts:1037-1057`): count existing staff of that role, `day` if even, `night` if
odd. So a minimal roster is all-`day` → the hospital is staffed through the busy
daytime and empty at night — the coverage pressure, surfaced. A per-staffer toggle
(hire panel / inspect card) lets the player rebalance; a full scheduling view is
deferred.

### Save — SAVE_VERSION **12 → 13** (NOT 12 — economy already took 12)
- One new saved field: **`shift: 'day' | 'night'` on `Staff`**. It breaks
  `SavedStaff` compile by design (`save.ts:246-260`), forcing the schema addition
  (`writeStaff` `:842`, `readStaff` `:860` + threaded `saveVersion`).
- **`onFloor` is NOT saved — it is DERIVED at load**: `onShift(shift, clock)` →
  on floor; off-shift AND holding a live reservation → on floor (finishing);
  else → off floor. Every input (shift, clock tick, reservations) is already
  serialized, so a load reconstructs the exact floor state with no new field. This
  is the key simplification over the draft's §5.
- **Migration for v<13:** assign existing staff **alternating by id parity**
  (`saveVersion < 13 ? (id % 2 ? 'night' : 'day') : asOneOf(o.shift, …)`), so a
  loaded save gets rough round-the-clock coverage rather than empty nights.
  Documented as a behaviour change on load (the outpatient/economy precedent).
  **OWNER FORK 2:** alternating-by-parity (rough 24/7 on load, behaviour changes)
  vs all-`day` (nights empty on load) vs a per-save "shifts enabled" opt-in flag
  (old saves keep 24/7; but shifts become opt-in, which the owner did not ask for).
  Recommend alternating-by-parity.

### Payroll — the whole roster (unchanged, and now it BITES)
No change to `economy.ts` payroll — it already charges every hired staffer hourly.
That IS the design: you pay a night nurse whether or not you also employ a day
nurse, so 24/7 costs ~2×. The economy re-tune is what makes this bite (measured:
2× payroll → ~6% mature margin). Charging only on-shift staff was rejected in the
plan (it removes the tension the owner asked for).

### The measurement protocol — a probe, on the TIGHTENED economy
Build `test/shiftProbe.test.ts` (the economyProbe pattern) measuring three postures
on both layout arms AND the early-game arm, against the SHIPPED economy:
1. **DAY-ONLY** (1× roster, day only) — the starter posture: profit/day, night
   arrivals forgone, deaths/walkouts during the unstaffed night.
2. **24/7** (2× roster, both shifts) — is it solvent at the tightened economy?
3. **BASELINE** (today's always-on 1× roster) — the control.
Deciding metrics, stated up front: profit/day per posture; night-arrival share a
day-only player forgoes; deaths+walkouts in unstaffed night hours; and whether
"day-only → 24/7" is a real progression or a trap. **No shift balance number ships
until this runs.** The night-check-in stall (an unstaffed night reception can't
check patients in, `dispatcher.ts:349`) is measured here too, not assumed.

### Regressions the implementation must own (one per MAJOR)
1. **`onShift` correctness** — both boundaries + both overlap windows across a full
   game-day (unit test on the pure fn).
2. **Off-shift exclusion** — an off-shift staffer is not in `availableStaff`/
   `idleStaff`/`rolePool` and takes no new work.
3. **Anti-capture-independent boundary** — a ratio nurse holding a live bay at her
   boundary finishes it and goes off shift (does NOT work past it). THE subtlety.
4. **Gathering cancellation** — a patient gathering to a room whose staffer goes
   off-shift is re-dispatched or cleanly cancelled, never stranded, and
   `promoteGatheredReservations` never promotes an off-shift staffer.
5. **Walk-home + off-floor** — an off-shift idle staffer leaves the floor
   (`onFloor=false`, tile freed, not rendered/clickable) and reappears on-shift.
6. **Standing-post vacate** — an off-shift receptionist un-posts; a day-only
   reception cannot check in at night (the coverage pressure, pinned).
7. **v12 → v13 back-compat** — a v12 save loads with shifts assigned by parity;
   REAL downgrade helper (`save.test.ts`), `onFloor` reconstructed, not saved.
8. **Payroll unchanged in mechanism** — the whole roster is still charged.
9. **Harness re-tuned green** — the roster and per-condition floors updated for the
   shift world, landing WITH the change (regression-of-record).

### The two owner forks, in one place
1. **Clock start (MAJOR B4):** open at day-shift-start (A, recommended, economy-safe)
   vs keep midnight + accept the empty-floor opening (B).
2. **v12→v13 save migration:** alternating-by-parity (recommended) vs all-day vs a
   per-save opt-in flag.

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
