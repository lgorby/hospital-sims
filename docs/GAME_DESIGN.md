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
6. **Priority aging (anti-starvation):** the dispatcher sorts by `effectivePriority = acuity − 0.5 × hoursWaited` (lower = served first), so a flu patient waiting 4 hours competes with a fresh fracture. AMA departures remain the relief valve under sustained overload.
7. **Reservation release:** if a patient dies or leaves AMA at *any* point — including mid-walk to a room — every staff member and room reserved for them is released immediately and staff return to idle.
8. **No path (A\* failure):** the task is cancelled, reservations released, the patient re-queued, and a toast hints that the layout is blocked.
9. **Room sale & build safety:** rooms can only be sold while unoccupied and unreserved (the sell button is disabled otherwise). Building is disallowed on tiles currently occupied by actors.
10. **Death visuals:** the patient flashes, fades out over ~3 s, and the entity is removed; a toast fires and the daily report tallies it.
11. **Idle staff** walk to the nearest room matching their role (or wander corridors if none exists) — cosmetic only.
12. **Negative cash:** payroll can push cash negative; building and hiring require `cash ≥ cost` (no credit).
13. **Lost patients:** wrong turns, wandering, recovery, and the 60-game-min reservation timeout are specified in §3 (Getting lost & wayfinding). Lostness is a movement sub-state — a lost patient still belongs to whatever queue/treatment stage they were in, and all release rules (7, 8) apply unchanged.

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

### Getting lost & wayfinding

Hospitals are mazes — patients walking to a distant room can get lost, and the player counters it with **atriums** (§5): open, pleasant spaces with a staffed help desk.

