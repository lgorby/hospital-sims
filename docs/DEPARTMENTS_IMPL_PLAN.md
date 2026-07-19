# Departments Stage 2a — implementation contract (radiology departments)

> # ⛔ BLOCKED — DO NOT IMPLEMENT (2026-07-19)
>
> Both pre-implementation reviews returned **NOT READY**, and the design review
> falsified the stage's premise rather than its details. **Owner decision:
> a measured imaging-demand balance pass must land FIRST; Stage 2a waits
> behind it.**
>
> **The finding that stopped it:** imaging rooms are idle ~93–96% of the day,
> so a second suite can never pay back and the epic's self-described
> "strongest design argument" — the movable machine-vs-tech bottleneck — does
> not exist at any buildable suite count. Numbers in `DEPARTMENTS_PLAN` §4.3,
> independently verified against the data tables.
>
> This document is retained because §1–§3 remain a usable contract **once
> demand supports the feature**, and because the review findings against it
> (§9, appended) are the specification for what a v2 must fix. Do not
> implement any section without re-reading §9.

**Status:** BLOCKED pending the imaging-demand balance pass. Was: DRAFT,
awaiting two independent pre-implementation reviews.
**Parent:** `docs/DEPARTMENTS_PLAN.md` §4 (design sketch) and §4.0 (the process
this document exists to satisfy).
**Predecessor:** Stage 1 (respiratory therapy retired) — SHIPPED, see
`docs/CHANGELOG.md`.

This is a **contract**, not a sketch. §4.0 is explicit about why: *"a sketch
earns design opinions; a contract earns defects."* Every claim about existing
code below carries a `file:line` and was verified against source on 2026-07-19.
Where a claim is an inference rather than a reading, it says so.

---

## 0. What this stage does, in one paragraph

A **department** is a set of same-type rooms that are edge-adjacent on the
grid. It is **derived from geometry, never stored**. Each member room ("suite")
remains an ordinary walled `Room` with its own door, its own machine and
`capacity: 'single'` — every existing wall, door, A*, reservation, capacity,
breakdown and sell path is reused unchanged. The stage adds four things: the
derivation, a department view on the inspect card, an **Add suite** gesture
that deterministically auto-places the next suite, and a department outline so
the group reads as one entity. **Applies to `xray`, `ct`, `mri`, `nucMed`;
`surgery` is deferred to Stage 2b** (§4.2 Q5).

---

## 1. The five open questions, ANSWERED

§4.0 requires these be settled here rather than deferred again.

### Q1 — Is `departmentId` stored or derived? **DERIVED.**

`DEPARTMENTS_PLAN` §4.2 leans toward stored, calling derived "tempting but
fragile — selling a middle suite would silently split a department." **This
contract disagrees, and the reasoning should be attacked first by reviewers.**

Cost of STORED, from the code map (all verified):
- `SAVE_VERSION` 10 → 11 (`save.ts:31`).
- `SavedRoom` gains a field in a **frozen position** (`save.ts:237-255` — the
  frozen-position comments exist because byte-identity fixtures pin serializer
  insertion order), plus `writeRoom` (`save.ts:850-867`) and `readRoom`
  (`save.ts:872-917`).
- Byte-identity fixture regeneration.
- **A new class of border validation.** Every existing `SavedRoom` field is a
  scalar; `departmentId` is a *reference*. `save.ts` has never validated
  cross-entity references on rooms. Worse, `loadWorld` must not mutate restored
  state (the Stage-1 lesson: an earlier draft sanitised retired rooms and broke
  save→load→save byte-identity), so a dangling `departmentId` **cannot be
  repaired at load** — the border must reject or tolerate, and rejecting means
  a save that refuses to load.

Cost of DERIVED: zero save changes, `SAVE_VERSION` stays 10, no new validation
class, and **existing saves gain departments retroactively with no migration**.

The "fragility" is, on inspection, **correct semantics rather than a bug**:

- *Selling a middle suite splits the department.* Two groups of suites with a
  gap between them **are** two departments. Physically, that is what happened.
  A stored id would have to either keep them fictitiously joined or run split
  logic anyway.
- *Two independently-built adjacent same-type rooms auto-merge.* This is a
  feature. A player who builds two X-ray rooms side by side gets a department
  for free, and every pre-existing save does too — with a stored id they would
  need a migration to ever become one.

