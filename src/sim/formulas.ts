import { GAME_MINUTES_PER_HOUR, GAME_MINUTES_PER_TICK, gameMinutesToTicks } from './clock';
import { BALANCE } from './data/balance';
import {
  SCORE_METRICS,
  type ChallengeContext,
  type ChallengeGoal,
} from './data/challenges';
import { CONDITION_DEFS, CONDITION_IDS, type ConditionId } from './data/conditions';
import { ROOM_DEFS, type RoomType } from './data/rooms';
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

/** GDD §5 sell-back refund (SSOT audit #2): the sim's payout AND the UI's button label. */
export function sellbackAmount(roomType: RoomType): number {
  return Math.floor(ROOM_DEFS[roomType].cost * BALANCE.economy.roomSellbackRatio);
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
