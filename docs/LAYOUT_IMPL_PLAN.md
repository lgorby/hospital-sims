# The layout milestone — implementation contract

**Status:** DRAFT, awaiting two independent pre-implementation reviews.
**Parent:** `docs/LAYOUT_PLAN.md` (the scoping draft and the measurements).
**Owner scope decision (2026-07-19):** teaching **plus** releasing the staffer
during the patient's walk. The reservation-model rewrite (LAYOUT_PLAN §4.1c —
do not claim the slot until arrival) is explicitly NOT in this milestone.

Every claim about existing code carries a `file:line` verified against source
on 2026-07-19. Where something is an inference rather than a reading, it says
so.

---

## 1. Why this milestone exists

`LAYOUT_PLAN` §1 measured it: a triage reservation holds its room and its nurse
for a mean **40.8 game-min** against **9.6 min** of treatment, and **88.8% of
that gather is a nurse who has already arrived, standing in the room waiting
for the patient to walk there**. Staff arrival is 0.4%.

`LAYOUT_PLAN` §3.1 measured what layout is worth: same rooms, same staffing,
**identical payroll** — discharged **+34%**, died **−44%**, profit/day
**+60%**. And §3.2 found that sprawl was *hiding* staff contention.

The player is never told any of this. Worse, the one hint that fires names the
wrong cause.

**Two halves, and they are the same problem:**
- **Part A (teaching)** — make the cost visible, and stop the hint blaming the
  room for a walk.
- **Part B (the staffer release)** — stop locking a nurse for a walk she is not
  part of.

Part B does **not** fix room throughput (the slot is still held). That is
deliberate and is stated to the reviewers as a known limit, not hidden.

### 1.1 The walk that matters starts at the WAITING ROOM, not the entrance

`LAYOUT_PLAN` says "18 tiles from the entrance". **That framing is wrong and is
corrected here.** `assignWaitingSpot` (`world.ts:1786-1810`) seats waiting
patients in a `waiting` room, and `world.ts:1897` returns a released patient to
`waitingTriage`/`waiting`. So the walk that costs is **waiting room → target
room**.

Confirmed numerically: the reference waiting door (23,35) → triage door (12,29)
is 17 tiles × ~2.1 game-min/tile = **35.7 min**, against a measured gather of
**~36 min**. The model is right; the earlier description of it was not.

**This is load-bearing for §2.2:** a readout measured from the entrance would
be wrong for every room except the first, and would actively mislead on
downstream rooms.

---

## 2. Part A — teaching

### 2.1 The capacity hint (`needs.ts`) — THE live defect

Measured (`test/utilisationProbe.test.ts`): `capacity:triage` is shown **85.0%
of all ticks**, saying *"Triage Bay is busy — build another one"*, while triage
rooms are ACTIVE only **17.3%** of the time and a required-role staffer is
**IDLE in 68%** of the ticks the row is shown. `capacity:xray` — the case a
reviewer predicted — fires 0.4% and is NOT a defect.

**Root cause, not wording:** `capacityNeeds` (`needs.ts:334-375`) tests
`world.openSlots(r) > 0`, and `openSlots` subtracts ALL reservations regardless
of phase. A reservation still gathering — room held, patient walking — zeroes
the room exactly like a treatment in progress. The code then `continue`s
(`needs.ts:375`) past the staff branch, so it never asks whether anyone was
free.

**The fix is a new derivation, not a new string.** It is derivable from live
state with **zero new fields**:

```ts
// src/sim/needs.ts — exported for the hint AND its test.
/**
 * Is this room's capacity consumed by a GATHER that is waiting on the patient
 * to walk here, rather than by treatment? Uses the SAME arrival predicate as
 * `promoteGatheredReservations` (dispatcher.ts:816-817) so the diagnosis can
 * never drift from the thing it diagnoses.
 */
export function heldByWalk(world: World, room: Room): boolean;
```

Three outcomes for a room with no free slot, replacing today's one:

