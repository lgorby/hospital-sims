import { GAME_MINUTES_PER_HOUR, GAME_MINUTES_PER_TICK, gameMinutesToTicks } from './clock';
import { AMENITY_DEFS, type AmenityId } from './data/amenities';
import { BALANCE } from './data/balance';
import {
  SCORE_METRICS,
  type ChallengeContext,
  type ChallengeGoal,
} from './data/challenges';
import { CONDITION_DEFS, CONDITION_IDS, type ConditionId } from './data/conditions';
import { FINANCE_CATEGORIES, type CashTotals } from './data/finance';
import type { RoleId } from './data/roles';
import {
  RETIRED_ROOMS,
  ROOM_DEFS,
  roomRetired,
  roomStaffRatio,
  type PropDensity,
  type RoomCategory,
  type RoomFailure,
  type RoomType,
} from './data/rooms';
import { dayNet } from './dailyStats';
import { rectTiles, type GridPoint, type Rect } from './types';

/**
 * Derived-value SSOT (tech plan §3.1 rule 4): every formula lives here as one
 * pure function, called by the sim AND any UI that displays the value.
 */

/** Dispatcher sort key — lower serves first. Aging prevents starvation (Flow rule 6). */
export function effectivePriority(acuity: number, hoursWaited: number): number {
  return acuity - BALANCE.dispatcher.agingPerHourWaited * hoursWaited;
}

/** GDD §2 Treatment resolution. */
export function successChance(averageSkill: number, health: number): number {
  const t = BALANCE.treatment;
  const lowHealth = Math.max(0, (t.lowHealthFloor - health) / t.lowHealthFloor);
  const p = t.successBase + t.successPerSkill * (averageSkill - 1) - t.lowHealthPenalty * lowHealth;
  return Math.min(t.successMax, Math.max(t.successMin, p));
}

/**
 * ED epic Stage B1: how many concurrent reservations one staffer of `role`
 * may hold in a room of `roomType`. THE reader for `RoomDef.staffRatio` —
 * absent room, absent role and every non-ratio room all answer 1, which is
 * the pre-B1 exclusive binding.
 */
export function staffRatioFor(roomType: RoomType, role: RoleId): number {
  return roomStaffRatio(roomType)?.[role] ?? 1;
}

/**
 * ED epic Stage B1 — effective skill for DURATION at concurrent `load`
 * (1 = undivided attention, and then this is the identity). Clamped to the
 * `BALANCE.stats` 1–5 scale, which is the scale SSOT (audit #7).
 * `successChance` deliberately does NOT consume this — see the balance
 * comment on `attentionSkillPenaltyPerPatient`.
 */
export function attentionSkill(skill: number, load: number): number {
  const penalty = BALANCE.treatment.attentionSkillPenaltyPerPatient * Math.max(0, load - 1);
  return Math.min(BALANCE.stats.max, Math.max(BALANCE.stats.min, skill - penalty));
}

/** GDD §2: duration = base × skill modifier × quality modifier, in ticks. */
export function treatmentDurationTicks(
  baseGameMinutes: number,
  averageSkill: number,
  roomQuality: number,
): number {
  const t = BALANCE.treatment;
  const skillMod = t.durationSkillBase - t.durationSkillFactor * averageSkill;
  // Floored: room cost is flat per type, so unbounded quality would make an
  // oversized room an infinite-throughput exploit (M2 review #5).
  const qualityMod = Math.max(
    t.durationQualityFloor,
    1 - t.durationQualityFactor * roomQuality,
  );
  return Math.max(1, Math.round(gameMinutesToTicks(baseGameMinutes) * skillMod * qualityMod));
}

/** GDD §7: +8 for an acuity-1 save down to +2 for an acuity-5 discharge. */
export function dischargeReputationGain(acuity: number): number {
  const r = BALANCE.reputation;
  const span = r.dischargeGainMax - r.dischargeGainMin;
  const acuitySpan = BALANCE.stats.max - BALANCE.stats.min;
  return Math.round(r.dischargeGainMax - ((acuity - BALANCE.stats.min) * span) / acuitySpan);
}

