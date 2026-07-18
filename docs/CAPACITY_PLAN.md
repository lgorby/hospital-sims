# Room capacity & growth — design scoping (the "bigger rooms do more" epic)

**Status: v2 RATIFIED (2026-07-18) — adversarial design review round 1 folded
in (5 major, 6 minor, 2 nit); all five §8 owner decisions ratified same day
(recommended options across the board — see §8 markers). NOT yet implemented;
next step = the Stage-0 implementation plan + pre-impl review (§7).** Owner ask: "as
more patients come, the ER may need to get larger to handle more patients and
doctors at once with more beds — and not just the ER: the waiting room and
other areas too." Owner follow-up ruling: **size affects cost** ("the
expansion would also affect the cost to resize") — folded into §4 as the
size-based economy. Companion to `GAME_DESIGN.md` / `TECH_PLAN.md` (§3.1
SSOT); CLAUDE.md hard rules govern. Workflow: this doc → owner ratification of
§8 → implementation plan + pre-impl review → staged build.

## 1. The gap this closes

Today, room SIZE buys only *quality* (faster treatment; slower seated patience
decay). It never buys *capacity*:

- **Every treatment room serves ONE patient at a time** — `roomBusy` treats any
  reservation on the room as "occupied," however large the room.
- **The waiting room seats exactly `WAITING_ROOM_BASE_CHAIRS` (6)** — a
  constant, matched by 6 chair props at build. A giant waiting room adds zero
  seats; overflow stands at 1.5× patience decay.
- **Props are fixed counts**, auto-placed once at build (dialysis already
  places 2 machines — but still treats 1 patient).
- **Throughput scaling today = build MORE rooms.** Legitimate, but land-hungry
  and not the hospital-ward fantasy.
- **No way to grow an existing room** — sell (50% refund) + rebuild.

Two mechanics, one epic (owner ruling: both, all room types considered):
**(A) capacity that scales with the room**, **(B) expanding built rooms** —
built on **(0) a size-based room economy** (v2: review MAJOR 1 + owner
ruling — pricing must land BEFORE capacity does, or stage A ships giant
drag-built rooms as a strictly dominant strategy).

## 2. Design principles

1. **Capacity is data, not code** (§3.1): a per-room-type `capacity` rule in
   `ROOM_DEFS`; sim and UI read the same derivation. No constant like
   `WAITING_ROOM_BASE_CHAIRS` survives outside the tables.
2. **Props ARE the capacity**: beds/chairs/machines are the visible slot
   tokens. A bigger room auto-places more (density rule); the count IS the
   concurrency. Formula (SSOT, `formulas.ts` — review MINOR: strips!):
   `slotCount(room) = tilesWithObject(slotProp) / PROP_STYLE[slotProp].tiles`
   (exact — strip length is uniform per prop id).
3. **The reservation stays the atomic unit.** Multi-capacity = several
   independent reservations coexisting in one room, each with its own patient
   + staff set (all-or-nothing per reservation, unchanged). No shared-staff
   cleverness in v1 — 3 concurrent ER slots need 3 doctors + 3 nurses.
4. **Every existing flow invariant holds per-reservation** (rules 7/8, cancel,
   promote, terminal releases) — the room just stops being the lock.
5. **Size costs money** (owner ruling): the same `priceOf(type, rect)` formula
   prices a NEW build and an EXPANSION — one economy, no arbitrage between
   "build big" and "build small, grow later."

## 3. Mechanic A — capacity model

### 3.1 The rule (SSOT, `ROOM_DEFS`)

```ts
type CapacityRule =
  | { kind: 'single' }                       // today's behavior (default)
  | { kind: 'perProp'; prop: PropId };       // slots = slotCount (§2.2)
```

Proposed roster (owner call, §8 Q1):

| Room | Rule | Slot prop | Rationale |
|---|---|---|---|
| Waiting | `perProp: chair` | chair (seats, not treatments) | the direct fix for "6 seats forever" |
| ER Bay | `perProp: traumaBed` | trauma bed | the owner's scenario — a ward |
| Dialysis | `perProp: dialysisMachine` | machine | fiction is a bay — but see §8 Q2 (the 1→2 retro jump) |
| Exam | `single` | — | multiple exams in one room reads odd; a second Exam Room is cheap |
| Triage | `single` | — | a triage BAY; parallel triage = build another |
| Imaging (X-ray/US/CT/MRI/NucMed) | `single` | — | one machine, one scan |
| Surgery | `single` | — | one table, one operation — sacred |
| Reception/Atrium | n/a | — | not treatment capacity (queue/aura systems own them) |

### 3.2 Prop density (how bigger rooms grow slots)

`props[].count` becomes `props[].density`:

```ts
type PropDensity =
  | { kind: 'fixed'; count: number }              // today (machines, desks)
  | { kind: 'perTiles'; tilesPerProp: number; min: number; max?: number };
```

