import { gameMinutesToTicks } from '../clock';
import { BALANCE } from '../data/balance';
import { ROOM_DEFS } from '../data/rooms';
import type { Patient } from '../entities/patient';
import { wrongTurnChance } from '../formulas';
import { ORTHOGONAL_STEPS } from '../types';
import type { World } from '../world';

/**
 * Wayfinding (GDD §3 "Getting lost", M3-gate rulings): wrong turns on care
 * walks, ❓ wandering, aura/staff/self recovery, and the 60-game-min lost
 * reservation timeout. Lostness is a movement sub-state — the stage machine
 * and all release rules (Flow 7/8) apply unchanged (rule 13).
 */

/** Which walks roll wrong turns (M3-gate ruling): purposeful care walks only. */
function rollsWrongTurns(patient: Patient): boolean {
  const k = patient.stage.kind;
  return k === 'waitingTriage' || k === 'waiting' || k === 'reserved';
}

/**
 * Called by the movement system for each tile a patient steps onto.
 * Zero chance inside a guidance aura; staff never roll (they don't call this).
 */
export function onPatientTileStep(world: World, patient: Patient): void {
  if (patient.lost || !rollsWrongTurns(patient)) return;
  // Arrival ends the walk — there is no "next turn" to get wrong (M3 review:
  // a roll on the destination tile made treatment start on a lost patient).
  if (world.walkerArrived(patient)) return;
  if (world.hasGuidanceAura(patient.at)) return;
  if (!world.rng.chance(wrongTurnChance(patient.wayfinding))) return;
  patient.lost = { since: world.clock.tick };
  world.today.lostEpisodes += 1;
  // Abandon the route but RETAIN the goal: the reservation target survives
  // and the gathering stall check exempts lost walkers (M3-gate ruling).
  patient.path = [];
  patient.next = null;
  patient.progress = 0;
  world.emitThought(patient, 'lost');
  world.events.emit('patientLost', {
    patientId: patient.id,
    name: patient.name.full,
    col: patient.at.col,
    row: patient.at.row,
  });
}

function staffNearby(world: World, patient: Patient): boolean {
  const r = BALANCE.wayfinding.staffRescueRadius;
  const rSq = r * r;
  for (const member of world.staff.values()) {
    // SHIFTS Stage-1: a gone-home (off-floor) staffer is off the map — she can't
    // rescue anyone. Off-floor staff cluster on the entrance tile, exactly where
    // arrivals get lost, so without this a day-only night still rescues at the door.
    if (!member.onFloor) continue;
    const dc = member.at.col - patient.at.col;
    const dr = member.at.row - patient.at.row;
    if (dc * dc + dr * dr <= rSq) return true;
  }
  return false;
}

function selfRecoveryRolls(world: World, patient: Patient, rollTicks: number): boolean {
  const lostFor = world.clock.tick - patient.lost!.since;
  if (lostFor <= 0 || lostFor % rollTicks !== 0) return false;
  return world.rng.chance(BALANCE.wayfinding.selfRecoveryChance);
}

/** Guidance aura and staff proximity rescue instantly; otherwise a periodic self-roll. */
function tryRecover(world: World, patient: Patient, rollTicks: number): boolean {
  const recovered =
    world.hasGuidanceAura(patient.at) ||
    staffNearby(world, patient) ||
    selfRecoveryRolls(world, patient, rollTicks);
  if (!recovered) return false;
  patient.lost = null;
  world.emitThought(patient, 'rescued');
  world.events.emit('patientRecovered', {
    patientId: patient.id,
    name: patient.name.full,
    col: patient.at.col,
    row: patient.at.row,
  });
  // Re-path (A*) to the retained destination — or get a fresh waiting spot if
  // the timeout already released it (GDD §3 "on recovery they re-path").
  if (patient.target) {
    world.setWalkerTarget(patient, patient.target);
  } else if (patient.stage.kind === 'waiting' || patient.stage.kind === 'waitingTriage') {
    world.assignWaitingSpot(patient);
  }
  return true;
}

/** Random adjacent walkable step; never THROUGH a door edge into a walled room. */
function wanderStep(world: World, patient: Patient): void {
  if (patient.next) return; // still finishing the previous wander step
  const from = patient.at;
  const fromRoom = world.roomAt(from);
  const options = ORTHOGONAL_STEPS.map((s) => ({
    col: from.col + s.col,
    row: from.row + s.row,
  })).filter((to) => {
    if (!world.canStep(from, to)) return false;
    const room = world.roomAt(to);
    return room === null || ROOM_DEFS[room.type].kind === 'open' || room.id === fromRoom?.id;
  });
  if (options.length === 0) return;
  patient.next = options[world.rng.intBelow(options.length)]!;
  patient.progress = 0;
}

export function updateWayfinding(world: World): void {
  const timeoutTicks = gameMinutesToTicks(BALANCE.wayfinding.lostReservationTimeoutGameMinutes);
  const rollTicks = gameMinutesToTicks(BALANCE.wayfinding.selfRecoveryRollGameMinutes);

  for (const patient of world.patients.values()) {
    if (!patient.lost) continue;

    // 60-min timeout (M3-gate ruling): release room + staff rule-7 style; the
    // patient stays lost with NO walk target and no corridor hint; the wait
    // clock keeps running (lostness counts as waiting). Spot + re-path happen
    // at recovery.
    if (
      patient.stage.kind === 'reserved' &&
      world.clock.tick - patient.lost.since >= timeoutTicks
    ) {
      const reservation = world.reservations.get(patient.stage.reservationId);
      if (reservation) world.releaseReservation(reservation);
      // Kind-aware like cancelReservation (audit #1): a patient lost en route
      // to TRIAGE has acuity null — dropping them into 'waiting' strands them
      // forever (assignTriage scans waitingTriage; assignTreatment requires
      // acuity). Regression: test/audit.test.ts.
      world.setPatientStage(
        patient,
        reservation?.kind === 'triage' ? { kind: 'waitingTriage' } : { kind: 'waiting' },
      );
      patient.waitingSince = reservation?.patientWaitingSince ?? world.clock.tick;
      patient.target = null;
      patient.path = [];
    }

    if (tryRecover(world, patient, rollTicks)) continue;
    wanderStep(world, patient);
  }
}
