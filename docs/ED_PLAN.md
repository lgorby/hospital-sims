# The Emergency Department epic — design + implementation plan (v1)

**Status: Stage A SHIPPED; Stages B and C DRAFT — awaiting pre-implementation
review.** Owner ask (2026-07-18): *"let's find out why the ER is not that busy.
This is a hospital setting and most hospitals [ERs] are some of the busiest
departments"* — then, on seeing the diagnosis: *"let's implement the second and
then the first and then the 3rd. We might need to have an ER entrance area with
a waiting room option as well and a triage for the ER patients, etc."*

Companion to `GAME_DESIGN.md` / `TECH_PLAN.md`; CLAUDE.md hard rules govern.
All numbers are **initial values** — `balance.ts` is authoritative.

## 1. The diagnosis (measured, not assumed)

A 5-day run of the harness reference build, instrumented with the per-room
`visitsTotal` counters the finances epic added:

| Room | Visits (before) |
|---|---|
| Exam | **76** |
| Respiratory | 24 |
| X-Ray | 21 |
| **ER** | **13** |
| CT | 12 |
| everything else | ≤7 |

Two causes, both structural:

1. **Only 3 of 14 conditions routed to the ER** (chest pain, head injury,
   stroke) — **12.8%** of arrival weight. Flu + laceration + fracture alone
   are 65 weight and all flowed to Exam.
2. **Two of those three were gated behind a CT scan first.** Head injury and
   stroke — nearly half the ER-bound weight — had to clear imaging, where 2
   rad techs serve 4 scanner rooms (47 visits between them). Only chest pain
   arrived directly.

**The root cause is a modelling choice, not a bug:** the ER is modelled as a
*specialty treatment room*, while a real ED is the hospital's **front door**.
Our front door is reception → triage → exam. Stages B and C close that gap.

## 2. Stage A — route the real ED cases through the ER (SHIPPED)

**Principle: change the ROOM of existing steps, never lengthen chains.** More
realism with no added contention from longer patient journeys — the cheapest
possible intervention, and the one that isolates the routing variable.

| Condition | Step | Was | Now | Why |
|---|---|---|---|---|
| Laceration | Sutures | exam | **er** | Lacerations are sutured in the ED |
| Fracture | Casting | exam | **er** | Fractures are reduced and cast in the ED |
| Kidney stones | Consult → **Pain control** | exam | **er** | Renal colic is one of the commonest ED presentations — the pain is what brings people in |

Step `roles` are unchanged and remain a subset of `er.staffedBy`
(doctor + nurse), so the `data.test.ts` structural invariant holds.

**Measured result, 5 seeds × 5 days:**

| | Before | After |
|---|---|---|
| ER visits | 13–19 (avg 15.6) | **35–43 (avg 39.6)** |
| Exam visits | 68–83 (avg 74) | 27–41 (avg 37) |
| Discharged | avg 124.2 | avg 112.6 |
| Died | avg 2.8 | **avg 4.2** |
| Left untreated | avg 47.6 | **avg 37.0** |

ER-routed arrival weight: 12.8% → **41.9%**. The ER is now the busiest
department, and Exam sits alongside it rather than dominating.

**The honest read on the cost (do not paper over this):** throughput fell ~9%
and deaths rose ~50% on average, with one seed (31337) tripling to 10 deaths.
Walkouts fell 22%, so patients are giving up less and dying slightly more —
the signature of a **capacity bottleneck**, not a routing error. The reference
ER is 3×4 = **one trauma bed** (`perTiles: 12`), and it is now absorbing 40%
of all arrivals. The harness envelope still passes, so this is inside the
documented tolerance, but it is a real balance signal and §5 owns it.

## 3. Stage B — the ED as a front door (ambulance arrivals) — NOT BUILT

The owner's framing: *"an ER entrance area with a waiting room option as well
and a triage for the ER patients."* That is exactly right, and it is what
makes the ED a department rather than a room.

Design sketch — **needs its own pre-implementation review before any code:**

- **A second intake path.** High-acuity arrivals (acuity 1–2, and/or a
  dedicated ambulance arrival stream) enter through an **ED entrance** and
  never touch reception. This is the core of the stage: today `newGame.ts`
  defines ONE entrance and every patient walks the same funnel.
- **New rooms**: an **ED entrance** (an arrival point, like the main
  entrance), an **ED waiting area** (the ambulance-bay analog of the waiting
  room — likely the existing waiting room with an ED affiliation rather than
  a new room type), and **ED triage** (a triage bay that serves the ED
  stream). The open question is whether these are NEW `RoomType`s or existing
  types tagged with a stream — the latter is far less code and reuses the
  capacity/expand machinery.
- **Stream routing.** `checkInQueues`, `assignTriage` and the waiting-spot
  pickers are all currently hospital-global. Making them stream-aware is the
  real work, and it touches Flow rules 1/4/6 — the invariants most bought
  with past bugs.
- **Save impact**: a patient's stream is new saved state ⇒ SAVE_VERSION bump.
- **Open design questions for the review**: does an ED patient who is *not*
  admitted get discharged from the ED, or transferred to the main hospital?
  Can the player build more than one ED? What happens with no ED built at all
  (the answer must be "today's behaviour", so existing saves keep working)?

## 4. Stage C — ungate the imaging dependency — NOT BUILT

Stroke and head injury currently run **CT → ER**. Real triage order is the
reverse: the patient is stabilised in the ED, *then* imaged, then treated. So:
**ER → CT → ER**, or ER-first with imaging as a middle step.

This LENGTHENS those chains (2 steps → 3), which is exactly the contention the
Stage-A principle avoided — so it must be measured, not assumed, and it lands
after Stage B when the ED has its own capacity. It also interacts with the
Stage-A death signal: more ER steps per patient means more ER bed-time.

## 5. The ER capacity question (owned by Stage B)

Stage A's death signal says the minimum ER is too small for its new share of
traffic. Options, for the owner and the reviewer:

1. **Leave it** — the pressure IS the lesson, and the capacity epic already
   ships the remedy (expand the ER, add beds). Players learn by losing people.
2. **Denser beds**: `traumaBed` density `perTiles: 12 → 6`, so the minimum
   3×4 ED holds **2** beds instead of 1. Thematically right (an ED bay is not
   a single-bed clinic) and it only affects NEW builds/expansions, so no save
   migration. Existing rooms keep their placed props.
3. **A bigger reference build** — harness-only, which fixes the measurement
   but not the player's experience. Insufficient alone.

**Recommendation: (2) as part of Stage B**, measured against the same 5-seed
probe, with (1) as the fallback if 2 beds flattens the pressure entirely.

## 6. Test/measurement protocol

The 5-seed × 5-day probe in §2 is the instrument for every stage: room visits,
discharged, died, left-untreated. Re-run it before and after each change and
record the table in this document — a stage that moves ER traffic without
reporting its outcome cost is not finished.
