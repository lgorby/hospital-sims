# Amenities, EVS & facility-failure layer — design doc (v2, RATIFIED)

**Status: v2 RATIFIED (2026-07-18).** v0 was the warm-start brief; v1 the full
design; v2 folds ALL findings from the independent adversarial design review
(6 MAJOR / 12 MINOR / 7 NIT — every MAJOR lived where v1 claimed something
came "for free": review verdict §10). **Owner-ratified (2026-07-18, §8):**
Q1 bladder + thirst; Q2 use-based wear, disable-only failures; Q3 vending
$5/use through `billFee`; Q5 two roles (EVS + Maintenance Tech). Q1b (plant),
Q4 (patience + daily-rep mess consequences), Q6 (staging 1→2→3), Q7 (gate
geometry on live claims) stand as the review-endorsed recommendations.
Workflow (proven across Phase 2 / HINTS / the capacity epic): per-stage
implementation plan + pre-impl review → staged build with per-stage
adversarial reviews. Companion to `GAME_DESIGN.md` / `TECH_PLAN.md` (§3.1
SSOT); CLAUDE.md hard rules govern. All numbers below are **initial values**
— `balance.ts` becomes authoritative at implementation.

## 1. The owner's ask (2026-07-17, verbatim intent)

> "Do you have an option to buy things like trashcan, vending machines,
> restrooms, etc, janitors, Environmental Service Workers (EVS), maintenance,
> etc. We need piping to go bad, bathroom, people throwing up, etc"

A Theme-Hospital-style **upkeep layer**: buyable amenities, cleaning/repair
staff, and failure/mess mechanics that create ongoing operational pressure
beyond the current treat-and-bill loop.

## 2. Design principles

1. **Everything is data** (§3.1): amenity specs, need rates, mess/failure
   tunables all live in `src/sim/data/`; derivations in `formulas.ts`.
2. **Reuse the proven machinery, don't fork it**: restroom stalls use the
   Stage-A capacity system (`capacityOf`/`slotAnchorTile`); need side-trips
   use the M3 *sub-state* pattern (like `lost` — NOT a lifecycle stage);
   cleaning/repair work uses a job queue that mirrors the reservation
   lifecycle (assign → gather → work → release, with rule-7/8 analogues);
   daily cleanliness uses the M4 tally→`closeDay` pattern.
3. **Needs create pressure through patience, not new fail states.** Unmet
   needs multiply patience decay (the existing modifier stack). No new ways
   to die or AMA outside the existing AMA-eligible stages (§3.1 pins this:
   accident hits clamp, they never AMA a mid-gathering patient).
4. **The upkeep loop is payroll-shaped, like capacity**: amenities are cheap;
   the ongoing cost is EVS/maintenance salaries. The brake on ignoring it is
   patience/reputation bleed, mirroring how staffing gates capacity.
5. **Determinism holds**: every roll (vomit, litter, breakdown, burst spread)
   comes from `world.rng` inside the fixed tick order. Render-side mess/broken
   visuals hash tile coords / entity ids, never `Math.random`.
6. **Failures disable, never kill** (v1): a breakdown stops NEW dispatch to a
   room; active treatments complete. No mid-treatment patient harm.
7. **Every geometry change sweeps the new stores** (review MAJORs 2/4, MINOR
   12): build, expand, sell (rooms AND amenities) each state what happens to
   messes, jobs, and live claims on the affected tiles. "It can't happen
   there" is not a rule; the sweep is.

## 3. Stage 1 — amenities & patient needs

### 3.1 New need meters: bladder + thirst

Two per-patient meters, spawn-initialized from `world.rng` (60–100), decaying
like patience (flat per-game-hour rates in `BALANCE.needs` — acuity does not
change how badly you need a restroom):

