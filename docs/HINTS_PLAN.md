# Hints milestone — look-ahead chain hints + persistent "what's blocked" panel

**Status: IMPLEMENTED & SHIPPED (2026-07-18).** Built per this plan (v2 —
pre-implementation review folded in: 3 major, 3 minor, 3 nit), then hardened by
a post-implementation adversarial review (3 minor fixed with regression tests —
vacuous firing-staff test, string-coercing sort assertion, panel staleness on
build-while-paused — + 2 nits: kind-typed `CHECK_IN_STAGES`, `article()` shared
with the checklist). Deltas from this plan: `BlockedNeed` labels gained an
a/an `article()` helper (exported; checklist reuses it) and a `triage` reason
marker so a condition union can't understate why a nurse is needed; the panel
also invalidates on `roomBuilt`/`roomSold`/`staffHired`/`staffFired` (commands
apply while paused — a tick-gate alone went stale). 246 tests green.

Companion to `GAME_DESIGN.md` (Flow rule 5) and `TECH_PLAN.md` (§3.1 SSOT).
CLAUDE.md hard rules govern. Original plan below.

## 1. Problem (owner report, 2026-07-17)

The Flow-rule-5 hints in `src/sim/systems/dispatcher.ts` have three gaps that
left the owner unable to get an Operating Room running:

1. **No look-ahead.** Hints fire only for a *waiting* patient's CURRENT step
   (`assignTriage` / `assignTreatment`). A gallstones patient still at
   ultrasound produces no "needs a Surgeon" hint until ultrasound completes —
   too late to prepare. (The owner hunted for a non-existent "anesthesia
   doctor" — surgery actually needs `surgeon`+`nurse`; the `anesthesiaCart` is
   a decorative prop. Prop relabel explicitly NOT chosen.)
2. **One-shot transient toasts.** `hintOnce` fires once per key, ever (and the
   key set is *saved*). Miss the toast and the guidance is gone.
3. **No check-in coverage.** A dead reception desk (no receptionist hired, or
   no reception at all while patients queue) stalls silently.

Owner ruling: build **(1) look-ahead chain hints** and **(2) a persistent
"what's blocked" panel**. Equipment needs no separate tracking — props come
with rooms (`ROOM_DEFS[*].props` auto-place on build).

## 2. Design — one pure derivation, two consumers

### 2.1 `src/sim/needs.ts` — `computeBlockedNeeds(world): BlockedNeed[]`

A pure, renderer-free, side-effect-free derivation of the CURRENT unmet needs
from world state (same module style as `challenge.ts`; unit-testable; no rng,
no mutation, no DOM). This is the ONE place "what is blocked" is computed —
the toast hints and the panel both consume it (SSOT/DRY).

**Load-bearing invariant (save-gate safety):** the needs pipeline mutates
NOTHING except via the existing `world.hintOnce`, and `computeBlockedNeeds` is
never called during `loadWorld`. Hints have zero sim feedback (`hintedOnce` is
write-only to the sim), so the world trajectory — and therefore the save
round-trip gate (`test/save.test.ts`) — is untouched by construction, not by
luck. Do not add any other mutation to this path.

```ts
interface BlockedNeed {
  /** Stable dedupe/hint key: 'room:<RoomType>' | 'role:<RoleId>'. */
  key: string;
  kind: 'room' | 'role';
  room?: RoomType;          // kind 'room'
  role?: RoleId;            // kind 'role'
  /** Live patients affected (deduped). */
  patients: number;
  /** Deduped condition labels driving this need ('' entries never appear);
   *  empty for the check-in needs (they're not condition-specific). */
  conditions: string[];
  /** true = blocks someone's CURRENT progress; false = an upcoming step. */
  urgent: boolean;
  /** Display line — the ONE wording for panel rows AND toasts (§2.2/§2.3). */
  label: string;
}
```

**Label wording** (composed from `ROOM_DEFS`/`ROLE_DEFS`/`CONDITION_DEFS`
labels — §3.1; the per-condition "why" is the causal link the owner was
missing, review MAJOR 2):

- room need: `Build a[n] <Room.label>` + (when conditions nonempty)
  ` — needed for <Cond1>, <Cond2>` (deduped, table order).
- role need: `Hire a <Role.label>` + same suffix.
- check-in needs are the same shape with no suffix: `Build a Reception` /
  `Hire a Receptionist` — plus the fixed suffix ` — patients can't check in`.

