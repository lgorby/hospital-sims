# The imaging-demand plan — why radiology is empty, and what to do

**Status:** SCOPING DRAFT (2026-07-19, owner ask). Not review-ready; §6 lists
what a contract must settle.
**Blocks:** Departments Stage 2a (`DEPARTMENTS_PLAN` §4.4 names this as its
prerequisite).
**Owner ask:** *"I see there is not much traffic going to the radiology
departments. In real life, the traffic to these departments is quite high…
I know the ER department sends a lot of patients to radiology."*

---

## 1. The measurement first

`test/utilisationProbe.test.ts`, 5 seeds × 5 days, reference build:

| room | visits/day | room-min/day | utilisation |
|---|---|---|---|
| X-Ray | 4.1 | 107 | **6.2%** |
| CT | 2.8 | 87 | **4.9%** |
| MRI | 1.2 | 69 | **3.9%** |
| Nuclear Medicine | 1.0 | 58 | **3.3%** |
| Ultrasound | 1.5 | 59 | **3.9%** |
| **total** | | **380 min** | **radTech 13–24%** |

**The owner's observation is correct and the cause is not what it looks like.**

**45.3% of arrivals already receive imaging** — see §2, that figure is roughly
right against reality. The problem is that ~14 studies/day are split across
**five dedicated rooms**, giving under 3 studies per room per day.

## 2. What the research says (24 sources, adversarially verified)

Full method: fan-out search → source fetch → 3-vote adversarial verification
(2/3 refutes kills a claim) → synthesis. Confidence and vote counts below are
the harness's, not editorial.

### 2.1 ED imaging rates by modality — HIGH confidence

| modality | share of US ED visits | source |
|---|---|---|
| plain radiography | **33.7%** (2016), flat since 2007 (33.8%) | NHAMCS, *West J Emerg Med* 2020, PMID 32191178 |
| CT | **16–17%** | NHAMCS, *PLOS ONE* 2019, PMID 30964899 |
| formal ultrasound | **3.6–5.2%** | NHAMCS; corroborated by CDC MMWR and Medicare FFS |
| MRI | **0.4%** | NHAMCS 2009–2014, n=139,150 adult visits |
| any advanced (CT or MRI) | 17.8% (2016) / 21.9% (2009–14) | two independent NHAMCS analyses |

Suggested sim calibration from the research: **~35% X-ray, ~18–22% CT, ~5%
ultrasound, ~1% MRI** per ED visit, with meaningful overlap between them.

**Radiography is flat but remains the volume leader; CT is the growth
modality** (ED CT went 2.8% of visits in 1995 → 13.9% in 2007 → ~16–17% now,
though the curve has plateaued for some body regions and must not be
extrapolated).

### 2.2 THE ANSWER TO THE OWNER'S QUESTION — HIGH confidence

> *"Radiology is a service the ED orders mid-stay and the patient returns from,
> not a gateway patients pass through before physician evaluation."*

Evidenced indirectly but consistently: ED and admitted-patient imaging turns
around faster than any other referral source (median request-to-test **0 days**
for X-ray and **1 day** for CT, against 15 days for ultrasound and 21 for MRI
system-wide — NHS England Diagnostic Imaging Dataset, 49.9m tests 2024/25).
**Flagged honestly: no source directly resolves intra-visit ordering.**

**The game has this backwards.** Every imaging chain runs *imaging → ER*:

| condition | game chain | weight |
|---|---|---|
| fracture | **xray → er** | 15 |
| kidneyStones | **ct → er** | 8 |
| headInjury | **ct → er** | 5 |
| stroke | **ct → er** | 4 |

Imaging is a turnstile patients pass through *en route* to the ER. That caps
imaging demand at the handful of conditions routed through it and makes the ER
a *consumer* of imaging output rather than the *source* of imaging orders.

### 2.3 THE FINDING THAT MATTERS MOST — and it is not about routing

**MRI is ~83% elective/outpatient.** In the NHS Diagnostic Imaging Dataset,
A&E plus *all* admitted patients together account for under ~17% of MRI
activity, so ED-driven MRI is a **single-digit percentage** of MRI volume.

**The ED is a major consumer of X-ray and CT, and a minor one of MRI.**

Hospital Simms has **exactly one demand channel: emergency walk-ins.** There is
no outpatient or elective stream at all. So:

> **A game whose only arrivals are emergencies will structurally never have a
> busy MRI or nuclear-medicine suite, no matter how the chains are routed.**

That is not a balance number. It is a missing demand channel, and it explains
the two emptiest rooms in the game directly.

### 2.4 Per-presentation rates — MEDIUM/HIGH confidence

- **Abdominal pain:** CT in **42.6%** of such ED visits (2019), up from 26.2%
  (2007).
- **Renal colic:** CT **55–83%** depending on cohort definition; formal
  ultrasound only ~6%.
- Highest-volume CT-driving complaints: **abdominal pain, headache, chest
  pain**. *(Caveat carried from the research: this describes the complaint mix
  among CT recipients, not the probability a given presentation receives CT, so
  it cannot be inverted into per-condition branch rates without other sources.)*

### 2.5 WHAT THE RESEARCH DID NOT ANSWER — recorded, not papered over

**Questions 5 and 6 returned no surviving verified claim:**
- per-study **room occupancy / turnaround time** by modality
- realistic **studies-per-scanner-per-day** throughput
- **radiographer/technologist staffing ratios** per scanner or per volume

So the game's step durations (X-ray 20 min, CT 25, MRI 40, nucMed 45,
ultrasound 25) and the 2-radTechs-for-4-scanners ratio **cannot be calibrated
from evidence in this pass.** Any change to them must be justified by in-game
measurement, or by a further targeted research pass — not by assertion.