**The genuine cost of derived is recomputation**, because `inspect.renderBody`
runs every frame (`inspect.ts:93-111` — buttons re-wire only on identity
change, but the body re-renders unconditionally). §2.1 specifies a
revision-cached derivation following the existing `auraRevision` precedent.

> **Reviewers: this is the highest-leverage decision in the stage.** If derived
> is wrong, it is wrong here and cheap to reverse; after implementation it is
> a save-version decision.

### Q2 — Auto-placement. **Deterministic four-side scan, first legal wins.**

Specified in §3.3. Failure mode is an explicit rejection toast, never a silent
no-op.

### Q3 — Does each suite need its own corridor door? **YES, and this is forced.**

Not a preference — `build.ts:121-129` requires a door's outside tile to be
walkable and **roomless or open-plan**:

```ts
const opensToOpenRoom = outsideRoom !== null && ROOM_DEFS[outsideRoom.type].kind === 'open';
if (!outsideTile || !outsideTile.walkable || (outsideTile.roomId !== null && !opensToOpenRoom)) {
  return fail('Door must open onto a corridor or atrium');
}
```

A door may not open into another walled room. Shared internal circulation is a
room-within-a-room problem and is out of scope (§7).

### Q4 — Sell semantics. **One suite at a time. No whole-department sell in v1.**

`sellRoom` is private (`world.ts:977`) with no batch entry point, and the
command union carries only single-room commands (`src/commands.ts:11-27`).
There is **no transaction concept in the CommandQueue**, so a fanned-out
department sell has reachable partial success — half a department sold when
suite 3 of 5 fails `validateRoomSell` (`build.ts:398-423`, which rejects on any
live reservation or anyone standing inside). Shipping a button whose failure
mode is "some of your department is gone" is worse than not shipping it.

The department card therefore sells the **selected suite**, using the existing
gesture and the existing validation, and says which suite it is about to sell.

### Q5 — Does the OR ship with radiology? **NO — radiology first (2a).**

`DEPARTMENTS_PLAN` §7 already sequences this and the code map supports it:
`surgery` carries the three-role gather plus the anesthesia machinery
(`ROOM_DEFS.surgery`, `rooms.ts:378`), while xray/ct/mri/nucMed are plain
single-capacity mechanical rooms. Prove the pattern on the clean case.

---

## 2. THE REFRAME — internal walls STAY, and that is the correct model

`DEPARTMENTS_PLAN` §4 asks for rendering "that reads as one block rather than N
buildings." The code map identifies this as **the single largest risk in the
stage**, and it is worth stating plainly why this contract does not do it.

**What the map found** (`renderer.ts:481-494`): `drawRoom` walks
`boundaryEdges(room.rect)` and emits a wall `Graphics` for every edge except
its own door — one `continue`, and it is the door gap. There is no neighbour
lookup, no shared-edge dedupe, no per-edge visibility set. Consequences of
suppressing the seam:

1. `drawRoom` would gain neighbour awareness, breaking the invariant that a
   room's visuals depend only on that room.
2. It needs a **new invalidation path**. `roomBuilt`/`roomSold` fire only for
   the changed room (`renderer.ts:245-255`), so a neighbour's seam would go
   stale forever.
3. **The visuals would lie.** `world.canStep` still enforces the wall for
   pathing, so a visually merged department is still two walled boxes to A*.
4. Two overlapping translucent near-walls already composite to a darker band
   (`WALL_NEAR_ALPHA`, `renderer.ts:522`), so the seam artifact is visible
   before any decision is made.

**But the deeper point is that the seam should not be suppressed at all.**
`DEPARTMENTS_PLAN` §1's own research says equipment-scaled departments scale by
**adding a walled suite** — capacity is the machine, floor area buys nothing.
Real X-ray, CT and nuclear-medicine suites are individually shielded rooms;
that is a physical requirement, not a layout habit. A radiology department that
renders as one open hall would contradict the research this epic is built on.

**So: internal walls stay, and "reads as one entity" is delivered at the
department level instead** — a shared outline, one inspect card, one Add-suite
gesture, aggregate income and capacity. This deletes the stage's largest risk
and produces a *more* accurate model, not a compromised one.

