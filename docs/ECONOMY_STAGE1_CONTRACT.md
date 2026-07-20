# Economy Rebalance — Stage 1 CONTRACT (collapse the margin)

**Status:** **v2 IMPLEMENTED (2026-07-19) — committed LOCAL, NOT pushed.** The
early-game probe was built, the numbers DERIVED and hardened across two review
rounds, the owner ratified the **~32% mature target** (3 levers; consumables →
Stage-2), and the change was implemented and passed a post-impl adversarial
review (SAFE TO COMMIT; 5 coverage-gap findings folded, incl. a per-room
net-positive regression). SAVE_VERSION 12. **Shipped `feeScale 0.72`** (not the
derived 0.68 — tuned to the real sim; see below). The spec is in
"## v2 — READY TO IMPLEMENT" below; the code is in `balance.ts`/`economy.ts`/
`formulas.ts`/`treatment.ts`/`dispatcher.ts`/`finance.ts`/`save.ts` +
`test/economyStage1.test.ts`. The original draft
(NOT READY, retained for provenance) and the two review outcomes follow.

_History: v1 draft was NOT READY (2026-07-19, both reviews — design 6 MAJORs, code
READY WITH FIXES) for repeating the measure-the-flattering-arm error. The probe +
derivation (below) is the v2 that fixed it._

> ## REVIEW OUTCOME
>
> ### The headline error (design MAJOR 1) — I did it AGAIN
> §3 derives the lever magnitudes from the **mature build** while §4 declares the
> **early-game arm** the one that decides. Utilities are a FIXED per-room cost;
> the mature build earns ~$1,150/room/day, a 6-room starter ~5× less. So a
> per-room utility tuned to leave the mature build at 15% margin **guarantees the
> starter runs NEGATIVE from day one** (~−$1,000/day → bankrupt in ~10-13 days,
> before a new player can grow). This is observation's occupancy-vs-discharge
> mistake and shifts' reference-vs-early mistake, a third time, in the contract
> that cited both. **Remedy: INVERT — set magnitudes from the early-game
> solvency floor (the binding arm), then check the mature build isn't too fat.
> Starting cash ($50k) is a co-lever, not an afterthought.**
>
> ### The other design MAJORs
> 2. **Operating leverage → cash death-spiral the metrics can't see.** At 15%
>    margin ~85% of cost is FIXED, so break-even is ~88% of baseline revenue — a
>    ~12% throughput drop flips to a loss, and a rep dip (mult 0.95 at rep 300,
>    linear to 0.5) is a ~47% arrival collapse → ~−$3k/day. §4 measures margin
>    LEVEL, never recovery-from-shock. **Remedy: a mandated death-cluster / low-
>    rep shock arm asserting cash SURVIVES and RECOVERS, not just steady margin.**
> 3. **Per-tile utilities make the just-populated imaging/OR rooms net losses —
>    reversing the LIVE outpatient milestone.** MRI ~$750/day post-cut vs ~$500
>    utilities. **Remedy: per-room P&L checks for MRI/nucMed/CT/OR; scale
>    utilities partly by USE or exempt idle high-capex rooms.**
> 4. **"Utilities make the LAYOUT lesson economic" is PROVABLY FALSE** — REFERENCE
>    and COMPACT use identical rects, so per-tile utilities are byte-identical
>    between arms; sprawl pays the same as compact. Utilities price SIZE, layout
>    is DISTANCE — orthogonal. (Upside: no double-count.) **Remedy: strike the
>    claim, or price spread explicitly (per-corridor-tile / bounding-box).**
> 5. **All-saves migration can bankrupt a WINNING live player on load** (v11
>    deployed, one-way). Binary all-vs-new misses the cushioned option.
>    **Remedy: a third option — a one-time migration cash grant preserving
>    runway. If new-games-only, state that shifts + every future cost mechanic
>    inherits the fork.**
> 6. **Falsification bounds aren't in the contract; 15% used as both ceiling and
>    target.** The reviewer wrote the bounds to adopt: **(a)** early-game starter
>    reaches positive daily net by ~day 5-7 and never bankrupts under reasonable
>    play; **(b)** an over-built config crosses −$10k in bounded time AND 2×
>    payroll drops mature margin below ~30% (the shifts check); **(c)** mature
>    well-run steady-state ~10-25% with a single death-cluster self-recovering.
>    A per-ARM band, not one reference number.
>
> ### Design MINOR/NIT worth keeping
> Re-verify surgery/OR P&L post-cut (anesthesia tuned fees to pay 3 salaries);
> do NOT raise arrivals to patch the fee cut (re-opens the M4 death-spiral —
> size the cut so 1.5/h stays winnable); the levers are LINEAR so solve the fee
> scale ANALYTICALLY from separately-measured revenue/utilities/repairs, no 3-D
> sweep; the reference build is **15 rooms not 13** (reception+waiting draw too);
> vending is fee-exempt; measure margin at rep STEADY-STATE not mid-climb; drop
> the "82% vs real 1-5%" framing (labor-only vs net-of-all — apples/oranges);
> a broken room shouldn't draw full utilities (already double-penalised).
>
> ### Code review (READY WITH FIXES) — fold these into v2
> - **MAJOR (one line): `TALLY_KEY_VERSIONS` at `save.ts:515` must gain
>   `utilities: 12, repairs: 12`** or every v11 save throws on load
>   (`asNumber(undefined)`). The `electiveTreated: 11` precedent. Not naming this
>   is the difference between a clean migration and bricking live saves.
> - Assign `reportOrder`/`showWhenZero` for the two rows; add
>   `dailyReport.dom.test.ts` + `finance.dom.test.ts:302` to the touched list.
> - De-vacuum the `dayNet` parity test (`finance.test.ts:88-92`) — set the new
>   keys nonzero and update the reference formula, or it goes blind.
> - Keep the fee bake UNIFORM to preserve the elective==emergency fee anchor
>   (`conditions.ts:241-246`).
> - **I over-sized the blast radius:** challenge tests are synthetic,
>   `anesthesia`/`m3Roster` read fees from the table, the harness envelope is
>   qualitative. Derive the affected set from what goes red, not a pre-planned
>   sweep (the INVARIANTS.md:274-279 lesson).
> - Verified SOUND: utilities accrual site, repair hook (no double-count),
>   partition guard, SAVE_VERSION-12 necessity, determinism, early-game-probe
>   constructibility.
>
> ### v2 SEQUENCE (the honest order)
> 1. **Build the early-game probe** (starter build + $50k + minimal roster) and
>    the separate cost-category reporting. 2. **Derive magnitudes from the early-
>    game floor** analytically (levers are linear). 3. **Run the shock arm.**
>    4. **Check per-room P&L + mature ceiling + 2× payroll.** 5. THEN write v2's
>    numbers. The measurement leads; the contract follows.

