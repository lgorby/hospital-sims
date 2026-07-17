import { TICKS_PER_GAME_HOUR } from '../clock';
import { BALANCE } from '../data/balance';
import { CONDITION_IDS, type ConditionId } from '../data/conditions';
import { conditionSpawnWeights, reputationArrivalMultiplier, timeOfDayMultiplier } from '../formulas';
import type { World } from '../world';

/** Weighted condition roll (GDD §3 mix + §7 case-mix shift). Exported for tests. */
export function rollCondition(world: World): ConditionId {
  const weights = conditionSpawnWeights(world.reputation);
  let total = 0;
  for (const id of CONDITION_IDS) total += weights[id];
  let roll = world.rng.next() * total;
  for (const id of CONDITION_IDS) {
    roll -= weights[id];
    if (roll < 0) return id;
  }
  return CONDITION_IDS[CONDITION_IDS.length - 1]!;
}

/**
 * Patient arrivals: base rate × time-of-day curve × reputation multiplier
 * (GDD §3), realized as a per-tick Bernoulli trial with p = rate/ticksPerHour.
 * Expected rate is EXACT and inter-arrival times are geometric — the discrete
 * approximation of a Poisson process the GDD asks for. (An earlier
 * accumulator+jitter scheme inflated slow rates by up to ×1.8 — M2 review #3.)
 * The full V1 roster spawns from M3 on, weighted per condition.
 */
export function updateSpawn(world: World): void {
  const perHour =
    BALANCE.arrivals.basePatientsPerGameHour *
    timeOfDayMultiplier(world.clock.hourOfDay) *
    reputationArrivalMultiplier(world.reputation);
  if (world.rng.chance(perHour / TICKS_PER_GAME_HOUR)) {
    world.spawnPatient(rollCondition(world));
  }
}
