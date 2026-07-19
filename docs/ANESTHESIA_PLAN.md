# The anesthesiologist — design + implementation plan (v2)

**Status: IMPLEMENTED 2026-07-18** (SAVE_VERSION 9, 585 tests, all gates
green — see the `*(anesthesia)*` row in `docs/HANDOFF.md`). Built from v2
below as written. Shipped deltas: the re-pin sweep §6 feared did NOT
materialize (only 2 tests changed, both semantic — the fixed-seed suites
assert properties, not rng values); the backward fixtures gained a shared
`expectPoolLacks` helper; and the `freeInteriorTile` door-tile NIT was left
banked as §8b says.

**Original status: v2 — one adversarial pre-implementation review folded
(4 MAJOR / 6 MINOR / 3 NIT).** The review verified the plan's claims
against real code and confirmed several as sound (the gather scales to N roles
and CANNOT deadlock; `topUpCandidates` handles migration; `needs.ts` needs no
change; the render/hire/directory surfaces all derive from `ROLE_IDS` and need
no per-role work; the fee arithmetic covers the new salary). What it broke:

- **MAJOR 1 — the harness reference build hires no anesthesiologist**, so the
  black-envelope gate would fail *unconditionally* and no re-pin could fix it.
  v1 framed the harness work as re-pinning; the required change is a ROSTER
  change. Folded into §4/§6/§8.
- **MAJOR 2 — the anesthesiologist has no competing demand, so it does not
  make the gather meaningfully harder, and it does not touch the contention
  §1 diagnoses.** The binding constraint stays the NURSE. v1's compensation
  was therefore calibrated against a largely illusory cost — masking, not
  fixing — while the owner's actual symptom (an idle, expensive OR bench) got
  worse. This is the finding that reshapes the milestone: see §4 lever 4.
- **MAJOR 3 — a failed gather gives its partially-secured staff away to
  lower-priority patients in the same tick.** No deadlock (nothing is
  committed), but starvation: surgery gathers surgeon+nurse, misses the
  anesthesiologist, `continue`s, and the nurse it just let go is taken by a
  lower-priority exam patient later in the SAME loop. With two roles that
  needs two coincidences; with three, three. v1's "no dispatcher changes"
  ruled out the only real fix. Folded as §4 lever 4 + §6.
- **MAJOR 4 — the backward-compat save fixtures would go green while silently
  ceasing to test the pre-role case** (they filter roles by name but assert
  their premise by counting `ROLE_IDS.length`, which stays true as the roster
  grows). This is the hollowed-by-re-pin class §6 warns about, in the very
  test that guards the v1→v2 surgeon bug. Folded into §7/§8.

Owner ask
(2026-07-18): *"we need to add an anesthesiologist to the Operating room
staff… I would want the game to actually model anesthesiology, that's a real
feature."* Companion to `GAME_DESIGN.md` / `TECH_PLAN.md`; CLAUDE.md hard
rules govern. All numbers are **initial values** — `balance.ts` is
authoritative at implementation.

**Owner ruling already taken (2026-07-18):** the anesthesiologist is a **THIRD
role on the surgery step, WITH balance compensation** so the OR does not
simply stall harder. The two rejected alternatives, for the record: replacing
the nurse (easier to staff, but does not model a real OR team) and adding the
third role bare (realistic, but strictly worsens the reported symptom).

## 1. The problem this solves

The owner's diagnosis, verified against the code: `nurse` is the `staffedBy`
role for **five** rooms — triage, exam, ER, dialysis and surgery
(`rooms.ts:172/184/225/310/333`) — making it by far the most contended role in
the game. Surgery reservations are **all-or-nothing**: the dispatcher gathers
every required role or reserves nothing. So a nurse dispatched to triage
leaves a hired, idle, $500/day surgeon standing still, and the player's only
current remedy is "hire another nurse", which is neither obvious nor
thematically satisfying.

Modelling anesthesiology fixes the *fiction* (a real OR does not run on a
surgeon and a spare nurse) and gives the contention a **name** — the blocked
panel can say "Hire an Anesthesiologist — needed for Gallstones" instead of
leaving the player to infer a nurse shortage.

**The honest tradeoff this plan must pay for:** three simultaneous staff is a
harder gather than two. Section 4 is the compensation, and it is not optional
— without it this milestone makes the owner's reported symptom worse.

