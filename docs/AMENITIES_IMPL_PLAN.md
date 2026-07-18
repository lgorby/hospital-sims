# Amenities epic — implementation plan (Stage 1: amenities + needs)

**Status: STAGE 1 IMPLEMENTED (2026-07-18)** — shipped through the full
workflow: freeze → 3 parallel tracks → 2 adversarial reviews (code/contract:
1 MAJOR vending stand-zone + 2 MINOR; live-drive: 2 MAJOR — checklist×vending
`feeBilled` source, blocked-panel occlusion row cap — all fixed with
regression tests; 377 tests green). Implementation deltas from this plan:
`feeBilled` gained a `source` discriminator; the vending stand pick/flip
gained the standing-zone rule; the blocked panel gained a row cap; the
restroom "In use" line labels walking claimants "(on the way)"; report rows
renamed "Patient fees" / "Sell-back income". Stages 2/3 get their sections
in their own sessions.
Contract: `docs/AMENITIES_PLAN.md` v2 RATIFIED (all § references below are to
it unless noted). Pre-impl review findings (6 MAJOR / 5 MINOR / 3 NIT) all
folded: §1.12 freeze block (cross-track compile surfaces), the committed-
`next` + `recomputePaths` clauses, the frozen walking→using flip + stalled-
arrival abandon, the failed-claim hold, the harness section (§5), the
`isAmaEligible` clamp-set correction (design-doc erratum recorded there).
Workflow: freeze contract → parallel build (disjoint tracks) → adversarial
reviews (code/contract + live-drive) → gates → commit.

## 0. Stage-1 scope (and non-scope)

IN: bladder+thirst meters, need side-trips (§3.1–3.2), restroom room (§3.3),
freestanding amenities trashcan/vending/plant (§3.4), vending revenue,
plant comfort aura, SAVE_VERSION 4 (§3.5), hints `room:restroom`, UI/render
for all of it.
OUT (Stage 2/3): messes, jobs, EVS/maintenance roles, wear/broken, `fill`
mutation (the field ships in v4, value stays 0), mess-proximity patience.

## 1. Frozen contract (orchestrator writes these BEFORE tracks start)

### 1.1 `src/commands.ts`
```ts
| { type: 'placeAmenity'; kind: AmenityId; col: number; row: number }
| { type: 'sellAmenity'; col: number; row: number }
```

### 1.2 `src/events.ts`
```ts
amenityPlaced: { col: number; row: number; kind: AmenityId };
amenitySold: { col: number; row: number; kind: AmenityId };
```

### 1.3 `src/sim/data/amenities.ts` (new)
```ts
export const AMENITY_DEFS = {
  trashcan: { label: 'Trashcan', cost: 150 },
  vending: { label: 'Vending Machine', cost: 1_200 },
  plant: { label: 'Plant', cost: 300 },
} as const satisfies Record<string, { label: string; cost: number }>;
export type AmenityId = keyof typeof AMENITY_DEFS;
export const AMENITY_IDS = Object.keys(AMENITY_DEFS) as AmenityId[];
```
RULE (§3.4, test-enforced): every AmenityId is also a PropId and is placed
NON-walkable — the room-build 'Blocked by an object' rejection depends on it.

### 1.4 `src/sim/data/rooms.ts`
- `PropId` += `'toiletStall' | 'trashcan' | 'vending' | 'plant'`;
  `PROP_STYLE` entries (all `tiles: 1`; colors/rises at art discretion).
- `ROOM_DEFS.restroom`: label 'Restroom', kind 'treatment', category
  'comfort', minCols 2, minRows 3, cost 2_500, staffedBy [], capacity
  `{ kind: 'perProp', prop: 'toiletStall', noun: 'Stalls' }`, props:
  toiletStall, non-walkable, `perTiles` tilesPerProp 3, min 2 (2×3 min = 6
  tiles derives exactly 2 — the §3.3 numbers).

### 1.5 `src/sim/data/balance.ts`
```ts
needs: {
  bladderPerGameHour: 10, thirstPerGameHour: 8,
  seekThreshold: 35, unmetPatienceMultiplier: 1.25,
  accidentPatienceHit: 20, accidentPatienceFloor: 1,
  restroomUseGameMinutes: 3, vendingUseGameMinutes: 1,
  breakWatchdogGameMinutes: 30, breakRetryGameMinutes: 15,
  vendingPrice: 5, spawnMeterMin: 60,
  plantAuraRadius: 2,
},
```
Spawn meter roll = rng in [spawnMeterMin, stats.vitalsMax].

### 1.6 `src/sim/entities/patient.ts`
```ts
export type NeedBreak = {
  kind: 'restroom' | 'vending';
  roomId?: number; slot?: number;   // restroom claims
  tile?: GridPoint;                  // vending claims (the MACHINE tile)
  phase: 'walking' | 'using';
  ticksRemaining: number;            // set at `using` start
  startedAt: number;                 // watchdog anchor
};
// Patient fields: bladder: number; thirst: number;
// needBreak: NeedBreak | null; needBreakHoldUntil: number;
```

