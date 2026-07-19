# Staff Shifts — the epic

**Status:** SCOPING PLAN (2026-07-19, owner ask). Not yet review-ready; §9 lists
what a Stage-1 CONTRACT must settle. **This is a whole-economy rebalance, not a
feature** — it needs its own measurement pass, and this plan commits to
measuring the balance rather than asserting it (the observation lesson).
**Owner ask:** *"a 12.5 hour shift limit (30 minutes for lunches) for staffing
so there is a rotation of staff every 12 hours so there will be some overlap."*
**Save impact:** **SAVE_VERSION 11 → 12** — a per-staffer shift field is new
saved state (§7).

---

## 1. Why this is the biggest thing on the board

Staff work **24/7 with no breaks today.** Payroll (`economy.ts:5-15`) charges
every hired staffer hourly, unconditionally. Shifts mean you need more than one
staffer to cover one position around the clock — so payroll rises sharply
against an economy tuned at M4 for continuous staff (`harness.test.ts:96`:
$3,060/day roster).

The research says this is not a distortion — **it is the central financial
reality of a hospital.** Labor is **~55% of hospital operating cost** (AHA 2025;
50–60% band), nursing its single largest chunk. A tycoon game that makes 24/7
coverage the dominant cost is *more* realistic, not less. This epic is where the
game's economy grows up.

## 2. The number that sizes everything — and the compression

**Reality: ~4.6–5.3 FTE to staff ONE position 24/7** (research §2, HIGH conf).
The popular "4.2" is just 168 hrs/week ÷ 40 — a before-time-off coverage factor;
fully loaded with PTO/sick/relief it is ~4.8. The 12-hour-specific worked base
is ~4.0 (12h nurses average a 42h week).

**The game cannot use 4.8× — it has no PTO, no weekends, no work-week cap.** A
game staffer already works every game-day, which a real nurse cannot. So the
honest compression is the axis the game DOES model:

> **Two shifts — day and night — so 24/7 coverage costs 2× the roster.**

The 4.8× → 2× gap is precisely the reality axes the game omits (relief for
weekends/PTO), and this plan states that explicitly rather than smuggling a
4.8× payroll shock into an M4 economy. **2× is the design target; whether the
economy survives even 2× is the Stage-1 measurement question (§6).**

This also hands the game a natural progression the owner will like: a new player
**cannot afford 2× staff**, so they run **day-shift only** and lose night
arrivals, then scale to 24/7 as revenue grows. "Day-only early, round-the-clock
later" falls straight out of the design — it is the core tycoon decision, and it
turns on the night arrival rate vs the cost of night cover.

## 3. The domain, grounded (research; honesty ledger §10)

- **12-hour shifts are the real standard** — 65% of US hospital RNs (Stimpfel &
  Aiken 2013). **12.5h = 12h worked + a 30-min unpaid meal** is authentic. Canonical clock 7a–7p / 7p–7a. **[HIGH]**
- **Overlap/handoff is real, paid, best-practice** — a 15–30 min shift-change
  block (bedside report / SBAR), where continuity is preserved. Skipping it is
  an error/continuity risk — a natural quality mechanic. **[HIGH principle]**
- **"Rotation every 12h" = the day↔night CHANGEOVER** (continuity), not circadian
  rotation of one nurse. The owner's phrasing points here. **[HIGH]**
- **Breaks:** federal law mandates none; states vary (CA strict — ratios hold
  even during breaks, which is *why* break/float nurses exist). **Nurses
  famously skip breaks under load** — a real trade-off (short-term coverage for
  a fatigue cost). **[HIGH]**
- **Fatigue:** error odds rise on 12.5h+ shifts — ~3× (US, Rogers 2004) but
  ~1.2–1.4× in European replication; model as a CURVE, not a cliff, and prefer
  the moderate multiplier. Crucially, **nurses PREFER 12h shifts** (fewer
  commutes, more days off) — so long shifts are a morale *bonus* AND a fatigue
  *cost*, a genuine trade-off, not strictly bad. **[HIGH]**
- **Night differential:** nights cost more — federal statutory **10%**, nursing
  ~10–15%. Weekend premium ~25%. **[HIGH/MED]**
- **Agency/overtime ≈ 2× base rate** — the expensive emergency gap-filler; a
  natural late-game lever. **[HIGH]**

## 4. The code, mapped (the implementer's blast radius)

Two existing mechanisms make this NOT fully greenfield — both are battle-tested
templates:

- **`firing` (deferred removal)** — `world.ts:1103-1128`: a busy staffer flagged
  `firing` stops taking new work, finishes the live reservation, then leaves.
  **This is the exact "end of shift: stop, hand off, walk off" pattern** —
  Stage 1 reuses it. `availableStaff` already excludes `firing` staff
  (`dispatcher.ts:174`).