> **Reviewers: this reframe is a design decision made against the letter of
> §4, and it should be challenged if the owner's intent was literally "no
> internal walls."** The owner's words were *"a collection of different
> operating rooms inside of it"* and *"a collection of rooms where there can be
> more than one xray machine in the entire entity"* — both describe an entity
> containing rooms, which is what this builds.

---

## 3. Frozen contract

### 3.1 New file: `src/sim/departments.ts` (pure, no Pixi, no DOM)

```ts
import type { RoomType } from './data/rooms';
import type { Rect } from './types';
import type { World } from './world';

/**
 * Room types that form departments: capacity is the MACHINE, so growth means
 * another walled suite (DEPARTMENTS_PLAN §1, equipment-scaled).
 * `surgery` is deliberately absent — Stage 2b.
 */
export const DEPARTMENT_TYPES = ['xray', 'ct', 'mri', 'nucMed'] as const;

export function isDepartmentType(type: RoomType): boolean;

/** A derived group. Never stored, never saved — see IMPL_PLAN §1 Q1. */
export interface Department {
  readonly type: RoomType;
  /** Member room ids, ASCENDING — the determinism guarantee. */
  readonly roomIds: readonly number[];
  /** Bounding box over every member rect. Render outline + jump target. */
  readonly bounds: Rect;
}

/** All departments, ordered by lowest member id ascending. */
export function departmentsOf(world: World): Department[];

/**
 * The department containing `roomId`, or null if the room is not a
 * department type. A LONE suite is a department of one — callers must not
 * special-case count === 1.
 */
export function departmentOf(world: World, roomId: number): Department | null;
```

**Grouping rule (frozen):** two rooms are in the same department iff they have
the same `type`, that type `isDepartmentType`, and their rects are
**orthogonally edge-adjacent** — they share at least one unit edge. Diagonal
touching does NOT group. Transitive closure via BFS over rooms.

**Determinism:** iterate `world.rooms` in ascending id (not `Map` insertion
order — assert this in test 4); sort `roomIds` ascending; sort departments by
`roomIds[0]`.

### 3.2 Caching — follow the `auraRevision` precedent