### 1.7 `src/sim/world.ts` — new surface (stubs in the freeze; Track S fills)
```ts
amenities: Map<string, { kind: AmenityId; tile: GridPoint; fill: number }>;
  // keyed `${col},${row}`; fill always 0 in Stage 1 (Stage-2 field, §3.5)
amenityAt(col, row): AmenityState | null;
stallClaims(roomId): Map<number, number>;        // slot → patientId (derived scan)
freeStallIndex(room): number | null;             // lowest unclaimed, claim-aware
vendingClaimedBy(tileKey): number | null;        // derived scan
placeAmenity(kind, tile) / sellAmenity(tile);    // command handlers (validate → mutate → emit)
clearNeedBreak(patient, opts: { hold: boolean }); // THE one abandon/clear path (§3.2)
```
`applyCommand` wires the two commands; terminal choke points (`killPatient`,
`patientLeavesAma`, `dischargePatient`) call `clearNeedBreak(p, {hold:false})`.
**Both `placeAmenity` and `sellAmenity` end with `recomputePaths()`** (pre-
impl MAJOR 2 — movement never re-validates steps; a precomputed path through
the new machine must be repaired, exactly as buildRoom/sellRoom do). Amenity
purchase/sale hit the `construction`/`sellIncome` tally buckets (else
`dayNet` diverges from real cash movement); the sell payout AND the inspect
button label read one `amenitySellback(kind)` in formulas.ts
(`AMENITY_DEFS[kind].cost × economy.roomSellbackRatio` — the sellbackAmount
pattern).
`refreshAuras`' signature gains plant tiles; `auraRevision` bumps on
place/sell (plant aura = comfort aura within `plantAuraRadius`, new pure
`plantCoversTile` in formulas.ts beside `auraCoversTile`).

### 1.8 `src/sim/build.ts`
```ts
validateAmenityPlace(world, kind, tile): { ok: true } | { ok: false; reason: string };
  // bounds; tile walkable + no object + roomId null-or-open-plan; NOT the
  // entrance tile (explicit — review MAJOR 5); no person's `at` OR committed
  // `next` on the tile (the build-validator clause, build.ts:75 — NOT
  // isTileClaimed, which misses `next`; pre-impl MAJOR 2) and the tile
  // unclaimed as a target; cash ≥ cost; blocked-tile BFS: with `tile`
  // removed from the walkable set, entrance still reaches every room
  // door.outside AND every person's standing tile (the §3.4 variant —
  // walls-overlay BFS is NOT sufficient).
validateAmenitySell(world, tile): amenity exists.
```
`validateRoomExpand` / `validateRoomSell`: + reject when any live `needBreak`
references the room (walking OR using) — reason 'Occupied' (§3.3/§8 Q7).

### 1.9 Systems
- `src/sim/systems/patientNeeds.ts` (new): `updatePatientNeeds(world)` — the
  §3.2 machine:
  - **Trigger gates**: eligible stage, meter < threshold, `lost === null`,
    `tick >= needBreakHoldUntil`, findPath reachability. **A failed claim
    (unreachable target, no free stall, no free standing tile) sets
    `needBreakHoldUntil` (+`breakRetryGameMinutes`) WITHOUT creating a
    break** (pre-impl MAJOR 4 — design §3.2's "any failed claim"; otherwise
    every below-threshold waiter re-runs findPath every tick forever).
  - **Walk goal computed ONCE at claim time** (pre-impl MAJOR 3 — never
    re-derive `slotAnchorTile` per tick: it's claim-order-dependent and its
    fallthrough consumes rng). Vending standing tile: picked at claim time,
    claim-aware, deterministic (fixed `ORTHOGONAL_STEPS` order, first
    walkable+unclaimed neighbor); zero available → failed claim (hold).
  - **walking→using flip (FROZEN)**: `phase === 'walking' && walkerArrived
    && (restroom: isInsideRoom(at, room) | vending: at orthogonally
    adjacent to needBreak.tile)`. **Arrived anywhere else → immediate
    abandon via `clearNeedBreak({hold:true})`** — the rule-8 stalled
    analogue; never wait out the watchdog, never flip `using` in a corridor
    (pre-impl MAJOR 3: `setWalkerTarget` nulls target on no-path, so a dead
    path reads as "arrived").
  - **Completion**: meter reset to `stats.vitalsMax`, vending →
    `billFee(vendingPrice, 'Vending')` + `today.vendingRevenue += price`
    (same choke point), `assignWaitingSpot`, clear sub-state.
  - **Watchdog** abandon via `clearNeedBreak(p, {hold:true})`, which nulls
    target/path per the lost/non-lost rule (§3.2).
  - **Accident × in-flight break** (pre-impl MINOR 8): a bladder accident
    clears a matching in-flight restroom break via `clearNeedBreak` (no
    hold — the meter is full again); the claim must not pin "Occupied"
    gates for a need that no longer exists.
- Tick order (world.tick): … thoughts → **updatePatientNeeds** → dispatcher …
- `decay.ts`: meter decay (all pre-terminal stages); unmet ×1.25 per meter
  below threshold unless the matching break is `using`; patience decay
  paused while `using`; bladder-0 accident (hit, clamp floor
  `accidentPatienceFloor` where `isAmaEligible` is FALSE — that set is
  `checkingIn`/`reserved`; `queuedCheckIn` is AMA-eligible today and stays
  so, pre-impl MAJOR 6 / design erratum; reset to `stats.vitalsMax`);
  thirst clamps at 0.
