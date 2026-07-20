# Maintenance-Dispatch Narration (CONTRACT)

**Status:** DRAFT (2026-07-20) — awaiting the two split-lens pre-impl reviews.
Owner ask (2026-07-19, HANDOFF backlog): *"turn a breakdown's follow-up into
'{staff} en route to {room}', and the valuable UNSTAFFED case 'CT broken — no
maintenance staff available' which drives a HIRE."*

**Save impact:** **NONE.** No new state, no `SAVE_VERSION` bump, no new events, no
determinism change. This is a **render/legibility-only** feature — a pure consumer
of state the sim already produces (`world.jobs`, `world.staff`, `room.brokenSince`).

## 1. What exists today (the feature is a consumer)

- A breakdown mints exactly ONE `repair` job (`broken ⇔ one repair job`, the v6
  border invariant) with `roomId`, `staffId` (null until assigned), and `phase`
  (`queued` → `assigned` → `working`); the dispatcher assigns a NAMED idle
  maintenance tech (`jobChanged` fires on every transition).
- `computeBlockedNeeds` (`src/sim/needs.ts`) already emits a
  `broken:<roomId>:<brokenSince>` row (label "{Room} is broken — needs repair")
  and, when no tech is hired, a `role:maintenance` "Hire a Maintenance Tech" row.
- `BlockedPanel` (`src/ui/blockedPanel.ts`) renders those labels IN PLACE and
  already recomputes on `jobChanged` / `roomBroken` / `roomChanged` (its
  invalidation list). Labels are the single wording source for the panel AND the
  one-shot toast (`emitUrgentNeedHints`).

So the ONLY change is to make the `broken:<roomId>` row's **`label`** reflect the
repair job's live state. The in-place update + clear-on-fix already work.

## 2. The design — enrich the broken-row label from the repair job

In `computeBlockedNeeds`, for each broken (non-retired) room, look up its repair
job (`world.jobs`, `kind==='repair' && roomId===room.id`) and its tech
(`world.staff.get(job.staffId).name.short`), and pick the label:

| Repair job state | Label |
|---|---|
| `working` (tech at the room) | `{Room} broken — {tech} is repairing it` |
| `assigned` (tech walking) | `{Room} broken — {tech} en route` |
| `queued`, ≥1 maintenance tech HIRED (all busy) | `{Room} broken — waiting for a maintenance tech` |
| `queued`, NO maintenance hired | `{Room} broken — no maintenance staff available` |
| (defensive) no repair job resolves | `{Room} is broken — needs repair` (today's wording) |

- **The `role:maintenance` "Hire a Maintenance Tech" row stays** (it's the
  actionable HIRE prompt) — so an unstaffed breakdown shows two complementary
  rows: "CT broken — no maintenance staff available" + "Hire a Maintenance Tech".
  Not a third stacked toast — the SAME broken row updates in place as the job
  progresses (queued → en route → repairing → cleared).
- **Wording** (pre-impl UX review): uniform "{Room} **is** broken — …" across
  every arm (matches today's fallback + the panel's declarative voice). "en
  route" is the owner's own word; note it does NOT literally match the staff
  card ("Heading to a repair"/"Repairing") or the room card ("repair
  pending/underway") — three surfaces, a deliberate granularity delta, not a
  claim of identical strings. **"waiting for a maintenance tech" (NOT "all
  techs busy") is load-bearing:** since SHIFTS Stage-1 a hired tech may be
  OFF-SHIFT, so "busy" would be false — do not "improve" it.

## 3. The toast vs the panel (the one-shot / standing split)

The `broken` need toasts ONCE via `hintOnce('need:broken:<id>:<since>', label)` —
key UNCHANGED, so still one toast per breakdown instance. It captures the label at
the first tick the need surfaces (job just `queued` → typically "no maintenance
available" or "waiting for a maintenance tech") — which is exactly the alert that
drives a HIRE. The PANEL is the live tracker (updates to "en route" / "repairing").
This snapshot-toast / live-panel split is the intended, existing design (toasts =
a new fact once; the panel = the standing state), not a regression.

## 4. Why this is sim-safe (no determinism/save concern)

`computeBlockedNeeds` is a PURE read — it never mutates world, and its output
(display labels) never feeds back into the sim. Reading `world.jobs`/`world.staff`
for the label adds no rng, no state, no event. `needs.ts` already lives in
`src/sim/` as a derivation (like `formulas.ts`) and already produces labels; this
keeps the panel + toast single-sourced. No `SAVE_VERSION` bump, no new field.

## 5. Edge cases

- **Retired broken room**: already skipped (no row) — unchanged.
- **broken ⇔ one repair job** (v6 invariant): the lookup always resolves for a
  non-retired broken room; the defensive fallback covers only a hostile/loaded
  save that violates it (which the border already rejects), so it's belt-and-braces.
- **Tech fired mid-repair**: the job re-queues (`staffId` null) → the row reverts
  to "waiting…" / "no maintenance available" next `jobChanged` — correct.
- **Repair completes**: `brokenSince → null` + `roomChanged`/`jobChanged` → the
  row clears (today's behaviour) — unchanged.

## 6. Tests

`needs.ts` is renderer-free and unit-testable. Regressions (extend the existing
needs/maintenance suite):
1. Broken room + `working` repair job → label names the tech "…is repairing it".
2. Broken room + `assigned` job → "…{tech} en route".
3. Broken room + `queued` job, maintenance hired → "…waiting for a maintenance tech".
4. Broken room + `queued` job, NO maintenance hired → "…no maintenance staff
   available" AND the `role:maintenance` hire row still present.
5. The `broken:<roomId>:<since>` KEY is unchanged (the toast once-guard and the
   panel renderKey both still work; a label change must not change the key).

## 7. Files (anticipated)

`src/sim/needs.ts` (the broken-row label; a small `repairStatus(world, room)`
helper). Possibly `src/sim/formulas.ts` if the wording wants a shared formatter
(likely not — it's local display text). `test/` (the label regressions). **No UI
file change needed** — `BlockedPanel` already renders the label and already
invalidates on `jobChanged`. **No save/render/determinism file touched.**

## 8. Open questions for the pre-impl reviews

1. Is enriching a `label` inside `computeBlockedNeeds` the right home, or should the
   status string be a formula in `formulas.ts` (single-sourced with any future
   consumer)? Recommend keeping it in `needs.ts` (labels already live there).
2. Should the `queued`-but-tech-hired case ("waiting for a maintenance tech") also
   promote a hint, or stay panel-only? Recommend panel-only (it's a transient
   state that resolves in a tick or two; a toast would be noise).
3. Any concern that the toast snapshot ("no maintenance available") persists after
   a tech is later hired+assigned (panel says "en route", toast said "unavailable")?
   Recommend: acceptable — the toast is the one-shot alert, the panel is live; the
   `hintOnce` key is per-breakdown-instance so it never re-fires.