`inspect.renderBody` runs **every frame** (`inspect.ts:93-111`), so an
uncached O(N²) derivation would land in the per-frame path — which
`INVARIANTS.md` explicitly guards against ("New render draw is one-time or
per-room-build, never per-frame").

```ts
// world.ts — mirrors auraRevision exactly, including NOT being saved.
/** Bumped on roomBuilt / roomChanged / roomSold. Derived; resets on load. */
departmentRevision: number;
```

`departmentsOf` memoizes on `departmentRevision`. Like `auraRevision`, it is
**deliberately not saved** (derived state, `INVARIANTS.md`).

> Reviewers: check whether `expandRoom` must bump it. It changes a rect, which
> can create or destroy adjacency. This contract says **yes** — `expandRoom`
> already emits `roomChanged` (`world.ts:841`), so bumping on that event covers
> it. Verify no other rect mutation path exists.

### 3.3 Auto-placement

Two functions, split so the rect arithmetic stays pure and testable, matching
how `placement.ts` is already structured (63 lines, no world access).

```ts
// src/render/placement.ts — PURE, no world access.
/**
 * Min-size rects flush against each side of `anchor`, in the FROZEN order
 * E, S, W, N; each side yields canonical orientation then swapped (skipped
 * when square). Near-corner aligned. Deterministic; no validation.
 */
export function adjacentSuiteCandidates(type: RoomType, anchor: Rect): Rect[];
```

```ts
// src/sim/build.ts — world-aware selection.
/**
 * The first legal (rect, door) for a new suite beside the department
 * containing `roomId`, or null. Search order — frozen, total:
 *   for each member suite, ASCENDING id
 *     for each candidate from adjacentSuiteCandidates (E,S,W,N order)
 *       for each boundary tile of that candidate, row-major
 *         if validateRoomBuild(world, type, rect, door, false).ok -> return
 *
 * COST: runs ONLY on the addSuite command, never per frame. Worst case is
 * suites x candidates x doorTiles full-map BFS inside validateRoomBuild
 * (build.ts:143-207). Bounded but not cheap — see test 14.
 */
export function findSuitePlacement(
  world: World, roomId: number,
): { rect: Rect; doorOutside: GridPoint } | null;
```

Note `findSuitePlacement` calls `validateRoomBuild` with `free = false`, so
**affordability is part of legality** — a player who cannot afford a suite gets
"Not enough cash" from the existing validator rather than a bespoke check.

> Reviewers: confirm the door scan uses `doorFromOutsideTile` (`build.ts:85-96`)
> rather than hand-constructing a `Door`. `validateRoomBuild` re-derives and
> compares (`build.ts:119-120`), so a hand-built Door risks 'Invalid door
> position'.

### 3.4 New command + world method

```ts
// src/commands.ts — appended to the union.
/** Departments 2a: auto-place another suite beside the department. */
| { type: 'addSuite'; roomId: number }
```

```ts
// world.ts — new public method, wired in the applyCommand switch beside
// 'expandRoom' (world.ts:671).
addSuite(roomId: number): void;
```

Frozen order of operations (mirrors `buildRoom`, `world.ts:745-790`):

1. Resolve `departmentOf(this, roomId)`; null → `buildRejected`
   `'Not a department'`.
2. `findSuitePlacement(this, roomId)`; null → `buildRejected`
   `'No space beside this department — clear room next to it'`.
3. Delegate to the **existing** `buildRoom(type, rect, doorOutside, false)`.
   Charging, tallying, prop placement, `roomBuilt` and `recomputePaths` are all
   inherited — **no duplicated build logic**.
4. Bump `departmentRevision` (via the `roomBuilt` subscription, §3.2).

**Economy (`DEPARTMENTS_PLAN` §5):** a suite costs a full room price because
`buildRoom` already charges `priceOf(type, rect)` (`world.ts:775`). Zero new
balance numbers, by construction. **The staff constraint deliberately does NOT
scale** — two rad techs still serve N scanners. That is the intended movable
bottleneck (§5, `ED_PLAN` §7.2) and §6 measures it.

### 3.5 `needs.ts` — a REQUIRED sim change

The code map flags this as the most direct collision in the codebase, and it
contradicts §4.1's "no sim change" framing. `capacityNeeds`
(`needs.ts:334-375`) currently emits, for any busy `single` room:

```
`${label} is busy — build another one (it treats one patient at a time)`
```

The comment above it (`needs.ts:351-359`) records that the owner was already
burned once by a wrong remedy here — they expanded Respiratory Therapy on this
hint's advice and correctly got no capacity. **The diagnosis stays right; the
remedy changes** for department types, from "build another one" to "add a
suite".

```ts
label: rule.kind === 'perProp'
  ? `${label} is full — expand it to add ${rule.noun.toLowerCase()}`
  : isDepartmentType(type)
    ? `${label} is busy — add another suite to the department`
    : `${label} is busy — build another one (it treats one patient at a time)`,
```

The `capacity:${type}` key is unchanged, so this stays **panel-only** per
`INVARIANTS.md` ("Capacity/ratio needs are PANEL-ONLY" — a type-keyed
`hintOnce` toast would announce a recurring state exactly once per save).

> Reviewers: the key is per TYPE, so with two separate X-ray departments the
> row cannot say WHICH is full. Is that acceptable for v1, or does the key need
> to become per-department? Note a per-department key must be stable across
> recomputation, and department identity is derived — `roomIds[0]` is the
> obvious candidate and it changes when the lowest-id suite is sold.

### 3.6 Inspect card

`Selection` stays `{ kind: 'room'; id: number }` — **no new selection variant.**
Clicking a suite selects that suite (`renderer.ts:342-358` unchanged); the card
gains a department section when `departmentOf` is non-null. This keeps
`stillExists` (`inspect.ts:113-119`) and the identity key (`inspect.ts:102-105`)
untouched, which the map flagged as needing a case per variant.

Added lines, rendered only for department types:
- `Department — N suites` (bounds size in parentheses)
- `Capacity n/N` — aggregate `openSlots` across members. **This line does not
  exist today for these types**: `capacityLine` renders only for `perProp`
  rules (`inspect.ts:374`), so all four types currently show no capacity line.
- `Income` aggregated across members, alongside the existing per-room figure.
- **`Add suite — $N`** button. Price is `priceOf(type, <the rect that
  findSuitePlacement would pick>)`, so the label cannot promise a price the
  command will not charge.

> Reviewers: that price requires running `findSuitePlacement` to know the rect,
> and §3.3 says it is expensive and must not run per frame — but the card
> re-renders every frame. Resolve this. Options: (a) all candidates are min-size
> so the price is `priceOf(type, minRect)` and needs no search; (b) cache the
> search on `departmentRevision` + cash. **This contract picks (a)** — every
> candidate from `adjacentSuiteCandidates` is min-size by construction, so the
> price is knowable without searching. Verify that claim.

Sell/Close/Expand buttons keep their current single-room behaviour (Q4).

### 3.7 Render — the department outline

A single outline around `department.bounds`, drawn from the existing
`roomVisuals` teardown/redraw path so it inherits invalidation. Because a
department is derived, **the outline must redraw for every member when any
member changes** — this is the one place where cross-room invalidation is
genuinely required, and it is why the outline is a separate overlay rather than
part of `drawRoom`.

**Chosen mechanism:** draw it in the existing overlay layer keyed on
`departmentRevision`, NOT in `drawRoom`. This preserves `drawRoom`'s per-room
independence (§2 point 1) and gives correct invalidation for free.

> Reviewers: confirm the overlay cache key. `INVARIANTS.md` says the render
> overlay is cache-keyed on `World.auraRevision` and that "a new overlay input
> must join the key." `departmentRevision` is a new overlay input.

---

## 4. What is explicitly NOT changing

Stated so reviewers can falsify it:

- **The dispatcher.** Verified, not assumed: `dispatcher.ts:527-556` builds a
  candidate list and *tries* each, breaking on success — it does not
  first-match. The comment at `dispatcher.ts:522-526` records that multi-room
  was designed for.
- **`save.ts`** — no fields, no version bump (Q1).
- **Walls, doors, A*, `canStep`, `canApproach`** — untouched (§2).
- **Reservations, capacity, `slotOrigins`, breakdowns, repair jobs** — a suite
  is an ordinary room.
- **`buildRoom`'s signature.** The map noted it returns `void` so a caller
  cannot learn the new id; with a derived department nothing needs the id, so
  the signature stays.

---

## 5. Test list (numbered — the review will check coverage against this)

**Derivation — `test/departments.test.ts`**
1. Two edge-adjacent xray rooms form one department of 2.
2. Two diagonally-touching xray rooms form TWO departments of 1.
3. An xray and a ct sharing an edge form two departments (type must match).
4. `roomIds` ascending and departments ordered by `roomIds[0]`, asserted
   against rooms built in DESCENDING id order (proves id-sort, not Map order).
5. A lone suite is a department of 1 (callers must not special-case).
6. Selling a middle suite of three-in-a-row splits it into two departments —
   pinning the Q1 semantics as intended, not incidental.
7. `bounds` is the true bounding box over an L-shaped department.
8. Non-department types (`exam`, `er`, `dialysis`, `surgery`) return null from
   `departmentOf`. **`surgery` explicitly, so Stage 2b is a deliberate act.**
9. `departmentsOf` is memoized: two calls at the same `departmentRevision`
   return the identical array reference; a `roomBuilt` between them does not.
10. `expandRoom` on a suite that grows it into adjacency with another suite
    merges the departments (proves `roomChanged` bumps the revision).

**Placement — `test/placement.test.ts` (extends the existing file)**
11. `adjacentSuiteCandidates` returns candidates in the frozen E,S,W,N order.
12. Every returned rect is flush against the anchor (shares a full edge, no
    overlap, no gap) and satisfies `fitsMinimum` in one orientation.
13. Square min-size types emit no duplicate swapped orientation.

**Suite placement — `test/departments.test.ts`**
14. `findSuitePlacement` returns the FIRST legal position by the frozen order,
    asserted against a hand-computed expected rect — not merely "something
    legal".
15. Returns null when the department is walled in on all four sides.
16. Returns null when cash is short (affordability rides `validateRoomBuild`).
17. The returned door passes `validateRoomBuild` unchanged — regression against
    hand-constructing a `Door` instead of using `doorFromOutsideTile`.
18. Never returns a rect that swallows a neighbouring room's `door.outside`
    (`build.ts:68-74` — the door-orphan rule).

**Command — `test/departments.test.ts`**
19. `addSuite` on a legal department builds a suite, charges
    `priceOf(type, rect)`, and emits `roomBuilt`.
20. `addSuite` with no space emits `buildRejected` with the space reason and
    mutates nothing (cash unchanged, room count unchanged).
21. `addSuite` on a non-department room emits `buildRejected` 'Not a
    department'.
22. `addSuite` is inert in challenge mode? **NO** — it is not a debug command.
    Assert it WORKS in challenge mode, so nobody later mistakes it for one.
23. The new suite is dispatchable: a patient needing that room type is routed
    into the new suite while the original is occupied. **This is the whole
    point of the stage** and must be an end-to-end assertion, not a unit test.

**Needs — `test/needs.test.ts`**
24. A busy xray department emits `capacity:xray` with the "add another suite"
    wording.
25. A busy `exam` (single, non-department) still emits "build another one" —
    regression against the wording change leaking.
26. A busy `er` (perProp) still emits "expand it to add beds".

**Save — `test/save.test.ts`**
27. Save→load→save byte-identity holds with a 3-suite department present, and
    `SAVE_VERSION` is still 10 — pinning the "no save change" claim.
28. Departments re-derive correctly after a load (no persisted grouping).

**UI — `test/inspect.test.ts`**
29. The department section renders for a department type and NOT for `exam`.
30. `Add suite` shows the min-size price and is disabled with a reason when
    `findSuitePlacement` would fail.

---

## 6. Measurement (`DEPARTMENTS_PLAN` §6 — non-negotiable)

*"A stage that moves capacity without reporting its outcome cost is not
finished."* `test/edProbe.test.ts` is the instrument (`ED_PROBE=1`), 5 seeds ×
5 days, results recorded back into `DEPARTMENTS_PLAN` §4.

Required columns: per-room visits, discharged, **died**, walkouts, **payroll,
profit/day, per-role blocked counters**, and — the intended new bottleneck —
**radTech utilisation**.

**Arms:**
- **A. Baseline** — current build, no departments.
- **B. Departments available, player does not use them** — must be a WASH.
  Anything else means the derivation or the needs wording changed behaviour on
  its own, which would be a defect, not a result.
- **C. A 2-suite X-ray department** — the intended case.

**The hypothesis to falsify:** adding scanners without adding techs moves the
bottleneck to `radTech` rather than raising throughput. If arm C raises
throughput *without* radTech utilisation rising, capacity got too cheap and §5's
economy guardrail failed.

**Reason from the measurement, not from this document.** The ED probe falsified
`availableStaff`'s ordering after the model and both reviewers agreed on it.

---

## 7. Explicitly out of scope

- **Surgery departments** — Stage 2b, after 2a proves the pattern (Q5).
- **Shared internal circulation** — a room-within-a-room problem (Q3).
- **Seam wall suppression** — §2; internal walls are the correct model.
- **Whole-department sell** — Q4; no transaction concept exists.
- **Per-department capacity hint keys** — §3.5, flagged for the review.
- **`dialysis`, `er`, `waiting`, `restroom`** — area-scaled, already correct
  (`DEPARTMENTS_PLAN` §4).

---

## 8. Open risks carried into review

1. **Q1 derived-vs-stored** is the stage's load-bearing decision (§1).
2. **The §2 reframe** deliberately does not implement §4's "reads as one block"
   literally.
3. **`findSuitePlacement` cost** — bounded but heavy; §3.3, test 14.
4. **The per-type capacity key** cannot distinguish two departments of the same
   type (§3.5).
5. **Economy** — `DEPARTMENTS_PLAN` §4.0 names this explicitly: Stage 1 deleted
   a capex gate and the probe could not see it; Stage 2 adds buildings, the same
   question in the other direction. **Do suites make capacity too cheap?**
   §6 arm C is the test.

> **Risk 5 was answered, and the answer was the opposite of the question.**
> Suites are not too cheap; they are unaffordable at any price because they
> produce nothing. Asking only the one direction is how this would have
> shipped. See §9.2 finding 1.

---

## 9. Review findings (2026-07-19) — the specification for a v2

Two independent adversarial pre-implementation reviews, run in parallel per
`DEPARTMENTS_PLAN` §4.0 step 3. **Both returned NOT READY.** Recorded in full
because these are the defects a v2 must close, and because several are traps
that would recur in any similar stage.

### 9.1 Code / contract / save-safety — 8 MAJOR, 6 MINOR, 1 NIT

1. **MAJOR — the `departmentRevision` bump mechanism does not exist.** §3.2/§3.4
   specified bumping "via the `roomBuilt` subscription". `World` never
   subscribes to its own EventBus (zero `this.events.on` in `world.ts`); it is
   a pure emitter. The cited `auraRevision` precedent is an *inline* increment
   (`world.ts:592`), not event-driven. Remedy: three explicit inline bumps
   before the emits at `world.ts:788`, `:840`, `:1030`. `room.rect = rect`
   (`world.ts:824`) is the ONLY rect write in `src/sim/`, which is what makes
   three sites sufficient.
2. **MAJOR — a module-level memo leaks across `World` instances.** Every
   `new World` starts at `departmentRevision = 0`, so a module-scoped cache
   returns one world's departments for another — green in whichever test runs
   first, wrong everywhere else, and it survives `loadWorld`. Remedy: a
   `WeakMap<World, ...>` or private World fields.
3. **MAJOR — the department outline would ship dead.** §3.7 put it in the aura
   overlay, but `drawOverlay` CLEARS that Graphics whenever
   `auraOverlayActive()` is false (`renderer.ts:1262-1266`), and that is true
   only while an atrium is selected or the atrium tool is armed. The outline
   would be invisible in exactly the moment it exists to explain. §3.7 also
   contradicts itself — "drawn from the `roomVisuals` path" and "NOT in
   `drawRoom`" cannot both hold, because that path IS `drawRoom`.
4. **MAJOR — test 30's disabled state is the per-frame cost §3.3 forbids.**
   `renderBody` runs every frame; `findSuitePlacement` runs a full-map BFS per
   candidate. A 3-suite department is ~336 BFS runs per frame. Remedy: the
   button is ALWAYS enabled and failure is the existing `buildRejected` toast.
5. **MAJOR — `adjacentSuiteCandidates` in `render/placement.ts` forces the
   first sim to render import in the project.** `src/sim/` currently references
   `render/` exactly once, in a comment. Remedy: put it in `src/sim/`.
6. **MAJOR — the frozen door scan returns `null` every time.** It iterated
   "boundary tiles of the candidate", which are INSIDE the rect;
   `doorFromOutsideTile` opens with `if (rectContains(rect, outside)) return
   null` (`build.ts:85-87`). Every candidate would fail. Remedy: scan the
   OUTSIDE perimeter ring.
7. **MAJOR — test 4 is unfalsifiable and guards the wrong path.** It asserts
   determinism "against rooms built in DESCENDING id order", but ids come from
   a monotonic `takeId()`, so that state cannot be constructed. The real
   Map-order risk is `loadWorld` (`save.ts:1817`) inserting from an untrusted
   save array. Remedy: reverse-insert or round-trip a reversed save.
8. **MAJOR — test 9 freezes an aliasing bug into the contract.** It requires
   the memo return "the identical array reference" on a MUTABLE `Department[]`;
   any caller doing `.sort()` silently corrupts every later consumer at that
   revision. Remedy: `readonly Department[]`, and test non-recomputation
   instead of reference identity.
9. MINOR — `DEPARTMENT_TYPES` in `departments.ts` is a parallel table against
   TECH_PLAN §3.1 rules 1-2; it belongs beside `RETIRED_ROOMS` in
   `data/rooms.ts`. Also make `isDepartmentType` a type guard or the `as const`
   is decorative.
10. MINOR — §3.4 has no success signal and could in principle emit two
    rejections; pin "exactly one event of each kind".
11. MINOR — the Add-suite button is a fourth persistent inspect button and must
    ride `wireAction`'s rebuild path, or it reproduces the M3 bug the rebuild
    pattern exists to prevent (`inspect.ts:127`).
12. MINOR — `roomChanged` also fires for `setRoomClosed` and `breakRoom`,
    neither geometric; bump at the three geometry sites instead.
13. MINOR — the candidate set is near-corner-aligned only, so a legal spot one
    tile off-axis is never found and the player is told "no space" falsely.
14. MINOR — discharge plan rule 6 explicitly for `departmentRevision`.
15. NIT — file:line drift: `test/inspect.test.ts` is `test/inspect.dom.test.ts`;
    `roomChanged` is `world.ts:840` not `:841`.

**Held up under attack:** §3.6 option (a). `priceOf` is area-based and area is
orientation-invariant, so every min-size candidate prices at exactly
`ROOM_DEFS[type].cost` — the button label cannot promise a price the command
will not charge, with no search required.

### 9.2 Design / balance / player experience — 6 MAJOR, 3 MINOR, 1 NIT

1. **MAJOR — a suite can never pay back.** THE finding; numbers in
   `DEPARTMENTS_PLAN` §4.3.
2. **MAJOR — the movable bottleneck does not exist.** radTech utilisation
   ~11%; neither machine nor tech is ever binding.
3. **MAJOR — §3.5's new hint recommends the money sink, in one click.** It
   repeats the owner's documented burn (`needs.ts:351-359`) while REMOVING the
   drag-place friction that was the only protection against a bad hint.
   *(Contested sub-claim: the reviewer wants the `continue` at `needs.ts:375`
   removed so the staff branch also runs. That is arguably wrong — if no room
   has a free slot, hiring a tech genuinely does not help. The defect is that
   the hint fires at all for transient contention on a 7%-utilised room.
   Being investigated as its own milestone.)*
4. **MAJOR — §6 cannot answer its own question.** No null branch (the actual
   outcome is "nothing moves", which §6 would read as *safe* rather than
   *inert*); the radTech-utilisation instrument does not exist and is not
   specified anywhere in §3; arm C measures at 7% load, an order of magnitude
   inside seed noise; 5 days still cannot price capex — needs a cumulative
   cash / total capital outlay column, not profit/day. Arm B is not a control
   in a headless probe (there is no player to decline the feature).
5. **MAJOR — a bounding-box outline visually annexes non-members.** §3.3's
   E,S,W,N first-legal scan makes L and staircase shapes normal, and test 7
   requires them. The notch of an L can contain an unrelated room, so the one
   affordance meant to say "these are one entity" would claim the player's CT
   belongs to the X-ray department. Remedy: outline the UNION of member rects
   (edge-dedupe in the overlay — cheap, and it does not touch `drawRoom`'s
   per-room independence).
6. **MAJOR — Q5 defers the OR, which the owner named FIRST**, on
   implementation-cleanliness grounds. The codebase says imaging is not where
   the player hurts: `edProbe` already carries `surgeryGatherBlocked`,
   `surgeryBlockedOnNurse` and `diedAwaitingSurgery`, with no imaging
   equivalents. Caveat that sharpens rather than weakens it: surgery is
   staff-gated, so an OR department would not raise throughput either without
   a staffing change.
7. MINOR — Add is one confirmation-free click; Sell is per-suite, manual, can
   fail, and refunds 50%. It is the largest single-click spend in the game and
   the only purchase with no siting decision. Remedy: confirm with price and
   resulting suite count; show sellback on the card BEFORE purchase.
8. MINOR — fixing the per-type hint key would only make a wrong recommendation
   more precise. If a per-department key is wanted later, use the `bounds`
   origin, not `roomIds[0]` (which changes when the lowest-id suite is sold).
9. **MINOR — §2's reframe is right, but argued the hard way.** The owner's ask
   ends *"...that are separated by a wall."* Internal walls were requested in
   terms; §2 spends its argument on lead shielding and `drawRoom` invalidation
   when a one-line quote closes it. §2 also does not address the first half of
   the same sentence — *"the user can expand the entire area"* — which
   describes a DRAG gesture (the `expandRoom` verb), not a card button.
   Add-suite is a defensible substitution but must be named as one.
   On perception: four walled boxes plus a bounding box will read as "four
   X-ray rooms someone drew a box around". The signals that would actually
   sell one entity are a shared floor tint, a single department name over
   `bounds`, and suites biased to grow along one axis so departments read as
   rows.
10. NIT — §3.6 option (a) verified correct (same conclusion as 9.1).
