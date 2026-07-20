# Invariants — do not regress

Every entry below was established by an adversarial review or a shipped
milestone and is protected by at least one regression test. **Read this before
changing sim behaviour**; `docs/HANDOFF.md` is the orientation doc and points
here rather than repeating it.

If you are about to violate one of these, that is a design decision requiring
its own review — not a refactor.

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
- **Treatment fees are scaled by `feeScale` at the SINGLE billing site** (ECONOMY
  Stage-1, `treatment.ts` via `formulas.scaledFee`): `patient.billed` and the
  ledger both use the scaled fee, so the inspect card and finances agree; VENDING
  is not treatment revenue and is never scaled. Uniform, so the elective==emergency
  anchor holds. Regression: `test/economyStage1.test.ts`.
- **Utilities accrue hourly in `updateEconomy`** (ECONOMY Stage-1): an always-on
  HVAC base on EVERY room (footprint tiles × rate) + a USAGE draw on each EQUIPMENT
  room that is ACTIVE that hour (holds ≥1 reservation). A broken/closed room holds
  no reservation, so it draws only the base — no double-penalty. Tallied
  `utilities`. Regression: `test/economyStage1.test.ts`.
- **Every EQUIPMENT room stays net-positive under the shipped usage rates** (ECONOMY
  Stage-1, the load-bearing per-type invariant): `usagePerActiveHour` is PER-TYPE
  (`≈0.52 × measured rev-per-active-hour`), NOT a flat per-tile/per-hour rate — a
  flat rate sinks low-volume rooms (xray/CT) and reverses the outpatient milestone.
  Regression: `test/economyStage1.test.ts` runs REFERENCE and asserts each equipment
  room's revenue − utilities − repairs ≥ 0.