- Waiting chairs: 1 per 1.5 tiles, min 6 (3×3 = 9 tiles → 6 — today's build
  unchanged; arithmetic review-verified).
- ER beds: rule constraint — **min size ⇒ exactly today's count (1 bed)** so
  the reference build behaves identically; growth earns bed 2, 3…
- **Known exception — Dialysis (review MAJOR 2):** it already places 2
  machines at min size, and old saves' grids contain both. `perProp` capacity
  means every existing dialysis room jumps 1→2 concurrency at ship with no
  player action — including in the harness (nurse-pool pressure shifts).
  This cannot be silently absorbed → owner decision §8 Q2.
- The auto-layout algorithm (checkerboard seats / row-major machines, M3) runs
  with the derived count; placement stays deterministic and revert-on-strand.
- **Pre-epic oversized rooms (review MINOR):** capacity derives from the SAVED
  grid, so an old save's 6×6 waiting room keeps its 6 grid-frozen chairs until
  the player EXPANDS it (≥1 tile, re-densifies at the §4 price) or sells +
  rebuilds. Stated policy, not an accident.

### 3.3 Sim changes

- `roomBusy(room)` → `openSlots(room) = slotCount(room) − liveReservations(room)`;
  the dispatcher may reserve while `openSlots > 0`. `single` rooms: unchanged.
- **Slot binding IS new saved state (review MAJOR 3):** each reservation
  carries a `slotIndex` (which bed/machine it holds), assigned at reservation
  time from the free-slot set. An on-the-fly "nth reservation → nth bed"
  derivation is unstable (a cancellation would rebind everyone mid-walk). So:
  `Reservation.slotIndex` ⇒ `SavedReservation` field ⇒ **`SAVE_VERSION` bump
  + v2-loadable migration** (§5 is honest about this now).
- **Per-slot anchoring is NEW machinery (review MINOR):** walk targets anchor
  beside the reservation's slot prop. Today `freeInteriorTile` picks random
  interior tiles and falls back to CLAIMED tiles when full — at ward
  occupancies (3 patients + 6 staff) that stacking returns. Scope: a
  `slotAnchorTiles(room, slotIndex)` derivation + claimed-tile exclusivity,
  with the rule-8 stall check (arrived-but-not-inside-room — verified
  multi-party-safe) unchanged.
- Waiting seats: `assignWaitingSpot` capacity check reads `slotCount`, not the
  constant. Seat-tile picking already scans chair props (converges).
- Treatment math per reservation unchanged. **No crowding penalty in v1**
  (§8 Q5).
- Events/day-tally: per-reservation choke points already — no change.

## 4. Mechanic 0+B — the size-based economy and the expand tool

### 4.1 Pricing (SSOT `formulas.ts`, used by BUILD and EXPAND alike)

```
priceOf(type, rect)   = cost + perTileRate(type) × (area(rect) − minArea(type))
perTileRate(type)     = ceil(cost / minArea)         // derived; bespoke rates = §8 Q3
expandPrice(type, old, new) = priceOf(type, new) − priceOf(type, old)
sellback(type, rect)  = floor(priceOf(type, rect) × roomSellbackRatio)
```

- **New builds pay for size too** (review MAJOR 1 + owner ruling): stamping at
  min size costs exactly today's `cost`; drag-to-grow charges per added tile
  AT BUILD TIME. This lands in **stage A** — capacity must never ship ahead
  of it.
- **Sellback becomes rect-aware** (review MAJOR 4): refunds derive from
  `priceOf(type, rect)` — fully rect-derivable, NO amount-paid bookkeeping,
  no new save field. Known consequence: rooms built oversized BEFORE this
  epic refund more than they paid (a one-time, bounded legacy arbitrage per
  pre-epic room; a fresh run has none because build pricing = refund basis
  from tick 0). Documented + accepted unless the owner objects (§8 Q3).
- The build-menu price readout and ghost show the LIVE price as the rect
  grows (the red-unaffordable tint keys on it).

### 4.2 The expand gesture

- Select a built room → "Expand" (inspect-panel action beside Sell) →
  placement-style ghost of the CURRENT rect; drag outward to a superset rect.
  Live price readout = `expandPrice`.
- **Validation** (delta tiles through the `validateRoomRect` machinery):
  bounds; added tiles unoccupied (no rooms/props/actors) and walkable;
  entrance-reachability BFS for every door + person (unchanged invariant);
  **door orphan rule (review MINOR, now precise): reject iff the new rect
  contains `door.outside`** (the inside tile stays inside, so the door edge
  stays on the boundary in every other case).
- **Occupancy rule (review MINOR — Sell's "empty of people" would break the
  headline case):** expansion requires the room RESERVATION-FREE, but seated/
  standing occupants are ALLOWED (their tiles don't change; delta tiles must
  be actor-free — already required). A full waiting room can expand; a
  mid-surgery OR cannot (§8 Q4 confirms).