- `dispatcher.ts`: `dispatchable` += `p.needBreak === null`.

### 1.10 `src/sim/save.ts` — SAVE_VERSION 4 (§3.5)
- SavedPatient += the four fields (compile-enforced readers); v≤3 defaults:
  meters `stats.vitalsMax` (normative — not a literal 100), needBreak null,
  hold 0. `readPatient` gains the `saveVersion` param (the `readReservation`
  slotIndex precedent — pre-impl MINOR 11); call site in
  `readRestorePayload` updated.
- serializeWorld += `amenities` (array, immediately after `rooms` — frozen
  position, §1.12; byte-identity fixtures pin it forever).
- `readTally` becomes version-aware: `vendingRevenue` defaults 0 for v<4
  (review MAJOR 3); `DayTally`/`DayReport` gain `vendingRevenue`.
- Border: needBreak roomId → restroom room, slot ∈ [0, grid-derived stall
  count), claim exclusivity across patients (NIT 19), vending claim tile
  carries `vending`; amenity entries ↔ roomless prop tiles match BOTH ways.
- Save-gate scenario pins (§3.5): a `walking` break + a `using` break (one
  restroom, one vending), a placed trashcan, a pending needBreakHoldUntil.

### 1.11 UI/render contract
- Build bar Comfort dropdown: amenity entries (label + $cost, red-tint when
  unaffordable — the existing `cashChanged` pattern); arming enters a 1-tile
  amenity placement mode (renderer ghost, validity tint + hintLine reason).
- Inspect: restroom occupancy from `stallClaims` ("Stalls 1/2", "In use:
  <names>") — NOT reservations (review MINOR 7); amenity click-select →
  card (label, Sell 50%); patient card gains bladder/thirst meter rows.
- blockedPanel invalidation += `amenityPlaced`/`amenitySold` (MINOR 18).
- `needs.ts`: `room:restroom` need — urgent when ≥1 patient below bladder
  threshold with no restroom built; upcoming otherwise while patients exist.
- Render: 4 new prop textures (init-time, `propKey` contract); roomless
  prop draw/remove on `amenityPlaced`/`amenitySold` (per-change — §3.4);
  aura overlay unchanged (auraRevision covers plants).
- Thoughts: break-start + accident thought lines (data in thoughts.ts —
  frozen, §1.12: Track S emits the keys, Track U only displays).
- `room:restroom` urgency (pre-impl MINOR 9): urgent = ≥1 patient in
  `waiting`/`waitingTriage` (the actionable stages, design §3.1) below the
  bladder threshold with no restroom built; upcoming otherwise while
  patients exist. Label (the panel+toast SSOT): "Build a Restroom —
  patients need the restroom".
- Sell MODE ignores amenity tiles in Stage 1 ("No room there" stands);
  amenities sell via the inspect card only (pre-impl NIT 14 — deliberate,
  noted for the live-drive reviewer).

### 1.12 Cross-track compile freeze (pre-impl MAJOR 1 — all written by the
orchestrator so every track compiles from minute one)

- `render/renderer.ts`: `UiMode` += `{ kind: 'placeAmenity'; amenity:
  AmenityId }` (setMode accepts it, ghost inert until Track R);
  `Selection` += `{ kind: 'amenity'; col: number; row: number }` (amenities
  have no entity id — the tile IS the identity; `stillExists` checks
  `world.amenityAt`). `pickAt` priority: patient > staff > amenity > room.
- `sim/dailyStats.ts`: `DayTally`/`DayReport` += `vendingRevenue`;
  `emptyDayTally` seeds 0.
- `sim/data/thoughts.ts`: the new thought keys + lines (needsRestroom,
  needsVending, accident).
- `sim/formulas.ts`: `amenitySellback(kind)` (§1.7).
- `serializeWorld`: the `amenities` array slots immediately after `rooms`
  (fixed NOW — the byte-identity fixtures pin insertion order forever).

## 2. Track split (disjoint file ownership — the proven parallel workflow)

Freeze (orchestrator, before tracks): 1.1–1.6 AND 1.12 fully; 1.7/1.8 as
typed stubs returning inert values, so every track compiles from minute one.