This matters because it is the *same* gap that sank Departments Stage 2a:
`DEPARTMENTS_PLAN` §4.3's "movable bottleneck" needed exactly these numbers.

## 3. Game mix versus reality

Share of *imaged* patients, game (derived from `BALANCE.spawn` weights and
`CONDITION_DEFS` chains) against share of ED visits, research:

| modality | game | reality (ED) | verdict |
|---|---|---|---|
| X-ray | 37% | ~35% | **about right** |
| CT | 25% | ~20% | close |
| ultrasound | 16% | ~5% | ~3× over |
| MRI | 12% | ~1% | **~12× over** |
| Nuclear Medicine | 9% | ~0 in ED | **not an ED modality** |

**The game's error is not too little imaging — it is imaging spread across five
co-equal rooms in proportions reality does not have.** X-ray and CT are roughly
right. MRI and nuclear medicine are massively over-weighted *for an
ED-only hospital*, which is precisely why they sit at 3–4%.

## 4. Candidate directions

Not a menu to pick from casually — (C) is a new mechanic and needs its own
milestone.

### A. Fix the chain inversion — ER → imaging → ER
Route the ER as the *orderer*. `ED_PLAN` Stage C already drafts the CT case
("ungate the CT dependency: ER → CT → ER"). Extends naturally to the X-ray
chains. **Cost: this LENGTHENS chains**, which `DEPARTMENTS_PLAN` §3.1's
principle ("change the ROOM of existing steps, never lengthen chains")
deliberately avoided — more steps means more gathers, more walking, more
contention. Must be measured on **both layout arms** (`LAYOUT_PLAN` §3.4).

### B. Add imaging to conditions that realistically get it
`chestPain` (weight 10) currently goes straight to a 90-minute ER stay with
**no imaging at all**; chest X-ray is near-universal for that presentation.
`laceration` (weight 20) is ER-only, which is defensible. This is the cheapest
lever and it raises X-ray — the modality reality says should dominate.

### C. An outpatient / elective arrival stream — the honest fix for MRI
§2.3 says MRI and nuclear medicine are outpatient businesses. A scheduled
outpatient channel would:
- give MRI and nucMed a demand source that matches reality;
- add a genuinely new decision (elective throughput vs emergency surge);
- make the imaging department a *revenue* centre, which is what it is in a real
  hospital.

**This is a new mechanic, not a balance pass** — new arrival path, probably
scheduling, new patient lifecycle variant. Its own design doc and review.

### D. Retire or merge the modalities the ED does not use
The mirror of (C): if there is no outpatient stream, nucMed has no honest place
in an ED-only hospital. `RETIRED_ROOMS` + `roomRetired()` already exist from
Departments Stage 1 and the retire path is proven on a live save. **Cheapest by
far, and the most destructive of existing content — offer it, do not assume
it.**

### E. Raise arrivals
31.8/day is a small hospital; a real ED sees 100–300. Would lift every room at
once — and is a whole-economy change that re-tunes the M4 balance and the
harness envelope. **Not recommended as the first lever**, because it changes
everything simultaneously and would confound the measurement of anything else.

## 5. Recommended sequencing

1. **(B) first** — cheapest, most defensible, moves the modality reality says
   should dominate. Measure on both layout arms.
2. **(A) second**, as `ED_PLAN` Stage C — but only after (B), so the chain-
   lengthening cost is measured against a known baseline rather than
   confounded with a demand change.
3. **(C) or (D) as an owner decision** — they are opposite answers to the same
   question: does this game want an outpatient business, or is it an ED
   simulator that should stop pretending to have an MRI department?
4. **(E) only if 1–3 leave imaging short**, and as its own balance milestone.

**Departments Stage 2a stays blocked until at least one scanner genuinely
saturates.** §2.5's gap means "saturates" must be defined by in-game
measurement, not by a real-world throughput figure we do not have.

## 6. What a contract must settle

1. Which levers, in which order, and the falsification condition for each.
2. **The §2.5 gap** — are step durations and the radTech ratio in scope? They
   cannot be evidence-calibrated from this pass.
3. Whether (C) or (D) is the answer for MRI/nucMed — an owner design decision,
   not a technical one.
4. Save impact. (A), (B), (D) are data-table edits: `CONDITION_DEFS` changes no
   save field, and `RETIRED_ROOMS` is proven. **(C) almost certainly adds
   patient state ⇒ `SAVE_VERSION` bump + plan rule 6.**
5. The measurement protocol: **both layout arms**, per-room utilisation, radTech
   utilisation, deaths, walkouts, profit/day — and the per-condition discharge
   floor (`DEPARTMENTS_PLAN` §3.2 risk 1: never measure a routing change and a
   capacity change together).

## 7. Sources

Primary, as returned by the verification pass:
- Marcozzi et al., *West J Emerg Med* 2020 — NHAMCS ED imaging 2007–2016
  (PMID 32191178)
- Hinson/Rezaei et al., *PLOS ONE* 2019 — advanced imaging, 139,150 adult ED
  visits (PMID 30964899)
- Larson et al., *Radiology* 2011;258(1):164-73 — ED CT growth 1995–2007
  (PMID 21115875)
- NHS England **Diagnostic Imaging Dataset** 2024/25 — 49.9m tests; referral
  source and request-to-test intervals
- CDC MMWR QuickStats; Medicare FFS ED imaging trends (*AJR* 2020)
- *Neurology* 2025 (doi 10.1212/WNL.0000000000214347) — head CT 2007–2022
