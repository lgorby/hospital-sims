# The Departments epic — three capacity units, not one (plan v1, DRAFT)

**Status: DRAFT — awaiting pre-implementation adversarial review. No code.**

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

## 3. Stage 1 — respiratory therapy: the room that should not exist

**Owner-decided (2026-07-19), and the research is unambiguous.** Patients are
not seen in a respiratory therapy room; the therapist comes to them.

**The change follows Stage A's principle exactly — change the ROOM of existing
steps, never lengthen chains** (`ED_PLAN` §2), which is the cheapest possible
intervention and isolates the variable:

| Condition | Step | Was | Proposed | Why |
|---|---|---|---|---|
| Asthma | Nebulizer (45 min) | `resp` | `exam` | An RT delivers the neb at the patient's bedside |
| Pneumonia | Respiratory therapy (60 min) | `resp` | `exam` | Same; the X-ray step ahead of it is unchanged |

`roles: ['respTherapist']` is **unchanged**, so the therapist is still the
binding resource — which is exactly the research's point. `respTherapist` must
join `exam.staffedBy` (and any other host room) or the `data.test.ts`
structural invariant (`step.roles ⊆ room.staffedBy`) fails.

**Open: which host room?** `exam` is the conservative choice (both conditions
are acuity 2–3). `er` is arguably right for a severe asthma attack. The review
should rule; splitting by condition is legal and free.

### 3.1 THE BLAST RADIUS — deleting a RoomType can brick live saves

**This is the plan's single biggest risk and it must be solved before any
code.** `save.ts:900` validates with `asOneOf(o.type, ROOM_TYPES, ...)`, and
`RoomType = keyof typeof ROOM_DEFS`. **Removing `resp` from `ROOM_DEFS` makes
every existing save containing a Respiratory Therapy room refuse to load** —
and the game is DEPLOYED (auto-deploy on push to `master`), so real player
saves are in real browsers. That is the save-bricking class HANDOFF already
records ("a tunable must not brick saves").

Three candidate strategies, for the review to choose between:

- **(a) Retire, don't delete.** `resp` stays in `ROOM_DEFS` and stays loadable,
  but leaves the build menu (a `retired: true` flag, or removal from
  `CATEGORY_LABELS` routing). No condition routes to it. Existing rooms remain
  standing, sellable, and cosmetic. **Cheapest and safest; zero migration.**
  Cost: a dead room type in the data table forever, and a player with one
  wondering why it never fills — needs an inspect-card line saying so.
- **(b) Migrate on load.** v10 `resp` rooms convert to `exam`. Risky: different
  `minCols/minRows` (both 3×3 — compatible), different props (nebulizer vs
  bed), different `failure` kind. A conversion that fails validation on a real
  save is the same brick by another route.
- **(c) Refund on load.** Convert the room to cash at sellback value and clear
  the tiles. Honest and simple, but silently demolishes something the player
  built — likely the worst player experience of the three.

**Recommendation: (a).** It is the only one that cannot brick a save, and the
`isLoadableVersion` policy stays untouched.

### 3.2 Also in scope for Stage 1

- The **harness reference build** contains a `resp` room and `respTherapist`
  in `STANDARD_STAFF`. Both must be re-pointed, and the 5-seed probe re-run —
  asthma (weight 15) and pneumonia (weight 10) are **25 of 148 arrival
  weight**, so this is a real load shift onto `exam`, which currently sits at
  ~37 visits against the ER's ~53. **This will move the numbers and might
  re-create a bottleneck; it must be MEASURED, not assumed** (`ED_PLAN` §6).
- 7 test files reference `'resp'`.

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
