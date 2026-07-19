# The outpatient stream — implementation contract (v2)

**Status:** v2, both pre-implementation reviews folded. Ready to implement.
**Parent:** `docs/IMAGING_PLAN.md` §4 direction C.
**Owner decision (2026-07-19):** add the outpatient stream.
**Unblocks:** Departments Stage 2a, blocked since `DEPARTMENTS_PLAN` §4.4 for
want of any reason to build a second scanner.

**v1 → v2:** the code review returned NOT READY (8 MAJOR) and the design review
IMPLEMENT AFTER FIXES (5 MAJOR). §9 records what changed and why, including
five claims of mine that were wrong. Every `file:line` here was verified by at
least one reviewer against source.

---

## 1. Why

`IMAGING_PLAN` §2.3: **MRI is ~83% elective/outpatient.** Hospital Simms has
exactly one demand channel — emergency walk-ins — so a busy MRI or
nuclear-medicine suite is **structurally unreachable**. Measured: MRI 3.9%,
nucMed 3.3% utilisation.

**NOT in scope:** the chain inversion (`IMAGING_PLAN` §4A / `ED_PLAN` Stage C)
or the modality mix (§4B/§4D). Kept separate so their effects measure apart.

## 2. THE DESIGN DECISION — room-gating

**The elective roll fires only for modalities the player has BUILT**, with
weights renormalised over available rooms.

Both reviewers converged on this independently, and it resolves **four** MAJORs
at once:

1. **It saturates.** Ungated at `perGameHour: 1.0`, volume splits four ways and
   MRI reaches 12.5% — clearing this document's own failure line (8%) while
   still missing saturation by an order of magnitude. `DEPARTMENTS_PLAN` §4.3
   blocked Stage 2a at ρ=0.074 with *"a second server recovers essentially
   nothing"*; that argument is unchanged at ρ=0.125. **Gated, a player who has
   built an MRI and nothing else receives all ~10 referrals/day = 468 room-min
   = ~78% of the clinic window.** That is a queue, and a real second-suite
   decision.
2. **It kills the first-run death spiral** (§2.4).
3. **It converts an imposed tax into a business decision** (§2.5).
4. **It makes the $18,000 MRI pay back** — precisely what `DEPARTMENTS_PLAN`
   §4.3 Finding 1 said was missing.

The stream becomes **opt-in by construction**: build a scanner, get referrals.

### 2.1 `checkingIn → waiting` is currently ILLEGAL

`entities/patient.ts:38`:
```ts
checkingIn: ['queuedCheckIn', 'waitingTriage', 'atEntrance', 'leaving', 'dead'],
```
`World.setPatientStage` validates against this, records violations, and the
harness and audit tests assert the counter stays empty (`INVARIANTS.md`).

**Adding `'waiting'` is a deliberate widening of a safety guard.** The
argument: an outpatient genuinely has no triage step, and the table exists to
catch *unintended* transitions, not to forbid a modelled one. The paired
semantic invariant — **`waiting` requires `acuity !== null`** (`world.ts:174`) —
is what keeps it safe, and §3.3 sets acuity at spawn so it holds by
construction.

**The save border needs no change** — `readPatientStage` (`save.ts:623-640`)
accepts `waiting` unconditionally and does not validate transitions (verified
by the code review).

### 2.2 Roster-reachability guards — TWO files, not one

`test/expansion1.test.ts:226-234` **and** `test/m3Roster.test.ts:73-90` both
assert every `CONDITION_ID` is reachable from `rollCondition`. v1 named only
the first.

Both must be **AMENDED deliberately** to the true invariant: *every condition
is reachable from ITS OWN stream*, plus the inverse guard that **no id is
reachable from BOTH**.

> **Precedent and trap:** Departments Stage 1 amended `data.test.ts`'s
> room-usage guard (`used || EXEMPT || RETIRED`) plus an inverse guard —
> deliberately NOT by filing `resp` under the exempt list, which "would have
> mislabelled it and permanently disarmed the guard."

### 2.3 The `needs.ts` triage hint — real, but NOT the guard hazard v1 claimed

