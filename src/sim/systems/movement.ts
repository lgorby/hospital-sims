import { BALANCE } from '../data/balance';
import type { Walker, World } from '../world';
import { onPatientTileStep } from './wayfinding';

/** One derivation, shared by the sim step and the renderer's interpolation (§3.1 rule 4). */
export const PATIENT_TILES_PER_TICK =
  BALANCE.movement.patientTilesPerSecond / BALANCE.time.ticksPerSecond;
export const STAFF_TILES_PER_TICK =
  BALANCE.movement.staffTilesPerSecond / BALANCE.time.ticksPerSecond;

/**
 * Advance one walker; returns tiles entered this tick (0 or 1 at V1 speeds).
 * `keepTarget` preserves the goal when a step finishes with no path — lost
 * walkers wander step-by-step but must RETAIN their reservation target.
 */
function advance(walker: Walker, step: number, keepTarget = false): number {
  if (!walker.next) return 0;
  let entered = 0;
  walker.progress += step;
  while (walker.progress >= 1 && walker.next) {
    walker.progress -= 1;
    walker.at = walker.next;
    walker.next = walker.path.shift() ?? null;
    entered += 1;
  }
  if (!walker.next) {
    walker.progress = 0;
    if (!keepTarget) walker.target = null;
  }
  return entered;
}

/**
 * Advances every walking actor along its path by a fixed per-tick step.
 * The renderer interpolates the at→next fraction (`progress`) for smoothness.
 * Each tile a patient enters rolls the wayfinding wrong-turn check (GDD §3);
 * staff never roll.
 */
export function updateMovement(world: World): void {
  for (const patient of world.patients.values()) {
    const entered = advance(patient, PATIENT_TILES_PER_TICK, patient.lost !== null);
    for (let i = 0; i < entered; i++) onPatientTileStep(world, patient);
  }
  for (const member of world.staff.values()) {
    advance(member, STAFF_TILES_PER_TICK);
  }
}
