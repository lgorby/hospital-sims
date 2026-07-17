import { BALANCE } from '../data/balance';
import type { World } from '../world';

/** One derivation, shared by the sim step and the renderer's interpolation (§3.1 rule 4). */
export const PATIENT_TILES_PER_TICK =
  BALANCE.movement.patientTilesPerSecond / BALANCE.time.ticksPerSecond;

/**
 * Advances every walking actor along its path by a fixed per-tick step.
 * The renderer interpolates the at→next fraction (`progress`) for smoothness.
 */
export function updateMovement(world: World): void {
  const step = PATIENT_TILES_PER_TICK;
  for (const patient of world.patients.values()) {
    if (!patient.next) continue;
    patient.progress += step;
    while (patient.progress >= 1 && patient.next) {
      patient.progress -= 1;
      patient.at = patient.next;
      patient.next = patient.path.shift() ?? null;
    }
    if (!patient.next) {
      patient.progress = 0;
      patient.target = null;
    }
  }
}