v1 claimed elective patients would book phantom triage demand and disable
ED_PLAN §5b's anti-capture guard hospital-wide. **That was wrong.**
`blockedDemand` books triage demand only for `stage.kind === 'waitingTriage'`
(`needs.ts:457-459`), which electives never enter. The claim is retracted and
v1's test 20 would have passed on unmodified `main` — a test certifying a
no-op fix.

**What is real:**
- **The hint** (`needs.ts:132-136`): `CHECK_IN_STAGES` includes `checkingIn`, so
  every checking-in outpatient raises a "Build a Triage Bay" / "Hire a Nurse"
  row for resources they never use. MEDIUM, fixed by gating that scan.
- **A genuine cross-stream coupling neither v1 nor I saw:** an elective in
  `waiting` books **legitimate** demand on its imaging room
  (`needs.ts:461-463`), which flows into `starvingDemand` and can switch off
  ratio extension for `radTech` **in other rooms**. Recorded and measured
  (§6), not "fixed" — it is correct behaviour with a new consequence.

### 2.4 First-run: without gating, a reputation death spiral

`setupNewGame` (`newGame.ts:9-33`) starts with reception + waiting only.
Ungated, referrals begin day 1 hour 8, find no scanner, and walk out ~8.3
game-hours later at −8 rep each → **up to −80 rep/day against a starting 300**,
flooring reputation in under four days. Meanwhile `needs.ts:143` raises
"Build an MRI" — **$18,000, 36% of starting cash** — as an *urgent* need on day
one, contradicting `GAME_DESIGN` §9's onboarding within ten game-hours.

**And the measurement plan was structurally blind to it**: both the harness and
`edProbe` build all five imaging rooms. §6 adds a bare-build arm.

§2's gating removes this entirely.

### 2.5 Clinic hours need a lever, and gating is it

v1 called clinic-hours overlap "the interesting tension." It is not a tension
without a lever: the player cannot reschedule, cap, defer or close the clinic.
Gating makes the *only* response — build the scanner — also the thing that
starts the stream. That is a decision rather than a tax.

**Deliberate omission, recorded:** the elective rate does NOT scale with
`reputationArrivalMultiplier`, so a struggling hospital gets proportionally
more elective load. Referrals are contracted work, not walk-in demand, so this
is defensible — but it is a choice, not an oversight.

## 3. Frozen contract

### 3.1 Data — `src/sim/data/conditions.ts`

```ts
interface ConditionDef {
  readonly label: string;
  readonly acuityMin: number;
  readonly acuityMax: number;
  readonly steps: readonly TreatmentStep[];
  /** Elective referral: arrives pre-triaged from the outpatient stream, never
   *  from the emergency mix. Absent = emergency (every existing condition). */
  readonly elective?: true;
}

/** Derived SSOT — the type-level partition the two streams need. */
export type ElectiveConditionId = {
  [K in ConditionId]: (typeof CONDITION_DEFS)[K] extends { elective: true } ? K : never;
}[ConditionId];
export const ELECTIVE_CONDITION_IDS: readonly ElectiveConditionId[];
export const EMERGENCY_CONDITION_IDS: readonly Exclude<ConditionId, ElectiveConditionId>[];
```

The derived type is **load-bearing**: without it `outpatient.weights` cannot be
typed and `rollElectiveCondition` does not compile (code review MAJOR 2).

**v1 conditions — MRI and nuclear medicine ONLY:**

| id | label | room | roles | duration | fee |
|---|---|---|---|---|---|
| `mriScan` | MRI Scan (referral) | `mri` | `['radTech']` | 40 | **500** |
| `nucMedScan` | Nuclear Medicine Scan (referral) | `nucMed` | `['radTech']` | 45 | **450** |

Both `acuityMin: 5, acuityMax: 5`.