| Meter | Decays | Below `seekThreshold` (35) | At 0 |
|---|---|---|---|
| `bladder` | ~10/game-hour | seeks a restroom stall | **accident**: one-time patience hit (−20), meter resets to 100; Stage 2 upgrades this to also drop a mess |
| `thirst` | ~8/game-hour | seeks a vending machine | clamps at 0 (no event); the unmet multiplier keeps stacking |

While a meter sits below its threshold and the patient is NOT actively
relieving it, patience decay gains a ×1.25 multiplier per unmet need —
multiplying into the existing stack (standing 1.5× / waiting-quality /
comfort-aura 0.75×), exactly how those compose today (M3-gate ruling).
Worst-case stack (acuity 5, standing, both needs unmet): 12 × 1.5 × 1.25² ≈
28/h → ~3.6h to AMA vs ~5.5h today — bounded, harness-checked (review NIT 23).

**Accidents never create a new AMA path** (review MINOR 11, principle 3):
the −20 hit clamps patience at a floor of 1 in non-AMA-eligible stages
(`reserved`/`checkingIn`/`queuedCheckIn` — see `isAmaEligible`, decay.ts);
in AMA-eligible stages patience just drops and the normal rules apply.

Meters decay in `updateDecay` beside patience (one decay system). They decay
in every pre-terminal stage but are **only actionable** (trigger a side-trip)
in `waiting`/`waitingTriage` — queued-at-desk patients won't abandon the desk
slot, reserved patients won't break a gathering, `atEntrance` patients aren't
checked in yet. Thought log gains need thoughts ("needs the restroom…").

Why both meters and not bladder-only (§8 Q1): they share ONE mechanism
(meter → seek amenity → occupy → reset), so thirst's marginal cost is small,
and thirst is what makes vending machines *do* something (revenue + Stage-2
litter) instead of being decor.

### 3.2 The need side-trip (sub-state, not a stage)

A new patient sub-state, following the `lost` precedent (M3: detours are NOT
lifecycle stages — the stage machine and its guard table stay untouched):

```ts
needBreak: {
  kind: 'restroom' | 'vending';
  /** restroom: roomId + claimed stall slot; vending: the machine's tile. */
  roomId?: number; slot?: number; tile?: GridPoint;
  phase: 'walking' | 'using';
  ticksRemaining: number;        // set when `using` begins
  startedAt: number;             // abandon watchdog (see below)
} | null
// Patient also gains: needBreakHoldUntil: number  (the dispatchHoldUntil analogue)
```

- **Trigger** (new `updateNeeds` system): an eligible waiter whose meter is
  below threshold claims the nearest free stall / free vending machine and
  walks there via the normal walker machinery. **Gates on the trigger**
  (review MAJOR 1 — this is the M3 `canReachRoom` class): `lost === null`
  (never `setWalkerTarget` a lost patient — the "lost walkers stay wanderers"
  invariant), `tick >= needBreakHoldUntil`, and a `findPath` reachability
  check to the target — never claim a stall you can't walk to (an unreachable
  claim + the dispatcher skip would otherwise hide the patient in a permanent
  abandon/re-claim loop). Their **stage stays `waiting`/`waitingTriage`** and
  `waitingSince` keeps aging (Flow rule 6 — a restroom trip never costs queue
  priority). `waitingRoomId` is **cleared at break start** (review MINOR 13):
  the seat is released for real arrivals; the patient re-competes for one on
  return. (Accepted edge: a patient who goes lost mid-break decays at the
  standing 1.5× until recovery.)
- **The dispatcher skips on-break patients** exactly like lost ones (one more
  clause in `dispatchable`). Symmetric cost: they can miss a dispatch window;
  they re-enter the pool the tick the break ends.
- **Using**: restroom ~3 game-minutes, vending ~1. On completion the meter
  resets to 100, vending charges the patient $5 → revenue (§3.4), and the
  patient re-runs `assignWaitingSpot` (seat may be gone → standing fallback,
  Flow rule 4 — unchanged machinery).
