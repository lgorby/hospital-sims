# The Observation Unit — an EDOU department

**Status:** CONTRACT DRAFT (2026-07-19, owner ask). Awaiting 2 independent
adversarial pre-implementation reviews. **No code until findings are folded in.**
**Owner ask:** *"add an observation area option to purchase for things like
chest pains, strokes, headaches… expandable… expanded with the increase in
beds, so the area is a department that will have rooms in it like the ER and
OR. Of course that is after they come back from radiology."*
**Owner decision 2026-07-19:** the ED is the hub for walk-ins —
`triage → er → imaging → observation → discharge`.
**Save impact:** **SAVE_VERSION 11 → 12.** Owed and justified — see §7.

---

## 1. Why this exists, and what it fixes

Three open problems collapse into this one feature.

1. **`IMAGING_PLAN` §2.2 — the chain inversion.** Every imaging chain runs
   `imaging → er`; reality is that the ED *orders* imaging mid-stay. Observation
   gives the corrected chain somewhere to terminate.
2. **`IMAGING_4B` review MAJOR 3 — the decay-exposure defect.** The reason the
   §4B contract came back NOT READY: `er → xray` converts health-PAUSED minutes
   into decay-exposed wait-and-gather minutes for acuity-1 patients.
   `decay.ts:20-25` pauses health decay during any **active** reservation, so an
   observation bed is a place a fragile patient waits *safely*. This is the
   defect's actual fix, not a patch over it.
3. **Radiology is empty** (`IMAGING_PLAN` §1; re-measured 2026-07-19: X-ray
   8.1%). §4 below is the research finding that matters most here, and it is a
   larger imaging lever than §4B was.

It also adds a capacity axis the game barely has. The Departments research found
reality has three — AREA-scaled, EQUIPMENT-scaled, STAFF-HOUR-scaled — and the
game has essentially one. Observation is **bed-scaled**, which today only
dialysis is.

## 2. The research (sources in §11; confidence markers are the harness's)

Method: fan-out search → source fetch → adversarial self-check, with an explicit
"what I could not establish" section. §10 carries the unverified items forward
rather than laundering them.

### 2.1 The owner's condition list scores 2 of 3 — HIGH confidence

| owner named | verdict |
|---|---|
| **chest pain** | **CORRECT, and genuinely #1.** *"The most common OU protocol across all sites is chest pain"* — two independent sources. |
| **head injury** | **CORRECT.** Named a top-4 protocol; "traumatic brain injury" in a 2025 review. |
| **stroke** | **MOSTLY WRONG — and this matters.** What goes to observation is **TIA / transient neurological events**, not acute stroke. Acute stroke needs thrombolysis and an inpatient stroke unit. In the game, `stroke` is acuity **1**, the most time-critical condition there is — routing it to a 15-hour monitoring bed would be clinically backwards AND would park the game's most fragile patient for most of a day. |
| **headache** | **COULD NOT VERIFY.** Plausible, but no fetched source lists it as a standard protocol. Not included; see §10. |

Canonical list, for future expansion: chest pain · syncope · TIA · abdominal
pain · asthma · head injury · atrial fibrillation · cellulitis · dehydration ·
hyperglycemia · mild heart failure · sickle cell crisis.

### 2.2 Length of stay — HIGH confidence, and the "23-hour rule" is folklore

**No CMS document establishes a 23-hour threshold.** It is a billing artifact
from when ≥24h of hospitalisation meant inpatient status. The governing rule
since 2013 is the **Two-Midnight Rule**. CMS language is *"generally do not
exceed 24 hours."*

Measured LOS: **12.9 h** (US EDOU sites), 14–15 h (2025 review), ~15 h (ACEP
benchmark). **Design number: ~15 h mean, 24 h cap. Not 23.**

Turnover: **1.6 patients/bed/day.**

### 2.3 Disposition — HIGH confidence, tight convergence

**75–85% discharged, 15–25% escalated to inpatient.** US sites: 84.3%
discharged. This is a game mechanic, not a detail — see §5.4.

### 2.4 Staffing — HIGH confidence, and it directly supports the mechanic

**1 RN : 5–8 beds**, consistent across US and Asian sites; design literature
independently gives 1:5. For comparison: ICU 1:2, ED 1:3–1:4 (Cal. Title 22
caps at 1:4 — the number already in `ROOM_DEFS.er`), med-surg 1:4–1:6.