**Why only these two.** They are the modalities `IMAGING_PLAN` §2.3 identifies
as outpatient businesses and the two rooms this milestone exists to rescue.
v1's table also carried `screeningXray` (weight 14 — the *largest*) and
`screeningUltrasound` (8), pouring the biggest tranche of elective volume into
the modality §3 already calls "about right" and the one it calls "~3× over".
**The weight table contradicted the milestone's own thesis.** Deferred to v2 of
this feature, once the mechanism is proven.

> `roles` was omitted from v1's table entirely and would have gone red on
> `data.test.ts:43-53`. Note for the deferred pair: **`ultrasound` is staffed by
> `sonographer`, not `radTech`** (`rooms.ts:290`) — adding `radTech` to
> `ultrasound.staffedBy` to "fix" it would silently change staffing for the
> existing `gallstones`/`appendicitis` chains.

**Fees match the identical existing steps by construction** — `backInjury`'s
MRI step bills 500 (`conditions.ts:122`), `thyroid`'s nuclear step bills 450
(`conditions.ts:136`). v1 proposed 900/1,100, which made an elective nuclear
scan **$24.4/room-minute against a stroke's $13.9** and **3.3× more profitable
per STAFF-minute**, because it needs one radTech and nothing else. That
rewards starving your own ED. Matching the existing step fee makes the
arbitrage **exactly zero**, and any residual is inherited balance rather than
invented here.

### 3.2 Balance — `src/sim/data/balance.ts`

```ts
arrivals: {
  /** IMAGING_PLAN §4C — the elective stream. Independent of the emergency
   *  curve so the two measure and tune apart. */
  outpatient: {
    /** Referrals per game-hour during clinic hours, BEFORE room-gating. */
    perGameHour: 1.0,
    openHour: 8,
    closeHour: 18,
    /** Weights over elective conditions; renormalised over BUILT rooms (§2). */
    weights: { mriScan: 10, nucMedScan: 6 } satisfies Record<ElectiveConditionId, number>,
  },
},
reputation: {
  /** An elective no-show is not an abandoned emergency. Symmetric with the +2
   *  `dischargeReputationGain(5)` an elective discharge earns, so the stream
   *  is reputation-neutral in expectation rather than a liability (§3.6). */
  electiveNoShowLoss: 2,
}
```

Elective ids ALSO carry `conditionWeights: 0` — a **compile requirement**
(`formulas.ts:137` indexes by `ConditionId`), not a balance choice. See §4.

### 3.3 Sim

```ts
spawnPatient(condition: ConditionId, opts?: { acuity?: number }): Patient;

/** Weighted roll over elective conditions WHOSE STEP ROOM EXISTS (§2).
 *  Returns null when the player owns none — the gate. */
export function rollElectiveCondition(world: World): ElectiveConditionId | null;
```

`updateSpawn` gains a second Bernoulli, **ordered after** the emergency roll:
```ts
const o = BALANCE.arrivals.outpatient;
if (world.clock.hourOfDay >= o.openHour && world.clock.hourOfDay < o.closeHour) {
  if (world.rng.chance(o.perGameHour / TICKS_PER_GAME_HOUR)) {
    const id = rollElectiveCondition(world);
    if (id !== null) world.spawnPatient(id, { acuity: CONDITION_DEFS[id].acuityMax });
  }
}
```

**The clinic-hours check sits OUTSIDE `chance`** — `rng.chance` consumes a draw
unconditionally (`rng.ts:31-33`), so this is what keeps pre-clinic ticks
bit-identical (§4). **The room-gate sits INSIDE**, after the draw, so gating
does not itself perturb the stream.

`rollCondition` iterates **`EMERGENCY_CONDITION_IDS`**, not `CONDITION_IDS` —
which also fixes its float-residue fallback (`spawn.ts:17`) returning the last
table entry, now an elective.

### 3.4 Check-in routing

```ts
const elective = CONDITION_DEFS[patient.condition].elective === true;
world.setPatientStage(patient, elective ? { kind: 'waiting' } : { kind: 'waitingTriage' });
```
No new `Patient` field; the stream derives from the condition, which is already
saved.

### 3.5 Priority — `waitingSince` MUST reset, or electives outrank strokes

