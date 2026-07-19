# The Economy Rebalance — collapsing the margin so cost decisions matter

**Status:** SCOPING PLAN (2026-07-19). Grounded in a measurement, not an
assertion. Not yet review-ready; §7 lists what a contract must settle.
**Origin:** the staff-shifts epic (`docs/SHIFTS_STAGE1_CONTRACT.md`) came back
NOT READY because 2× payroll does not bite — and the measurement showed WHY: the
game runs an **82% operating margin.** No cost decision can matter at that
margin. This milestone fixes the root cause, and it **unblocks shifts, per-room
running costs, and every future cost mechanic.**
**Owner direction (2026-07-19):** *"economy re-tune first, then shifts."*

---

## 1. The measurement — the whole justification

`ED_PROBE=1 test/edProbe.test.ts`, 5 seeds × 5 days:

| build | payroll/day | profit/day | revenue/day (derived) | **operating margin** |
|---|---|---|---|---|
| REFERENCE | $3,060 | **$14,184** | ~$17,244 | **82%** |
| REFERENCE, dense ER | $3,060 | $16,343 | ~$19,403 | 84% |
| LEAN (½ clinical staff) | $2,460 | $7,383 | ~$9,843 | **75%** |

**A real hospital runs a 1–5% operating margin** (research, SHIFTS_PLAN §9:
labor alone is ~55% of cost). **This game runs ~82%.** Payroll is the ONLY
recurring cost today (no room running costs — FINANCE_PLAN §7), so:

- Labor is ~100% of *operating cost* but only ~18% of *revenue*.
- The hospital is so over-profitable that **cost is not a constraint at all** —
  the binding constraint is throughput (how many patients you can physically
  treat), never money.

That is the disease. Every downstream symptom follows from it:
- **Shifts don't bite** (2× payroll: profit $14.2k → $11.1k, still enormous).
- **Per-room running costs wouldn't bite** (scoped in FINANCE_PLAN §7, but at an
  82% margin they would be a rounding error).
- **The finance window is cosmetic** — a ledger nobody needs to read, because you
  cannot go broke by building or hiring.
- **Bankruptcy is unreachable** in normal play, so the lose-state is inert.

## 2. What this milestone is

**Collapse the operating margin toward a tight, game-appropriate band so that
cost decisions — staffing, room count, and later shifts/running costs — actually
threaten solvency.** Not literal 1–5% (a game needs headroom to recover from
mistakes), but a target where a bad decision *hurts* and a good one is *earned*.

This is a **foundational M4 rebalance** — it touches fees, salaries, arrivals,
starting cash, and the debt limit, and it re-baselines every historical balance
number. It needs its own contract, its own 2 reviews, and — the lesson of this
session — **its target measured, not asserted.**

## 3. The cost taxonomy (owner asks 2026-07-19) — and the levers

The owner named the full operating ledger a real hospital carries and the game
ignores: repairs, **utilities (heating/AC, water, gas, electricity), replacing
furniture and equipment.** These are not one lever — they are a **cost model**
with distinct KINDS, and the design value is that each is a different, thematic
decision, not a flat drain. The taxonomy:

| category | kind | scales with | the decision it creates | today |
|---|---|---|---|---|
| **Payroll** | continuous | headcount | who/how many to hire (and, later, shifts) | EXISTS |
| **Utilities** — heat/AC, water, gas, power | continuous | **floor area + room mix** (an MRI draws more than a waiting room) | build efficiently; big sprawling hospitals cost more to run (pairs with LAYOUT_PLAN) | **none** |
| **Per-room running costs** — consumables/supplies | continuous | room type + usage | is this room worth keeping? (the RCT profit-per-ride) | **none** (FINANCE_PLAN §7) |
| **Repairs** — parts to fix a breakdown | **stochastic** (per breakdown) | room type + neglect | maintain, or gamble on downtime + a repair bill | **none** (only tech time today) |
| **Equipment/furniture replacement** — end-of-life | **periodic/capital** | prop age/wear | budget for the big replacement, not just the fix | **none** |

**Two design cautions, stated up front:**
- **Micromanagement risk.** Five cost categories, each with a UI and a decision,
  can become a spreadsheet. The contract must decide which are FIRST-CLASS
  decisions (the player acts on them) vs which are AMBIENT (a line on the ledger
  that just tightens the margin). A defensible split: utilities + running costs
  are ambient continuous drains that scale automatically; **repairs and
  replacement are the active decisions** (maintain vs gamble); payroll/shifts is
  the third active axis.
- **Utilities are the highest-value NEW lever** — they scale with hospital SIZE,
  which nothing currently costs. A player who over-builds should feel it. This
  also makes the LAYOUT lesson economic: a compact hospital is cheaper to heat
  and light, not just faster.

### 3.1 The margin levers

