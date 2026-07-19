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

## 3. Stage B1 — ratio staffing: the ED as a department, not four clinics

**Researched 2026-07-18.** The owner's model — *"RN covers 4 patients, 1
doctor covers an area"* — is **substantially correct and is now the design.**

### 3.1 What the research established

| Claim | Verdict | Source |
|---|---|---|
| Nurse 1:4 in the ED | **CORRECT — it is LAW**, not a guideline: California Title 22 §70217 mandates 1:4 in the ED "at all times", with **no shift averaging** — an instantaneous cap | Cal. Code Regs. Tit. 22 §70217 |
| 1:1 for critical/trauma | **CORRECT**, RN-only; trauma resus in practice runs **2 nurses + 2 physicians on ONE patient** | Title 22; trauma-team activation guidance |
| Triage nurse is extra | **CORRECT** — the triage RN is *excluded* from the 1:4 count and must be "immediately available at all times" | Title 22 |
| "~15 beds, one doctor" | **CORRECT, and it falls out of the arithmetic**: at ~4 patients/bed/day and 2.5 patients/physician/hour, 15 beds ≈ 60 patients/day ≈ 24 physician-hours ≈ **1 doctor continuously present**. Flagged by the researcher as a DERIVATION from two independently-sourced constants, not a quoted standard | AAEM 2.5 PPH cap; ACEM 1 bed per 1,100 attendances/yr |
| "4 areas × 40 beds, one doctor" | **WRONG by ~11×** — 160 beds ≈ 640 patients/day ≈ **~11 physicians on the floor at once**. It also describes an ED larger than Parkland (154 rooms, 180k visits/yr); architects advise splitting before 100k visits/yr | derived from the above |

Two caveats that partly rescue the 40-bed intuition: an *area* of 40 may be
covered by one **attending** plus residents/APPs whose patients they
supervise; and **boarded** patients occupy beds while generating no new
physician work, so bed count overstates physician demand in a clogged ED.

### 3.2 The model (game translation)

Three levels, matching the owner's description:

1. **Beds** — the ED room's `capacity` slots; already exists (capacity epic).
   `traumaBed` density `perTiles: 12 → 3`, so a minimum 3×4 ED derives **4
   bays** instead of 1. (Real acute bay ≈ 12 m², so 4 bays in 12 tiles is
   dimensionally sane.)
2. **Nurses — a 1:4 RATIO**: one nurse may hold up to `patientsPerNurse` (4)
   concurrent ED reservations.
3. **Doctors — ZONE coverage**: one doctor covers the room, up to
   `bedsPerDoctor` (15) ⇒ required doctors = `ceil(beds / 15)`.

**This preserves the payroll brake** (the risk flagged before the research): a
4-bay ED runs on **1 nurse + 1 doctor**; a 16-bay ED needs **4 nurses + 2
doctors**. Cost scales with capacity, just sub-linearly — which is exactly why
real departments consolidate.

### 3.3 Implementation shape (blast radius, already mapped against the code)

The load-bearing insight: **a staffer's load is DERIVED** by counting
reservations whose `staffIds` include them — the restroom-occupancy precedent
(derived from live claims, never separately tracked). **No new saved state and
no SAVE_VERSION bump for the ratio itself.**

- `idleStaff` → **`availableStaff`**: a ratio role qualifies while its load is
  under capacity FOR THAT ROOM, instead of requiring `duty.kind === 'idle'`.
- **`releaseReservation` is the crux.** Today it unconditionally idles the
  staffer and walks them out (`world.ts:1797`). It must idle/step-out **only
  when remaining load hits zero**, and otherwise **re-point `duty` at another
  live reservation** of that staffer. Save shape unchanged — `duty` stays a
  single valid `reservationId`, so the existing duty↔reservation border
  validation keeps holding.
- **Flow rules 7/8 are the danger zone**: they release everything a
  reservation holds. They must release only the ONE binding, never the
  staffer's whole panel — a death in bay 1 must not free the nurse from bays
  2–4.
- The anesthesia milestone's **partial-gather soft hold** treats "secured" as
  all-or-nothing per staffer; a ratio staffer is *partially* available, so the
  hold must key on (staffer, remaining capacity), not staffer identity.
