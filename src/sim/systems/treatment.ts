import { BALANCE } from '../data/balance';
import { CONDITION_DEFS } from '../data/conditions';
import type { Reservation } from '../entities/staff';
import { successChance } from '../formulas';
import type { World } from '../world';

/** Ticks active reservation timers and resolves completions. */
export function updateTreatment(world: World): void {
  for (const reservation of [...world.reservations.values()]) {
    if (reservation.phase !== 'active') continue;
    reservation.ticksRemaining -= 1;
    if (reservation.ticksRemaining > 0) continue;
    if (reservation.kind === 'triage') {
      completeTriage(world, reservation);
    } else {
      const patient = world.patients.get(reservation.patientId);
      const members = reservation.staffIds.map((id) => world.staff.get(id)!);
      const averageSkill = members.reduce((sum, m) => sum + m.skill, 0) / members.length;
      const success = world.rng.chance(successChance(averageSkill, patient?.health ?? 0));
      resolveTreatmentOutcome(world, reservation, success);
    }
  }
}

function completeTriage(world: World, reservation: Reservation): void {
  const patient = world.patients.get(reservation.patientId);
  world.releaseReservation(reservation);
  if (!patient) return;
  const def = CONDITION_DEFS[patient.condition];
  patient.acuity = world.rng.intInRange(def.acuityMin, def.acuityMax);
  patient.stage = { kind: 'waiting' };
  patient.waitingSince = world.clock.tick;
  world.assignWaitingSpot(patient);
}

/**
 * GDD §2 Treatment resolution. Exported so tests can drive both branches
 * without fighting the RNG: success bills the step and advances (discharging
 * after the last step); failure is a complication — health penalty, repeat
 * the step, never instant death (death only ever at health 0).
 */
export function resolveTreatmentOutcome(
  world: World,
  reservation: Reservation,
  success: boolean,
): void {
  const patient = world.patients.get(reservation.patientId);
  if (!patient) {
    world.releaseReservation(reservation);
    return;
  }
  const def = CONDITION_DEFS[patient.condition];
  const step = def.steps[reservation.stepIndex]!;

  if (success) {
    patient.billed += step.fee;
    world.billFee(step.fee, `${def.label} — ${step.label}`);
    patient.stepIndex += 1;
    if (patient.stepIndex >= def.steps.length) {
      world.dischargePatient(patient, patient.billed); // releases the reservation too
      return;
    }
    world.releaseReservation(reservation);
    patient.stage = { kind: 'waiting' };
    // Flow rule 6 ruling: between-steps re-queues keep the accumulated wait —
    // multi-step patients never restart the aged-priority line from zero.
    patient.waitingSince = reservation.patientWaitingSince ?? world.clock.tick;
    world.assignWaitingSpot(patient);
    return;
  }

  patient.health -= BALANCE.treatment.complicationHealthPenalty;
  if (patient.health <= 0) {
    patient.health = 0;
    world.killPatient(patient); // releases the reservation too
    return;
  }
  world.emitThought(patient, 'complication');
  world.events.emit('patientComplication', {
    patientId: patient.id,
    name: patient.name.full,
    col: patient.at.col,
    row: patient.at.row,
  });
  world.releaseReservation(reservation);
  patient.stage = { kind: 'waiting' };
  // "Re-queued, with aged priority per Flow rule 6" (GDD §2): the wait clock
  // survives the complication instead of resetting to the back of the line.
  patient.waitingSince = reservation.patientWaitingSince ?? world.clock.tick;
  world.assignWaitingSpot(patient);
}