v1 claimed electives "queue behind every emergency **by construction**".
**False.** `effectivePriority = acuity − 0.5 × hoursWaited` (`formulas.ts:31`).
Emergency `waitingSince` resets at `completeTriage` (`treatment.ts:38-41`), so
their priority starts at raw acuity. An elective's is set once at check-in and
never reset — there is no triage step to reset it. At 8 game-hours an elective
prices at `5 − 4 = 1.0` and **outranks a freshly-triaged acuity-1 stroke** — and
8.3 hours is exactly its patience budget (§3.6).

**Frozen:** the elective's `waitingSince` is set at entry to `waiting`, so both
streams age from the same origin. Test 12b pins an aged elective still queueing
behind a fresh acuity-1.

### 3.6 Neglect: they leave, and it costs 2 not 8

At acuity 5, `healthPerGameHour: 2` and `patiencePerGameHour: 12`
(`balance.ts:90-91`): **~8.3 game-hours to walk out, ~50 to die.** Every
patience multiplier only shortens the first, so the margin is conservative. No
decay special-casing needed; an outpatient dying of a back MRI is unreachable.

**But flat `amaLoss` made the stream a reputation LIABILITY.**
`dischargeReputationGain(5)` = **+2**; `amaLoss` = **8**, flat
(`balance.ts:139`, `world.ts:2009`). Break-even walkout share is
`2(1−w) = 8w` → **w = 20%**, and the measured baseline walkout rate is already
~25% — with electives sorting last, theirs will be *higher* than average. At a
plausible 40–50%, ten referrals/day nets **≈ −25 rep/day**, roughly wiping out
the hospital's entire reputation growth, in a channel with no UI.

`electiveNoShowLoss: 2` (§3.2) makes discharge and no-show symmetric, touches
no emergency behaviour, and is one number with one test. **Acuity-scaling
`amaLoss` globally was rejected** — that is shared emergency behaviour and must
not ride in under this milestone.

### 3.7 Legibility — the minimum surface

Not deferrable, because §3.6 and §3.1 mean the stream can move reputation and
profit in a channel the player cannot see:
1. **Daily report: `Referrals: N seen, M no-show`.** Highest value — it
   surfaces the §3.6 break-even directly.
2. **Inspect card: a `Referral` tag** on elective patients. They arrive with an
   acuity and no triage history; unlabelled they read as a bug.
3. Finances channel split — genuinely deferred to v2.

Requires a mechanism, frozen here: `feeBilled` gains
`source: 'treatment' | 'vending' | 'outpatient'`, which also gives the
checklist a clean gate (§3.8).

### 3.8 Checklist

"Treat your first patient" completes on any `feeBilled` with
`source: 'treatment'` (`checklist.ts:68-70`), so an elective fee would tick it
without triage ever being built. Gate on the new `'outpatient'` source. Also
gate `seedFromWorld`'s `lifetimeTreated > 0` path, which would tick it on
reload. **Low severity under gating** — day 1 has no scanner, so it only
misfires if a player builds imaging before an exam room.

## 4. Determinism

`updateSpawn` currently consumes one `rng.chance` per tick plus one `next()` in
`rollCondition` on a hit. The second Bernoulli adds a draw **on clinic-hour
ticks only**, so:

- **Pre-clinic ticks are bit-identical to today.** `TICKS_PER_GAME_HOUR = 200`
  and the clock starts at hour 0, so ticks `[0, 1600)` are entirely pre-clinic —
  a real control window (test 8).
- **The streams diverge at the first clinic-hour tick, not at tick 0.** v1's §6
  claimed tick 0; that was stale. Elective ids carry `conditionWeights: 0`, so
  `rollCondition`'s total is **unchanged** and the emergency roll is
  bit-identical until the elective Bernoulli first fires.
- **The harness seed still re-pins** from that point. Budget it as milestone
  work — **re-pin, never weaken** (`INVARIANTS.md`).

## 5. Save decision (plan rule 6)

