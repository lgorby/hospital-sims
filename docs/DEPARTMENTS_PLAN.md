# The Departments epic — three capacity units, not one (plan v2)

**Status: §3 (Stage 1) REVIEW-HARDENED and owner-ratified — implementing. §4 (Stage 2) still DRAFT, awaiting its own review.**

Owner asks (2026-07-19):
1. *"I did expand respiratory room but it did not add new bays"* — the bug that
   started this. Fixed at the hint level (commit `41ee800`); this plan fixes
   the model underneath it.
2. *"The OR can be a collection of different operating rooms inside of it. Not
   just a single room. The xray room is a collection of rooms inside of it
   where there can be more than one xray machine in the entire entity and the
   user can expand the entire area and it will add more xray machines that are
   separated by a wall."*
3. *"If patients are really not seen there, then we do not need the room, the
   respiratory therapists would need to go to the areas they are needed in the
   exam rooms, ER, etc."*

Companion to `GAME_DESIGN.md` / `TECH_PLAN.md`; CLAUDE.md hard rules govern.
All numbers are **initial values** — `balance.ts` / `rooms.ts` are authoritative.

## 1. The research (measured against sources, not assumed)

Deep research, 2026-07-19: 24 sources fetched, 98 claims extracted, top 25
adversarially verified (3-vote, 2/3 refutes kills). **Verdicts and confidence
are reported as returned, including the ones that FAILED.**

| Claim | Verdict | Source |
|---|---|---|
| **Respiratory therapy capacity is therapist-HOURS. There is no room.** AARC's staffing methodology contains no spatial capacity unit — a full-text search for bed/room/station/chair returned **zero** hits. Capacity = time standards × procedure counts | **CONFIRMED 3-0** (4 merged claims) | AARC *Safe and Effective Staffing Guide*; AARC *Best Practices in Productivity & Staffing* 2018 |
| **RTs are mobile bedside providers**, and treating several patients at once is explicitly *prohibited*: APEX standards require policy that "prohibits the routine delivery of care to multiple patients simultaneously"; doing so "no longer valid[ates]" the time standard because the RT "remains at the bedside of each patient throughout the patient's therapy" | **CONFIRMED 3-0** | AARC APEX Acute Care Standards; AARC 2018 |
| Observed ratios ≈ **5–6 ventilated patients per RT**, expressed as ratios and RT-hours/24h — never as rooms | **CONFIRMED 3-0** | Paranto et al., *Can J Respir Ther* 2016 (38 adult ICUs, 94% response); AARC HR survey |
| **Dialysis is the genuinely AREA-scaled department**: "The treatment area **may be an open area**"; each station ≥**80 sq ft**; ≥**4-ft** clearance between chairs; nurse station must visually observe **ALL** stations | **CONFIRMED 3-0** | California Building Code 2025 §1224.36.2 (CA adoption of FGI) |
| **Imaging capacity is the MACHINE**, measured as per-scanner serial time occupancy. Adding floor area adds nothing — you buy another scanner in another room. MRI process cycle **51 min/exam**, patient stay **84 min**; utilisation computed per scanner ("160 working hours for each of the two 1.5T scanners" → 77% / 85%) | **CONFIRMED 3-0** | Beker et al., *AJR* 2017;209(4) (n=305); Streit et al., *Eur J Radiol* 2021 (n=302) |
| **ORs / exam / procedure rooms are dimensioned for exactly ONE patient**: FGI's 20-ft minimum OR width is the sum of concentric clearance bands around a single 3'×7' gurney — 2'6"+3'+3'+3'+3'+3'+2'6" = **exactly 20'-0"**. Extra area buys workability, not concurrency | **CONFIRMED 2-1** *(medium — three sibling claims from the same deck were refuted)* | FGI clearance-zone diagram |
| ED per-station areas (80/120/100 sq ft), a 40 sq ft low-acuity station, 5 stations per 30-ft bay, fixture scaling | **REFUTED 0-3 / 1-2 across five claims** — the document is a **2018 proposal, not adopted code**. ED-as-open-bays is uncontroversial *in practice*, but **we have no verified numbers** | — |