---

## MEASURED — the early-game probe is BUILT (2026-07-19, v2 step 1 DONE)

`test/economyProbe.test.ts` (gated `ECONOMY_PROBE=1`), 5 seeds, injects the three
levers from outside `src/` (fee scale, size-scaled utilities, per-repair). Shared
builds extracted to `test/fixtures/builds.ts` (also consumed by `edProbe`).
Reviewed adversarially (READY-WITH-FIXES); all 8 findings folded. Run:
`ECONOMY_PROBE=1 npx vitest run test/economyProbe.test.ts --disable-console-intercept`.

**Raw per-arm streams ($/day, full fee):**

| arm | grossRev | vending | payroll | util-tiles | breaks/d |
|---|---|---|---|---|---|
| EARLY-GAME (rep 300, ~$34k post-build) | 1,062 | 66 | 530 | 40 tiles → $468 @candidate | 0 |
| REFERENCE (mature) | 18,774 | 149 | 3,060 | 154 tiles → $4,010 @candidate | 1.16 |
| COMPACT (mature) | 25,706 | 134 | 3,060 | 154 tiles → $4,010 @candidate | 1.16 |

**Margins:** BASELINE (today) — EARLY 53% · REFERENCE **83.8%** · COMPACT **88.2%**
(the ~82% disease, confirmed). BALLPARK (fee×0.5 + utilities + repairs) — EARLY
**−67%** · REFERENCE 20% · COMPACT 41% · REFERENCE **2× payroll −15.7%** (⇒ 2×
payroll BITES once the margin is tight — the shifts unblock). SHOCK (mature,
rep→100 @day 6): trough → recovery, **recovered 5/5** — a tight-margin hospital
survives and climbs back.