**What the review corrected here (MAJOR 2), and it matters:** the
anesthesiologist has NO competing demand — surgery is its only consumer, so
it is idle whenever it is not operating. The three-way gather's binding
constraint therefore remains **exactly the nurse**, and worse, `assignTriage`
runs BEFORE `assignTreatment` every tick and drains idle nurses
unconditionally, one per waiting-triage patient. So adding a third role does
not really make the gather harder in the way v1 assumed — which means
shortening durations to "buy back" that cost was masking a problem rather
than fixing one, while the player's actual experience (an idle bench that now
costs $920/day instead of $500) got worse. **Lever 4 in §4 is the fix, and it
is the one that earns this milestone.**

## 2. The role

```ts
anesthesiologist: {
  label: 'Anesthesiologist',
  salaryPerDay: 420,        // between nurse (150) and surgeon (500)
  color: 0xc1121f,          // crimson
  standingPost: false,
}
```

- **Salary 420.** Real anesthesiologists earn near surgeons; game-side this is
  the brake that stops "just hire three of them" being free. Combined with a
  surgeon that is now $920/day of OR payroll before a single case — §4's fee
  raise is what keeps the OR solvent.
- **Colour: crimson `0xc1121f`.** The art review's standing complaint is a
  green cluster (nurse teal `2a9d8f`, respTherapist `52b788`, surgeon
  `2d6a4f`). Crimson is clear of all ten existing role colours: nothing else
  is red (greeter is yellow `e9c46a`, maintenance orange `e07a3f`,
  receptionist light purple `c98bdb`). Semantic collisions were CHECKED by the
  review and are clear: critical-patient cues are emoji glyphs not tints, the
  `bad` tone is CSS-only, the hazard decal is yellow, the invalid-build ghost
  is transient salmon. The one standing red OBJECT in the world is the vending
  machine (`PROP_STYLE.vending = 0xc44b4b`) — so verify on screen **with a
  vending machine in frame**, not against the mood bubble.
- `standingPost: false` — dispatched like every clinical role, never posted.

## 3. Where it is required

Both surgery steps and the room's `staffedBy` gain the role. There are exactly
two surgery steps today (`conditions.ts`): gallstones and appendicitis.

```ts
// rooms.ts
surgery.staffedBy = ['surgeon', 'nurse', 'anesthesiologist']
// conditions.ts — both steps
roles: ['surgeon', 'nurse', 'anesthesiologist']
```

**The `anesthesiaCart` prop stays decorative.** It is an OR prop, not a
staffable thing; the HINTS milestone explicitly declined to relabel it. This
plan does NOT couple the role to the prop — an OR with no cart still runs.

## 4. Balance compensation (the load-bearing half)

A three-way gather is strictly harder than a two-way one. Three levers,
smallest first; the harness decides the final numbers.

