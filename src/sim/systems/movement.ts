import { BALANCE } from '../data/balance';
import type { Walker, World } from '../world';

/** One derivation, shared by the sim step and the renderer's interpolation (§3.1 rule 4). */
export const PATIENT_TILES_PER_TICK =
  BALANCE.movement.patientTilesPerSecond / BALANCE.time.ticksPerSecond;
export const STAFF_TILES_PER_TICK =
  BALANCE.movement.staffTilesPerSecond / BALANCE.time.ticksPerSecond;

function advance(walker: Walker, step: number): void {
  if (!walker.next) return;
  walker.progress += step;
  while (walker.progress >= 1 && walker.next) {
    walker.progress -= 1;
    walker.at = walker.next;
    walker.next = walker.path.shift() ?? null;
  }
  if (!walker.next) {
    walker.progress = 0;
    walker.target = null;
  }
}

/**
 * Advances every walking actor along its path by a fixed per-tick step.
 * The renderer interpolates the at→next fraction (`progress`) for smoothness.
 */
export function updateMovement(world: World): void {
  for (const patient of world.patients.values()) {
    advance(patient, PATIENT_TILES_PER_TICK);
  }
  for (const member of world.staff.values()) {
    advance(member, STAFF_TILES_PER_TICK);
  }
}