**Enumeration rules.** Scanned over **pre-terminal** patients only — every
patient whose `stage.kind` is NOT `leaving` or `dead`. (Both DO remain in
`world.patients` until exit/fade — review MAJOR 1 — so the filter is explicit;
a corpse must not keep "Build an Operating Room" alive.) Every patient carries
`condition` + `stepIndex` from spawn (pre-triage included). Lost patients
count (their chain still needs the facility).

- **Check-in** (stages `atEntrance`/`queuedCheckIn`/`checkingIn`): no
  reception room built → `room:reception` (urgent). Reception exists but zero
  receptionists hired → `role:receptionist` (urgent). "Hired" counts `firing`
  members (they still work while walking out — no panel flash; review NIT) and
  means role presence, NOT posted+arrived (transient walking states must not
  flash the panel).
- **Triage**: patients in the check-in stages or `waitingTriage` need triage
  next: zero triage rooms → `room:triage`; zero nurses hired → `role:nurse`.
  Urgent when some such patient is already `waitingTriage`, else upcoming.
- **Treatment chain look-ahead**: for each pre-terminal patient, scan steps
  from their `stepIndex` to the chain's end — a step room type with zero rooms
  built → `room:<type>`; a step role with zero hired staff → `role:<id>`.
  `urgent` if the blocking step is the patient's CURRENT step and their stage
  is `waiting`; upcoming otherwise (incl. `reserved` patients' remaining
  steps — a mid-ultrasound patient still surfaces `room:surgery` upcoming).
- Needs dedupe by `key` across patients; `patients` counts affected patients;
  `urgent` is OR-ed; `conditions` unions (deduped, `CONDITION_IDS` table
  order). Sort: urgent first, then patients desc, then key ascending — total
  (key is unique), so the order is deterministic for tests and panel rows.
- Perf: precompute room-type counts and the hired-role `Set` ONCE per call
  (O(P+S), not O(P×S)); chains are ≤2 steps today (claim conservative). The
  function runs at most ~2×/tick (dispatcher + panel).

**Capacity/contention is OUT of scope** (e.g. "you need a second OR") — this
milestone surfaces *existence* gaps (zero rooms / zero staff of a needed
kind), which is what the owner hit. Contention hints are a future pass.

### 2.2 Consumer 1 — toast hints (sim-side, URGENT needs only)

The dispatcher's four inline hint blocks (`room:triage`, `role:nurse`,
`cond:<condition>:room`, `cond:<condition>:<role>`) are REPLACED by one loop
at the END of `updateDispatcher` (after `promoteGatheredReservations` — call
site pinned, review NIT): compute needs once and, **for each URGENT need**,
`world.hintOnce('need:' + key, label)`.

- **Toasts are urgent-only (review MINOR 5 ruling):** a toast is an
  interruption — it fires when something blocks progress NOW. Upcoming needs
  live in the persistent panel (that IS the look-ahead surface the owner
  asked for). This also reproduces the old toast timing on day 1 — triage
  toasts at `waitingTriage`, step toasts at `waiting` — so there is no
  first-spawn burst duplicating the checklist, with no sim→UI coupling.
- Same `hintOnce` mechanism (Flow rule 5 "once", saved keys). Old
  `cond:*`/`room:triage`/`role:nurse` keys become inert; a legacy save sees
  the `need:*` keys once. One wording source: the need's `label`.
- Determinism: needs derive purely from world state; emission follows the
  sorted order. No rng.

**Existing hint-COUNT tests (review MAJOR 3 — no test pins keys/messages;
these four pin counts) and why each stays green:**

| Test | Asserts | Stays green because |
|---|---|---|
| `reviewGate.test.ts` ~L100 | 0 hints during unreachable-room churn | fixture builds exam+doctor; flu chain fully satisfiable → no needs |
| `reviewGate.test.ts` ~L121/132 | exactly 1 hint (noPath) | same — the only hint is the rule-8 noPath hint, not a need |
| `m3Roster.test.ts` ~L203 | 0 hints (fire mid-gather) | fixture has the room + both roles hired (firing counts as hired) |
| `m3Wayfinding.test.ts` ~L264 | 0 hints (lost-timeout) | fixture chain satisfiable; lost patient's needs all met |

If a fixture drifts (e.g. stops building the room), these now fail loudly —
that is deliberate; update the FIXTURE, not the assertion.

### 2.3 Consumer 2 — the persistent panel (UI-side)

`src/ui/blockedPanel.ts` — a small panel visible whenever needs exist
(pattern: `Checklist`), id `#blocked`.

