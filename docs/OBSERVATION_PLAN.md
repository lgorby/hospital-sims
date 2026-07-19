# The Observation Unit — an EDOU department

**Status:** CONTRACT v3 (2026-07-19). **Balance is MEASURED, not asserted** —
the v2 design review's central demand. Ready for a fresh pair of adversarial
pre-implementation reviews. **No code on `master` until findings are folded in;**
a throwaway prototype lives on branch `observation-measurement`.
**Owner ask:** *"add an observation area option to purchase for things like
chest pains, strokes, headaches… expandable… a department that will have rooms
in it like the ER and OR. Of course that is after they come back from
radiology."* Plus *"outpatients should be sent from triage to the ER for things
like this"* and nurse techs with a **6–9 patient load**.
**Owner decisions folded in:** ED is the hub for walk-ins; nurse tech is a role
distinct from EVS; keep chest pains (do NOT touch the chestPain chain).
**Save impact:** **SAVE_VERSION 11 → 12**, owed three times over — see §7.

---

## 0. Provenance — three drafts, and what each measurement taught

| draft | shape | why it failed |
|---|---|---|
| **v1** | route `chestPain`/`headInjury` THROUGH a bed by lengthening their chains | 25 findings. Stranded chestPain in every save; INVERTED its own decay claim; nurse-only ward starved the surgery pool (`appendicitis` discharged 0, PROVEN). |
| **v2** | native `tia`/`syncope` conditions, nurse-tech staffed, but as EMERGENCY WEIGHTS | Design review MAJOR 1, verified against `spawn.ts:76-85`: the arrival rate is a FIXED Bernoulli; weights only redistribute it. So the natives were NOT net-new — they cannibalised 8.6% of every existing condition. And the balance was ASSERTED (33% occupancy, expansion never binds) — both wrong. |
| **v3** | native conditions on a SEPARATE arrival channel, **balance measured from a probe** | this doc. |

**The v3 spine both v2 reviewers converged on:** model observation as a separate
gated arrival channel (the outpatient-stream precedent, `spawn.ts:99-110`) —
genuinely net-new, cleanly measurable, still ED walk-ins. This also dissolves
the code review's gate-mechanism finding (no filter-in-the-emergency-roll, no
float-residue trap) and keeps the natives out of `EMERGENCY_CONDITION_IDS`
entirely, so the two spawn-mix tests v2 would have broken pass untouched.

## 0.1 WHAT THE PROBE MEASURED — and it corrected me twice more

Prototype on branch `observation-measurement`; `test/observationProbe.test.ts`,
5 seeds × 5 days. Baseline emergency arrivals with the channel OFF: **43.0/day.**

**REFERENCE arm, ER step full (45/40 min, doctor+nurse):**

| rate | rep | obs arr/d | **occupancy** | peak beds | **tech peak load** | emerg arr/d | AMA/d |
|---|---|---|---|---|---|---|---|
| 0.5 | base | 11.2 | **67.9%** | 2 | **2** | 33.4 | 14.1 |
| 1.0 | base | 16.7 | 76.3% | 2 | 2 | 27.0 | 16.5 |
| 1.5 | base | 22.9 | 79.0% | 2 | 2 | 24.0 | 21.5 |

**ER-step variant × layout arm (rate 0.5, base rep):**

| arm | occupancy | emerg arr/d (baseline 43.0) |
|---|---|---|
| full · REFERENCE | 67.9% | 33.4 |
| full · COMPACT | 77.6% | **40.9** |
| light · REFERENCE | 64.9% | 34.0 |
| light · COMPACT | 78.9% | 42.5 |

**Bed sweep (rate 1.0, REFERENCE): 2 beds → mean 1.56 / occ 77.8%; 3 beds →
mean 2.24 / occ 74.7%, peak 3, tech peak load 3.**

**Four findings, each of which overturned an assertion — mine or a reviewer's:**

1. **Occupancy is ~68%, not the 33% I asserted in v2.** The separate channel is
   additive, producing ~4× the volume the weight-redistribution model did
   (11–23/day vs 2.7). Two beds run 68–79% and peak to full regularly.