- **Repairs charge per-type on COMPLETION** (ECONOMY Stage-1): `world.completeRepair`
  is the sole charge site (the dispatcher's repair-done branch), debits
  `BALANCE.economy.repairCost[type]`, tallies `repairs`; a never-broken room is
  never charged. Regression: `test/economyStage1.test.ts`.
- **The mature operating margin sits ~32%, not ~82%** (ECONOMY Stage-1): the
  collapse is the point of the milestone — cost decisions must matter (2× payroll →
  ~6%). `TALLY_KEY_VERSIONS {utilities:12, repairs:12}` gates v11 loads (else
  `asNumber(undefined)` throws). Regression: `test/economyStage1.test.ts` margin
  band (0.25–0.40) + `save.test.ts` v11→v12→v13 back-compat.
- **SHIFTS Stage-1 is LIVE (SAVE_VERSION 13, deployed 2026-07-20).** `Staff.shift`
  (`day`/`night`/`null`) and `onFloor` are SAVED. `null` = always-on (test rosters and
  pre-shift entities); real hires get a shift. The load-bearing rules:
  - **The wage factor lives in ONE place** — `economy.ts` charges `salaryPerDay ×
    shiftWageMultiplier(shift)` (0.6 for shifted). The hire path assigns `shift` ONLY;
    NEVER pre-scale `salaryPerDay` (double-count — it bit the probe itself, PROBE REVIEW
    2). Pinned: `economyStage1.test.ts` "SHIFTS wage mechanism".
  - **`onFloor` is SAVED, not derived** — a staffer mid-walk-home would derive wrong and
    break save→load→run determinism. Every all-staff iteration that PLACES a staffer in
    the world MUST exclude `!onFloor`: `isTileClaimed`, renderer sprite loop + `pickAt`,
    build/expand/sell occupancy (`build.ts`), AND `staffNearby` (`wayfinding.ts` — the
    one missed in review; off-floor staff cluster on the entrance tile and would rescue
    lost patients at the door). Adding a new all-staff placement loop? Add the guard.
  - **`updateShifts` runs BEFORE `updateDispatcher`** and keys `busy` on reservation
    PHASES + `duty.kind==='job'`, NOT `member.duty` (which stays pinned to a gathering
    bay while a second promotes to active — a `duty`-based check would abandon a live
    bay). Off-shift gathering bays are cancelled unconditionally (mirror `fireStaff`),
    so the ungated `promoteGatheredReservations` can't promote an off-shift gather.
  - **The clock offset is its OWN constant** (`BALANCE.time.dayStartMinute`), NOT
    `shifts.day.startMinute` — the probe sweeps the day window and the clock phase must
    stay put; a drift-pin test asserts they're equal. Day rollover stays on the raw tick
    (`isDayRollover`); the 06:00 re-base re-phases the spawn RNG stream, so spawn-
    dependent suites re-baseline WITH any change to it.
  - **v<13 load mints a night roster** (`migrateMintNightRoster` in `loadWorld`, after
    `restorePrivateState` so twin ids can't collide) — deterministic, no rng, no
    `staffHired` emit. Regressions: `test/shifts.test.ts` (18), `save.test.ts` v12→v13.
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


## The outpatient stream (2026-07-19, SAVE_VERSION 11)

- **An ELECTIVE condition is pre-triaged BY CONSTRUCTION** — `spawnPatient`
  defaults `acuity` from the condition when the caller omits it. The default
  lives at the CONSTRUCTOR, not the caller, and that placement is the
  invariant: `debugSpawnPatient` (and any test fixture) would otherwise mint a
  referral with `acuity: null`, which `processCheckIn` routes to `waiting`,
  tripping the guard that makes the stage widening safe. **Found by
  live-drive; the whole 674-test suite passed while it was live.**
- **`checkingIn → waiting` is legal ONLY because `waiting` still requires
  `acuity !== null`.** The stage table was widened deliberately for referrals;
  the paired semantic invariant in `setPatientStage` is what stops the
  shortcut being used to smuggle an untriaged emergency into the treatment
  queue. Never relax the acuity check to "simplify" the table.
- **The two arrival streams are DERIVED from the condition table, never
  hand-kept.** `ElectiveConditionId` is a type-level filter over
  `CONDITION_DEFS`, which is why `elective?: true` (not `boolean`) — a boolean
  would not narrow. `conditionElective()` is the ONE accessor, matching the
  `roomFailure`/`roomStaffRatio` widening idiom.
- **`rollCondition` iterates `EMERGENCY_CONDITION_IDS`, not `CONDITION_IDS`** —
  which also stops its float-residue fallback returning an elective.
- **Elective ids carry `conditionWeights: 0`, and that is a COMPILE
  requirement** (`formulas.ts` indexes the table by `ConditionId`), not a
  balance choice. Zero also keeps `rollCondition`'s running total unchanged,
  which is what keeps the emergency stream bit-identical until the elective
  Bernoulli first fires.
- **The clinic-hours check sits OUTSIDE `rng.chance`, the room-gate INSIDE.**
  `chance` consumes a draw unconditionally, so the guard placement is what
  makes every pre-clinic tick bit-identical to the pre-change build — a real
  control window, pinned by test. Moving the hours check inside would diverge
  the stream on every tick.
- **The elective stream is ROOM-GATED** (`rollElectiveCondition` returns null
  when the player owns no elective modality). Ungated it buries a new hospital
  in referrals it cannot serve (~−80 rep/day against a starting 300) and
  splits volume too thin to saturate anything. Gating is what makes it opt-in.
- **`electiveNoShowLoss` is a SEPARATE number from `amaLoss`.** Flat `amaLoss`
  against the +2 an elective discharge earns puts break-even at a 20% walkout
  rate, and the baseline is ~25% — the stream would be reputation-negative in
  expectation. Do NOT "simplify" by acuity-scaling `amaLoss`: that is shared
  emergency behaviour.
- **Electives are excluded from the door-to-treatment wait AVERAGE.** They skip
  triage and would otherwise deflate it and cheapen the day-close bonus.
  `firstTreatedAtTick` is still stamped — that is per-patient provenance, not a
  hospital metric.
- **`electiveTreated`/`electiveNoShow` are SUBSETS** of
  `arrivals`/`treated`/`leftAma`, never additions. Do not sum them into
  totals.