/** Decay tables are points per game-hour (GDD §6); systems tick in ticks. */
export function healthDecayPerTick(acuity: number | null): number {
  const a = acuity ?? BALANCE.decay.untriagedAcuity;
  return (BALANCE.decay.healthPerGameHour[a]! * GAME_MINUTES_PER_TICK) / GAME_MINUTES_PER_HOUR;
}

export function patienceDecayPerTick(acuity: number | null): number {
  const a = acuity ?? BALANCE.decay.untriagedAcuity;
  return (BALANCE.decay.patiencePerGameHour[a]! * GAME_MINUTES_PER_TICK) / GAME_MINUTES_PER_HOUR;
}

/** Need meters (amenities Stage 1, §3.1): BALANCE.needs rates are authored
 *  per game-hour like the decay tables; one conversion for sim and tests. */
export function meterDecayPerTick(ratePerGameHour: number): number {
  return (ratePerGameHour * GAME_MINUTES_PER_TICK) / GAME_MINUTES_PER_HOUR;
}

/** GDD §5: a roomier waiting room slows patience decay for its seated waiters
 *  (audit #4). Floored — like treatment duration — so oversized rooms can't
 *  freeze patience entirely. */
export function waitingQualityMultiplier(roomQuality: number): number {
  const d = BALANCE.decay;
  return Math.max(d.waitingQualityFloor, 1 - d.waitingQualityFactor * roomQuality);
}

/** GDD §3: linear 0.5×–2.0× arrival multiplier over rep 0–1000. */
export function reputationArrivalMultiplier(reputation: number): number {
  const a = BALANCE.arrivals;
  const t = Math.min(1, Math.max(0, reputation / BALANCE.reputation.max));
  return a.reputationMultiplierMin + (a.reputationMultiplierMax - a.reputationMultiplierMin) * t;
}

/**
 * GDD §3 condition mix + §7 case-mix shift: base weights, with referral-grade
 * conditions (acuityMin ≤ referralAcuityMax) scaled by reputation. Weights are
 * relative — the spawner rolls against their sum, so no explicit renormalize.
 */
export function conditionSpawnWeights(reputation: number): Record<ConditionId, number> {
  const a = BALANCE.arrivals;
  const r = BALANCE.reputation;
  const shift = Math.max(
    0,
    1 + a.caseMixShiftFactor * ((reputation - r.starting) / (r.max - r.starting)),
  );
  const weights = {} as Record<ConditionId, number>;
  for (const id of CONDITION_IDS) {
    const referral = CONDITION_DEFS[id].acuityMin <= a.referralAcuityMax;
    weights[id] = a.conditionWeights[id] * (referral ? shift : 1);
  }
  return weights;
}

/** Piecewise time-of-day multiplier (GDD §3). */
export function timeOfDayMultiplier(hourOfDay: number): number {
  for (const block of BALANCE.arrivals.timeOfDayCurve) {
    if (hourOfDay < block.untilHour) return block.multiplier;
  }
  return BALANCE.arrivals.timeOfDayCurve[BALANCE.arrivals.timeOfDayCurve.length - 1]!.multiplier;
}

/**
 * Mood at a glance (GDD §10 bubbles; the M3 thought log reuses the same
 * moments). One reader for the thresholds — render and UI never re-derive.
 */
export type Mood = 'content' | 'impatient' | 'critical';
export function moodOf(health: number, patience: number): Mood {
  if (health < BALANCE.mood.criticalHealthBelow) return 'critical';
  if (patience < BALANCE.mood.impatientPatienceBelow) return 'impatient';
  return 'content';
}

/** GDD §3: wrong-turn chance per tile step; zero inside a guidance aura (caller checks). */
export function wrongTurnChance(wayfindingStat: number): number {
  const w = BALANCE.wayfinding;
  return w.wrongTurnPerTileBase * (w.wrongTurnStatCeiling - wayfindingStat);
}

/** Candidate salary from role base and skill (GDD §4 hiring pool tradeoffs). */
export function candidateSalary(baseSalary: number, skill: number): number {
  const baseline = (BALANCE.stats.min + BALANCE.stats.max) / 2;
  return Math.round(baseSalary * (1 + (skill - baseline) * BALANCE.hiring.salaryPerSkillStep));
}

/** Area of a room's minimum footprint — the denominator of the per-tile rate. */
function minArea(roomType: RoomType): number {
  return ROOM_DEFS[roomType].minCols * ROOM_DEFS[roomType].minRows;
}