| state | label |
|---|---|
| held by a walk | `${label} is tied up waiting for patients to walk there — building it closer to the waiting room would free it sooner` |
| genuinely treating, `perProp` | *(unchanged)* `${label} is full — expand it to add ${noun}` |
| genuinely treating, `single` | *(unchanged)* `${label} is busy — build another one (it treats one patient at a time)` |

The key stays `capacity:${type}` and the row stays **PANEL-ONLY**
(`INVARIANTS.md`: a type-keyed `hintOnce` toast would announce a recurring
state exactly once per save).

> **Reviewers:** the contested `continue` at `needs.ts:375`. A reviewer wanted
> it removed so the staff branch also runs; I argued against, and **the
> measurement went against me** — my argument holds for a genuinely occupied
> room and fails for a gather-held one, which is the majority case. This
> contract does NOT remove the `continue`; it makes the room branch tell the
> truth instead. Challenge that: is a third row better than a corrected one?

### 2.2 Build-ghost walk-time readout

**Owner decision: use `findPath` for accuracy, not a Manhattan estimate.**
Manhattan ignores walls and doors and would undersell a room whose door faces
away — precisely the mistake the feature exists to prevent.

Affordable because the ghost is **input-keyed**: `drawGhost` early-returns on
an unchanged `lastGhostKey` (`renderer.ts:1017-1018`), so validators run ≤10/s,
not per frame. `findPath(grid, start, goal, varietySeed)`
(`astar.ts:41-45`) returns `GridPoint[] | null`.

```ts
// src/sim/formulas.ts — pure, sim-side, so UI and sim share one derivation.
/**
 * Game-minutes for a walker to cover `tiles` steps. The ONE conversion; the
 * ghost readout and any future estimate must both call it.
 */
export function walkGameMinutes(tiles: number): number;
```

```ts
// src/sim/world.ts — the origin question of §1.1 answered in ONE place.
/**
 * Where a patient would walk FROM to reach a new room: the waiting room they
 * would be seated in, falling back to the entrance when none exists (early
 * game, before a waiting room is built). Returns null if unreachable.
 */
walkOriginForNewRoom(): GridPoint;
```

Rendered by **appending to the existing price string**, never as a new writer:

```
Triage Bay 2×2 — $2,000 · ~14 min walk · click to place, drag to grow
```

> `hintLine.ts:1-15` documents a Stage-0 review MAJOR: three writers share this
> DOM line and a re-price clobbered a rejection reason one frame later. A
> fourth writer would reopen exactly that defect. Appending to the price keeps
> one writer and one geometry key.

**Unreachable ghost:** show no walk figure rather than a wrong one. Do not
invent a number when `findPath` returns null.

### 2.3 Inspect card — the live gather line

**Correction to an earlier proposal of mine:** I suggested a "mean gather"
line and called it derived. It is not — a mean over history needs accumulation,
i.e. a new `Room` field and a `SAVE_VERSION` bump. Dropped.

The genuinely derived line is the **live** one, rendered only while
`heldByWalk` is true:

```
Waiting for patient — 12 min
```

It shows the problem happening rather than a statistic about it.

> **Consistency note:** an earlier draft said this reads "the existing
> gathering reservation's elapsed ticks". The code map established that **no
> age field exists on `Reservation`** — no `gatheringSince`, and no scan
> anywhere keyed on reservation age. The elapsed figure therefore comes from
> `awaitingSince` (§3.3), which Part B adds. **That couples §2.3 to Part B:**
> if the reviews split the milestone and ship Part A alone, this line either
> drops or the field ships without the behaviour. Reviewers should say which.

### 2.4 Checklist

`checklist.ts:25` composes labels from the defs. The `triage` item gains
placement guidance in the same composed style. One line, no sim change, and it
lands at the exact moment the player chooses where to put their first room.

---

## 3. Part B — release the staffer during the patient's walk

### 3.1 The problem, precisely

`makeReservation` binds the room AND the staff at dispatch. The staffer's
`duty` becomes `reserved`, which makes them unavailable to `assignTriage`,
`assignJobsForRole` and `postStandingStaff` (all gate on `idle`). Measured
result: **39.4% of nurse time is "in a gather", overwhelmingly standing still**,
while 35.0% is idle and only 25.6% is treating.