**`SAVE_VERSION` 10 → 11.** `save.ts:740` validates
`asOneOf(o.condition, CONDITION_IDS)`, so a save containing `mriScan` opened by
the currently deployed build dies on an unknown condition instead of refusing
cleanly. Adding condition ids has bumped the version every time — v1→v2
(`save.ts:38-49`) names conditions explicitly; v8→v9 (`save.ts:99-108`) states
the rule for roles.

**No new `Patient` field** (§3.4), so `SavedPatient`/`writePatient`/
`readPatient` are untouched and `loadWorld` needs no migration beyond the stamp
(no new `RoleId`, so `topUpCandidates` is unaffected — the v7 precedent).

**Owner note:** a bump is one-way on a live game. Saves written after this
deploys cannot be opened by the current build.

## 6. Measurement

Both layout arms, 5 seeds × 5 days, before and after — plus **a bare-build arm**
(`setupNewGame` only, no imaging) that §2.4's regression requires and that no
existing arm can see.

Required columns:
- Per-room utilisation for all five imaging rooms; **radTech utilisation** (and
  `sonographer` if the deferred pair ever lands).
- **Emergency-only wait time and emergency-only walkouts as first-class
  columns.** Merged metrics would *mask* the harm: electives skip triage and
  post structurally shorter waits, deflating the average (§3.7 of v1).
- **Elective walkout rate** — §3.6's break-even is 20%.
- Reputation/day, split by stream where derivable.

**Predicted in advance so nobody misreads it after the fact:** `LAYOUT_PLAN`
§3.2 shows REFERENCE is walking-bound and *suppresses* staff contention
(×7.5 on COMPACT). Extra radTech load will be absorbed by corridors on
REFERENCE and bite on COMPACT. **A green REFERENCE arm is not evidence of
safety.**

**Falsification conditions:**
- Emergency walkouts or wait rise materially on EITHER arm → do not ship as
  tuned.
- **Elective walkout rate > 20%** → the stream is reputation-negative.
- MRI utilisation does not approach saturation → the rate is too low; raise it,
  do not declare success.
- Bare-build arm shows any elective arrival → the gate is broken.

**Deaths are the WRONG headline metric** and v1 led with them. A blocking
elective scan delays a stroke ~39 min ≈ 8 health points; `successChance` is
flat above `lowHealthFloor: 30`, so the treatment roll is unaffected. The real
channels are **walkouts, waiting-room seat contention** (over-capacity waiters
take `standingMultiplier: 1.5` patience decay) **and radTech saturation**.

## 7. Test list

**Data (`test/data.test.ts`)**
1. `CONDITION_IDS` partitions exactly into `EMERGENCY_CONDITION_IDS ∪
   ELECTIVE_CONDITION_IDS`, empty intersection.
2. Every elective condition has exactly one step whose room is an imaging room,
   and `roles ⊆ ROOM_DEFS[room].staffedBy`.
