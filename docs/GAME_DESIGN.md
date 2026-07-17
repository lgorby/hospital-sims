# Hospital Simms — Game Design Document

**Working title:** Hospital Simms
**Genre:** Isometric management/tycoon sim (RollerCoaster Tycoon × Theme Hospital, played straight-ish)
**Platform:** Web browser (desktop-first, mouse + keyboard)
**Version:** Design v1.0 — scoped to the first playable release ("V1")

> **Numbers note (SSOT):** every cost, fee, salary, duration, and rate in this document is an *initial* value with its rationale. Once implementation starts, `sim/data/` (see tech plan §3.1) is the single source of truth; this document is not updated for balance tweaks.

---

## 1. High Concept

You run a hospital. Patients arrive with conditions, get triaged, wait (and deteriorate), and must be routed to the right room with the right staff to be treated. Treat them well and fast: you earn money and reputation, which brings more (and sicker, higher-paying) patients. Let them languish and they leave angry — or die — and your reputation craters.

The RCT DNA, translated:

| RollerCoaster Tycoon | Hospital Simms |
|---|---|
| Guests | Patients |
| Rides | Treatment rooms (ER bay, X-ray, respiratory therapy, exam room) |
| Ride stats (excitement/intensity) | Staff skill → speed & success odds; room quality → speed & patient comfort |
| Queue lines | Waiting room / triage queue |
| Handymen, mechanics, security | Nurses, doctors, radiology technologists, respiratory therapists |
| Ride breakdowns | Equipment out-of-service (post-V1) |
| Guests getting lost; info kiosks & park maps | Patients getting lost; atriums with help desks |
| Park rating | Hospital reputation |
| Ticket prices | Treatment billing |
| Guests vomiting | Patients coding (deteriorating to critical) |

## 2. Core Loop (V1)

```
Patient spawns at entrance
        ↓
Check-in at Reception desk
        ↓
Triage (nurse assigns acuity 1–5)
        ↓
Waiting room  ←──────────────┐
        ↓                    │ (multi-step conditions
Assigned to treatment room ──┘  return to waiting
  requires: free room of the    between steps)
  right type + free staff of
  the right role
        ↓
Treatment (timed; duration from skill & room quality;
           success odds from skill & health remaining)
        ↓
  ┌─────┴──────┬─────────────┐
Discharged   Death        Left AMA
(payment,   (rep hit,    (walked out after
 rep gain)   no payment)  patience ran out;
                          rep hit, no payment)
```

The player's job is to keep this pipeline flowing by **building rooms**, **hiring staff**, and **watching the queue** — the tension is always "where is the bottleneck right now?"

### Failure pressure
- **Health decay:** every patient's health ticks down while untreated. Decay rate scales with acuity. Health at 0 = death.
- **Patience decay:** separate meter. Patience at 0 = patient leaves AMA (against medical advice). Low-acuity patients have less patience; high-acuity patients have less health.
- **Payroll:** staff salaries are charged continuously. An overbuilt, understaffed — or overstaffed, under-visited — hospital bleeds cash.

### Treatment resolution
- **Duration** = base step duration (see §6 balance table) × skill modifier `(1.3 − 0.1 × skill)` × quality modifier `(1.0 − 0.02 × qualityBonus)`.
- **Success roll** at step completion: `P(success) = clamp(0.70 + 0.06 × (skill − 1) − 0.20 × max(0, (30 − health) / 30), 0.50, 0.98)` — skilled staff help, crashing patients (health < 30) are harder to save. For dual-staff treatments, use the average skill.
- **Success:** step completes and its fee is billed; if it was the last step, the patient is discharged.
- **Failure = complication:** the patient loses 15 health and must repeat the step — they return to the waiting room (re-queued, with aged priority per Flow rule 6) and the room/staff are freed. Death only ever occurs at health 0; a failed roll is never instant death.