### 3.2 THE THREE CRITICAL LINES — an unstaffed reservation self-destructs

A code map (2026-07-19) found that "staff-less reservation" is not one hazard
but a **cascade of three**, all from the same `members.length === 0`:

**(1) Vacuous promotion — `dispatcher.ts:817`:**
```ts
if (!members.every((m) => world.walkerArrived(m) && world.isInsideRoom(m.at, room))) continue;
```
`Array.prototype.every` returns `true` on `[]`. The reservation flips to
`active` the moment the patient stands in the room, with nobody there. Health
decay then pauses (`decay.ts:24`), `firstTreatedAtTick` is stamped and the
door-to-treatment metric polluted (`dispatcher.ts:828-832`).

**(2) `NaN` duration — `dispatcher.ts:841-846`:** `averageSkill` divides by
`members.length`, so `0/0 = NaN`. `attentionSkill` and `treatmentDurationTicks`
propagate NaN through `Math.min/max/round`, giving `ticksRemaining = NaN`.
`treatment.ts:12` tests `> 0`, which is **false for NaN** — so the treatment
resolves on its very first active tick.

**(3) `NaN` outcome roll — `treatment.ts:17-19`:** same `0/0` into
`successChance`, then `world.rng.chance(NaN)`. An rng draw is still consumed
(determinism holds) but the outcome is effectively pinned.

**Combined: an unstaffed room "treats" and resolves a patient in one tick.**

**(4) A fourth, found by the same map — `fireStaff` leaks it.** `fireStaff`
(`world.ts:1112`) and `releaseReservation` (`world.ts:1943`) both work through
`reservationsOfStaff`, which filters on `staffIds.includes`. **An unstaffed
reservation is in nobody's panel**, so firing the entire roster leaves it live,
holding a room slot, forever.

**(5) And the existing safety net silently disappears.** The stall check at
`dispatcher.ts:811` is `members.some(stalled)` — also **vacuously false** on
`[]`. Per §3.5, there is no other watchdog on a gathering reservation.

### 3.3 The chosen shape — REVISED after the code map

**This section previously chose "empty `staffIds` while `gathering`, no
SAVE_VERSION bump". That was wrong and is reversed.** The reasoning is recorded
because the error is instructive.

I rejected an explicit new phase *because* it forces a bump
(`readReservation` validates `asOneOf(o.phase, ['gathering','active'])`,
`save.ts:1053`). But the map established that **a bump is required either way**,
which removes the only argument against the phase.

**Why the bump is unavoidable — the "other direction" argument.** `save.ts:102-108`
(v8→v9) and `save.ts:114-121` (v9→v10) both record that those bumps existed for
saves opened by an *older deployed build*, not for the forward migration. v10's
wording is directly on point: an older build would "release the first, idle her,
walk her out and silently strand the rest of her panel. Silent corruption, where
a version refusal is clean."

An unstaffed reservation is exactly that class: a **currently deployed** v10
build opening such a save walks straight into hazards (1)–(3) and resolves a
patient in one tick against a NaN roll. The border tolerating `staffIds: []`
today is tolerance *by omission* — `asArray` accepts `[]`, and every ED B1 rule
is a `forEach` that simply never runs — not a considered permission.

**CHOSEN: `SAVE_VERSION` 11, an explicit phase, and an explicit border rule.**

```ts
// src/sim/entities/staff.ts
/**
 * awaiting:   room claimed, patient walking, NO staff yet (layout milestone).
 * gathering:  staff bound, parties walking to the room.
 * active:     timer running.
 */
phase: 'awaiting' | 'gathering' | 'active';

/** Tick the reservation entered `awaiting`. Ages the watchdog (§3.5). */
awaitingSince: number | null;
```

Once we are bumping, `awaitingSince` is nearly free and it solves §3.5's
watchdog properly — the map confirmed **no `gatheringSince` or any age field
exists today**, and no scan anywhere is keyed on reservation age.

The border rule becomes exact rather than approximate:
**`staffIds` is empty if and only if `phase === 'awaiting'`.** That is a rule the
previous design could not express, and hazard (1) is precisely a save that has
crossed it.