- **Lostness composes**: the walk uses normal per-tile wrong-turn rolls; a
  lost on-break patient is just lost (retains target, recovery machinery
  unchanged). **Watchdog**: a break older than 30 game-minutes that never
  reached `using` is abandoned. Abandonment (and any failed claim) clears the
  sub-state AND `target`/`path`, sets `needBreakHoldUntil` (+15 game-min) so
  the same doomed trip can't rearm next tick, then: non-lost patients get
  `assignWaitingSpot`; lost patients get target = null — the lost-timeout
  semantics, NOT a retained target a later recovery would walk into a stall
  they no longer hold (review MAJOR 1 + MINOR 10).
- **Terminal events clear it** (rule-7 analogue): death/AMA/discharge clears
  `needBreak` at the existing choke points — stall/machine claims are
  derived (§3.3), so release is automatic on every deletion path.
- Patience decay during a break: the walk is purposeful (free, Flow rule 3);
  while `using`, patience decay pauses (relief is relief; using is ≤3
  game-minutes, no camping exploit at that duration).

### 3.3 The restroom (a room, stalls = Stage-A capacity)

New `ROOM_DEFS.restroom`: category `comfort`, kind `treatment` (walled +
door), min 2×3, cost $2,500, `staffedBy: []` (unstaffed, like waiting),
`capacity: { kind: 'perProp', prop: 'toiletStall', noun: 'Stalls' }`, props:
`toiletStall` (non-walkable, `perTiles` 1 per 3 tiles, min 2 — min-size room
derives exactly 2). It prices and expands via the capacity-epic machinery
(expand-vs-build-two parity verified in review: ceil(2500/6) = $417/tile,
no arbitrage).

**Stall occupancy is DERIVED, not stored**: a stall is taken iff some live
patient's `needBreak` references `{roomId, slot}`. No new reservation-like
store, no release bookkeeping to leak — rule 7 falls out of clearing the
sub-state. `updateNeeds` assigns stalls sequentially (lowest free slot via
the Stage-A slot machinery), so two patients can't claim one stall in a tick.

**Live claims gate geometry changes** (review MAJOR 2 — slot indices are
row-major over the rect, so expansion RENUMBERS them; `Reservation.slotIndex`
was made stored-stable for exactly this reason, and stall claims get neither
protection): `validateRoomExpand` and `validateRoomSell` on a restroom also
reject while ANY live `needBreak` references the room — walking claimants
included, symmetric with the reservation gate ("Occupied" reason). §8 Q7
ratifies this (the alternative — clearing/re-deriving claims on expand — is
listed there). The inspect panel's occupancy line for restrooms counts
`needBreak` claims, NOT reservations (review MINOR 7 — the capacity inspect
code reads `reservationsOn`, which is always empty here); the Treating list
renders as "In use" with claimant names.

### 3.4 Freestanding amenity props (NEW build surface)

Trashcans and vending machines belong in corridors/waiting areas, not inside
a room type — this epic adds the game's first **roomless placeable prop**:

- `AMENITY_DEFS` (new `src/sim/data/amenities.ts`): `trashcan` ($150),
  `vending` ($1,200), `plant` ($300, pure comfort — stretch, §8 Q1b). All
  1-tile. **Rule, not coincidence** (review NIT 22): amenity props are
  ALWAYS non-walkable — room build/expand over an amenity tile is rejected
  by the existing 'Blocked by an object' check ONLY because of this; a
  walkable amenity would silently lose that protection. Their ids join
  `PropId` + `PROP_STYLE` (so `Tile.object`, the grid RLE, and its
  `PROP_IDS` border gate accept them); `AMENITY_DEFS` carries
  cost/behavior, `PROP_STYLE` carries art/tiles — a deliberate two-table
  split, same fact never in both.