**Observation is the LOWEST nursing intensity of any monitored bed in the
hospital.** One nurse covering 5–6 beds is accurate, defensible, and exactly
the `staffRatio` shape the ER already established.

Physician side: EDOUs run on **APPs with ED-physician supervision**, not a
dedicated attending — and units staffed attending-only measured *worse*
throughput. The game has no APP role; §9 Q4 asks whether to add one or to model
observation as nurse-only.

### 2.5 Sizing — HIGH confidence

**"OU volume should approximate 4% to 10% of annual ED visits."** US EDOU
average **17 beds**; typical range 10–40. Only **39% of US EDs have one** —
natural justification for an opt-in purchase rather than a starting room.

FGI (via secondary reporting, see §10): **120–140 sq ft per bed**, 4-ft
clearance each side, one toilet per six patients, ~10 rooms per clinical
workstation, visibility from the station the top design priority.

### 2.6 The financial case — HIGH confidence, and it is the right tycoon shape

- **$1,572 saved per patient**; $4.6M/hospital/year; $3.1B nationally (Baugh,
  *Health Affairs* 2012), by avoiding ~2.4M admissions/year.
- Protocol-driven dedicated units vs scattered observation: **23–38% shorter
  LOS, 17–44% lower subsequent admission** (Ross, *Health Affairs* 2013).
- **The caveat that makes it a game decision:** *"High upfront costs often
  outweigh eventual savings."* Expensive to build, pays back through throughput
  rather than directly.

## 3. THE FINDING THAT CHANGES THE DESIGN — imaging happens DURING observation

**The owner's premise — "after they come back from radiology" — is half right,
and the half it omits is the more valuable one.**

Real chest-pain sequence, HIGH confidence:

1. **ED:** ECG + first troponin + **plain chest X-ray**. Low-risk-but-not-clear
   patients go to observation.
2. **Observation:** the **advanced** imaging is ordered *during* the stay —
   CCTA, stress echo, nuclear perfusion. Directly verified: *"CCTA occurs
   during the observation stay, not before admission."*
3. **Disposition** follows that result: discharge, or escalate.

So the real shape is:

> **ER → basic imaging → OBSERVATION → advanced imaging → discharge-or-admit**

**Observation is a CONSUMER of the imaging department, not a parking lot
downstream of it.** It pulls patients *back* to imaging mid-stay — a circular
flow rather than a linear one.

This is why observation is a bigger imaging lever than §4B was. §4B added ~2.2
X-ray visits/day. An observation unit that orders advanced imaging adds demand
for **CT, nuclear medicine and ultrasound** — the modalities sitting at 4.9%,
13.5% and 3.9%, and the ones `IMAGING_PLAN` §2.3 said an ED-only hospital could
never fill. It also lands that demand on patients who are *safely parked*, not
decaying in a queue.

**Scope ruling: Stage 1 does NOT build the return leg.** It is the prize, but a
chain that goes `er → xray → observation → ct → discharge` is a 4-step chain
against a game whose longest is 2, and `DEPARTMENTS_PLAN` §3.1 warns that every
added step is another gather, another walk, another contention point. Stage 1
establishes the bed and the terminal step; **Stage 2 adds the return leg and
measures it against Stage 1's baseline.** §9 Q1 asks a reviewer to challenge
this split.

## 4. The room

```
observation: {
  label: 'Observation Unit',
  kind: 'treatment',
  category: 'treatment',          // appears in the build bar automatically
  minCols: 4, minRows: 4,
  cost: 14_000,                   // see §6 — the most expensive room in the game
  floorColor: <pale blue-grey>,
  staffedBy: ['nurse'],
  staffRatio: { nurse: 5 },       // §2.4: 1 RN : 5-8 beds, MEASURED
  capacity: { kind: 'perProp', prop: 'bed', noun: 'Beds' },
  props: [{ id: 'bed', walkable: false,
            density: { kind: 'perTiles', tilesPerProp: 8, min: 2 } }],
}
```

- **`perProp` capacity is the whole point** — beds ARE capacity, derived from
  placed prop tiles (`world.ts:406-418`), so expanding the room adds beds. This
  is the owner's "expanded with the increase in beds," and it is data-derived:
  no expansion code changes.
- **Reuse the existing `bed` prop.** A new `PropId` requires a `PROP_STYLE`
  entry or the renderer crashes on a non-null assertion (`renderer.ts:484`).
  Reusing `bed` means **zero render-side work**.
