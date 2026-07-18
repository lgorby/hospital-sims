import { BALANCE } from '../data/balance';
import {
  healthDecayPerTick,
  meterDecayPerTick,
  patienceDecayPerTick,
  waitingQualityMultiplier,
} from '../formulas';
import type { Patient } from '../entities/patient';
import { clearMatchingRestroomBreak } from './patientNeeds';
import type { World } from '../world';

/** Stages where patience drains and hitting 0 means walking out AMA (Flow
 *  rule 3). Exported for the mess system (Stage 2): the vomit self-hit uses
 *  the same accident clamp rule — floor where AMA-ineligible. */
export function isAmaEligible(patient: Patient): boolean {
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

    // Need meters (amenities Stage 1, §3.1): flat per-game-hour rates, every
    // pre-terminal stage — acuity does not change how badly you need a
    // restroom. Thirst clamps at 0 (the unmet multiplier keeps stacking);
    // bladder at 0 is an ACCIDENT: one-time patience hit, meter refills.
    patient.thirst = Math.max(
      0,
      patient.thirst - meterDecayPerTick(BALANCE.needs.thirstPerGameHour),
    );
    patient.bladder -= meterDecayPerTick(BALANCE.needs.bladderPerGameHour);
    if (patient.bladder <= 0) {
      patient.bladder = BALANCE.stats.vitalsMax;
      // Accident × in-flight break (pre-impl MINOR 8): a matching restroom
      // claim is cleared with NO hold — the need no longer exists, and the
      // claim must not pin the restroom's "Occupied" geometry gates.
      clearMatchingRestroomBreak(world, patient);
      // Stage 2 (§3.1 upgrade): accidents drop a real mess on the tile —
      // kind 'vomit' (one decal family; a clean job cleans any mess).
      world.addMess('vomit', patient.at);
      // Accidents never mint a new fail state (design principle 3): the hit
      // clamps at the floor in non-AMA-eligible stages (checkingIn/reserved);
      // in AMA-eligible stages patience just drops and normal rules apply.
      const floor = isAmaEligible(patient) ? 0 : BALANCE.needs.accidentPatienceFloor;
      patient.patience = Math.max(floor, patient.patience - BALANCE.needs.accidentPatienceHit);
      world.emitThought(patient, 'accident');
    }

    // While `using` a stall/machine, patience decay pauses entirely (relief
    // is relief — §3.2; use is ≤3 game-minutes, no camping exploit).
    if (patient.needBreak?.phase === 'using') continue;

    // Patience drains only while actually waiting IN PLACE — purposeful
    // walking is exempt (Flow rule 3). Lostness counts as waiting in ANY
    // stage, including `reserved` (rules 3/13): a lost patient going to 0
    // patience walks out AMA like any other waiter.
    if (patient.lost !== null || (isAmaEligible(patient) && world.walkerArrived(patient))) {
      let rate = patienceDecayPerTick(patient.acuity);
      // Standing because every waiting room is full → 1.5× (Flow rule 4).
      // Applies to both triaged and untriaged waiters (M2 review #10).
      if (
        (patient.stage.kind === 'waiting' || patient.stage.kind === 'waitingTriage') &&
        patient.waitingRoomId === null
      ) {
        rate *= BALANCE.decay.standingMultiplier;
      } else if (patient.waitingRoomId !== null) {
        // Seated in a waiting room: roomier rooms decay slower (GDD §5,
        // audit #4) — multiplies with the comfort aura below.
        const room = world.rooms.get(patient.waitingRoomId);
        if (room) rate *= waitingQualityMultiplier(room.quality);
      }
      // Comfort aura ×0.75 (GDD §5) — MULTIPLIES with the modifiers above
      // (M3-gate ruling): a standing waiter in comfort decays at 1.5 × 0.75.
      if (world.hasComfortAura(patient.at)) {
        rate *= BALANCE.wayfinding.comfortAuraPatienceMultiplier;
      }
      // Mess proximity (Stage 2, §4.2 channel 1): ONCE — not per mess —
      // composing multiplicatively with the full stack above and the unmet
      // multipliers below (pre-impl MINOR 9).
      if (world.hasMessNear(patient.at)) {
        rate *= BALANCE.mess.patienceMultiplier;
      }
      // Unmet needs (§3.1): ×1.25 PER meter below threshold, multiplying into
      // the stack above, unless the MATCHING break is actively relieving it.
      // (The full using-pause already skipped this block for the user's own
      // break; the guards keep the rule locally true regardless.)
      const nb = patient.needBreak;
      if (
        patient.bladder < BALANCE.needs.seekThreshold &&
        !(nb?.kind === 'restroom' && nb.phase === 'using')
      ) {
        rate *= BALANCE.needs.unmetPatienceMultiplier;
      }
      if (
        patient.thirst < BALANCE.needs.seekThreshold &&
        !(nb?.kind === 'vending' && nb.phase === 'using')
      ) {
        rate *= BALANCE.needs.unmetPatienceMultiplier;
      }
      patient.patience -= rate;
      if (patient.patience <= 0) {
        patient.patience = 0;
        world.patientLeavesAma(patient);
      }
    }
  }
}