**Do not launder the two weak rows.** The OR claim is 2-1, and the ED evidence
failed outright. Where this plan relies on either, it says so.

## 2. The model: three capacity units, one per department class

The game has **one** axis today — floor area → props → slots (`perProp`) — with
everything else forced into `single`. Reality has three:

| Unit | Departments | Player action | Game today |
|---|---|---|---|
| **AREA** — more floor in the same room = more concurrent patients | Dialysis, waiting, restroom, ER *(by practice; §1 evidence failed)* | Expand the room | ✅ correct, **do not touch** |
| **EQUIPMENT** — buy a machine, and it needs its own walled room | X-ray, CT, MRI, nuc med, **OR suite** | Expand the *department* | ❌ **this plan, §4** |
| **STAFF-HOURS** — no room capacity at all | Respiratory therapy | Hire a therapist | ❌ **this plan, §3** |

The `single` rule does not disappear — an OR and an X-ray room each genuinely
hold one patient (§1, FGI). What changes is that those rooms become **members
of a department** that scales, instead of isolated buildings.

## 3. Stage 1 - retire the respiratory therapy room

**Status: REVIEW-HARDENED v2.** Two independent pre-implementation reviews
(code/save: 5 MAJOR + 7 MINOR + 3 NIT; design/balance: 5 MAJOR + 2 MINOR +
1 NIT), both PROCEED WITH CHANGES. Owner re-ratified retirement 2026-07-19
**after** being shown the evidence is weaker than v1 claimed (SS3.0).

### 3.0 The honest state of the evidence (design review MAJOR 4)

v1 said the research showed RT "should not be a room". **It does not.** AARC's
document is a *staffing methodology*, and "a staffing guide contains no spatial
capacity unit" is a fact about that document, not about architecture - absence
of evidence, run against a source that was never about space. The reviewer also
names a counterexample the research never sought: **pulmonary function testing
is a genuinely room-based, appointment-scheduled RT service.**

What the research DOES establish, at 3-0: nebulizer and ventilator care are
delivered at the **bedside** by a mobile therapist, and treating several
patients at once is prohibited. That supports the **routing** change. It does
not, by itself, support removing the building.

**The owner was shown this and chose retirement anyway (2026-07-19).** Recorded
so no future reader mistakes it for a research conclusion: it is a game-design
decision - patients are not treated there under the new routing, so the room
has no purpose - taken with the evidentiary gap in full view.

### 3.1 The routing change

| Condition | Step | Was | Now | Why |
|---|---|---|---|---|
| Asthma | Nebulizer (45 min, $400) | `resp` | `exam` | The RT delivers the neb at the bedside |
| Pneumonia | Respiratory therapy (60 min, $500) | `resp` | `exam` | Same; its X-ray step is unchanged |

`roles: ['respTherapist']` unchanged, so `respTherapist` joins
`exam.staffedBy` (required by the `step.roles` subset-of `room.staffedBy`
invariant, `data.test.ts:37`).

**Host is `exam`, RULED - not left open.** The ER would take Wq from 10.6 to
**25 min** while already the busiest department and already carrying the SS5b
nurse-capture issue; and a third role inside a `staffRatio` room entangles with
the attention penalty and the anesthesia partial-gather hold.

**v1's "splitting by condition is legal and free" is DELETED - it is useless.**
Acuity is rolled per patient (`acuityMin/Max` 2-3) but `TreatmentStep.room` is
**static per condition**, so the game cannot route a severe asthma attack
differently from a mild one. Both reviewers caught this independently.

**Stage 1 RELOCATES the room constraint; it does not implement the staff-hours
model** (code review MINOR 8). The patient still occupies a `single` room for
45-60 min. Do not let SS1's research be read as implemented - the honest
staff-hours model is a later stage.

### 3.2 Balance - measured in weight x DURATION, not weight (both reviews, MAJOR)

v1's "25 of 148 arrival weight" used the wrong denominator. Contention is
arrivals x service time:

| Room | Weight-minutes |
|---|---|
| exam today | flu 30x30 + backInjury 8x30 + thyroid 6x25 = **1,290** |
| exam after | + asthma 15x45 + pneumonia 10x60 = **2,565 (+99%)** |
| er (post-B1) | **3,245** |