- **Movement**: a ratio staffer walks to the zone once and stays — no re-path
  per patient. `promoteGatheredReservations` waits for participants to ARRIVE;
  a nurse already standing in the ED is already arrived.

### 3.4 Deliberately NOT in B1

- **Interruptible/per-touch staffing.** The research is clear that "lock a
  staffer for the whole treatment" is wrong in both directions (a physician
  touches each patient ~2.5×/hour, not continuously). True per-touch modelling
  is a much larger change; ratio binding is the honest middle ground and is a
  strict improvement on today.
- **Zone types** (resus 1:1 held deliberately EMPTY; fast track 1:5 in chairs
  at half the floor area; acute 1:4) — where the strategic texture lives, and
  its own stage. See §7.
- **Boarding** — see §7; needs an inpatient-ward concept the game lacks.

## 3b. Stage B2 — the ED front door (ambulance arrivals) — NOT BUILT

The owner's framing: *"an ER entrance area with a waiting room option as well
and a triage for the ER patients."* That is exactly right, and it is what
makes the ED a department rather than a room. Research backs the shape:
**~18–19% of ED patients arrive by EMS**, they bypass the waiting room and
registration but **NOT assessment** (EMTALA requires immediate triage), and
they are admitted at ~35–40% vs ~13–14% for walk-ins. The failure mode to
model later is **offload delay / "ramping"** — with no space, the crew and
stretcher are stuck, removing an ambulance from the road.

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

## 7. What the research says we are missing (future epics, not scoped)

Recorded because these are the highest-value ideas the research surfaced.

1. **Boarding — the endgame constraint, and the best tycoon dynamic
   available.** Every professional body agrees the ED's binding constraint is
   usually *not inside the ED*: it is **output** — no inpatient bed to admit
   into. Median boarding 190 min (295 in EDs over 80k visits), 47% of an
   admitted patient's ED time, psych boarders ~3x worse, triggering on
   hospital occupancy above 85%. In game terms: **the ED's performance becomes
   hostage to the player's decisions about the REST of the hospital.** Needs
   an admission/inpatient-ward concept the game does not have.
   (Asplin input/throughput/output model; ACEP crowding position.)
2. **The bottleneck should be MOVABLE, and diagnosing it should be the skill.**
   A discrete-event study modelled two EDs and found opposite constraints: the
   "national average" ED was provider-limited (one extra physician cut LOS by
   ~1h; a second did nothing), the academic ED was bed-limited (extra
   physicians did little; beds and nurses moved it). The killer line: *adding
   1 doctor + 8 beds + 2 nurses produced nearly identical results to adding
   the one doctor alone.* A game where the player must DIAGNOSE the binding
   resource — and where scattergun spending is wasted — is a better game than
   a fixed bottleneck. This is arguably the single most valuable finding.
3. **Nurses and doctors fix DIFFERENT things.** Nurse hours move
   discharged-patient LOS (-28 min) and left-without-being-seen (-9/day) but
   have *zero* effect on admitted-patient LOS, which is gated by inpatient
   beds. Encoding that asymmetry teaches real operational logic instead of
   "add staff, number goes up".
4. **Zones need different RULES, not different labels**: resus 1:1-2:1 and
   kept deliberately EMPTY (its idleness is the point — held capacity,
   excluded from the treatment-space count); fast track 1:5, chairs not beds,
   half the floor area, 30-40% of volume, ~90-minute turnover; acute 1:4,
   where boarding accumulates.
5. **Most of a patient's stay is spent waiting on SHARED resources, not on
   staff.** Median ED LOS 211 min, of which the physician contributes perhaps
   20-30. Lab median turnaround 51 min; CT workflow is 29% of total LOS and
   can add 150 min. Our shared radTech pool across four scanners is already an
   accidental model of this — Stage C should lean INTO it, not remove it.
6. **Terminology: pick a region and stay in it.** US = pods, rooms, gurneys,
   fast track, EDOU, ESI. UK = zones, cubicles, trolleys, majors/minors/resus,
   CDU, Manchester Triage. Mixing them is the tell that a hospital game was
   researched from blog posts. This game is US-flavoured (ER, exam room,
   trauma bed) — so: pods, bays, fast track.