### 3.4 Where staff get bound — and a correction

A new pass in `updateDispatcher`, ordered **after** `assignTriage`/
`assignTreatment` (which mint reservations) and **before**
`promoteGatheredReservations` (which consumes them), so a patient arriving this
tick can still be staffed this tick.

```ts
/**
 * Bind staff to `awaiting` reservations whose patient is close enough, and
 * flip them to `gathering`. Ages the watchdog for those that cannot be
 * staffed (§3.5).
 */
function callStaffForArrivals(
  world: World, starved: ReadonlyMap<RoleId, ReadonlySet<RoomType>>,
): void;
```

> **CORRECTION — I previously wrote that a `reserved` staffer is unavailable to
> "`assignTriage`, `assignJobsForRole` and `postStandingStaff` (all gate on
> idle)". That is off by one.** The map verified `idleStaff`
> (`dispatcher.ts:117-119`) has exactly **two** callers — `postStandingStaff`
> (`:305`) and `assignJobsForRole` (`:692`). **`assignTriage` uses
> `availableStaff`** (`:483`). The doc comment at `dispatcher.ts:122-126` says
> so explicitly. Part B's benefit is therefore concentrated on the JOB QUEUE and
> STANDING POSTS, plus freeing the staffer for other rooms — not on triage
> dispatch, which could already draw a ratio staffer.

> **`availableStaff` CANNOT simply be reused — a second correction.** I claimed
> it could. `dispatcher.ts:179-183` only accepts a non-idle staffer when
> `world.reservations.get(s.duty.reservationId)` resolves **and names this
> room**. A staffer whose only claim is an unbound `awaiting` reservation has no
> witness, so the predicate misreads them. Late binding needs this predicate
> extended to treat an `awaiting` claim in this room as a valid witness — a
> deliberate change, not a reuse.

> **`needs.ts` must move in step.** `needs.ts:378-396` mirrors `availableStaff`
> and its comment demands they not drift. If the gather rule changes here and
> not there, `starvingDemand` feeds the §5b anti-capture guard a stale picture
> and the BlockedPanel disagrees with the sim.

### 3.5 The failure mode this creates, and its remedy

Deferring the binding means a patient can arrive and find **no staff
available**. Today that cannot happen: staff are secured before the patient
walks. Worse, per §3.2(5), the existing stall net goes vacuous at the same time.

The map confirmed **there is no general gathering watchdog** — a reservation
today ends only via the stall cancel, the lost-patient timeout
(`wayfinding.ts:109-137`), a terminal patient event, a fire, or a room
sell/close. A patient who keeps walking and never arrives holds room and staff
until decay kills them. That is the *current* contract, and Part B must not
widen it.

- Each tick, `callStaffForArrivals` retries binding for `awaiting` reservations.
- `awaitingSince` (§3.3) ages them. Past
  `BALANCE.dispatcher.unstaffedAbandonGameMinutes`, `cancelReservation` runs —
  the existing Flow rule 8 path (release + re-queue + hold + hint), **not a new
  mechanism**. `patientWaitingSince` restoration (Flow rule 6) is already inside
  it (`world.ts:1900`).
- The abandon path must ALSO cover the §3.2(4) fire leak: with an explicit
  `awaiting` phase, `fireStaff` need not change (an unstaffed reservation has no
  staffer to fire), but the watchdog is now the only thing that can reap one —
  so it must not be gated on the patient having arrived.

> **Reviewers: this is a real regression risk and I want it attacked.** We trade
> a guaranteed-staffed walk for a faster one. If abandons are material in either
> layout arm, ship Part A alone. §6 measures it.

---

## 4. Save decision (plan rule 6) — REVISED

**`SAVE_VERSION` 10 → 11.** Reasoning in §3.3; the short version is that the
bump is owed to the *other* direction, matching the v9 and v10 precedents
recorded at `save.ts:102-121`.

Changes:
- `Reservation.phase` gains `'awaiting'` ⇒ `readReservation`'s
  `asOneOf(o.phase, ['gathering','active'])` (`save.ts:1053`) extends to three
  values. **This is what makes the bump mandatory**: an older build hits
  `asOneOf` and refuses cleanly, which is the desired outcome.
