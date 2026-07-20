/**
 * SSOT for every tunable number in the game (tech plan §3.1 rule 1).
 * Values are the GDD's initial balance; this file is authoritative.
 * Durations are authored in GAME-MINUTES; clock.ts owns all conversions to ticks.
 */
import type { RoomType } from './rooms';

export const BALANCE = {
  time: {
    ticksPerSecond: 10,
    gameDayRealMinutes: 8, // 1 game day = 8 real minutes at 1× speed
  },
  /** The 1–5 scale shared by acuity, staff skill, and patient wayfinding
   *  (SSOT — audit #7: rng rolls, UI star rows, and formula spans derive it). */
  stats: {
    min: 1,
    max: 5,
    /** Health/patience scale ceiling (SSOT audit #1): spawn values and UI bars share it. */
    vitalsMax: 100,
  },
  map: {
    /** Map dims are BAKED INTO SAVES (the grid RLE is cols×rows tiles and
     *  loadWorld rejects any other total) — changing them requires a
     *  SAVE_VERSION bump + migration, or every existing save is refused. */
    cols: 40,
    rows: 40,
    /** Entrance is fixed on the south edge (GDD §5). */
    entrance: { col: 20, row: 39 },
  },
  economy: {
    startingCash: 50_000,
    hireFee: 100,
    roomSellbackRatio: 0.5,
    bankruptcyThreshold: -10_000,
    /** Cash must stay below the threshold this long to lose (GDD §2). */
    bankruptcyGraceGameMinutes: 24 * 60,
    /**
     * ECONOMY Stage-1 (ECONOMY_STAGE1_CONTRACT v2): collapse the measured ~82%
     * operating margin to ~32% so cost decisions matter. Derived from the
     * early-game probe (test/economyProbe.test.ts), reviewed twice.
     */
    /** Uniform multiplier on every TREATMENT fee (vending exempt); applied via
     *  formulas.scaledFee at the single billing site. 0.72 (not the probe's 0.68)
     *  because the sim's hourly-sampled utilities run ~14% above the probe's
     *  per-tick estimate — tuned to the REAL sim (regression-of-record): lands
     *  the mature build ~32% and keeps the minimal starter net-positive. */
    feeScale: 0.72,
    /** Always-on HVAC/lighting, $/footprint-tile/game-hour, ALL rooms. */
    utilitiesPerTileHour: 0.05,
    /** Usage draw, $ per ACTIVE room-hour, EQUIPMENT rooms only (a room drawing
     *  a reservation this hour). Rates = round(0.52 × measured rev-per-active-hour)
     *  so each equipment room keeps ~24% margin; a missing type draws no usage. */
    usagePerActiveHour: {
      mri: 163, ct: 165, nucMed: 134, xray: 81, ultrasound: 110, dialysis: 112, surgery: 374,
    } as Partial<Record<RoomType, number>>,
    /** Parts/materials charged when a repair COMPLETES (per room type). Makes
     *  neglect a cash decision, not just downtime. */
    repairCost: {
      mri: 1_800, ct: 1_200, nucMed: 1_200, surgery: 1_500, xray: 400, dialysis: 600,
      restroom: 200, resp: 200,
    } as Partial<Record<RoomType, number>>,
  },
  arrivals: {
    /** M4 balance pass: 3.0 overwhelmed a full 6-room build (~50 arrivals vs
     *  ~23 treatable/day → rep death-spiral to double digits by day 4); 2.0
     *  still oscillated (recovering rep re-floods the queues). 1.5 puts
     *  starting arrivals just above that build's throughput — busy, climbable. */
    basePatientsPerGameHour: 1.5,
    /**
     * Piecewise multiplier blocks covering the whole day (GDD §3). Blocks are
     * NON-uniform — a block applies to hours [previous untilHour, untilHour).
     */
    timeOfDayCurve: [
      { untilHour: 6, multiplier: 0.3 },
      { untilHour: 10, multiplier: 0.8 },
      { untilHour: 14, multiplier: 1.3 },
      { untilHour: 18, multiplier: 1.5 },
      { untilHour: 22, multiplier: 1.0 },
      { untilHour: 24, multiplier: 0.5 },
    ],
    reputationMultiplierMin: 0.5,
    reputationMultiplierMax: 2.0,
    /** Per-condition spawn weights (GDD §3 condition mix); renormalized after the case-mix shift. */
    conditionWeights: {
      flu: 30,
      laceration: 20,
      fracture: 15,
      asthma: 15,
      pneumonia: 10,
      chestPain: 10,
      // Expansion 1 (GDD §12): 48 added against the existing 100 keeps the
      // early game recognizably V1; the §7 case-mix shift grows these with rep.
      kidneyStones: 8,
      backInjury: 8,
      thyroid: 6,
      kidneyFailure: 6,
      gallstones: 6,
      headInjury: 5,
      appendicitis: 5,
      stroke: 4,
      // ELECTIVE conditions are ZERO here, and that is a COMPILE requirement,
      // not a balance choice: `formulas.conditionSpawnWeights` indexes this
      // table by `ConditionId`, so a missing key does not typecheck. Zero also
      // keeps `rollCondition`'s running total unchanged, which is what makes
      // the emergency stream bit-identical until the elective Bernoulli first
      // fires (OUTPATIENT_IMPL_PLAN §4). They spawn from `outpatient.weights`.
      mriScan: 0,
      nucMedScan: 0,
    },
    /**
     * The scheduled outpatient stream (OUTPATIENT_IMPL_PLAN §3.2). Deliberately
     * NOT a share of `conditionWeights`: referrals arrive on clinic hours
     * rather than the emergency time-of-day curve, and the two volumes must be
     * tunable — and measurable — apart.
     *
     * Also deliberately NOT scaled by `reputationArrivalMultiplier`: referrals
     * are contracted work, not walk-in demand. Recorded as a choice (§2.5).
     */
    outpatient: {
      /**
       * Referrals per game-hour inside clinic hours, BEFORE room-gating.
       *
       * MEASURED, and 1.0 was rejected (OUTPATIENT_IMPL_PLAN §10). Both the
       * plan and the design review proposed 1.0; the probe tripped the plan's
       * own falsification condition on BOTH layout arms — deaths 3.2 -> 4.2,
       * walkouts 39.0 -> 45.0, surgeries 10.4 -> 8.2, i.e. the stream was
       * starving the ED through radTech (24% -> 56%).
       *
       * A THIRD radiographer did not repair it (deaths rose further, to 4.8),
       * which falsifies the review's "the pressure is the point, hiring is the
       * answer" reasoning — recorded so nobody re-derives it.
       *
       * At 0.5 deaths (3.4) and walkouts (40.4) sit at baseline while MRI
       * still runs 4.3x its old utilisation (3.9% -> 16.8%) and nucMed 4.1x.
       * Surgeries at 9.2 vs 10.4 is the honest residual cost.
       */
      perGameHour: 0.5,
      openHour: 8,
      closeHour: 18,
      /**
       * Weights over elective conditions, renormalised over the modalities the
       * player has actually BUILT (§2 room-gating). Ungated and split four
       * ways this reached only ~12.5% MRI utilisation — clearing the plan's own
       * 8% failure line while still missing saturation by an order of
       * magnitude, so Departments Stage 2a would have stayed blocked.
       */
      weights: { mriScan: 10, nucMedScan: 6 },
    },
    /** Conditions with acuityMin ≤ this are "referral-grade" and shift with reputation (GDD §7). */
    referralAcuityMax: 2,
    /** Referral-grade weights scale by 1 + factor × (rep − starting)/(max − starting). */
    caseMixShiftFactor: 0.5,
  },
  /** Reception check-in (GDD Flow rule 1). */
  reception: {
    checkInGameMinutes: 5,
    queueDepthTiles: 6,
  },
  triage: {
    durationGameMinutes: 10,
  },
  /** Indexed by acuity 1–5 (index 0 unused). Points per game-hour (GDD §6). */
  decay: {
    healthPerGameHour: [NaN, 12, 8, 5, 3, 2],
    patiencePerGameHour: [NaN, 3, 5, 8, 10, 12],
    /** Untriaged patients decay at this acuity's rates (Flow rule 2). */
    untriagedAcuity: 3,
    /** Patience decay multiplier while standing in a full waiting room (Flow rule 4). */
    standingMultiplier: 1.5,
    /** GDD §5 "roomier rooms slow patience decay" (audit #4): multiplier
     *  1 − factor × waiting-room quality, floored like treatment duration. */
    waitingQualityFactor: 0.02,
    waitingQualityFloor: 0.7,
  },
  treatment: {
    /** P(success) = clamp(base + perSkill*(skill-1) - lowHealthPenalty*max(0,(lowHealthFloor-health)/lowHealthFloor)) */
    successBase: 0.7,
    successPerSkill: 0.06,
    lowHealthPenalty: 0.2,
    lowHealthFloor: 30,
    successMin: 0.5,
    successMax: 0.98,
    /** Failed roll = complication: health penalty + repeat the step (GDD §2). */
    complicationHealthPenalty: 15,
    /** Duration multiplier: (skillBase - skillFactor × skill) (GDD §2 treatment resolution). */
    durationSkillBase: 1.3,
    durationSkillFactor: 0.1,
    durationQualityFactor: 0.02,
    /** Quality can never speed a treatment beyond this multiplier (exploit guard). */
    durationQualityFloor: 0.7,
    /**
     * ED epic Stage B1 — the attention penalty. A ratio staffer split across
     * N bays treats each one more SLOWLY: effective skill drops by this much
     * per extra concurrent patient (ED_PLAN §7.5 — most of a stay is spent
     * waiting on shared resources; contention made visible as TIME, the
     * currency the player already reads). Without it, sharing is free and a
     * second ED nurse is strictly dominated below the ratio cap, while a
     * skill-5 nurse becomes worth 4× more in the ER than anywhere else —
     * inverting the hiring market `salaryPerSkillStep` is priced for.
     * DURATION ONLY: `successChance` stays on RAW skill, because deaths are
     * the ED's loudest signal and must stay tied to a health/acuity story
     * rather than to staffing arithmetic. At load 1 the penalty is 0, so
     * every non-ratio room is bit-identical to pre-B1.
     */
    attentionSkillPenaltyPerPatient: 0.5,
  },
  reputation: {
    starting: 300,
    max: 1000,
    dischargeGainMin: 2,
    dischargeGainMax: 8,
    deathLoss: 25,
    amaLoss: 8,
    /**
     * An elective no-show is not an abandoned emergency
     * (OUTPATIENT_IMPL_PLAN §3.6). Flat `amaLoss` against the +2 an elective
     * discharge earns (`dischargeReputationGain(5)`) puts break-even at a 20%
     * walkout rate — and the measured baseline is already ~25%, with electives
     * sorting LAST. The stream would have been reputation-NEGATIVE in
     * expectation, silently, in a channel with no UI.
     *
     * Symmetric with that +2, so the stream is reputation-neutral at any
     * service level. Deliberately a NEW local number rather than acuity-scaling
     * `amaLoss`: that is shared emergency behaviour and must not ride in under
     * an outpatient milestone (design review MAJOR 4).
     */
    electiveNoShowLoss: 2,
    dayCloseWaitBonus: 10,
    /** M4 balance pass: 120 was unreachable — even an overstaffed 6-room build
     *  bottoms out ~230m door-to-first-treatment (check-in + triage + walking
     *  are ~4h structural). 240 makes the bonus reward keeping up with demand. */
    dayCloseWaitThresholdGameMinutes: 240,
  },
  wayfinding: {
    /** Wrong-turn chance per tile step = perTileBase × (statCeiling − wayfinding) (GDD §3). */
    wrongTurnPerTileBase: 0.004,
    wrongTurnStatCeiling: 6,
    guidanceAuraRadius: 8,
    staffRescueRadius: 3,
    comfortAuraPatienceMultiplier: 0.75,
    selfRecoveryChance: 0.2,
    selfRecoveryRollGameMinutes: 5,
    lostReservationTimeoutGameMinutes: 60,
  },
  hiring: {
    candidatesPerRole: 3,
    /** Candidate salary = role base × (1 + (skill − 3) × this). */
    salaryPerSkillStep: 0.08,
  },
  /** Ticks a dead patient remains visible before removal (render fade window). */
  deathFadeTicks: 30,
  movement: {
    patientTilesPerSecond: 1.4,
    staffTilesPerSecond: 1.8,
  },
  dispatcher: {
    /** effectivePriority = acuity − agingPerHourWaited × hoursWaited (Flow rule 6). */
    agingPerHourWaited: 0.5,
    /**
     * Hold before the dispatcher retries a patient whose reservation was
     * cancelled (Flow rule 8) — without it, cancel + re-queue restores the
     * exact state that created the doomed reservation, once per tick, forever.
     */
    cancelRetryGameMinutes: 5,
    /**
     * How long a patient must have been waiting before a room/role SHORTAGE
     * is reported (ED B1, owner ask: "continued hints if we need more
     * particular staff to cover areas"). Every 1:1 room is momentarily
     * "all staff busy" between patients, and hinting on that would be exactly
     * the transient noise the existence-based need scan avoids. A patient who
     * has waited this long is blocked by a real shortage, not by a staffer
     * mid-walk.
     */
    capacityHintWaitGameMinutes: 45,
  },
  /** Mood-bubble thresholds (GDD §10). `criticalHealthBelow` is shared by
   *  `moodOf` AND the Stage-2 vomit-eligibility gate (one threshold SSOT). */
  mood: {
    criticalHealthBelow: 30,
    impatientPatienceBelow: 30,
  },
  /** Messes & cleanliness (amenities Stage 2, AMENITIES_PLAN §4). */
  mess: {
    /** Per-tick Bernoulli mass for sub-critical-health patients in the
     *  frozen eligibility stage set (impl plan §S2.1). */
    vomitPerGameHour: 1.2,
    /** One-time hit on the vomiter (same clamp rule as accidents). */
    vomitSelfPatienceHit: 5,
    /** A vending user's litter goes into a non-full can within this
     *  Chebyshev radius; otherwise it hits the floor. */
    litterTrashcanRadius: 4,
    /** Uses until a trashcan overflows (empty job + overflow mess). */
    trashcanCapacity: 8,
    /** Patience decay multiplier near a mess (once, not per mess). */
    patienceMultiplier: 1.25,
    patienceRadius: 3,
    /** Day-close reputation: spotless day (with arrivals) bonus… */
    cleanDayRepBonus: 2,
    /** …else −1 rep per this many mess-hours, capped per day. */
    messHoursPerRepPoint: 4,
    dailyRepCap: 15,
    /** Job base durations (skill-scaled via treatmentDurationTicks). */
    cleanGameMinutes: 2,
    emptyGameMinutes: 1,
    /** Failed-probe retry hold (the dispatchHoldUntil analogue). */
    jobRetryGameMinutes: 5,
    /** The `role:evs` hint promotes to URGENT at this many standing messes
     *  (moved here from needs.ts — SSOT §3.1, Stage-2 code review NIT). */
    evsUrgentMesses: 3,
  },
  rooms: {
    /** Quality bonus per tile above minimum footprint (GDD §5). */
    qualityPerExtraTile: 1,
  },
  /** Finances window (FINANCE_PLAN §9.3, owner ruling §7 Q4: show 7, store
   *  30). `historyCapDays` is TRIMMED on load, never a load-time reject —
   *  lowering it must not brick existing saves (plan review MAJOR 7). */
  finance: {
    historyShownDays: 7,
    historyCapDays: 30,
  },
  /** Room failures & repair (amenities Stage 3, AMENITIES_PLAN §5). */
  maintenance: {
    /** Per-use breakdown-probability slope: p = wearFactor × wear, rolled
     *  at each use completion (formulas.breakdownChance — the ONE
     *  derivation). MTBFs ≈31 uses mechanical / ≈45 piping (§5.1) —
     *  HARNESS-TUNED before ship. */
    wearFactor: { mechanical: 0.002, piping: 0.001 },
    /** Repair base duration, skill-scaled via treatmentDurationTicks. */
    repairGameMinutes: 15,
    /** A piping burst drops this many `water` messes (rng-inclusive). */
    burstMessesMin: 2,
    burstMessesMax: 4,
  },
  /** Patient need meters + side-trips (amenities epic Stage 1,
   *  AMENITIES_PLAN §3.1–3.2). Meters share the vitals 0–100 scale. */
  needs: {
    /** Stage-3 balance pass (owner report 2026-07-18 "bathrooms don't look
     *  used", verified by harness probe: ~25 visits per 5 days at the old
     *  10/h + 60-floor — patients were treated long before their ~4.5h
     *  time-to-seek). 12/h + spawn floor 45 puts the average waiter at
     *  ~3.1h to seek, in range of real door-to-treatment times.
     *  ADOPT-UNLESS-VETOED (flagged in HANDOFF). */
    bladderPerGameHour: 12,
    thirstPerGameHour: 8,
    /** Below this a waiting patient seeks the matching amenity. */
    seekThreshold: 35,
    /** Patience decay multiplier PER unmet need (multiplies into the
     *  standing/quality/comfort stack — M3-gate composition ruling). */
    unmetPatienceMultiplier: 1.25,
    /** Bladder-0 accident: one-time patience hit; clamped to the floor in
     *  non-AMA-eligible stages (checkingIn/reserved) so accidents never
     *  mint a new fail state (design principle 3). */
    accidentPatienceHit: 20,
    accidentPatienceFloor: 1,
    restroomUseGameMinutes: 3,
    vendingUseGameMinutes: 1,
    /** A break that never reached `using` is abandoned after this long.
     *  Stage-3 balance pass (the owner's "bathrooms don't look used"
     *  report, root-caused by harness trace): walking is ~2.1 game-min per
     *  TILE (1.4 tiles/s real at 8 real-min days), so the original 30 only
     *  covered a ~14-tile walk — the watchdog was aborting nearly every
     *  legitimate cross-map trip mid-walk (373 claims → 23 completions on
     *  seed 1341), wedging stalls and cascading into accidents. 120 covers
     *  the full map with wrong-turn slack; genuinely lost claimants still
     *  abandon within 2 game-hours. ADOPT-UNLESS-VETOED. */
    breakWatchdogGameMinutes: 120,
    /** Retry hold after ANY failed/abandoned break (the dispatchHoldUntil
     *  analogue — a doomed side-trip must not rearm every tick). */
    breakRetryGameMinutes: 15,
    /** Charged per vending use through billFee (revenue). */
    vendingPrice: 5,
    /** Spawn meter roll floor (max = stats.vitalsMax). Stage-3 balance
     *  pass: 60 → 45 (see bladderPerGameHour note). */
    spawnMeterMin: 45,
    /** Plant comfort-aura radius — Chebyshev (a square patch around the
     *  pot). DELIBERATELY different from room auras, which are Euclidean
     *  (`auraCoversTile`): a 1-tile prop reads fine as a square, and the
     *  cheap check is test-pinned in `plantCoversTile` (code review MINOR). */
    plantAuraRadius: 2,
  },
} as const;