**Three measured findings (were asserted, now numbers):**
1. **Design MAJOR 1 QUANTIFIED.** The same levers that leave the mature build at
   20–41% put the starter at **−67%**. Mature earns **18×** the starter's gross,
   so a flat per-tile utility meaningful at scale ($4,010 = 21% of mature gross)
   is **44% of the starter's** revenue. The starter is **throughput-starved**
   (1 nurse → 5.4 discharged vs 11.3 turned away), so per-tile costs are
   REGRESSIVE against it.
2. **Design MAJOR 3 CONFIRMED.** CT goes **net-negative** under BALLPARK (−$51/day
   REFERENCE, −$35 COMPACT, −$182 at 2× payroll) — a just-populated imaging room
   turned into a loss, reversing the LIVE outpatient milestone.
3. **Repairs are NOT a margin lever.** The starter has no breakable room (0
   breakdowns) and mature repairs are only ~$552/day. Keep them thematic
   (maintenance decision), not load-bearing for the margin collapse.

**The analytical result (levers are linear): the naïve Stage-1 is unwinnable.**
You cannot collapse the mature 82% via a uniform fee cut + flat per-tile utilities
while keeping the throughput-capped starter growing. v2 numbers must therefore:
- **Concentrate utilities on EQUIPMENT rooms (imaging/OR)**, near-zero on basic
  clinical rooms. Mature utilities are already 81% imaging/OR; the starter owns
  none, so this prices SIZE/equipment without punishing a small clinic — and it
  is thematically correct (an MRI draws vastly more than an exam room). Also fixes
  finding 2: raise imaging fees or lower the imaging util rate so CT stays > $0.
- **Trim fees gentler than 50%** (or non-uniformly) — the starter is already near
  a healthy 53%; the FAT is the mature build, and equipment utilities do most of
  the collapsing.
- **Treat starting cash / a migration grant as an explicit co-lever** (review
  MAJOR 1) — the starter is not meant to grow fast; give it runway.
- **Consider a gentler mature target (~25–30%, not 15%)** so the fee trim can stay
  survivable for the starter.

### The DERIVED v2 numbers (measured, then adversarially reviewed — 2 rounds)