- **`tilesPerProp: 8`** — deliberately sparser than the ER's 6, reflecting §2.5's
  120–140 sq ft + 4-ft clearance. `min: 2` satisfies CAPACITY_PLAN §3.2 (a
  min-size room must derive exactly its intended count: 4×4=16, 16/8 = 2 ✓).
- **No `failure` entry.** A ward of beds has no machine to break. This also
  keeps it off the single maintenance tech's queue.

**Not a new `RoomCategory`.** `treatment` is correct and needs no union change.

## 5. The four mechanics questions, answered

### 5.1 Staff hold — the ratio is doing real work

`makeReservation` binds a staffer for the **whole** reservation
(`dispatcher.ts:445-449`); there is no attend-then-leave concept. A long
observation step at ratio 1 would remove a nurse from the hospital for the
entire stay.

`staffRatio: { nurse: 5 }` is what makes this affordable, and §2.4 says it is
also what is *true*. But it walks straight into the **anti-capture guard**
(`dispatcher.ts:186-207`), whose comment is a warning written from measurement:

> *"a ratio staffer never returns to `idle` while any bay is live… the
> characterization suite measured 0 idle ticks, triage never firing in 1,200
> ticks, and a patient dying untriaged at 4,000."*

A long hold makes that near-permanent. **Mandatory before ship: verify
`starvedOutside` actually fires for `observation`** (`dispatcher.ts:238-247`),
and measure nurse idle-time and triage-start rate on both layout arms. If the
guard does not fire here, observation eats the nurse pool exactly as ED Stage B1
measured. §8 regression 4 pins it.

### 5.2 Duration — reality is 15 h; the game cannot have 15 h

The game's longest step today is stroke's 120-minute ER stay. A literal 15
game-hours (900 min) would be **7.5× the longest existing step** and ~62% of a
game day — one patient would occupy a bed for most of a day at 1.6 turns/bed/day.

The game already compresses: real chest-pain ED stays run hours against the
game's 90 minutes. **Observation must compress by the same factor, not be
imported literally.** Proposed: **240 game-minutes** (4 h), which is
2.7× chest pain's current ER step and preserves the *relationship* — observation
is much longer than treatment — without deleting a bed for a day.

**This is the number most likely to be wrong.** It is a game-feel judgement, not
a research finding, and §8 regression 5 makes it falsifiable via bed turnover.

### 5.3 Bladder and thirst keep draining

`decay.ts:52-58` drains both in every non-terminal stage, so a bedbound patient
on a 240-minute step will hit a bladder accident — patience hit plus a mess, in
the bed. `patientNeeds.ts:23` notes a reserved patient will not break a
gathering. **Decide deliberately** (§9 Q3): pause bladder during an active
observation reservation (defensible — obs beds have call bells and bedpans;
FGI mandates one toilet per six patients), or accept accidents as flavour and
let EVS earn its keep. This contract proposes **pausing bladder only, not
thirst** — but it is a real fork.

### 5.4 Escalation — 15–25% do NOT go home

§2.3 says 75–85% discharge. The game's chain model has exactly one terminal:
`stepIndex >= steps.length → dischargePatient` (`treatment.ts:75-79`). There is
no "escalate to inpatient" concept, and the complication path
(`treatment.ts:89-107`) re-queues the *same* step rather than branching.

