# The Observation Unit — an EDOU department

**Status:** CONTRACT DRAFT v2 (2026-07-19). Rewritten around the v1 review
findings (12 + 13 findings, both reviewers NOT READY). Awaiting a fresh pair of
adversarial pre-implementation reviews. **No code until findings are folded in.**
**Owner ask:** *"add an observation area option to purchase for things like
chest pains, strokes, headaches… expandable… a department that will have rooms
in it like the ER and OR. Of course that is after they come back from
radiology."* Plus: *"outpatients should be sent from triage to the ER for things
like this, just like in a hospital setting"* and nurse techs with a
**6–9 patient load** to staff it.
**Owner decisions folded in:** ED is the hub for walk-ins; nurse tech is a role
distinct from EVS; keep chest pains (do NOT touch the chestPain chain).
**Save impact:** **SAVE_VERSION 11 → 12**, owed three times over — see §7.

---

## 0. What changed from v1, and why

v1 tried to route `chestPain` and `headInjury` THROUGH a new observation bed by
lengthening their chains. Both reviewers killed it, converging on one better
design. This rewrite adopts it wholesale:

| v1 (NOT READY) | v2 (this doc) |
|---|---|
| Lengthen `chestPain` (1→2 steps) and `headInjury` (2→3) | **Two NATIVE conditions, `tia` + `syncope`**, that only exist because the room exists |
| Stranded chestPain in every save with no obs room (MAJOR 1) | **Room-gated**: no observation → these patients never spawn. Zero stranding. |
| "observation fixes the decay defect" — INVERTED (MAJOR 2): it added a decay-exposed queue before the bed | Native conditions arrive AT the ED and flow to the bed; nothing existing is re-routed |
| Nurse-only ward starved the 3-nurse pool → `appendicitis` discharged 0 (proven) | **Nurse-tech staffed** — a new role, zero competition with the nurse pool |
| `tilesPerProp: 8` → half of all expansions added zero beds | **`tilesPerProp: 6`** — every column of growth adds a bed |
| Confounded measurement (routing + service-time + revenue all at once) | Clean by construction: the "before" arm simply has neither condition |
| Overrode the owner's stroke ask with a flat "no" | Honours it with the research's own answer — **TIA**, not acute stroke |

The v1 doc's research (§2) and its honesty ledger (§10) survive intact; only the
design built on top of them is replaced.

## 0.1 v2 REVIEW OUTCOME (2026-07-19) — NOT READY; the v3 spine

Two fresh reviews. **Design: NOT READY. Code: READY WITH FIXES** ("the v2 design
is sound and the architecture claims mostly hold"). They converge on one fix.

**The disqualifying finding (design MAJOR 1), verified against `spawn.ts:76-85`:**
the arrival rate is a FIXED Bernoulli per tick, independent of `conditionWeights`
— the weights only pick WHICH condition each arrival becomes. So putting
`tia`/`syncope` in `conditionWeights` does NOT add patients; it **redistributes a
fixed budget**, dropping every existing condition's arrivals by 148/162 = 8.6%
the moment the room is built. This falsifies "net-new revenue" (§1, §6),
reintroduces the measurement confound §3.2 claimed to eliminate, and confounds
two of four revert guards. The outpatient stream is genuinely net-new precisely
because it is a SEPARATE Bernoulli channel (`spawn.ts:99-110`) — this contract
cited that precedent but copied only the gating, not the separate rate.

**THE v3 SPINE — both reviewers point here:**
1. **Model observation as a separate gated arrival channel** with its own
   `perGameHour`, like the outpatient stream — genuinely net-new, cleanly
   measurable, still triaged as ED walk-ins. This also dissolves the code
   review's gate-mechanism MAJOR (no filter-in-the-emergency-roll, no
   float-residue trap) and means tia/syncope are not in the emergency weight mix
   at all.