/**
 * Capacity epic Stage 0 (CAPACITY_PLAN §4.1, owner ruling "size affects
 * cost"): the per-tile price of growing a room beyond its minimum footprint.
 * Derived from the table (`ceil(cost / minArea)`) — zero new balance numbers.
 */
export function perTileRate(roomType: RoomType): number {
  return Math.ceil(ROOM_DEFS[roomType].cost / minArea(roomType));
}

/**
 * THE room price (CAPACITY_PLAN §4.1): base cost + per-tile rate on every
 * tile beyond the minimum footprint. One formula prices a NEW build and (in
 * Stage B) an EXPANSION — no arbitrage between "build big" and "grow later".
 * A minimum-size rect (either orientation — the areas are equal) prices at
 * exactly the table cost. The max(0, …) is defensive; validation rejects
 * sub-minimum rects before money moves.
 */
export function priceOf(roomType: RoomType, rect: Rect): number {
  const extraTiles = Math.max(0, rect.cols * rect.rows - minArea(roomType));
  return ROOM_DEFS[roomType].cost + perTileRate(roomType) * extraTiles;
}

/**
 * Stage B (CAPACITY_PLAN §4): the cost of growing a built room — the SAME
 * `priceOf` curve, so "build big" and "build small, grow later" cost
 * identically (no arbitrage between the paths, by construction).
 */
export function expandPrice(roomType: RoomType, oldRect: Rect, newRect: Rect): number {
  return priceOf(roomType, newRect) - priceOf(roomType, oldRect);
}

/**
 * GDD §5 sell-back refund (SSOT audit #2): the sim's payout AND the UI's
 * button label. Rect-aware since Stage 0 (CAPACITY_PLAN §4.1): the refund
 * derives from what the SAME rect would cost today — no amount-paid
 * bookkeeping. Known, accepted quirk: rooms built oversized BEFORE the
 * size-based economy refund more than their flat price (one-time, bounded).
 */
export function sellbackAmount(roomType: RoomType, rect: Rect): number {
  const priced = priceOf(roomType, rect);
  if (roomRetired(roomType)) {
    // RETIRED rooms refund in FULL (DEPARTMENTS_PLAN §3.6 defect 3): the
    // player paid for a working department and WE withdrew it, so charging
    // the normal 50% to reclaim the floor would bill them for our decision —
    // and the game is deployed, so these are real purchases in real saves.
    //
    // CLAMPED to the flat build cost (post-impl review MINOR 5). "Made whole"
    // means the price paid, not the rect's price today: a legacy 5×5 `resp`
    // bought for the flat $5,000 prices at $13,896 under the size-based
    // economy, so an unclamped full refund would pay out an $8,896 windfall.
    // The pre-Stage-0 oversize quirk is documented above as BOUNDED by the
    // 0.5 ratio; removing that bound without this clamp would unbound it.
    return Math.min(priced, ROOM_DEFS[roomType].cost);
  }
  return Math.floor(priced * BALANCE.economy.roomSellbackRatio);
}

/** Amenity sell-back (Stage 1, AMENITIES_PLAN §3.4) — the sellbackAmount
 *  pattern: sim payout AND inspect button label read this one derivation. */
export function amenitySellback(kind: AmenityId): number {
  return Math.floor(AMENITY_DEFS[kind].cost * BALANCE.economy.roomSellbackRatio);
}

/**
 * Day-close cleanliness reputation (Stage 2, AMENITIES_PLAN §4.2) — the ONE
 * metric: closeDay applies it, the daily-report row displays it. A spotless
 * day earns the bonus only when patients actually came (an empty hospital
 * isn't clean, it's closed — the wait-bonus principle; Stage-2 pre-impl
 * MINOR 15, design delta flagged to owner); otherwise −1 per
 * `messHoursPerRepPoint` mess-hours, capped per day.
 */
export function cleanlinessRepDelta(messTicks: number, arrivals: number): number {
  const m = BALANCE.mess;
  if (messTicks === 0) return arrivals > 0 ? m.cleanDayRepBonus : 0;
  const messHours = messTicks / (GAME_MINUTES_PER_HOUR / GAME_MINUTES_PER_TICK);
  // `|| 0` normalizes IEEE −0 when the floor lands on zero (Track-U finding:
  // −0 renders as "+0" through signed formatting and fails Object.is pins).
  return -Math.min(m.dailyRepCap, Math.floor(messHours / m.messHoursPerRepPoint)) || 0;
}