- **Patient `needBreak` sub-state** — `patientNeeds.ts`, `patient.ts:64-77`: a
  meter-triggered side-trip that is a SUB-state, not a lifecycle stage, and the
  dispatcher skips it (`dispatcher.ts:471-477`). **This is the 1:1 template for
  the Stage-2 staff lunch.**

The load-bearing facts:
- **Time:** 12h = 2,400 ticks; a shift boundary every `TICKS_PER_DAY/2`. Pure
  `tick` arithmetic → deterministic, mirrors `updateEconomy`'s hourly gate.
- **THE ANTI-CAPTURE HAZARD (confirmed):** the ED ratio guard means "a ratio
  nurse never returns to `idle` while any bay is live" (`dispatcher.ts:186-196`).
  So a shift boundary gated on idleness would let her **work forever past her
  shift.** The boundary MUST be enforced independently of idle — the `firing`
  precedent (exclude from `availableStaff`, finish live work, then leave) is
  exactly that. This is the single most important implementation subtlety.
- **Payroll gate:** `economy.ts:9` sums `salaryPerDay` over ALL staff with no
  duty gate. The design choice is §6.
- **Standing posts** (receptionist/greeter): re-derived from `idleStaff` each
  tick, so an off-shift receptionist won't be re-posted — but a currently-posted
  one needs an explicit un-post at the boundary (`sellRoom`'s un-post block,
  `world.ts:1006-1012`, is the precedent). An unposted reception stalls check-in
  — the 24/7 coverage problem made visible.
- **Save:** a new `Staff` field breaks `SavedStaff` compile by design
  (`save.ts:145-154`) → forces the schema decision; read-time-default migration
  + `SAVE_VERSION 12` (the `readRoom.closed` v10 precedent).

## 5. Staging — three stages, each measurable, Stage 1 load-bearing

**Stage 1 — TWO-SHIFT COVERAGE (the economic rebalance).**
Day shift / night shift, 12h each, with a handoff-overlap window at each
changeover. Each staffer is assigned a shift; off-shift staff leave the
available pool and walk home (off-map). You must hire to cover both shifts or
the hospital is unstaffed at night. Payroll for the whole roster (§6). **This
alone roughly doubles the minimum viable roster and re-tunes the M4 economy — it
is a whole stage, and it needs the measurement pass before any number ships.**

