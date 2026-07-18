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