/**
 * Breakdown probability at a use completion (amenities Stage 3, §5.1) — the
 * ONE derivation: `applyRoomUse` rolls it, tests pin it. Linear in wear so
 * the player can reason from use ("that CT has run all week"); clamped —
 * enough wear makes failure certain.
 */
export function breakdownChance(kind: RoomFailure['kind'], wear: number): number {
  return Math.min(1, BALANCE.maintenance.wearFactor[kind] * wear);
}

/**
 * Room quality from footprint (GDD §5): every tile beyond the minimum adds
 * quality. Moved out of `buildRoom` (design-review NIT) so Stage B's
 * expansion recompute calls the same derivation.
 */
/**
 * How many of a prop this footprint should carry (Stage A, CAPACITY_PLAN
 * §3.2): fixed counts pass through; perTiles floors area/tilesPerProp into
 * [min, max]. The density tables are authored so a MINIMUM footprint derives
 * exactly the pre-epic count (pinned by test).
 */
export function propTargetCount(density: PropDensity, rect: Rect): number {
  if (density.kind === 'fixed') return density.count;
  const derived = Math.floor((rect.cols * rect.rows) / density.tilesPerProp);
  const capped = density.max === undefined ? derived : Math.min(density.max, derived);
  return Math.max(density.min, capped);
}

export function roomQuality(roomType: RoomType, rect: Rect): number {
  // Clamped like priceOf (sub-min rects are rejected before rooms exist;
  // the exported Stage-B API stays symmetric and never returns negatives).
  const extraTiles = Math.max(0, rect.cols * rect.rows - minArea(roomType));
  return extraTiles * BALANCE.rooms.qualityPerExtraTile;
}

/** Flow rule 1 check-in capacity (SSOT audit #5): the desk slot + the queue tiles behind it. */
export function checkInCapacity(): number {
  return BALANCE.reception.queueDepthTiles + 1;
}

/**
 * GDD §3 aura membership (SSOT audit #3): Euclidean ≤ radius from ANY footprint
 * tile, walls ignored. The ONE implementation — `World.refreshAuras` fills its
 * grid with it and the build-ghost preview asks it directly, so the preview can
 * never drift from live coverage.
 */
export function auraCoversTile(footprint: Rect, p: GridPoint, radius: number): boolean {
  const radiusSq = radius * radius;
  for (const foot of rectTiles(footprint)) {
    const dc = p.col - foot.col;
    const dr = p.row - foot.row;
    if (dc * dc + dr * dr <= radiusSq) return true;
  }
  return false;
}

/**
 * Plant comfort-aura membership (amenities Stage 1, AMENITIES_PLAN §3.4) —
 * the ONE formula, beside `auraCoversTile`: `refreshAuras` fills its grid
 * with it and any render preview asks it directly. Chebyshev distance per
 * the `plantAuraRadius` declaration in balance.ts (a small square patch —
 * a 1-tile prop has no footprint to sweep a Euclidean disc from).
 */
export function plantCoversTile(plant: GridPoint, p: GridPoint, radius: number): boolean {
  return Math.abs(p.col - plant.col) <= radius && Math.abs(p.row - plant.row) <= radius;
}

// ------------------------------------------------- finances (FINANCE_PLAN §9.2)

/**
 * Rooms that can bill (FINANCE_PLAN §4.1): DERIVED from CONDITION_DEFS, never
 * a hand-kept flag (§3.1 rule 1 — a table plus a "test both ways" only polices
 * a duplicate). Memoized: the inspect card polls it per frame.
 *
 * RETIRED rooms are included (DEPARTMENTS_PLAN §3.6 ruling 2). No step routes
 * to one any more, so the derivation alone would answer false — and a player's
 * standing `resp` room, holding real accumulated `revenueTotal`/`visitsTotal`,
 * would silently drop Income and Patients-seen from its inspect card and the
 * directory column. Keeping the row is what EXPLAINS where that money went.
 * Still derived (`CONDITION_DEFS ∪ RETIRED_ROOMS`), still no hand-kept flag.
 */
