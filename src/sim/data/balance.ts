/**
 * SSOT for every tunable number in the game (tech plan §3.1 rule 1).
 * Values are the GDD's initial balance; this file is authoritative.
 * Durations are authored in GAME-MINUTES; clock.ts owns all conversions to ticks.
 */
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
  },
  reputation: {
    starting: 300,
    max: 1000,
    dischargeGainMin: 2,
    dischargeGainMax: 8,
    deathLoss: 25,
    amaLoss: 8,
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
  },
  /** Mood-bubble thresholds (GDD §10); formulas.ts `moodOf` is the only reader. */
  mood: {
    criticalHealthBelow: 30,
    impatientPatienceBelow: 30,
  },
  rooms: {
    /** Quality bonus per tile above minimum footprint (GDD §5). */
    qualityPerExtraTile: 1,
  },
} as const;