**But contention is NOT the risk.** Erlang-C at c=2: exam Wq **0.8 -> 4.4 min**,
an order of magnitude below the ER's 53-min 1-bay knee (`ED_PLAN` SS5). Exam
starts at rho 0.16 and lands at rho 0.33. The axis v1 worried about is fine.

**FOUR risks v1 missed, all of which must be owned:**

1. **Net capacity falls 33%** - the reference build is 2 exam + 1 resp = three
   `single` servers; delete resp and it is two. That is a server cut bundled
   invisibly into a "routing-only" change - exactly the confounding `ED_PLAN`
   SS5b split into arms. **The harness `resp` room becomes a THIRD EXAM ROOM**
   (`exam` and `resp` are both 3x3 minimum, so the rect is drop-in), and the
   probe reports **both arms**: 2 rooms (what a player who never rebuilds
   experiences) and 3 rooms (capacity-neutral).
2. **A $5,000 capex gate is deleted.** Serving 16.9% of arrival weight goes
   from requiring a $5,000 room to requiring nothing - `respTherapist`
   ($200/day) becomes an ~11.8x ROI hire with zero capital. **This is a balance
   change and is named as one**; SS6's profit/day column detects it.
3. **Room-capture - SS5b rotated 90 degrees.** `exam` is `single` with no
   ratio, so a 60-min RT session blocks the whole room from doctors, and a
   doctor's flu exam blocks the RT. SS6 must add **doctor-blocked-in-exam**
   counters. If it rises materially the remedy is a ratio on exam or a real
   bedside concept - not shipping and hoping.
4. **Both conditions are referral-grade** (`acuityMin: 2` <= `referralAcuityMax`),
   so their weights GROW with reputation (`caseMixShiftFactor: 0.5`). The load
   onto exam is not static; it increases all game.

### 3.3 The retire mechanism - v1's was not implementable

**v1 offered "a `retired: true` flag, or removal from `CATEGORY_LABELS`
routing". The second does not exist**: `CATEGORY_LABELS` is
`Record<RoomCategory, string>` keyed by CATEGORY (`buildMenu.ts:19`), so
removing a key would delete exam/er/dialysis/surgery from the build bar too,
and would not compile. And a flag in `src/ui/` breaks **hard rule 1**.

**Frozen:** `RETIRED_ROOMS: readonly RoomType[]` in `src/sim/data/rooms.ts`,
read through a `roomRetired()` accessor mirroring the existing
`roomFailure`/`roomStaffRatio` widening (`rooms.ts:413`). `buildMenu.ts:77`
filters on it.

**`world.buildRoom` stays PERMISSIVE** (code review MINOR 10): retirement is a
build-catalog concept only. `save.test.ts:331` and `maintenance.test.ts:44`
both build `resp` through the command path, and the v6 breakdown-rotation
premise depends on it. A sim-side gate would kill that coverage for no gain.

### 3.4 The guard that must NOT be disarmed (code review MAJOR 2)

`data.test.ts:50` asserts every room type is used by >=1 condition step or is
explicitly exempt. It goes red immediately - correctly. **Do not "fix" it by
adding `resp` to `CONDITION_STEP_EXEMPT_ROOMS`**, whose documented meaning is
*infrastructure* (check-in/waiting/atrium); that mislabels a treatment room and
permanently disarms the guard for it.

Amend to `used || EXEMPT.includes(t) || RETIRED.includes(t)`, and add two
assertions that make "retired" total:
1. **no condition step routes to a retired room** (the inverse guard);
2. **a retired room is absent from the build menu** (`buildMenu.dom.test.ts`) -
   the "cannot be labeled yet invisible" equivalent HANDOFF demands.

### 3.5 The safety net cannot see this stage's likeliest failure (MAJOR 4)

`harness.test.ts:259` applies the per-condition discharge floor to the eight
**expansion** conditions only. **`asthma` and `pneumonia` have NO floor.** Exam
contention could starve both to ZERO discharges - 25/148 of arrivals dying or
walking out - while `totalTreated > 30` and `totalDied < totalTreated/2` stay
green on the other twelve.