2. **Expansion BINDS.** The bed sweep: a 3rd bed at rate 1.0 reaches mean 2.24/3
   occupancy and lets more patients through (obs arr 16.9 → 17.7). v2 MAJOR 2's
   "expansion never pays" is false under the corrected model. The owner's
   expandable-ward ask works.
3. **The tech never binds.** Peak load on one nurseTech is 2 at 2 beds, 3 at 3
   beds — never near ratio 6. **Beds are the sole capital lever; one $100 tech
   runs the ward.** Clean design.
4. **Lightening the ER step does NOT fix displacement — this REFUTED my own
   §0.2 remedy.** full→light barely moves emerg arrivals (33.4 → 34.0 on
   REFERENCE) and slightly raises deaths. The displacement is not the ER step's
   duration; it is total added load, and it is **layout-mediated**: COMPACT
   absorbs the channel (emerg holds at ~41 of 43), REFERENCE does not (drops to
   ~33). This is the LAYOUT_PLAN §3 lesson again — a competent hospital tolerates
   the load; a sprawling one spirals via AMA→reputation→arrivals.

**So the displacement is load-equilibrium, not a defect** (v2 framed it as harm):
the channel adds net-new revenue (~11 patients/day × ~$1,400) against a modest,
reputation-mediated dip in emergency throughput that a well-built hospital barely
feels. **Keep the ER step full** — the owner wants the ED hub, and lightening it
buys nothing.

## 1. Why this exists

1. **Radiology is empty** (`IMAGING_PLAN`; X-ray 8.1%). Observation is a real
   second demand source for CT/MRI — but that leg is **Stage 2** (§3.3).
2. **The game has one capacity axis.** Reality has three (area-, equipment-,
   staff-hour-scaled). Observation is **bed-scaled**, which only dialysis is,
   and the bed-vs-tech split is a genuine capacity diagnosis (§5).
3. **The owner wants an expandable department.** `perProp` bed capacity IS that,
   and the probe confirms expansion binds (§0.1 finding 2).

Net-new revenue with its own P&L — measured, not asserted this time (§0.1
finding 1).

## 2. The research (24 sources, adversarially verified; honesty ledger §10)

### 2.1 The owner's condition list — HIGH confidence

| owner named | verdict |
|---|---|
| **chest pain** | #1 obs protocol in reality — but shipped as the EXISTING condition, NOT rerouted (owner: "keep chest pains"). Reaches observation only in **Stage 3** via escalation. |
| **head injury** | Top-4 protocol. Deferred; `headInjury` stays 2 steps in Stage 1. |
| **stroke** | Acute stroke → NO (acuity 1, thrombolysis pathway). **TIA → YES**, the canonical obs protocol and the honest answer. |
| **headache** | UNVERIFIED as a standard protocol (§10). Not shipped. |

Stage-1 natives: **`syncope`** (clinically clean — obs + telemetry, ~100%
discharge) and **`tia`** (rides the case-mix shift; §9 Q2 flags its Stage-1
imaging gap).

### 2.2 Length of stay — HIGH confidence
No CMS "23-hour rule" (folklore; the rule is Two-Midnight). Measured mean
**12.9 h**. The game compresses to **360 game-min** (§5.2) — validated by the
probe's occupancy, not by the raw hours.

### 2.3 Disposition — HIGH confidence
**75–85% discharged.** Stage 1 ships 100% for the two natives (§5.4); the
escalate branch is Stage 3.

### 2.4 Staffing — HIGH confidence, and the probe confirms it
**1 RN : 5–8 beds**, the lowest nursing intensity of any monitored bed, because
**nurse techs / CNAs absorb the routine work.** The probe (§0.1 finding 3) shows
one tech at ratio 6 is never contended — reality and measurement agree.

### 2.5 Sizing — HIGH confidence
OU volume ≈ **4–10% of ED visits.** At rate 0.5 the probe puts obs arrivals at
11.2/day against ~43 emergency ≈ 20% — higher than the real-world band, but the
game deliberately concentrates demand (the outpatient stream did the same). The
occupancy, not the share, is the shipping criterion.

### 2.6 Financial case — HIGH confidence
$1,572 saved/patient; payback INDIRECT. In v3 the ward also earns directly from
its natives, and the probe confirms net-new volume — so it is not the pure sink
v1 was.

## 3. The design

### 3.1 Two native conditions, `er → observation`, on a separate channel