### Flow & edge rules (canonical V1 answers)
1. **Check-in:** 5 game-min per patient at the reception desk. The receptionist is a standing post, not dispatcher-assigned. Patients queue up to 6 tiles behind the desk; further arrivals cluster near the entrance. No reception room or no receptionist → patients never enter the system and leave when patience expires.
2. **Pre-triage decay:** untriaged patients decay at acuity-3 rates until a nurse triages them and their true acuity takes over.
3. **Decay semantics:** health decays everywhere *except* during active treatment; patience decays only while queueing/waiting **or lost** — not while purposefully walking, checking in, or being treated.
4. **Waiting room overflow:** the base 3×3 room includes 6 chairs (capacity = chairs). When full, patients stand on free tiles in and around the room with patience decaying at 1.5×.
5. **No facility/staff for a needed step:** the patient stays in waiting (still decaying) and a hint toast fires once per condition type ("Nobody here can treat Pneumonia — build Respiratory Therapy").
6. **Priority aging (anti-starvation):** the dispatcher sorts by `effectivePriority = acuity − 0.5 × hoursWaited` (lower = served first), so a flu patient waiting 4 hours competes with a fresh fracture. AMA departures remain the relief valve under sustained overload. **`hoursWaited` semantics (M3-gate ruling):** each queue class starts its own clock (entering the check-in queue, finishing check-in, finishing triage), but within the treatment queue the clock **survives every re-queue** — complication, between-steps return, rule-8 cancellation, and the lost-reservation timeout all keep the accumulated wait. It clears only on reservation start or a terminal event.
7. **Reservation release:** if a patient dies or leaves AMA at *any* point — including mid-walk to a room — every staff member and room reserved for them is released immediately and staff return to idle.
8. **No path (A\* failure):** the task is cancelled, reservations released, the patient re-queued, and a toast hints that the layout is blocked. **Cancellation is a recovery, not a spin (M3-gate ruling):** the dispatcher never reserves a room the patient can't currently path to, a cancelled patient is held from re-dispatch for 5 game-min, and the layout hint fires at most once per patient.
9. **Room sale & build safety:** rooms can only be sold while unoccupied and unreserved (the sell button is disabled otherwise). Building is disallowed on tiles currently occupied by actors. **Open-plan exemption (M3 ruling):** an atrium occupies and reserves no one, so it may be sold while people stand on its tiles (tiles stay public; walkers keep walking); selling it un-posts its greeter. At build time an atrium footprint must contain at least one entrance-reachable tile.
10. **Death visuals:** the patient flashes, fades out over ~3 s, and the entity is removed; a toast fires and the daily report tallies it.
11. **Idle staff** walk to the nearest room matching their role (or wander corridors if none exists) — cosmetic only. **V1 minimum (implemented at the M3 gate):** released staff drop their stale walk target and step out of walled rooms to the nearest free corridor tile, so an idle loiterer can never pin a room sale; the ambient wander is polish on top.
12. **Negative cash:** payroll can push cash negative; building and hiring require `cash ≥ cost` (no credit).
13. **Lost patients:** wrong turns, wandering, recovery, and the 60-game-min reservation timeout are specified in §3 (Getting lost & wayfinding). Lostness is a movement sub-state — a lost patient still belongs to whatever queue/treatment stage they were in, and all release rules (7, 8) apply unchanged.
14. **Collision model (V1):** walkers pass through each other while in motion (RCT tradition — hard per-tile blocking creates doorway deadlocks and is deferred post-V1), but **standing spots are exclusive**: destination assignment (queue slots, waiting seats, treatment spots, staff posts) avoids tiles already occupied or targeted, and each person renders with a small deterministic stance offset so transient overlaps stay readable.

### Win/lose (V1)
- No hard win state in V1 — it's sandbox with pressure. Lose state: cash below a bankruptcy threshold (−$10,000) for a full game day.
- V1 shows a **daily report** (patients treated, died, left; times patients got lost; revenue; expenses; rep change) so the player can feel progress — and spot a wayfinding problem before it becomes a death problem.

## 3. Patients

Every patient gets a **procedurally generated name and age** ("Doris Klepper, 62 — Fracture"). Names appear in inspection panels, notifications, thoughts, and the daily report — a death notification with a name on it stings in a way "Patient #47" never will. Staff are named too, and hire candidates come with names on their cards.

### Attributes
| Attribute | Range | Meaning |
|---|---|---|
| Condition | enum | What's wrong with them; determines the treatment path |
| Acuity | 1–5 | ESI-inspired: 1 = resus-level critical, 5 = minor. Set at triage |
| Health | 0–100 | Decays while waiting; death at 0 |
| Patience | 0–100 | Decays while waiting; leaves AMA at 0 |
| Wayfinding | 1–5 | Sense of direction; low = prone to wrong turns on long walks (see Getting lost) |
| Mood | derived | Visual feedback (thought bubbles): content → annoyed → angry / suffering |

### Condition roster (V1 — 6 conditions)

Each condition is a **treatment path**: an ordered list of (room type, staff role, duration) steps.

| Condition | Typical acuity | Path | Payout |
|---|---|---|---|
| Flu | 4–5 | Exam room (Doctor) | $ |
| Laceration | 3–4 | Exam room (Nurse) — sutures | $ |
| Fracture | 3 | X-ray (Rad Tech) → Exam room (Doctor) — casting | $$ |
| Asthma attack | 2–3 | Respiratory therapy (Resp. Therapist) — nebulizer | $$ |
| Pneumonia | 2–3 | X-ray (Rad Tech) → Respiratory therapy (Resp. Therapist) | $$$ |
| Chest pain | 1–2 | ER bay (Doctor + Nurse) | $$$$ |