**Land the asthma/pneumonia discharge floor as a SEPARATE COMMIT FIRST, proven
green on the OLD routing.** It is this stage's regression of record, and it is
worthless if it lands in the same commit as the change it guards.

### 3.6 Live saves - retirement must not punish existing players

Confirmed by the code review: **no code re-derives the room from the step for a
live reservation.** `updateTreatment`/`resolveTreatmentOutcome` use
`reservation.roomId` for billing and `stepIndex` only for fee/label;
`promoteGatheredReservations` uses `roomId`; `validateReferences` never
cross-checks step->room. **In-flight reservations in a resp room survive
intact.** Repair jobs are room-id keyed and also survive.

**No SAVE_VERSION bump** - and the argument is the BACKWARD direction, not "no
shape change" (v10 bumped with no field added). Trace: a new-build save has a
reservation with `roomId` = exam and `stepIndex` = asthma step 0. An older
deployed build loads it, bills to `reservation.roomId`, never consults
`step.room`, and completes correctly. A *waiting* asthma patient simply routes
to `resp` in the old build, where `resp` is still in its menu -
self-consistent. **No silent corruption in either direction, unlike v9's role
addition and v10's shared `staffIds`.**

Three defects retirement WOULD introduce, each fixed:

1. **A broken retired room becomes a permanent unclearable urgent hint**
   (MAJOR 5): `computeBlockedNeeds` emits an always-urgent
   `broken:<id>:<since>` plus `role:maintenance` for a room that can never
   treat anyone, and `applyRoomUse` never fires on it again so it never
   self-clears. **Fix:** skip retired rooms in the broken scan and the
   maintenance count, and clear `brokenSince` + delete any queued repair job
   for retired rooms at restore. Regression test required.
2. **Income display vanishes** (MINOR 6): `roomEarns` is DERIVED from
   `CONDITION_DEFS`, so a retired room drops Income/Patients-seen from the
   inspect card and the directory column - for a room holding real accumulated
   `revenueTotal`. **Ruled: retired rooms KEEP their historical income
   display** (it explains where the money went). Pin the choice;
   `finance.test.ts:481` must drop `'resp'` from its pinned set.
3. **Silent devaluation of a $5,000 purchase in a DEPLOYED game.** The player
   paid $5,000; `roomSellbackRatio` is 0.5, so recovering the space costs them
   $2,500 for a developer decision. **Ruled:** (a) a one-time explicit message
   on loading a save containing a retired room - not a passive inspect line;
   (b) **full-price sellback for retired room types**, so the player is made
   whole; (c) the room stands, cosmetic, until they choose.

### 3.7 Remaining items

- `edLegibility.dom.test.ts:411` - the owner's "expanded resp, got nothing" bug
  regression - uses `resp` as its fixture. **Re-point to `xray` or
  `ultrasound`** (still-buildable `single` rooms with condition paths). Do not
  delete or weaken it.
- The `nebulizer` prop becomes unreachable. **Ruled: leave it.** Adding it to
  `exam.props` consumes a tile in a 3x3 minimum and perturbs quality and
  auto-placement.
- Build-menu / inspect "Run by" will read *"Doctor, Nurse, Respiratory
  Therapist"* for exam though an RT serves 2 of its 5 conditions (NIT 13).
  Accepted for v1.
- **No new `RoleId`, so NO fixed-seed re-pin sweep is required.** But treatment
  completions move to different ticks, so rng ORDER shifts downstream - budget
  for a possible harness re-pin, and note `resp` was a `mechanical`-failure
  room carrying 25/148 of traffic while `exam` has **no `failure` def**, so
  `harness.test.ts:254`'s organic-breakdown premise gets weaker (MINOR 11).
- **Verified clean, do not re-derive** (NIT 15): adding `respTherapist` to
  `exam.staffedBy` changes no behaviour. `standingPost` is false;
  `staffRatioFor` returns 1 for an absent key; `everySlotApproachable`
  early-returns on `single`; `capacityNeeds` is gated on `step.roles`, so a flu
  patient cannot produce a spurious "Every Respiratory Therapist is busy".
  **No third-role assumption exists anywhere in the code.**