- **Wrong turns:** on every tile step of a walk, a patient rolls a wrong-turn chance of `0.4% × (6 − wayfinding)` (so 2%/tile for the worst navigators, 0.4%/tile for the best). Inside a **guidance aura** the chance is zero. Staff never get lost.
- **Lost behavior:** a lost patient abandons their path and wanders randomly with a ❓ bubble. Lostness counts as *waiting* for patience decay (it's infuriating), and health decay continues as normal — a lost chest-pain patient is a quiet emergency.
- **Getting found:** a lost patient recovers instantly when they enter a guidance aura **or** come within 3 tiles of any staff member (staff point the way); otherwise they self-recover with a 20% roll every 5 game-min. On recovery they re-path (A*) to their destination — or to the waiting room, if their reservation timed out.
- **Reservation timeout:** lost for more than 60 game-min with a room/staff reserved → the reservation is released (Flow rule 7) so the hospital doesn't stall; on recovery the patient re-queues with aged priority (Flow rule 6).
- **Why atriums, plural:** the guidance aura has a radius, so one grand atrium at the entrance protects nothing deep in the hospital. Coverage — a small atrium at each junction of a large hospital — is the design the mechanic rewards, mirroring real hospital wayfinding (and RCT's scattered info kiosks).
- Condition mix shifts slightly with reputation: better hospitals attract referrals for higher-acuity (higher-paying) cases.

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
- **Skill (1–5):** affects treatment duration and success odds. Hiring pool offers randomized skill/salary tradeoffs.
- **State machine:** `Idle → WalkingToTask → Working → Idle`. (Fatigue, breaks, and morale are post-V1.)

### Assignment logic (the "brain" of the game)
A central **dispatcher** runs every sim tick:
1. Collect waiting patients sorted by **effective priority** — acuity aged by wait time (Flow rule 6) — like a real ED, but starvation-proof.
2. For each, find their next treatment step; match to a free, built room of the right type and free staff of the required role(s).
3. Reserve room + staff, path both to the room, run the timed treatment.

The player never micro-assigns in V1 — they shape flow by what they build and hire. (A manual "prioritize this patient" pin is a post-V1 nicety.)

### Firing
Staff can be fired from their inspection panel — effective immediately, no severance in V1. This is the correction lever for the "overstaffed, under-visited" failure mode. Staff mid-treatment finish the current patient first.

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

**Atrium special rules:** unlike treatment rooms, an atrium is **open-plan** — no walls or door; its tiles stay public and walkable, and it has no dispatcher occupancy slot. While its help desk is staffed it projects a **guidance aura** (radius 8 tiles): no wrong turns inside it, and lost patients who enter it instantly recover. Staffed or not, it projects a **comfort aura** (same radius): patience decays at 0.75× within it. Several small atriums spread across the hospital beat one big one — coverage is the point.

### Building mechanics
- Drag-a-rectangle room placement on the isometric grid (Theme Hospital style), then place the door on a wall segment touching a corridor/open tile.
- **Placement validation:** in bounds, no overlap, min size met, no actors on the footprint, and the door must have a walkable path to the entrance (a door may open onto a corridor **or an atrium tile** — open-plan tiles are public). A build that would sever any *existing* room's door-to-entrance path, or seal any person into an unreachable pocket, is rejected with a hint.
- Required equipment auto-suggests placement spots; player can rearrange within the room.
- Rooms can be sold back at 50% of cost — only while unoccupied and unreserved (Flow rule 9).
- Corridors are just unbuilt floor — patients and staff path through any walkable tile. (Explicit corridor décor is post-V1.)
- **Room quality (V1-simple):** each tile of size above the minimum adds a small quality bonus (roomier = slightly faster treatment, slower patience decay inside). Décor items deepen this post-V1.

### The map
- Single fixed lot for V1: **40×40 tiles**, entrance fixed on the south edge. Buy-more-land is post-V1.

## 6. Economy (V1 starting numbers — tune in playtest)

- Starting cash: **$50,000**
- Revenue: flat fee per completed treatment step — Flu $150 · Laceration $200 · Fracture $500 (X-ray $200 + casting $300) · Asthma $400 · Pneumonia $700 · Chest pain $1,200
- Expenses: salaries (charged per game-hour, pro-rated), room construction, one-time hire fee ($100)
- Payment is **per completed step** — a fracture patient who gets an X-ray but leaves AMA before casting still pays $200 for the X-ray.
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
- Gains: successful discharge (+2 to +8 scaled by acuity); day-close bonus of +10 if the day's average door-to-first-treatment wait was under 2 game-hours.
- Losses: death (−25), left-AMA (−8).
- Effects: arrival-rate multiplier (0.5× at rep 0 → 2× at rep 1000) and case-mix shift toward higher acuity.

## 8. Time

- Game clock with day/hour display. 1 game day ≈ 8 real minutes at 1× speed.
- Speed controls: **pause / 1× / 2× / 3×**. Build, hire, and fire while paused (RCT tradition) — commands apply even at speed 0 and the world reflects them immediately (see tech plan §2.2 for how this avoids the paused-queue deadlock).

## 9. UI

- **HUD (top bar):** cash, reputation, date/time, speed controls, daily patient counter.
- **Build menu (bottom):** room catalog with cost/footprint preview; hire menu with candidate cards (role, skill stars, salary).
- **Inspection panels:** click a patient → condition, acuity, health/patience bars, current state. Click a staff member → role, skill, salary, current task, **Fire** button. Click a room → type, quality, assigned staff, patient inside, **Sell** button (disabled while occupied/reserved).
- **Notifications (toast queue):** death, AMA departure, bankruptcy warning, "no room can treat X" hints. **Clicking a toast snaps the camera** to the entity or tile it references — a death report on a 40×40 map is useless if you can't jump to where it happened.
- **Coverage overlay:** while placing or selecting an atrium, tiles inside guidance auras are tinted — both the ghost's radius and all existing coverage — so wayfinding gaps are visible instead of guessed. (General overlay infrastructure also serves the debug panel.)
- **Thought log:** the RCT guest-thoughts analog. A scrollable feed of recent patient thoughts ("Doris K.: *I've been waiting forever*", "*I got lost twice!*", "*What a lovely atrium*"), generated at mood-bubble moments. The first-run checklist teaches the opening; the thought log is how the player diagnoses the mid-game — it's the narrative answer to "why are my patients dying?"
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
6. **More departments** — ICU (post-ER holding), OR + surgeon, lab, pharmacy, inpatient ward.
7. **Equipment breakdown + maintenance techs** (the RCT mechanic analog).
8. **Décor, comfort & concessions** — plants and TVs affecting patience; **wall signage** as a cheap, unstaffed wayfinding item that lowers wrong-turn chance along a corridor (the budget alternative to an atrium); **vending machines, gift shop, cafeteria** as RCT's food-stall economy — secondary revenue from waiting patients plus a patience boost.
9. **Insurance/billing mix** — payer types with different reimbursement and paperwork delay.
10. **Finance & stats graphs** — RCT's chart screen: cash over time, treatments by condition, deaths, average wait. The daily report is the V1 version; graphs are the long game.
11. **Scenario sharing & unlockable maps** — "reach rep 600 in 10 days." (Save/load itself is a V1 stretch goal in the tech plan's M4, not a post-V1 item.)
12. **Epidemics/seasonal events** — flu season surges.
13. **Options & accessibility** — pause-on-death toggle (RCT tradition), autosave, colorblind-safe role palette.