- `Reservation.awaitingSince: number | null` — new saved field, appended in a
  documented frozen position (`SavedReservation`, `save.ts:257-266`), read with
  `saveVersion < 11 ? null : asIntOrNull(...)`.
- **New border rule:** `staffIds.length === 0` **iff** `phase === 'awaiting'`.
  Rejects both an unstaffed `active`/`gathering` (hazard 1) and a staffed
  `awaiting` (an incoherent state the sim cannot produce).
- ED B1's rules 1–3 are unaffected: all iterate `staffIds`, so an empty panel is
  vacuously fine — which is now *correct by design* rather than by accident.

**Pre-v11 saves load unchanged**: every existing reservation has staff, so each
reads as `gathering`/`active` with `awaitingSince: null`, satisfying the new
rule by construction.

**Deployment note for the owner:** a bump is one-way on a live game
(`HANDOFF.md`). Saves written after this deploys cannot be opened by the
current build. That is the bump doing its job, but it is a release decision.

---

## 5. Test list (numbered — the review checks coverage against this)

**Hint (`test/needs.test.ts`)**
1. A room whose only reservation is gathering with staff present and patient
   absent yields the "tied up waiting" label, NOT "build another one".
2. The same room, once the reservation is `active`, yields the ordinary busy
   label — proving the two states are distinguished, not swapped.
3. A `perProp` room (`er`) still yields "expand it to add beds".
4. A `single` non-department room (`exam`) genuinely treating still yields
   "build another one" — regression against the wording leaking.
5. `heldByWalk` is false when the patient has arrived and staff have not
   (the 0.4% case) — the label must not blame the walk for a staffing gap.

**Walk readout (`test/formulas.test.ts`, `test/hintLine.test.ts`)**
6. `walkGameMinutes` matches the sim's own per-tile walk cost — asserted
   against the movement system's constant, not a copied literal.
7. `walkOriginForNewRoom` returns a waiting-room tile when one exists and the
   entrance when none does.
8. The ghost readout is appended to the PRICE string, so an error still owns
   the hint line until geometry changes — the Stage-0 MAJOR, re-pinned.
9. An unreachable ghost shows no walk figure (no fabricated number).

**Staffer release (`test/dispatcher.test.ts`)**
10. A reservation is minted `awaiting` with `staffIds: []` while the patient is
    far, and the staffer stays `idle`.
11. That idle staffer is genuinely usable meanwhile — assert they can be taken
    by `assignJobsForRole` or `postStandingStaff`, the two real `idleStaff`
    consumers (§3.4). **Without this, Part B is a relabel, not a release.**
12. Staff are bound once the patient is within `staffCallTiles`; the phase goes
    `awaiting` → `gathering` → `active`.