1. **Shorter surgeries.** Gallstones 120 → **90** game-minutes, appendicitis
   100 → **80**. The OR's throughput problem is occupancy × gather difficulty;
   shortening occupancy buys back part of the gather cost. (Correction, review
   NIT: 120 min was a TIE for longest, not the sole maximum — dialysis is also
   120. And a real consequence to watch: shorter surgeries mean MORE OR uses
   per day, wear is rolled per use, so the OR will break down more often — and
   a broken OR sets `capacityOf` to 0, blocking the three-role step entirely.
   If the harness shows OR downtime climbing, that is this lever's fault.)
2. **Higher fees.** Gallstones 1,500 → **2,000**; appendicitis 1,800 →
   **2,300**. This funds the third salary rather than making surgery a
   money-loser — the OR should read as the prestige, high-margin service that
   justifies three staff. (Note for the reviewer: fees are per-STEP, and both
   conditions bill an ultrasound step first, so total case revenue is higher
   than these numbers alone.)
3. **~~The contention hint~~ — CLAIM WITHDRAWN (review MINOR).** `needs.ts`
   fires only when a role is hired ZERO times, so it names a *missing* role,
   never a *busy* one. Contention is precisely the case where the role IS
   hired and the panel goes silent, so v1 oversold this. A genuine contention
   hint (role hired but all-busy beyond a threshold, room slot open, patient
   dispatchable) is real and worth doing — **banked, not in this milestone.**

4. **THE lever: a partial-gather soft hold in the dispatcher (review MAJOR 3
   — the fix v1 explicitly ruled out).** When the highest-priority
   dispatchable patient's step gathers SOME but not all of its roles, the
   staff it did secure are marked unavailable for the remainder of THIS
   tick's `assignTreatment` pass — a local `Set<staffId>`, discarded at the
   end of the pass. Nothing is committed, no new world state, no save impact.
   This is what stops a surgery that is one role short from handing its
   surgeon and nurse to a lower-priority exam patient in the same loop, only
   to find the anesthesiologist free next tick and the nurse gone. It is the
   difference between "three roles is viable" and "three roles starves".
   Note `dispatchHoldUntil` does NOT cover this — it arms only after a
   *cancellation*, never after a failed gather, so nothing ages surgery's
   claim today.

**Still explicitly NOT done:** no partial RESERVATIONS, no "surgery can start
without the anesthetist", no change to what all-or-nothing means. Flow rules
7/8 depend on it. Lever 4 changes only who may be *considered* within a single
dispatch pass — it commits nothing and survives no longer than the tick.

**The harness roster MUST gain the role (review MAJOR 1 — not a re-pin).**
`STANDARD_STAFF` (`test/harness.test.ts:72-87`) is a FIXED roster with no
anesthesiologist. The moment the role joins both surgery steps, the gather can
never succeed, gallstones and appendicitis discharge ZERO, and the
per-condition asserts fail — unconditionally, for every seed. An implementer
who reads §6 as "re-pin the numbers" will hunt §4 for a balance bug that does
not exist. So, explicitly: **`STANDARD_STAFF` gains
`{ role: 'anesthesiologist', count: 1 }`**, which moves roster payroll
$2,640 → $3,060/day (+16%) — a real tightening of the operating envelope the
balance pass must absorb.

**Harness gate:** the §12 black-envelope assertion requires every condition to
discharge ≥1 patient in the 5-day reference run. Gallstones and appendicitis
both route through the OR, so if the compensation is insufficient the harness
fails loudly — that is the balance test, and it must not be weakened to pass.

**One structural assertion at risk (review MINOR):**
`harness.test.ts:315-333` bounds `maxReservationAgeTicks` at
`lostReservationTimeout + 3 game-hours`, and a gathering reservation's life
includes the SLOWEST participant's walk — a third converging walker raises
that max, while shorter surgeries pull the other way. If it goes red, raise
the bound **with a written justification**; never re-seed to dodge it.

## 5. Hints

`computeBlockedNeeds` (`needs.ts:145`) already iterates `step.roles`, so a
third role is named automatically with **no code change** — verify by test
rather than by reading. The player should see "Hire an Anesthesiologist —
needed for Gallstones" in the blocked panel, and the urgent-need toast on the
same key scheme.

## 6. The fixed-seed re-pin (the mechanical risk)

**A new `RoleId` shifts every seeded stream from tick 0.** The World
constructor mints `candidatesPerRole` (3) candidates for every role in
`ROLE_IDS` order (`world.ts:201`), each consuming rng draws for name/age/skill
— so adding an eleventh role changes every subsequent draw in every fixed-seed
test. This is the third time (evs, maintenance, now this): the established
rule is **a new ROLE ships WITH its re-pins; re-pin, never weaken.**

- **Affected suites: derive MECHANICALLY from what the run turns red** — do
  not work from a list. v1 enumerated twelve files and the review found ~20
  more (`expansion1` — which explicitly tests the TWO-role surgery gather and
  must change — plus `m4`, `expand`, `capacity`, `amenities`, `mess`,
  `patientNeeds`, `m3*`, `challenge*`, `reviewGate`, `slice`, and the DOM
  suites). An incomplete list read as exhaustive is worse than no list.
- **Rewrite the comment at `harness.test.ts:265-270`**: it currently states
  that seed 1338 is deliberately NOT re-pinned because the finances bump added
  no role, and instructs a future reader that a red 1338 means an rng-order
  bug to be FOUND, not papered over. This milestone makes that false, and a
  stale guard is noise that will mislead the next person.
- Re-pin means updating **expected values**, never loosening an assertion into
  `toBeGreaterThan(0)`. If a re-pinned expectation looks *wrong* (a death rate
  that jumps, a discharge count that collapses), that is a BALANCE finding
  from §4, not a number to paste in.
- Record the seed rationale in-file, per the evs/maintenance precedent.

## 7. Saves

**`SAVE_VERSION` 8 → 9** (review MINOR — v1 said no bump, and that was the
wrong call). Roles are not saved state and `topUpCandidates` (`world.ts:241`,
called unconditionally from `save.ts:1738` after `restorePrivateState`)
genuinely handles forward migration — it refills every role in `ROLE_IDS` and
is a strict no-op on complete pools, so LOADING old saves needs no bump. The
bump is for the OTHER direction: `save.ts` validates roles with
`asOneOf(o.role, ROLE_IDS, …)`, so a save written by the new build and opened
by an older DEPLOYED build (Vercel auto-deploys; a cached tab is enough) would
die on an unknown role with a confusing shape error instead of the clean
"newer than this game understands" refusal. Every prior role addition (evs at
v5, maintenance at v6) shipped with a bump and therefore had that guard. Costs
one line plus a migration note; `isLoadableVersion` accepts 1..9 unchanged.

**The backward-compat fixtures must be UPDATED, not merely re-run (review
MAJOR 4).** `test/save.test.ts`'s "genuine v1/v3/v4/v5 pool" fixtures are
built by FILTERING named roles out of a current-code save, and their premise
assert counts `(ROLE_IDS.length - N) * candidatesPerRole`. That arithmetic
stays true as the roster grows, so after this milestone the fixtures would
retain anesthesiologist candidates **a real pre-role save could never have** —
going green while no longer testing the pre-role case at all. That is the
exact guard for the v1→v2 surgeon bug, hollowed out. So: add
`anesthesiologist` to the filter list of EVERY backward fixture (v1, v3, v4,
v5), and change the premise assert to ENUMERATE the roles the fixture is
supposed to lack rather than counting from `ROLE_IDS.length`.

Documented consequence, unchanged: topping up a deficit consumes rng draws and
ids, so a migrated world deliberately diverges from its origin version.

## 8. Test list

1. `ROLE_DEFS.anesthesiologist` exists; colour distinct from every other role
   (a mechanical all-pairs assertion, not an eyeball).
2. Surgery `staffedBy` and both condition steps require exactly
   `surgeon + nurse + anesthesiologist`.
3. A surgery reservation gathers all THREE and starts only when all three are
   bound; with any one missing, nothing is reserved (the all-or-nothing pin).
4. Releasing any one of the three cancels the reservation per Flow rule 8.
5. `computeBlockedNeeds` names the anesthesiologist for a gallstones patient
   with no such staff hired (§5, asserted not assumed).
6. A pre-role save fixture loads and offers hireable anesthesiologist
   candidates (§7).
7. Harness seed 1338 green after re-pin, with the per-condition discharge
   assertions INTACT — gallstones and appendicitis still discharge.
8. Payroll: three OR staff accrue to `tallyCash('payroll')` as expected (the
   finances epic's choke point, unchanged but now with a pricier OR).
9. **The lever-4 regression (review MAJOR 3):** one nurse, one surgeon, no
   anesthesiologist, a waiting exam patient AND a higher-priority surgery
   patient. Assert the exam patient does NOT take the nurse while surgery is
   one role short; then hire the anesthesiologist and assert the surgery
   reserves within one tick. This is the test that proves three roles is
   viable rather than starving.
10. **The updated backward fixtures (review MAJOR 4):** each of v1/v3/v4/v5
    lacks anesthesiologist candidates, its premise asserts the roles it is
    supposed to LACK by name (never by `ROLE_IDS.length` arithmetic), and it
    still proves `topUpCandidates` makes the role hireable after load.
11. `data.test.ts`'s structural invariants still hold (every step's roles can
    staff its room; every role is used somewhere) — satisfied only if §3
    changes `rooms.ts` AND `conditions.ts` together.

## 8b. Also update (review MINOR)

`docs/GAME_DESIGN.md` goes stale in four places and the workflow treats it as
the canonical roster: §the Operating Room room entry ("Surgeon + Nurse"), the
staff roster table (no anesthesiologist row), and the gallstones/appendicitis
condition chains. Descriptive, not authoritative for balance — but a reviewer
reads it as the roster of record, so it must not contradict the code.

Also banked from the review, not in scope: `freeInteriorTile` excludes the
patient's tile but NOT `room.door.inside` when picking staff standing spots, so
a third OR staffer raises the odds someone stands in the doorway. Harmless
under rule-14 pass-through; a free improvement if touched.

## 9. Workflow

Plan → **pre-implementation review** (this document) → implement → re-pin →
adversarial code review + live-drive review → fix ALL findings + a regression
test per MAJOR → gates green → HANDOFF entry → commit.