### 3.8 MEASURED (2026-07-19, `ED_PROBE=1`, 5 seeds x 5 days)

| Arm | ER | exam | Disch | **Died** | Walkouts | Surg | **drBlockedExam** | Payroll/day | Profit/day |
|---|---|---|---|---|---|---|---|---|---|
| Before Stage 1 (resp room) | 53.0 | 36.6 | 120.6 | 3.6 | 43.0 | 7.2 | - | 3,060 | 12,709 |
| **Stage 1, 3 exam rooms** (capacity-neutral) | 44.8 | 62.8 | **120.2** | **3.4** | 43.2 | 8.6 | **27t** | 3,060 | 12,229 |
| **Stage 1, 2 exam rooms** (no rebuild) | 51.0 | 53.4 | 117.4 | 4.2 | 41.4 | 10.2 | **564t** | 3,060 | 12,897 |

`drBlockedExam` counts ticks where a doctor-needing patient waits, EVERY
non-closed non-broken exam room is full, AND at least one is held by a step
that does not need a doctor — i.e. genuine room-capture by another role, not
ordinary doctor-on-doctor congestion. (The first cut of this counter could not
tell those apart and read 679t; corrected per post-impl review MINOR 4.)

**The honest read:**

1. **Capacity-neutral, the change is a wash** - discharges 120.6 -> 120.2 and
   deaths 3.6 -> 3.4, both inside seed noise. Exam absorbs the traffic
   (36.6 -> 62.8 visits) without the queueing damage SS3.2's Erlang predicted
   would not happen. The routing change is safe *when the player has the
   servers*.
2. **The two-arm split earned its keep, and room-capture is REAL.**
   Doctor-blocked-in-exam is **27 ticks with three rooms and 564 with two - a
   20x difference**, plus 3 fewer discharges, 0.8 more deaths, and pneumonia
   deaths rising 2 -> 5. This is SS3.2 risk 3 (SS5b rotated onto the room axis)
   measured rather than assumed. **A player who never rebuilds pays for this
   change**, which is exactly why the capacity hints must name the room.
3. **The $5,000 capex deletion did NOT show up as a windfall** - profit/day is
   flat to slightly down across arms. Do not read that as safety: capex is a
   ONE-TIME cost and a 5-day probe cannot see it. The finding stands as a
   design risk (SS3.2 risk 2); it needs a longer horizon or a capital-outlay
   metric to measure properly.
4. **Payroll is identical across arms** (3,060/day) - the roster never
   changed, which is what makes the profit comparison meaningful and confirms
   the capex finding above is about CAPITAL, not wages.
5. Surgeries recovered (7.2 -> 8.6, and 10.2 in the 2-room arm) - the exam
   rooms host RT work that used to have its own room, so the nurse pool is
   less contended. A small mitigation of `ED_PLAN` SS5b, not a fix.

**Not re-pinned:** no new `RoleId`, so no fixed-seed candidate sweep was
needed (SS3.7). Treatment completions do move to different ticks, but the
fixed-seed suites assert properties rather than rng values and stayed green.

## 4. Stage 2 — the department model (the owner's ask)

A **department** is a group of ordinary `Room`s of one type, rendered and
inspected as one block. Expanding the department stamps another **suite** —
a min-size walled room with its own door and its own machine.

**Applies to** (§1, equipment-scaled + the OR): `xray`, `ct`, `mri`, `nucMed`,
`surgery`. **Does NOT apply to** `dialysis`, `waiting`, `restroom`, `er` —
those are area-scaled open floors and are already correct.

### 4.1 Implementation shape — reuse Rooms, do NOT invent internal walls

Two paths; the plan picks the cheap one deliberately.

