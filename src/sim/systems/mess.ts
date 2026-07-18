import { TICKS_PER_GAME_HOUR } from '../clock';
import { BALANCE } from '../data/balance';
import type { Patient } from '../entities/patient';
import { isAmaEligible } from './decay';
import type { World } from '../world';

/**
 * Mess sources & the cleanliness tally (amenities Stage 2, AMENITIES_PLAN
 * §4.1–4.2 / impl plan §S2.2). Tick slot: AFTER treatment, BEFORE economy
 * (design §7 order).
 *
 * (1) Vomit rolls — per-tick Bernoulli (`vomitPerGameHour / ticksPerHour`,
 *     the spawn-rate precedent) over the FROZEN stage set, per patient in
 *     fixed map order. Per-patient — not aggregate — is the RIGHT
 *     determinism call (the wrong-turn per-tile precedent): an aggregate
 *     roll can't attribute the mess tile + self hit without extra draws.
 * (2) The daily tally: `today.messTicks += messes.size` every tick (the M4
 *     tally choke-point pattern) — closeDay converts via cleanlinessRepDelta.
 */

/**
 * The FROZEN vomit eligibility set (pre-impl MAJOR 7): the pre-terminal,
 * non-reserved stages. `atEntrance` is included deliberately (design delta
 * recorded in the impl plan); `reserved` is not — treatment-room patients
 * don't roll. needBreak holders DO roll: their stage stays waiting — being
 * en route to the restroom doesn't settle a stomach.
 */
function vomitEligible(patient: Patient): boolean {
  const k = patient.stage.kind;
  return (
    k === 'atEntrance' ||
    k === 'queuedCheckIn' ||
    k === 'checkingIn' ||
    k === 'waitingTriage' ||
    k === 'waiting'
  );
}

export function updateMess(world: World): void {
  // Threshold reuses BALANCE.mood.criticalHealthBelow — no new number
  // (the moodOf threshold is shared by the vomit gate, §S2.1).
  const perTick = BALANCE.mess.vomitPerGameHour / TICKS_PER_GAME_HOUR;
  for (const patient of world.patients.values()) {
    if (!vomitEligible(patient)) continue;
    if (patient.health >= BALANCE.mood.criticalHealthBelow) continue;
    if (!world.rng.chance(perTick)) continue;
    world.addMess('vomit', patient.at);
    world.emitThought(patient, 'vomit');
    // Self patience hit — the accident clamp rule (design principle 3):
    // floored where isAmaEligible is false (`checkingIn` here), so a vomit
    // never mints a new fail state mid-desk.
    const floor = isAmaEligible(patient) ? 0 : BALANCE.needs.accidentPatienceFloor;
    patient.patience = Math.max(floor, patient.patience - BALANCE.mess.vomitSelfPatienceHit);
  }
  // Tally choke point (§4.2 channel 2): one increment per standing mess per
  // tick — mess-hours fall out at closeDay via cleanlinessRepDelta.
  world.today.messTicks += world.messes.size;
}
