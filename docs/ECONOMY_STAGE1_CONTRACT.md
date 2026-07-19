# Economy Rebalance — Stage 1 CONTRACT (collapse the margin)

**Status:** CONTRACT DRAFT (2026-07-19). Awaiting 2 independent adversarial
pre-implementation reviews. **No code until findings are folded in.**
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