Design rules baked into the roster:
- At least one condition per staff role, so every hire matters.
- Multi-step paths (fracture, pneumonia) create **re-queueing**, which is where interesting congestion emerges.
- Chest pain requires **two staff simultaneously** — the V1 stress-test of the assignment system.

### Patient spawning
- Arrival rate = **base 3.0 patients/game-hour** × reputation multiplier (linear 0.5×–2.0× over rep 0–1000) × time-of-day curve: 00–06 ×0.3 · 06–10 ×0.8 · 10–14 ×1.3 · 14–18 ×1.5 · 18–22 ×1.0 · 22–24 ×0.5. Spawns are Poisson-distributed around the rate (seeded RNG).
- **Condition mix (M3 ruling):** each spawn rolls a condition from per-condition base weights — initial values flu 30 · laceration 20 · fracture 15 · asthma 15 · pneumonia 10 · chest pain 10 (SSOT in `balance.ts` once implemented). **Case-mix shift (§7):** the weights of referral-grade conditions (those with `acuityMin ≤ 2`: asthma, pneumonia, chest pain) scale by `1 + 0.5 × (reputation − 300) / 700`, then the whole table renormalizes — better hospitals draw the harder, better-paying cases.
- **Wayfinding stat:** rolled uniform 1–5 from the seeded rng at spawn.

### Getting lost & wayfinding

Hospitals are mazes — patients walking to a distant room can get lost, and the player counters it with **atriums** (§5): open, pleasant spaces with a staffed help desk.

