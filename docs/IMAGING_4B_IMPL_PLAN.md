# Imaging §4B — give chest pain its chest X-ray

**Status:** CONTRACT DRAFT (2026-07-19). Awaiting 2 independent adversarial
pre-implementation reviews. **No code until findings are folded in.**
**Parent:** `docs/IMAGING_PLAN.md` §4B, sequenced FIRST by §5.
**Save impact:** **NONE.** No `SAVE_VERSION` bump. See §4.

---

## 1. The problem, restated from measurement

`IMAGING_PLAN` §1: X-ray runs at **6.2% utilisation**, 4.1 visits/day. §3 says
X-ray is the one modality whose game share (37%) already roughly matches
reality (~35%) — the volume is simply too small in absolute terms.

`chestPain` is **weight 10** (`balance.ts:63`), acuity 1–2, and receives **no
imaging at all** — a 90-minute ER stay and out. Chest radiography is
near-universal for that presentation. It is the largest single block of missing
X-ray demand in the table.

## 2. THE DESIGN DECISION — append, do not prepend

**This is the most important paragraph in the contract, and it departs from how
every existing imaging chain is built.**

All four current imaging chains prepend: `xray → er`, `ct → er`, `ct → er`,
`ct → er`. `IMAGING_PLAN` §2.2 identifies this as **backwards** — HIGH
confidence, the answer to the owner's original question:

> *"Radiology is a service the ED orders mid-stay and the patient returns from,
> not a gateway patients pass through before physician evaluation."*

So chestPain gets `er → xray`, **not** `xray → er`. Three independent reasons,
any one of which would be sufficient:

1. **Correctness.** Prepending would add a fifth instance of the exact
   inversion §2.2 says is wrong, making §4A's eventual fix strictly larger.
2. **Clinical truth.** A chest-pain patient is triaged, seen, and *then*
   imaged. They are not X-rayed on arrival.
3. **Blast radius — this is the cheap part, and it is not an accident.**
   ~8 existing tests assert that chestPain's **step 0 is the dual-role ER
   step** (`m3Roster.test.ts:165-207`, `:209-236`, `:238-257`;
   `capacity.test.ts:125-149`, `:151-168`, `:196-215`; `edRatio.test.ts:417-426`).
   Every one of them builds an `er` and no `xray`, so **prepending breaks them
   all** — no xray room means no reservation on tick 1. Appending leaves step 0
   untouched and they all keep passing unmodified.

**The `IMAGING_PLAN` §5 claim that §4B is "the cheapest lever" is only true in
the append direction.** Prepended, it is a ~10-file test rewrite. This contract
asserts the cheap version and the correct version are the same version.

### 2.1 Two steps, not three

The fully faithful chain is `er → xray → er` (order, image, interpret, dispose).
This contract ships **`er → xray`** and explicitly defers the return leg:

- Three steps means two extra gathers and an extra walk *each way* — precisely
  the chain-lengthening cost `DEPARTMENTS_PLAN` §3.1 warns against and
  `IMAGING_PLAN` §4A budgets as its own milestone.
- `er → xray` already delivers the demand-side prize (X-ray volume) and the
  directional correction (ED as orderer).
- The return leg belongs to §4A, measured against the baseline this change
  establishes — `IMAGING_PLAN` §5 point 2 sequences it exactly that way.

Discharging from radiology is a modelling abstraction. **Name it as one in the
chain comment; do not pretend it is realism.**

## 3. THE CONFOUND CONTROL — hold minutes and fee constant

`DEPARTMENTS_PLAN` §3.2 risk 1: *never measure a routing change and a capacity
change together.* Adding 20 minutes of new treatment on top of 90 would change
both demand and total service time, and the measurement could not separate them.

So the split is **conservative**:

| | before | after | total |
|---|---|---|---|
| ER treatment | 90 min / $1,200 | **70 min / $1,000** | |
| Chest X-ray | — | **20 min / $200** | |
| **sum** | **90 min / $1,200** | **90 min / $1,200** | **unchanged** |

Total service minutes and total billed revenue per chestPain patient are
**identical**. The change is a pure re-routing of 20 minutes from the ER to the
X-ray room. This means:

- the M4-tuned economy does not shift (revenue per patient is a constant);
- `harness.test.ts`'s black-envelope assertions face no revenue delta;
- **any measured movement is attributable to routing alone.**

It also relieves the ER, which is a real second-order effect and must be
reported, not hidden — `harness.test.ts:333-336` reasons explicitly that *"the
single ER throttles chest pain"*, and this change weakens that throttle by 22%
of chestPain's ER minutes.

### 3.1 The falsification condition

**This change is REVERTED, not tuned, if on EITHER layout arm:**
- deaths rise by >10% against baseline, **or**
- `radTech` utilisation exceeds **65%**, or the elective referral stream's
  completion rate drops >15% (radTech starvation — see §5), **or**
- chestPain's own discharge count falls (the §3.2-risk-1 discharge floor).

Stated before measurement, per the handoff's five-times-repeated lesson.

## 4. Save impact: NONE — with one wrinkle to document

`SAVE_VERSION` stays at **11**. Nothing serializes a chain or its length: the
save stores `stepIndex: number` only (`save.ts:209` written `:731` read `:770`;
reservation `:278`/`:1047`/`:1065`), and `condition` is validated against
`CONDITION_IDS` (`save.ts:757`), never against chain shape.

**This is the single largest reason to do §4B before anything else on the
imaging thread: `SAVE_VERSION 11` is deployed and one-way, and this lever costs
zero of that budget.**