- **Effect:** rect grows → props re-derive from density — **additive only**:
  existing prop tiles are preserved verbatim (byte-identity of untouched
  layout), new props auto-place on the ADDED area's tiles via the
  deterministic layout; if a new prop placement would strand tiles it reverts
  (existing rule) → quality recomputes → capacity rises.
- **Aura invariant fix (review MAJOR 5):** `refreshAuras`' signature cache
  assumes rects never change post-build — an expanded atrium would keep its
  OLD coverage. The atrium rect joins the aura signature (and thus
  `auraRevision`/the overlay cache key) as part of this epic; until that
  lands, open-plan rooms are EXCLUDED from the expand tool.
- Renderer: walls/floors/props rebuild on a `roomChanged` event
  (per-room-build, not per-frame — invariant held). Quality moves to a
  `roomQuality(type, rect)` formula in `formulas.ts` (review NIT — it's
  inline in `buildRoom` today; expansion is the second caller).

## 5. Save/load, determinism, challenges

- `Reservation.slotIndex` ⇒ `SAVE_VERSION` 3, v1/v2 loadable (migration:
  legacy reservations get slot 0 — correct, since legacy rooms have exactly
  one slot's worth of concurrency). Prop layouts stay in the grid RLE; load
  never re-runs layout, so placement byte-identity holds by construction.
- The fixed-seed round-trip gate must be re-proven with a multi-slot scenario
  (reservations in both phases across ≥2 slots of one room).
- **Challenge comparability (review MINOR):** this epic changes balance on
  the live deploy; Phase-2 challenges are honor-system + co-versioned, so
  cross-version score comparisons break — the known, accepted Phase-2 stance
  (CHALLENGES_PLAN §2.1). This epic is the concrete case the deferred Phase-3
  rules-identity notice exists for; shipping it does NOT pull that work
  forward (owner may revisit).

## 6. UI surfacing (review MINOR — was missing)

- Inspect panel (room): "Beds 2/3" (or "Seats 9/12") capacity line via the
  same `slotCount` formula; 'Treating' becomes a LIST of current occupants
  (today's `.find` shows one arbitrary patient of N); Expand button with live
  `expandPrice`.
- Build menu: entry price is the MIN-size price (unchanged label); the ghost
  carries the live grown price.
- Blocked-needs/hints: existence hints stay as-is this epic; the deferred
  "capacity/contention" hint pass gains a natural phrasing ("expand your ER
  or build another") — explicitly OUT here, noted in HINTS backlog.

## 7. Staging (three stages, this order)

1. **Stage 0 — size-based pricing** (`priceOf`/rect-aware sellback + live
   price readouts). Small, independently shippable, closes the drag-big
   exploit BEFORE capacity exists.
2. **Stage A — capacity** (density rules + multi-slot dispatch + slot
   anchoring + seat-count fix + SAVE_VERSION 3). The big one.
3. **Stage B — expand tool** (gesture + validation + additive re-densify +
   aura-signature fix). Ships the owner's headline scenario end-to-end.

Each stage: implement → adversarial review → fix-all + regression tests →
gates → commit (the standard workflow).

## 8. Owner decisions — RATIFIED (2026-07-18)

1. **Multi-slot roster = the §3.1 table as proposed.** Waiting (seats=chairs),
   ER (trauma beds), Dialysis (machines) scale; Exam, Triage, all Imaging,
   and Surgery stay `single`.
2. **Dialysis retro jump = ACCEPTED.** Existing rooms/saves go 1→2 concurrent
   at ship (the room finally does what it visually promises); the harness is
   re-baselined as part of Stage A.
3. **Pricing = derived rates, quirk accepted.** `perTileRate =
   ceil(cost/minArea)` for every type (zero new balance numbers); sellback is
   rect-aware via the same `priceOf`; the one-time legacy-room refund
   arbitrage is documented and accepted.
4. **Occupied-room rule = recommended default.** Expansion requires
   reservation-free; seated occupants allowed (a full waiting room CAN
   expand; a mid-surgery OR cannot).
5. **Caps & crowding = recommended defaults.** No hard per-room slot cap (map
   + payroll are the brakes) and no crowding penalty in v1. Watch item: if
   one mega-room dominates in play, a per-room cap is the ready lever.

## 9. Explicitly OUT (this epic)

Sub-rooms/partitions inside a room (walls-within-walls is a rendering+pathing
project of its own; a multi-bed open ward delivers the gameplay value first —
revisit after this epic ships); shared/pooled staff across slots; nurse
stations/ward staffing auras; crowding penalties; capacity/contention hints
(HINTS backlog); moving/rotating built rooms; shrinking rooms; the Phase-3
rules-identity notice.
