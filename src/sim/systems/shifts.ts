import { BALANCE } from '../data/balance';
import type { Staff } from '../entities/staff';
import { onShift } from '../formulas';
import { samePoint } from '../types';
import type { World } from '../world';

/**
 * SHIFTS Stage-1 (SHIFTS_IMPL_PLAN §B) — the per-tick reconciliation that turns
 * the availability gate into real behaviour. Runs AFTER updatePatientNeeds and
 * BEFORE updateDispatcher, so the pools the dispatcher reads this tick already
 * reflect the boundary.
 *
 * It is IDEMPOTENT and keys on live state (reservations, clock, onFloor) — no
 * stored previous-tick flag (itself an unsaved-state hazard). A staffer has three
 * availability states: working (onShift, onFloor, in pool) · off-shift finishing a
 * live bay/job (¬onShift, onFloor, excluded from NEW work by the gate) · gone home
 * (¬onShift, ¬onFloor, off the map but still on payroll).
 *
 * INERT until a shift is assigned: a null-shift staffer is always onShift and
 * defaults onFloor=true, so this loop is a no-op for them.
 */
export function updateShifts(world: World): void {
  const minute = world.clock.minuteOfDay;
  const entrance = BALANCE.map.entrance;

  for (const member of world.staff.values()) {
    if (onShift(member.shift, minute)) {
      // On shift: if home, come back on the floor (available again).
      if (!member.onFloor) respawn(world, member, entrance);
      continue;
    }

    // Off shift. Cancel any GATHERING bays (mirror fireStaff): the patient
    // re-queues to an on-shift staffer, and the ungated promoteGatheredReservations
    // (which runs after this) can never promote an off-shift gather. Cancel even
    // when an active bay remains — exactly fireStaff's rule.
    const reservations = world.reservationsOfStaff(member.id);
    for (const r of reservations) {
      if (r.phase === 'gathering') world.cancelReservation(r, { hint: false });
    }

    // A posted staffer (receptionist/greeter) un-posts at the boundary (mirror the
    // sellRoom un-post) — postStandingStaff won't re-post them (idleStaff excludes
    // off-shift), so a day-only reception simply stops checking in at night.
    if (member.duty.kind === 'post') {
      member.duty = { kind: 'idle' };
      member.path = [];
      member.target = null;
      world.events.emit('staffUpdated', { staffId: member.id });
    }

    // Let a LIVE bay or job finish — she takes no NEW work (gate), her bay/job
    // drains, and she walks home the tick after it releases. `busy` reads the
    // reservation phases (not member.duty, which lies during multi-bay
    // gather→active promotion) plus an in-progress job.
    const busy = reservations.some((r) => r.phase === 'active') || member.duty.kind === 'job';
    if (busy) continue;
    if (!member.onFloor) continue; // already home

    if (world.walkerArrived(member) && samePoint(member.at, entrance)) {
      // Arrived home — mark off-floor (the analogue of the patient despawn, but
      // MARK not delete: payroll continues for coverage you hired).
      member.onFloor = false;
      member.path = [];
      member.target = null;
      world.events.emit('staffUpdated', { staffId: member.id });
      continue;
    }

    // Start (or keep) walking home. Don't re-issue if already targeting the
    // entrance (avoids a pointless per-tick re-path).
    if (!(member.target && samePoint(member.target, entrance))) {
      world.setWalkerTarget(member, entrance);
      // No path to the entrance (e.g. walled in): blink home rather than loiter
      // on-floor claiming a tile forever. Clear the committed step too, so an
      // off-floor staffer never drifts a tile in updateMovement.
      if (member.target === null) {
        member.onFloor = false;
        member.next = null;
        member.path = [];
        world.events.emit('staffUpdated', { staffId: member.id });
      }
    }
  }
}

/**
 * Coming back on shift: reappear at the entrance (staff enter through the door),
 * then REPORT to the area being taken over. During the 30-min changeover overlap
 * the OUTGOING same-role worker is still on the floor, so the newcomer walks to
 * her spot to relieve her (owner ask). Standing-post roles (receptionist/greeter)
 * are re-posted by the dispatcher this SAME tick — that overrides the idle relief
 * target — so a night receptionist still reports to the reception desk, not the
 * door. No outgoing counterpart (fallback) → idle at the entrance, dispatcher routes.
 */
function respawn(world: World, member: Staff, entrance: { col: number; row: number }): void {
  // nearestFreeStandingTile sees already-respawned staff as occupying tiles (they
  // are on-floor + arrived), so a whole night crew coming on at once places
  // sequentially without stacking.
  const spot = world.nearestFreeStandingTile(entrance, member) ?? entrance;
  member.at = { ...spot };
  member.next = null;
  member.path = [];
  member.target = null;
  member.progress = 0;
  member.onFloor = true;
  member.duty = { kind: 'idle' };
  // The OUTGOING same-role worker is on the OTHER shift and still on-floor during
  // the 30-min overlap (she doesn't leave until her window closes) — head to her
  // spot. Keyed on `shift !==`, not `!onShift`: during the handover she is still
  // ON her shift, so an off-shift test would find no one and drop the newcomer at
  // the door.
  const relief = [...world.staff.values()].find(
    (s) => s !== member && s.role === member.role && s.onFloor && s.shift !== member.shift,
  );
  if (relief) world.setWalkerTarget(member, relief.next ?? relief.at);
  world.events.emit('staffUpdated', { staffId: member.id });
}
