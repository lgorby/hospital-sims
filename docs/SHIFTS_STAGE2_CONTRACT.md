# SHIFTS Stage 2 — Lunches & the Staff Lounge (CONTRACT)

**Status:** **v2 — both split-lens pre-impl reviews folded (2026-07-20).**
Mechanical/save/determinism lens and design/balance/game-feel lens both returned
READY-WITH-FIXES; every MAJOR/MINOR/NIT is folded below (see "### Review outcome").
Parent: `SHIFTS_PLAN.md` §5 (Stage 2 = *lunches + the lounge + break coverage*).
Stage 1 (two-shift coverage) is SHIPPED + DEPLOYED (`9ae3b95`, SAVE_VERSION 13).

**Save impact:** **SAVE_VERSION 13 → 14** — a new room type (`lounge`) AND new
saved staff break-state. Owed in BOTH directions: an older deployed build must
refuse a v14 save cleanly (`asOneOf(o.type, ROOM_TYPES)` would otherwise throw
on the new type) rather than crash — the failure class that owed v10→v11.

**Fatigue, morale, night differential, agency are OUT** — Stage 3
(`SHIFTS_PLAN.md` §5). This stage ships the break as a *coverage* mechanic only;
§7 lists the inert hooks Stage 3 will consume.

---

## Review outcome — what changed from v1 (all findings folded)

- **[MECH-MAJOR] gate lunch-start on `duty ∈ {idle, post}`, NOT the active-only
  "busy" test.** v1 copied `updateShifts`' `busy = res.some(active) || job`, which
  is safe there ONLY because the boundary unconditionally cancels gathers. The
  lunch path has no gather-cancel, so a staffer holding a *gathering* reservation
  read as free and could walk off mid-gather, stranding the patient (Flow rule 8).
  A `reserved` (gathering OR active) or `job` staffer now simply SKIPS lunch —
  the accepted skip-under-capture outcome. §3.4.
