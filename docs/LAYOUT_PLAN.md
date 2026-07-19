# The layout lesson — distance is a hidden cost the game never teaches

**Status:** SCOPING DRAFT (2026-07-19, owner ask). Not review-ready; §4 lists
what a contract must settle first.
**Origin:** the triage-throughput thread (`docs/HANDOFF.md`), opened by the
capacity-hint measurement and root-caused in commit `2adcd4e`.

---

## 1. The finding

A room reservation claims its slot at DISPATCH time and holds it until both the
patient and the staff have arrived. Measured on triage (3 seeds × 5 days,
`test/utilisationProbe.test.ts`):

| | value |
|---|---|
| mean gather (walk/wait) | **40.8 game-min** |
| mean active (treatment) | 9.6 game-min |
| gather : treat | **4.25 : 1** |
| of gather, spent awaiting the PATIENT | **88.8%** |
| of gather, spent awaiting STAFF | 0.4% |

The nurse arrives almost immediately and then **stands in the room for ~36
game-minutes while the patient walks**. The slot and the staffer are both held
for that whole walk. With one triage bay, nobody else can be triaged.

**Distance is therefore a first-order throughput cost, and nothing in the game
communicates it.** Walking costs ~2.1 game-min/tile, so an 18-tile door is a
~38-minute round trip against a 10-minute treatment.

### 1.1 Measured prize

Same build, same staffing, same cash — only the triage rect moves:

| | FAR (door 18 tiles) | NEAR (door 3 tiles) |
|---|---|---|
| triage completions | 388 | **496 (+28%)** |
| mean gather | 40.8 min | **26.8 min (−34%)** |
| gather : treat | 4.25 : 1 | 2.79 : 1 |
| waitingTriage queue (mean) | 9.44 | 7.63 |
| nurse time treating | 25.6% | 31.5% |

**Moving one room is worth +28% triage throughput.** No purchase, no hire.

Note the NEAR arm still carries a 26.8-minute gather: patients check in first,
so the walk is entrance → reception → triage, not entrance → triage. Distance
between CONSECUTIVE rooms in a patient's chain matters, not just distance to
the door. A contract must not model this as "everything near the entrance".

## 2. What is NOT wrong — corrections to earlier framing

Recorded because both were believed during the investigation and acting on
either would have wasted a milestone.

- **`newGame.ts` is not broken and needs no change.** Its reception and waiting
  doors are **7 tiles** from the entrance. The 18-tile triage is a
  `REFERENCE_BUILD` **test-fixture** choice; it never ships. The GDD
  additionally makes "Build a Triage Bay" the FIRST checklist item by design,
  so pre-building triage would delete the opening tutorial step and contradict
  the design contract.
- **The dispatcher is not choosing badly.** `availableStaff` sorts by load then
  staff id (`dispatcher.ts:210`) with no distance term, which looks like an
  obvious defect. It was measured: a Manhattan-distance tiebreaker moved gather
  40.8 → 41.5 and left idle unchanged. **Reverted.** Staff arrival is 0.4% of
  the wait, so there was never anything to win. Do not retry this.

## 3. THE MEASUREMENT-VALIDITY QUESTION (raise before any balance work)

`REFERENCE_BUILD` (`test/edProbe.test.ts`, mirrored in the utilisation probe)
is the fixture behind **every balance measurement this project has recorded** —
`DEPARTMENTS_PLAN` §3.8, `ED_PLAN` §5b, and §4.3's imaging numbers. Its triage
door is 18 tiles from the entrance, and §1.1 shows that single choice is worth
28% of triage throughput.

**So: is the reference build representative of a hospital a player actually
builds?** If it is not, then throughput, queue-length and death figures across
the project are measured against an unusually sprawling hospital, and some
conclusions drawn from them may be artifacts of the fixture.

This does not invalidate the demand-side arithmetic in §4.3 — imaging
utilisation is driven by arrival weight and step duration, which are
distance-independent. It does bear on anything about queues, deaths or
walkouts.

### 3.1 MEASURED (2026-07-19, owner ask) — the deltas are large

`test/edProbe.test.ts`, 5 seeds × 5 days, **shipped config on both arms** (no
`withArm`), identical rooms/types/sizes/staffing/cash. Only placement differs:
the compact arm packs the same 13 rooms into two bands with corridors on rows
38 and 31, triage door **7 tiles** from the entrance instead of **18**.

A hard guard runs before both arms and throws unless each builds exactly
`build.length + 2` rooms. `buildRoom` rejects SILENTLY, so a compact rect that
overlapped the pre-built reception/waiting or failed the trap-BFS would simply
not exist, and the arm would be measuring 12 rooms against 13 while reporting a
layout effect — the confounding `DEPARTMENTS_PLAN` §3.2 risk 1 exists to
prevent.

| metric | REFERENCE (fixture) | COMPACT | delta |
|---|---|---|---|
| discharged | 120.4 | **161.6** | **+34%** |
| died | 3.2 | **1.8** | **−44%** |
| walkouts (AMA) | 39.0 | 32.8 | −16% |
| profit/day | $12,605 | **$20,198** | **+60%** |
| ER visits | 46.2 | 67.2 | +45% |
| exam visits | 61.2 | 74.8 | +22% |
| surgeries | 10.4 | 14.8 | +42% |
| triage starts | 130.8 | 178.0 | +36% |
| mean wait for triage | 228.9 min | 181.4 min | −21% |
| **payroll/day** | **3,060** | **3,060** | **0 — the control held** |

