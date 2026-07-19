# ED epic Stage B1 — ratio staffing: implementation contract (v2, REVIEW-HARDENED)

Companion to `docs/ED_PLAN.md` §3 (design + research). This document is the
**code contract**: exact signatures, exact call sites, frozen order of
operations, the save decision, and the test list. CLAUDE.md hard rules govern.

**Status: v3 (SHIPPED) — two independent adversarial pre-implementation reviews folded
(code/contract: 6 MAJOR + 4 MINOR + 2 NIT; design/balance: 4 MAJOR + 4 MINOR +
3 NIT). Both returned PROCEED WITH CHANGES. Owner ratified the two design
forks 2026-07-19. Ready to implement.**

All numbers are initial values; `balance.ts` / `rooms.ts` are authoritative.

## 0. What ships in B1

1. **Ratio staffing**: one staffer may hold up to N concurrent reservations
   **in one room**, N from that RoomDef. ED nurse 1:4, ED doctor 1:4. Every
   other room/role is N=1 — today's behaviour **by construction**.
2. **The attention penalty** (owner-ratified): sharing costs TIME. Effective
   skill falls as concurrent load rises, applied to **duration only**.
3. **Denser ED beds**: `traumaBed` density `perTiles: 12 → 6` ⇒ a minimum 3×4
   ER derives **2 bays**.
4. **Three legibility surfaces** (review MAJOR — not optional).
5. The probe re-run as a **3-arm split**, recorded in `ED_PLAN` §5b.
6. **Close / reopen a room** (owner ask 2026-07-19, added mid-stage): a busy
   room can never be expanded or sold — both validations reject while any
   reservation is live — so the department that most needs more bays is the
   one you can never grow. `Room.closed` + `World.setRoomClosed` reuse
   `breakRoom`'s disable-never-harm contract: capacity 0, gathering cancelled,
   actives drain. NEW SAVED STATE (see §4).
7. **`tryPlaceStripAt` slot-approachability** (found during implementation, not
   planned): at 1 bed / 6 tiles, placement packed beds into solid rows and left
   inner bays with no walkable neighbour — a bay nobody can stand beside.
   Every slot strip must keep one, which staggers the ward. Scoped to STAFFED
   rooms: in a restroom you occupy the stall rather than stand beside it.

NOT in B1 (`ED_PLAN` §3.4 / §3b / §4): interruptible per-touch staffing, zone
types, boarding, the ED front door (B2), the CT ungate (C).

## 1. The load-bearing insight (why this is small)

**A staffer's load is DERIVED**, by counting reservations whose `staffIds`
include them — the restroom-occupancy precedent. There is **no new
per-staffer counter**, so nothing can leak and nothing new is saved.

`Staff.duty` stays a **single** `{ kind: 'reserved'; reservationId }`. It is no
longer "the reservation I hold" but **"a reservation I hold"** — one witness.

**Design rule, stated here rather than smuggled in as a border check**
(design MINOR 8): **a ratio staffer's reservations are all in ONE room.** That
is what makes "zone" mean anything, and it is the incentive to consolidate —
two adjacent 2-bay ERs need 2 nurses; one 4-bay ER needs 1.

## 2. Data: the ratio lives on the RoomDef

`src/sim/data/rooms.ts` — new optional field on `RoomDef`:

```ts
/**
 * Concurrent reservations ONE staffer of this role may hold IN THIS ROOM
 * (ED_PLAN §3.2). Absent role ⇒ 1 ⇒ today's exclusive binding. A room with
 * no `staffRatio` is byte-for-byte today's behaviour.
 */
readonly staffRatio?: Readonly<Partial<Record<RoleId, number>>>;
```

On `er` only:

```ts
// Cal. Title 22 §70217 sets the ED nurse cap at 1:4 INSTANTANEOUS (no shift
// averaging) — that is where `nurse: 4` comes from and it is kept.
// `doctor: 4` is DELIBERATELY NOT the researched 1:15 zone number: at
// `perTiles: 6` a 15-bed ED needs 90 tiles, so 1:15 is inert at every
// buildable size (review Q1 — "do not claim it is doing work"). 4 puts the
// physician threshold inside the range players actually build, which is what
// makes the binding constraint MOVE with the day's case mix (ED_PLAN §7.2):
// laceration (wt 20) is nurse-only, fracture + kidney stones (wt 23) are
// doctor-only, chest pain/head injury/stroke (wt 19) need both.
staffRatio: { nurse: 4, doctor: 4 },
```