```
tia:      TIA (mini-stroke)   acuity 2   (referral-grade → rides case-mix shift)
  step 0  ED assessment    er           [doctor, nurse]   45 min   $900
  step 1  Observation      observation  [nurseTech]      360 min   $500

syncope:  Syncope (fainting)  acuity 3
  step 0  ED assessment    er           [doctor, nurse]   40 min   $700
  step 1  Observation      observation  [nurseTech]      360 min   $500
```

- Both **2-step** (`er → observation`), so nothing existing lengthens
  (`DEPARTMENTS_PLAN` §3.1 satisfied by construction).
- **The ER step stays full** (doctor+nurse) — §0.1 finding 4 measured that
  lightening it does not reduce displacement and slightly worsens deaths. Keep
  the ED hub the owner asked for.
- Marked `observation: true` in `CONDITION_DEFS`, which puts them in a THIRD
  partition (`OBSERVATION_CONDITION_IDS`) — excluded from both
  `EMERGENCY_CONDITION_IDS` and `ELECTIVE_CONDITION_IDS`. This is what keeps the
  spawn-mix tests passing and the natives out of the fixed arrival budget.

### 3.2 The separate arrival channel, room-gated

`updateObservationSpawn` (mirroring `updateOutpatientSpawn`): a third Bernoulli
at `BALANCE.arrivals.observation.perGameHour`, drawn every tick, gated INSIDE
the draw on the observation room existing (so owning no ward does not perturb
the stream). **Walk-ins, not referrals** — spawned WITHOUT an acuity override,
so they triage and bill as treatment. No clinic-hours window (a faint keeps no
office hours). `scaleWithReputation: true` — the probe measured this on; it is
what makes high-rep demand saturate 2 beds.

This dissolves both v2 review MAJORs at once: net-new (design MAJOR 1) and no
gate-in-the-emergency-roll (code MAJOR). The natives simply are not in
`rollCondition`.

### 3.3 Staged roadmap

- **Stage 1 (this contract):** the ward, `tia` + `syncope`, the `nurseTech`
  role, the channel. Complete and measured.
