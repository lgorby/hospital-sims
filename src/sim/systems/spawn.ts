import { TICKS_PER_GAME_HOUR } from '../clock';
import { BALANCE } from '../data/balance';
import {
  CONDITION_DEFS,
  ELECTIVE_CONDITION_IDS,
  EMERGENCY_CONDITION_IDS,
  type ElectiveConditionId,
  type EmergencyConditionId,
} from '../data/conditions';
import { conditionSpawnWeights, reputationArrivalMultiplier, timeOfDayMultiplier } from '../formulas';
import type { World } from '../world';

/**
 * Weighted EMERGENCY condition roll (GDD §3 mix + §7 case-mix shift).
 * Exported for tests.
 *
 * Iterates `EMERGENCY_CONDITION_IDS`, not `CONDITION_IDS`: elective referrals
 * arrive on their own stream (`rollElectiveCondition`) and must never enter
 * the walk-in mix. This also fixes the float-residue fallback below, which
 * would otherwise return the last entry in the whole table — now an elective.
 */
export function rollCondition(world: World): EmergencyConditionId {
  const weights = conditionSpawnWeights(world.reputation);
  let total = 0;
  for (const id of EMERGENCY_CONDITION_IDS) total += weights[id];
  let roll = world.rng.next() * total;
  for (const id of EMERGENCY_CONDITION_IDS) {
    roll -= weights[id];
    if (roll < 0) return id;
  }
  return EMERGENCY_CONDITION_IDS[EMERGENCY_CONDITION_IDS.length - 1]!;
}

/**
 * Weighted ELECTIVE roll, GATED ON THE STEP ROOM EXISTING
 * (OUTPATIENT_IMPL_PLAN §2) — returns null when the player owns none of the
 * elective modalities, which is the gate.
 *
 * Gating is what makes this milestone work at all. Ungated, the volume splits
 * across every elective modality and MRI reaches ~12.5% utilisation — enough
 * to clear the plan's own failure line while still missing saturation by an
 * order of magnitude, leaving Departments Stage 2a blocked. Gated, a player
 * who has built one scanner receives the WHOLE stream, which is a queue and a
 * real second-suite decision. It also makes the stream opt-in, which is what
 * stops a brand-new hospital being buried in referrals it cannot serve.
 *
 * Ownership, not usability: a closed or broken scanner still attracts its
 * booked referrals, exactly as a real appointment book does not empty because
 * the machine is down. They queue (or leave), which is the honest outcome.
 */
export function rollElectiveCondition(world: World): ElectiveConditionId | null {
  const weights = BALANCE.arrivals.outpatient.weights;
  const available = ELECTIVE_CONDITION_IDS.filter((id) => {
    const step = CONDITION_DEFS[id].steps[0];
    return step !== undefined && world.roomsOfType(step.room).length > 0;
  });
  let total = 0;
  for (const id of available) total += weights[id];
  if (total <= 0) return null;
  let roll = world.rng.next() * total;
  for (const id of available) {
    roll -= weights[id];
    if (roll < 0) return id;
  }
  return available[available.length - 1]!;
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
  updateOutpatientSpawn(world);
}

/**
 * The scheduled outpatient stream (OUTPATIENT_IMPL_PLAN §3.3).
 *
 * DRAW-ORDER CONTRACT, and it is load-bearing for determinism (§4):
 *   - the clinic-hours check sits OUTSIDE `rng.chance`, which consumes a draw
 *     unconditionally. That is what keeps every pre-clinic tick bit-identical
 *     to the pre-change build, giving a real control window (the clock starts
 *     at hour 0, so ticks [0, openHour x TICKS_PER_GAME_HOUR) are untouched).
 *   - the room-gate sits INSIDE, after the draw, so owning no scanner does not
 *     itself perturb the stream.
 * Ordered AFTER the emergency roll so that roll's draws keep their positions.
 */
function updateOutpatientSpawn(world: World): void {
  const o = BALANCE.arrivals.outpatient;
  const hour = world.clock.hourOfDay;
  if (hour < o.openHour || hour >= o.closeHour) return;
  if (!world.rng.chance(o.perGameHour / TICKS_PER_GAME_HOUR)) return;
  const id = rollElectiveCondition(world);
  if (id === null) return; // no elective modality built — the gate
  // Pre-triaged by construction: `waiting` carries the semantic invariant that
  // acuity is set (world.setPatientStage), and a referral has no triage step
  // to set it later.
  world.spawnPatient(id, { acuity: CONDITION_DEFS[id].acuityMax });
}