2. **MEASURE the balance before asserting it.** Design MAJORs 2/3/4: at the v2
   weights, base occupancy is ~33% (fails the plan's own 40% success floor),
   max-rep ~70% on 2 beds (never saturates), and one $100 tech at ratio 6 covers
   the ward forever — **neither capacity lever ever binds.** The §6.2 saturation
   figure double-counted the case-mix shift (syncope is acuity 3, does not
   shift). v1 and v2 both asserted balance and both were wrong the same way.
   **v3's balance section must be produced from a probe arm, not reasoned.**
3. **TIA ships clinically hollow** (design MAJOR 6): its identity is stroke
   rule-out and Stage 1 gives it no imaging. Consider **syncope + a
   non-imaging native** (dehydration / cellulitis / a-fib rate-control) for
   Stage 1, holding TIA until its CT lands in the same stage.

**Code-side fixes to fold into v3 (all confirmed against source):**
- Gate keys on the OBSERVATION step (step 1), not step 0; use a filtered
  `available` array, never a `continue` (the fallback returns the last id).
  Moot if the separate-channel model is adopted.
- **Test blast radius the plan missed:** `m3Roster.test.ts:83-99` and
  `expansion1.test.ts:248-261` both assert every `EMERGENCY_CONDITION_ID` rolls
  — they fail the instant tia/syncope are gated. `finance.test.ts:486-503` pins a
  hardcoded earning-room set that omits the now-earning `observation`.
- Regression 3 "bit-identical to today" is FALSE — `nurseTech` mints candidates
  (`world.ts:201-204`) and re-pins every seed. Reword to "role present, no obs
  room → tia/syncope never spawn over a long run."
- The bladder pause needs reserved→reservation→room plumbing (`decay.ts:57`
  has no room lookup), not a one-line data read. And the accident drops on the
  patient's walkable ANCHOR tile, not the bed.
- `nurseTech` needs a unique `color` (`anesthesia.test.ts:44` all-pairs sweep).

**Confirmed sound, carry forward unchanged:** the SAVE_VERSION 12 story (all
three `asOneOf` sites, no field migration); the single-room `nurseTech` role
(anti-capture guard correctly inert for it); one tech across 6 beds mechanically;
the `data.test.ts` / `edRatio.test.ts` coverage guards auto-satisfy.

---

## 0.2 MEASURED (2026-07-19) — the scaffold ran; my asserted numbers were wrong BOTH ways

The v2 design review said "measure before asserting a third time." I built the
v3 spine as a throwaway prototype (branch `observation-measurement`: separate
arrival channel, `nurseTech` role, `tia`/`syncope` natives, observation room)
and ran a sweep probe (`test/observationProbe.test.ts`, REFERENCE arm, 5 seeds ×
5 days). **The data overturns my v2 assertions in both directions.**

Baseline emergency arrivals with the channel OFF: **43.0/day.**

| obs rate | rep | obs arr/day | **bed occupancy** | peak beds | **tech peak load** | emerg arr/day | AMA/day |
|---|---|---|---|---|---|---|---|
| 0.5 | base | 11.2 | **67.9%** | 2 | **2** | 33.4 | 14.1 |
| 0.5 | MAX | 24.4 | 64.2% | 2 | 2 | 67.5 | 60.6 |
| 1.0 | base | 16.7 | **76.3%** | 2 | 2 | 27.0 | 16.5 |
| 1.0 | MAX | 47.6 | 73.2% | 2 | 2 | 69.9 | 87.3 |
| 1.5 | base | 22.9 | **79.0%** | 2 | 2 | 24.0 | 21.5 |
| 1.5 | MAX | 71.4 | 74.1% | 2 | 2 | 68.0 | 110.4 |

**Finding 1 — the separate channel produces ~4× the volume the v2 weight model
did, so occupancy is ~68%, not the 33% I asserted.** v2's `2.7 obs/day` came from
redistributing the fixed budget; the separate channel is additive and yields
11–23/day. My v2 arithmetic wasn't just miscalibrated, it used a number 4× too
low. **Two beds run at 68–79% occupancy — a healthy band — and peak to 2 (full)
regularly.** Expansion DOES bind here, especially at rate ≥1.0. v2 MAJOR 2's
"expansion never pays" is FALSE under the separate-channel model.

**Finding 2 — the tech never binds. `tech peak load` is 2 against a ratio of 6,
at every rate.** One $100/day nurseTech covers the whole foreseeable ward — so
the capacity lever that binds is BEDS (capital), and the tech is cheap, ample
support. That is a clean design: buy beds, one tech runs them. It also confirms
v2 MAJOR 2's tech observation — but reframes it as a feature, not a flaw.

**Finding 3 — the ER-assessment step is the real cost, and it is NOT what either
of us predicted.** At floating reputation, adding the channel drops emergency
arrivals 43 → 33 (rate 0.5) → 24 (rate 1.5). NOT weight redistribution (that is
fixed) — the mechanism is: both natives carry an `er` assessment step, that
extra ER load spikes AMA, AMA tanks floating reputation, and the reputation
multiplier suppresses ALL arrivals. At PINNED reputation the emergency number
holds (67.5 at rate 0.5 MAX ≈ the un-perturbed rate), which isolates the cause
to the reputation spiral driven by ER contention. **The ED-hub chain the owner
asked for is exactly what generates the cost.**

**What this means for v3's balance (now grounded, not asserted):**
- Ship at **rate ~0.5** and **2 starting beds** (67.9% occupancy — room to grow,
  not saturated on day one).
- **The ER step must be lightened** — shorter, or single-role, or the channel
  gated behind ER headroom — or it drags the whole hospital at floating rep.
  This is the real design problem, and it is measured, not guessed.
- `staffRatio: { nurseTech: 6 }` is fine — arguably generous, since load never
  exceeds 2. Beds are the sole capital lever.
- The revert set's guard #1 (nurse/ER load) is the one that matters; the probe
  shows exactly where the harm lands.

**Not yet measured (v3 owes it):** the COMPACT arm (LAYOUT_PLAN §3.4), a bed
sweep (does a 3rd bed pay at rate 1.0?), and the ER-step-lightening options
head-to-head. The scaffold is on the branch, ready to extend.

## 1. Why this exists

Three problems collapse into one feature, and unlike v1 this version actually
resolves each:

1. **Radiology is empty** (`IMAGING_PLAN`; X-ray 8.1%, re-measured). Observation
   is a real second demand source for CT/MRI/ultrasound — but the imaging-during-
   observation leg is **Stage 2** (§3), not Stage 1. Stage 1 does not touch it.
2. **The game has one capacity axis.** Departments research: reality has three
   (area-, equipment-, staff-hour-scaled). Observation is **bed-scaled**, which
   today only dialysis is, and it introduces a genuine "machine or staff?"
   diagnosis via the nurse-tech ratio (§5).
3. **The owner wants an expandable department** "with rooms in it like the ER."
   Bed-scaled `perProp` capacity IS that: expanding the room adds beds, and at
   `tilesPerProp: 6` every expansion column actually delivers one.

It is also **net-new revenue**, not a cost bolted onto existing patients. tia
and syncope are patients who do not exist without the room, so the unit has its
own P&L — the honest tycoon shape the research (§2.6) describes, and the exact
thing v1 got backwards.

## 2. The research (unchanged from v1; sources §11, honesty ledger §10)

Method: fan-out search → source fetch → adversarial self-check. Confidence
markers are the harness's.

### 2.1 The owner's condition list — HIGH confidence

| owner named | verdict |
|---|---|
| **chest pain** | CORRECT and #1 in reality — but we ship it as an EXISTING condition and do NOT reroute it (owner: "keep chest pains"). Chest pain reaches observation only in **Stage 3**, via the escalate/branch mechanic. |
| **head injury** | CORRECT — a top-4 protocol. Also deferred; `headInjury` stays a 2-step chain in Stage 1. |
| **stroke** | **Acute stroke → NO** (acuity 1; belongs in a thrombolysis pathway). **TIA → YES** — the canonical obs protocol and the honest answer to the ask. Shipped as the new `tia` condition. |
| **headache** | UNVERIFIED as a standard protocol (§10). Not shipped. |

Canonical obs list, for later stages: chest pain · **syncope** · **TIA** ·
abdominal pain · asthma · head injury · a-fib · cellulitis · dehydration.
**syncope and TIA are the two Stage-1 natives** — both well-attested, both
short-stay, neither requiring the escalate mechanic.

### 2.2 Length of stay — HIGH confidence
No CMS "23-hour rule" (folklore; the real rule is Two-Midnight). Measured mean
**12.9 h** (US EDOU), ~15 h benchmark. **The game cannot import 15 h** — see
§5.2. Turnover **1.6 patients/bed/day**.

### 2.3 Disposition — HIGH confidence
**75–85% discharged, 15–25% escalated.** Stage 1 ships **100% discharge** for
the two natives and says so (§5.4); the escalate branch is Stage 3.

### 2.4 Staffing — HIGH confidence, and it IS the mechanic
**1 RN : 5–8 beds** — the lowest nursing intensity of any monitored bed. And
critically: EDOUs run on **nurse techs / CNAs with nurse oversight** — the tech
absorbing routine bedside work is *why* the ratio stretches that far. This is
the clinical basis for the owner's nurse-tech ask and for staffing the room with
`nurseTech`, not `nurse` (§5.1).

### 2.5 Sizing — HIGH confidence
**OU volume ≈ 4–10% of ED visits.** Only 39% of US EDs have one — the basis for
making it opt-in (room-gated, §3.2). This is the number that sets the Stage-1
weights (§6).

### 2.6 Financial case — HIGH confidence, right tycoon shape
$1,572 saved/patient; payback is INDIRECT (throughput/avoided admission), and
*"high upfront costs often outweigh eventual savings."* In v2 the room ALSO earns
directly from its native patients, so it is not the pure-sink trap v1 was.

## 3. The design — native conditions, room-gated

### 3.1 Two new conditions, both `er → observation`

Owner-confirmed chain (ED hub for walk-ins): a walk-in **triages, is assessed in
the ED, then goes to the observation bed.** Both natives are therefore
**2-step** chains — the game's current maximum — so `DEPARTMENTS_PLAN` §3.1's
never-lengthen-chains rule is satisfied *by construction*, and nothing existing
is touched.

```
tia:      Transient Ischemic Attack   acuity 2   (referral-grade → rides case-mix shift)
  step 0  ED assessment    er           [doctor, nurse]   45 min   $900
  step 1  Observation      observation  [nurseTech]      360 min   $500

syncope:  Syncope (fainting)           acuity 3
  step 0  ED assessment    er           [doctor, nurse]   40 min   $700
  step 1  Observation      observation  [nurseTech]      360 min   $500
```

- **The ER step is short by design.** The point of the feature is that service
  time lives in the bed, not the ED — and a short ER step limits the load added
  to the game's most-contended room. It is still measured (§6.1).
- **tia is acuity 2** → referral-grade (`referralAcuityMax: 2`), so its weight
  scales up with reputation via `caseMixShiftFactor`. That is deliberate: it is
  what grows bed demand as the player succeeds, which is what eventually makes
  **expansion** pay (§6.2). syncope at acuity 3 does not shift — a steady base.
- **The CT-first "rule out stroke" step is Stage 2.** Real TIA gets a head CT;
  adding it now is a 3-step chain the reviews forbade. `tia` shipping as
  `er → observation` is the honest 2-step compression; the CT leg is the
  imaging-during-observation prize (§3.3), measured against this baseline.

### 3.2 Room-gating dissolves the stranding failure

**tia and syncope only spawn when an observation room exists.** This is the
outpatient precedent (`spawn.ts` gates electives on the modality being built),
applied to two emergency conditions:

- No observation room → the conditions never enter the mix → **no stranding, no
  forced $12k capex, and every existing save is untouched** — the v1 MAJOR 1
  that killed the predecessor cannot occur.
- Build the room → the patients appear. "Build the unit, unlock the patients" is
  a clean tycoon loop and makes the whole feature genuinely opt-in.
- Measurement is clean by construction: the baseline arm has neither the room
  nor the conditions; the treatment arm has both. No confound between "the
  routing changed" and "a room appeared."

**This is the one required `src/sim/systems/` change** (`spawn.ts`): the
emergency roll must skip observation-gated conditions when the room is absent,
mirroring `rollElectiveCondition`'s existing gate. Everything else is data.
§9 Q1 asks a reviewer to confirm the gate belongs in the emergency roll and not,
say, as an elective-style pre-triaged stream (it must not be — the owner wants
them triaged as ED walk-ins).

### 3.3 The staged roadmap — and why Stage 1 does not strand at a dead end

The v1 review's MAJOR 9 was that its Stage 1 pointed at a Stage 2 the design had
already ruled inadmissible. This roadmap does not:

- **Stage 1 (this contract):** the room, `tia` + `syncope` as `er → observation`,
  the `nurseTech` role staffing the beds, room-gating. A complete, shippable,
  measurable feature on its own.
- **Stage 2:** imaging-during-observation. `tia` becomes `er → observation → ct`
  — the return-to-imaging leg, which lands demand on CT/MRI. Still 3 steps, and
  it *replaces* the deferred CT-first step rather than adding a fourth, so the
  never-lengthen rule holds. Measured against Stage 1's baseline.
- **Stage 3:** the escalate/discharge branch (§2.3's 15–25%) and the
  protocol-selectivity mechanic (§2.4: a unit that accepts everything performs
  worse). This is where `chestPain` and `headInjury` finally reach observation —
  as escalations, not as lengthened chains — honouring the owner's original
  "chest pains and head injuries" naming without ever making those chains longer.

Each stage is independently valuable and none requires rewriting a shipped,
save-bumped chain.

## 4. The room

```
observation: {
  label: 'Observation Unit',
  kind: 'treatment',
  category: 'treatment',          // appears in the build bar automatically
  minCols: 4, minRows: 4,
  cost: 12_000,                   // see §6
  floorColor: <pale blue-grey>,
  staffedBy: ['nurseTech'],       // §5.1 — NOT nurse; that is the appendicitis fix
  staffRatio: { nurseTech: 6 },   // owner spec 6-9; 6 is the conservative pick
  capacity: { kind: 'perProp', prop: 'bed', noun: 'Beds' },
  props: [{ id: 'bed', walkable: false,
            density: { kind: 'perTiles', tilesPerProp: 6, min: 2 } }],
}
```

- **`tilesPerProp: 6`, not 8** (v1 review MINOR, measured): at 8, `4×4→5×4`
  costs money and adds ZERO beds — half of all expansions were inert, gutting
  the owner's "expanded with the increase in beds" ask. At 6: `4×4`=16→**2 beds**
  (satisfies CAPACITY_PLAN §3.2 min-size rule), `5×4`=20→**3 beds**. Every growth
  column delivers.
- **Reuse the existing `bed` prop** → ZERO render-side work (v1 code review
  verified `bed` has a `PROP_STYLE` entry). Note `bed` is a 2-tile strip, so 2
  beds consume 4 of 16 tiles — ample standing room (v1 review confirmed 11
  standable at min size).
- **No `failure` entry** — a ward of beds has no machine to break, and this keeps
  it off the single maintenance tech's queue.
- **`treatment` category** — no `RoomCategory` union change.

## 5. The four mechanics questions

### 5.1 Staffing — the nurse tech is the appendicitis fix AND the owner's ask

v1's code review PROVED a nurse-only 240-min ward drains the 3-nurse pool until
`appendicitis` discharges zero (`INVARIANTS.md:60`). Staffing with a **new
`nurseTech` role removes that competition at the root** — the ward never touches
the nurse pool.

```
nurseTech: { label: 'Nurse Tech', salaryPerDay: 100, ... }
```

- **$100/day** sits below nurse ($150) and above EVS ($90) — a CNA earns less
  than an RN, so hiring techs to cover beds is genuinely cheaper than hiring
  nurses, which is what makes the "nurse or tech?" question a real economic one.
- **`staffRatio: { nurseTech: 6 }`** — owner spec 6–9 patients; 6 is the safe end
  and the band is the balance knob. One tech covers a whole small ward.
- **A new `RoleId` is a real cost:** it mints constructor candidates
  (`topUpCandidates`) and therefore **re-pins every seed from tick 0** — the
  ANESTHESIA_PLAN §6 precedent. §8 owns the re-pin, derived mechanically, never
  predicted (v1 review MAJOR 6).
- **The anti-capture guard.** v1's headline fear did NOT materialise — measured
  triage starts were flat-to-up on all five seeds, because the guard fires for a
  new room type. But it does not fire on a role the ED never competes for:
  `nurseTech` serves ONLY observation, so it has no "starved outside" pressure
  and the guard is irrelevant to it. That is fine here — a tech monopolised by
  observation is a tech doing its only job. §9 Q4 confirms.

**Stage 1 keeps observation tech-only.** The richer "do I need a nurse or a
tech?" diagnosis — where both serve and the tech raises effective nurse coverage
— is Stage 2+, once nurses also appear in the unit. Stated so a reviewer does
not expect the capacity-lever payoff in Stage 1.

### 5.2 Duration — 360 game-minutes, and the honest defence

Reality is ~15 h; the game's longest step is stroke's 120 min. A literal import
is impossible. **360 game-min (6 h)** — 3× chest pain's ER step — preserves the
relationship (observation is much longer than treatment) without deleting a bed
for a day. It is a game-feel judgement, not a research finding.

**The honest defence is the sizing rule, not the turnover figure** (v1 review
MINOR): §2.5's "OU volume = 4–10% of ED visits." §6's weights put tia+syncope at
~8.6% of arrivals, inside that band, and 360 min sets bed occupancy where a
2-bed ward is comfortable early and saturates as reputation grows (§6.2). Bed
occupancy is the falsifiable measure (§8 regression 5), not the duration itself.

### 5.3 Bladder — Stage 1 pauses it; the nurse-tech hygiene job is Stage 1.5

A 360-min bedbound patient drains 72 bladder points (`bladderPerGameHour: 12`)
against a 45 spawn floor — **essentially every obs patient would accident in the
bed**, dropping a mess on a `walkable: false` tile.

The owner's answer is *"staff for them"* — nurse techs handle bed accidents.
That is real, and it is the second nurse-tech duty. But it is a **new
patient-directed claim shape** (the tech attends a PATIENT, unlike EVS which
attends a TILE — owner ruling), which is genuinely new machinery. So:

- **Stage 1 pauses bladder in an observation bed** via a `RoomDef` data flag
  (`bedbound: true`), read through an accessor like `conditionElective` /
  `roomStaffRatio` — NOT a `room.type === 'observation'` literal in `decay.ts`,
  which would put a game fact in a system file (v1 review MINOR, hard rule 1).
  Defensible: obs beds have call bells and bedpans; FGI mandates a toilet per
  six beds. This ships a working, accident-free unit.
- **Stage 1.5 (the nurse-tech hygiene job):** unpause bladder, add the
  patient-directed nurse-tech claim for accidents, and the EVS boundary. This is
  where the "new claim shape" lands, measured against Stage 1's clean baseline.

The owner gets the nurse-tech role immediately (as obs staff) and the
bed-accident mechanic in the very next stage — not a giant single drop. §9 Q3
puts the pause-vs-ship-accidents fork to a reviewer explicitly; a reviewer who
would rather do the hygiene job in Stage 1 should say so now.

### 5.4 Escalation — Stage 1 is 100% discharge, and says so

The chain model has one terminal (`stepIndex >= steps.length → discharge`).
Branching to "escalate to inpatient" (§2.3's 15–25%) is a genuinely new sim
capability and is **Stage 3**. Stage 1's two natives discharge 100%, which is
stated, not hidden. It does not misteach the mechanic because the natives are
*low-risk rule-outs by definition* — a TIA whose deficit resolved and a syncope
that ruled out cardiac cause genuinely do go home. The interesting "did I rule
out or just delay?" decision is Stage 3's, and named as such.

## 6. Balance

| | value | basis |
|---|---|---|
| room cost | **$12,000** | above ER ($10k); but native revenue means it is not a pure sink (§2.6) |
| beds at min size | 2 | §4 density at `tilesPerProp: 6` |
| obs step duration | 360 game-min | §5.2 |
| obs step fee | **$500** | low per-bed-hour; the room also earns each condition's ER-step fee |
| nurseTech salary | **$100/day** | §5.1, below nurse |
| staffRatio | nurseTech: 6 | §5.1, owner spec |

**New emergency weights** (added to the existing 148):

```
tia:     6      (acuity 2 → rides the case-mix shift)
syncope: 8      (acuity 3 → steady base)
```

tia+syncope = 14 of 162 = **8.6% of arrivals** ≈ 2.7 obs patients/day at base
reputation — squarely inside §2.5's 4–10% band. **Room-gated (§3.2), so these
weights are ZERO whenever observation is absent** — the emergency mix is
bit-identical to today until the room is built, exactly as the elective weights
are zero until a modality is built.

Revenue: at ~2.7/day the obs step alone earns ~$1,350/day, plus the ER-step fees
of patients who would not exist otherwise; payback on $12k is ~9 days from the
obs step and faster counting the whole conditions' revenue. Honest, because it is
net-new demand.

### 6.1 Falsification — calibrated against the MEASURED noise floor (commit `8ec700d`)

The baseline commit supplies real per-seed spreads. Deaths at 5 seeds have a
0.0–0.6 spread against a 0.20 mean — **unusable**, exactly as it killed
`IMAGING_4B`'s thresholds. So:

**REVERT if, on either layout arm (both, per LAYOUT_PLAN §3.4):**
1. **triage starts fall >15%** OR **nurse idle-time falls below its measured
   baseline minus 15 points** — the ER-step load from two new conditions lands
   on the nurse pool. State the measured baseline idle-% first, then set the
   threshold as a delta (v1 review MAJOR 7: never cite utilisation as if it were
   idle-time).
2. **`appendicitis`, `gallstones` or any surgery/dialysis condition's
   discharged/arrived falls** — the nurse-gated rooms, the exact thing v1's
   nurse-only ward broke. This is the guard that proves the tech-staffing fix.
3. **AMA walkouts rise >15%** on either arm — v1 moved them 9→32 on one seed and
   watched with nothing. Now watched.
4. **`chestPain`/`fracture`/`pneumonia` discharged/arrived falls** — the floors
   pinned in `harness.test.ts` on the pre-change build (`8ec700d`).

**SUCCESS BAR** (v1 had none): tia and syncope discharge ≥90% of arrivals on both
arms, bed occupancy lands in a 40–80% band at base reputation, and **no
regression in (1)–(4)**. If the ward cannot serve its own patients without
harming the existing hospital, it is not ready.

**Deaths are NOT a revert metric at 5 seeds — stated deliberately** (v1 review
MAJOR 3). To use deaths, raise the seed count until the spread is below the
effect. §9 Q5.

### 6.2 Expansion actually pays — the owner's headline ask, defended

v1's fatal flaw: 2 beds exceeded demand, so no player would ever buy a third and
the "expandable" ask was inert. v2 fixes this two ways:
- `tilesPerProp: 6` means a bought column delivers a real bed (§4).
- tia is acuity-2 referral-grade, so at high reputation its weight ×1.5 AND the
  arrival rate ~×2 — obs demand at max rep is roughly 2.7 × (arrival mult) ×
  (tia shift) ≈ 6–8/day, which **saturates a 2-bed ward and forces a third**.
  Early game 2 beds suffice; late game you expand. The probe must show this
  (§8 regression 5): occupancy rising with reputation toward saturation.

## 7. Save impact — SAVE_VERSION 12, owed THREE times

Every reason is the same concrete old-build failure the policy at
`save.ts:33-138` requires, all via `asOneOf(... , X_IDS)`:

1. **New room type** `observation` — `save.ts:917` `asOneOf(o.type, ROOM_TYPES)`.
2. **New condition ids** `tia`, `syncope` — `save.ts:757`
   `asOneOf(o.condition, CONDITION_IDS)` (the v10→v11 precedent exactly).
3. **New role id** `nurseTech` — `asOneOf(o.role, ROLE_IDS)` (the v8→v9
   precedent exactly).

An older DEPLOYED build opening such a save dies on a shape error instead of the
clean "newer than this game understands" refusal. **No field shape changes and
no `readRoom`/`readPatient` migration** — capacity is derived from the grid, not
stored; `stepIndex` already serialises; the v1 code review ran the full save
suite at v12 including byte-identity and version-border fixtures, all green.

## 8. Regressions required

1. **Room shape** — `observation` derives exactly 2 beds at 4×4 and 3 at 5×4
   (pins `tilesPerProp: 6` vs the rejected 8). Add to `capacity.test.ts`.
2. **Native chains** — `tia` and `syncope` are each `er → observation`, step 1
   is `nurseTech`-staffed, and a patient reaches `discharged` with the full fee.
3. **Room-gating** — with NO observation room, `tia`/`syncope` never spawn
   (emergency mix bit-identical to today); WITH one built, they do. Pins §3.2,
   the dissolution of the stranding failure.
4. **Nurse pool untouched** — a run with the observation ward busy still
   discharges `appendicitis`/`gallstones` (the tech-staffing fix; the exact
   assertion v1 failed).
5. **Bed occupancy / turnover** — mean occupancy over a 5-day run lands in a
   stated band and rises with reputation (falsifies a duration that deletes a bed
   for a day; pins §6.2's expansion premise).
6. **Bladder paused in the bed** — a patient on an active observation
   reservation does not accident (pins the Stage-1 `bedbound` flag; §5.3).
7. **v11 → v12 back-compat** — a v11 save loads. Use the REAL downgrade helper
   (`save.test.ts:840-860`, which DELETES fields), NOT the version-stamp tamper
   lines at `:534/544/552` — that mistake made a regression vacuous in the
   thoughts contract.
8. **Coverage guards** — `data.test.ts:55-83` (obs used by ≥1 step — satisfied by
   the natives; would FAIL without them), `expansion1.test.ts` prop-fit,
   `buildMenu.dom.test.ts` totality, `edRatio.test.ts` staffRatio ⊆ staffedBy.
9. **RNG re-pins derived mechanically, never predicted** — the new role + room +
   conditions shift seeded streams; re-pin whatever goes red, committed WITH the
   change (`INVARIANTS.md:161/278`).

## 9. Open questions for the reviewers

1. **Is room-gating an emergency condition on a room the right mechanism**
   (§3.2), or does gating belong elsewhere? It must NOT become an elective-style
   pre-triaged stream — the owner wants ED walk-ins through triage → ER.
2. **Are `er → observation` (2-step) the right chains**, or does tia clinically
   demand its CT rule-out even in Stage 1 (making it 3 steps and reopening the
   never-lengthen debate)?
3. **Bladder: pause in Stage 1, or ship the hygiene job now?** (§5.3) The owner
   asked for nurse-tech accident handling; this contract stages it one step
   later. Right call, or should Stage 1 carry it?
4. **Is `nurseTech` serving ONLY observation correct for Stage 1**, or should it
   also relieve nurses elsewhere immediately (the capacity-lever payoff)? The
   latter reintroduces nurse-pool interaction the tech-staffing was chosen to
   avoid.
5. **Seed count.** Deaths are unusable at 5 (§6.1). Raise, change the metric, or
   accept the blind spot — choose explicitly.
6. **The expandability friction** (`build.ts:248-250` rejects expansion while any
   reservation is live; a 360-min ward is almost always busy). v1's code review
   measured the drain at ~80 real-seconds at 1× — a documented gesture, not a
   blocker. Confirm that judgement holds for a bed-scaled room.
7. **Is $12,000 / $500 / weights 6+8 the right shape** for "2 beds early,
   saturates late"? The whole §6.2 expansion premise rests on it and it is
   asserted, not yet measured.

## 10. What the research could NOT establish — carried, not laundered

1. **Headache as a standard EDOU protocol — UNVERIFIED.** Not shipped.
2. **Exact condition-mix percentages — UNVERIFIED** (Emory figures from an
   unopenable PDF). Ordering probably right, decimals not.
3. **Chest pain's share of obs volume — NOT FOUND.**
4. **ACEP protocol details** — second-hand via search summary.
5. **FGI section numbers — NOT FOUND** (HFM reporting about FGI, not the code).
6. **Median (vs mean) LOS — NOT ESTABLISHED.**
7. **Nurse/tech ratio is convention, not law.**

## 11. Sources

- Baugh et al., *Health Affairs* 2012 — observation cost savings
- Ross et al., *Health Affairs* 2013 — protocol-driven vs scattered observation
- PMC3922480 — multi-site EDOU (LOS 12.9h, 1 RN:5–8 beds, 84.3% discharge, 4–10%
  sizing)
- PMC8967459 — NHAMCS; 39% of EDs have a unit
- PMC12194427 — 2025 review; multi-diagnosis units underperform
- PMC11291183 — imaging occurs DURING the observation stay (Stage 2 basis)
- CMS Two-Midnight Rule; SAEM EDOU toolkit; AAEM staffing ratios; FGI via HFM