Moving the margin (§2's disease) uses this taxonomy. The contract picks a
combination and MEASURES it; none is asserted here.

1. **Lower per-patient fees** (`conditions.ts` step fees). Directly shrinks
   revenue. Cleanest single lever, but it re-baselines every condition's P&L and
   interacts with the outpatient/imaging revenue work.
2. **Add per-room running costs** (FINANCE_PLAN §7 — already scoped as a
   milestone). A recurring cost per room per hour, accrued beside payroll. This
   is the RCT-authentic lever — rides show *profit* because they have running
   costs; ours show income only. **This milestone and per-room running costs are
   the same milestone** — folding them together is the honest scope.
3. **Raise salaries** (`roles.ts`). Makes labor a real cost and makes the
   shift/headcount decision bite directly — the most relevant lever for the
   shifts epic that follows. But it interacts with the anesthesia/ratio balance.
4. **Add per-repair costs** (owner ask 2026-07-19). **MEASURED CURRENT STATE: a
   breakdown costs only the maintenance tech's TIME and the room's downtime —
   there is NO monetary repair charge** (`balance.ts:295-303` has
   `repairGameMinutes` but no `repairCost`; `economy.ts` never charges for a
   repair). RCT charges cash to fix a breakdown, and the game should too: a
   per-repair parts/materials cost, charged when a repair completes. This is an
   EVENT cost (per breakdown) complementing running costs (continuous), and it
   makes the maintenance decision real — an unmaintained room that breaks often
   becomes a cash drain, not just a downtime nuisance. A natural per-room-type
   cost (an MRI repair costs more than a restroom repair), riding the existing
   `roomFailure`/wear machinery.

**The interaction that matters:** these are not independent. Lowering fees AND
adding running costs AND raising salaries AND adding repair costs all cut the
margin — do them all naïvely and the game is unwinnable. The contract must move
them **together, measured against a target margin**, not one at a time by feel.
The four levers also differ in KIND — fees/salaries are continuous and
predictable; running costs are continuous; **repair costs are stochastic
(per-breakdown)**, so they add variance the player manages by maintaining, which
is a richer decision than a flat drain.

## 4. The design target — MEASURED, not asserted (the session's hard-won lesson)

v1/v2/v3 of observation and the shifts contract all asserted balance numbers and
were wrong. This milestone commits from the start to a measured target:

**The deciding question, stated before measuring:** at what margin does the game
become a real economy — where the player must *choose* (can't afford everything),
a bad build/hire *hurts*, and recovery is *possible* — without tipping into
unwinnable or grind?

**The probe (extend `edProbe`/a new `economyProbe`):** sweep the fee/running-
cost/salary levers across candidate settings and report, on both layout arms AND
the EARLY-GAME arm (the shifts review's lesson — the mature reference build hides
affordability; the decision lives in the early game):
- **profit/day and margin** under each setting;
- **time-to-first-expansion** from starting cash (can a new player still grow?);
- **can a bad decision bankrupt?** (is the lose-state now reachable?);
- **is 2× payroll now a real trade-off?** (the direct shifts-unblock check);
- **is the game still winnable** at the tightened margin, on all arms.

**No number ships until this probe has run.** The target margin is an OUTPUT of
the measurement, not an input.

## 5. Save impact

- Fee/salary changes are `conditions.ts`/`roles.ts` data — **no save field, no
  bump** (the IMAGING §4B precedent: data-table edits don't touch saves).
- **Per-room running costs** likely add a `FINANCE_CATEGORIES` expense row and a
  `DayTally` key ⇒ **SAVE_VERSION bump** (FINANCE_PLAN §7 already flags this).
- A one-way live-save consequence to weigh: existing saves re-baseline under new
  fees/costs — a player's healthy hospital may become tight on load. Document it
  (the departments/outpatient precedent), and consider whether the change is
  gated to new games or applies to all.

## 6. Why this is worth doing (beyond unblocking shifts)

This is not a detour — it is the milestone that makes Hospital Simms a *tycoon
game* rather than a throughput puzzle:
- It makes the **finance window real** (a ledger you must read to survive).
- It makes **per-room running costs** meaningful (the RCT profit-per-ride model).
- It makes **repair costs** a real maintenance decision (owner ask): a room you
  neglect breaks and drains cash, so upkeep is a choice with a price.
- It makes the **bankruptcy lose-state reachable**, so risk exists.
- It makes **every staffing and building decision a trade-off**, which is the
  genre's core loop.
- And only THEN do shifts, night differential, and agency pricing have anything
  to bite against.

The handoff already names per-room running costs as *"the one thing standing
between the finances window and a true RCT ledger."* This milestone is that,
measured and generalised into the full cost taxonomy (§3) the owner described.

**Scope discipline (the observation lesson, applied to scope not just numbers):**
the full taxonomy is the VISION; the contract must pick a SHIPPABLE Stage 1 and
measure it, not build all five categories at once (that was the observation
mistake — an unreviewable single drop). A likely Stage 1: **utilities (size-
scaled) + repair costs**, because together they collapse the margin AND deliver
two owner asks AND make the layout lesson economic — with running costs and
equipment replacement as fast-follow stages once the target margin is proven.

## 7. What a contract must settle

1. **The target margin band** — measured (§4), but the contract states the
   falsification bounds (unwinnable floor, inert ceiling) before the probe runs.
2. **Which levers, in what combination** (§3) — and the order of operations so
   the intermediate states are not unwinnable.
3. **Fold in per-room running costs, or sequence them?** They are arguably the
   same milestone; the contract decides whether to ship the cost table with the
   fee/salary re-tune or immediately after.
4. **New-games-only vs all-saves** (§5) — the live-save re-baseline consequence.
5. **The harness/envelope re-tune** — every per-condition floor, the black-
   envelope assertion, the $3,060 payroll figure, all move together and land
   green WITH the change (the regression-of-record rule).
6. **The measurement protocol** — early-game arm mandatory, deciding metrics
   named up front, both layout arms.
7. **Does arrivals need to move too?** Tightening the margin by cutting fees may
   need more volume to stay winnable — or not. Measure before deciding.

## 8. Sequencing

1. **This milestone** (economy rebalance + per-room running costs) — foundational.
2. **THEN the shifts epic** (`SHIFTS_PLAN`) — now with something to bite against.
   Its Stage-1 contract's mechanical MAJORs (gathering-cancel semantics, the
   off-floor state, the midnight-start collision) still stand and must be solved
   too — the economy re-tune fixes the "inert" half, not the "heavy" half.
3. Shifts Stages 2–3 (lounge, fatigue) as before.

**The shifts contract stays NOT READY on BOTH counts** — this milestone clears
the economic objection; the mechanical objections are a separate rewrite.