let earningRooms: Set<RoomType> | null = null;
export function roomEarns(type: RoomType): boolean {
  if (earningRooms === null) {
    earningRooms = new Set<RoomType>();
    for (const id of CONDITION_IDS) {
      for (const step of CONDITION_DEFS[id].steps) {
        if (step.fee > 0) earningRooms.add(step.room);
      }
    }
    for (const retired of RETIRED_ROOMS) earningRooms.add(retired);
  }
  return earningRooms.has(type);
}

/** The world shape `hospitalValue`/`departmentCapital` read — declared
 *  structurally so formulas.ts stays free of a `world.ts` import cycle. */
interface ValuedWorld {
  readonly cash: number;
  readonly rooms: ReadonlyMap<number, { type: RoomType; rect: Rect }>;
  readonly amenities: ReadonlyMap<string, { kind: AmenityId }>;
}

/**
 * RCT "company value" (§3.2): cash + every room's and amenity's sell-back.
 * MODAL-OPEN ONLY — it iterates all rooms + amenities; never call per-frame.
 */
export function hospitalValue(world: ValuedWorld): number {
  let value = world.cash;
  for (const room of world.rooms.values()) value += sellbackAmount(room.type, room.rect);
  for (const amenity of world.amenities.values()) value += amenitySellback(amenity.kind);
  return value;
}

/**
 * §5: what this category's footprints cost to build TODAY (rect-aware, the
 * `sellbackAmount` convention — no amount-paid bookkeeping). Because
 * `expandPrice = priceOf(new) − priceOf(old)`, this is EXACTLY the cash spent
 * across a build→expand chain, not merely a replacement-cost proxy. It DOES
 * also bill the new-game starting rooms, which were built free — deliberate:
 * it is a read of what the department is worth ("Capital invested"), never a
 * receipt ("Spent").
 */
export function departmentCapital(world: ValuedWorld, category: RoomCategory): number {
  let total = 0;
  for (const room of world.rooms.values()) {
    if (ROOM_DEFS[room.type].category === category) total += priceOf(room.type, room.rect);
  }
  return total;
}

/**
 * §3.1 Net — the table fold IS the net derivation (`dayNet` delegates here).
 * A `DayTally` satisfies `CashTotals` structurally, so one param type serves
 * today, a closed day, and lifetime alike. `breakdown` rows are display-only
 * and are never summed (vending already lives inside `revenue`).
 */
export function netFromCategories(totals: CashTotals): number {
  let net = 0;
  for (const category of FINANCE_CATEGORIES) {
    if (category.kind === 'income') net += totals[category.field];
    else if (category.kind === 'expense') net -= totals[category.field];
  }
  return net;
}

/**
 * §3.2: treatment fees only (vending excluded), over discharges counted in the
 * SAME window. `lifetimeTreatedBase` is the v6→v7 watermark — without it a
 * migrated save divides fresh revenue by pre-upgrade discharges and reads
 * permanently, invisibly low. `null` when the denominator is 0.
 */
export function averageBillPerPatient(
  lifetime: CashTotals,
  lifetimeTreated: number,
  lifetimeTreatedBase: number,
): number | null {
  const discharges = lifetimeTreated - lifetimeTreatedBase;
  if (discharges <= 0) return null;
  return (lifetime.revenue - lifetime.vendingRevenue) / discharges;
}

/**
 * Challenge scoring (plan §5): the ONE place a goal-metric becomes a number.
 * `SCORE_METRICS[metric].kind` selects the source; reads existing SSOT fields
 * only (no re-tally). Returns `null` ONLY for a daily-flow metric on a DNF
 * (no day closed) — snapshot/cumulative metrics score on both terminals.
 */
export function scoreChallenge(goal: ChallengeGoal, ctx: ChallengeContext): number | null {
  const metric = SCORE_METRICS[goal.metric];
  switch (metric.kind) {
    case 'snapshot':
    case 'cumulative':
      return ctx.terminal[metric.field];
    case 'dailyFlow':
      if (ctx.report === null) return null;
      return metric.field === 'net' ? dayNet(ctx.report) : ctx.report[metric.field];
    default: {
      // A new SCORE_METRICS kind must extend this switch — else the compiler
      // flags it here instead of silently returning undefined (: number | null).
      const exhaustive: never = metric;
      return exhaustive;
    }
  }
}