13. **An `awaiting` reservation is NEVER promoted to `active`** — §3.2 hazard
    (1). Must FAIL with the guard removed; assert non-vacuity explicitly (the
    project's mutation-testing lesson: a guard no test can kill is unverified).
14. **`ticksRemaining` is never `NaN`** — §3.2 hazards (2) and (3). Drive a full
    treatment from an `awaiting` reservation and assert a finite duration and a
    real outcome roll.
15. A patient who arrives with no staff available is cancelled via Flow rule 8
    after `unstaffedAbandonGameMinutes`, re-queued, `waitingSince` preserved
    (Flow rule 6), and the room slot freed.
16. **The watchdog reaps an `awaiting` reservation whose patient NEVER arrives**
    — §3.2 hazard (5), the vacuous `members.some(stalled)`. This is the net that
    disappears, so it needs its own test.
17. `fireStaff` leaves no reservation naming a deleted staffer, including when
    one of that staffer's rooms also holds an `awaiting` reservation
    (§3.2 hazard 4).
18. ED_PLAN §5b's anti-capture guard still fires at BIND time — a nurse is
    refused extension while her role starves elsewhere.
19. `availableStaff` accepts a staffer whose only witness is an `awaiting` claim
    in THIS room, and still rejects one whose claim is in another room (§3.4's
    witness correction).
20. `needs.ts`'s availability mirror agrees with `availableStaff` for an
    `awaiting` claim (§3.4) — pin them together so they cannot drift.

**Save (`test/save.test.ts`)**
21. Round-trip byte-identity with an `awaiting` reservation present;
    `SAVE_VERSION` is 11.
22. The border REJECTS empty `staffIds` under `gathering` or `active`, and
    REJECTS non-empty `staffIds` under `awaiting` (§4, both directions).
23. A v10 fixture loads: every reservation reads `gathering`/`active` with
    `awaitingSince: null`, satisfying the new rule by construction.

**UI (`test/inspect.dom.test.ts`)**
19. The "Waiting for patient" line renders only while `heldByWalk`, with the
    elapsed figure.

---

## 6. Measurement — BOTH ARMS, non-negotiable

`LAYOUT_PLAN` §3.4: *a remedy that only works at one point on the layout axis
is not a remedy.* `test/edProbe.test.ts` carries `REFERENCE_BUILD` and
`COMPACT_BUILD`; both run, 5 seeds × 5 days, before and after.

Required columns: the probe's existing set, plus from
`test/utilisationProbe.test.ts`:
- **mean gather and the gather:treat ratio** — the number Part B exists to move.
- **nurse time budget** (idle / in a gather / treating) — Part B should convert
  "in a gather" into "treating" or "idle-and-usable", not merely relabel it.
- **`capacity:triage` shown %** — Part A should collapse the 85% figure.
- **NEW: unstaffed-abandon count** (§3.5). This is the regression counter and
  must be reported even if zero.

**Falsification conditions, stated in advance:**
- If Part B raises abandons materially in either arm, **ship Part A alone.**
- If Part B moves the nurse budget but not throughput in either arm, it is
  cosmetic — say so and let the owner decide whether it still ships.
- If the COMPACT arm regresses on anything while REFERENCE improves, the
  change is tuned to sprawl and must not ship.

---

## 7. Explicitly out of scope

- **The reservation-model rewrite** (`LAYOUT_PLAN` §4.1c — do not hold the slot
  during the walk). The bigger prize; touches Flow rules 6 and 8 structurally.
- **Reducing walk cost** (§4.1d) — a whole-economy balance milestone.
- **A distance term in `availableStaff`** — measured, worthless, reverted
  (`LAYOUT_PLAN` §2).
- **Changing `REFERENCE_BUILD`** (`LAYOUT_PLAN` §3.4 — it would silently
  re-baseline every historical number).
- Departments Stage 2a, still blocked on `DEPARTMENTS_PLAN` §4.4.

## 8. Open risks carried into review

1. **§3.3 was REVERSED after the code map** — this contract originally chose
   "no SAVE_VERSION bump" and that was wrong. It now bumps to 11 and takes an
   explicit `awaiting` phase. Reviewers should check the reversal is right, not
   just the conclusion: is the "other direction" argument (`save.ts:102-121`)
   genuinely load-bearing here?
2. **§3.5's abandon risk** — Part B trades a guaranteed-staffed walk for a
   faster one.
3. **§3.2's vacuous `every`** — a silent, save-corrupting class of bug if the
   guard is ever removed.
4. **§2.2's `findPath` cost** — input-keyed today; a future change making the
   ghost redraw per frame would turn this into a per-frame BFS.
5. **Part B does not fix room throughput** and must not be sold as if it does.
   The slot is still held for the whole walk; only the STAFFER is freed.
6. **Part B's benefit is narrower than first claimed** (§3.4 correction):
   `assignTriage` already used `availableStaff`, not `idleStaff`, so the freed
   staffer helps the JOB QUEUE, STANDING POSTS and other rooms — not triage
   dispatch. Test 11 exists to stop this being a relabel. **If reviewers think
   that narrows the prize below the risk, say so: Part A can ship alone.**
7. **The abandon watchdog is now load-bearing** in a way nothing was before —
   it is the ONLY reaper for an `awaiting` reservation, because both existing
   nets (`members.some(stalled)`, `fireStaff`'s panel) go vacuous on an empty
   `staffIds` (§3.2 hazards 4 and 5).
