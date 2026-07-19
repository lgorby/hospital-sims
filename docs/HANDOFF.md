# Handoff — Hospital Simms

**Last updated:** 2026-07-19 (Departments epic Stage 1 SHIPPED — respiratory
therapy retired, its care moved to the bedside; ED epic Stage B1 SHIPPED — ratio staffing, the
attention penalty, denser ED beds, close/reopen-to-expand; Stages B2/C still
drafted in `docs/ED_PLAN.md`. SAVE_VERSION 10, 644 tests, all gates green)
**OWNER DECISIONS PENDING (adopt-unless-vetoed, all review-recommended):**
(1) the clean-day +2 cleanliness rep bonus requires ≥1 arrival that day (the
wait-bonus "an empty hospital isn't fast" principle — ratified §4.2 didn't
contemplate empty days); (2) idle EVS stand where released instead of
wandering (matches all released staff; §4.4's "wander" overstated). Both are
one-line reverts if vetoed (`cleanlinessRepDelta` in formulas.ts; no code
for the second — it's the absence of a wander system).
(3) **Stage-3 balance pass (the owner's "bathrooms don't look used" report,
2026-07-18):** `breakWatchdogGameMinutes` 30→120 — the old value covered a
~14-tile walk (walking costs ~2.1 game-min/tile), so the watchdog aborted
nearly every legitimate restroom trip MID-WALK (harness trace: 373 claims →
23 completions; patients visibly walked toward the bathroom and turned
around — the exact reported symptom); plus `bladderPerGameHour` 10→12 and
`spawnMeterMin` 60→45 (time-to-seek ~4.5h→~3.1h). Post-fix: 128–169 visits
per 5-day run (was 12–33), live-drive confirmed near-continuous stall
occupancy. All three numbers in `BALANCE.needs` — one-line reverts each.
(4) Room `broken: boolean` became `brokenSince: number | null` (one field
serves the flag AND the instance-keyed breakdown toast — design MINOR 8).
**State: M0–M4 + audit + save/load + V1 DoD + Expansion 1 + art pass + DEPLOY + Phase 2 (seed challenges) + HINTS + UI polish + build-UX + the FULL capacity & growth epic + Quit-to-Title + the FULL AMENITIES EPIC — **Stage 1** (needs/restroom/amenities, SAVE_VERSION 4), **Stage 2** (messes/EVS/job queue, SAVE_VERSION 5), **Stage 3** (use-based wear + breakdowns, repair jobs, Maintenance Tech, piping bursts, SAVE_VERSION 6). Live at https://hospital-sims.vercel.app (git push to `master` auto-deploys). **497 tests, all gates green.** Stage 3 ran the full workflow: S3 plan pre-impl-reviewed (3 MAJOR folded: structurally-workable repair anchors, guaranteed repair mints + burst exclusions, sell-occupancy semantics) → freeze → sim inline + parallel UI/render agent tracks → 2 adversarial reviews (code/contract: 1 MAJOR — a mess on a WALKABLE repair anchor suppressed its clean mint, a save-bricking class; fixed via addMess re-anchoring the repair job; live-drive: COMMIT, 0 MAJOR, 9/9 PASS, v5→v6 proven on a real production save) → ALL findings fixed + regressions. The Stage-3 session ALSO root-caused and fixed the owner's "bathrooms don't look used" report (see OWNER DECISIONS 3 — a watchdog/walk-speed arithmetic bug, not a Stage-3 defect). NEXT: quick passes — fun-name pool expansion (owner ask), patient click-highlight, capacity/contention hints; then scope the owner's new asks (family/visitors, wheelchairs, seated exams — see the design backlog). See Next.**

## What this project is

An isometric hospital tycoon game — RCT/Theme Hospital DNA. Patients arrive, check in, get triaged, wait (health and patience decay), get treated by the right staff in the right room, and are discharged, die, or walk out. The player builds rooms and hires staff; money and reputation are the score.

Two documents are the contract; read them before writing code:
- `docs/GAME_DESIGN.md` — the design: core loop, condition/room/staff rosters, **Flow & edge rules 1–14** (canonical answers to every lifecycle edge case), balance defaults, roadmap.
- `docs/TECH_PLAN.md` — the architecture: sim/render split, §3.1 SSOT rules, §2.6 art contract, milestones M0–M4 with per-milestone test lists, risk table.

Both were hardened by independent adversarial reviews before any code was written, and every milestone since has been reviewed the same way.

## Where things stand

| Commit | Contents |
|---|---|
| *(departments 1)* | **Departments epic Stage 1 — respiratory therapy retired, its care moved to the bedside** (`docs/DEPARTMENTS_PLAN.md` §3). Owner ask: *"if patients are really not seen there, then we do not need the room, the respiratory therapists would need to go to the areas they are needed in the exam rooms, ER, etc."* Asthma's Nebulizer (45 min) and pneumonia's Respiratory Therapy (60 min) move `resp` → `exam`, `roles` unchanged so the THERAPIST stays the binding resource; `respTherapist` joins `exam.staffedBy` (audited: display-only, no third-role assumption exists anywhere). **`resp` is RETIRED, not deleted** — `RoomType` derives from `ROOM_DEFS` and `save.ts` validates against `ROOM_TYPES`, so deleting it would refuse every LIVE save holding one, and the game auto-deploys. `RETIRED_ROOMS` + `roomRetired()` live in `sim/data/rooms.ts` (hard rule 1 — the pre-impl review caught that the plan's own suggested mechanism, removing a `CATEGORY_LABELS` key, is keyed by CATEGORY and would have deleted exam/er/dialysis/surgery from the bar and not compiled); `buildRoom` stays PERMISSIVE because two save/maintenance fixtures build `resp` through the command path. **THE HEADLINE CORRECTION IS IN §3.0: the research does NOT support retiring the room, and the plan says so.** AARC's document is a STAFFING methodology, so "contains no spatial capacity unit" is a fact about that document, not about architecture — absence of evidence run against a source never about space; the reviewer also named a counterexample the first research pass never sought (pulmonary function testing IS room-based). The research supports the ROUTING change at 3-0; retirement is an owner design decision taken with that gap in full view, recorded as such. **Measured, 2 arms** (§3.8): capacity-neutral (the harness `resp` slot became a THIRD EXAM ROOM) is a wash — discharges 120.6 → 120.2, deaths 3.6 → 3.4; but the **no-rebuild arm shows real ROOM-capture — doctor-blocked-in-exam 27t → 564t (20×)**, 3 fewer discharges and pneumonia deaths 2 → 5. A player who never rebuilds pays for this change. The deleted **$5,000 capex gate** (serving 16.9% of arrival weight now needs no room, just a $200/day hire) did NOT show as a windfall in 5 days — recorded as an unmeasured risk, since capex is one-time and the probe horizon is too short. Live-save handling: retired rooms keep their historical income display (`roomEarns` = `CONDITION_DEFS ∪ RETIRED_ROOMS`, still derived), refund at **FULL price clamped to the flat build cost** (an unclamped refund on a legacy 5×5 would have paid $13,896 on a $5,000 purchase), announce themselves once per session at boot, and are skipped by the broken-room hint, the maintenance-need count AND repair-job assignment (a tech was otherwise crossing the hospital to fix a room that can never treat anyone while the UI reported nothing broken). **`loadWorld` deliberately does NOT sanitise retired rooms** — an earlier draft did and broke save→load→save byte-identity; the needs-scan skip is therefore the ONLY defence and says so at the site. `data.test.ts`'s room-usage guard was AMENDED (`used \|\| EXEMPT \|\| RETIRED`) plus an inverse guard, deliberately NOT by filing `resp` under the infrastructure exempt list, which would have mislabelled it and permanently disarmed the guard. Reviews: 2 pre-impl (10 MAJOR — incl. the unimplementable retire mechanism, a red data-integrity test the plan never mentioned, balance measured with the wrong denominator, and a harness that could not see this stage's likeliest failure) + 1 post-impl (3 MAJOR — a comment citing a function that was deliberately never written, and two §3.6 remedies that had silently not shipped). The asthma/pneumonia discharge floor landed as its OWN PRIOR COMMIT proven green on the old routing (`8d2ad3d`) — a regression of record that ships with the change it guards has never been observed failing. No SAVE_VERSION bump: traced in both directions (an older build bills `reservation.roomId` and never re-derives from `step.room`). 5 net-new tests (652 total) |
| *(ED stage B1)* | **Emergency Department epic Stage B1 — ratio staffing, denser bays, close-to-expand (SAVE_VERSION 10)**, built from the twice-pre-reviewed `docs/ED_IMPL_PLAN.md`. **THE HEADLINE IS THE MEASUREMENT, NOT THE MECHANIC** (`ED_PLAN` §5b, 3-arm × 5-seed probe): **the DENSITY change alone answers Stage A's death signal — deaths 4.4 → 1.0, discharged 114 → 121** (`traumaBed` 1 bed/12 tiles → 1/6, min 2, so a minimum 3×4 ER derives 2 bays; Erlang: 1 bay queues ~53 min with a 120-min stroke freezing the department, 2 bays ~9 min, 4 bays ~1 min = pressure deleted). **Ratio staffing measured NEUTRAL** (`er.staffRatio {nurse:4, doctor:4}` — Title 22's 1:4 kept; the researched 1:15 doctor number was DROPPED as inert at every buildable size). **The probe FALSIFIED the contract's own ordering decision:** v2 specified load-forward ("extend the engaged staffer first") and both pre-impl reviewers called it the payroll brake; measured, it cost **+1.8 deaths and −23% surgeries**, because a hired staffer's salary is already spent — sharing saves money at HIRE time, never at dispatch. Reversed to **IDLE-FIRST**, making the ratio *graceful degradation*: fully staffed the ED behaves exactly as pre-B1, short-staffed the extra bays run slower rather than standing empty (ED_PLAN §7.2's movable bottleneck). **The attention penalty** (`attentionSkillPenaltyPerPatient` 0.5, `formulas.attentionSkill`, DURATION only — `successChance` keeps RAW skill so deaths stay tied to health/acuity, not staffing arithmetic; `activeOnly` load so a nurse walking to bay 2 doesn't slow bay 1). Load is **DERIVED** (`reservationsOfStaff`/`staffLoadIn`, the restroom-occupancy precedent) — ratio staffing adds NO saved state; `duty` stays a single `reservationId` reinterpreted as **A** witness, not **THE** binding. `releaseReservation` gains an idempotence guard + the remaining-panel branch (re-point to an ACTIVE reservation, no idle/step-out) — that ONE branch IS the Flow-rule-7 and rule-8 fix; `fireStaff` acts on the whole panel (without it, firing a ratio nurse left reservations naming a deleted staffer and `promoteGatheredReservations` would throw). **`Room.closed` + `setRoomClosed`** (owner ask mid-stage: "an area needs to be closed down before being able to expand it because it may be so busy that people will always be in the area") reuses `breakRoom`'s disable-never-harm contract — capacity 0, gathering cancelled, actives DRAIN — closing the loop on B1's own "expand to add bays" remedy, since expand/sell both reject while any reservation is live. `tryPlaceStripAt` now requires EVERY capacity-slot strip to keep a walkable orthogonal neighbour (found during implementation: at 1 bed/6 tiles placement packed beds into solid rows leaving inner bays nobody could stand beside; scoped to STAFFED rooms — in a restroom you occupy the stall, and imposing it there would have rewritten restroom layouts and broken a Stage-3 regression of record). Save border closes the **one-directional duty↔reservation gap** (3 new rules: witness validity, total coverage, ratio bound + one-room), reasoned safe for v9-and-older because pre-v10 dispatch required `duty.kind === 'idle'` so no old save can have a staffer in two reservations. Reviews: 2 pre-impl (code/contract 6 MAJOR incl. two UNIMPLEMENTABLE sections + a phantom `needs.ts` audit naming code that does not exist; design/balance 4 MAJOR incl. the payroll brake being exactly $0 for bays 2–4) → owner ratified the ratio numbers + the movable-bottleneck goal → post-impl (3 MAJOR: an unreopenable closed+broken room, a 135s zero-assertion probe in the default gate, 2 missing contract tests; all fixed, probe now `ED_PROBE=1`-gated so the suite runs 11s not 133s). **OPEN, recorded not buried (`ED_PLAN` §5b item 5): the ED out-competes the rest of the hospital for nurses — surgeries 11.2 → 7.2 (−36%)**, because a ratio staffer never returns to `idle` while `assignTriage`/`assignJobsForRole` gate on idleness. Harness per-condition floor still passes. Three candidate remedies scoped, none implemented — each needs its own measurement pass. 59 net-new tests |
| *(ED stage A)* | **Emergency Department epic Stage A — route the real ED cases through the ER** (`docs/ED_PLAN.md`). Owner: "why is the ER not that busy? most hospitals' ERs are one of the busiest departments." DIAGNOSED BY MEASUREMENT, not assumption (a 5-day reference run instrumented with the finances epic's `visitsTotal`): only 3 of 14 conditions routed to the ER = **12.8%** of arrival weight, and TWO of those three were gated behind a CT scan first (2 rad techs serve 4 scanner rooms), so only chest pain arrived directly. Exam saw 76 visits to the ER's 13. Root cause is a MODELLING choice, not a bug — the ER was a specialty room while a real ED is the hospital's front door. Stage A's principle: **change the ROOM of existing steps, never lengthen chains** (realism with no added contention). Laceration sutures, fracture casting and kidney-stone pain control move exam → er; `roles` unchanged and still a subset of `er.staffedBy`. **Measured, 5 seeds × 5 days: ER visits 15.6 → 39.6 avg (now the busiest department), exam 74 → 37, ER-routed weight 12.8% → 41.9%.** Honest cost, recorded not buried: throughput −9%, deaths 2.8 → 4.2 avg (one seed tripled to 10), walkouts 47.6 → 37.0 — patients give up less and die slightly more, the signature of a CAPACITY bottleneck (the reference ER is 3×4 = ONE trauma bed now absorbing 40% of arrivals). Harness envelope still green. ED_PLAN §5 owns the fix and recommends denser beds as part of Stage B. Stages B (ambulance arrivals + ED entrance/waiting/triage — the owner's ask) and C (ungate the CT dependency: ER → CT → ER) are DRAFTED, awaiting pre-impl review. 3 test fixtures updated (they built exam rooms for flows that now need an ER) |
| *(anesthesia)* | **The anesthesiologist role — a three-role OR (SAVE_VERSION 9)**: owner ask "the game actually needs to model anesthesiology". `ROLE_DEFS.anesthesiologist` ($420/day — between nurse and surgeon, the brake on over-hiring; crimson `0xc1121f`, clear of the teal/green clinical cluster and colour-checked in frame against the one standing red object, the vending machine) joins `surgery.staffedBy` AND both surgery steps (gallstones, appendicitis — the only two). **THE finding, from the pre-impl review (MAJOR 2): the new role has NO competing demand, so it does not make the gather harder in the way the plan assumed — the binding constraint remains the NURSE (7 condition steps + triage, and `assignTriage` runs BEFORE `assignTreatment` and drains idle nurses unconditionally). v1's compensation was therefore calibrated against a largely illusory cost.** What earned the milestone is **§4 lever 4, the partial-gather soft hold** (review MAJOR 3): a failed gather used to hand its partially-secured staff to a LOWER-priority patient later in the SAME dispatch pass — surgery grabs surgeon+nurse, misses the third role, gives up, and the nurse goes to a walk-in; next tick the third role is free and the nurse is gone. Now the top-priority patient's secured staff are held for the rest of the pass (a local `Set`, discarded at pass end — nothing committed, no new state, no save impact, all-or-nothing untouched). **Verified non-vacuous: with the hold reverted the regression test fails, with it restored it passes.** Balance: surgeries shorter + dearer (gallstones 120→90 min / $1,500→$2,000; appendicitis 100→80 / $1,800→$2,300) to fund the third salary; harness `STANDARD_STAFF` gains the role (review MAJOR 1 — a ROSTER change, not a re-pin: without it both surgical conditions discharge ZERO for every seed). SAVE_VERSION 9 (review MINOR — the bump is for the OTHER direction: an older DEPLOYED build opening a new save would die on an unknown role instead of refusing cleanly; `topUpCandidates` already handles loading old saves). Backward fixtures v1/v4/v5/v6 now filter post-version roles BY NAME with a shared `expectPoolLacks` premise (review MAJOR 4 — the old `ROLE_IDS.length - N` arithmetic stayed true as the roster grew, so each new role silently left them holding candidates that version could never have had, hollowing out the guard for the v1→v2 unhirable-surgeon bug). Hints name the role with NO code change (`needs.ts` iterates `step.roles`) — asserted, not assumed. **The re-pin sweep the plan feared did not materialize: only 2 tests needed changes, both semantic, because the fixed-seed suites assert properties rather than brittle rng values.** 10 net-new tests (585 total) |
| *(finances polish)* | **Finances polish pass (SAVE_VERSION 8)** — the owner's "fix them all" sweep over the leftovers the two reviews had ranked as NIT/MINOR. **The one that matters: `Sold rooms (no longer owned)`** — the Departments block summed only rooms we CURRENTLY own, so income earned in a room since sold vanished from the ledger with nothing to explain the shortfall against `Patient fees`; the new row is `lifetime.revenue − Σ owned − Σ vending` (derived, zero new state, `max(0)` defensive) and makes the block reconcile exactly. **SAVE_VERSION 8**: `amenity.revenueToday`, the per-DAY partner of v7's `revenueTotal` — a machine had no per-day figure ANYWHERE, which is why the directory column and the modal's Amenities row sat blank while it was visibly taking money; reset in the SAME `closeDay` step as rooms (one "earned today" epoch), pairwise-bounded at the border like rooms, read-time default 0 on v7 (the honest value — the running day's takings are unknowable after the fact). Payroll moved OUT of the column grid into a bordered `.finance-footer` with a "lifetime · staff serve the whole hospital" note (under a column header its figure read as that column's kind of number — first a patient count, then negative income for a department that doesn't exist). Persistent styled scrollbar on `.finance-body` (Chromium's overlay scrollbars left no track, so a half-clipped row was doing all the affordance work); graph plot inset 62px so the labels sit BESIDE the chart instead of the first data point sharing a corner with its own label; directory shows vending's earned-today. 6 net-new tests (575 total). **Deliberately NOT done** (owner told, not silently skipped): per-room running costs — a game-wide balance change, now scoped as its own milestone in Next. |
| *(finances)* | **The FINANCES epic — RCT-style finances window + departmental P&L (SAVE_VERSION 7)**: built straight from the twice-pre-reviewed `docs/FINANCE_PLAN.md` v3. `data/finance.ts` = the category SSOT (`FINANCE_CATEGORIES`, `CashTallyKey`, `CashTotals`, `NON_CASH_TALLY_KEYS` + its partition-guard test) driving the grid, the daily report's Money section AND `netFromCategories` (`dayNet` delegates — the fold is the net derivation); 5 new pure derivations (`roomEarns` DERIVED from CONDITION_DEFS not a flag, `hospitalValue`, `departmentCapital`, `netFromCategories`, `averageBillPerPatient` with the `lifetimeTreatedBase` watermark); `tallyCash` = THE increment (today AND lifetime, one call — every `today.<cashKey> +=` migrated); `billFee(amount, label, {source, roomId})` attributes per-room income at the ONE billing choke point (`revenueToday`/`revenueTotal`/`visitsTotal` = treatment STEPS, hence "Patients seen"); per-machine vending revenue; the extended FROZEN 6-step `closeDay` (history push as a COPY + trim, `revenueToday` resets, ALL before the emit so the autosave never persists phantom earnings); SAVE_VERSION 7 (room/amenity counters, `world.lifetime`/`lifetimeTreatedBase`/`history`; `writeDayReport`→`writeTally`, `readDayReport`→the VERSION-AWARE `readTally`; history TRIMMED on load never rejected — a tunable must not brick saves; v6 fixture-load pins the watermark). UI: the pausing **Finances modal** (`ui/finance.ts` — grid × 7 shown/30 stored days + Today + Total, summary with hospital value + average bill, inline-SVG cash graph, departmental ledger closed by `Payroll (not allocated, lifetime)`) with `allowResumeToPaused` so a deliberately paused game STAYS paused; per-room Income on the inspect card + per-machine vending; directory earned column + subtotals (keyed on RENDERED money strings). **First save bump with NO new role ⇒ NO fixed-seed re-pin — harness seed 1338 green and asserted non-vacuously.** Reviews: code/contract (**0 MAJOR** — save layer, closeDay, attribution, determinism and the `formulas`↔`dailyStats` cycle all verified clean; 4 MINOR + NITs fixed) + live-drive (**DO NOT COMMIT → 2 MAJOR, both visual and both in the modal nobody had yet seen: the graph's scale labels laid out horizontally so a RISING week read as falling; and the card overflowing 80vh with Continue below the fold, no scrollbar and no Esc = a paused game with no visible exit** — fixed via vertically-anchored labels and a scrolling body with Continue pinned outside it; plus the departments block silently excluding amenities). 65 net-new tests (568 total) |
| *(amenities 3)* | **Amenities epic Stage 3 — failures & maintenance (SAVE_VERSION 6, EPIC COMPLETE)**: `RoomDef.failure` (mechanical: xray/ct/mri/nucMed/surgery/resp; piping: restroom/dialysis; ultrasound excluded — a cart) + `Room.wear`/`brokenSince` (the tick doubles as the instance-keyed hint — design MINOR 8); `applyRoomUse` = THE wear choke point (updateTreatment after BOTH branches incl. the missing-patient early-return; restroom completions in patientNeeds; no-op while broken ⇒ border pins broken ⇒ wear 0), rolling `formulas.breakdownChance` (wearFactor × wear, clamped); `breakRoom` = THE breakdown path (flag → rule-8 cancel of gatherings hint-free, actives finish → guaranteed repair mint on a STRUCTURALLY WORKABLE anchor (pre-impl MAJOR 1: the 2×3 west-door restroom's stalls are all door/stall/through-wall-neighbored) → piping burst (2–4 water messes, in-room + adjacent corridor only, pre-messed/job-held tiles excluded) → roomBroken + roomChanged); `capacityOf` = 0 while broken (one line gates ALL dispatch + stall claims; the reservation-slot border stays grid-derived so actives round-trip); repair jobs ride the FROZEN Stage-2 loop via a per-role kind map (evs: clean/empty; maintenance: repair); `addMess` re-anchors a repair job off a mess tile (post-impl MAJOR: walkable anchors + patients-drop-messes-at-their-feet = a suppressed clean mint = a save that refuses to load); sellRoom's orphan sweep extends to roomId-targeted jobs; expand rejected while broken; `debugBreakRoom` (real-path debug, challenge-dropped); SAVE_VERSION 6 (readRoom/readJob version params; repair legal from v6 with roomId⇔broken⇔exactly-one both-ways border; kind-aware ticks bound; v5 fixture-LOAD conversion) + the round-trip gate pins wear>0 + queued/working repairs + burst water at ONE tick; hints `broken:<id>:<since>` + `role:maintenance`; inspect OUT OF SERVICE pending/underway + phase-aware duty labels ("Heading to a repair"); greyed floors + hazard decals (in roomVisuals — leak-free); ROLE_DEFS.maintenance (orange, re-pin audit run — seed 1338 SURVIVED via the balance pass). PLUS the restroom-watchdog balance fix (OWNER DECISIONS 3). Reviews: code/contract 1 MAJOR/2 MINOR/2 NIT (all fixed); live-drive COMMIT 0 MAJOR 9/9 PASS. 58 net-new tests (497 total) |
| *(amenities 2)* | **Amenities epic Stage 2 — EVS, messes & cleanliness (SAVE_VERSION 5)**: `world.messes` (vomit: per-tick Bernoulli over the frozen stage set at sub-critical health; litter: vending-use drops unless a non-full trashcan within Chebyshev radius absorbs — overflow at fill 8 mints the `empty` job FIRST then the overflow mess, no clean-job double-mint; accidents drop messes too) + `world.jobs` (the facility job queue — `Job` + the new `{kind:'job'}` StaffDuty; the FROZEN assignJobs loop: oldest = lowest id, held jobs skipped never blocking, per-job retry holds; work-tile derivation guarded by **`world.canApproach`** — the code-review MAJOR: Manhattan adjacency holds THROUGH edge-walls, so an in-room mess with a claimed tile was previously "worked" from the corridor; completion orders frozen non-reentrantly; fire/stall/orphan analogues of rules 7/8; workers step out of walled rooms unconditionally) + `ROLE_DEFS.evs` (landed WITH the fixed-seed re-pins — a new role's constructor candidates shift every seeded stream) + cleanliness (proximity ×1.25 once via revision-cached `hasMessNear`; `cleanlinessRepDelta(messTicks, arrivals)` at closeDay beside the wait bonus — clean-day +2 gated on arrivals>0, flagged design delta) + geometry sweeps (build/expand/sell/placeAmenity delete messes+jobs; sellAmenity takes the overflow mess WITH the can) + SAVE_VERSION 5 (messes/jobs after amenities — frozen positions; border: job↔target both ways, every-mess-has-a-job, working-worker adjacency, fill ≤ capacity, repair rejected/water accepted) + decals in a new `decalLayer` (per-change, tile-hashed variety; prop-tile decals spill toward the front edge — live-drive MINOR) + `role:evs` hint row + report Cleanliness row + duty labels. Reviews: code/contract 1 MAJOR/1 MINOR/2 NIT (all fixed, `canApproach` + border bounds + SSOT move); live-drive **COMMIT, 0 MAJOR, 12/12 PASS** (v4-compat proven on a real production save; 3 visual MINORs fixed). 62 net-new tests (439 total) |
| *(amenities 1)* | **Amenities epic Stage 1 — needs, restroom, freestanding amenities (SAVE_VERSION 4)**: bladder+thirst meters (decay.ts, spawn rng-rolled 60–100) with the ×1.25-per-unmet patience multiplier; `needBreak` side-trips (`systems/patientNeeds.ts` — the `lost`-precedent sub-state: trigger gates incl. findPath reachability + failed-claim retry hold, frozen walking→using flip with stalled-arrival abandon, watchdog, accident-mid-break clear; dispatcher skips on-break patients); restroom room (2×3, stalls = Stage-A capacity, occupancy DERIVED from claims — never reservations); freestanding `AMENITY_DEFS` props via `placeAmenity`/`sellAmenity` (blocked-tile BFS + entrance rejection + at/next actor checks + `recomputePaths`; amenities are ALWAYS non-walkable — the room-build 'Blocked by an object' rejection depends on it); vending $5/use through `billFee` with `source: 'vending'` (checklist ignores it — live-drive MAJOR); plant Chebyshev comfort aura (deliberately ≠ Euclidean room auras); SAVE_VERSION 4 (readPatient version param, version-aware readTally, amenities after rooms, border: claim exclusivity + both-ways amenity↔grid + bounded use timers); restroom expand/sell gate 'Occupied' on live claims (walking counts). Reviews: code/contract (1 MAJOR: vending stand tile inside walled rooms — stand pick + flip now require the standing-zone rule; 2 MINOR: same-tick vending fallback when the restroom is full, Chebyshev comment) + live-drive (2 MAJOR: vending completing "Treat your first patient", blocked-panel unbounded growth click-blocking the inspect card — row cap 8 + "+N more" + CSS max-height; PASS on all 13 checklist items, zero console errors). 70 new tests (377 total) |
| `3c2f3bd` | M0 (scaffold, iso world, loop) + M1 (rooms, A*, walking) + fixes from two code reviews |
| `f6ecf05` | M2 (playable vertical slice) + fixes from the M2 review (12 findings) |
| `d4567a3` | Placeholder-plus characters + V1 collision model (Flow rule 14) |
| `8ede235` | M3 gate: two adversarial pre-M3 reviews (code gaps + plan gaps): 11 code fixes with 12 regression tests, and 19 plan rulings written into the GDD/tech plan (look for "M3-gate ruling" / "M3 ruling" markers) |
| `16ade07` | Full V1 roster: 6 conditions with weighted spawn mix + rep case-mix shift, multi-step + dual-staff paths, room props, atrium/greeter/aura grid, complete wayfinding system, comfort auras, inspection panels, click-to-jump toasts, aura overlay, thought log, A* per-walker path variety + fixes from the M3 adversarial review (3 major, 5 minor) |
| `7e27b63` | `/run-hospital-simms` skill: headless browser driver (playwright-core + system Edge) for driving the live game |
| `12e6aef` | M4 feel & finish: daily report modal + per-day tally (`src/sim/dailyStats.ts`), day-close wait bonus, bankruptcy lose-state + game-over screen, title screen + `?seed=` new-game flow, first-run checklist, keyboard shortcuts (Space/1/2/3), hover cursors, headless balance harness + balance pass (arrivals 3.0→1.5/h, wait-bonus threshold 120→240m), `debugSetCash` + fixes from the M4 adversarial review (2 major, 3 minor, 4 nit) |
| *(audit)* | Full-codebase audit (owner-requested, 14 findings fixed): triage lost-timeout strand bug (MAJOR), stage-transition guard table (`setPatientStage` + `stageViolations`), EventBus handler isolation + rAF-chain protection, Pixi-init failure screen, GDD §5 waiting-room-quality patience decay implemented, shared `ui/dom.ts`·`ui/modal.ts`·renderer `pickAt`, `BALANCE.stats` scale SSOT, debug-command payload guards, entrance-overflow standing spots, tech-plan drift corrections + `docs/PERSISTENCE_PLAN.md` |
| *(save/load)* | Persistence Phase 1 (plan §1): `SeededRng.getState/setState`, explicit per-entity serializers + grid RLE in `src/sim/save.ts` (`serializeWorld`/`saveToString`/`loadWorld`), border validation of shape AND referential integrity, localStorage slots (3 manual + midnight autosave) + file export/import (`src/ui/saveStore.ts`, `src/ui/saveLoad.ts`), `?load=<slot>` boot path, title Continue/Load/Import + fixes from the save/load adversarial review (2 major, 6 minor, 2 nit) |
| *(expansion 1)* | V1 DoD sweep (SSOT audit clean of majors; perf PASS 60fps @110 patients; hostile QA playthrough: zero game errors) + GDD §12 Expansion 1: ultrasound/CT/MRI/nucMed/dialysis/surgery, sonographer+surgeon, 8 conditions (imaging→consult chains, imaging→OR dual-staff, dialysis, CT→ER), `SAVE_VERSION` 2 with v1 loadable (candidate-pool top-up migration), §9 bottom-bar category dropdowns (mutually exclusive), aura-overlay render caching, staff-age fix, checklist load-seeding + fixes from two parallel adversarial reviews (1 major, 5 minor, ~10 nit) |
| *(art pass)* | Procedural art upgrade (still 100% runtime-generated, deterministic — no asset pipeline): `sprites.ts` split into `sprites/{shared,characters}.ts` + barrel; **4 diagonal facings** (§2.6 — `characterKey` gains a facing arg, `facingFromStep` in shared.ts; faces on SE/SW, backs on NE/NW, mirror baked at gen-time so `scale.x` stays 1) with facing-aware torso details; readable walk cycle; all 8 roles visually distinct; soft-shaded ground/floors/walls (top-cap + baseboard + translucent near-walls) and prop decor (pillow/backrest/monitor/panel/basin); chair color nudged for contrast + fixes from two parallel art reviews (code/contract + live-drive visual: 0 major/minor, ~3 nit) |
| *(stage B)* | **Capacity epic Stage B — the expand tool (EPIC COMPLETE)**: select a room → Expand (inspect panel) → hover previews the superset rect toward the cursor (`growExpandRect`, pure+tested; no ghost while the cursor is inside — nothing to buy) with a live "+$N" price (`expandPrice` = the Stage-0 curve, no build-vs-grow arbitrage) → click buys via the `expandRoom` command (sim re-validates; challenge-mode legal). `validateRoomExpand` (build.ts, shared `reachabilityWithWalls` extracted from validateRoomBuild): strict superset, delta tiles clear (rooms/props/actors/entrance/others' doors), **door-orphan reject iff newRect contains door.outside**, RESERVATION-free but seated occupants allowed, **post-expansion interior-connectivity BFS (review MAJOR 2: an ultrasound's bed seals its top row — growing north pocketed the delta behind it, grinding reservations forever)**. `world.expandRoom`: rect→tiles→ADDITIVE prop top-up (existing prop tiles byte-preserved; `tryPlaceStripAt` now REFUSES tiles under a person — **review MAJOR 1: the top-up entombed walkers inside machines**)→quality→`roomChanged` (renderer full-room redraw, per-change)→recomputePaths. Atriums expandable: the aura signature now includes each rect (design MAJOR 5 closed). Known symmetric quirk (deliberate): a walker whose TARGET is swallowed re-paths through the door — same as builds. 15 expand tests incl. both MAJOR regressions. Live-driven: build→expand 3×4→4×4 "+$3,000"→inspect Size 4×4/Quality +4/Sell +$6,000 |
| *(stage A)* | **Capacity epic Stage A — multi-slot room capacity** (CAPACITY_PLAN §3, all ratified): props ARE the capacity. `PropSpec.count` → `PropSpec.density` (fixed \| perTiles; min-size rooms derive EXACTLY pre-epic counts — harness-safe by construction) + `CapacityRule` on every RoomDef (multi-slot roster: Waiting seats=chairs 1/1.5 tiles · ER beds 1/12 · Dialysis machines 1/6 min 2 — the RATIFIED 1→2 retro jump; rest `single`). World: `slotOrigins` (row-major strip consumption — provably parses end-to-end strip runs since strips place atomically), `capacityOf`/`openSlots`/`freeSlotIndex` (loud on misuse)/`reservationsOn`, `slotAnchorTile` (bedside anchoring, unclaimed-first, falls THROUGH to freeInteriorTile when all bedside tiles claimed — rule 14). Dispatcher: `roomBusy` → `hasOpenSlot`; each reservation claims a STABLE `slotIndex` + its own staff (payroll is the capacity brake). `SAVE_VERSION` 3: `Reservation.slotIndex` serialized; pre-v3 defaults 0 (correct — legacy rooms held ≤1); border validates slot ≥0, < grid-derived capacity (deliberately stricter floor formula — see comment), exclusive per room. Waiting seats read `capacityOf`, not the old constant 6. Inspect: "Machines 0/2"-style capacity line + Treating LIST. Renderer: strip slices classify by RUN OFFSET (review MINOR: end-to-end bed strips — the default grown-ER layout — mis-sliced with the old neighbor check). THE save gate scenario now pins a concurrent (slot>0) reservation at the save tick. Reviewed (0 MAJOR, 4 MINOR, 3 NIT — all fixed; 19 capacity tests + gate extension). Live-verified: "Seats 5/6", dialysis "Machines 0/2" |
| *(stage 0)* | **Capacity epic Stage 0 — the size-based economy** (CAPACITY_PLAN §4.1, owner ruling "size affects cost"): `formulas.priceOf(type, rect) = cost + ceil(cost/minArea)×extraTiles` (derived — zero new balance numbers; area-based, so rotated rects price identically), `perTileRate`, rect-aware `sellbackAmount(type, rect)` (same formula → no fresh-run arbitrage by construction; pre-epic oversized rooms keep the accepted one-time refund quirk), `roomQuality(type, rect)` moved out of `buildRoom` (Stage-B second caller). `buildRoom` charges + tallies the SIZED price; `validateRoomRect` prices the actual rect (ghost turns red when the drag outgrows cash); live hint readout "Operating Room 4×4 — $20,000 · click to place, drag to grow". **`render/hintLine.ts`** arbitrates the shared hint line (review MAJOR: the re-seeded ghost's re-price clobbered rejection reasons one frame later; an error now owns the line until the ghost geometry CHANGES — keyed on position+dims, not display text, because the same-size string repeats across tiles — that second bug was caught by the live drive after the unit tests passed). Catalog label stays the min-size price by design. 18 new tests (pricing 13 + hintLine 6, minus 1 superseded). Reviewed (1 MAJOR + 1 MINOR + 3 NIT — all fixed) |
| *(build ux)* | **Hybrid placement + affordability tint** (owner rulings): (1) armed build tool previews the room at its DEFAULT (min) size under the cursor — ONE click stamps it, hold-drag grows it, never below a VALID minimum in EITHER orientation (`src/render/placement.ts`: pure `minRectAt`/`growRect`, orientation follows the drag — review MAJOR: a canonical-only clamp made sim-legal rotated footprints like a 3×2 Reception unreachable; 9 tests incl. every-type×every-direction sim-validity sweep). Mode hint updated ("Click to place — hold and drag to grow"). NOTE: an atrium (open-plan, no door step) now builds on a single click — deliberate per the ruling, flagged to owner. (2) Build-menu prices tint red when cost > cash (`cashChanged`-live; entries stay clickable so you can plan; sim placement validation stays the hard gate). Perf: `drawGhost` is input-keyed (`lastGhostKey` incl. clock tick — validity reads live actors/cash) so validators run ≤10/s not 60fps; the atrium aura-preview's dead hover leg removed and its overlay key reworked (drag|hover discriminator carries the tint alpha). Expand-EXISTING-rooms = owner-approved backlog (sell+rebuild until then) |
| *(ui polish)* | **Room-staffing visibility + alphabetized lists** (owner: "no way to hire a dialysis staff member" — dialysis is run by a Nurse, but no UI surface showed `staffedBy`): build-menu room entries gain a dim role list ("Dialysis · Nurse · 3×4 · $9,000"; neutral ', ' separator — surgery needs both roles at once, exam either-or); room inspect gains a 'Run by' line and its misleading permanent "Staffed by —" is now a 'Posted' line rendered only for standing-post rooms (reception/atrium), with the staff scan gated behind it. Alphabetized (presentation-only, `localeCompare(…, 'en')` pinned — bare collation is host-locale-dependent): rooms within each build category, hire-panel role groups + candidates + roster (role, then name), debug spawn list. `vitest testTimeout: 30s` (harness multi-day sims flaked at the 5s default under machine load; verified 3× stable). Reviewed (1 review: 2 MINOR + 3 NIT, all fixed) |
| *(hints)* | **Hints milestone** (`docs/HINTS_PLAN.md`, owner-requested): ONE pure derivation `computeBlockedNeeds` (`src/sim/needs.ts` — check-in/triage/full-chain look-ahead over pre-terminal patients, `leaving`/`dead` excluded, firing-counts-as-hired, urgency + patient counts + condition reasons, total deterministic sort, a/an `article()` shared with the checklist) feeding two consumers: (1) `emitUrgentNeedHints` at the end of `updateDispatcher` — REPLACES the four inline Flow-rule-5 hints; toasts are **urgent-only** (`need:*` hintOnce keys; legacy `cond:*` keys inert), (2) the persistent `#blocked` "Needs attention" panel (`src/ui/blockedPanel.ts`) in the new `#leftstack` column under the checklist — urgent rows plain, upcoming rows "soon:"-dimmed, recompute on tick change OR roster/room event (commands apply while paused), DOM rebuilt only on real change. The needs pipeline mutates NOTHING but `hintedOnce` (save-gate invariant). Built via plan → pre-impl review (3 MAJOR: terminal-filter rationale, missing condition context, phantom key-pinning tests) → implement → live-drive → adversarial review (3 MINOR fixed + tests: vacuous firing test, coercing sort assert, paused-build staleness). 18 needs tests + 3 panel DOM tests |
| *(Phase 2 fixes)* | **Round-5 post-commit review follow-up** (a fifth adversarial pass over `9cf62a5`, hunting fix-regressions): MAJOR — `startNewGame` never scrubbed `challenge`/`goal`, so New Game from a challenge game-over re-booted the SAME challenge; fixed via `clearBootParams` (grammar SSOT in `challenge.ts`) + regression test. MINORs: challenge runs no longer clobber the sandbox autosave (`installAutosave` inert when `world.challengeMode`); the goal-day-midnight bankruptcy tie-break (bank forecloses first → DNF) documented in CHALLENGES_PLAN §5 + pinned by test; the vacuous close-bonus assertion replaced with a real one (bonus provably awarded, score === preClose + bonus). NIT: dropped the misleading `% SEED_MAX` clamp (roster test is the guard). 227 tests |
| *(Phase 2)* | **Seed challenges** (docs/CHALLENGES_PLAN + CHALLENGES_IMPL_PLAN): shareable `?challenge=<id>` (4 built-ins) + ad-hoc `?seed=N&goal=<metric>:<day>` deterministic runs scored at a day-N close. Track 1 sim: `data/challenges.ts` (SSOT `SCORE_METRICS`/`CHALLENGE_DEFS` + all challenge types), pure `challenge.ts` (`resolveBoot`/parse/`SEED_MAX`/`challengeToQuery`), `formulas.scoreChallenge`, `world.challengeMode` debug-gate, `events.challengeComplete`. Track 2 UI: `challengeController` (two terminals + once-latch), `MidnightModalCoordinator` (single `dayEnded` owner → daily report XOR result card), `challengeResultCard` + shared `appendChallengeResult`/share-line, `PausingOverlay` base (clock-ownership DRY), title Challenges roster, DNF folds into game-over. Debug affordances hidden in challenge mode (panel + build-bar spawn button). 46 new tests (`happy-dom` added for UI-DOM). Built via full workflow: freeze → 2 per-track adversarial reviews (Track-1 MAJOR: `in`→`Object.hasOwn` prototype-chain guard) → integration live-drive (caught the inert spawn button) → 2 final reviews (loop catch-up halts on pause; `gameOver` day off-by-one) → gates green |

**The game is playable end-to-end:** `npm run dev` → localhost:5173 shows the title screen (New Game / Continue / Load Game / Import when saves exist); New Game navigates to `?seed=<random>`, `?load=<slot>` boots a save (a bare `?seed=1337` boots deterministically, which the `/run-hospital-simms` driver skill relies on). All **14 conditions** arrive on a reputation-shifted weighted mix across **14 room types** (build bar: Basics · Imaging · Treatment · Comfort category dropdowns, mutually exclusive with the hire panel and thought log) and **8 staff roles**. M4 systems all live: pausing daily-report modal at midnight, bankruptcy lose-state (below −$10k a full day → foreclosure → New Game), first-run checklist (seeds from a loaded world), Space/1/2/3 shortcuts (modal-suppressed), staged Esc peel (dropdown → build mode → selection). Save/load: 3 localStorage slots + midnight autosave + file export/import; `SAVE_VERSION` 2, v1 loadable. **178 Vitest tests, lint and build green.** V1 DoD all passed (2026-07-17): SSOT grep audit, 60fps @ 110 patients + 20 staff (measured ~97% frame headroom), hostile QA playthrough with zero game-originated console errors.

## Architecture in five sentences

1. `src/sim/` is a pure-TS, deterministic, fixed-timestep (10 tps) simulation — no Pixi, no DOM, fully unit-testable; `World.tick()` runs systems in order: spawn → decay → thoughts → dispatcher → wayfinding → movement → treatment → economy (wrong-turn rolls fire inside movement, per tile stepped; wayfinding runs before movement so wander steps and recoveries apply the same tick).
2. `src/loop.ts` owns speed/pause (NOT the sim) and drains the CommandQueue every frame even at speed 0 ("build while paused"); it has an injectable `LoopHost` so tests can hand-crank frames.
3. `src/render/` (PixiJS v8) is a projection: iso projection math only in `iso.ts`, all textures runtime-generated in `sprites.ts` behind a lookup contract an atlas will later satisfy, actors synced by diffing world maps each frame.
4. `src/ui/` is DOM overlay (`data-ui` attribute guards input routing); it reads World directly or reacts to events, never caches authoritative state.
5. Rooms use **edge walls** (footprint tiles stay walkable; walls live on boundary edges, crossed only at the door; open-plan rooms like the atrium have no walls) — this is load-bearing for pathfinding, validation, and rendering.

## Invariants the reviews established (do not regress)

- **Flow rule 7:** any terminal patient event (death/AMA/discharge) releases everything they hold — queue slot, seat, reservation (room + staff) — from ANY stage.
- **Flow rule 8:** a reservation participant who stops without reaching the room ⇒ `cancelReservation` (release + re-queue + hint toast). Never a silent stall; `promoteGatheredReservations` checks this every tick.
- **Build validation** (`src/sim/build.ts`): bounds/size/overlap/cash, no actors (patients AND staff) on footprint, door must open onto corridor **or open-plan tile**, entrance-reachability BFS for the new door + every existing door + every person's standing tile (no trapping).
- **Sell validation:** room must be unreserved and empty of people; selling a waiting room re-seats its waiters.
- **Check-in desk works only while a receptionist is posted and arrived** — mid-check-in staffing loss reverts the patient to the desk slot.
- **`treatmentDurationTicks` has a quality floor** (0.7×) — without it, oversized flat-cost rooms are an infinite-throughput exploit.
- **Spawn is per-tick Bernoulli** (`rate/ticksPerHour`) — exact expected rate. An accumulator+jitter scheme was rejected for inflating slow rates ×1.8.
- **Collision (Flow rule 14):** walkers pass through in motion; standing spots are exclusive (`isTileClaimed` in destination pickers); hard blocking is deliberately post-V1.
- **Rule-8 cancellation is a recovery, not a spin (M3 gate):** the dispatcher never reserves a room the patient can't path to (`canReachRoom`), a cancelled patient carries a `dispatchHoldUntil` retry hold, and the layout hint is `hintOnce` per patient. Regression: `test/reviewGate.test.ts`.
- **Flow rule 3 (M3 gate):** patience decays only when `walkerArrived` — purposeful walking is free. M3 lostness must count as waiting via the lost sub-state, NOT by weakening this gate.
- **Flow rule 6 (M3 gate):** the wait clock (`waitingSince`) survives every re-queue — reservations stash it in `Reservation.patientWaitingSince` and every re-queue path restores it. Only new queue classes (check-in→triage→treatment) and terminal events reset it.
- **Flow rules 4/14 (M3 gate):** overflow waiters and released staff get real standing destinations via `world.nearestFreeStandingTile` (BFS; excludes walled-room interiors, door tiles, and claimed spots). Nobody loiters on the desk slot or inside treatment rooms.
- **Check-in routing (M3 gate):** staffed receptions beat unstaffed ones; patients queued at a dead desk migrate when a staffed desk has capacity.
- **Lost walkers stay wanderers (M3 review):** `recomputePaths` and `assignWaitingSpot` skip lost patients — the retained target is a RECOVERY destination, never an active walk. Only `tryRecover` re-paths.
- **Arrival ends the walk (M3 review):** `onPatientTileStep` never rolls on the destination tile, and promotion to `active` defensively clears `lost` — treatment can never run on a lost patient (rule 3 decay would leak).
- **Aura grid is signature-cached per tick** (`auraCheckedTick`, invalidated end-of-tick and per command) — has* getters are cheap enough for the per-frame overlay; don't add per-query signature scans back.
- **Prop strip length lives ONLY in `PROP_STYLE[id].tiles`** — placement and render slicing both read it (§3.1 rule 5).
- **Day tallies increment at the same choke points that emit events** (M4): `killPatient`/`dischargePatient`/`patientLeavesAma`/`billFee`/`applyReputation` in world.ts, payroll in economy.ts, lost episodes in wayfinding.ts, first-treatment wait in the dispatcher's promotion (kind `treatment` only, `firstTreatedAtTick` once-guard — regression: `test/m4.test.ts` pipeline test). `repDelta` records the APPLIED (clamp-aware) delta.
- **`closeDay` order is load-bearing** (M4, extended by the finances epic —
  SIX steps now, and the old four-step summary understated it): wait bonus →
  cleanliness rep → report snapshotted → **`history.push({...report})` (a
  COPY — the emitted payload must never alias stored history) + trim to
  `historyCapDays`** → **every `room.revenueToday` reset** → `today` reset →
  `dayEnded` emitted. `dayEnded`'s payload is a `DayReport` (superset of the
  old `{day}`). **The resets PRECEDE the emit** so the midnight autosave
  persists a consistent new-day state (`today` zeroed ⇔ every `revenueToday`
  zeroed) — a reload must never show phantom earnings, and **no `dayEnded`
  consumer may read `room.revenueToday`** (pinned by test). The history push
  precedes the emit for the same reason: the autosave must capture the entry.
- **Bankruptcy** (M4): strictly below the threshold, sampled once per tick after all systems (intra-tick dips can't false-trigger); recovery resets the countdown; `gameOver` emits once and `tick()` becomes a no-op — commands still drain, so debug commands after game over are inert by construction.
- **A visible `.modal-overlay` owns the clock** (M4 review): keyboard speed shortcuts check for one before touching the loop; the game-over screen hides an open daily report.
- **Harness validity is mutation-checked, not assumed** (M4 review): the zero-atrium test probes reservation ages EVERY tick (a stuck reservation fails the bound even if it resolves by day end) and asserts a lost holder was actually observed; the acuity-5 test pins reputation at max for genuine overload (AMA assertion proves it). Room partitioning (one ER, X-ray throttle) means the aging *mechanism* is guarded by unit tests, not the harness — see the comment in `test/harness.test.ts` before "improving" either.
- **All patient stage writes go through `World.setPatientStage`** (audit #5): kind transitions validate against `LEGAL_STAGE_TRANSITIONS` (declared in `entities/patient.ts`), plus the semantic invariant that `waiting` requires `acuity !== null` (the audit-#1 strand-bug class). Violations are counted in `world.stageViolations` and console-warned, never thrown; the harness and audit tests assert the counter stays empty. Never assign `patient.stage` directly in sim code (test fixtures may).
- **Lost-timeout is reservation-kind-aware** (audit #1): a lost patient timing out of a TRIAGE reservation returns to `waitingTriage`, mirroring `cancelReservation`. Regression: `test/audit.test.ts`.
- **EventBus handlers are isolated** (audit #2): a throwing subscriber is caught + logged, siblings still run, and the loop schedules the next rAF *before* the frame body so no exception can sever the chain. Don't move `requestFrame` back to the end of `frame()`.
- **`BALANCE.stats` (1–5) is the scale SSOT** (audit #7) for acuity, skill, and wayfinding rolls, UI star rows, and the discharge-gain span. **Waiting-room quality slows seated patience decay** (audit #4, GDD §5): `waitingQualityMultiplier` in formulas.ts, floored like treatment duration.
- **Debug command payloads are guarded at the sim boundary** (audit #8): `debugSetCash` requires finite, `debugFastForward` clamps to 7 days — the CommandQueue is the public mutation API, so garbage must die at the border.
- **`loadWorld` never half-constructs** (save review MAJOR 1): the FULL payload — shape, then referential integrity (global id uniqueness, `nextEntityId` above every saved id, every reservation/stage/duty/queue/grid-tile reference resolves, rects in bounds) — is validated before `new World` exists; every failure is `{ok:false, reason}`, never a throw. File import is untrusted input by design (PC-to-PC). Regressions: `test/save.test.ts` border suites.
- **The round-trip gate's premises are asserted, not assumed** (save review MAJOR 2): at the save tick the scenario proves lost/queued/checking-in/at-entrance/leaving/dead patients, a firing staff member, a pending `dispatchHoldUntil`, both reservation kinds AND phases — then save→load→run-past-midnight must produce identical event logs and state. A balance change that hollows the scenario fails loudly; don't weaken the asserts.
- **The save payload string IS the contract:** slots store exactly `saveToString` output (no envelope); UI metadata (savedAt/day/cash/seed) lives in a separate meta key. Byte-identity of save→load→save is pinned by test and depends on serializer key/insertion order — don't reorder.
- **Adding a World-level mutable field requires a deliberate save decision** (plan rule 6): `SaveData` + `serializeWorld` + validate/restore in `loadWorld` + `SAVE_VERSION` bump. Entity fields are compile-enforced by the `Saved*` readers; World-level fields are NOT — the checklist is the guard.
- **Day derivation lives only in `clock.ts`** (`dayOfTick`) — the UI slot metadata uses it; never re-derive from `TICKS_PER_DAY`.
- **Render art is 100% procedural + deterministic** (art pass): `render/sprites/` generates all textures at init from Pixi Graphics — no asset files. Variety hashes entity id (`variantFor`) or tile coords, NEVER `Math.random`/`Date.now` (`performance.now` for frame dt only). `render/sprites/shared.ts` is the frozen art contract (`shade`, `Facing`, `facingFromStep`, `PROP_RISE_PAD`); `characters.ts` and `sprites.ts` both import from it (no cycle). The atlas-lookup contract (`characterKey(kind,variant,facing,frame)`, `propKey(id,slice)`) is what a future atlas would satisfy — callers never change.
- **Character texture bounds are the anchor contract** (art pass): every kind/facing/frame draws inside the pad rect (x −9..9, y −46..1) with the planted foot at y=0 (bob moves the body, not the feet); `FEET_ANCHOR` = 46/47 depends on this. Changing head size/bob/limb reach means re-auditing the pad bounds or actors float/sink. **4 facings**: SE/SW draw the face + front-of-torso details (`showFace`), NE/NW draw the back; SW/NW are the x-mirror of SE/NE baked into the texture (renderer keeps `scale.x` = 1).
- **New render draw is one-time or per-room-build, never per-frame** (art pass, guards the 60fps DoD): texture gen at `init`, walls/floors/props in `drawRoom`/`wallGraphic` on `roomBuilt`. The `draw()`/`drawOverlay()` hot path and the `lastOverlayKey`/`auraRevision` overlay cache stay untouched — don't add per-tile work there.
- **`isLoadableVersion` is the ONE version-acceptance policy** (Expansion 1): accepts 1..`SAVE_VERSION`; loadWorld's gate and the UI import pre-check both call it. The v1→v2 migration is a no-op EXCEPT `World.topUpCandidates()` (restore-time pool refill so predated roles are hireable) — a strict no-op on complete pools, proven by the untouched byte-identity test. Runs AFTER `restorePrivateState` (minted ids must come from the restored counter).
- **`auraCoversTile` (formulas.ts) is the one aura-membership formula** — `refreshAuras` fills its grid with it, the render ghost/hover preview asks it directly. **The render overlay is cache-keyed on `World.auraRevision`** (+ ghost rect / hovered tile only while placing an atrium) — a new overlay input must join the key. `auraRevision` is deliberately NOT saved (derived, resets on load).
- **Bottom-bar panels are mutually exclusive dropdowns** (§9 owner ruling): the `BottomBarDropdowns` coordinator owns ALL open/close state; panels register and never know each other. Its Escape listener is capture-phase and consumes the event ONLY when it closed a panel — that's what keeps M4's "Esc peels one layer" true; don't add independent Esc listeners.
- **Build-menu categories derive from `CATEGORY_LABELS`** (compile-complete `Record<RoomCategory, string>`, insertion order = display order) — a new category cannot be labeled yet invisible. `PROP_STYLE[*].tiles ≤ 2` is test-enforced (renderer strips slice single/west/east only).
- **The harness's black-envelope assertion measures the OPERATING envelope** (Expansion 1 ruling): the reference build's expansion wing is bankrolled in the fixture; capital costs are deliberately outside the assertion (see `test/harness.test.ts`). Every §12 condition must discharge ≥1 patient in the 5-day run — don't drop those per-condition asserts.
- **All boot-param grammar lives in `resolveBoot` (Phase 2)** — `src/sim/challenge.ts` is the ONE parser (load/challenge/seed/title/failure precedence, seed canonicalization to `[0,2^31)` via `SEED_MAX`, goal grammar) and `challengeToQuery` is its proven inverse (share-URL SSOT). `main.ts` only turns the `BootAction` into a side effect; it never re-parses. Use `Object.hasOwn`, never `in`, to look up challenge ids / metrics (prototype-chain guard, Track-1 review MAJOR). A malformed challenge is a boot-failure card, NEVER a fresh roll (MAJOR-3).
- **`world.challengeMode` is the ONE debug gate (Phase 2)** — `applyCommand` drops every `command.type.startsWith('debug')` when set (covers the complete debug* set; rejection is a pure no-op, so the scored rng stream is unperturbed). It's a runtime ctor arg — NOT saved, NOT `src/sim` source — so `save.ts` is untouched and a reloaded save is always a normal run. UI mirrors it: no DebugPanel, no build-bar spawn button in challenge mode.
- **`MidnightModalCoordinator` is the single `dayEnded` subscriber (Phase 2)** — it opens the daily report XOR the challenge result card per midnight, decided by a synchronous return value (not event order — kills the v1 race). The challenge controller once-latches on the FIRST of its two terminals (`dayEnded`@goal.day → reached, `gameOver` before → dnf) and emits `challengeComplete` exactly once; the DNF folds into the game-over screen. `scoreChallenge` (formulas.ts) is the ONE metric→number fn, reading `SCORE_METRICS[metric].kind/field/unit`.
- **A visible `.modal-overlay` owns the clock — enforced by `PausingOverlay` (Phase 2)** — the daily report + challenge card extend it (pause-on-open/restore-on-Continue is single-sourced). The catch-up loop (`loop.ts`) HALTS when a mid-frame tick pauses it (`&& this.speedValue > 0`), so the sim never advances behind a just-opened "paused" overlay and a bankruptcy can't stack game-over on the reached card. Only one overlay is ever visible.

- **A staffer's LOAD is DERIVED, never tracked** (ED B1): count the
  reservations whose `staffIds` name them (`reservationsOfStaff`/
  `staffLoadIn`) — the restroom-occupancy precedent. `Staff.duty` is still a
  single `reservationId`, but it now means **A** reservation they hold, not
  **THE** one. Consequently `releaseReservation` idles + steps out ONLY when
  the remaining panel is empty, and otherwise re-points the witness at a
  remaining (ACTIVE-preferred) reservation. That one branch IS the Flow-rule-7
  and rule-8 fix; neither needed its own change. `fireStaff` must act on the
  WHOLE panel or it leaves reservations naming a deleted staffer.
- **A ratio staffer's reservations are all in ONE room** (ED B1) — enforced by
  induction (`makeReservation`'s `wasIdle` gate + `availableStaff`'s
  witness-room test + the within-panel re-point) and by the v10 save border.
  It is what makes "zone" mean anything and why the soft hold keys on
  (staffer, room, units): a nurse secured for surgery must be unavailable in
  the ER OUTRIGHT, not merely down one unit.
- **`availableStaff` is IDLE-FIRST, and that was a MEASURED reversal** (ED B1,
  `ED_PLAN` §5b): the contract specified load-forward and both pre-impl
  reviewers endorsed it; the 3-arm probe measured +1.8 deaths and −23%
  surgeries. A hired staffer's salary is already spent, so sharing is a saving
  at HIRE time, never at dispatch. Don't "optimise" this back.
- **The attention penalty is DURATION-ONLY and counts ACTIVE load only**
  (ED B1): `successChance` keeps RAW skill so deaths stay tied to a
  health/acuity story rather than staffing arithmetic, and a nurse walking to
  bay 2 must not slow bay 1 (`staffLoadIn(..., {activeOnly:true})`).
- **`closed` and `brokenSince` disable a room identically** (ED B1) — one line
  in `capacityOf` gates every dispatch path — but the broken guard in
  `setRoomClosed` is ASYMMETRIC: closing a broken room is refused, REOPENING
  one is always allowed. A closed room still drains its actives and a draining
  treatment can still break it, so closed+broken is reachable; refusing the
  reopen stranded the room permanently.
- **Capacity/ratio needs are PANEL-ONLY** (ED B1): `hintOnce` keys persist per
  save and `capacity:<roomType>` is type-keyed, so toasting it would announce
  a recurring state exactly once in a save's lifetime — the defect the
  `broken:<id>:<since>` instance key exists to avoid.
- **The SHORTAGE scan covers EVERY staffed room and names the ROLE**
  (`capacityNeeds` in needs.ts, owner ask 2026-07-19). The existence-based
  scan answers "is it built / is anyone hired"; this one answers "is anyone
  FREE", which is the game's most common real failure and was previously
  silent — a player watched patients die outside an idle OR with no
  explanation. Three states: no free slot → expand; every X busy → hire an X
  *for this room*; role not hired → the existing `role:<id>` row, never
  duplicated. `waitingTriage` counts, so a starved triage queue surfaces.
  **The transient-flash problem is solved by `capacityHintWaitGameMinutes`,
  NOT by scoping to ratio rooms** — every 1:1 room is briefly "all staff busy"
  between patients, so only a patient stuck for a real interval counts. Naming
  which role binds in which area IS the mechanic (ED_PLAN §7.2: diagnosing the
  binding resource is meant to be the skill).
- **`needBreak` is a SUB-STATE, never a stage** (amenities Stage 1, the `lost`
  precedent): stage stays `waiting`/`waitingTriage`, `waitingSince` keeps
  aging, the dispatcher's `dispatchable` skips on-break patients, and stall/
  vending claims are DERIVED from live `needBreak`s (release falls out of the
  terminal choke points calling `clearNeedBreak` — no bookkeeping to leak).
  `clearNeedBreak` is THE one abandon path (target/path nulling per the
  lost/non-lost rule, retry hold on failure/abandon).
- **Side-trips are gated like dispatch** (design MAJOR 1 class): findPath
  reachability before any claim; ANY failed probe against existing candidates
  sets `needBreakHoldUntil`; a stalled arrival (dead path reads as "arrived")
  abandons immediately — never flips `using` outside the target.
- **Vending stand tiles obey the standing-zone rule** (Stage-1 code review
  MAJOR): the claim-time pick AND the `using` flip require corridor/open-plan,
  never a walled-room interior or door landing — orthogonal adjacency is
  Manhattan distance and holds ACROSS walls.
- **Amenity props are ALWAYS non-walkable** (rule, not coincidence): the room
  build/expand 'Blocked by an object' rejection is the only thing stopping
  rooms from being stamped over amenities.
- **`feeBilled` carries `source`** ('treatment' | 'vending'): the checklist's
  "treat your first patient" completes ONLY on treatment fees (live-drive
  MAJOR — a $5 soda must not check it off). Vending revenue is a BREAKDOWN of
  `revenue` tallied at the same `billFee` choke point, never re-added to
  dayNet.
- **Restroom occupancy is read from `stallClaims`, never `reservationsOn`**
  (self-service room — reservations are permanently empty there); walking
  claimants render "(on the way)". Restroom expand/sell reject 'Occupied'
  while ANY live claim references the room (walking counts).
- **The blocked panel is row-capped (8 + "+N more") with a CSS max-height**
  (live-drive MAJOR): it must never grow over — and click-block — the inspect
  card's buttons.
- **Every mess has a job; every job has a live target** (Stage 2): `addMess`
  mints the clean job (iff none targets the tile — the overflow order mints
  the `empty` job FIRST so no double-mint); `removeMess` carries the GENERAL
  orphan rule (job deleted in any phase, worker released + stepped out); the
  geometry choke points (build/expand/sell/placeAmenity/sellAmenity) sweep
  both. The v5 border enforces the invariant BOTH ways.
- **Job work tiles obey `world.canApproach`** (Stage-2 code review MAJOR):
  Manhattan adjacency holds THROUGH edge-walls, so any "stand beside the
  target" derivation must verify the facing edge is legal (same room, open
  plan, or a door). `canStep` = `canApproach` + destination walkability —
  one wall-logic source; never re-derive wall rules elsewhere.
- **The frozen assignJobs loop** (Stage 2): oldest = lowest job id; held
  jobs are SKIPPED, never blocking younger workable ones; a failed probe
  sets that job's `holdUntil` and the scan continues — the dispatchHoldUntil
  hot-loop/starvation lessons, applied to the job queue.
- **A new ROLE ships WITH its fixed-seed re-pins** (Stage 2): the World
  constructor mints candidates per role, so adding a RoleId shifts every
  seeded stream from tick 0 — never freeze a role separately from the
  test-expectation updates. Re-pin, never weaken; record seed rationale
  in-file.
- **`cleanlinessRepDelta(messTicks, arrivals)` is the ONE cleanliness
  metric** (closeDay applies it beside the wait bonus, before the snapshot;
  the report row displays it); the clean-day bonus requires arrivals > 0
  (flagged design delta — the wait-bonus "empty hospital" principle).
- **`applyRoomUse` is THE wear choke point** (Stage 3): unconditional after
  BOTH updateTreatment branches (incl. the missing-patient early-return —
  one rng-order rule, no forks) and at restroom completions; zero-rng no-op
  for no-failure rooms AND while broken (the border pins broken ⇒ wear 0,
  and a finishing occupant can't double-break). `breakdownChance` in
  formulas.ts is the ONE probability derivation.
- **`breakRoom` is THE breakdown path** (roll + debugBreakRoom share it),
  frozen order: flag → cancel gatherings (rule-8, hint:false; actives
  finish — disable, never harm) → mint the repair job → piping burst →
  events. `capacityOf` returns 0 while broken — that ONE line gates every
  dispatch path and restroom claim; the save border's reservation-slot
  bound stays GRID-derived and broken-blind (actives must round-trip).
- **A repair anchor must be STRUCTURALLY WORKABLE and never job-held**
  (Stage-3 pre-impl MAJOR 1 + 2a, post-impl MAJOR 1): eligible = no job
  targets it AND ≥1 orthogonal neighbor passes isWalkable + standableTile
  (same-room) + canApproach — claim-free, rng-free, at EVERY fallback
  level. `addMess` on a repair-held tile RE-ANCHORS the repair job first
  (releasing any bound tech to re-converge) so the clean mint is never
  suppressed — a mess whose only cover is a repair job is a save that
  refuses to load after the repair completes.
- **broken ⇔ exactly one repair job** (v6 border, both ways; repair ⇒
  roomId resolves to a broken failure-def room, anchor inside its rect;
  clean/empty ⇒ roomId null; the mess-reverse-check requires CLEAN/EMPTY
  cover — a repair job doesn't service messes). "Mint on load" was
  rejected: breakRoom's guaranteed mint is the invariant's source.
- **Broken-room geometry**: expand rejected ('Out of service — repair it
  first'); sell legal SUBJECT TO the normal occupancy gates (a working
  tech inside blocks 'Someone is inside' — fire-then-sell is the remedy;
  validateRoomSell was NOT weakened); sellRoom deletes roomId-targeted
  jobs and releases their workers.
- **`FINANCE_CATEGORIES` is THE money-row SSOT** (finances epic,
  `src/sim/data/finance.ts`): ONE table drives the finances grid, the daily
  report's Money section AND `netFromCategories` — which `dayNet` now
  delegates to, so a new cash category joins the net automatically instead of
  being silently omitted. `kind` drives the display negation, the net fold and
  the row tone from one flag; `reportOrder` carries the daily report's shipped
  row order independently of ARRAY order (the grid's); `showWhenZero` governs
  the DAILY REPORT ONLY — the grid always renders every non-breakdown row,
  because a grid needs a stable row set across columns. `breakdown` rows
  (vending) are display-only and NEVER summed. **The partition guard test**
  (`NON_CASH_TALLY_KEYS` ∪ category fields === `Object.keys(emptyDayTally())`)
  makes a new tally key fail loudly until it is classified as cash or not.
- **`tallyCash` is THE cash-tally increment** (finances epic): today AND
  lifetime in one call, so the grid's Today and Total columns cannot disagree.
  It deliberately does NOT move `world.cash` — every call site still adjusts
  cash itself, which is why it is not named `addCash`. No `this.today.<cashKey>
  +=` may survive anywhere.
- **Per-room income is attributed at the ONE billing choke point**: `billFee`
  takes `{ source?, roomId? }` and credits `revenueToday`/`revenueTotal`/
  `visitsTotal` in the same call that moves the cash. `visitsTotal` counts
  treatment STEPS, not discharges — hence "Patients seen" in the UI, never the
  `treated`/`lifetimeTreated` vocabulary (a 2-step patient credits two rooms
  once each). A complication credits nothing; selling a room mid-treatment
  degrades to no attribution rather than a crash.
- **Lifetime totals are REAL STATE, not a sum** (finances epic): `world.lifetime`
  is saved, because Σ over live rooms silently drops a SOLD room's earnings and
  the stored history is only 30 days. `lifetimeTreatedBase` is the v6→v7
  watermark for the average-bill denominator — without it a migrated save
  divides fresh revenue by pre-upgrade discharges and reads permanently,
  invisibly low. Pre-v7 saves start Total at 0 and the modal says so once.
- **History is TRIMMED on load, never REJECTED** (finances epic): the cap is a
  BALANCE tunable, so a load-time reject against it would brick every existing
  save — production autosaves included — the day the cap is lowered. Keep the
  newest `historyCapDays`; a hard structural bound (1000) guards malformed
  input only. Consequence: an over-cap save is not byte-identical on re-save,
  so **the byte-identity fixture must never be over-cap**.
- **`allowResumeToPaused` distinguishes player-opened overlays from midnight
  ones** (finances epic): `PausingOverlay`'s speed-1 fallback is right for the
  daily report and challenge card (which only open at a day boundary), but
  WRONG for the first overlay a player opens at will — pause, open Finances,
  Continue, and the game would silently resume. Default `false` preserves every
  pre-finances overlay byte-for-byte; only `FinanceModal` sets it true.
- **The single-overlay rule needs BOTH halves** (finances verification MINOR):
  `FinanceModal.open()` refuses to open over a live overlay, AND it hides on
  `dayEnded`. The second half is structural — the daily report has no
  reciprocal guard, so without it a forced tick at midnight stacked both
  overlays, and dismissing finances left the report up with the clock RUNNING
  behind a modal that claims to pause. Never re-justify the guard with
  "midnight cannot fire while we're open": pausing makes that true only while
  nothing forces a tick through the queue, which is not an interlock.
- **`hospitalValue` is MODAL-OPEN ONLY** — it walks every room and amenity, and
  must never ride the frame poll. **Selling is value-NEUTRAL** (the sale pays
  exactly `sellbackAmount` into cash, so the two deltas cancel — the plan's own
  §12 claimed otherwise and was wrong, confirmed by both reviews); what drops is
  the department's capital invested. Value falls on a BUILD, by the
  price-vs-sellback spread.
- **Non-earning rooms show NO money anywhere** (finances epic, both reviews):
  the inspect card gates its Income block on `roomEarns`, and the directory
  gates its earned column the same way. A waiting room reading "$0" is not the
  RCT "this ride earns nothing" signal — that read only carries information for
  a unit that COULD have earned. Directory money values join the `renderKey` as
  their RENDERED `money()` strings, never raw floats, or payroll's sub-cent
  dust rebuilds the list forever.
- **`formulas.ts` ↔ `dailyStats.ts` is a deliberate, verified-safe import
  cycle**: neither module calls across it at evaluation time and both export
  hoisted `function` declarations. Evaluating an exported binding at module
  scope on either side (e.g. `const X = netFromCategories(...)`) would break it.
- **The dispatcher's partial-gather soft hold** (anesthesia milestone): when
  the top-priority patient's step gathers SOME but not all of its roles, the
  staff it secured are off-limits for the rest of that tick's
  `assignTreatment` pass. Without it a multi-role step that is one role short
  hands its staff to a lower-priority single-role patient in the SAME loop and
  starves indefinitely — `dispatchHoldUntil` does NOT cover this (it arms only
  after a CANCELLATION, never after a failed gather). Purely local: a `Set`
  that dies with the pass, nothing committed, all-or-nothing untouched.
  Regression: `test/anesthesia.test.ts` — and it is verified non-vacuous
  (reverting the hold makes it fail).
- **A new ROLE still ships WITH its re-pins — but check what actually breaks
  before planning a sweep** (anesthesia milestone): the pre-impl review
  predicted ~20 suites would need re-pinning; only TWO tests changed, both
  semantic (a two-role OR assertion and a hints enumeration). The fixed-seed
  suites assert PROPERTIES, not rng-derived values, which is why they survived
  an eleventh role. Derive the affected set mechanically from what goes red.
- **Backward save fixtures filter post-version roles BY NAME** (anesthesia
  MAJOR 4, shared `expectPoolLacks`): a premise counted as
  `(ROLE_IDS.length - N) * candidatesPerRole` stays arithmetically true as the
  roster grows, so every new role silently left the fixtures holding
  candidates that version could never have had — green while no longer testing
  the migration. That is the guard for the v1→v2 unhirable-surgeon bug.
- **Job duty labels are phase-aware** (live-drive MINOR 2): en-route reads
  "Heading to a mess/trashcan/repair", the kind label ("Cleaning" /
  "Repairing") only while `working` — the room card's pending/underway
  split and the staff card must never contradict.

## Working agreements (user-established)

1. **Per milestone:** implement → **independent adversarial review agent** (fresh context, docs as contract, ordered findings with severity + file:line) → fix ALL findings → add a regression test per major → build/test/lint green → **commit** → next milestone. The user explicitly wants the review step; don't skip it.
2. SSOT/DRY per tech plan §3.1 — the ESLint `no-magic-numbers` scoping to `ui/` + `sim/systems/` is the enforcement teeth; extend, don't weaken.
3. Balance changes edit `src/sim/data/balance.ts`, not the GDD (GDD numbers are initial values by declaration).
4. User cares about game feel: they requested the wayfinding/atrium mechanic, the character upgrade, and the overlap fix. Visual polish requests are welcome mid-milestone.

## Next

- **DEPARTMENTS EPIC — `docs/DEPARTMENTS_PLAN.md`. STAGE 1 SHIPPED (see the
  commit table). STAGE 2 (the department model — the owner's "OR is a
  collection of operating rooms" / "xray is a collection of rooms" ask) is
  still DRAFT and needs its OWN pre-implementation review.** Owner asks 2026-07-19: the OR should be "a collection of
  different operating rooms inside of it", X-ray "a collection of rooms where
  there can be more than one xray machine in the entire entity", and — if
  patients aren't really seen there — respiratory therapy should lose its room
  entirely. **Deep research (24 sources, 98 claims, top 25 adversarially
  verified) says the game has ONE capacity axis and reality has THREE:**
  AREA-scaled (dialysis — CBC §1224.36.2 permits one open room, 80 sq ft +
  4-ft clearance per station; the game already has this right), EQUIPMENT-
  scaled (X-ray/CT/MRI/nucMed/OR — capacity is the MACHINE measured as
  per-scanner serial occupancy, so floor area buys nothing and you add a
  walled suite), and STAFF-HOUR-scaled (respiratory therapy — **AARC's
  methodology contains no spatial capacity unit at all**; RTs are mobile
  bedside providers and APEX standards PROHIBIT treating several patients at
  once). Two rows flagged weak, not laundered: the OR clearance-band claim
  passed only 2-1, and the ED per-station evidence was **REFUTED 0-3** (a 2018
  proposal, not adopted code). **The #1 blast-radius item: `save.ts:900`
  validates room type with `asOneOf(o.type, ROOM_TYPES)`, so deleting `resp`
  from `ROOM_DEFS` would make every LIVE save containing one refuse to load —
  the plan recommends RETIRE (keep loadable, drop from the build menu) over
  delete or migrate.** Stage 2's chosen shape deliberately avoids internal
  wall edges: a department is a SET of ordinary Rooms, so every existing wall,
  door, A*, reservation and capacity path is reused and the dispatcher needs
  no change at all (`roomsOfType` already returns them). The design prize is
  §5: suites add machines but NOT technicians, making "do I need a machine or
  a tech?" a real diagnosis (ED_PLAN §7.2's movable bottleneck).
- **STAFF LOUNGE — owner ask (2026-07-19), NOT SCOPED.** *"Add the option to
  create a staff lounge in the Comfort dropdown area. Staff need a place to
  take breaks and lunches."* The room itself is cheap — a `RoomDef` with
  `category: 'comfort'`; the build menu derives categories from
  `CATEGORY_LABELS`, so it appears automatically. **The real work is what a
  break MEANS**, and it needs its own plan + pre-implementation review:
  (1) a staff fatigue/hunger meter — the patient bladder/thirst precedent from
  Amenities Stage 1 (`decay.ts` + the rng-rolled spawn values); (2) a break
  SIDE-TRIP, which should follow `patientNeeds.ts`'s `needBreak` sub-state
  rather than inventing a new stage (stage stays put, the dispatcher skips
  on-break staff, claims derive from live break state — no bookkeeping to
  leak); (3) the balance question: does a staffer on break leave the available
  pool? **That interacts directly with ED B1's nurse capture** (`ED_PLAN` §5b
  item 5) — a ratio nurse who never returns to `idle` also never gets a break,
  which is either a bug to fix or, more interestingly, the pressure that makes
  the lounge matter. Decide that deliberately. (4) Morale/efficiency payoff vs
  pure decoration — a lounge with no mechanical effect is a money sink.
  Save impact: new room type is fine, but a staff meter is new saved state ⇒
  SAVE_VERSION bump.
- **Art pass: DONE** (procedural upgrade — see commit table; the §2.6 atlas contract stayed intact, so a real sprite atlas remains a future drop-in). This was the deploy prerequisite (owner ruling).
- **Deploy: DONE (2026-07-17).** Live at **https://hospital-sims.vercel.app** — Vercel, `hospital-sims` team, project `hospital-sims`, production branch `master` (= GitHub default; no master/main mismatch). Git integration connected → every push to `master` auto-deploys to production, other branches get preview URLs. Deployed via Vercel CLI (`vercel link` + `vercel deploy --prod`) after the dashboard import produced no build; git auto-deploy verified with a live push. **Public GitHub repo: `lgorby/hospital-sims`** — full tree tracked, including `CLAUDE.md` (initially kept private + scrubbed from pre-publish history via `git filter-branch`, then re-added on owner request so it syncs across machines — nothing private in it; it appears from commit `10d35e5` forward). Full pre-publish history preserved on branch `pre-public-master` (local + pushed to `origin` as an archive — never merge it into `master`; the histories intentionally diverge). `.vercel/` is gitignored (local link config). The build output is a pure static site (`vite build` → `dist/`), portable to any static host — a hosting choice, not a dependency. Redeploy manually if ever needed: `vercel deploy --prod --scope hospital-sims`.
- **Optional art polish (art-review recommendations, not defects):** three green-family role colors cluster — nurse (teal), respiratory therapist (green), surgeon (dark green); RT vs surgeon differ only by the surgeon's mask. Reads fine in-world (cap/mask disambiguate) but nudging `ROLE_DEFS` colors apart in `roles.ts` would help at a glance. Also consider making staff role colors more hue-spread generally. Deferred pending an owner call + a visual check.
- **Camera input polish: DONE** (2026-07-17, trackpad complaint). `renderer.ts` wheel handler: plain wheel / two-finger scroll → pan both axes (fixes trackpad up/down, which the old wheel-zoom binding ate); ctrl/meta+wheel (= trackpad pinch) → continuous cursor-anchored zoom (MIN_ZOOM 0.5 .. MAX_ZOOM 2, was 3 discrete steps). Known tradeoff: a classic mouse wheel now pans; mouse users zoom via ctrl+wheel.
- **Input supported today = mouse + trackpad ONLY** (clarified 2026-07-17: an owner touchscreen report turned out to be finger-on-display, which the game doesn't handle — the fix above is wheel-based, i.e. mouse/trackpad). **Touchscreen / touch input is DEFERRED** — GDD §11 item 17: touch gestures emit *touch* pointer events the canvas ignores; adding one-finger pan/tap + two-finger pinch (via Pointer Events, coexisting with tap-select/drag-build) is a self-contained future pass that makes the game tablet-playable. Owner chose to build it later.
- **View rotation: SCOPED, not built** — GDD §11 item 16 + `TECH_PLAN.md` §2.7. It's a rendering-architecture milestone (orientation-aware `iso.ts` projection+picking, `depthKey`, wall far/near, and character facings), NOT input polish — give it its own milestone + pre-implementation review. Do not conflate with the camera-input pass above.
- **Amenities epic: COMPLETE (2026-07-18)** — all three stages shipped
  (commit table); `docs/AMENITIES_PLAN.md` + the impl plan's S1/S2/S3
  sections all marked IMPLEMENTED. The owner's original ask ("trashcans,
  vending, restrooms, EVS, maintenance, piping to go bad, people throwing
  up") is playable end-to-end. Watch items: wearFactor MTBFs (≈31/≈45
  uses) were harness-tuned but not yet felt over long real sessions; the
  restroom-usage balance pass (OWNER DECISIONS 3) awaits the owner's feel
  check on the live build.
- **Fun-name pool expansion: DONE (2026-07-18, owner ask)** — FIRST_NAMES
  40→72, LAST_NAMES 30→54 (~3,900 combos), same register; draw count
  unchanged, zero test fallout (no literal name was pinned anywhere —
  grepped and suite-verified).
- **Hospital Directory pullout: DONE (2026-07-18, owner ask "an inventory
  list — hard to see what areas are purchased")** — `src/ui/directory.ts`:
  a 🏥 bottom-bar toggle opens a right-side pullout (the thought-log slot;
  BottomBarDropdowns keeps all right-slot panels mutually exclusive)
  listing every room by build-menu category (CATEGORY_LABELS now EXPORTED
  from buildMenu — one source) with floor-color swatch, size, and live
  status (Out of service / used-capacity mirroring the inspect card's
  used-count semantics / In use), every amenity (trashcan fill, vending
  claims), and a staff head-count line. **Rows click-to-jump AND select**
  (camera centers + the inspect card opens). Rebuilds via the blockedPanel
  idiom (tick-gate + renderKey + the paused-command event invalidation
  list; O(1) while closed). `cssHexColor` extracted to ui/dom.ts (shared
  with buildMenu swatches). Reviewed (combined code + live-drive: COMMIT,
  0 MAJOR, 1 MINOR + 2 NIT all fixed; 12/12 drive items PASS, zero console
  errors). 6 DOM tests (503 total).
- **Jump-target pulse: DONE (2026-07-18, owner ask "can it somehow glow or
  pulse to show the area")** — `renderer.pulseRect/pulseTile` + `drawPulse`
  (a dedicated topmost `pulseGfx` in the camera): every click-to-jump
  (toasts, thought-log entries, directory rows) throbs an amber footprint
  outline at the destination — 3 floored cosine cycles fading over 1.6s
  (the floor is a review NIT: a bare cosine blacked out 3×/pulse). Single
  slot; directory room rows upgrade the tile pulse to the full rect. Pure
  presentation (performance.now; zero rng/sim contact; bare null-check per
  frame at rest — the hot-path budget untouched). Reviewed (code +
  live-drive: COMMIT, 0 MAJOR/MINOR, 2 NIT — throb floor fixed, the
  deliberate amber-palette share noted). This CLOSES the banked "patient
  click-highlight" backlog item (thought-log jumps now pan AND pulse).
- **FINANCES epic: COMPLETE (2026-07-18)** — see the `*(finances)*` commit-table
  row and the invariants above. The owner's ask ("show the profit and loss for
  each department and totals… mimic RollerCoaster Tycoon") is playable: a
  `💷 Finances` HUD button opens the pausing window (category grid × last 7
  days + Today + Total, hospital value, average bill, cash graph, departments),
  rooms and vending machines carry their own income on the inspect card, and
  the directory doubles as the P&L browser. `docs/FINANCE_PLAN.md` v3 remains
  the contract; its §12 sell-back line was CORRECTED post-implementation (both
  reviews proved hospital value is conserved on a sale, not reduced). **Owner
  decisions still open from §7, deliberately deferred, not forgotten:** payroll
  allocation (v1 = hospital overhead, shown as an explicit unallocated line —
  the alternative is time-weighted attribution, needs its own save fields);
  **per-room running costs (§7 Q2) — the thing that would make per-room PROFIT
  and true departmental P&L meaningful; deferred because every room becoming a
  drain re-tunes the M4 economy and the harness envelope**; loans (out of
  scope). Watch item: the departments block sums LIVE ROOMS only, so it is
  short of `Patient fees` — CLOSED by the polish pass: the Amenities row
  carries the vending side and `Sold rooms (no longer owned)` carries income
  from rooms we no longer own, so the block now reconciles with lifetime
  revenue exactly (pinned by a DOM test that sums the column).
- **The superseded finances entry** (kept for provenance — the plan below is
  what was built): read `docs/FINANCE_PLAN.md` v3 — it is BOTH the design and
  the implementation plan, self-contained for a cold start. Two adversarial
  pre-impl review rounds are already folded (round 1: 8 MAJOR / 8 MINOR / 6
  NIT; round 2 verified all eight closed against real code and found 2 new
  MAJOR / 7 MINOR / 7 NIT — also folded), so the contract in §9 is
  freeze-ready; do NOT re-litigate it, implement it. Shape:
  - **Scope**: a pausing Finances modal (RCT finances window — categories ×
    last 7 days + Today + Total, hospital value, average bill, an inline-SVG
    cash graph), per-room income on the inspect card (the RCT ride-window
    analog), per-machine vending revenue, and a departmental ledger by
    `RoomCategory` (income + capital invested + an explicit
    `Payroll (not allocated)` line — §6's ruling: payroll is hospital
    overhead in v1 because staff are dispatched hospital-wide; per-room
    running costs are §7 Q2, deferred as a balance pass).
  - **SSOT/DRY spine** (the owner asked for this explicitly): ONE
    `FINANCE_CATEGORIES` table drives the grid, the daily report's Money
    section, and `dayNet`; ONE `tallyCash` increment feeds today AND
    lifetime; the history reader delegates to the version-aware `readTally`;
    `roomEarns` is DERIVED from `CONDITION_DEFS`, never a hand-kept flag.
  - **Workflow**: freeze §9.1–§9.4 + typed stubs → 3 parallel tracks with
    disjoint ownership (S: sim/save/tests · U1: the modal + pausingOverlay +
    main.ts wiring + its ui.css marker block · U2: inspect/directory/
    dailyReport + its ui.css block; NO render track) → 2 parallel adversarial
    reviewers (code/contract + live-drive via `/run-hospital-simms`) → fix
    ALL findings + a regression test per MAJOR → gates → **orchestrator**
    writes the HANDOFF entry and commits → push.
  - **SAVE_VERSION 7** (`Room.revenueToday/revenueTotal/visitsTotal`,
    `amenity.revenueTotal`, `world.lifetime`/`lifetimeTreatedBase`/`history`).
    First save bump with NO new role ⇒ **no fixed-seed re-pin** — harness
    seed 1338 must stay green (assert it; don't weaken it).
  - **Owner decisions still open** (§7): payroll allocation (v1 = overhead),
    per-room running costs (deferred), loans (out), 7-shown/30-stored history.
- **Click a patient to read THEIR thoughts: SCOPED, not built (owner ask
  2026-07-18).** Today the inspect card shows a patient's condition, acuity,
  vitals bars, state and billed total plus a mood emoji (🙂/💢/💀) — but their
  actual thoughts go ONLY to the global 💭 Thoughts feed, mixed in with
  everyone else's. The owner wants to click a person and read what THAT person
  is thinking (the RCT "pick up a guest and read their thoughts" moment).
  **The design fork that decides the size of this — settle it before coding:**
  thoughts are EVENTS (`patientThought`), not state. Nothing anywhere stores a
  patient's thought history.
  - *(a) UI-only, cheap:* the thought log already retains a capped 100-entry
    scrollback carrying `patientId`; filter it per patient and render the last
    few on the card. No sim change, no save change, zero risk — but a patient's
    thoughts vanish once pushed out of the shared 100-entry window (a busy
    hospital churns it fast), and they are GONE on reload, so the card is empty
    for every patient after loading a save.
  - *(b) Sim state, honest:* a small ring buffer (3–5 entries) on `Patient`,
    written at the existing `emitThought` choke point. Survives reload, always
    populated, per-patient by construction — but it is new World state, so it
    is a **SAVE_VERSION bump** with the plan-rule-6 checklist, plus a decision
    about whether thought text or just the `ThoughtKey` is saved (keys are
    smaller and re-render through `THOUGHTS`, but the text is hash-picked from
    `patient.id + tick`, so persisting the key alone means re-picking the
    variant on load unless the tick is stored too).
  - Recommendation: **(b)** — (a) looks free but produces a card that is empty
    exactly when a player most wants it (after loading a save, or in the busy
    hospital that generates the most interesting thoughts). Pairs naturally
    with the banked "click a patient to highlight them" work, which the
    jump-target pulse already closed.
- **Per-room running costs: SCOPED, not built (FINANCE_PLAN §7 Q2, owner ask
  "fix them all" 2026-07-18 — explicitly carved out as a milestone).** This is
  the one thing standing between the finances window and a TRUE RCT ledger:
  RCT rides show *profit* because rides have running costs; ours show income
  only, so nothing in the game answers "is this room worth having". Adding
  them is a BALANCE change, not a display change — every room becomes a
  continuous drain, the M4-tuned economy shifts under it, and the harness's
  black-envelope assertion needs re-tuning. Shape when it lands: a
  `runningCostPerHour` (or per-tile derivation, so a bigger room costs more —
  the Stage-0 pricing precedent) in `ROOM_DEFS`/`balance.ts`; an hourly accrual
  in `updateEconomy` beside payroll, tallied through `tallyCash` into a NEW
  `FINANCE_CATEGORIES` expense row (the partition-guard test will demand it be
  classified — that is the table working as designed); a `Profit` line on the
  inspect card (§4.1) and a running-cost column in Departments, at which point
  the departmental block becomes real P&L; and a balance pass with the harness
  before it ships. No save bump needed for the cost table itself, but the new
  cash category means a `DayTally` key ⇒ SAVE_VERSION bump. Give it its own
  plan + pre-implementation review, like every prior epic.
- **Anesthesiologist role: SHIPPED (2026-07-18)** — see the `*(anesthesia)*`
  commit-table row and `docs/ANESTHESIA_PLAN.md` v2 (marked IMPLEMENTED). The
  OR is a THREE-role gather (surgeon + nurse + anesthesiologist), and the
  pre-impl review's MAJOR 2 reshaped the milestone: the new role has no
  competing demand, so it does NOT make the gather harder in the way the plan
  assumed — the binding constraint stays the nurse. The fix that earned the
  milestone is §4 lever 4, the **partial-gather soft hold**.
- **~~Anesthesiologist role: SCOPED, not built (owner ask 2026-07-18).~~**
  *(Superseded by the entry above — kept for the scoping rationale.)* The
  OR today needs `surgeon` + `nurse`, and `nurse` is the most contended role
  in the game (triage, dialysis, laceration sutures, the ER) — a nurse
  dispatched elsewhere blocks the all-or-nothing surgery reservation and the
  surgeon never moves; hiring a second nurse is the current fix. The owner
  wants anesthesiology MODELLED rather than papered over: a new `RoleId` +
  `ROLE_DEFS` entry (colour must clear the existing green cluster — see the
  art-polish note above) and a THIRD role on the surgery step, which makes
  every surgery a 3-way gather. **This is a milestone, not a one-liner:**
  a new RoleId shifts every seeded stream from tick 0 (the World constructor
  mints candidates per role), so it ships WITH its fixed-seed re-pins — the
  Stage-2 EVS invariant above ("a new ROLE ships WITH its re-pins; re-pin,
  never weaken"). Also needs: the hints pipeline naming the new role in the
  surgery chain, a balance look at OR throughput (a third required role
  lengthens gathers), and no SAVE_VERSION bump (roles aren't saved state,
  but the candidate pool is — check `topUpCandidates` covers the new role on
  load, the v1→v2 migration precedent). NOT started — awaiting the owner's
  priority call against the other backlog items.
- **Then, quick passes:** (1) capacity/contention hints
  ("expand your ER or build another" — the panel's `roomChanged`
  invalidation is pre-wired). Banked NITs (fix opportunistically): the
  trap-BFS doesn't re-check existing ATRIUM footprints; room/expand ghost
  validity keys omit cash while paused; patients stand in messes (V1
  collision, accepted); wage-accrual float dust (HUD rounds it); Stage-3
  live-drive: sparks decal reads subtle at default zoom (grey floor
  carries it), restroom "In use" line lists "(on the way)" walkers under
  an "In use" header, and REJECTED build/expand/sell modes stay armed
  after the reason toast (pre-existing; Esc is the exit).
- **Owner asks 2026-07-18 (answered + scoped, pending owner priorities):**
  (a) *Do patients bring family?* Not yet — GDD §11 item 15 (family &
  visitors) is designed at sketch level only; needs a milestone (non-patient
  walkers, seating pressure, leave-together logic). (b) *Wheelchair
  patients?* Not designed — would be a patient mobility variant (spawn mix
  flag, slower speed, sprite variant, maybe wheelchair-accessible standing
  spots); worth a small design doc before code; pairs naturally with
  (c) *patients sitting during exams* — a render/animation pass (seated
  pose on bed/chair while a reservation is active; the §2.6 art contract
  supports new poses as texture variants, no atlas break). (d) **AUDIO**
  (owner ask 2026-07-18): "overhead pages, critical patient arriving
  alerts, stroke alerts in rooms, missing patients, just the business of a
  hospital setting." The game has NO audio subsystem today, so this is a
  MILESTONE, not a sprinkle: a WebAudio layer driven by the EXISTING
  EventBus (the events are already there — patientSpawned by acuity/
  condition for arrival + stroke alerts, patientLost for "missing patient"
  pages, roomBroken, patientDied, dayEnded chimes), an ambient bed
  (murmur/PA-crackle overhead pages — procedural or licensed samples is a
  design choice), volume/mute settings persisted outside saves, and the
  browser autoplay-gesture rule (audio can only start after a click —
  title screen is the natural gate). Sim stays silent by design (audio is
  a render-side EventBus consumer — determinism untouched). Needs its own
  design pass (cue list, mixing, annoyance budget) before code. None
  started — awaiting owner priority call vs the quick passes above.
- **Capacity & growth epic: COMPLETE (2026-07-18)** — all three stages
  shipped same-day (see the `*(stage 0/A/B)*` commit-table rows);
  `docs/CAPACITY_PLAN.md` marked IMPLEMENTED with the shipped deltas. The
  owner's original ask ("the ER may need to get larger to handle more
  patients and doctors at once with more beds") is playable end-to-end:
  build min, earn, Expand, staff up, treat concurrently. "Quit to Title"
  SHIPPED in the in-game Save/Load modal (two-step armed — the only autosave
  is midnight's). Parked: the mega-room dominance watch (§8 Q5 cap lever).
- **Capacity & growth epic: RATIFIED (2026-07-18)** —
  `docs/CAPACITY_PLAN.md` v2 (design-reviewed: 5 MAJORs folded — flat-cost
  drag-big exploit, dialysis 1→2 retro jump, slotIndex save field,
  rect-aware sellback, stale atrium aura on expand). Owner-ratified: proposed
  multi-slot roster (Waiting/ER/Dialysis; rest single); dialysis jump
  accepted; derived per-tile pricing (`ceil(cost/minArea)`) + rect-aware
  sellback + legacy-refund quirk accepted; reservation-free-but-seated-ok
  expand rule; no caps/crowding v1. Staging is LOAD-BEARING: **Stage 0
  (size-based pricing) MUST ship before Stage A (capacity)** or drag-built
  giant rooms are strictly dominant; Stage B (expand tool) last. Each stage
  gets the full milestone workflow.
- **HINTS milestone: SHIPPED (2026-07-18)** — see the commit table `*(hints)*`
  row and `docs/HINTS_PLAN.md` (marked IMPLEMENTED, deltas listed). The owner's
  OR confusion is addressed: the panel names the full chain ahead of time
  ("soon: Hire a Surgeon — needed for Gallstones"). NOT built (explicit owner
  choice): the anesthesia-cart relabel — surgery needs `surgeon`+`nurse`; the
  `anesthesiaCart` is a decorative OR prop, NOT a staffable role. Future passes
  if wanted: capacity/contention needs ("a second OR"), click-a-need to open
  the build menu/hire panel.
- **Owner design backlog (2026-07-17, sketch-level, needs scoping):** (a) SMALL —
  clicking a patient name in the thought log should HIGHLIGHT the person, not
  just pan (ThoughtLog already click-to-jumps via the `jump` callback; add a
  selection pulse). (b) LARGE Theme-Hospital-style upkeep layer — buyable
  amenities (trashcans, vending, restrooms), new staff (janitors/EVS/
  maintenance), and facility-needs mechanics (plumbing failures, bathrooms,
  patient vomiting, cleanliness). New props/rooms/roles + a decay/needs system;
  design it before any code.
- **Persistence Phase 2 (seed challenges): SHIPPED (2026-07-17).** See the commit
  table `*(Phase 2)*` row. Design/code contracts: `docs/CHALLENGES_PLAN.md` +
  `docs/CHALLENGES_IMPL_PLAN.md` (both now marked IMPLEMENTED, with the additive
  deltas listed). Residuals deferred to Phase 3 (unchanged): rules-identity
  comparability notice, verifiable command-log replay, save-file challenges,
  save-during-challenge persists challengeMode (today it reloads as a normal
  run — documented, harmless). Original scoping below (kept for provenance).
- **Persistence Phase 2 (seed challenges): SCOPED, review-hardened, OWNER-RATIFIED — was ready to implement (now DONE, see above).** Full scope in `docs/CHALLENGES_PLAN.md` (Draft v4, hardened by 3 adversarial review rounds — determinism premise independently verified; all 4+2 majors closed with mechanisms). Ratified owner decisions (2026-07-17, CHALLENGES_PLAN §10): (1) scoring default = **reputation, compare-raw** (registry supports cash/treated/died; per-challenge day); (2) rules identity = **no Phase-2 comparability warning** — deferred to Phase 3 after the pre-impl review showed both manual-version and auto-hash were poor trades (Phase 2 is honor-system + co-versioned on the live deploy); only the float-op determinism lint stays; (3) **debug commands disabled** at the CommandQueue in challenge mode; (4) **honor-system** (verifiable replay = Phase 3); (5) launch roster = a few curated built-ins + ad-hoc `?seed=&goal=` URLs; (6) **save-file challenges deferred to Phase 3** (narrows PERSISTENCE_PLAN §Phase 2). Design mechanisms: metric-agnostic `SCORE_METRICS` reading `DayReport` + `lifetimeTreated/Died` + the `gameOver` payload; two terminals (`dayEnded`→reached / `gameOver`→DNF) with a once-latch; a new `MidnightModalCoordinator` (BottomBarDropdowns pattern) owns which overlay opens at a day boundary; all URL parsing in one pure `src/sim/challenge.ts`. **Code plan DONE & reviewed:** `docs/CHALLENGES_IMPL_PLAN.md` (v2) — file manifest, frozen contract (World ctor `challengeMode=false`, pure `resolveBoot()`, `scoreChallenge()`, `controller.resolveIfTerminal()`), 2-track disjoint build order, test list; passed pre-implementation review (2 major fixed: rules-notice deferral + the `MidnightModalCoordinator` as sole synchronous `dayEnded` owner, killing the emit-order race). **Next step = implement** (freeze contract → Track 1 sim + Track 2 UI → 2 adversarial reviews → gates → commit). Residual non-blocking calls: exact metric set beyond reputation, curated roster content, flagship day-N, save-during-challenge handling. Needs only the Phase-1 determinism guarantees, now in place. Phase 1 owner rulings on record: paused-modal close restores speed 0 (deliberate DailyReportModal deviation), `?load=` persists in the URL like `?seed=`, map dims are baked into saves (comment beside `BALANCE.map`).
- **CI: live (2026-07-17).** `.github/workflows/ci.yml` runs the full gate (lint + `npm test` + `tsc --noEmit` + `vite build`) on every push to `master` and every PR — closes the gap that Vercel builds on push but does NOT run tests/lint. First run green in 29s. A red check = a regression that can't silently land or deploy.
- **Owner-requested design backlog:** GDD §11 items 14 (roaming volunteers) and 15 (family & visitors), plus wall signage in item 8 — all designed at sketch level, none implemented.
- **Balance watch:** the M4 pass tuned arrivals to 1.5/h and the wait-bonus threshold to 240m against the harness's then-6-room reference build (see `balance.ts` comments); the harness build now includes an Expansion-1 wing (12 rooms, capital bankrolled — operating envelope only). Expansion roster numbers are initial values: watch stroke (acuity 1, 20m CT → 120m ER) death rates at low rep, and OR contention (gallstones+appendicitis share it) — via the harness.

## Gotchas

- **Headless Chromium RESERVES `::-webkit-scrollbar` space but never PAINTS
  it** (found while verifying the finances scrollbar, 2026-07-18): the
  `/run-hospital-simms` driver's screenshots show a correctly-sized but empty
  band, which reads as a broken fix. Verify scrollbar//overlay-widget styling
  with a HEADED run (`HS_HEADED=1`) before believing a failure. Related CSS
  trap, since it cost a round: declaring `scrollbar-width` SILENTLY disables
  every `::-webkit-scrollbar*` rule in Chromium, and neither property reserves
  layout space under overlay scrollbars — `scrollbar-gutter: stable` is what
  reserves, the ::-webkit rules are what paint, and the two must not be mixed
  with `scrollbar-width`.
- **Windows + PowerShell 5.1.** No `&&`/`||` chaining (use `if ($?) { }`). Use the Write/Edit tools for file content — a `Get-Content`/`Set-Content` round-trip once mangled UTF-8 `§` chars (it happened AGAIN in the Stage-1 session — BOM + `—`→`â€"`; reverted via git checkout). Long commit messages: write to a scratch file and `git commit -F <file>` — multi-line here-strings to `git commit -m` have mis-parsed and leaked message text as pathspecs.
- `as const` balance tables produce literal types — widen explicitly where mutated (`cash: number = BALANCE...`).
- The dev server may already be running in a background task; Vite HMR picks up edits.
- Queue slot tiles clamp at obstacles and stack (documented); reception's door orientation matters for queue room (see `newGame.ts` comment).
- `debugWalkTo` command is test/debug-only; idle clicks select patients.
- Review agents: give them the docs as contract + explicit hunt list + severity format; they've each earned their cost (picking off-by-half-tile, pause deadlock, spawn-rate inflation ×1.8, reservation stalls, the v1 candidate-pool starvation).
- **Proven parallel-milestone workflow** (save/load + Expansion 1, owner-endorsed): orchestrator freezes a contract first (API skeleton / data-table ids / shared exports), then 2–3 parallel implementation agents with DISJOINT file ownership (sim+test / ui+main+index.html / render), each verifying tsc+lint scoped to its own files; then two parallel adversarial reviewers with split lenses (code/contract vs live-drive via `/run-hospital-simms`); fix ALL findings + regression test per major; gates; HANDOFF update; commit. Reviewers run only AFTER implementers finish — they diff the working tree.