- **Track S (sim + tests)**: world.ts, build.ts, save.ts, decay.ts,
  patientNeeds.ts, dispatcher.ts, needs.ts, formulas.ts (fills the frozen
  `amenitySellback`), newGame.ts (nothing expected), test/*. Owns making
  the stubs real, including the §5 harness update.
- **Track U (UI)**: ui/buildMenu.ts, ui/inspect.ts, ui/blockedPanel.ts,
  ui/dailyReport (vending line) + any ui/dom glue. Reads only the frozen
  surface (thoughts.ts data is frozen, not Track U's — pre-impl MAJOR 1).
- **Track R (render)**: render/sprites/*, renderer.ts (amenity placement
  mode + ghost + roomless prop layer + pickAt amenity hit), hintLine reasons.

Each track verifies `tsc --noEmit` + scoped lint before reporting. Then two
parallel adversarial reviewers (code/contract vs live-drive via
`/run-hospital-simms`), fix ALL findings + regression test per major, gates
green, HANDOFF, commit.

## 3. Test list (Track S authors; ~35 new)

1. Meter decay rates + spawn ranges (rng-rolled, deterministic per seed).
2. Unmet multiplier stacking: standing 1.5 × 1.25² × comfort 0.75 exact.
3. Patience paused while `using`; walk legs free (Flow rule 3 analogue).
4. Accident: hit + reset; clamp floor where `isAmaEligible` is false
   (`checkingIn`, `reserved`); normal AMA path in `atEntrance`/
   `queuedCheckIn`/`waitingTriage`/`waiting` (principle 3, erratum fixed).
5. Trigger gates: unreachable restroom never claimed (design MAJOR 1); lost
   patients never trigger; hold respected; hold set on watchdog abandon AND
   on failed claims (unreachable target probed once per hold window, not
   per tick — pre-impl MAJOR 4).
5b. Stalled arrival (dead path → "arrived" in the corridor) abandons
   immediately with hold — never flips `using` outside the target
   (pre-impl MAJOR 3).
5c. Accident mid-break clears the in-flight restroom claim (no hold);
   expand/sell gates release (pre-impl MINOR 8).
6. Claim exclusivity: two below-threshold waiters, one stall → sequential.
7. Watchdog: non-lost → assignWaitingSpot + hold; lost → target null
   (MINOR 10 semantics).
8. Dispatcher skips on-break patients; re-enters pool when break ends.
9. Terminal events clear breaks (all three choke points).
10. `waitingRoomId` cleared at break start; seat re-competed on return.
11. Restroom expand/sell rejected while claimed (walking AND using);
    allowed after clear (§8 Q7).
12. Amenity validation: entrance tile, walled interior, occupied tile,
    actor-claimed tile, a walker's committed `next` on the tile (pre-impl
    MAJOR 2), cash, trap-BFS (a corridor pinch-point machine that strands a
    door or person → rejected; design MAJOR 5 class).
12b. Mid-path walker re-routes after placement (`recomputePaths` called by
    placeAmenity AND sellAmenity — pre-impl MAJOR 2).
13. Amenity sell: vending mid-use → claim cleared via abandon path (hold
    set, meter unchanged), refund correct.
14. Vending: $5 through billFee (revenue + dayNet single-count, MAJOR 3),
    `vendingRevenue` breakdown line tallied at the same choke point.
15. Plant aura: `plantCoversTile` radius; auraRevision bumps on place/sell;
    patience multiplier applies.
16. Save: v4 round-trip byte identity; v1/v2/v3 fixtures load (tally
    default — the v3-fixture test, MAJOR 3); border suites (needBreak
    resolution, exclusivity, amenity↔tile both ways); gate scenario pins.
17. needs.ts: `room:restroom` urgent/upcoming rules; label wording.
18. Amenities-are-non-walkable rule test (NIT 22) + PROP_STYLE tiles ≤ 2
    still green for new ids.
19. Restroom `perTiles` derivation: 2×3 → exactly 2 stalls (harness-safe
    construction rule).

## S2 — Stage 2 implementation plan (EVS + messes) — IMPLEMENTED (2026-07-18)

**Shipped** through the full workflow: freeze → 3 parallel tracks → 2
adversarial reviews. Code/contract review: 1 MAJOR (through-wall clean via
the work-tile derivation — fixed with `world.canApproach`, the single
wall-logic source `canStep` now composes on) + 1 MINOR (fill upper bound in
the border) + 2 NIT (working-worker adjacency bound; `evsUrgentMesses`
moved into BALANCE.mess). Live-drive review: **COMMIT — 0 MAJOR, 12/12
checklist PASS** (v4 compat proven against a real production save); its 3
visual MINORs fixed: prop-tile decals spill toward the front edge (chair
vomits + can overflow were fully occluded), and the amenity hover hint now
runs the real validator so hover and click never disagree. 439 tests.

Contract: AMENITIES_PLAN §4 (ratified) + the banked Stage-1 review notes
(HANDOFF Next): geometry sweeps (design MAJOR 4), worker step-out via the
`releaseReservation` clause (design MAJOR 6), `messChanged`/`jobChanged` in
the panel invalidation list (MINOR 18), `amenities.fill` already in v4.
Pre-impl review (7 MAJOR / 8 MINOR / 4 NIT) folded throughout; the MAJORs:
sold-can orphaned mess, overflow double-mint + re-entrant removeMess,
unimplementable `standableTile` shape, `STAFF_DUTY_LABELS` compile surface,
understated rng blast radius (the evs CONSTRUCTOR candidates dominate),
assignment-loop hold semantics, contradictory vomit stage set. **Design
deltas flagged for owner** (erratum-style, adopt-unless-vetoed): (1) the
clean-day +2 applies only when `today.arrivals > 0` — the ratified §4.2
didn't contemplate empty days, and the wait bonus already excludes them
("an empty hospital isn't fast"); (2) idle EVS stand where released (like
all released staff) — §4.4's "wander" overstated what released staff do.

### S2.0 Scope

IN: `world.messes` + vomit/litter/accident-mess sources, trashcan
fill/overflow, the job queue + `{kind:'job'}` duty (clean/empty; `repair`
reserved in the unions for Stage 3, no producer), EVS role, cleanliness
(proximity patience + daily rep), SAVE_VERSION 5, hints `role:evs`,
mess decals + EVS render, report cleanliness row.
OUT (Stage 3): wear/broken, repair jobs, piping bursts, `water` messes
(the KIND ships in the union/save schema; no producer).

### S2.1 Frozen contract

**`BALANCE.mess`** (new block): `vomitPerGameHour: 1.2` (per-tick Bernoulli;
threshold reuses `BALANCE.mood.criticalHealthBelow` — no new number; fix the
stale "`moodOf` is the only reader" comment beside it, pre-impl NIT 16),
`vomitSelfPatienceHit: 5` (same clamp rule as accidents),
`litterTrashcanRadius: 4` (Chebyshev, like the plant aura),
`trashcanCapacity: 8`, `patienceMultiplier: 1.25`, `patienceRadius: 3`
(Chebyshev), `cleanDayRepBonus: 2`, `messHoursPerRepPoint: 4`,
`dailyRepCap: 15`, `cleanGameMinutes: 2`, `emptyGameMinutes: 1`,
`jobRetryGameMinutes: 5`.

**Vomit eligibility (FROZEN stage set — pre-impl MAJOR 7):** patients in
`atEntrance | queuedCheckIn | checkingIn | waitingTriage | waiting` (the
pre-terminal, non-reserved set) with `health <
BALANCE.mood.criticalHealthBelow` roll; **needBreak holders DO roll** (their
stage stays waiting — being en route to the restroom doesn't settle a
stomach). Design delta recorded: §4.1 said "waiting/queued"; `atEntrance`
is included deliberately (a critical patient stuck outside an unstaffed
hospital vomiting at the door is exactly the pressure this layer sells).

**Types** — `world.ts`: `Mess = { kind: 'vomit'|'litter'|'water'; tile:
GridPoint; since: number }`; `entities/staff.ts`: `Job = { id: number;
kind: 'clean'|'empty'|'repair'; tile: GridPoint; staffId: number | null;
phase: 'queued'|'assigned'|'working'; ticksRemaining: number; holdUntil:
number }` (repair's `roomId` variant is Stage 3 — tile-only now; job ids
come from `takeId()` — they join the border's global-uniqueness register
and the `nextEntityId` bound, pre-impl MINOR 8); `StaffDuty` +=
`{ kind: 'job'; jobId: number }`. `ROLE_DEFS.evs`: label 'EVS Worker',
`salaryPerDay: 90`, color 0x9b7653, `standingPost: false`.

**`format.ts` (FREEZE — pre-impl MAJOR 4, the cross-track compile
surface):** `STAFF_DUTY_LABELS` gains the `job` key, and `staffDutyLabel`
gains an optional third param: `staffDutyLabel(duty, reservationPhase?,
jobKind?: 'clean' | 'empty' | 'repair')` → 'Cleaning' / 'Emptying a
trashcan' / 'Repairing' when duty.kind === 'job' (falls back to the record
label without jobKind). The inspect caller resolves jobKind from
`world.jobs` (Track U wiring only).

**Events**: `messChanged: { col; row }` (add OR remove — renderer re-syncs
the tile), `jobChanged: { jobId }`. Both join the blocked-panel invalidate
list AND the save-gate `EVENT_NAMES` record.

**Formulas**: `cleanlinessRepDelta(messTicks, arrivals): number` — the ONE
formula: 0 mess-ticks AND `arrivals > 0` → `+cleanDayRepBonus` (an empty
hospital isn't clean, it's closed — the wait-bonus principle; design delta
flagged, pre-impl MINOR 15); 0 mess-ticks with no arrivals → 0; else
`−min(dailyRepCap, floor(messHours / messHoursPerRepPoint))` — called by
`closeDay` AND the report row. Job durations reuse
`treatmentDurationTicks(base, skill, 0)` (quality 0 — no new formula).

**World surface** (stubs at freeze): `messes: Map<tileKey, Mess>`,
`jobs: Map<number, Job>`, `addMess(kind, tile)` (one-per-tile — a second
event refreshes `since`; mints a `clean` job iff none targets the tile;
`messChanged` + `messRevision++`), `removeMess(tile)` (delete + orphan-job
delete/worker-release + `messChanged` + `messRevision++`),
`hasMessNear(p)` (signature-cached per tick — the `auraCheckedTick`
pattern, `messRevision` its invalidation counter).

**`standableTile(p, opts?: { sameRoomAs?: GridPoint })`** (pre-impl MAJOR
3 — the frozen signature must express the same-room exception):
corridor/open-plan OR inside the room containing `opts.sameRoomAs`, AND
never any room's door.inside/outside. Call-site declarations, frozen: the
vending stand PICK calls it with NO opts (vending stays corridor-only —
the exception cannot leak); `assignJobs` passes `sameRoomAs: job.tile`
(an accident inside a treatment room is worked from that room's interior);
the Stage-1 walking→using FLIP is **untouched** (zone-only, its frozen
contract — no door-rule bolt-on). Claim-awareness (`isTileClaimed`) stays
a separate check at each call site, as today. patientNeeds' local
`standingZoneOk`/`onDoorTile` refactor onto this without behavior change.

`writeStaffDuty`/`readStaffDuty` gain the 'job' case at freeze (exhaustive
switch — compile requires it), as do `SavedStaffDuty` and the border duty
checks.

### S2.2 Mess sources & sinks (Track S)

- New `systems/mess.ts` → `updateMess(world)`, tick slot AFTER treatment,
  BEFORE economy (design §7 order): (1) vomit rolls — per-tick Bernoulli
  over waiting/queued/at-entrance patients below the critical-health
  threshold, fixed map order; on vomit: `addMess('vomit', patient.at)` +
  self patience hit (accident clamp rule); (2) the tally:
  `today.messTicks += messes.size`.
- Bladder accidents (decay.ts) now also `addMess('vomit', at)` — the §3.1
  Stage-2 upgrade. (Accident mess kind is vomit — one decal family.)
- Vending completion (patientNeeds.ts): nearest non-full trashcan within
  `litterTrashcanRadius` (Chebyshev) → `fill += 1` silently (no event —
  the inspect card is frame-polled); tie-break: FIRST minimal-distance can
  in `world.amenities` insertion order (placement order, save-stable —
  `restoreInto` preserves it; pre-impl MINOR 11); none → `addMess('litter',
  patient.at)`. **Overflow order (FROZEN — pre-impl MAJOR 2):** a can
  REACHING `trashcanCapacity` mints the `empty` job FIRST, then
  `addMess('litter', can.tile)` — the one-job-per-target check then
  suppresses addMess's clean-job mint (no double-mint; the overflow decal
  on a non-walkable tile is fine, decals aren't collision).
- **decay.ts** (pre-impl MINOR 9 — the dropped-work-item): the proximity
  patience channel lives here: `hasMessNear(patient.at)` → ×
  `BALANCE.mess.patienceMultiplier`, ONCE (not per mess), inside the
  waiting-in-place block, composing multiplicatively with the Stage-1
  stack (standing × waiting-quality × comfort × unmet-needs).
- `closeDay`: `applyReputation(cleanlinessRepDelta(today.messTicks,
  today.arrivals))` beside the wait bonus, BEFORE the snapshot (order is
  load-bearing).
- **Geometry sweeps** (design MAJOR 4 / principle 7): `buildRoom`,
  `expandRoom`, `sellRoom`, AND `placeAmenity` delete messes (+ their
  jobs, releasing workers) on affected tiles via `removeMess`. Jobs never
  block builds. **`sellAmenity` on an overflowed can (pre-impl MAJOR 1 —
  the orphaned-mess rep-leak):** delete the `empty` job, then
  `removeMess(can.tile)` — the overflow litter leaves WITH the can (the
  can's contents were the mess; the tile underneath is clean). Never a
  mess with no job and no minter left behind.

### S2.3 The job queue (Track S — dispatcher)

- **`assignJobs(world)` (FROZEN loop — pre-impl MAJOR 6, the hot-loop/
  starvation class):** inside `updateDispatcher` after `assignTreatment`.
  Per idle EVS (not firing): scan queued clean/empty jobs **oldest-first =
  lowest job id** (ids from `takeId()`, monotonic), SKIPPING jobs with
  `holdUntil > tick`; per candidate job, probe = derive the work tile
  (the mess tile itself if walkable + `standableTile(tile, {sameRoomAs:
  tile})` + unclaimed, else the first claim-aware standable orthogonal
  neighbor via `standableTile(p, {sameRoomAs: job.tile})` — this
  adjacent-neighbor rule is what keeps a mess under a seated patient
  workable, so long claims starve nothing) + `findPath`; probe FAILURE →
  `job.holdUntil = tick + gameMinutesToTicks(jobRetryGameMinutes)` and
  **continue to the next job** (a held/unworkable oldest job never blocks
  younger workable ones; a failed probe is not re-run until its window
  expires). Probe SUCCESS → assign: `staffId`, phase 'assigned', duty
  `{kind:'job', jobId}`, `setWalkerTarget(worker, workTile)`,
  `staffUpdated` + `jobChanged`.
- `progressJobs(world)` (same system; **iterates `[...world.jobs.values()]`
  — completion mutates the map, pre-impl MAJOR 2**): `assigned` + arrived
  at the work tile → `working` + `ticksRemaining =
  treatmentDurationTicks(base, skill, 0)`; arrived ANYWHERE else (dead
  path) → requeue + hold (the rule-8 stalled analogue, immediate).
  `working` counts down → **completion order (FROZEN):** clean →
  `removeMess` (the job is deleted by removeMess's orphan clause with the
  worker already detached — see below); empty → `fill = 0` → delete the
  empty job + release the worker → `removeMess(can.tile)` (which then
  finds no job — never a re-entrant delete of the completing job). Either
  way the worker STEPS OUT of any walled room unconditionally
  (`releaseReservation` clause verbatim — design MAJOR 6), duty idle,
  `staffUpdated` + `jobChanged`.
- `fireStaff` mid-job (any phase): job requeued (`staffId` null, phase
  queued, hold NOT set — the job didn't fail); the worker follows the
  existing firing release path. Rule-7 analogue. (Consumer inventory note:
  today's `fireStaff` would fall through to instant `removeStaff` leaving
  a dangling `staffId` — the 'job' branch is REQUIRED, not optional.)
- **The general orphan rule** (design MINOR 12): `removeMess` deletes the
  job targeting that tile in every phase, releasing its worker (idle +
  step-out). Idle EVS between jobs stand where released, like all released
  staff (design §4.4's "wander" overstated — delta noted; live-drive
  reviewers: an EVS standing at the entrance post-hire is correct).
- Accepted V1-collision looseness (pre-impl NIT 17): a working EVS near a
  reception queue line can transiently share a tile with a re-slotted
  queue patient — `queueSlotTile` re-slotting ignores claims today for
  ALL staff; not a Stage-2 regression, not fixed here.

### S2.4 Save v5 (Track S)

**SAVE_VERSION 5.** `SavedMess`/`SavedJob`; staff duty 'job';
`today.messTicks` (`TALLY_KEY_VERSIONS: 5`). **Serializer positions
(FROZEN — byte-identity fixtures pin insertion order forever, pre-impl
MINOR 8): `messes` then `jobs` immediately after `amenities`.** Job ids
join the global-uniqueness register and the `nextEntityId` bound. Border:
mess tiles in bounds, ≤1 per tile, kind valid (`water` ACCEPTED — a clean
job cleans any mess); **`kind: 'repair'` jobs REJECTED in v5** (reserved
union value with no legal target — a shape-valid repair job would sit
queued forever, pre-impl MINOR 10); job↔target both ways (clean → a mess
on the tile; empty → a trashcan amenity on the tile; ≤1 job per tile),
`duty.jobId` resolves AND `job.staffId` back-references (queued ⇔ staffId
null; assigned/working ⇒ an `evs` staff whose duty is that job),
`ticksRemaining` bounded by the longest job duration × the slowest skill
factor, `holdUntil` finite (the `readNeedBreak` bounding precedent).
Migration v≤4: empty maps, messTicks 0. NOTE: `topUpCandidates` mints evs
candidates on every v≤4 load — the v4 byte-identity fixture test becomes a
fixture-LOAD test (see the harness section). **Round-trip pins**: a live
mess with a `queued` job, an `assigned` job (worker mid-walk), a `working`
job mid-timer, a queued job with `holdUntil > tick` (the Stage-1 hold-pin
precedent), a can at `fill > 0`, and `today.messTicks > 0` at the save
tick. **Gate-scenario sketch (pre-impl MINOR 14, so this isn't
renegotiated mid-build):** hire 2 EVS; poke `health = 20` on a few waiters
(the established field-poke pattern — border-valid, self-consistent) so
vomits occur organically; `fill > 0` comes from the scenario's existing
adjacent vending/trashcan pair; `working` lasts only ~7–9 ticks, so the
pipelineRich-style poll must catch the queued+assigned+working conjunction
(≥3 standing messes makes it reachable).

### S2.5 UI (Track U)

`format.ts` is FROZEN (S2.1) — Track U only wires the inspect staff card
to pass `jobKind` from `world.jobs` and shows the duty line; daily report
Cleanliness row (reads `cleanlinessRepDelta(report.messTicks,
report.arrivals)` — "spotless +2" / "−N (X mess-hours)" / absent on an
empty day); blockedPanel invalidate list += `messChanged`/`jobChanged`;
`role:evs` need row (needs.ts is Track S: urgent at ≥`3` standing messes
with no EVS hired, upcoming when any mess exists; label 'Hire an EVS
Worker — messes need cleaning'; **`patients` field = the standing-mess
count** — pre-impl MINOR 13, it drives the sort tie-break and messes
aren't patients; the >8-urgent-rows panel-cap occlusion edge is accepted:
urgent rows sort strictly first); trashcan inspect card gains a
"Fill N/8" line (frame-polled — no event needed). DOM tests for each.

### S2.6 Render (Track R)

Mess decal textures at init (vomit splat / litter scraps / water puddle —
water unused until Stage 3), variety hashed on tile coords; drawn
per-change on `messChanged`, sprites keyed by tile in a Map, in a **new
`decalLayer` Container inserted between `roomFloorLayer` and `sortedLayer`
in the camera child order** (pre-impl MINOR 12 — `sortedLayer` has no
"actor band" to slot under; a dedicated layer above floors, below the
depth-sorted world is the implementable home). EVS character — the
role-color pipeline covers a new RoleId automatically (verified:
characters.ts iterates ROLE_IDS with a generic-hair fallback); decide
whether evs joins SCRUB_CAP_ROLES (recommend no — cap-free distinguishes
from nurse teal at a glance); a working EVS gets no special animation in
v1 (noted, not built).

### S2.6b Harness & fixed-seed gate (Track S — a Stage-2 EXIT GATE, pre-impl
MAJOR 5: the rng blast radius, honestly stated)

THREE stream-shift sources, in blast-radius order: (1) **`ROLE_DEFS.evs`
itself is the dominant shift** — the World CONSTRUCTOR mints
`candidatesPerRole` candidates per role (~12 extra seeded draws before
tick 0), so EVERY seeded World in the suite diverges from construction,
strictly more invasive than Stage 1's per-spawn meter rolls; (2) vomit
Bernoulli draws (run-length-dependent — only when sub-critical-health
patients exist in eligible stages; short unit fixtures mostly untouched,
the harness and gate-enrichment loops are not); (3) the reference build's
EVS hire. Policy unchanged: **re-pin, never weaken** — the seed is the
fixture; audit alternates before settling on one, and record the rationale
in-file (the Stage-1 1337→1338 precedent). `topUpCandidates` mints evs
candidates on every v≤4 load, so the v4 byte-identity fixture test
converts to a fixture-LOAD test. Per-patient Bernoulli is the RIGHT
determinism call (the wrong-turn per-tile precedent; an aggregate roll
can't attribute the mess tile + self hit without extra draws) — do not
"optimize" it mid-build. Reference build hires 1 EVS; the operating
envelope must stay green with messes occurring organically.

### S2.7 Tests (Track S + U; ~35 new)

Vomit Bernoulli (rate conversion + the FROZEN stage set exactly — including
needBreak holders roll, `reserved` doesn't + fixed rng order); accident
drops a mess; litter vs trashcan radius (in/out/full + the
insertion-order tie-break); **overflow mints empty-job-BEFORE-addMess (no
clean-job double-mint — ≤1 job per tile holds at the overflow instant,
pre-impl MAJOR 2)**; one-job-per-target; tally + `cleanlinessRepDelta`
boundaries (0+arrivals → +2; **0 arrivals → 0, the empty-day gate**; cap;
the 4-mess-hour step) + closeDay order (delta inside repDelta AND the
snapshot); proximity multiplier stacks with the Stage-1 stack (× standing
× unmet × comfort, once not per mess); **assignJobs: oldest = lowest id;
a HELD job is skipped, not blocking (a younger workable job assigns the
same tick); a failed probe is not re-probed until its window expires
(pre-impl MAJOR 6)**; the same-room work rule (mess inside a treatment
room IS workable from inside; vending stands stay corridor-only — the
opts cannot leak, pre-impl MAJOR 3); mess under a seated patient →
adjacent work tile (no starvation); stalled-arrival requeue;
fire-mid-job requeue (all 3 phases — the dangling-staffId branch);
**empty-completion order: fill=0 → job deleted → removeMess finds no job
(no re-entrant delete)**; completion step-out (worker never idles inside
a walled room — the sell gate stays clear); geometry sweeps
(build/expand/sell/placeAmenity over a mess: mess + job gone, worker
released); **sellAmenity on an overflowed can: empty job deleted AND the
overflow mess leaves with the can — no orphaned rep-leak (pre-impl MAJOR
1)**; save v5 round-trip byte identity + border suites (incl. repair-job
rejection, water-mess acceptance, holdUntil bound) + v4-fixture LOAD
(messTicks default + evs candidate top-up) + the S2.4 pins; needs
`role:evs` urgent/upcoming + the `patients`=mess-count sort; harness per
S2.6b.

### S2.8 Live-drive checklist (reviewer 2)

Drive a busy hospital until someone vomits (or force low health via debug);
see the decal; hire an EVS; watch them walk, clean, decal clears; duty line
reads "Cleaning"; fill a trashcan to overflow via vending uses; watch the
empty job; sell the can mid-job (job vanishes, worker released); build a
room over a mess (mess swept); daily report cleanliness row both ways
(spotless +2 / penalized); blocked panel "Hire an EVS Worker" appears at 3
messes and clears on hire — including while paused; console hygiene
throughout.

## 4. Harness & fixed-seed gate (Track S — a Stage-1 EXIT GATE, pre-impl MAJOR 5)

Design §7 requirement, previously dropped: `test/harness.test.ts`'s
reference build (`STANDARD_ROOMS`) gains a restroom + vending machine +
trashcan; the operating-envelope assertions (totalTreated, died bound,
reputation > 0, per-condition discharges) must stay green with meters live.
The two spawn-meter rng draws shift EVERY fixed-seed trajectory — expected;
Track S re-validates all fixed-seed tests and re-pins updated expectations
where tests pin exact streams (never weaken an assertion to pass — retune
`BALANCE.needs` if the envelope breaks, and record the tuning like the M4
pass). The §3.1 worst-case decay-stack bound (≈3.6h to AMA) gets a direct
formula test.

## 5. Live-drive checklist (reviewer 2)

Build a restroom + vending + trashcan + plant; fast-forward until a patient
takes each break kind; verify "Stalls 1/2" + "In use"; sell a claimed
vending machine; try to place a machine on the entrance (rejected, reason
shown); try to expand an occupied restroom ("Occupied"); daily report shows
the vending line; old-save import (a v3 export) loads and plays.