**The wrinkle, recorded honestly:** an in-flight chestPain patient saved under
the old build with `stepIndex: 0` reloads into a world where index 0 is still
the ER step — so appending is *also* the direction that makes the reload benign.
(Prepending would have silently reinterpreted their step.) A patient saved
mid-chain at `stepIndex: 1` under the old build does not exist, because the old
chain has only one step; `stepIndex: 1` on load now means "awaiting X-ray",
which is reachable and correct. **No migration, no bump, no dangling state.**

## 5. The contention risk — the one thing that could sink this

`radTech` is the binding role. `OUTPATIENT_IMPL_PLAN` already recorded radTech
**24% → 56%** when the elective stream landed, which is *why* `perGameHour` was
cut 1.0 → 0.5 — and it recorded that **a third radiographer did not repair it**
(it made deaths worse on both arms).

chestPain is weight 10 **and** acuity-1, so it is referral-grade: its effective
weight *scales up with reputation* via `caseMixShiftFactor`
(`balance.ts:125`, `formulas.ts:134-138`). **Its X-ray demand therefore grows
as the player succeeds** — the arm most likely to trip §3.1.

**Mandatory: measure with the elective stream LIVE.** Measuring §4B against a
world with no outpatient referrals would understate radTech load exactly where
it binds. Use the existing outpatient arms at `edProbe.test.ts:471-485`.

## 6. Measurement protocol — both layout arms, per LAYOUT_PLAN §3.4

Owner-confirmed 2026-07-19: both arms.

1. `UTIL_PROBE=1 npx vitest run test/utilisationProbe.test.ts --disable-console-intercept`
   — per-room (xray especially) and per-role (radTech) utilisation. This is the
   only instrument that reports either.
2. `ED_PROBE=1 npx vitest run test/edProbe.test.ts --disable-console-intercept`
   — REFERENCE **and** COMPACT arms, plus the outpatient arm.
3. Record, for each arm, **before and after**: xray utilisation + visits/day,
   radTech utilisation, deaths (total and chestPain-specific), walkouts,
   profit/day, ER utilisation, and the elective completion rate.
4. **State the layout with every number** (`LAYOUT_PLAN` §3.4 point 1).

`utilisationProbe.test.ts:48-62` keeps a hand-synced copy of `REFERENCE_BUILD`.
Confirm it still matches `edProbe.test.ts:22-41` before trusting cross-probe
comparisons — a silent divergence would invalidate the whole pass.

## 7. Files touched

| file | change |
|---|---|
| `src/sim/data/conditions.ts:99-112` | chestPain: ER 90→70 / $1,200→$1,000; append `{ label: 'Chest X-ray', room: 'xray', roles: ['radTech'], durationGameMinutes: 20, fee: 200 }` + a comment naming the §2.2 inversion and the §2.1 abstraction |
| `test/imaging4b.test.ts` (new) | regressions — see §8 |
| `docs/IMAGING_PLAN.md` | §5 sequencing: mark (B) shipped, record the append finding |
| `docs/CHANGELOG.md`, `docs/HANDOFF.md` | per the workflow |

**No `src/sim/systems/` change. No `src/ui/` change. No save change.** If the
implementation finds itself editing either, stop — the scope was wrong.

Structural guards that will newly apply and should pass unmodified:
`data.test.ts:31-54` (step room exists; `roles ⊆ ROOM_DEFS.xray.staffedBy` —
`radTech` qualifies), `:56-83` (room-usage coverage), `finance.test.ts:485-520`
(`earningRooms` is derived+memoized from `fee > 0` steps, so xray is already in
it via `fracture`/`pneumonia` — no new row).

## 8. Regressions required (one per major claim)

1. **Chain shape + order** — chestPain step 0 is `er` with `['doctor','nurse']`,
   step 1 is `xray` with `['radTech']`. Pins the §2 append decision against a
   future well-meaning prepend.
2. **Conservation** — summed `durationGameMinutes` = 90 and summed `fee` = 1,200
   across chestPain's steps. Pins §3's confound control; fails loudly if someone
   "rebalances" one step without the other.
3. **End-to-end discharge** — a chestPain patient in a world with `er` + `xray`
   reaches `discharged` with `stepIndex === 2` and is billed $1,200 total.
4. **Save continuity (no bump)** — a v11 save carrying a chestPain patient at
   `stepIndex: 0` loads, and that patient still completes. Pins §4's claim that
   this costs no save budget.
5. **Elective isolation** — `rollElectiveCondition` never returns `chestPain`
   (guards `spawn.ts:51-55`; chestPain has no `elective` flag).

## 9. Open questions a reviewer must settle

1. **Is `er → xray` defensible, or is the 3-step `er → xray → er` the only
   honest chain?** §2.1 argues the 2-step; a reviewer who disagrees should say
   so now, not after measurement.
2. **Is 70/20 the right split, or should the ER step keep its 90 and the X-ray
   be additive?** The conservative split buys measurement cleanliness at the
   cost of understating real-world service time. Which matters more here?
3. **Should `laceration` (weight 20) also change?** `IMAGING_PLAN` §4B calls it
   "ER-only, which is defensible" — this contract touches it NOT. Confirm.
4. **Does the §3.1 falsification set have the right thresholds?** They are
   asserted, not derived; §2.5 of the parent plan says imaging throughput
   numbers cannot be evidence-calibrated from the research pass.
5. **Does relieving the ER by 20 min × weight-10 invalidate any `ED_PLAN` §5b
   conclusion** tuned against the old throttle?
