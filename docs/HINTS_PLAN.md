# Hints milestone — look-ahead chain hints + persistent "what's blocked" panel

**Status: DRAFT v1 (2026-07-18). Owner-requested scope; pre-implementation
review pending.** Companion to `GAME_DESIGN.md` (Flow rule 5) and
`TECH_PLAN.md` (§3.1 SSOT). CLAUDE.md hard rules govern.

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
with rooms.

## 2. Design — one pure derivation, two consumers

### 2.1 `src/sim/needs.ts` — `computeBlockedNeeds(world): BlockedNeed[]`

A pure, renderer-free, side-effect-free derivation of the CURRENT unmet needs
from world state (same module style as `challenge.ts`; unit-testable; no rng,
no mutation, no DOM). This is the ONE place "what is blocked" is computed —
the toast hints and the panel both consume it (SSOT/DRY).

```ts
interface BlockedNeed {
  /** Stable dedupe/hint key: 'room:<RoomType>' | 'role:<RoleId>'. */
  key: string;
  kind: 'room' | 'role';
  room?: RoomType;          // kind 'room'
  role?: RoleId;            // kind 'role'
  /** Live patients affected (deduped). */
  patients: number;
  /** true = blocks someone's CURRENT progress; false = an upcoming step. */
  urgent: boolean;
  /** Display line, composed from ROOM_DEFS/ROLE_DEFS labels (§3.1). */
  label: string;
}
```

**Enumeration rules** (scanned over live, pre-terminal patients):

- **Check-in** (stages `atEntrance`/`queuedCheckIn`/`checkingIn`): no reception
  room built → `room:reception` (urgent). Reception exists but zero
  receptionists HIRED → `role:receptionist` (urgent). ("Hired", not
  "posted+arrived" — transient walking states must not flash the panel.)
- **Triage** (stage `waitingTriage`, plus check-in stages looking ahead): zero
  triage rooms → `room:triage`; zero nurses hired → `role:nurse`. Urgent when
  a patient is already `waitingTriage`, else upcoming.
- **Treatment chain look-ahead** (any pre-terminal patient with a condition,
  including pre-triage ones): for each step from the patient's `stepIndex` to
  the chain's end — a step room type with zero rooms built → `room:<type>`;
  a step role with zero hired staff → `role:<id>`. `urgent` if the blocking
  step is the patient's CURRENT step and they are `waiting`; upcoming
  otherwise. Lost patients count (their chain still needs the facility);
  dead/discharged/AMA don't (not in `world.patients`).
- Needs dedupe by `key` across patients; `patients` counts affected patients;
  `urgent` is OR-ed. Sort: urgent first, then by patient count desc, then key
  (deterministic order for tests and stable panel rows).

**Capacity/contention is OUT of scope** (e.g. "you need a second OR") — this
milestone surfaces *existence* gaps (zero rooms / zero staff of a needed
kind), which is what the owner hit. Contention hints are a future pass.

### 2.2 Consumer 1 — look-ahead toast hints (sim-side)

The dispatcher's four inline hint blocks (`room:triage`, `role:nurse`,
`cond:<condition>:room`, `cond:<condition>:<role>`) are REPLACED by one loop:
after `assignTreatment`, compute needs and `world.hintOnce('need:' + key,
label)` for each. One wording source, look-ahead included, check-in included.

- Same `hintOnce` mechanism (Flow rule 5 "once", saved keys) — toasts stay
  transient nudges; the panel is the persistent surface.
- Old `cond:*`/`room:triage`/`role:nurse` keys become inert; old saves simply
  see the new `need:*` keys once. Existing tests asserting the old hint
  messages/keys will be updated to the new single source.
- Determinism: needs derive purely from world state; emission order is the
  sorted needs order. No rng.
- Cost: ≤ ~110 patients × ≤3 remaining steps × small role lists, once per
  tick — trivial next to A*.

### 2.3 Consumer 2 — the persistent panel (UI-side)

`src/ui/blockedPanel.ts` — a small always-visible-while-nonempty panel
(pattern: `Checklist`), id `#blocked`, mounted top-left under the checklist.

- Reads `computeBlockedNeeds(world)` directly (UI reads World, never caches —
  architecture rule 4). Recomputed only when `world.clock.tick` changed since
  the last render callback (ties refresh to sim rate, not frame rate; paused
  game = frozen panel, correct).
- Renders: header "Needs attention", then one row per need — urgent rows
  normal, upcoming rows dimmed with a "soon:" prefix. Hidden entirely when
  the list is empty (like `#readout:empty`).
- No interactivity in v1 (no click-to-open-build-menu) — smallest useful
  surface; interactions are a future nicety.
- `data-ui` attribute; styles in `ui.css` reusing checklist visual language.

## 3. SSOT / DRY ledger

| Concern | Single source |
|---|---|
| What is blocked | `computeBlockedNeeds` (`src/sim/needs.ts`) |
| Need wording | `BlockedNeed.label`, composed from `ROOM_DEFS`/`ROLE_DEFS` labels |
| Toast dedupe | existing `world.hintOnce` (`need:<key>` namespace) |
| Chain data | existing `CONDITION_DEFS[*].steps` (no new tables) |
| Panel refresh | `world.clock.tick` change (no timers, no cached state) |

No new balance numbers. No World fields (nothing saved — plan rule 6 is not
triggered). No new events (the panel polls world state like the HUD; toasts
ride the existing `hint` event).

## 4. Files

- NEW `src/sim/needs.ts` — types + `computeBlockedNeeds`.
- NEW `src/ui/blockedPanel.ts` — the panel.
- NEW `test/needs.test.ts` — derivation unit tests.
- EDIT `src/sim/systems/dispatcher.ts` — replace inline hints with the needs
  loop.
- EDIT `src/main.ts` — mount the panel (all boot kinds incl. challenge — the
  panel is guidance, not a debug affordance).
- EDIT `src/ui/ui.css` — panel styles.
- EDIT existing tests that assert the old hint keys/messages.

## 5. Test list

- `computeBlockedNeeds`: empty world → `[]`; patient at entrance with no
  reception → urgent `room:reception`; reception built, nobody hired → urgent
  `role:receptionist`; patient `waitingTriage` with no triage/nurse → urgent
  both; **look-ahead: a gallstones patient at stepIndex 0 (ultrasound) with no
  surgery room and no surgeon → upcoming `room:surgery` + `role:surgeon`**
  (the owner's exact scenario — the regression test of record); the same
  patient `waiting` at stepIndex 1 → those needs turn urgent; needs dedupe +
  count across multiple patients; hiring/building clears the need; terminal
  patients contribute nothing; deterministic sort order.
- Hint emission: driving a world with a blocked chain emits `hint` once per
  `need:*` key, including a FUTURE-step need while the patient is still on an
  earlier step; no re-emission next tick.
- Panel (happy-dom): renders urgent + "soon:" rows from a fixture world;
  hides when empty; updates when a need clears.
- Full-suite pass (existing hint-message tests updated, not weakened).

## 6. Workflow

Plan (this doc) → pre-implementation adversarial review → fix plan → implement
→ adversarial code review → fix ALL + regression test per major → gates
(lint/test/tsc/build) → HANDOFF update → commit.
