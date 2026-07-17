import { BALANCE } from '../data/balance';
import { healthDecayPerTick, patienceDecayPerTick } from '../formulas';
import type { Patient } from '../entities/patient';
import type { World } from '../world';

/** Stages where patience drains and hitting 0 means walking out AMA (Flow rule 3). */
function isAmaEligible(patient: Patient): boolean {
  const k = patient.stage.kind;
  return k === 'atEntrance' || k === 'queuedCheckIn' || k === 'waitingTriage' || k === 'waiting';
}

/** Health decays everywhere except during ACTIVE treatment (Flow rule 3). */
function healthPaused(world: World, patient: Patient): boolean {
  if (patient.stage.kind === 'dead' || patient.stage.kind === 'leaving') return true;
  if (patient.stage.kind !== 'reserved') return false;
  return world.reservations.get(patient.stage.reservationId)?.phase === 'active';
}

export function updateDecay(world: World): void {
  for (const patient of world.patients.values()) {
    if (patient.stage.kind === 'dead') {
      if (world.clock.tick - patient.stage.since > BALANCE.deathFadeTicks) {
        world.patients.delete(patient.id);
      }
      continue;
    }
    if (patient.stage.kind === 'leaving') {
      if (world.walkerArrived(patient)) world.patients.delete(patient.id);
      continue;
    }

    if (!healthPaused(world, patient)) {
      patient.health -= healthDecayPerTick(patient.acuity);
      if (patient.health <= 0) {
        patient.health = 0;
        world.killPatient(patient);
        continue;
      }
    }

    // Patience drains only while actually waiting IN PLACE — purposeful
    // walking is exempt (Flow rule 3). M3 lostness counts as waiting again
    // via the lost sub-state (Flow rule 13), not via stage.
    if (isAmaEligible(patient) && world.walkerArrived(patient)) {
      let rate = patienceDecayPerTick(patient.acuity);
      // Standing because every waiting room is full → 1.5× (Flow rule 4).
      // Applies to both triaged and untriaged waiters (M2 review #10).
      if (
        (patient.stage.kind === 'waiting' || patient.stage.kind === 'waitingTriage') &&
        patient.waitingRoomId === null
      ) {
        rate *= BALANCE.decay.standingMultiplier;
      }
      patient.patience -= rate;
      if (patient.patience <= 0) {
        patient.patience = 0;
        world.patientLeavesAma(patient);
      }
    }
  }
}