- **Stage 1.5:** the nurse-tech HYGIENE job (§5.3) — unpause bladder, add the
  patient-directed tech claim for bed accidents (the owner's explicit ask). A
  new claim shape; sequenced right after Stage 1 so the owner's request is not
  orphaned (v2 review NIT).
- **Stage 2:** imaging-during-observation. `tia` becomes `er → observation → ct`
  — the return leg, landing CT/MRI demand, and the CT that makes TIA clinically
  honest (§9 Q2). Replaces the deferred rule-out; still ≤3 steps.
- **Stage 3:** the escalate/discharge branch and protocol-selectivity. Here
  `chestPain`/`headInjury` reach observation as ESCALATIONS, honouring the
  owner's naming without ever lengthening their chains.

## 4. The room

```
observation: {
  label: 'Observation Unit', kind: 'treatment', category: 'treatment',
  minCols: 4, minRows: 4, cost: 12_000, floorColor: 0xbcd0e6,
  staffedBy: ['nurseTech'], staffRatio: { nurseTech: 6 },
  capacity: { kind: 'perProp', prop: 'bed', noun: 'Beds' },
  props: [{ id: 'bed', walkable: false,
            density: { kind: 'perTiles', tilesPerProp: 6, min: 2 } }],
}
```

- **`tilesPerProp: 6`** — 4×4 → 2 beds, 5×4 → 3 (the probe's 3-bed arm). At the
  v2-drafted 8, half of all expansions added zero beds.
- **Reuse the `bed` prop** → zero render work. `nurseTech` gets a unique magenta
  `color` (`anesthesia.test.ts` all-pairs sweep).
- **No `failure`** — a ward of beds has no machine to break.

## 5. Mechanics

### 5.1 Staffing — nurse-tech, and the measurement backs the ratio
A new `nurseTech` role ($100/day, below nurse's $150) removes v1's proven
nurse-pool starvation entirely. `staffRatio: { nurseTech: 6 }` — the probe
measured peak load 2–3, so 6 is ample. The anti-capture guard is correctly inert
for a single-room role (`starvedOutside` returns false — it is never demanded
outside observation). Stage 1 is tech-only; the "nurse or tech?" diagnosis is
Stage 2+.

### 5.2 Duration — 360 game-min, validated by occupancy not hours
Reality ~15 h; the game's longest step is 120 min. 360 is a compression, and its
correctness is the MEASURED occupancy (68–79%), not the raw figure.

### 5.3 Bladder — Stage 1 pauses it; the hygiene job is Stage 1.5
A 360-min bedbound patient drains 72 bladder points (floor 45) → near-certain
accident. Stage 1 pauses bladder in the bed via a `bedbound` `RoomDef` flag read
through an accessor (NOT a `room.type` literal in `decay.ts` — hard rule 1). The
plumbing is real (v2 code review: the bladder branch has no room lookup today,
unlike `healthPaused`; threading it is `stage.reserved → reservation.roomId →
roomBedbound()`). Stage 1.5 unpauses it and adds the nurse-tech hygiene claim.

### 5.4 Escalation — Stage 1 is 100% discharge, honestly
The two natives are low-risk rule-outs that genuinely go home. The 15–25%
escalate branch (§2.3) is Stage 3.

## 6. Balance — MEASURED (the whole point of v3)

| | value | basis |
|---|---|---|
| room cost | **$12,000** | above ER; net-new revenue confirmed, not a sink |
| beds at min size | 2 | `tilesPerProp: 6`, 4×4 |
| obs step duration | 360 game-min | §5.2, occupancy-validated |
| obs step fee | $500 | low per-bed-hour; also earns the ER-step fee |
| nurseTech salary | $100/day | below nurse; the "tech is cheaper" lever |
| staffRatio | nurseTech: 6 | probe peak load 2–3 |
| **channel rate** | **`perGameHour: 0.5`** | probe: 67.9% occupancy at base rep — room to grow, not saturated day one |
| scaleWithReputation | true | probe: what saturates 2 beds at high rep |
| channel weights | tia 6, syncope 8 | net-new; ZERO in `conditionWeights` (compile requirement, like electives) |

### 6.1 Falsification — against the MEASURED baselines

**REVERT if, on either layout arm:**
1. emergency-condition discharge RATE (discharged/arrived, not counts — the v2
   code review's confound fix) falls >10% for `appendicitis`/`gallstones` (the
   nurse-gated rooms) — the guard that proves the tech-staffing fix.
2. `chestPain`/`fracture`/`pneumonia` discharge rate falls >10% (the floors
   pinned on the pre-change build, `8ec700d`).
3. On COMPACT, emergency ARRIVALS fall >15% from the 40.9 measured with the ward
   present — the displacement staying load-bounded, not spiralling. (REFERENCE's
   larger dip is the fixture's sprawl, per §0.1 finding 4, not the feature.)

**SUCCESS BAR:** tia/syncope discharge ≥90% of arrivals on both arms; bed
occupancy 60–80% at base rep (MEASURED 67.9%, so this is reachable — unlike v2's
40% floor against a 33% assertion); and expansion demonstrably binds (the 3-bed
arm reaches ≥2.0 mean concurrent beds — MEASURED 2.24).

**Deaths remain OUT of the revert set at 5 seeds** (spread 0.0–0.6). §9 Q5.

## 7. Save impact — SAVE_VERSION 12, owed three times

Every reason is the concrete old-build failure the `save.ts:33-138` policy
requires, all via `asOneOf`:
1. New room type `observation` — `save.ts:917`.
2. New condition ids `tia`, `syncope` — `save.ts:757` (the v10→v11 precedent).
3. New role id `nurseTech` — `asOneOf(o.role, ROLE_IDS)` at BOTH the staff
   (`:852`) and candidate (`:1091`) sites, both covered by one addition.

**No field-shape change, no `readRoom`/`readPatient` migration** — capacity is
grid-derived, `stepIndex` already serialises. The v2 code review ran the full
save suite at v12 including byte-identity — all green.

## 8. Regressions required

1. **Room shape** — `observation` derives 2 beds at 4×4, 3 at 5×4.
2. **Native chains** — `tia`/`syncope` are `er → observation`, step 1 is
   `nurseTech`-staffed, patient discharges with full fee.
3. **Room-gating** — role present, NO observation room → tia/syncope never spawn
   over a long run (the v2 code review's correct wording; NOT "bit-identical to
   today", which the `nurseTech` re-pin makes false).
4. **Nurse pool untouched** — obs ward busy, `appendicitis`/`gallstones` still
   discharge (the tech-staffing fix; the exact assertion v1 failed).
5. **Bed occupancy binds** — a 5-day run reaches the measured occupancy band and
   the 3-bed arm exceeds 2.0 mean concurrent beds.
6. **Bladder paused in the bed** — a patient on an active obs reservation does
   not accident (Stage-1 `bedbound`).
7. **v11 → v12 back-compat** — use the REAL downgrade helper
   (`save.test.ts:840-860`, which DELETES fields), NOT the version-stamp tamper
   lines at `:534/544/552`.
8. **Spawn-mix tests pass UNCHANGED** — `m3Roster.test.ts:83-99` and
   `expansion1.test.ts:248-261` assert every `EMERGENCY_CONDITION_ID` rolls;
   because the natives are a THIRD partition they are not emergency ids, so these
   pass without a fixture change (the third-partition design's payoff over v2's
   gated-emergency approach). Add `observation` to `finance.test.ts:486-503`'s
   earning-set pin (it earns $500).
9. **RNG re-pins derived mechanically, never predicted** — `nurseTech` mints
   candidates and shifts every seed; re-pin whatever goes red, committed WITH the
   change (`INVARIANTS.md:161/278`; the prototype measured 4 re-pin failures —
   `slice`, `capacity` bedside-anchor, plus the partition/finance ones).

## 9. Open questions for the reviewers

1. **Is the load-equilibrium displacement (§0.1 finding 4) acceptable**, or does
   the REFERENCE-arm dip (43→33) need a remedy beyond "build compact"? The
   probe says lightening the ER step does not help; is rate 0.5 low enough?
2. **TIA ships without its stroke-rule-out CT in Stage 1** (v2 design MAJOR 6).
   Two honest options: (a) ship `tia` + `syncope` now, commit the CT to Stage 2;
   (b) ship `syncope` + a non-imaging native (dehydration/cellulitis/a-fib),
   hold `tia` until Stage 2 carries its CT. (a) honours the owner's stroke ask
   sooner; (b) never ships a clinically hollow condition. **Recommend (a) with
   the Stage-2 commitment explicit** — but this is a design call, not a measured
   one, and the owner should weigh it.
3. **Bladder: pause in Stage 1, hygiene job in Stage 1.5** (§5.3) — right
   sequencing, or fold the owner's accident-handling into Stage 1?
4. **Is `nurseTech` serving ONLY observation right for Stage 1**, or should it
   relieve nurses elsewhere immediately (reintroducing nurse-pool interaction)?
5. **Seed count** — deaths unusable at 5 (§6.1). Raise, change metric, or accept.
6. **The COMPACT bed sweep is not yet run** — the 3-bed arm was measured only on
   REFERENCE. Confirm expansion binds on COMPACT too before ship.
7. **Is $12,000 / $500 / rate 0.5 the shippable point**, given the measured
   68% occupancy and net-new revenue? The numbers are now grounded but the
   cost/fee ratio is still a judgement.

## 10. What the research could NOT establish — carried, not laundered

1. Headache as a standard EDOU protocol — UNVERIFIED. Not shipped.
2. Exact condition-mix percentages — UNVERIFIED (unopenable PDF).
3. Chest pain's share of obs volume — NOT FOUND.
4. ACEP protocol details — second-hand via search summary.
5. FGI section numbers — NOT FOUND (HFM reporting about FGI).
6. Median (vs mean) LOS — NOT ESTABLISHED.
7. Nurse/tech ratio is convention, not law.

## 11. Sources

- Baugh et al., *Health Affairs* 2012 — observation cost savings
- Ross et al., *Health Affairs* 2013 — protocol-driven vs scattered observation
- PMC3922480 — multi-site EDOU (LOS 12.9h, 1 RN:5–8 beds, 84.3% discharge)
- PMC8967459 — NHAMCS; 39% of EDs have a unit
- PMC12194427 — 2025 review; multi-diagnosis units underperform
- PMC11291183 — imaging occurs DURING the observation stay (Stage 2 basis)
- CMS Two-Midnight Rule; SAEM EDOU toolkit; AAEM staffing ratios; FGI via HFM