**Stage 2 — LUNCHES + THE STAFF LOUNGE (the owner's second ask + the lounge).**
The 30-min mid-shift break on the `needBreak` template; the lounge room in the
Comfort dropdown; break coverage (a staffer on break leaves the pool, so you
need slack or quality drops). This couples the two owner asks — a lunch break is
a shift concept, which is why the lounge belongs here and not alone.

**Stage 3 — THE TRADE-OFFS (fatigue, differential, agency).**
End-of-shift fatigue as a quality/error curve (moderate multiplier, not a
cliff); the 12h-preference morale bonus that offsets it; night differential
(+10–15%); agency/overtime as a ~2× emergency gap-filler. These make shifts a
*decision* rather than pure overhead.

Each stage is independently valuable and shippable. **Do NOT build all three at
once** — that is the observation mistake (an unreviewable single drop). Stage 1
is the contract to write first.

## 6. Stage 1 balance — MEASURE it, do not assert it

**The observation lesson, applied from the start:** v1/v2 of that epic asserted
balance twice and were wrong twice the same way, and v3 leaned on a flattering
metric (occupancy) while the deciding one (discharge rate) was omitted. This
plan commits Stage 1 to a **probe measured before the contract's balance section
is written**, reporting the DECIDING metrics up front:

- **Does the economy survive 2× payroll?** The harness roster ~doubles
  (~$3,060 → ~$6,120/day if both shifts staffed). Revenue must cover it or the
  game is unwinnable. This is the whole question.
- **The deciding metrics** (state them before measuring): profit/day at day-only
  vs 24/7 coverage; the night arrival share (how many patients a day-only player
  forgoes — `timeOfDayMultiplier` already dips at night, so this may be small);
  deaths/walkouts during unstaffed night hours; and whether "day-only early,
  24/7 later" is a real progression or a trap.
- **The design fork the measurement informs:** (a) charge the whole roster
  (payroll doubles, coverage is the constraint — realistic, creates the
  tension); vs (b) charge only on-shift staff (removes the tension — hiring 2 to
  cover 1 costs the same as today). **(a) is the owner's intent**, but the
  measurement decides whether the M4 economy can bear it or whether arrivals/fees
  need a companion re-tune.

**No Stage-1 balance number ships until the probe has run on both layout arms
(LAYOUT_PLAN §3.4).**

## 7. Save impact — SAVE_VERSION 12

A per-staffer shift assignment (day/night, and a stagger anchor for overlap) is
new saved state on `Staff`. It breaks `SavedStaff` compile by design, forcing
the schema addition; read-time default (`shift: saveVersion < 12 ? <derived> :
…`) + `SAVE_VERSION 12`. Adds NO role and NO condition, so unlike observation it
does not re-pin seeds on those grounds — but a new field on the world-construction
path may still shift draws; the re-pin is derived mechanically, never predicted.
The bump also serves the OTHER direction (an older deployed build opening a
shift-bearing save), the v9/v10 precedent.

## 8. Tests the Stage-1 contract must own

- **`harness.test.ts:96`** — the $3,060/day payroll figure and the "operating
  envelope stays green" premise. Doubling coverage changes both; the harness
  roster and its downstream per-condition discharge floors must be re-tuned WITH
  the change and proven green.
- **`edProbe.test.ts:118,244`** — `payrollPerDay` summed from the roster, and
  idle-nurse counting via `duty.kind === 'idle'` (the exact proxy a shift system
  perturbs).
- **`edRatio.test.ts`, `maintenance.test.ts`** — direct `duty = { kind: 'idle' }`
  manipulation and the anti-capture "never returns to idle" characterization.
- **`save.test.ts`** — the v11→v12 gate (real downgrade helper, `:840-860`).
- Any roster/payroll/cash assertion across `finance`, `audit`, `challenge*`,
  `anesthesia`, `m3Roster`.

## 9. What a Stage-1 CONTRACT must settle

1. **Shift model:** two fixed shifts (day/night) is the recommendation — is
   rotating (a nurse alternating day↔night over game-days) in or out of Stage 1?
   (Research: the owner means the changeover, not circadian rotation — so OUT.)
2. **The overlap window:** how long (15–30 game-min ≈ 50–100 ticks), and does it
   do anything mechanically in Stage 1 (continuity) or is it just a staffing
   window until Stage 3's quality mechanic?
3. **Off-shift staff:** walk home off-map (freeing the tile) vs stand idle
   off-pool? Home is cleaner and reads correctly; confirm the walk-off reuses
   `setWalkerTarget` + entrance.
4. **Payroll fork (§6a vs 6b)** — settle with the measurement.
5. **Shift assignment:** who decides which staffer is day vs night — auto-split
   the roster, or a player control? Auto for Stage 1; a scheduling UI is later.
6. **Standing-post coverage** — the un-post-at-boundary path, and what a
   nightless reception does to check-in (measured, not assumed).
7. **The anti-capture-independent boundary** — the firing-pattern releaser, with
   a regression that a ratio nurse mid-bay actually goes off shift.
8. **The measurement protocol** — deciding metrics stated first, both arms.

## 10. What the research could NOT establish — carried, not laundered

- No single canonical citable "4.2" source (it is an arithmetic identity, and
  before-time-off; true loaded headcount ~4.6–5.3).
- No current US national 12h-vs-8h split (best is 2013, 4 states).
- The exact odds ratio for "3× errors past 12.5h" (abstract says "significantly
  increased"; the 3× is via secondary CDC/NIOSH tables).
- US prevalence of rotating vs fixed nursing schedules (no clean BLS/ANA split).
- Occupation-specific $/hr night differential for nurses (federal statutory 10%
  is the firm anchor; 15% rests on industry sources).
- No binding standard prescribing a specific paid overlap duration (15/30 min is
  best-practice guidance).

## 11. Sources

- Stimpfel & Aiken, *J Nursing Care Quality* 2013 — 12h shift prevalence (PMC3786347)
- Rogers et al., *Health Affairs* 2004 — long shifts and errors (PMID 15318582)
- Stimpfel et al., *Health Affairs* 2012 — 12h shifts, burnout, patient experience
- Dall'Ora et al., RN4CAST 2015 — European replication (PMC4577950)
- Geiger-Brown et al. 2012 — end-of-shift fatigue (PMID 22324559)
- ANA position statement — nurse fatigue (≤12h, 2 rest days after 3 consecutive)
- Cal. Title 22 §70217 — mandated ratios (ICU 1:2, med-surg 1:5, ED 1:4)
- AHA *Cost of Caring* 2025; Kaufman Hall — labor as ~55% of hospital cost
- DOL Fact Sheet #53; OPM night-differential fact sheet; AHRQ BSR handbook