- **[MECH-MAJOR / DESIGN-MAJOR] the solo-role contradiction.** v1 §3.3 ("a solo
  role never lunches") contradicted v1 §4 ("a solo receptionist has a check-in
  gap") and test 9.8. Resolved: the cap applies to ALL roles; **solo-of-a-role
  never lunches**; the phantom receptionist-gap example is deleted; the
  **lounge-inert-below-2-per-role** consequence is now stated (§3.3, §6). Owner
  decision, one-line revert (§0.5).
- **[MECH-MAJOR] the `onBreak` pool clause is load-bearing, not redundant.** v1
  §4 claimed an offFloor-lunch staffer is "already excluded by the Stage-1 gate."
  FALSE — the pools gate on `onShift`, never `onFloor` (`dispatcher.ts:126,
  182-184, 242`). A mid-shift lunch breaks off-floor⟺off-shift, so `onBreak ===
  null` is the SOLE exclusion in all three pools. §4 rewritten + a proxy re-audit.
- **[MECH-MAJOR / DESIGN-MINOR] wrong reuse target.** `freeSlotIndex`
  (`world.ts:482`) is reservation-derived — useless for a self-service lounge.
  The precedent is `freeStallIndex`/`stallClaims` (`world.ts:1561-1579`,
  patient-`needBreak`-derived). Spec a NEW `loungeSeatClaims`/`freeLoungeSeatIndex`
  over `staff.onBreak`, plus NEW staff-`onBreak` clauses in `validateRoomExpand`
  /`validateRoomSell`/the load border. `slotAnchorTile` IS reusable. §2.
- **[DESIGN-MAJOR] the double-lunch bug.** Reusing `respawn` to end an offFloor
  lunch resets `lunchedThisShift` → repeat lunches. A relief-free `placeAtEntrance`
  helper (no reset) ends the lunch; `respawn` keeps the shift-start reset. §3.5.
- **[DESIGN-MAJOR] night stagger overflows midnight.** `lunchStartMinute` must be
  `mod GAME_MINUTES_PER_DAY` with a wrap-aware windowed eligibility check (the
  `onShift` idiom), or night staff never lunch. §3.2.
- **[DESIGN-MAJOR] the lounge payoff is placement-contingent.** The 30-vs-45-min
  duration lever is erased by walk distance (LAYOUT trap). The probe measures
  **walk-inclusive** coverage delta at realistic placement on both arms; the lever
  width is decided FROM the probe, not asserted. §6.
- **[DESIGN-MAJOR] the probe led on deaths** (unfalsifiable at 5 seeds — the thrice-
  burned metric). Deciding metric → discharges/throughput + walkouts on a **busy
  24/7** binding arm; measure the death spread first; **pre-register a lounge
  payback bound**. §6.
- **[DESIGN-MAJOR] skip-under-capture inverts the cost** (coverage cost vanishes
  when busy). Kept (both lenses agree it's right for Stage 2), but the consequence
  is stated, the probe sweeps LOAD, and §7 records the Stage-3 debt.
- **[MINORs folded]** `loungeSeat` non-walkable (slotAnchorTile precedent, §2);
  "zero rng" refined — stagger is rng-free, the seat-anchor fallback shares the
  seeded `world.rng` exactly as the restroom does (§3.2); explicit id-order
  resolution for the cap + walkers-count-as-on-break (§3.3); `lunchedThisShift`
  set at CLAIM, cleared on abort with a retry hold (reconciles both lenses, §3.5);
  save shape — append after `onFloor`, `writeStaffBreak`/`readStaffBreak` mirroring
  `writeNeedBreak`/`readNeedBreak`, regenerate the byte-identity fixture for v14
  (§8); the committed legibility signal (§3.7); the rolePool regression (§9).
- **[NITs]** utilities are a rounding error — payback is capital-only (§6); document
  the `lunchedThisShift`-reset-couples-to-respawn-cycle dependency (§3.6).

---

## 0. Owner decisions — RATIFIED 2026-07-20

1. **Trigger = a SCHEDULED mid-shift lunch** (not a fatigue/hunger meter). One
   ~30-min lunch per staffer per shift.
2. **An on-lunch staffer LEAVES the dispatchable pool** — this coverage cost IS
   the mechanic.
3. **The lounge CUTS the break's coverage cost.** Lunch is mandatory; WITH a
   lounge it is short + on-site; WITHOUT one the staffer leaves the building to
   eat (off-floor, longer).
4. **Breaks must be STAGGERED — never all at once** (owner: "a hospital open all
   the time cannot have all staff on break together; it must be random"). A
   per-staffer stagger + a per-role coverage cap, realised deterministically
   (hard rule 2 — an id-derived pure function, rng-free stagger).
5. **The coverage cap applies to ALL roles; a solo-of-a-role skips lunch**
   (folded from the review). Consequence: the lounge is **inert until you have
   ≥2 of a role on a shift** — a mid-game operations purchase, not early. Chosen,
   not stumbled into. *One-line revert:* switch the cap from a per-role floor to
   a per-role concurrency cap (≤K on break at once) to let solo staff lunch at
   the cost of real coverage gaps.

---

## 1. The model in five sentences

1. Each real-hired staffer (shift ≠ null) gets ONE lunch per shift, at a personal
   time staggered across a mid-shift window so co-workers don't overlap.
2. When her lunch time arrives — she holds no live work (`duty ∈ {idle, post}`)
   and a per-role coverage cap still permits it — she goes on break: to a **lounge
   seat** if a lounge exists (short, on-site), else **off the floor** to eat
   (longer, a bigger coverage hole).
3. While on break she is **out of the dispatch pool** (`onBreak === null` clause);
   lounge-mode she occupies a real seat, offFloor-mode she is off-map.
4. The lounge is an unstaffed `comfort` room whose seat occupancy is **DERIVED**
   from `staff.onBreak` (the restroom `stallClaims` precedent), so release frees
   the seat by construction.
5. `updateShifts` remains the sole owner of shift-boundary walk-home; the new
   `updateStaffBreaks` owns the break, and the shift boundary **cancels an
   in-progress lunch** (a staffer going off shift stops eating and goes home).

## 2. The lounge room (data)

New `ROOM_DEFS.lounge` — mirrors `restroom` (unstaffed, walled, derived occupancy):

```ts
lounge: {
  label: 'Staff Lounge',
  kind: 'treatment',            // walled + door (staff go INSIDE, like restroom)
  category: 'comfort',          // appears in the Comfort dropdown automatically
  minCols: 3, minRows: 3,       // 9 tiles → derives exactly 3 seats at min
  cost: 3_000,                  // INITIAL — balance pass may move it
  floorColor: <art discretion>,
  staffedBy: [],                // unstaffed, self-service
  capacity: { kind: 'perProp', prop: 'loungeSeat', noun: 'Seats' },
  props: [{ id: 'loungeSeat', walkable: false,   // non-walkable: slotAnchorTile precedent
            density: { kind: 'perTiles', tilesPerProp: 3, min: 3 } }],
  // NO `failure` entry — a lounge has no equipment to break (Stage 2 scope).
}
```

New `PropId` `'loungeSeat'` (a couch/armchair), **non-walkable** like `toiletStall`
— so `slotAnchorTile` (which stands the occupant on a walkable tile *beside* the
strip) applies unchanged. Joins `PROP_STYLE` (`tiles = 1 ≤ 2`).

- **Occupancy is DERIVED**, never stored: a seat is taken iff some live staffer's
  `onBreak` references `{roomId, slot}`. This needs a **NEW** `loungeSeatClaims(roomId):
  Map<slot, staffId>` and `freeLoungeSeatIndex(room)` over `world.staff` — mirroring
  `stallClaims`/`freeStallIndex` (`world.ts:1561-1579`), NOT `freeSlotIndex`
  (reservation-derived, always empty here). `slotAnchorTile` (`world.ts:499-522`)
  is reused as-is for the walk goal.
- **Live claims gate geometry** — a **NEW** staff-`onBreak` clause in
  `validateRoomExpand` (`build.ts:258-260`) and `validateRoomSell`
  (`build.ts:412-414`), rejecting "Occupied" while ANY live `onBreak.roomId ===
  roomId` (walking claimants included; `"Someone is inside"` at `:419-427` only
  catches an arrived on-floor staffer). Seat slots renumber on expand, exactly the
  restroom reason.
- **Inspect occupancy** counts `onBreak` claims, never `reservationsOn`.
- The lounge earns nothing (`roomEarns` derives from `CONDITION_DEFS` → false; no
  money shown anywhere) and draws only the HVAC base — the per-EQUIPMENT-room
  net-positive invariant does not apply; no new tally key, `TALLY_KEY_VERSIONS`
  untouched.

## 3. The staff break sub-state (mechanics)

### 3.1 State

`Staff` gains (mirroring patient `NeedBreak`):

```ts
onBreak: StaffBreak | null;      // in-flight lunch; null = none. SAVED.
lunchedThisShift: boolean;       // once-per-shift guard; reset at shift start. SAVED.

type StaffBreak = {
  mode: 'lounge' | 'offFloor';
  roomId?: number;               // lounge mode: the lounge
  slot?: number;                 // lounge mode: the claimed seat index
  phase: 'walking' | 'using';    // offFloor 'using' == off-map (onFloor already false)
  ticksRemaining: number;        // set when `using` begins
  startedAt: number;             // watchdog
};
```

`onBreak`/`lunchedThisShift` are **SAVED, not derived** — the `Staff.onFloor` M1
determinism precedent (a staffer mid-walk-to-lunch would re-derive wrong). Defaults
(`null`/`false`) keep v<14 and null-shift test rosters inert.

### 3.2 The lunch window and personal stagger (deterministic "random")

`BALANCE.shifts` gains a `lunch` block (INITIAL values; the probe tunes them):

```ts
lunch: {
  windowStartMinuteFromShiftStart: 240,  // eligible from +4h into the shift…
  windowSpanMinutes: 300,                //   …across a 5h window (staggered within)
  loungeBreakGameMinutes: 30,            // the owner's "30 minutes" — on-site
  offFloorBreakGameMinutes: 45,          // no lounge: leave to eat, longer (INITIAL — probe may widen)
  minSameRoleOnFloor: 1,                 // coverage cap: never break the last one
  breakWatchdogGameMinutes: 120,         // walk-never-arrives abort (restroom precedent)
  breakRetryGameMinutes: 15,             // failed/capped/aborted hold (dispatchHold analogue)
}
```

**Personal lunch minute** — a pure function in `formulas.ts`, rng-free, no saved
offset (the render-variety-hash idiom in-sim; deterministic ⇒ legal under hard
rule 2), **wrapped mod the day**:

```ts
lunchStartMinute(staff) =
  (shiftStartMinute(staff.shift)
   + lunch.windowStartMinuteFromShiftStart
   + hash(staff.id) % lunch.windowSpanMinutes) % GAME_MINUTES_PER_DAY
```

**Eligibility this tick** iff: `shift !== null`, `onShift`, `onFloor`,
`onBreak === null`, `!lunchedThisShift`, `duty.kind ∈ {idle, post}` (§3.4),
the cap permits (§3.3), AND `minuteOfDay` is inside her
window `[lunchStartMinute, lunchStartMinute + remainingSpan)` computed with **the
same wrap arithmetic as `onShift`** (a night window straddles midnight). A staffer
who could not go by window-end skips this shift's lunch (Stage-3 hook, §7).

*Determinism note:* the stagger is rng-free; the seat-anchor fallback
(`slotAnchorTile → freeInteriorTile → rng.intBelow`) shares the seeded `world.rng`
exactly as the restroom does — so enabling lunches perturbs the shared stream in
SHIFTED worlds only (null-shift fixtures stay bit-identical: lunch never fires).

### 3.3 The coverage cap — the "never all at once" guarantee

> A lunch-eligible staffer may START her break only if, AFTER she leaves, at least
> `minSameRoleOnFloor` same-role workers remain **on-shift, on-floor, and not on
> break (walking-to-lunch counts as on break)**. Otherwise she waits (retry hold)
> and retries later in her window.

Made hard by three specifics:
- **Walkers count.** A staffer who has committed and is `walking` to lunch is
  already "on break" for the floor math — else two eligible staff in one tick each
  see the other still counted and both leave.
- **Sequential, id-ordered resolution.** `updateStaffBreaks` scans candidates in
  explicit **ascending staff-id order** (the `reservationsOfStaff` sort precedent,
  `world.ts:453-457`) and mutates `onBreak` in place, so a later candidate in the
  same tick sees an earlier committer as on-break. Never trust `world.staff` Map
  order.
- **Derived live**, never tracked (the `staffLoadIn` precedent) — cannot desync.

Consequences (chosen, §0.5): a solo-of-a-role never lunches (realistic solo
coverage; the incentive to hire slack); **the lounge is inert below 2-per-role**
— so it must NOT be surfaced as an early-game need/hint, and the probe measures on
a roster with ≥2-per-role or nothing fires.

### 3.4 "Holds no live work" — the anti-capture boundary

Lunch-start requires `duty.kind ∈ {idle, post}` — i.e. **holds no reservation and
no job**. This is stricter than `updateShifts`' active-only `busy` test on purpose:
the lunch path has no gather-cancel, so a `reserved` staffer (gathering OR active)
must be ineligible, or she walks off mid-gather and strands the patient. A posted
staffer un-posts as part of going to lunch (§4). A `reserved`/`job` staffer simply
skips lunch this window.

**Skip-under-capture — the load inversion (stated, chosen).** Because she only
leaves when free, coverage cost is paid when the hospital is *idle enough* for staff
to be free and **vanishes exactly when the hospital is slammed** (a captured ratio
nurse never returns to `idle`, so she never lunches). This is the honest Stage-2
posture — but it means the probe must sweep LOAD (§6), and it defers "captured staff
never lunch" to Stage 3 as a known debt (§7): a Stage-3 fatigue meter reading
`lunchedThisShift === false` gives the busiest nurse unbounded fatigue unless Stage 3
adds the pre-emption Stage 2 declined.

### 3.5 Going on break, advancing, releasing (the `needBreak` transplant)

New system **`updateStaffBreaks(world)`**, inserted in `tick()` **between
`updatePatientNeeds` (`world.ts:2229`) and `updateShifts` (`:2230`)** — breaks
settle → the boundary reconciles → the dispatcher sees the settled pool.

**Trigger** (eligible staffer, §3.2–3.4):
- **Lounge exists** (`roomsOfType('lounge')` with a door + a `freeLoungeSeatIndex`
  reachable by `findPath`): claim the nearest reachable free seat (goal computed
  ONCE at claim, `tryClaimRestroom` precedent), `onBreak = {mode:'lounge', roomId,
  slot, phase:'walking', …}`, `setWalkerTarget` to `slotAnchorTile`. If posted,
  un-post first.
- **No lounge (or none reachable/free)**: `onBreak = {mode:'offFloor',
  phase:'walking', …}`, `setWalkerTarget(entrance)`; if posted, un-post.
- Set `lunchedThisShift = true` **at claim** (so she isn't re-selected next tick).
  It is LEFT `true` on an abort below — an aborted lunch consumes that shift's
  attempt. This is deliberate (SHIPPED decision, revised from the v2 draft): the
  only abort path is a lounge walk whose route breaks mid-flight (offFloor falls
  back to the always-reachable entrance and never aborts), which is rare, and
  leaving the guard set needs no retry-hold field and cannot thrash. Stage-3
  caveat: an aborted lunch reads as "lunched" to the §7 fatigue signal — Stage 3
  may distinguish "attempted" from "ate" if it matters.
- Emit `staffUpdated`; emit the legibility signal (§3.7).

**Advance** (mirror `advanceBreak`):
- `walking` + watchdog exceeded, OR arrived anywhere that is NOT the target (a dead
  path reads as "arrived") → abort: clear `onBreak`, return to `idle`; restore
  floor state. `lunchedThisShift` stays true (the attempt is consumed, above).
- `walking` + arrived AT target (lounge: inside the room; offFloor: at entrance) →
  flip `using`; set `ticksRemaining` from the mode's duration; offFloor sets
  `onFloor=false` (now off-map, excluded everywhere §5).
- `using` counts down; at 0 → **end of lunch**: clear `onBreak`; lounge mode →
  already on-floor, `duty=idle` (dispatcher re-picks her); offFloor mode →
  `placeAtEntrance(world, member)` (below), `onFloor=true`, `duty=idle`.

**`placeAtEntrance` (NEW shared helper).** The position/`onFloor=true`/`duty=idle`
work of `respawn`, **without** the shift-start `lunchedThisShift` reset AND without
the shift-changeover relief walk (`respawn`'s relief target is meaningless — and
during the 30-min overlap actively wrong — for a lunch return). `respawn` (shift
start) keeps the reset + relief; lunch-end uses `placeAtEntrance`.

**Release is automatic** because the seat claim is derived: firing a staffer or the
shift boundary clears `onBreak` and the seat frees.

### 3.6 Interaction with the shift boundary (`updateShifts`)

`updateShifts` runs immediately AFTER `updateStaffBreaks`:
- **Boundary cancels lunch:** an off-shift staffer with `onBreak !== null` has her
  lunch cleared (seat freed), then the normal walk-home path takes over — she goes
  HOME, not back to the floor. An offFloor-`using` staffer (already `onFloor=false`)
  crossing her boundary just stays home.
- **Respawn gate:** `updateShifts`' on-shift `if (!member.onFloor) respawn`
  (`shifts.ts:29`) MUST guard on `onBreak === null`, or it snaps an offFloor-`using`
  staffer (on-shift, off-floor) straight back to the floor, deleting the coverage
  cost. This is the one Stage-1 edit; test 9.7 pins it non-vacuous.
- **`lunchedThisShift` reset lives in `respawn`** (shift start) — one line.
  *Dependency (NIT):* this is correct only because every shifted staffer reliably
  cycles off-floor once per game-day (walk-home → respawn). If a future stage keeps
  a shifted staffer on-floor across her own boundary, the reset stops firing — move
  it to an explicit shift-start edge then. Tick-0 on-floor staff init
  `lunchedThisShift=false` at creation.

### 3.7 Legibility (render-only)

Matters most in the no-lounge default (a staffer vanishing to the south entrance for
45 game-min reads as quitting). SHIPPED: the inspect card's **Shift line** reads
"out for lunch — back ~HH:MM" / "in the staff lounge — back ~HH:MM" (the ETA once
she's settled), the **Duty line** reads "On lunch", and the lounge's occupancy line
counts live `onBreak` claims and names the occupants (§2). A **thought bubble** on
lunch start was DEFERRED: there is no staff-thought infrastructure today (the bubble
system is `patientThought`-only), so a "Taking my lunch…" bubble is a separate small
render feature; the inspect line carries the signal for Stage 2.

## 4. Dispatch & pool exclusion

The three pools gate on `onShift`, **never** `onFloor` — so `&& member.onBreak ===
null` is **load-bearing in ALL THREE**, not belt-and-braces (an offFloor-`using`
staffer is `onFloor=false` but `onShift=true`, and a lounge-mode staffer is
on-floor): `idleStaff` (`dispatcher.ts:126`), `availableStaff` (`:182-184`),
`rolePool` (`:242`). The `rolePool` clause is critical: a lunching nurse counted in
`rolePool` would misfire the ED anti-capture guard (the Stage-1 off-shift fix,
`dispatcher.ts:242`) — regression 9.13.

**Posted staff:** a posted staffer whose lunch triggers un-posts first (mirror the
off-shift un-post), so check-in isn't believed staffed while she walks away; she
re-posts via `postStandingStaff` on lunch end. With two receptionists (one posted,
one idle) `postStandingStaff` re-posts the spare seamlessly — no gap; with one, the
cap blocks her lunch entirely (§0.5), so the desk is never abandoned.

**Proxy re-audit (off-floor⟺off-shift no longer holds).** Re-check every site that
used `onShift`/`onFloor` as an availability proxy: the coverage signal
(`needs.ts:313-317`, keys on `onFloor && onShift` — a lounge-mode on-break staffer
is over-counted as "covering," benign; a solo can't lunch anyway), `staffNearby`
(`wayfinding.ts:52-56`, keys on `onFloor` — an offFloor luncher correctly excluded;
a lounge-mode one correctly present), `atriumStaffed` (`world.ts:553-565`). Fix any
that must exclude on-break staff; document the rest as verified.

## 5. Off-floor / on-break exclusion (every all-staff iteration)

The Stage-1 off-floor list (`isTileClaimed`, renderer sprite loop + `pickAt`,
`build.ts`/expand/sell occupancy, `staffNearby`) already covers offFloor-mode
(`onFloor=false`). **Lounge-mode staff stay on-floor** and are correctly NOT
excluded there — they occupy a real seat anchor tile, are clickable ("On lunch"),
and veto a build over the lounge. The ONLY new exclusion is the **dispatch pool**
(§4). Any future all-staff placement loop inherits the Stage-1 rule.

## 6. Balance — MEASURE it (a probe, not an assertion)

`test/staffBreakProbe.test.ts` (gated `STAFF_BREAK_PROBE=1`, the `shiftProbe`
precedent). **Roster ≥2-per-role** on the binding arm (else the cap fires nothing).

- **The binding arm is BUSY + 24/7-staffed** (both shifts), so day lunches land in
  the 10:00–15:00 arrival peak — the load where coverage cost actually bites. Report
  the **deciding metric = discharges/throughput + walkouts**, NOT deaths (the thrice-
  burned, 5-seed-unfalsifiable metric); measure the **death spread first** and only
  use deaths if the spread supports a threshold.
- **Sweep LOAD** (a quiet arm and a busy arm) so the skip-under-capture inversion
  (§3.4) is measured, not assumed — report coverage cost as a function of load.
- **Three coverage arms:** breaks OFF (Stage-1 baseline) · breaks ON, **no lounge**
  (offFloor) · breaks ON, **with a lounge placed at a realistic, non-optimal
  distance** (the LAYOUT §1.1 near/far discipline). The lounge's value = recovered
  throughput between the last two, measured **walk-inclusive** (walk round-trip +
  duration, not just 30-vs-45). Decide whether the duration lever needs widening
  FROM this, not by assertion.
- **The stagger holds:** max concurrent same-role on-break stays ≤ `headcount −
  minSameRoleOnFloor` over a multi-day run, and a burst-aligned tick never breaks
  the floor (regression 9.1).
- **Both layout arms** (`LAYOUT_PLAN` §3.4).
- **Pre-registered lounge pass/fail** (the SHIFTS §7a discipline): e.g. "the lounge
  recovers ≥ N discharges/day on the busy arm AND capital payback < D days on both
  layout arms, else it is repriced or its duration lever widened." Without a stated
  bound §6 is toothless. Utilities are ~$11/game-day (9 tiles × HVAC base) — payback
  is effectively capital-only ($3,000); don't overweight them.

No Stage-2 balance number ships until the probe runs both arms with a bound met.

## 7. Stage-3 hooks left inert (do not build now)

- **Skipped-lunch fatigue debt**: `lunchedThisShift` staying `false` past a staffer's
  window is the signal Stage-3 fatigue/morale reads. Inert now (no quality effect).
  **Known debt:** skip-under-capture (§3.4) means the busiest staff never lunch, so
  Stage-3 fatigue is unbounded for them unless Stage 3 adds pre-emption or a captured-
  staff carve-out. Chosen here.
- **Lounge quality → break quality**: available (room-quality precedent), unused now.
- **Night differential / agency**: untouched.

## 8. Save & compat (SAVE_VERSION 14)

New surface: `lounge` room type + `loungeSeat` prop (grid RLE via `PROP_STYLE`/
`PROP_IDS`), `Staff.onBreak`, `Staff.lunchedThisShift`.
- **Migration v<14**: `onBreak` null, `lunchedThisShift` false — a loaded save plays
  identically until the next lunch window (bounded, intended).
- **`SavedStaff`** (`save.ts:257-275`) appends `onBreak`/`lunchedThisShift` **after
  `onFloor`** (byte-order-sensitive — the byte-identity invariant); `writeStaff`
  (`:869-870`) appends in the same order; a `writeStaffBreak`/`readStaffBreak` pair
  mirrors `writeNeedBreak`/`readNeedBreak` (`:703-735`, mode-strict, conditional
  `slot`/`roomId` spread). `readStaff` already threads `saveVersion` — read-time
  defaults (`< 14 ? null/false`) drop in.
- **Border validation** (`loadWorld`, mirror the needBreak border `save.ts:1524-1560`):
  `onBreak.roomId` (lounge mode) resolves to a `lounge` room, `slot` within its
  derived seat count; **seat-claim exclusivity** (no two staff on one `{roomId,
  slot}`); the phase-aware `onFloor` pin — lounge OR offFloor-`walking` ⇒
  `onFloor===true`, offFloor-`using` ⇒ `onFloor===false`.
- **Regenerate the byte-identity fixture for v14** (added fields change the payload
  string — the v13 fixture must NOT be treated as unchanged).
- **Round-trip gate**: the scenario PROVES a lounge `walking`, a lounge `using`, an
  offFloor `using` (off-map), and a `lunchedThisShift` staffer — asserted premises,
  never assumed (save-review MAJOR 2).
- **No new role, no new condition.** The new room type is itself the bump.

## 9. Tests / regressions the implementation must own

1. **Stagger + cap** — max concurrent same-role on-break ≤ headcount −
   `minSameRoleOnFloor`, over a multi-day multi-role run AND on a burst-aligned tick.
2. **Solo role skips lunch** — a 1-nurse shift never deadlocks waiting to lunch.
3. **Lounge claim/use/release** — walk to a seat, occupancy=1, release, seat frees.
4. **No-lounge offFloor lunch** — off-floor for the duration (excluded everywhere),
   then `placeAtEntrance` back on-floor.
5. **Anti-capture: gathering** — a staffer holding a GATHERING reservation does NOT
   start lunch (the strand fix); extend `edRatio.test.ts`.
6. **Anti-capture: active bay** — a ratio nurse mid-active-bay does NOT start lunch.
7. **Shift boundary cancels lunch** — an on-break staffer crossing her boundary goes
   HOME, not back to the floor; seat frees.
8. **Respawn gate** — a lunching offFloor staffer is NOT snapped back to the floor by
   `updateShifts` (revert the §3.6 guard → this fails).
9. **Posted-staff lunch** — with two receptionists, one lunches, the spare re-posts,
   no check-in gap; with one, she never lunches (cap). *(Replaces v1's phantom-gap
   test 9.8.)*
10. **No double-lunch** — a completed offFloor lunch does NOT re-arm
    `lunchedThisShift`; at most one lunch per shift.
11. **Aborted walk** — a watchdog/dead-path abort clears `lunchedThisShift` and holds
    (no silent lost lunch).
12. **`lunchedThisShift` resets at shift start**.
13. **rolePool** — a 2-nurse ED with one on lunch degrades gracefully (extend the
    working nurse), not starve triage (the Stage-1 off-shift regression, mirrored).
14. **Geometry gates** — expand/sell a lounge with a live claim → "Occupied".
15. **v13→v14 migration** (real downgrade helper) — defaults applied; the byte-identity
    fixture regenerated; round-trip.
16. **Determinism + night wrap** — save→load→run under an in-flight lunch reproduces
    the event log; a night staffer whose id-hash lands post-midnight actually lunches.

## 10. Files (anticipated)

`src/sim/data/rooms.ts` (lounge + `loungeSeat`) · `src/sim/data/balance.ts`
(`shifts.lunch`) · `src/sim/entities/staff.ts` (`onBreak`, `lunchedThisShift`,
`StaffBreak`) · `src/sim/systems/staffBreaks.ts` (NEW) · `src/sim/systems/shifts.ts`
(boundary-cancel, respawn-gate, `placeAtEntrance` helper) · `src/sim/world.ts` (tick
insert; `loungeSeatClaims`/`freeLoungeSeatIndex`; expand/sell "Occupied"; break
helpers) · `src/sim/systems/dispatcher.ts` (`onBreak` clause ×3) · `src/sim/formulas.ts`
(`lunchStartMinute`) · `src/sim/save.ts` (SAVE_VERSION 14, `SavedStaff`,
`writeStaffBreak`/`readStaffBreak`, border, round-trip, fixture regen) ·
`src/render/renderer.ts` (lounge draw; "On lunch" inspect state) · `src/ui/inspect.ts`
(on-break line + thought) · `test/` (the 16 regressions, the probe).

## 11. Open questions — RESOLVED in v2

All v1 open questions are folded into the text above: Q1 skip-under-capture (kept,
§3.4/§7) · Q2 `lunchedThisShift` at claim + clear-on-abort (§3.5) · Q3 mirror
`stallClaims`/`freeStallIndex`, seat-tile anchor via `slotAnchorTile` (§2) · Q4
`placeAtEntrance` helper, not `respawn` (§3.5) · Q5 night wrap mod 1440 + windowed
check (§3.2) · Q6 walkers count, sequential id-order (§3.3).
