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

**Recommended first action for any contract here: measure a compact-layout arm
against the current fixture across the ED probe's existing columns.** If the
deltas are large, the fixture needs revisiting before it is used to ratify
another balance decision.

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