The analytical solve exposed that a FLAT per-tile utility is regressive against
low-VOLUME rooms (CT/xray go net-negative at any rate that collapses the mature
margin) AND the starter. So the probe gained a **usage-scaled** component (per
ACTIVE room-hour — a room holding ≥1 reservation) and per-room data for all 7
equipment rooms. A first candidate used a FLAT usage rate; review round 2 proved
that too was an artifact (a flat rate is bounded by the weakest earner, so it
can't tax the fat rooms — surgery kept +$1,527/day). The final candidate uses a
**per-type** rate = a fixed FRACTION of each room's measured revenue-per-active-
hour, so every room keeps the same margin and none goes negative.

**DERIVED-PERTYPE — the recommended Stage-1 levers:**
- **`feeScale = 0.68`** (a ~32% fee trim, baked into `conditions.ts`) — starter-safe.
- **HVAC base `$0.05`/tile/game-hour, ALL rooms** (always-on; negligible, thematic).
- **Usage `= 0.52 × (room's revenue-per-active-hour)`, EQUIPMENT rooms only**
  (xray/ct/mri/nucMed/ultrasound/surgery/dialysis), charged per active room-hour.
  Basic clinical rooms pay $0 usage — this is what protects the throughput-starved
  starter (its triage/exam/ER are heavily active). The `0.52` leaves each room
  ~24% of its scaled revenue as margin (imaging still worth building).
- **Repairs** per-type on breakdown — modest, thematic, NOT a margin lever
  (the starter has no breakable room; mature repairs ≈ $552/day).

**Verified outcomes (5 seeds, all reconciled by the reviewer):**
| arm | BASELINE | DERIVED-PERTYPE | note |
|---|---|---|---|
| EARLY-GAME (starter) | 53% | **26.7%** | +$211/day, ALL 5 seeds +$153–371, 0/5 bankrupt |
| REFERENCE (mature) | 83.8% | **32.3%** | every room net-positive (xray +$42 … surgery +$477) |
| COMPACT (mature) | 88.2% | **40.8%** | busier ⇒ earns more margin (the LAYOUT lesson, economic) |
| SHOCK (mature, rep→50 @day6) | — | **29.2%** | NO TROUGH — see caveat 2 |
| REFERENCE 2× payroll | — | **6.4%** | 32%→6%: cost now BITES hard (the shifts unblock) |

**Three caveats a v2 contract MUST carry (all measured, none laundered):**
1. **The mature "floor" is ~32% (REFERENCE), NOT ~15%.** A true 15–20% is
   unreachable in Stage 1 without either loss-making equipment or a per-patient
   VARIABLE cost (consumables per treatment step — the taxonomy's running-costs
   row). That is the **Stage-2** lever. 84%→32% is still a real ~2.6× collapse
   where cost decisions bite (2× payroll → 6.4%).
2. **The operating-leverage risk (§ REVIEW MAJOR 2) does NOT materialise at ~30%.**
   A harsh rep→50 shock (≈45% arrival cut) produced NO cash trough on any seed —
   fixed costs are only ~25% of revenue and usage-utility itself falls with
   activity, so the build stays profitable through the shock. Recovery-from-trough
   is therefore untested and only becomes a risk at a much tighter margin (the 2×
   payroll arm at 6.4%). If a v2 wants that risk to exist, it needs the Stage-2
   variable cost.
3. **The per-type rate has LAYOUT sensitivity.** Rates derived from REFERENCE
   activity leave all REFERENCE rooms positive, but on the busier COMPACT build
   CT/ultrasound dip slightly negative (−$127/−$30). A shipped per-type rate needs
   a safety margin (lower `k`, or rates set from the busier arm), and this must be
   re-checked on both layout arms — the LAYOUT_PLAN §3 discipline.

**Also for the implementer:** "active" = reservation-HELD hours (dispatch → walk →
treat → complete), not pure equipment-in-use — a defensible "room in service"
proxy, but state it; a metered-power model would gate on an occupied stage. And
`utilPerActiveHour` is a live per-hour computation (no save state) beside payroll
in `economy.ts`; the new `utilities`/`repairs` `FINANCE_CATEGORIES` rows are the
only SAVE_VERSION-12 cost (the `TALLY_KEY_VERSIONS` one-liner remains MANDATORY).

---

## v2 — READY TO IMPLEMENT (owner-ratified 2026-07-19)

**Decisions:** target **~32% mature** (the measured, layout-safe 3-lever floor);
per-patient **consumables deferred to Stage-2**; implement fully then commit
local (push = the owner's deploy decision).

### The three levers — where each lives in code
1. **Fee trim.** `BALANCE.economy.feeScale = 0.72` (SHIPPED). The probe DERIVED
   0.68, but the sim's hourly-sampled utilities run ~14% above the probe's
   per-tick estimate, so 0.68 landed the real mature build at 28.5% and the
   minimal starter marginally negative; **0.72 is tuned to the REAL sim**
   (regression-of-record) — mature **32.8%**, COMPACT 50%, starter positive on
   every seed (+$192/+$424/+$216). Applied at the SINGLE treatment
   billing site (`treatment.ts:63-71`) via a `scaledFee(fee)` formula
   (`formulas.ts`), used for BOTH `patient.billed +=` and `billFee(...)` so the
   inspect card and the ledger agree. Vending (`patientNeeds.ts:127`, source
   `vending`) is UNTOUCHED — it is not treatment revenue. Uniform ⇒ the
   elective==emergency anchor holds by construction. No save impact (a data knob).
2. **Utilities** — accrued hourly in `updateEconomy` (`economy.ts`, already runs at
   the game-hour boundary), two components, tallied `tallyCash('utilities', …)`:
   - **HVAC base:** `Σ rooms (footprint tiles × BALANCE.economy.utilitiesPerTileHour)`,
     flat `0.05`, ALL rooms.
   - **Usage:** for each room whose type is equipment, if it is ACTIVE this hour
     (`reservationsOn(room).length > 0`), charge `usagePerActiveHour[type]`.
     Rates are `round(0.52 × measured rev-per-active-hour)` per type, in
     `BALANCE.economy` (or `ROOM_DEFS`): mri 163, ct 165, nucMed 134, xray 81,
     ultrasound 110, dialysis 112, surgery 374; all others 0. **Hourly instantaneous
     sampling is an UNBIASED estimator of active-hours** (a room active X% of the
     day is caught in ~X% of 24 samples) — noisier per-seed than the probe's
     per-tick, same mean; the harness re-tune pins the ACTUAL margin and the rate
     is nudged to land ~32% (regression-of-record).
   - A broken/closed room draws only the HVAC base, not usage (it holds no
     reservation) — the double-penalty the v1 review flagged is avoided by
     construction.
3. **Repairs** — charge `BALANCE.economy.repairCost[type]` when a repair COMPLETES
   (`dispatcher.ts:798`, `room.brokenSince = null`), `tallyCash('repairs', …)`.
   Per-type (mri 1800, ct/nucMed 1200, surgery 1500, xray 400, dialysis 600,
   restroom/resp 200). Not a margin lever; makes neglect a cash decision.

### Save — SAVE_VERSION 11 → 12
New `FINANCE_CATEGORIES` expense rows `utilities` + `repairs`, their `CashTallyKey`
+ `DayTally` keys, `emptyCashTotals`/`emptyDayTally`, and **`TALLY_KEY_VERSIONS:
{ utilities: 12, repairs: 12 }` (`save.ts:515`) — MANDATORY, or every v11 save
throws `asNumber(undefined)` on load (the `electiveTreated: 11` precedent).
`reportOrder`/`showWhenZero` for the two rows. **All-saves** (the owner ratified the
re-baseline; existing saves get tighter on load — the departments/outpatient
precedent). No field-shape/`readRoom` change.

### Regressions required (one per lever + the guards)
1. `scaledFee` bills 0.68× at the treatment site; vending unscaled; `patient.billed`
   == ledger revenue.
2. Utilities accrue hourly: a bigger/denser build costs more base; an ACTIVE
   equipment room adds usage, an idle/closed/broken one does not.
3. Repairs debit `repairCost[type]` on completion; a room that never breaks is
   never charged.
4. Finance partition holds — every dollar classified; `utilities`+`repairs` sum
   into the ledger (`finance.test.ts` partition guard; de-vacuum the `dayNet`
   parity test by setting the new keys nonzero).
5. v11 → v12 back-compat via the REAL downgrade helper (`save.test.ts:840-860`),
   new keys default to 0.
6. **Harness re-tuned green WITH the change** (regression-of-record): the $3,060
   payroll figure, per-condition floors, and the black-envelope assertion all move
   to the ~32% economy and pass. Confirm the mature margin lands ~32% and the
   early-game arm stays solvent (re-run the economy probe's DERIVED-PERTYPE).

### Blast radius
`balance.ts` (feeScale, utilitiesPerTileHour, usagePerActiveHour[type],
repairCost[type]); `formulas.ts` (`scaledFee`, a utilities helper); `economy.ts`
(utilities accrual); `dispatcher.ts:798` (repair charge); `treatment.ts` (scaledFee
at the two lines); `finance.ts` (2 rows) + `dailyStats.ts` (2 DayTally keys) +
`save.ts` (SAVE_VERSION 12, TALLY_KEY_VERSIONS, downgrade); `world.ts` (tallyCash
calls). Tests: `harness`, `finance`/`finance.dom`, `save`, `pricing`, `audit`,
`challenge*`, `m3Roster`, `anesthesia`, `edProbe` — derive the affected set from
what goes RED, not a pre-planned sweep (the `INVARIANTS.md:274-279` lesson).

---

_Original draft below, retained for provenance; superseded by the v2 requirements above._

**Status (superseded):** CONTRACT DRAFT (2026-07-19).
**Parent:** `docs/ECONOMY_REBALANCE_PLAN.md`.
**Blocks:** the staff-shifts epic (nothing bites until this ships).
**Save impact:** **SAVE_VERSION 11 → 12** (new `FINANCE_CATEGORIES` rows +
`DayTally` keys — §5).

---

## 1. What Stage 1 is

**Collapse the measured 82% operating margin to a tight, winnable band by moving
three levers together — a fee re-tune, size-scaled utilities, and per-repair
costs — with the final magnitudes MEASURED, not asserted.** Per-room running
costs and equipment replacement are later stages (the plan's fast-follow).

Stage 1 is chosen this way because the arithmetic (§3) shows **no single lever
suffices**: utilities+repairs alone cannot dent an 82% margin without absurd
numbers, and a fee cut alone leaves the margin too fat. The three move together
or the target is unreachable — which is exactly why they are one contract.

## 2. The measured baseline (the whole justification)

`ED_PROBE=1 test/edProbe.test.ts`, 5 seeds × 5 days, REFERENCE build:

| | value |
|---|---|
| revenue/day (derived) | **~$17,244** |
| cost/day (payroll — the ONLY recurring cost today) | **$3,060** |
| profit/day | **$14,184** |
| **operating margin** | **~82%** |

Real hospitals run **1–5%**. At 82%, cost is not a constraint — throughput is —
so no cost mechanic (shifts, running costs, the finance ledger, the bankruptcy
lose-state) can matter. This is the disease Stage 1 cures.

## 3. The margin arithmetic — the levers' ballpark, GROUNDED not asserted

This is algebra on the baseline, so a reviewer can check it; the FINAL numbers
come from the probe (§4).

**Target: ~15% margin** (real is 1–5%; a game needs recovery headroom, so 15% is
the proposed ceiling of "tight but survivable" — §4 measures whether that is
right). To hit 15% on the baseline:

- **Hold revenue, raise cost only:** cost must reach 0.85 × $17,244 = **$14,657**
  — i.e. **+$11,597/day** of new cost. Over 13 rooms that is ~$900/room/day of
  utilities+repairs — **implausible**, and it would read as arbitrary.
- **Cut fees 50%, hold payroll:** revenue → $8,622, profit $5,562, margin **64%**
  — still far too fat.
- **Cut fees ~50% AND add ~$4,500/day utilities+repairs:** cost $7,560, revenue
  $8,622, profit **$1,062**, margin **~12%.** Utilities ≈ $4,500/13 rooms ≈
  **$14/room-hour** — plausible for hospital power+HVAC+water. **This is the
  ballpark Stage 1 aims at, and the probe refines it.**

**Conclusion the arithmetic forces:** Stage 1 MUST cut fees ~40–50% AND add
utilities on the order of ~$10–15/room-hour AND repair costs — no subset hits a
tight margin at plausible magnitudes. The exact split is measured.

## 4. The measurement protocol — early-game arm MANDATORY

The shifts review's lesson: the mature reference build HIDES affordability; the
real decision lives in the early game. This contract will NOT repeat it.

**Build a NEW early-game arm** (there is none today): starter rooms only
(reception + waiting + a triage + an exam + an ER — what a player builds in the
first days), starting cash $50,000, reputation 300, a minimum viable roster (a
nurse, a doctor, a receptionist), run ~10 game-days. This is the arm where the
rebalance either works or bankrupts a new player.

**Prototype the levers behind a probe** (the observation-scaffold pattern, on a
branch): a global fee scale factor, a per-room-hour utilities cost (scaled by
footprint tiles and room type), and a per-repair cost by room type. Sweep them.

**Deciding metrics, named before measuring** (the metric that would falsify the
target, printed up front):
- **operating margin** on BOTH the reference AND early-game arms.
- **early-game solvency and growth:** does a starter hospital stay above the
  debt limit, and can it still afford its first expansion within ~N days? (The
  failure mode: the rebalance bankrupts new players — the opposite of fun.)
- **is bankruptcy now REACHABLE** by a bad decision (over-hiring, over-building,
  neglecting repairs)? If not, the margin is still too fat.
- **is the mature hospital still profitable** (a well-run hospital should earn,
  just not 82%)?
- **the day-only/leaner postures** — do they now matter (the shifts unblock)?

**No final fee/utility/repair number ships until this probe has run on both arms.
The target margin is an OUTPUT.**

## 5. The three levers — mechanism

### 5.1 Fee re-tune
A **global fee scale factor** in `balance.ts` (the measurement knob), applied in
the billing path (`treatment.ts` where `step.fee` is charged). Once the probe
sets the factor, the contract decides whether to BAKE it into `conditions.ts`
per-step fees (cleaner SSOT, but re-baselines every condition) or keep the
factor (one knob, but a layer of indirection). **Recommend: bake it**, so
`conditions.ts` stays the single source of fee truth. No save impact (data edit).

### 5.2 Utilities — size-scaled continuous cost
A per-room, per-game-hour cost accrued in `updateEconomy` (`economy.ts:5-15`)
beside payroll, summed over `world.rooms`. Scales with **footprint tiles** (a
bigger room costs more) and a **per-room-type rate** (an MRI draws more than a
waiting room — a `utilitiesPerTileHour` or similar in `ROOM_DEFS`/`balance.ts`).
Tallied through `tallyCash` into a NEW `FINANCE_CATEGORIES` expense row
(`utilities`). **This is the lever that makes hospital SIZE cost something and
the LAYOUT lesson economic** — a compact hospital is cheaper to run.

### 5.3 Repairs — stochastic per-breakdown cost
A per-repair cost charged when a repair COMPLETES (rides the existing
`roomFailure`/wear machinery, `balance.ts:295-303`). Per room type (an MRI
repair > a restroom repair). Tallied into a NEW `repairs` expense row. **Today a
breakdown costs only the tech's time** (`repairGameMinutes: 15`, no cash) — this
makes neglect a cash decision, not just downtime.

## 6. Save impact — SAVE_VERSION 12

- Fee re-tune: **no save impact** (data edit).
- Utilities + repairs: two new `FINANCE_CATEGORIES` expense rows and their
  `DayTally` keys ⇒ **SAVE_VERSION bump** (FINANCE_PLAN §7 flagged this). The
  partition-guard test (`finance.test.ts`) will demand the new categories be
  classified — the table working as designed.
- **Live-save consequence to weigh (§9 Q3):** an existing v11 save re-baselines
  under the new fees+costs — a player's healthy hospital may become tight or
  insolvent on load. This is the biggest player-facing risk of the milestone.
  The contract must decide: apply to all saves (honest, but can bankrupt a live
  player's loaded game), or gate the new economy to new games (safer, but two
  economies to maintain). Recommend measuring the severity first.

## 7. Regressions required

1. **Utilities accrue** — a hospital with rooms is charged a per-hour utilities
   cost scaling with size; a bigger/denser build costs more. Pin the size-scale.
2. **Repairs charge on completion** — a completed repair debits the per-type
   cost; a room that never breaks is never charged.
3. **The margin target holds** — the reference build lands in the measured margin
   band (the pinned outcome of §4), and the early-game arm stays solvent. This
   is the load-bearing balance regression; it lands WITH the change, green.
4. **Bankruptcy is reachable** — a deliberately over-built/over-hired config now
   crosses the debt limit (the lose-state is no longer inert).
5. **Finance partition holds** — every dollar is classified; the new `utilities`
   and `repairs` rows sum correctly into the ledger (`finance.test.ts` partition
   guard).
6. **v11 → v12 back-compat** — a v11 save loads with the new categories
   defaulted (real downgrade helper, `save.test.ts:840-860`).
7. **The harness envelope re-tuned green** — `harness.test.ts`'s payroll figure,
   per-condition floors, and black-envelope assertion all move to the new
   economy and pass WITH the change (regression-of-record rule).

## 8. Blast radius / files touched

- `src/sim/data/balance.ts` — fee factor (transitional), `utilitiesPerTileHour`
  by room type, `repairCost` by room type, the target-margin comment.
- `src/sim/data/conditions.ts` — baked fee re-tune (§5.1).
- `src/sim/data/rooms.ts` — per-room utilities/repair rates if room-typed there.
- `src/sim/systems/economy.ts` — utilities accrual beside payroll.
- `src/sim/systems/treatment.ts` or the repair-completion path — repair charge.
- `src/sim/data/finance.ts` (`FINANCE_CATEGORIES`) + `save.ts` (DayTally keys,
  SAVE_VERSION 12).
- `test/` — the new early-game probe, the 7 regressions, and the WIDE re-tune of
  every test asserting a fee, a cash figure, or the envelope: `harness`,
  `edProbe`, `finance`/`finance.dom`, `audit`, `pricing`, `challenge*`,
  `m3Roster`, `anesthesia`. **This is the largest test blast radius of any
  milestone this session** — every balance number moves.

## 9. Open questions a reviewer must settle

1. **Is ~15% the right target margin**, or does a game need more headroom (20%?)
   / can it bear less (8%?)? The probe measures winnability; the reviewer sets
   the falsification bounds (unwinnable floor, inert ceiling) before it runs.
2. **Fee factor vs baked re-tune** (§5.1) — one knob or SSOT-clean per-condition?
3. **All-saves vs new-games-only** (§6) — the live-save re-baseline. This is the
   deploy risk; SAVE_VERSION 11 is live.
4. **Utilities scaling** — tiles only, or tiles × room-type rate? Does an unbuilt
   /closed/broken room still draw utilities? (Reality: a closed room still costs
   something; a proper answer, not an accident.)
5. **Does arrivals need to move too?** Cutting fees ~50% may need more volume to
   stay winnable, or the leaner hospital is simply the point. Measure.
6. **Is the three-lever Stage 1 the right scope**, or should running costs /
   equipment replacement be in Stage 1 too (fewer save bumps) or strictly later
   (smaller, safer)? The plan says later; confirm.
7. **The measurement protocol (§4)** — is the early-game arm defined correctly,
   and are the deciding metrics the right ones? This is the contract's most
   important section — attack it as hard as the design.