**Identical payroll is the proof the arms differ only in geometry.**

### 3.2 The finding inside the finding: sprawl was HIDING staff contention

The blocked counters move the opposite way, and by more:

| counter | REFERENCE | COMPACT | |
|---|---|---|---|
| OR gather blocked | 368t | **1,421t** | ×3.9 |
| ...specifically on a nurse | 141t | **1,052t** | ×7.5 |
| doctor blocked in exam | 11.8t | **144.6t** | ×12.3 |

In the sprawling fixture, staff spend their time WALKING, so they are rarely
contended — the queue forms at the corridor, not at the roster. Compact the
hospital and throughput rises 34%, at which point **the staff become the
binding constraint and the contention the game is designed around finally
appears.** ED_PLAN §7.2's "movable bottleneck" is real, but the reference
fixture was largely suppressing it.

This is the important part for future work: the fixture does not merely shift
the numbers, it changes WHICH RESOURCE BINDS. A remedy tuned against the
sprawling fixture is tuned against a walking-bound hospital.

### 3.3 What this does and does not invalidate

**Does NOT invalidate — `DEPARTMENTS_PLAN` §4.3 and the decision to block
Departments Stage 2a.** Imaging utilisation is driven by arrival weight and
step duration, both distance-independent. Compact raises throughput ~34%, so
X-ray utilisation moves roughly 6.2% → ~8%: still an order of magnitude short
of a saturated scanner. **A second imaging suite still cannot pay back, and
Stage 2a stays blocked.**

**Directionally safe but UNDERSTATED — `DEPARTMENTS_PLAN` §3.8's room-capture
result** (doctor-blocked-in-exam 27t → 564t for a non-rebuilder). §3.2 shows
that counter runs ×12 higher in a compact build, so the effect is larger than
recorded, not smaller. The conclusion holds; the magnitude is a floor.

**Needs re-reading — `ED_PLAN` §5b.** The nurse-capture measurement and the
anti-capture guard tuned against it were measured on the walking-bound fixture,
where `noNurse` is 141t versus 1,052t compact. The guard may be tuned against
a regime the player never occupies. **This does not mean it is wrong** — it
means it was ratified on one point of a variable nobody knew was ±34%.

### 3.4 Recommendation

Do NOT simply replace the fixture: a compact build is as unrepresentative in
one direction as the sprawling one is in the other, and swapping it would
silently re-baseline every historical number. Instead:

1. **State the layout with every future balance measurement.** A number without
   its layout is not reproducible.
2. **Run both arms for any decision sensitive to throughput, deaths or
   contention.** A remedy that only works at one point on the layout axis is
   not a remedy.
3. Keep `REFERENCE_BUILD` as the historical baseline so past numbers stay
   comparable, and keep `COMPACT_BUILD` beside it as the contention arm.

## 4. What a contract must settle

1. **Is the reserve-then-walk model itself changing, or only the teaching?**
   Four candidate directions, in ascending blast radius:
   - *(a) Teaching only.* No sim change. Surface the cost so the player can act
     on it. Smallest, and it is the one this document recommends starting from.
   - *(b) Release the staffer during the patient's walk.* Dispatch staff on
     patient proximity. Frees ~35% of nurse time; does NOT fix room throughput,
     since the slot is still held.
   - *(c) Do not claim the slot until the patient arrives.* Fixes throughput
     directly, but a patient can cross the hospital and find the room taken —
     a re-queue loop touching Flow rules 6 and 8, both protected in
     `INVARIANTS.md`. Needs its own review.
   - *(d) Reduce walk cost.* ~2.1 game-min/tile means crossing the 40×40 map
     takes ~84 minutes. Moves every room at once and re-tunes the whole M4
     economy and the harness envelope. A balance milestone, not a fix.
2. **How is the cost surfaced?** Options, none chosen: a walk-time readout on
   the build ghost ("~38 min from the entrance"); a distance/flow warning when
   a room is placed far from its chain predecessors; a per-room "mean gather"
   line on the inspect card (derived, no new state); a thought-log or hint row
   naming the walk. The inspect-card line is the cheapest honest one — it
   reports a measured fact rather than predicting.
3. **Does the checklist teach placement?** Today it teaches WHAT to build, never
   WHERE. The GDD's first-run sequence is the natural place for one sentence,
   and it costs no sim change.
4. **Does this generalise beyond triage?** Triage is worst (every patient passes
   through it, it is first from the door, and there is usually one). The same
   arithmetic applies to every room. A contract should measure at least one
   other room type before generalising the remedy.
5. **What is the regression?** Any change here must pin the §1.1 arms so a
   future edit cannot silently undo the throughput gap.

## 5. Explicitly out of scope

- Pre-building triage in `newGame.ts` (§2 — contradicts the GDD first-run).
- A distance term in `availableStaff` (§2 — measured, worthless, reverted).
- Departments Stage 2a, still blocked on `DEPARTMENTS_PLAN` §4.4.
