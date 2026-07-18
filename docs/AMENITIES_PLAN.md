# Amenities, EVS & facility-failure layer — scoping brief (DRAFT v0)

**Status: DRAFT v0 (2026-07-18) — NOT designed, NOT reviewed, NOT ratified.**
This is the warm-start brief for the next working session: the owner's ask,
the design surface it touches, and the questions to ratify BEFORE code.
Workflow (proven across Phase 2 / HINTS / the capacity epic): flesh this into
a full design doc → adversarial design review → owner ratification of the
decision list → staged implementation plan → per-stage build + review.

## 1. The owner's ask (2026-07-17, verbatim intent)

> "Do you have an option to buy things like trashcan, vending machines,
> restrooms, etc, janitors, Environmental Service Workers (EVS), maintenance,
> etc. We need piping to go bad, bathroom, people throwing up, etc"

A Theme-Hospital-style **upkeep layer**: buyable amenities, cleaning/repair
staff, and failure/mess mechanics that create ongoing operational pressure
beyond the current treat-and-bill loop.

## 2. The design surface (what a full design must cover)

1. **Amenity props/rooms** — trashcan, vending machine (revenue?), restroom
   (a room? multi-stall via the Stage-A capacity system?), possibly plants/
   decor. All fit the existing `PROP_STYLE`/`ROOM_DEFS` + density machinery.
2. **New staff roles** — janitor/EVS (cleaning), maintenance tech (repairs).
   Fit `ROLE_DEFS` + the dispatcher (cleaning/repair "jobs" are a NEW duty
   kind — today staff only post or join patient reservations; this is the
   biggest sim change: a non-patient work queue).
3. **Patient needs** — bladder (restrooms), maybe thirst (vending). New
   per-patient meters decaying like patience; unmet needs → patience penalty /
   mess events. Which meters exist is an owner call (§3 Q1).
4. **Mess & cleanliness** — vomit (low-health/queasy patients), litter (near
   vending/waiting), overflowing trashcans. Messes are tile objects in the
   existing grid; a cleanliness score feeds reputation/patience (like the
   waiting-quality multiplier). EVS staff path to messes and clean them.
5. **Facility failures** — piping bursts (restrooms/dialysis), machine
   breakdowns (imaging/OR out of service until repaired). Failures roll from
   `world.rng` (determinism preserved); a broken room's capacity drops to 0
   (the Stage-A `capacityOf` machinery + the flagged capacity-0 hint gap
   become load-bearing here — see HANDOFF stage-A NIT).
6. **Hints/needs integration** — the blocked-needs panel should surface "hire
   a Janitor", "restroom needed", "X-Ray is broken — hire Maintenance".
   (`roomChanged` invalidation is already wired — pre-push review.)

## 3. Owner decisions to ratify (draft list — refine during design)

1. **Needs scope:** bladder only, or bladder + thirst (+ hunger?)? Each meter
   is sim+UI+balance+save surface.
2. **Role split:** one combined EVS role, or janitor (cleaning) + maintenance
   (repairs) as separate hires?
3. **Failure model:** random breakdowns (rng cadence per room age/use?) vs
   use-count wear; can failures hurt patients mid-treatment or only disable
   rooms?
4. **Vending revenue:** do vending machines earn money (new income stream —
   balance implications) or are they pure patience relief?
5. **Mess consequences:** patience-only, or reputation hits / infection-style
   health effects too?
6. **Staging:** suggested — Stage 1 amenities+needs (props, restroom, bladder,
   vending), Stage 2 EVS+messes (vomit/litter/cleaning jobs), Stage 3
   failures+maintenance. Each independently shippable.

## 4. Known engineering implications (from the current codebase)

- **New duty kind** for staff (`cleaning`/`repair` jobs) — dispatcher grows a
  non-reservation work queue; Flow rules 7/8 analogues needed (job release on
  fire/terminal).
- **Save:** new patient meters + mess tiles + broken-room state ⇒
  `SAVE_VERSION` 4 + migration (plan rule 6 checklist; the v2→v3 slotIndex
  migration is the template).
- **Determinism:** all failure/mess rolls via `world.rng`; the float-op lint
  and the fixed-seed replay gate must stay green; challenge comparability
  changes again (accepted honor-system stance).
- **Balance:** new pressure needs a harness pass (the reference build gains
  amenities; watch the operating envelope).
- **Render:** mess decals + broken-state visuals are new per-tile/per-room
  draws — must stay per-change, never per-frame (HANDOFF render invariant).

## 5. Separate small items (not this epic — do as quick passes)

- **Patient click-highlight** from the thought log (already pans; add a
  selection pulse) — one small reviewed pass.
- **Capacity/contention hints** ("expand your ER or build another") — the
  parked HINTS follow-up; unblocked by the capacity epic.
- **Mega-room dominance watch** — play data first; the §8 Q5 bed-cap lever is
  ready if needed.