- **Wrong turns:** on every tile step of a walk, a patient rolls a wrong-turn chance of `0.4% × (6 − wayfinding)` (so 2%/tile for the worst navigators, 0.4%/tile for the best). Inside a **guidance aura** the chance is zero. Staff never get lost.
- **Lost behavior:** a lost patient abandons their path and wanders randomly with a ❓ bubble. Lostness counts as *waiting* for patience decay (it's infuriating), and health decay continues as normal — a lost chest-pain patient is a quiet emergency.
- **Getting found:** a lost patient recovers instantly when they enter a guidance aura **or** come within 3 tiles of any staff member (staff point the way); otherwise they self-recover with a 20% roll every 5 game-min. On recovery they re-path (A*) to their destination — or to the waiting room, if their reservation timed out.
- **Reservation timeout:** lost for more than 60 game-min with a room/staff reserved → the reservation is released (Flow rule 7) so the hospital doesn't stall; on recovery the patient re-queues with aged priority (Flow rule 6).
- **Why atriums, plural:** the guidance aura has a radius, so one grand atrium at the entrance protects nothing deep in the hospital. Coverage — a small atrium at each junction of a large hospital — is the design the mechanic rewards, mirroring real hospital wayfinding (and RCT's scattered info kiosks).
- Condition mix shifts slightly with reputation: better hospitals attract referrals for higher-acuity (higher-paying) cases.

**M3-gate rulings (canonical answers to the lost-state edge matrix):**
- **Which walks roll wrong turns:** patient walks in stages `waitingTriage`, `waiting`, and `reserved` (walks to seats, standing spots, and rooms). Check-in queue walks/shuffles and the leaving walk (discharged/AMA) **never** roll — a lost patient can't deadlock the reception line or haunt the exit. Staff never roll.
- **Lost while reserved:** the lost walker *keeps its reservation target* and is **exempt from the rule-8 gathering stall check** — only the 60-min timeout or a terminal event releases a lost patient's reservation. (Without this exemption the timeout is dead code: the stall check would cancel on the first lost tick.)
- **Timeout semantics:** at timeout the room and staff are released (rule-7 style); the patient stays lost, returns to stage `waiting` with **no walk target and no layout hint** (this isn't a corridor problem); waiting-spot assignment and the A* re-path happen at recovery. The wait clock keeps running throughout — lostness counts as waiting (rule 3).
- **Dispatcher:** skips lost patients when assigning — staff are never idled against a wanderer.
- **Exits clear lostness:** going AMA or being discharged clears `lost`; the patient paths to the entrance normally.
- **Wander mechanics:** uniformly random orthogonal steps (seeded rng) at normal speed; a wanderer never crosses a door edge into a walled room.
- **Geometry:** all aura radii are Euclidean, measured from the nearest atrium footprint tile, ignoring walls; staff rescue is Euclidean ≤ 3 from any staff tile. Aura coverage is a per-tile boolean — overlapping auras don't stack.
- **Staffed means posted AND arrived** (same rule as the reception desk). A posted greeter's arrival at or departure from the help desk invalidates the aura grid, alongside room build/sell and greeter hire/fire.

## 4. Staff

### Roles (V1)
| Role | Works in | Salary/day | Notes |
|---|---|---|---|
| Receptionist | Reception | $80 | Check-in throughput; no receptionist = patients stack at the door |
| Nurse | Triage, Exam room, ER bay | $150 | Triage is nurse-only; also sutures and assists in ER |
| Doctor | Exam room, ER bay | $300 | The generalist bottleneck by design |
| Radiology Technologist | X-ray | $200 | Imaging steps |
| Respiratory Therapist | Respiratory therapy | $200 | Nebulizers, breathing treatments |
| Volunteer Greeter | Atrium help desk | $50 | Standing post (like the receptionist); powers the atrium's guidance aura |

### Attributes
- **Skill (1–5):** affects treatment duration and success odds. Hiring pool offers randomized skill/salary tradeoffs. Greeter skill is **cosmetic in V1** — auras don't scale with it (their candidate cards still show it; a bargain skill-1 greeter is the smart hire).
- **State machine:** `Idle → WalkingToTask → Working → Idle`. (Fatigue, breaks, and morale are post-V1.)

### Assignment logic (the "brain" of the game)
A central **dispatcher** runs every sim tick:
1. Collect waiting patients sorted by **effective priority** — acuity aged by wait time (Flow rule 6) — like a real ED, but starvation-proof.
2. For each, find their next treatment step; match to a free, built room of the right type and free staff of the required role(s).
3. Reserve room + staff, path both to the room, run the timed treatment.

The player never micro-assigns in V1 — they shape flow by what they build and hire. (A manual "prioritize this patient" pin is a post-V1 nicety.)

### Firing
Staff can be fired from their inspection panel — effective immediately, no severance in V1. This is the correction lever for the "overstaffed, under-visited" failure mode. Staff mid-treatment finish the current patient first. **Gathering is not mid-treatment (M3-gate ruling):** firing a staff member who is still walking to a reservation cancels it per Flow rule 8 — the patient re-queues (wait clock intact), co-staff are released, and the fired member is removed immediately. Only an *active* treatment defers removal.

### Patient movement (V1)
All patients are ambulatory and walk themselves between rooms — even chest-pain patients (walking slowly, clutching their chest, for flavor). Dedicated patient transport — wheelchairs, stretchers, and a Transporter role for non-ambulatory arrivals — is a headline post-V1 system (§11): it turns *movement itself* into a schedulable resource, which is exactly the kind of dispatcher complexity V1 deliberately defers until the core loop is proven.

## 5. Rooms & Building

### Room types (V1)
| Room | Min size | Cost | Required equipment (included in cost) | Staffed by |
|---|---|---|---|---|
| Reception | 2×3 | $2,000 | Desk | Receptionist |
| Waiting room | 3×3 | $1,000 | 6 chairs included (capacity = chairs; overflow stands, Flow rule 4) | — |
| Triage bay | 2×2 | $1,500 | Chair, vitals cart | Nurse |
| Exam room | 3×3 | $3,000 | Exam bed, cabinet | Doctor or Nurse |
| X-ray | 3×4 | $8,000 | X-ray machine, lead screen | Rad Tech |
| Respiratory therapy | 3×3 | $5,000 | Treatment chair, nebulizer station | Resp. Therapist |
| ER bay | 3×4 | $10,000 | Trauma bed, crash cart, monitor | Doctor + Nurse |
| Atrium | 4×4 | $4,000 | Help desk, benches, plants | Volunteer Greeter |

**Atrium special rules:** unlike treatment rooms, an atrium is **open-plan** — no walls or door; its tiles stay public and walkable, and it has no dispatcher occupancy slot. While its help desk is staffed (greeter posted **and arrived**) it projects a **guidance aura** (radius 8 tiles): no wrong turns inside it, and lost patients who enter it instantly recover. Staffed or not, it projects a **comfort aura** (same radius): patience decays at 0.75× within it — multiplying with other patience modifiers (a standing overflow waiter in comfort decays at 1.5 × 0.75). Several small atriums spread across the hospital beat one big one — coverage is the point.

### Building mechanics
- Drag-a-rectangle room placement on the isometric grid (Theme Hospital style), then place the door on a wall segment touching a corridor/open tile.
- **Placement validation:** in bounds, no overlap, min size met, no actors on the footprint, and the door must have a walkable path to the entrance (a door may open onto a corridor **or an atrium tile** — open-plan tiles are public). A build that would sever any *existing* room's door-to-entrance path, or seal any person into an unreachable pocket, is rejected with a hint.
- Required equipment is **auto-placed** (fixed, data-driven layouts per room type, like the M1 exam bed; placement respects the interior-connectivity backstop). Player rearrangement of equipment is post-V1.
- Rooms can be sold back at 50% of cost — only while unoccupied and unreserved (Flow rule 9).
- Corridors are just unbuilt floor — patients and staff path through any walkable tile. (Explicit corridor décor is post-V1.)
- **Room quality (V1-simple):** each tile of size above the minimum adds a small quality bonus (roomier = slightly faster treatment, slower patience decay inside). Décor items deepen this post-V1.

### The map
- Single fixed lot for V1: **40×40 tiles**, entrance fixed on the south edge. Buy-more-land is post-V1.

## 6. Economy (V1 starting numbers — tune in playtest)

- Starting cash: **$50,000**
- Revenue: flat fee per completed treatment step — Flu $150 · Laceration $200 · Fracture $500 (X-ray $200 + casting $300) · Asthma $400 · Pneumonia $700 · Chest pain $1,200
- Expenses: salaries (charged per game-hour, pro-rated), room construction, one-time hire fee ($100)
- Payment is **per completed step** — a fracture patient who gets an X-ray but leaves AMA before casting still pays $200 for the X-ray. Death works the same way: fees already billed for completed steps stay billed; only uncompleted steps go unpaid.
- No insurance/billing simulation in V1 — flat fees keep the loop legible. (Insurance mix is a flavorful post-V1 system.)

### Balance defaults (initial values — all live in `sim/data/balance.ts`)

Time anchor: 1 game day = 8 real minutes at 1× ⇒ **1 game-hour = 20 real seconds**.

**Step durations (game-minutes):**

| Step | Duration | | Step | Duration |
|---|---|---|---|---|
| Check-in | 5 | | Casting (fracture) | 30 |
| Triage | 10 | | Asthma nebulizer | 45 |
| Flu exam | 30 | | Pneumonia resp. therapy | 60 |
| Laceration sutures | 40 | | Chest pain ER | 90 |
| X-ray | 20 | | |

**Decay rates (points per game-hour), by acuity:**

| Acuity | 1 (critical) | 2 | 3 | 4 | 5 (minor) |
|---|---|---|---|---|---|
| Health decay | 12 | 8 | 5 | 3 | 2 |
| Patience decay | 3 | 5 | 8 | 10 | 12 |

**Wayfinding (per §3 Getting lost):**

| Parameter | Value |
|---|---|
| Wrong-turn chance per tile step | 0.4% × (6 − wayfinding); 0 inside a guidance aura |
| Guidance aura radius (staffed atrium) | 8 tiles |
| Staff-proximity rescue radius | 3 tiles |
| Comfort aura (any atrium) | patience decay × 0.75 within 8 tiles |
| Self-recovery while lost | 20% roll per 5 game-min |
| Lost reservation timeout | 60 game-min |

So an untreated chest-pain patient (acuity 1, full health) dies in ~8 game-hours; a flu patient (acuity 5) walks out in ~8. The M4 headless harness asserts a sensible hospital survives these numbers and a neglected one doesn't.

## 7. Reputation

- Score 0–1000, starts at 300.
- Gains: successful discharge (+2 to +8 scaled by acuity); day-close bonus of +10 if the day's average door-to-first-treatment wait was under 2 game-hours *(the bonus needs per-day wait tracking, so it lands with the M4 daily report — M3 reputation covers discharge/death/AMA deltas and the arrival/case-mix couplings only)*.
- Losses: death (−25), left-AMA (−8).
- Effects: arrival-rate multiplier (0.5× at rep 0 → 2× at rep 1000) and case-mix shift toward higher acuity.

## 8. Time

- Game clock with day/hour display. 1 game day ≈ 8 real minutes at 1× speed.
- Speed controls: **pause / 1× / 2× / 3×**. Build, hire, and fire while paused (RCT tradition) — commands apply even at speed 0 and the world reflects them immediately (see tech plan §2.2 for how this avoids the paused-queue deadlock).

## 9. UI

- **HUD (top bar):** cash, reputation, date/time, speed controls, daily patient counter.
- **Build menu (bottom):** room catalog with cost/footprint preview; hire menu with candidate cards (role, skill stars, salary). *(Owner ruling, 2026-07-17 playtest: the bottom-bar panels — build catalog, hire panel, thought log — behave as **mutually exclusive dropdowns**: opening one closes the others; they must never overlap. With the §12 room roster the build catalog additionally splits into category groups — Basics · Imaging · Treatment · Comfort — instead of one flat strip.)*
- **Inspection panels:** click a patient → condition, acuity, health/patience bars, current state. Click a staff member → role, skill, salary, current task, **Fire** button. Click a room → type, quality, assigned staff, patient inside, **Sell** button (disabled while occupied/reserved).
- **Notifications (toast queue):** death, AMA departure, bankruptcy warning, "no room can treat X" hints. **Clicking a toast snaps the camera** to the entity or tile it references — a death report on a 40×40 map is useless if you can't jump to where it happened. *(M3 ruling: every jumpable event carries a `{col,row}` tile snapshot at emit time; a click pans to the live entity if it still exists, else to the snapshot — a death toast must outlive its patient, whose entity fades in ~3 s.)*
- **Coverage overlay:** while placing or selecting an atrium, tiles inside guidance auras are tinted — both the ghost's radius and all existing coverage — so wayfinding gaps are visible instead of guessed. *(M3 ruling: staffed atriums tint solid; an unstaffed atrium's potential radius renders dimmed/hollow. Comfort coverage shares the same footprint, so one tint suffices.)* (General overlay infrastructure also serves the debug panel.)
- **Thought log:** the RCT guest-thoughts analog. A scrollable feed of recent patient thoughts ("Doris K.: *I've been waiting forever*", "*I got lost twice!*", "*What a lovely atrium*"), generated at mood-bubble moments. The first-run checklist teaches the opening; the thought log is how the player diagnoses the mid-game — it's the narrative answer to "why are my patients dying?" *(M3 ruling: capped at the most recent 100 entries; the trigger moments come from the shared `moodOf` formula plus lifecycle events (lost, rescued, treated, long wait); thought strings are game content and live in `sim/data/thoughts.ts` per SSOT.)*
- **Daily report modal** at midnight.
- **First-run experience:** a new game starts with a reception desk and waiting room pre-built and one receptionist hired, plus a persistent guided checklist in place of a tutorial: *Build a Triage Bay → Hire a Nurse → Build an Exam Room → Hire a Doctor → Treat your first patient.* Items check off as completed; the checklist dismisses itself. This is what makes the M4 definition-of-done ("a stranger plays 3 days without instruction") achievable.
- Rendering note: HUD/menus are DOM overlay (HTML/CSS), not in-canvas — see tech plan.

## 10. Art & Audio Direction (V1)

- **Placeholder-first:** flat-colored isometric diamond tiles, simple two-frame walking sprites with role-colored scrubs (patients in gowns, nurses teal, doctors white coat, rad techs navy, RTs green). Readability over fidelity.
- Mood conveyed with floating emoji-style bubbles (💢 impatient, 💀 critical, 💚 treated, ❓ lost).
- Audio: none in V1. A hook point exists in the event system for later (heart-monitor beeps, PA chimes, cash register on discharge).

## 11. Post-V1 Roadmap (explicitly out of scope for V1)

Ordered by likely value:
1. **Diagnosis uncertainty** — conditions arrive as symptoms; exam/imaging reveals the real condition (Theme Hospital's best trick).
2. **Patient transport** — Transporter role, wheelchairs, and stretchers. Some arrivals (acuity 1–2, post-op later) become **non-ambulatory**: they cannot walk between rooms and must be moved by a transporter with equipment. Movement itself becomes a schedulable, reservable resource — the biggest single upgrade to the dispatcher game. Pairs naturally with ambulance arrivals (item 4). V1 explicitly keeps all patients ambulatory (§4, Patient movement).
3. **Janitors & messes** — the true RCT handyman analog, currently absent: patients vomit and bleed, dirty tiles tank comfort and reputation, janitors sweep. A whole new actor loop, which is why it waits.
4. **Staff fatigue & morale** — breaks, staff room, burnout quits.
5. **Emergencies** — ambulance arrivals, multi-casualty events, code blues with CPR minigame odds.
6. **More departments** — ICU (post-ER holding), lab, pharmacy, inpatient ward. *(OR + surgeon and the imaging suite were promoted to §12 Expansion 1, owner-requested 2026-07-17.)*
7. **Equipment breakdown + maintenance techs** (the RCT mechanic analog).
8. **Décor, comfort & concessions** — plants and TVs affecting patience; **wall signage** as a cheap, unstaffed wayfinding item that lowers wrong-turn chance along a corridor (the budget alternative to an atrium); **vending machines, gift shop, cafeteria** as RCT's food-stall economy — secondary revenue from waiting patients plus a patience boost.
9. **Insurance/billing mix** — payer types with different reimbursement and paperwork delay.
10. **Finance & stats graphs** — RCT's chart screen: cash over time, treatments by condition, deaths, average wait. The daily report is the V1 version; graphs are the long game.
11. **Scenario sharing & unlockable maps** — "reach rep 600 in 10 days." (Save/load itself is a V1 stretch goal in the tech plan's M4, not a post-V1 item.)
12. **Epidemics/seasonal events** — flu season surges.
13. **Options & accessibility** — pause-on-death toggle (RCT tradition), autosave, colorblind-safe role palette.
14. **Roaming volunteers** *(owner-requested, 2026-07-17 playtest)* — a patrolling counterpart to the posted Volunteer Greeter (§4): walks a beat between waypoints (or wanders a wing) and rescues lost patients via the existing staff-proximity rule, effectively a **mobile guidance presence** instead of a fixed aura. Design tension to resolve: V1 deliberately made lostness counterable by *placement* (atrium coverage); a cheap roamer that solves lostness everywhere would undercut the atrium economy, so the roamer should be weaker per-dollar than coverage (small rescue radius, no wrong-turn prevention — cure, not prophylaxis). Slots into the dispatcher as a new duty kind (`patrol`); pairs with item 2's Transporter (shared "movement staff" scheduling) and item 8's wall signage as the third wayfinding tier: signage (passive, cheap) < roamer (mobile, mid) < staffed atrium (area denial, premium).
15. **Family & visitors** *(owner-requested, 2026-07-17 playtest)* — companions arrive with some patients (weighted by age/acuity: children and acuity 1–2 rarely arrive alone), walk with them to waiting areas, occupy seats, and slow the patient's patience decay while nearby (a portable comfort aura, weaker than the atrium's). They leave on the patient's terminal event — including grieving exits on death (reputation sting amplifier). Visitors are non-actors to the dispatcher (never treated, never block treatment spots) but DO consume waiting-room seats — bigger waiting rooms become genuinely necessary. Natural revenue hook for item 8's concessions (visitors are who buys from the gift shop/cafeteria). Sim-cost note: roughly doubles walker count at high traffic — the V1 perf headroom (60fps at ~110 patients, measured 2026-07-17) supports it, but seat-search and `isTileClaimed` scans should get spatial indexing first if visitor counts push actors past ~300.
16. **View rotation** *(owner-requested, 2026-07-17)* — a rotate control (button + keyboard, RCT-style) that cycles the camera through the **four 90° orientations** so players can see behind walls and around corners. This is a **rendering-architecture milestone, NOT input polish** — it's cross-cutting and touches the load-bearing iso assumptions, so it gets its own milestone and a pre-implementation review like every other. Scope (full architectural detail in `TECH_PLAN.md` §2.7): (a) `iso.ts`'s single grid→screen transform and its exact inverse (picking) must become orientation-parameterized (4 variants); (b) `depthKey` (`col+row`) is only correct for the current orientation — each rotation needs its own depth ordering; (c) walls' fixed N/W-far / S/E-near orientation must re-derive per rotation; (d) **character facings must cover all four camera orientations** — the art pass added 4 facings for ONE camera angle; rotation multiplies the facing space (either regenerate per orientation or remap which of the 4 sprite facings shows). Everything downstream reads `toScreen`/`depthKey`/`characterKey`, so done right it's centralized, but it is a genuine milestone. The input-polish pass (continuous pan/zoom) shipped separately and first (2026-07-17) — do NOT conflate the two.
17. **Touchscreen / touch input** *(owner-requested, 2026-07-17 — deferred, build later)* — the game currently handles **mouse + trackpad only**: pan/zoom ride on `wheel` events (two-finger scroll = pan, pinch = ctrl+wheel = zoom), and select/build ride on mouse-button pointer events. **Touching the display does nothing** because touch gestures emit *touch* pointer events the canvas doesn't handle. To add: one-finger drag/tap → pan/select, two-finger pinch → zoom (two-pointer distance ratio), via Pointer Events on the canvas — coexisting carefully with the existing tap-to-select and drag-to-build logic (a single touch already fires `pointerdown` button 0, so build/select must not mis-trigger during a two-finger gesture). Self-contained to `renderer.ts`'s input layer; makes the game tablet-playable. Pairs with item 16 (a "mobile/touch" pass would do both).

## 12. Expansion 1 — Departments & Imaging (owner-requested 2026-07-17; first content milestone after the V1 DoD closes)

The owner asked for a wider hospital: surgery, a fuller imaging suite (ultrasound, CT, MRI, nuclear medicine), dialysis, and more ER traffic — "not limited to just these rooms." This section is the design; numbers are initial values, SSOT moves to `balance.ts` at implementation per §6's rule. The §3/§4/§5 design rules all still bind: every room earns ≥1 condition path, every role earns ≥1 condition, multi-step paths drive re-queueing, dual-staff rooms stress the dispatcher.

### New rooms
| Room | Min size | Cost | Required equipment | Staffed by |
|---|---|---|---|---|
| Ultrasound | 2×3 | $4,000 | Ultrasound cart, exam bed | Sonographer |
| CT scanner | 4×4 | $14,000 | CT gantry, control desk | Rad Tech |
| MRI | 4×4 | $18,000 | MRI bore, shield screen, control desk | Rad Tech |
| Nuclear medicine | 3×4 | $16,000 | Gamma camera, hot-lab bench | Rad Tech |
| Dialysis | 3×4 | $9,000 | Dialysis chairs ×2, machine | Nurse |
| Operating room | 4×4 | $20,000 | OR table, anesthesia cart, scrub sink | Surgeon + Nurse |

### New roles
| Role | Works in | Salary/day | Notes |
|---|---|---|---|
| Sonographer | Ultrasound | $180 | The cheap imaging on-ramp |
| Surgeon | Operating room | $500 | Dual-staff with a nurse — the second assignment-system stress test after chest pain |

**Rad Tech becomes a deliberate multi-room bottleneck** (X-ray, CT, MRI, nuclear medicine): one tech cannot staff two scanners at once, so scaling imaging means hiring techs — the imaging mirror of the doctor-generalist bottleneck (§4). Dialysis reuses the Nurse (as in real units), deepening nurse demand rather than adding a fourth niche role.

### New conditions
| Condition | Typical acuity | Path | Payout | Base weight |
|---|---|---|---|---|
| Kidney stones | 3 | CT (Rad Tech) → Exam (Doctor) | $$$ | 8 |
| Back injury | 4 | MRI (Rad Tech) → Exam (Doctor) | $$$ | 8 |
| Thyroid disorder | 4 | Nuclear medicine (Rad Tech) → Exam (Doctor) | $$$ | 6 |
| Kidney failure | 2 | Dialysis (Nurse) | $$$ | 6 |
| Gallstones | 3 | Ultrasound (Sonographer) → Operating room (Surgeon + Nurse) | $$$$ | 6 |
| Head injury | 2 | CT (Rad Tech) → ER bay (Doctor + Nurse) | $$$$ | 5 |
| Appendicitis | 2 | Ultrasound (Sonographer) → Operating room (Surgeon + Nurse) | $$$$$ | 5 |
| Stroke | 1 | CT (Rad Tech) → ER bay (Doctor + Nurse) | $$$$$ | 4 |

Design notes:
- **The ER gets busier without a new room kind:** head injury and stroke both terminate in the existing ER bay — the owner's "rooms in the ER" ask is served first by traffic; dedicated trauma/resus variants and ICU holding stay §11 item 6.
- **Late-game by case mix, not by lockout:** the new roster is referral-heavy (six of eight at acuity ≤ 3, four at acuity ≤ 2), so §3's reputation case-mix shift naturally makes expansion rooms matter as the hospital's rep grows; low base weights (48 added against the existing 100) keep the early game recognizably V1.
- **Appendicitis/gallstones are the new longest chains** (imaging → OR with two staff) — the congestion showcase; a lost post-ultrasound appendicitis patient wandering while their surgeon waits is the expansion's "quiet emergency."
- **UI prerequisite:** the §9 dropdown/category ruling ships before or with this roster — 14 room types do not fit a flat strip.
- **Save compatibility:** new rooms/roles/conditions extend the `as const` data tables; per `PERSISTENCE_PLAN.md` rule 6 this is a `SAVE_VERSION` bump (new enum values in saves), with a migration decision for old saves at implementation time.

**Implementation rulings (Expansion-1 review, 2026-07-17 — code is authoritative, recorded here per the doc-pointer rule):**
- **Acuity ranges:** the table's "typical acuity" scalars became ranges where triage variety helps: thyroid 4–5, kidney failure 2–3 (both contain the typical value; kidney failure keeps `acuityMin 2`, preserving referral-grade status). Others are pinned scalars.
- **Prop reuse (SSOT-friendly):** ultrasound's "exam bed" is the existing `bed` prop; CT/MRI "control desk" is the existing `desk`. Dialysis is realized as 2 generic chairs + 2 `dialysisMachine` units (one per station).
- **Save migration (v1→v2):** v1 saves load unchanged EXCEPT the hire-candidate pool, which is topped up per role on load so the new roles are hireable (a v1 pool predates sonographer/surgeon and would otherwise never offer them).
- **Balance harness semantics:** the reference build gained an Expansion-1 wing whose capital is bankrolled in the fixture — the harness's "stays in the black" assertion measures the OPERATING envelope only, by design (documented in `test/harness.test.ts`).
