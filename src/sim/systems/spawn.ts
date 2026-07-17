import { TICKS_PER_GAME_HOUR } from '../clock';
import { BALANCE } from '../data/balance';
import { reputationArrivalMultiplier, timeOfDayMultiplier } from '../formulas';
import type { World } from '../world';

/**
 * Patient arrivals: base rate × time-of-day curve × reputation multiplier
 * (GDD §3), realized as a per-tick Bernoulli trial with p = rate/ticksPerHour.
 * Expected rate is EXACT and inter-arrival times are geometric — the discrete
 * approximation of a Poisson process the GDD asks for. (An earlier
 * accumulator+jitter scheme inflated slow rates by up to ×1.8 — M2 review #3.)
 * M2 spawns flu only — the full roster opens in M3.
 */
export function updateSpawn(world: World): void {
  const perHour =
    BALANCE.arrivals.basePatientsPerGameHour *
    timeOfDayMultiplier(world.clock.hourOfDay) *
    reputationArrivalMultiplier(world.reputation);
  if (world.rng.chance(perHour / TICKS_PER_GAME_HOUR)) {
    world.spawnPatient('flu');
  }
}