- **REJECTED — internal wall edges inside one rect.** The edge-wall model
  ("footprint tiles stay walkable; walls live on boundary edges, crossed only
  at the door") is one of the five load-bearing architectural sentences, and
  pathfinding, build validation and rendering all depend on it. Partitions
  inside a rect touch all three. Very large blast radius.
- **CHOSEN — a department is a SET of ordinary Rooms.** Each suite is a normal
  `Room` with its own rect, door, props and `capacity: 'single'`. **Every
  existing wall, door, A*, reservation, capacity, breakdown and sell path is
  reused unchanged.** The genuinely new work is: the grouping, one inspect
  card for the group, an "expand department" gesture that auto-places the next
  suite adjacent, and rendering that reads as one block rather than N
  buildings.

**The dispatcher already handles this** — `roomsOfType` returns every room of
a type, and the reference build already runs two exam rooms. So concurrency
across suites needs **no dispatcher change at all**; this is a build-gesture
and presentation epic sitting on machinery that already works.

### 4.2 Open questions the review must settle

1. **Is `departmentId` new saved state, or derived from adjacency?** Derived
   is tempting (no save change) but fragile — selling a middle suite would
   silently split a department. A stored id is honest and costs a
   SAVE_VERSION bump. Note plan rule 6: a World-level mutable field needs a
   deliberate save decision.
2. **Auto-placement.** Where does the next suite go, deterministically, and
   what happens when there is no room to grow into? The `growExpandRect` /
   `minRectAt` precedent in `render/placement.ts` is the model.
3. **Does each suite need its own door to a corridor**, or may suites open
   into a shared internal circulation space? The latter is more realistic and
   much harder (it is a room-within-a-room). **Recommend: own door, v1.**
4. **Sell semantics.** Sell one suite or the whole department? What happens to
   a department whose suites are no longer contiguous?
5. **Does the OR suite ship with radiology, or after it?** Radiology is 4 room
   types and the cleanest case; surgery has the three-role gather and the
   anesthesia machinery layered on it.

## 5. Economy — the guardrail that must not be skipped

`ED_PLAN` §5 learned this the expensive way: a density change can **delete the
pressure entirely** (Erlang: 1 bay → ~53 min queue, 2 bays → ~9 min, 4 bays →
~1 min). The same risk applies here.

**Each suite must cost a full room's price**, because §1 says the machine is
what you are actually buying. `formulas.priceOf` is area-based, so a suite
priced as its own rect falls out of the existing curve with **zero new balance
numbers** — the Stage-0 pricing precedent. Sellback likewise.

**The staff constraint must NOT scale with suites.** Two rad techs already
serve four scanners, and `ED_PLAN` §7.5 calls that "an accidental model" of
the real shared-resource bottleneck worth leaning into. A department that adds
machines without adding techs is exactly the movable bottleneck (§7.2) — the
player must diagnose whether they need a machine or a technician. **This is
the strongest design argument for the whole epic** and it should be stated as
an intent, then measured.

## 6. Measurement protocol

`test/edProbe.test.ts` is the instrument (`ED_PROBE=1`). Per stage, 5 seeds ×
5 days, recorded in this document — **a stage that moves capacity without
reporting its outcome cost is not finished** (`ED_PLAN` §6).

Required columns: per-room visits, discharged, **died**, walkouts, and — the
lesson from B1 — **payroll, profit/day, and the per-role blocked counters**,
because outcome averages alone cannot detect a deleted brake or a starved
department. Stage 1 additionally needs **exam-room contention** (it absorbs 25
of 148 arrival weight) and Stage 2 needs **radTech utilisation** (the intended
new bottleneck).

## 7. Sequencing

1. **Stage 1 — respiratory therapy** (data change + the retire decision).
   Small, self-contained, and it settles an owner question already decided.
2. **Stage 2a — radiology departments** (4 room types, no role complications).
3. **Stage 2b — the OR suite** (after 2a proves the pattern).

Each stage: plan → pre-implementation review → implement → measure → adversarial
review → fix all findings + a regression per finding → gates → commit.

## 8. Explicitly NOT in this epic

- Rebalancing the `single`/`perProp` split for exam, triage, reception — §1
  confirms exam rooms are one-patient-per-room, and the "2–3 rooms per
  provider" pipelining effect is a **different** mechanic (rooms as a buffer
  for one provider), worth its own plan.
- Anything from `ED_PLAN` §3b (Stage B2, the ED front door) or §4 (Stage C).
- The `ED_PLAN` §5b item 5 nurse-capture issue. It is still open and still
  unremedied; this epic must not be used as cover for it.