The ONE reader (no scattered `?.[role] ?? 1`):
```ts
// src/sim/formulas.ts
export function staffRatioFor(roomType: RoomType, role: RoleId): number
```

**Why one mechanism, not two**: reservations on a room can never exceed its
bed count, so "one doctor holds ≤N concurrent ER reservations" yields exactly
`ceil(beds / N)` doctors. Two rules collapse to one number. **Recorded debt**
(design MINOR 7): this forecloses `ED_PLAN` §7.3's nurse/doctor *asymmetry*
(they'd bind at the same KIND of threshold, differing only in magnitude). A
future stage that wants that asymmetry must reopen the mechanism.

**Density**: `er.props[0].density.tilesPerProp: 12 → 6`, `min: 2` (documents
intent — design NIT).

Capacity derives from **placed prop tiles in the grid** (`stripOrigins` reads
`tileAt().object`, `world.ts:408`), so this affects **new builds and expansions
only**; existing saved ER rooms keep their one placed bed. No migration.

**The 3×4 placement trace** (review MINOR 10 — §2 owed `6` the same arithmetic
it spent rejecting `3`): `traumaBed` is a 2-tile strip. In a 3-col × 4-row
rect, strip 1 lands at `(col0,row0)`; `(col1,row0)` refuses on overlap; strip 2
lands at `(col0,row1)`. Col 2 stays walkable on every row, so the interior
stays connected and `roomInteriorConnected` passes. With a north door at
`(col1,row0)` both row-0 origins refuse and the beds land on rows 1–2 — still
2. Failed placements **skip silently** and capacity derives from what landed
(`world.ts:759`), so test 14 sweeps **every legal door edge**, not one build.

**Why 2 and not 4** (design reviewer's Erlang, which supersedes my
tile-geometry reasoning): λ = 13 ER patients/day = 0.54/h; mean occupancy
63 min (52.3 raw × 1.22 for complication repeats) ⇒ μ = 0.95/h; offered load
0.57 erlangs. c=1 → Wq ≈ **53 min** with a 120-min stroke freezing the whole
department. c=2 → Wq ≈ **9 min**, head-of-line blocking gone. c=4 → **~1 min**,
i.e. the pressure deleted entirely — exactly `ED_PLAN` §5's stated failure mode.

## 2b. The attention penalty (owner-ratified 2026-07-19)

**The finding** (design MAJOR 3): with `averageSkill` untouched, one nurse
contributes **full** skill to all 4 concurrent treatments for one salary. A
second ED nurse is then not "rarely worth it" but **strictly dominated**, and a
skill-5 nurse is worth 4× more in the ER than in any other room — inverting
the hiring market `salaryPerSkillStep` is priced for. Not modelling
*interruption* is defensible; asserting sharing has **no cost at all** is a
balance decision, and it was the one making the mechanic free.

`src/sim/data/balance.ts`, in `treatment`:
```ts
/**
 * ED_PLAN §7.5: most of a patient's stay is spent waiting on SHARED
 * resources. A ratio staffer split across N bays treats each one more
 * slowly — contention made visible AS TIME, the currency the player already
 * reads. Effective skill only; `successChance` stays on RAW skill, because
 * deaths are the ED's loudest signal and must stay tied to a health/acuity
 * story rather than to staffing arithmetic.
 */
attentionSkillPenaltyPerPatient: 0.5,
```

`src/sim/formulas.ts` — the ONE derivation:
```ts
/** Effective skill for DURATION at concurrent load (1 = undivided). Clamped
 *  to the BALANCE.stats scale (audit #7: 1–5 is the scale SSOT). */
export function attentionSkill(skill: number, load: number): number
```
`= clamp(skill - attentionSkillPenaltyPerPatient * (load - 1), stats.min, stats.max)`

Applied at the ONE duration site — `promoteGatheredReservations`, where each
member contributes `attentionSkill(m.skill, world.staffLoadIn(m.id, room.id))`.
v2 said "the two `averageSkill` sites", which was self-contradictory:
`treatment.ts`'s `averageSkill` feeds `successChance` ALONE, and that roll
deliberately keeps RAW skill. One site, not two. **`successChance` is NOT
touched.** At load 1 the penalty is 0 and every
non-ratio room is bit-identical to today.

Worked example: a skill-4 nurse alone runs duration ×0.90; across 4 bays she
treats as skill 2.5 ⇒ ×1.05, ~17% slower per bay. Four bays on one nurse is
now measurably worse than two bays on two — a real decision with a real answer.

## 3. Sim changes, in dependency order

### 3.1 Derivations (world.ts)

```ts
/** Every live reservation naming this staffer, id-ascending (determinism). */
reservationsOfStaff(staffId: number): Reservation[]
/** …of which how many are in this room. */
staffLoadIn(staffId: number, roomId: number): number
```

### 3.2 `idleStaff` → `availableStaff` (dispatcher.ts)

**Frozen 4-arg signature** (review MAJOR 2 — the 3-arg version in v1 gave the
soft hold no way in):
```ts
function availableStaff(
  world: World,
  room: Room,
  filter: (s: Staff) => boolean,
  held?: ReadonlyMap<number, SoftHold>, // staffId → { roomId, units } this pass
): Staff[]
```

Qualifies iff `!s.firing && filter(s)` **and** either:
- `s.duty.kind === 'idle'` and `(held.get(s.id) ?? 0) < ratio`; **or**
- `s.duty.kind === 'reserved'`, the witness reservation is **in this room**,
  and `staffLoadIn(s.id, room.id) + (held.get(s.id) ?? 0) < ratio`.

**SUPERSEDED BY MEASUREMENT — the shipped order is IDLE-FIRST** (least-loaded
first, ties by staff id). v2 specified load-forward and called it the payroll
brake; both reviewers agreed. The 3-arm probe (ED_PLAN §5b) falsified it: it
cost **+1.8 deaths and −23% surgeries** against density alone, because it
overloads one nurse — paying the attention penalty on every bay — while her
colleagues stand idle. A hired staffer's salary is already spent, so sharing
is only ever a saving at HIRE time, never at dispatch. Idle-first makes the
ratio GRACEFUL DEGRADATION instead: fully staffed the ED behaves exactly as
pre-B1; short-staffed the extra bays still run, slower, rather than standing
empty. That is both the real payroll brake and ED_PLAN §7.2's movable
bottleneck. Test-pinned, never left to Map iteration order.

**Implementation is frozen** (review MINOR 8): build a `Map<staffId, load>`
**once at the top of each call** and sort against that snapshot. Never memoize
across a pass — `makeReservation` mutates `world.reservations` between calls
and later patients MUST see updated loads. Naively calling `staffLoadIn` inside
the comparator is O(S·logS·R) per role per patient per tick.

**Callers:**

- `assignTreatment` (`dispatcher.ts:299`) — the real one. **Delete
  `!heldForHigherPriority.has(s.id)` from the filter** (review MAJOR 2: the
  units term in the predicate is its ONLY replacement; leaving the identity
  exclusion in place makes §3.6 inert and test 10 vacuous).
- `assignTriage` (`:259`) — **NOT a mechanical convert.** v1 claimed
  "behaviour is identical"; that is **false** (review MAJOR 1). Today the nurse
  is picked BEFORE the room exists, and `if (!nurse) return` aborts the whole
  pass cheaply. Bay-first reordering puts that guard behind a per-patient
  `canReachRoom` — an **A\* `findPath` per patient per tick** with zero nurses,
  on the game's busiest funnel. **Frozen loop:**
  ```ts
  const bays = world.roomsOfType('triage');
  if (bays.length === 0) return;
  for (const patient of waiting) {
    const bay = bays.find((r) => hasOpenSlot(world, r) && canReachRoom(world, patient, r));
    if (!bay) continue;                                    // unchanged: skip THIS patient
    const nurse = availableStaff(world, bay, (s) => s.role === 'nurse')[0];
    if (!nurse) return;                                    // unchanged: abort the pass
    makeReservation(world, 'triage', patient, bay, [nurse], 0);
  }
  ```
  Triage has no `staffRatio` ⇒ N=1 ⇒ same staffing outcome; the guard
  semantics (`continue` for the bay, `return` for the nurse) are preserved
  exactly. The residual cost — a room scan before the nurse check — is bounded
  by the early `bays.length === 0` return.
- `postStandingStaff` (`:99`) and `assignJobsForRole` (`:411`) keep
  `idleStaff` **deliberately**: a ratio nurse is not available for a mop.

### 3.3 `makeReservation` — do not re-path an already-engaged staffer

```ts
const wasIdle = member.duty.kind === 'idle';
if (wasIdle) {
  member.duty = { kind: 'reserved', reservationId: reservation.id };
  world.setWalkerTarget(member, world.freeInteriorTile(room, patientSpot));
}
// else: duty already witnesses a live reservation in THIS room and the member
// is standing in (or walking to) it. Re-pathing would yank them off the walk
// their first reservation is gathering on.
```

The `wasIdle` gate is also **the guarantee** behind §3.7's open question: it is
the only thing that could `setWalkerTarget` an already-arrived ratio staffer,
so `walkerArrived` can never flip false underneath a gathering reservation.

### 3.4 `releaseReservation` — THE crux (world.ts:1796)

**Note for the diff reviewer** (review NIT 12): `this.reservations.delete(...)`
is *already* line 1 of the shipped body. The only deltas are the idempotence
guard, the `remaining.length > 0` branch, and its `continue`.

```ts
releaseReservation(reservation: Reservation): void {
  // Idempotence (review MINOR 7): a second call on a detached reservation
  // would otherwise recompute `remaining` from a panel that no longer holds
  // it and step out a staffer who was just legitimately re-bound. Latent
  // today; §3.5 is the first caller-controlled release ordering in the code.
  if (!this.reservations.delete(reservation.id)) return;
  for (const staffId of reservation.staffIds) {
    const member = this.staff.get(staffId);
    if (!member) continue;
    const remaining = this.reservationsOfStaff(member.id);
    if (remaining.length > 0) {
      // Ratio staffer with a live panel: re-point the witness and leave them
      // standing. A death in bay 1 must not free the nurse from bays 2-4.
      // Prefer an ACTIVE reservation (review NIT 11 + MAJOR 4): the lowest id
      // is the OLDEST, hence the likeliest to be stale-gathering while
      // another is active — which is exactly what made the duty label lie.
      member.duty = {
        kind: 'reserved',
        reservationId: (remaining.find((r) => r.phase === 'active') ?? remaining[0]).id,
      };
      this.events.emit('staffUpdated', { staffId: member.id });
      continue;                       // NO idle, NO step-out, NO firing removal
    }
    // ... today's body verbatim: idle, firing→removeStaff, clear path/target,
    //     walled-room step-out.
  }
}
```

Intended consequences, each test-pinned:
- Flow rule 7 (`releasePatientHoldings`) already scopes to the patient's ONE
  reservation ⇒ the above IS the rule-7 fix. No separate change.
- Flow rule 8 (`cancelReservation`) likewise.
- `breakRoom` cancels each gathering reservation individually; each release
  peels one binding, the last idles and steps out. Correct by construction.
- **Firing defers to the LAST release**: `availableStaff` excludes `s.firing`,
  so the panel drains and takes no new patients.

### 3.5 `fireStaff` — must cover the WHOLE panel (world.ts:1023)

A defect the ratio introduces that `ED_PLAN` did not name: today the `reserved`
branch looks at `duty.reservationId` alone. Fire a nurse holding 4 and three
reservations keep a `staffIds` entry pointing at a deleted staffer —
`promoteGatheredReservations` does `world.staff.get(id)!` and blows up.

```ts
const panel = this.reservationsOfStaff(member.id);   // fresh array — safe to
const gathering = panel.filter((r) => r.phase === 'gathering');  // mutate under
const active    = panel.filter((r) => r.phase === 'active');
// Gathering is not mid-treatment (M3 ruling) — cancel every one, hint:false.
for (const r of gathering) this.cancelReservation(r, { hint: false });
if (active.length > 0) {
  member.firing = true;                    // finishes what it is already treating
  this.events.emit('staffUpdated', { staffId: member.id });
  return;
}
if (this.staff.has(member.id)) this.removeStaff(member);
```
Strict generalisation: at N=1 the panel has one entry and this is byte-identical
to today's two branches. Iteration is safe — the snapshot is a fresh array and
`cancelReservation` cannot delete a *different* panel member (review verified).

### 3.6 Partial-gather soft hold — units, not identity (dispatcher.ts:284)

`heldForHigherPriority: Set<number>` → `Map<number, number>` (staffId → units
held this pass), passed as `availableStaff`'s 4th arg. On a failed gather,
`held.set(id, (held.get(id) ?? 0) + 1)` for each secured member.

Holding a 1:4 ED doctor's **entire** capacity because one gather came up a
nurse short would starve the pass. Still purely local, discarded at pass end,
nothing committed (`ANESTHESIA_PLAN` §4 lever 4 intact).

**Non-vacuity proof required** (the anesthesia precedent): test 10 must FAIL
when the units term is reverted to identity exclusion, and pass when restored.

### 3.7 `promoteGatheredReservations` — audited, no change

Verified hostilely by the review: `stalled` requires
`walkerArrived(w) && !isInsideRoom(w.at, room)`, and a staffer standing in the
ED satisfies `isInsideRoom` for **every** reservation on that room. The
cancelled-while-walking case is safe — nurse walking to bay 1's tile, bay 1
cancelled, duty re-points to bay 2, path untouched; she arrives at bay 1's
tile, which is inside the *same* room (§1's one-staffer-one-room rule), so
bay 2 promotes.

`averageSkill` **is** changed here, by §2b.

## 4. Save decision (plan rule 6)

**Ratio staffing itself adds no saved state** — `duty` keeps its shape and its
single `reservationId`, and load is derived. **`Room.closed` (item 6) IS new
saved state**, with a read-time default of false for pre-v10 rooms.

**SAVE_VERSION 9 → 10 anyway**, for the *other* direction (anesthesia
precedent): an older **deployed** build opening a B1 save would find one nurse
in four `staffIds`, release the first, idle her, walk her out, and silently
strand three reservations. It must refuse cleanly.

**Border hardening** — the duty↔reservation border is **one-directional**
today (`save.ts:1638`): `duty.reservationId` must resolve, but nothing checks
the back-reference, unlike the job border at `:1558`. Add to `loadWorld`:

1. **Witness validity**: a `reserved` duty's reservation lists this staff id.
2. **Total coverage**: every id in every `staffIds` belongs to a staffer whose
   `duty.kind === 'reserved'` (the witness may name a *different* reservation
   — that is the ratio).
3. **Ratio bound**: per (staffer, room), reservations holding them ≤
   `staffRatioFor(...)`; and a staffer's reservations are all in **one** room.

**v9-and-older safety, reasoned not assumed** (review MINOR 9 — a new border
rule rejecting old saves is the save-bricking class): v9's `makeReservation`
bound `duty` unconditionally for every member and v9's `idleStaff` required
`duty.kind === 'idle'`, so **no v9 staffer can appear in two `staffIds`** —
rules 1, 2 and 3 all hold, and rule 3's bound is ≥1 for every room/role so it
can never be stricter than v9 reality. The reviewer confirmed rule 3 cannot
reject a state the sim produces (`availableStaff` admits a `reserved` staffer
only when the witness is in *this* room; the witness only re-points within the
same room, by induction). Per `save.ts:1375`, the border may be stricter than
the sim, never more permissive.

## 5. Legibility — REQUIRED, not optional (both reviews, MAJOR)

v1 deferred this to the reviewer. Both reviewers returned the same verdict:
the mechanic is not merely invisible, **the existing UI reports the opposite
of reality**, and not-invisible-but-lying is strictly worse than invisible.

1. **The duty label lies** (`ui/format.ts:88-91` via `ui/inspect.ts:159`):
   phase resolves from the witness reservation only, so a nurse holding
   res#41 (gathering) + res#42 (active) reads **"Walking to a patient"** while
   standing still, mid-treatment. §3.4's active-preferred witness fixes the
   common case; `staffDutyLabel` must additionally derive "active" as **any**
   reservation active, and report `Treating N patients` for N > 1.
2. **Load readouts**: staff inspect card gets `ER panel 3/4`; room inspect
   card's staff line gets per-staffer load (`1 nurse (3/4) · 1 doctor (2/4)`).
   Without them the decision B1 creates — "another nurse or another bay?" — is
   literally unanswerable.
3. **`needs.ts` must distinguish three states, not suppress one.**
   **SHIPPED WIDER THAN SPECCED** (owner ask 2026-07-19, after seeing patients
   die outside an idle OR): the scan covers EVERY staffed room and names the
   ROLE and the AREA, not just ratio rooms. Scoping to ratio rooms was only
   ever a dodge for the transient-flash problem; the real fix is
   `BALANCE.dispatcher.capacityHintWaitGameMinutes`, so a 1:1 room being
   momentarily busy between patients never surfaces as a hire hint. Triage is
   included, which is how the nurse-capture starvation becomes visible.
   v1's §5 told the implementer to "audit `needs.ts` for `duty.kind === 'idle'`"
   — **that code does not exist** (review MAJOR 3). Availability there is
   *existence*-based (`needs.ts:78`, `hiredRoles`), deliberately, to avoid
   transient flashes. Chasing the phantom would have caused a regression.
   The real gap is the inverse: a saturated ratio nurse produces **no hint at
   all**, which under Stage A's 41.9% ER weight is the feature's modal failure
   state. Add a **new room-keyed** need kind — never a change to the
   existence-based role path — emitting three distinct messages:
   *no free bay* (→ "expand this room to add bays") ≠ *nurse at ratio cap*
   (→ hire) ≠ *no nurse hired*. The first also closes design MINOR 6: existing
   saves keep their 1-bed ER and get **none** of B1's capacity remedy unless
   the game tells them to expand.
4. No render change (a nurse standing in a room already renders).

## 6. Test list (plus a regression per review finding)

Ratio core:
1. One nurse serves 2 concurrent ER reservations; a second is NOT pulled while
   the first has capacity (the payroll brake, load-forward ordering).
2. The 5th concurrent ER patient does NOT bind the 1:4 nurse.
3. Non-ED rooms unchanged: two exam reservations require two staffers.
4. `staffRatioFor` returns 1 for every pair without an entry, and
   `keys(staffRatio) ⊆ staffedBy` — `data.test.ts` structural sweep (NIT).

Attention penalty:
5. `attentionSkill` at load 1 is identity; at load 4 with penalty 0.5 a skill-4
   nurse yields 2.5; clamps to `BALANCE.stats` at both ends.
6. Two bays on two nurses out-throughput four bays on one (the decision exists).
7. `successChance` is provably unaffected by load.

Release / rules 7-8:
8. Death in bay 1 leaves the nurse bound to bays 2-4 (duty re-pointed, still
   inside the room, path untouched).
9. The LAST release idles her, clears path/target, steps her out.
10. A firing nurse with a live panel survives until the last release and takes
    no new patients meanwhile.
11. `fireStaff` on 3 gathering + 1 active cancels the 3, leaves no dangling
    `staffIds` (§3.5 — regression).
12. `breakRoom` on an ED with 3 gathering reservations releases all three.
13. `releaseReservation` is idempotent (MINOR 7 — regression).

Dispatch:
14. The soft hold reserves ONE unit — **and fails when reverted to identity
    exclusion** (§3.6 non-vacuity).
15. `makeReservation` does not re-path a staffer already gathering for bay 1.
16. `assignTriage` keeps its guard semantics: no triage bays ⇒ early return;
    unreachable bay ⇒ skip that patient; no nurse ⇒ abort the pass — and no
    `canReachRoom` call happens when there are zero bays (MAJOR 1 regression).
17. **Triage starvation** (review MAJOR 5): one nurse, an ER with a live panel,
    a `waitingTriage` patient. A ratio nurse never returns to `idle`, and
    `assignTriage` gates on idleness and runs FIRST — so the ER now wins that
    contest permanently, where today she cycled back between patients. Pin the
    actual behaviour and surface it via §5.3; the probe (below) decides whether
    it needs a mechanism (Title 22 excludes the triage RN from the 1:4 count,
    so a carve-out is available and research-backed).

Save:
18. A **v9 fixture containing a live gathering AND a live active reservation
    with bound staff** loads through the new rules 1-3 (MINOR 9 — without
    reservations in the fixture the new rules are never exercised and the test
    is vacuous). Existing ER keeps capacity 1.
19. v10 round-trip with one nurse on 3 reservations is byte-identical.
20. Border rejects: a duty naming a reservation that omits the member; a
    `staffIds` member whose duty is `idle`; a nurse over ratio; a nurse holding
    reservations in two rooms.

Density:
21. A freshly built 3×4 ER derives capacity 2, interior connected, door landing
    not a bed tile — swept over **every legal door edge** (MINOR 10).

## 6b. The probe — 3 arms, and columns that can falsify B1

The §6 probe as specified could not detect a deleted payroll brake (design
MINOR 5). Required columns, per seed: ER visits, discharged, **died**, left
untreated, **nurses hired, doctors hired, payroll/day, profit/day, peak
concurrent ER reservations, mean ER staff load, triage completions and mean
`waitingTriage` duration** (the last two for test 17's starvation mode).

**Three arms, because density and ratio are confounded** — without the ratio,
2 bays would demand 2 nurses + 2 doctors, so density alone does not deliver the
fix, and a single-arm result is unattributable:
1. baseline (Stage A as shipped)
2. density only (`perTiles: 6`)
3. density + ratio + attention penalty (B1)

Run arm 3 on **both** a fresh build and a **v9-loaded** ER (design MINOR 6 —
only the fresh-build number is optimistic; existing saves keep 1 bed).

## 7. Build order

1. Data + `staffRatioFor` + `attentionSkill` + balance number; tests 4, 5, 7.
2. `reservationsOfStaff` / `staffLoadIn` (pure, no behaviour change).
3. `releaseReservation` + `fireStaff` (tests 8-13) — **before** dispatch, so
   the release path is correct the moment anything can hold a panel.
4. `availableStaff` + `makeReservation` + soft hold + `assignTriage`
   (tests 1-3, 14-17).
5. `averageSkill` → attention penalty at both sites (test 6).
6. Legibility: duty label, load readouts, the new room-keyed need (§5).
7. Save border + SAVE_VERSION 10 (tests 18-20).
8. Probe (3 arms), record in `ED_PLAN` §6, gates, adversarial review.

**No fixed-seed re-pin is required** (review, determinism section): B1 adds no
`RoleId`, draws no rng, and perturbs no rng ordering — the HANDOFF rule "a new
ROLE ships WITH its re-pins" does not apply. Do not pre-emptively re-pin.

## 8. Closed questions (answered by the reviews)

1. **One mechanism?** Acceptable; debt recorded in §2 (design MINOR 7).
2. **`perTiles` 6 vs 3?** **6** — Erlang in §2; 4 bays deletes the pressure.
3. **Load-forward ordering enough for the brake?** The ordering is correct and
   verified (within a pass, `makeReservation` sets `world.reservations` before
   the next `availableStaff`, so patient 2 sees load 1 and ranks her first).
   But the ordering was never the risk — the *ratio numbers* were, hence §2's
   retune and §2b.
4. **Anything else assuming `duty.reservationId` is THE reservation?** Complete
   list obtained: `fireStaff` (§3.5), `releaseReservation` (§3.4),
   `makeReservation` (§3.3), `idleStaff` (§3.2), the save border (§4),
   `ui/inspect.ts:159` + `ui/format.ts:88` (§5.1). Everything else matching
   `reservationId` is **patient** `stage.reservationId` — a patient holds
   exactly one reservation under B1, so all are safe by construction. Do not
   re-derive this analysis; the grep hits are noise.
5. **SAVE_VERSION 10 justified?** Yes — §4.
6. **Legible without a UI surface?** **No** — §5.