- **Stacking (review MINOR 4):** `main.ts` mounts a `#leftstack` fixed
  flex-column container at the checklist's current spot (top 48px / left
  12px); `Checklist` and `BlockedPanel` both mount INTO it (checklist first).
  `#checklist` loses its own `position: fixed` (container owns placement) —
  no overlap, and the panel slides up when the checklist dismisses.
  (`#inspect` owns bottom-left, `#toasts` top-right — untouched.)
- Reads `computeBlockedNeeds(world)` directly (UI reads World, never caches
  authoritative state). Recomputed only when `world.clock.tick` changed since
  the last render callback (≤10×/s; paused game = frozen panel, correct).
  **DOM is rebuilt only when the needs actually changed** (compare a
  serialized key of the computed list — labels+urgency; review MINOR 6).
- Renders: header "Needs attention", then one row per need — urgent rows
  normal, upcoming rows dimmed with a "soon:" prefix. Hidden entirely when
  the list is empty. Rows use each need's `label` (SSOT with toasts).
- No interactivity in v1 (no click-to-open-build-menu) — future nicety.
- `data-ui` attribute; styles in `ui.css` reusing checklist visual language.
- Mounted on every boot kind incl. challenge (guidance, not a debug
  affordance; it reads only deterministic world state).

## 3. SSOT / DRY ledger

| Concern | Single source |
|---|---|
| What is blocked + wording | `computeBlockedNeeds` / `BlockedNeed.label` (`src/sim/needs.ts`) |
| Toast dedupe | existing `world.hintOnce` (`need:<key>` namespace) |
| Chain data | existing `CONDITION_DEFS[*].steps` (no new tables) |
| Panel refresh | `world.clock.tick` change + needs-key diff (no timers, no cached authority) |
| Left-column placement | `#leftstack` container (checklist + blocked panel) |

No new balance numbers. No World fields (nothing saved — plan rule 6 not
triggered). No new events (the panel polls world state like the HUD; toasts
ride the existing `hint` event).

## 4. Files

- NEW `src/sim/needs.ts` — types + `computeBlockedNeeds`.
- NEW `src/ui/blockedPanel.ts` — the panel.
- NEW `test/needs.test.ts` — derivation unit tests.
- EDIT `src/sim/systems/dispatcher.ts` — remove the four inline hint blocks;
  add the urgent-needs hint loop at the end of `updateDispatcher`.
- EDIT `src/main.ts` — mount `#leftstack` + panel (all boot kinds).
- EDIT `src/ui/checklist.ts` — mount into the container (no self-positioning).
- EDIT `src/ui/ui.css` — `#leftstack` + panel styles; `#checklist` position
  moves to the container.
- Re-verify (not edit) the four hint-count tests named in §2.2.

## 5. Test list

- `computeBlockedNeeds`: empty world → `[]`; patient at entrance with no
  reception → urgent `room:reception`; reception built, nobody hired → urgent
  `role:receptionist`; **receptionist hired but still WALKING to the desk →
  no receptionist need (anti-flash)**; patient `waitingTriage` with no
  triage/nurse → urgent both; **look-ahead: a gallstones patient at stepIndex
  0 (ultrasound) with no surgery room and no surgeon → upcoming
  `room:surgery` + `role:surgeon`, with `conditions` naming Gallstones** (the
  owner's exact scenario — the regression test of record); the same patient
  `waiting` at stepIndex 1 → those needs turn urgent; **a `reserved`
  (mid-treatment) patient still surfaces their REMAINING steps as upcoming**;
  **a `leaving` and a `dead` patient (still in `world.patients`) contribute
  nothing**; lost patients DO count; needs dedupe + `patients` count +
  `conditions` union across multiple patients; hiring/building clears the
  need; firing staff still count as hired; deterministic sort order.
- Hint emission: driving a blocked world emits `hint` once per urgent
  `need:*` key; **upcoming needs emit NO toast** (panel-only — the ruling);
  no re-emission next tick.
- **Legacy saves:** a save whose `hintedOnce` holds old `cond:*` keys still
  fires the `need:*` hints exactly once, and never again after a second
  save/load round-trip.
- Panel (happy-dom): renders urgent + "soon:" rows from a fixture world;
  hides when empty; updates when a need clears; DOM untouched across ticks
  when needs are unchanged.
- Full-suite pass — the four §2.2 count tests re-verified green unmodified;
  the save round-trip gate untouched (invariant in §2.1).

## 6. Workflow

Plan v2 (this doc) → implement → adversarial code review → fix ALL + a
regression test per major → gates (lint/test/tsc/build) → HANDOFF update →
commit.