3. `outpatient.weights` keys are exactly `ELECTIVE_CONDITION_IDS`.
4. Every elective condition has `acuityMin === acuityMax === 5`.
5. Every elective id has `conditionWeights === 0` (§4's determinism premise).

**Spawn (new `test/outpatient.test.ts`)**
6. `conditionSpawnWeights` returns finite values for every id; `rollCondition`
   never returns an elective id.
7. `rollElectiveCondition` returns only elective ids, and **only ones whose
   step room is built**.
8. **Returns null when no imaging room exists** — the §2 gate.
9. No elective spawn outside `[openHour, closeHour)`.
10. Pre-clinic ticks are rng-bit-identical to a pinned literal captured from
    the current build, and no elective patient exists (§4's control window).
11. Roster reachability, AMENDED in **both** `expansion1.test.ts` and
    `m3Roster.test.ts`: every emergency id reachable from `rollCondition`,
    every elective id from `rollElectiveCondition`, union exhaustive, **and no
    id reachable from both**.

**Lifecycle (`test/outpatient.test.ts`)**
12. An elective goes `checkingIn → waiting` with acuity set;
    `world.stageViolations` stays empty.
12b. **An elective aged 8+ game-hours still queues behind a freshly-triaged
    acuity-1** (§3.5's reset). Must FAIL without the reset.
13. An emergency still goes `checkingIn → waitingTriage`.
14. An elective completing its step is discharged and billed with
    `source: 'outpatient'`.
15. A neglected elective walks out before dying, and costs
    `electiveNoShowLoss`, not `amaLoss` (§3.6).

**Needs (`test/needs.test.ts`)**
16. A checking-in elective raises no `room:triage` / `role:nurse` need (§2.3).
17. An elective in `waiting` DOES book demand on its imaging room — pinning the
    §2.3 cross-stream coupling as known behaviour, not accident.

**Reporting**
18. An outpatient fee does not complete the checklist's "Treat your first
    patient", including via `seedFromWorld` on reload (§3.8).
19. `waitSumTicks`/`waitCount` exclude electives, so the day-close wait bonus is
    unchanged by outpatient volume.
20. The daily report renders the referrals line; the inspect card renders the
    `Referral` tag (§3.7).

**Save (`test/save.test.ts`)**
21. Round-trip byte-identity with an elective patient mid-study;
    `SAVE_VERSION` is 11.
22. A pre-v11 fixture still loads, filtering post-version conditions **by
    name** (the anesthesia MAJOR-4 precedent — arithmetic on roster length
    silently hollows out as the roster grows).

**Harness (`test/harness.test.ts`)**
23. Per-condition discharge floor ≥1 for `mriScan` and `nucMedScan`.
24. The black-envelope assertion holds with the stream active.

## 8. Open risks

1. **Does it unblock Departments?** §2's gating should saturate MRI at ~78% of
   the clinic window for a single-scanner player. **If §6 shows otherwise, the
   milestone has not delivered** — raise the rate, do not declare success.
2. **radTech saturation is the POINT and the risk.** Elective load alone is
   ~78% of clinic-hour radTech capacity before any ED imaging, forcing a third
   tech. That is `DEPARTMENTS_PLAN` §4.3's "never exercised" bottleneck finally
   being exercised — you cannot have the prize without the pressure.
3. **Waiting-room seat contention** (§6) — ten extra bodies/day in a 6-chair
   room push emergencies into 1.5× standing patience decay. Unmodelled.
4. **The §2.3 cross-stream coupling** — elective demand can switch off ratio
   extension for radTech in other rooms. Correct behaviour, new consequence.
5. **Fees are anchored to existing steps, not evidence** (`IMAGING_PLAN` §2.5
   found none). Anchoring makes arbitrage zero; it does not make the underlying
   numbers right.

## 9. What changed from v1, and what I got wrong

Recorded because the errors are instructive.

**Reversed:**
- **No-bump → `SAVE_VERSION` 11.** I hedged ("I lean no-bump; I am not
  confident"). The lean was wrong; precedent is direct.
- **Four conditions → two.** v1's weights sent the largest tranche to `xray`,
  contradicting the milestone's own thesis.
- **Fees 900/1,100 → 500/450.** v1's made electives out-earn every emergency
  bar one, per staff-minute by 3.3×.
- **Ungated → room-gated.** The single change that fixes saturation, first-run,
  the missing lever, and MRI payback together.

**Wrong, and retracted:**
- **The NaN corruption claim (v1 §2.2)** — it is a compile error. But my
  retraction was then *over-broad*: elective ids must still carry
  `conditionWeights: 0`, and without that the NaN returns.
- **"Phantom triage demand disables the §5b guard"** — impossible;
  `blockedDemand` only books triage demand for `waitingTriage`. My test for it
  would have passed on unmodified `main`.
- **"Electives queue behind emergencies by construction"** — false without a
  `waitingSince` reset; an aged elective outranks a fresh stroke.
- **"Shifts the seed from tick 0"** — no; divergence starts at the first
  clinic-hour tick.
- **Deaths as the headline risk** — the real channel is walkouts.

**Missed entirely:** `roles` (and that `ultrasound` is sonographer-staffed);
the second reachability guard in `m3Roster.test.ts`; the derived
`ElectiveConditionId` type without which nothing compiles; the first-run
death spiral; the bare-build measurement blind spot.