**Stage 1 ships 100% discharge and says so.** Branching outcomes are a genuinely
new sim capability (a conditional chain), and bolting it onto this stage would
make an already-large epic unreviewable. Recorded as the Stage 3 prize: it is
the mechanic that would make observation a *decision* ("did I rule out, or did I
just delay?") rather than a slower discharge. §9 Q2.

## 6. Balance — and the anti-pattern the research warns about

| | value | basis |
|---|---|---|
| cost | **$14,000** | §2.6's "high upfront costs often outweigh eventual savings" — it must be the most expensive room in the game (ER is $10,000) and must not pay back immediately |
| beds at min size | 2 | §4 density |
| duration | 240 game-min | §5.2, compressed |
| fee | **$400** | low per-bed-hour: observation is cheap monitoring, and its payback is THROUGHPUT (fewer deaths/walkouts, more completed chains), not the fee |
| staffRatio | nurse: 5 | §2.4, measured |

**Chain change (Stage 1):** `chestPain` becomes
`er (70min/$1,000) → observation (240min/$400)`, and `headInjury` becomes
`ct → er → observation`. **`stroke` is NOT routed to observation** (§2.1).

**The design prize the research hands us — and it is a better mechanic than a
number.** §8 point 4: protocol-driven units with strict exclusion criteria
dramatically outperform "put anyone in there" units; multi-diagnosis units
showed *no significant LOS benefit or a slight increase*. **An observation unit
that accepts everything should perform WORSE than a focused one.** That is a
real tycoon decision and it falls naturally out of routing only the researched
conditions there. Recorded for Stage 3; not built in Stage 1.

### 6.1 Falsification — calibrated against the MEASURED noise floor

The `IMAGING_4B` review's MAJOR 8 killed that contract's thresholds because they
were asserted, not calibrated. The baseline commit (`8ec700d`) now supplies real
per-seed spreads, so this set is built from them:

| metric | baseline (REFERENCE / COMPACT) | per-seed spread | usable? |
|---|---|---|---|
| deaths/day | 0.20 / 0.20 | **0.0–0.6** | **NO at 5 seeds** — a 10% threshold is 30× smaller than its own noise |
| elective completion | 98.5% / 99.4% | tight | **YES** — near-saturated, a drop has room to mean something |
| chestPain discharged | 7.0 / 10.8 | 3.0–11.0 | **weak** — 3.7× spread on REFERENCE |
| radTech ACTIVE-only | 21.7% / 23.7% | 19.5–27.4 | **YES** |
| xray utilisation | 8.1% / 9.3% | 4.7–13.5 | **weak on COMPACT** |

**REVERT if, on either arm:**
1. **triage starts fall >15%** or **nurse idle-time falls below 10%** — the §5.1
   nurse-capture failure, the single most likely way this feature does harm.
   Nurse utilisation is 62.3% today, the highest of any role.
2. **elective completion drops >15%** from 98.5% — the one tight falsifier.
3. **chestPain discharged/arrived falls** below its 61% (REFERENCE) / 79%
   (COMPACT) baseline — the §3.2-risk-1 discharge floor, now pinned in
   `harness.test.ts` on the pre-change build.
4. **fracture or pneumonia discharges fall** — X-ray/room preemption.

**Deaths are NOT in the revert set at 5 seeds, and that is stated deliberately
rather than papered over.** To use deaths, raise the seed count until the
spread is smaller than the effect being claimed. §9 Q5.

**Success bar** (the `IMAGING_4B` review's MAJOR 8c — that contract had revert
conditions and no success criterion): chestPain discharged/arrived rises on both
arms, with no regression in (1)–(4). If observation does not improve the
survival of the patients it exists to serve, it is decoration.

## 7. Save impact — SAVE_VERSION 12, and this one is genuinely owed

`save.ts:917` validates room type with `asOneOf(o.type, ROOM_TYPES)`. A save
containing an `observation` room, opened by an older DEPLOYED build (Vercel
auto-deploys; a cached tab suffices), dies on a confusing shape error instead of
the clean *"newer than this game understands"* refusal.

**That is exactly the concrete old-build failure every recent bump is justified
by** — v8→v9 for roles (`asOneOf(o.role, ROLE_IDS)`), v10→v11 for condition ids
(`asOneOf(o.condition, CONDITION_IDS)`), both at `save.ts:99-135`. Unlike the
per-patient thought ring — where the reader silently drops unknown keys and no
bump was owed — this one cannot be avoided.

**No field shape changes and no `readRoom` migration**: capacity is derived from
the grid, not stored. The bump is owed to new CONTENT, exactly as v11's was.

> **Doc defect found while verifying this: `HANDOFF.md:316` states "new room
> type is fine, but a staff meter is new saved state ⇒ SAVE_VERSION bump."**
> That is **wrong** under the policy written into `save.ts:99-135` and would
> mislead the next session into shipping a save-breaking change. Fix it in the
> same commit.

## 8. Regressions required

1. **Room shape** — `observation` derives exactly 2 beds at min size (4×4) and
   more when expanded. Pins §4's density arithmetic. Add to
   `capacity.test.ts:60-92` beside the existing min-size pins.
2. **Chain terminal** — a chestPain patient in a world with `er` + `observation`
   reaches `discharged` with the full fee, and the observation reservation holds
   its bed for the whole step.
3. **Health is paused in the bed** — a patient on an active observation
   reservation loses NO health over the step. This is the §1-point-2 claim, the
   entire reason the feature fixes the §4B defect; it must not silently regress.
4. **Anti-capture fires for observation** — with the ward occupied and triage
   starved, a ratio nurse is refused extension (`dispatcher.ts:201-203`).
   The §5.1 risk, pinned.
5. **Bed turnover** — beds turn over at a rate consistent with §5.2's
   compression; falsifies a duration that silently deletes a bed for a day.
6. **v11 → v12 back-compat** — a v11 save loads. Use the REAL downgrade helper
   (`save.test.ts:840-860`, which DELETES fields), not the version-stamp tamper
   lines at `:534/544/552` — that mistake made a regression vacuous in the
   thoughts contract and it must not be repeated.
7. **Coverage guards pass** — `data.test.ts:55-83` (every room type used by ≥1
   condition step: satisfied by the chain change, and would FAIL without it),
   `expansion1.test.ts:70-118` prop-fit, `buildMenu.dom.test.ts:108-130`
   totality, `edRatio.test.ts:138-151` staffRatio ⊆ staffedBy.

## 9. Open questions a reviewer must settle

1. **Is the Stage-1/Stage-2 split right?** §3 defers the return-to-imaging leg —
   the research's most valuable finding and the biggest imaging lever. Is
   shipping a terminal-only observation unit first genuinely safer, or does it
   ship a chain we immediately rewrite (the exact mistake §4B made)?
2. **Is 100% discharge acceptable for Stage 1** (§5.4), when §2.3 says 15–25%
   escalate? Does a unit where everyone goes home misteach the mechanic?
3. **Bladder during observation** (§5.3) — pause, or accidents in beds?
4. **Nurse-only, or add an APP role?** §2.4 says EDOUs are APP-led and
   attending-only staffing measured worse. A new `RoleId` is a save-affecting
   change of its own (`asOneOf(o.role, ROLE_IDS)`) — but the bump is already
   being spent. Is this the moment to add it, or scope creep?
5. **Is 5 seeds enough?** §6.1 shows deaths are unusable at 5. Raise the count,
   change the metric, or accept the blind spot — but choose explicitly.
6. **The expandability trap.** `build.ts:248-250` rejects expansion while ANY
   reservation is live. With long occupancy an observation ward is almost never
   expandable without the close/drain gesture — and the drain takes a full step.
   Is that acceptable friction for a room whose selling point is "add more
   beds," or does it need a remedy?
7. **Does `maxOccupants` hold?** `expansion1.test.ts:60-69` derives it from
   `max(step.roles.length) + 1`, i.e. one crew plus one patient. A 4-bed ward
   holds 4 patients plus a nurse; the standing-room assertion may not cover it.
8. **Is $14,000 / $400 the right shape**, given §2.6 says payback is indirect?

## 10. What the research could NOT establish — carried, not laundered

1. **Headache as a standard EDOU protocol — UNVERIFIED.** The owner named it; no
   fetched source lists it. Head *injury* is well-attested. Not included.
2. **Exact condition-mix percentages — UNVERIFIED.** The Emory CDU figures came
   from a search extraction of a PDF the harness could not open. Ordering
   probably right, decimals unverified.
3. **Chest pain's share of obs volume — NOT FOUND.** Every source says #1; none
   gave a percentage. Any "30–50%" is inference.
4. **ACEP chest-pain protocol details** (0/6h troponins, 8–24h window) are
   second-hand via search summary, not a direct read.
5. **FGI section numbers — NOT FOUND.** The 120–140 sq ft / 4-ft clearance /
   1-toilet-per-6 figures come from HFM reporting *about* FGI, not the code.
6. **Median (vs mean) LOS — NOT ESTABLISHED.** All good figures are means; the
   distribution is right-skewed, so the median is probably lower.
7. **Nurse ratio is convention, not law.** No US state mandates an
   observation-specific ratio.

## 11. Sources

- Baugh et al., *Health Affairs* 2012 — observation unit cost savings
- Ross et al., *Health Affairs* 2013 — protocol-driven vs scattered observation
- PMC3922480 — multi-site EDOU operational characteristics (LOS, ratios, 84.3%
  discharge, 4–10% sizing rule)
- PMC8967459 — NHAMCS; 39% of US EDs have a unit
- PMC12194427 — 2025 narrative review; multi-diagnosis units underperform
- PMC11291183 — CCTA occurs DURING the observation stay (§3)
- CMS Two-Midnight Rule; Medicare Claims Processing Manual Ch.12 §30.6.8
- SAEM EDOU toolkit; ACEP chest-pain protocol; AAEM ED staffing ratios
- FGI Guidelines via HFM Magazine design reporting