- Placement: a new build-bar Comfort entry arms a 1-tile ghost →
  `placeAmenity` command. Validation (build.ts): tile walkable + unclaimed +
  roomless (corridor or open-plan tile; walled-room interiors rejected),
  no actor on the tile, **explicitly NOT the entrance tile** (review MAJOR
  5 — the reachability BFS seeds AT the entrance and cannot see its own
  start tile become unwalkable; a vending machine there would entomb every
  future spawn), and a **blocked-tile reachability BFS** — the room-build
  BFS overlays *walls*, so placeAmenity needs the variant that removes the
  candidate tile from the walkable set, then asserts the entrance still
  reaches every room door and every person's standing tile (no trapping).
- Selling: click-select, 50% back. **Selling an amenity sweeps its state**
  (review MAJOR 2/principle 7): live vending claims on it are cleared via
  the abandon path (§3.2 — hold set, meter unchanged), its `empty` job (if
  any) is deleted, its `amenities` entry removed. `amenityPlaced`/
  `amenitySold` events drive the render (roomless props have no
  `roomBuilt`/`drawRoom` to piggyback on — per-change draw invariant,
  review NIT 24) and the blocked-panel invalidation list (review MINOR 18).
- Vending economics (§8 Q3): a use charges $5 through **`billFee`** — so it
  lands inside `today.revenue` and `dayNet` like every fee (review MAJOR 3:
  v1's "billFee-style + separate tally" would have double-counted).
  `today.vendingRevenue` is a **breakdown line** incremented at the same
  choke point, displayed in the daily report, never added to `dayNet` again.
  One user at a time per machine (derived claim, like stalls). Payback ~6+
  days and demand-capped (review-verified: no vending-farm strategy).
- Trashcans do nothing in Stage 1 but exist and look right; Stage 2 gives
  them fill/overflow. (Shipping them in Stage 1 keeps Stage 2 sim-only.)

### 3.5 Save & compat (Stage 1 ⇒ SAVE_VERSION 4)

New surface: patient `bladder`/`thirst`/`needBreak`/`needBreakHoldUntil`,
`world.amenities` (map keyed by tile: kind + fill), restroom rooms +
`toiletStall`/`trashcan`/`vending`/`plant` tiles (grid RLE carries them),
`today.vendingRevenue`. Migration v≤3: meters default 100, `needBreak` null,
amenities empty. **`readTally` becomes version-aware** (review MAJOR 3 —
it currently `asNumber`-throws on ANY missing key, so a new tally field
refuses every old save): keys introduced at version N default to 0 when
loading version < N; pinned by a load-a-v3-fixture test. Border validation:
`needBreak` room/slot resolves (slot < grid-derived stall count),
**stall-claim exclusivity** (no two patients on one `{roomId, slot}` — the
`slotsHeld` mirror, review NIT 19), amenity-map keys carry the matching
`Tile.object`. Compat statement (review NIT 23): an old save plays
identically until meters cross thresholds — thirst is unrelievable until a
vending machine exists, which is intended pressure, bounded as §3.1.

**Round-trip gate pins, Stage 1** (review MINOR 15 — premises are asserted,
never assumed): at the save tick the scenario proves a `needBreak` in phase
`walking` AND one in `using` (one restroom, one vending), a non-full
trashcan, and a pending `needBreakHoldUntil`.

## 4. Stage 2 — EVS, messes & cleanliness

### 4.1 The mess model

`world.messes: Map<tileKey, Mess>` with `Mess = { kind: 'vomit' | 'litter' |
'water'; tile; since }` — a map like `reservations`, NOT a `Tile` field (the
grid RLE stays untouched; messes serialize explicitly). Messes are walkable
decals (V1 collision model unchanged); at most one mess per tile (a second
event on the tile refreshes `since`).

Sources (all rolls `world.rng`, rates authored **per-game-hour** and
converted to per-tick Bernoulli like decay — review MINOR 16: "per-minute"
doesn't fit the 3⅓-ticks-per-game-minute grid):
- **Vomit**: waiting/queued patients with `health < 30` (the existing
  critical-mood threshold) roll ~`1.2/game-hour` probability mass. On vomit:
  mess on their tile + small self patience hit (−5, same clamp rule as
  accidents). Bladder accidents (§3.1) now also drop a mess.
- **Litter**: a vending use drops litter on the patient's tile UNLESS a
  non-full trashcan is within radius 4 (then that can's `fill` +1, silently).
- **Water**: Stage 3 piping bursts (§5.4).
- **Trashcan overflow**: a can reaching `fill = 8` **mints a real `litter`
  mess on its tile** (review NIT 25 — overflow must enter `world.messes` or
  the cleanliness tally and proximity scan can't see it) and spawns an
  `empty` job. The mess clears when the can is emptied.

**Geometry sweeps** (review MAJOR 4 + principle 7): `buildRoom`,
`expandRoom`, and `sellRoom` all delete messes (and their jobs) on the
affected tiles — v1 covered sell/expand and missed build, which would have
buried a corridor vomit under a wall or prop as an uncleanable permanent
reputation leak. Jobs never block builds.

### 4.2 Cleanliness pressure (two channels, both cheap + deterministic)

1. **Proximity patience**: a mess within radius 3 of a waiting patient adds a
   ×1.25 patience multiplier (once, not per mess). Implemented as a
   **sim-side signature-cached check** like `hasComfortAura`/
   `auraCheckedTick` — `messRevision` is that cache's invalidation counter
   (review NIT 24: it is NOT a render-overlay key; mess decals are drawn
   per-change on mess events, and the aura overlay key is untouched).
2. **Daily reputation**: each tick, `today.messTicks += messes.size` (tally
   choke-point pattern, M4); `closeDay` converts: 0 messes all day = +2
   (clean-hospital bonus), else −1 rep per 4 mess-hours, capped at −15/day.
   Applied **beside the wait bonus, before the report snapshot** (review
   MINOR 17 — `closeDay`'s order is load-bearing; the delta must land inside
   `repDelta` and the report).

### 4.3 The job queue (the NEW duty kind — the epic's biggest sim change)

```ts
// world.jobs: Map<number, Job>
Job = { id; kind: 'clean' | 'empty' | 'repair';
        tile?: GridPoint; roomId?: number;      // clean/empty target vs repair target
        staffId: number | null;                  // null = queued
        phase: 'queued' | 'assigned' | 'working';
        ticksRemaining: number;
        holdUntil: number }                      // retry hold (rule-8 analogue)
// StaffDuty gains: | { kind: 'job'; jobId: number }
```

- **Creation**: a mess spawns a `clean` job; an overflowing can an `empty`
  job; a breakdown a `repair` job (Stage 3). One job per target (keyed
  check), auto-created in the sim — the player never micro-assigns.
- **Assignment** (dispatcher, new `assignJobs` step): idle EVS → oldest
  queued clean/empty job past its `holdUntil` whose target is reachable
  (`findPath` gate, the `canReachRoom` analogue — never assign a doomed
  job); idle maintenance → oldest repair. Oldest-first is deterministic and
  starvation-free. Destination: the mess tile if unclaimed, else an
  adjacent walkable tile (rule-14 claim-aware picking, review NIT 20);
  non-walkable targets (cans, broken rooms) always use adjacent tiles.
- **Lifecycle mirrors reservations**: assigned worker walks to the target;
  arrival flips `working` and sets `ticksRemaining` (clean ~2 game-min,
  empty ~1, repair ~15, skill-scaled via the existing duration formula);
  completion removes the mess / resets `fill` / clears `broken`. **Then the
  worker steps out of any walled room unconditionally** — the
  `releaseReservation` clause verbatim (review MAJOR 6: v1 said
  "nearestFreeStandingTile if their tile is claimed", which leaves an EVS
  idling INSIDE the restroom they just mopped, pinning its sale — the M3
  no-loitering invariant applies to the release path, not just claimed
  tiles). Same step-out on every release path below.
- **Rule-7/8 analogues (load-bearing)**: firing a worker mid-job re-queues
  the job (`staffId = null`, phase `queued`); a worker who stalls (arrived,
  not at target, no path) re-queues the job + sets its `holdUntil` (+5
  game-min) so an unreachable mess doesn't spin assign/cancel every tick.
- **The orphan rule is general** (review MINOR 12): any job whose target no
  longer resolves — mess deleted, can sold, room sold — is deleted at the
  geometry-change choke points (§4.1 sweeps, §3.4 amenity sell, §5.2 room
  sell), releasing its worker (step-out included). Never a job spinning on
  a target that can't exist again.

### 4.4 New role: EVS Worker

`ROLE_DEFS.evs`: label "EVS Worker", salary ~$90/day, `standingPost: false`,
color — a brown/tan family (0x9b7653-ish), deliberately far from the existing
teal/green cluster (the art-review color-spread note). Idle EVS wander to
standing spots like released staff today. Hire panel/candidates/save all
inherit (roles are data). Skill affects clean speed via the existing
duration-skill formula.

### 4.5 Save & compat (Stage 2 ⇒ SAVE_VERSION 5)

New: `world.messes`, `world.jobs`, trashcan `fill` (in the v4 `amenities`
map), the `job` duty kind, `evs` role, `today.messTicks` (version-aware
tally default, as §3.5). Migration v≤4: empty maps. Border: job↔mess/room
referential integrity, `duty.jobId` resolves, one job per target, job phase
consistent with `staffId`. **Round-trip pins, Stage 2**: a live mess with a
`queued` job, an `assigned` job (worker walking), a `working` job mid-timer,
and a can at `fill > 0`.

## 5. Stage 3 — failures & maintenance

### 5.1 Wear & breakdown (use-based, not random-clock)

Rooms with a `failure` entry in their def wear out by USE — deterministic
pressure the player can reason about ("that CT has run all week"):

```ts
// RoomDef gains: failure?: { kind: 'mechanical' | 'piping' }
// Room gains:    wear: number; broken: boolean
```

- Every completed treatment increments the room's `wear`; **restroom visits
  increment wear at `needBreak` completion in `updateNeeds`** (review §5
  probe: restrooms have no reservations, so their wear hook lives in the
  needs system, not treatment). At each increment, roll
  `p = wearFactor × wear` from `world.rng`; on failure → `broken = true`,
  `wear = 0`, spawn a `repair` job + `roomChanged` (renderer draws the
  broken state per-change — sparks/steam decal, hashed variety).
- `wearFactor` initial values: mechanical 0.002/use (expected MTBF ≈ 31
  uses), piping 0.001/use (≈ 45 visits — restrooms are the highest-traffic
  room in the game, and every piping failure is a multi-mess event; review
  MINOR 14 killed v1's 0.004 "gentle" claim, ~22-use MTBF ≈ daily
  breakdowns). **Explicitly harness-tuned before ship.**
- Proposed `failure` roster: imaging (xray/ct/mri/nucMed) + surgery + resp =
  `mechanical`; restroom + dialysis = `piping`. Reception/waiting/triage/
  exam/atrium don't break (v1 — desks don't explode).

### 5.2 Broken rooms disable, never harm (§8 Q2)

`capacityOf(broken room) = 0` — the Stage-A machinery makes "no new
dispatch" one line (review-verified: `hasOpenSlot` gates all dispatch paths;
a transiently negative `openSlots` while actives finish is safe). Active
reservations complete normally; gathering reservations are cancelled via the
existing rule-8 cancel (release + re-queue + retry hold). A broken restroom
rejects new stall claims; occupants finish. **Geometry rules** (review MINOR
12): a broken room CANNOT be expanded (validateRoomExpand rejects — no
adding beds to a capacity-0 room, no "Beds 2/0" inspect line); it CAN be
sold (the general orphan rule deletes the repair job and releases the
tech). Inspect shows "OUT OF SERVICE — repair pending/underway".

### 5.3 New role: Maintenance Tech

`ROLE_DEFS.maintenance`: label "Maintenance Tech", salary ~$140/day, color
orange family (0xe07a3f-ish). Repairs via the Stage-2 job machinery (~15
game-min base, skill-scaled). No preventive maintenance in v1 (watch for a
Phase-2 "inspect/service to reset wear" mechanic).

### 5.4 Piping bursts

A `piping` failure additionally spawns 2–4 `water` messes on rng-picked
walkable tiles **inside the failing room + orthogonally-adjacent corridor/
open-plan tiles only** (review NIT 21 — never inside a *neighboring* walled
room: no water through walls) — so a burst restroom needs BOTH trades:
maintenance to fix, EVS to mop. That's "piping to go bad" in one event.

### 5.5 Save & compat (Stage 3 ⇒ SAVE_VERSION 6)

New: `room.wear`/`broken`. Migration v≤5: wear 0, broken false. Border:
broken rooms have a matching repair job (or one is minted on load).
**Round-trip pins, Stage 3**: nonzero wear on a room, a broken room with a
queued repair, and one mid-repair.

## 6. Hints & needs-panel integration

`computeBlockedNeeds` extends with a **third kind** (review MINOR 9 — v1's
"extends naturally" understated a real shape change):

```ts
kind: 'room' | 'role' | 'broken'
// 'broken': key `broken:<roomId>`, room type + roomId payload, no patient
// count, label "X-Ray is broken — needs repair"; sorts with urgent rows.
```

- `room:restroom` — patients below bladder threshold, no restroom built
  (urgent when someone is actively seeking; upcoming otherwise).
- `role:evs` — messes exist, none hired (urgent at ≥3 standing messes; the
  scan reads `world.messes`, which the signature already has access to).
- `role:maintenance` — a room is broken, none hired (always urgent).
- `broken:<roomId>` — per-room callout. Toasts key on the breakdown
  INSTANCE (`broken:<roomId>:<tick>`), not the room (review MINOR 8 —
  `hintedOnce` persists for the save's lifetime, so a room-keyed toast
  would announce only the first breakdown ever).
- **Panel invalidation** (review MINOR 18 — the paused-staleness class):
  `amenityPlaced`/`amenitySold`/`messChanged`/`jobChanged`/`roomBroken`
  events join the blocked-panel invalidate list beside `roomChanged` (tick
  recompute covers the running sim; commands apply while paused).

## 7. Engineering implications (beyond the per-stage save notes)

- **Tick order** grows two systems: spawn → decay (meters too) → thoughts →
  **needs (side-trips, restroom wear)** → dispatcher (**+ assignJobs**) →
  wayfinding → movement → treatment (**+ wear/breakdown rolls**) →
  **mess/cleanliness tally** → economy. Exact slots frozen in the
  implementation plan; determinism only needs the order fixed.
- **Determinism**: new rolls (vomit, litter-drop, breakdown, burst spread,
  meter spawn values) all `world.rng` in-order; the fixed-seed replay gate
  and float-op lint stay green; challenge comparability shifts again
  (accepted honor-system stance, CHALLENGES_PLAN §10).
- **Balance/harness**: the reference build gains a restroom, vending,
  trashcans, 1 EVS (+1 maintenance in Stage 3); the operating envelope
  assertion must stay green — need multipliers stack on the M4-tuned
  patience economy (worst case computed in §3.1), and wearFactor MTBFs are
  §5.1's explicit tuning target. A harness balance pass closes each stage.
- **Render invariants hold**: amenity/stall/mess/broken textures generated
  at init; mess decals + broken-state visuals drawn per-change on their
  events (`messChanged`, `roomChanged`, `amenityPlaced`/`amenitySold`),
  never in the per-frame hot path; the aura overlay key is untouched.
- **Perf**: `updateNeeds` scans patients (O(P)); job assignment scans jobs ×
  idle workers with a path check each — bounded like dispatch today; the
  mess proximity check is signature-cached per tick (`messRevision`).
  Nothing per-frame.

## 8. Owner decisions to ratify (recommendations bolded)

1. **Needs scope** — **bladder + thirst** (shared mechanism, thirst powers
   vending; no hunger v1). Fallback: bladder-only, vending becomes ambient.
   1b. Include the decorative `plant` (pure patience aura, $300)? **Yes,
   cheap** — zero mechanics, cuttable freely (non-walkable like all
   amenities — pinned rule, §3.4).
2. **Failure model** — **use-based wear, rolled at use-completion; failures
   disable rooms, never interrupt active treatments or harm patients** (v1).
   Initial MTBFs ≈ 31 uses mechanical / 45 piping, harness-tuned (the
   review rejected v1's faster numbers as ~daily breakdowns). Alternatives:
   random clocks (feels arbitrary), mid-treatment aborts (re-queue
   complexity + player rage) — both rejected in draft.
3. **Vending revenue** — **yes, $5/use through `billFee`** (inside normal
   revenue/dayNet; the daily report shows a vending breakdown line).
   Alternative: free (pure patience relief).
4. **Mess consequences** — **patience (proximity ×1.25) + daily reputation
   (clean-day +2 / −1 per 4 mess-hours, cap −15/day)**. No infection/health
   effects v1.
5. **Role split** — **two roles: EVS Worker (clean/empty) + Maintenance
   Tech (repair)** — matches the owner's verbatim list; two salaries is the
   payroll-shaped pressure this design leans on. Fallback: one combined
   "Facilities" role (cheaper, less texture).
6. **Staging** — **Stage 1 amenities+needs → Stage 2 EVS+messes → Stage 3
   failures+maintenance**, each independently shippable, each with the full
   milestone workflow. Ordering is load-bearing: Stage 2's job machinery is
   Stage 3's foundation; Stage 1 ships trashcans/vending so Stage 2 is
   sim-only.
7. **Live claims vs geometry** (surfaced by the design review) — when a
   restroom with active/walking stall claimants is expanded or sold:
   **block with an "Occupied" reason, symmetric with the reservation gate**
   (recommended — claims are short-lived, the gate clears in minutes).
   Alternative: clear/re-derive claims on the spot (more code, permits the
   action immediately). Amenity sale always clears its claims (not gated —
   machines are claimed near-constantly).

## 9. Out of scope (this epic)

- Infection / disease spread from messes (health effects — big balance
  surface, needs its own design).
- Staff needs (staff don't eat/tire in v1).
- Hunger meter / food court; incinerators; bulk-buy amenity placement.
- Preventive maintenance & machine-quality degradation before failure.
- Patient click-highlight and capacity/contention hints — separate quick
  passes (HANDOFF), not this epic.

## 10. Design review of record (v1 → v2)

Independent adversarial design review, 2026-07-18: **6 MAJOR / 12 MINOR /
7 NIT — all folded above.** The MAJORs, for the record: (1) need side-trips
lacked the `canReachRoom`-class reachability gate + retry hold (permanent
hidden-from-dispatch abandon/re-claim loops); (2) derived stall claims are
renumbered by expansion and unprotected by the reservation gates (→ §8 Q7 +
amenity-sale sweeps); (3) new `DayTally` keys refuse every pre-v4 save
(`readTally` throws on missing keys → version-aware defaults) + the
billFee/dayNet double-count ambiguity; (4) `buildRoom` could bury a mess
under walls/props forever (→ the general geometry sweep, principle 7);
(5) `placeAmenity` could occupy the entrance tile — the BFS structurally
cannot detect its own seed tile becoming unwalkable (→ explicit rejection +
blocked-tile BFS variant); (6) job completion inside walled rooms left
workers loitering (→ the `releaseReservation` step-out clause verbatim).
Review verdict: ready for ratification once folded; §8 recommendations
endorsed except Q2's wear numbers (softened, as above).
