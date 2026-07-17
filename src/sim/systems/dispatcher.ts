import { GAME_MINUTES_PER_HOUR, gameMinutesToTicks, ticksToGameMinutes } from '../clock';
import { BALANCE } from '../data/balance';
import { CONDITION_DEFS } from '../data/conditions';
import { ROLE_DEFS } from '../data/roles';
import { ROOM_DEFS } from '../data/rooms';
import type { Room } from '../entities/room';
import type { Patient } from '../entities/patient';
import type { Reservation, Staff } from '../entities/staff';
import { effectivePriority, treatmentDurationTicks } from '../formulas';
import { samePoint } from '../types';
import type { Walker, World } from '../world';

/**
 * The dispatcher (GDD §4): matches waiting patients to free rooms + free
 * staff with all-or-nothing reservations, runs the check-in pipeline, and
 * promotes gathered reservations to active treatments.
 */
export function updateDispatcher(world: World): void {
  postReceptionists(world);
  reRouteEntranceWaiters(world);
  processCheckIn(world);
  assignTriage(world);
  assignTreatment(world);
  promoteGatheredReservations(world);
}

function idleStaff(world: World, filter: (s: Staff) => boolean): Staff[] {
  return [...world.staff.values()].filter((s) => s.duty.kind === 'idle' && !s.firing && filter(s));
}

function roomBusy(world: World, roomId: number): boolean {
  for (const res of world.reservations.values()) {
    if (res.roomId === roomId) return true;
  }
  return false;
}

/** Deterministic desk spot: first walkable interior tile that isn't the doorway. */
function postTile(world: World, room: Room): { col: number; row: number } {
  for (let row = room.rect.row; row < room.rect.row + room.rect.rows; row++) {
    for (let col = room.rect.col; col < room.rect.col + room.rect.cols; col++) {
      const p = { col, row };
      if (!world.isWalkable(p)) continue;
      if (room.door && samePoint(room.door.inside, p)) continue;
      return p;
    }
  }
  return room.door?.inside ?? { col: room.rect.col, row: room.rect.row };
}

function postReceptionists(world: World): void {
  const staffedRooms = new Set<number>();
  for (const s of world.staff.values()) {
    if (s.duty.kind === 'post') staffedRooms.add(s.duty.roomId);
  }
  for (const room of world.roomsOfType('reception')) {
    if (!room.door || staffedRooms.has(room.id)) continue;
    const candidate = idleStaff(world, (s) => s.role === 'receptionist')[0];
    if (!candidate) continue;
    candidate.duty = { kind: 'post', roomId: room.id };
    world.setWalkerTarget(candidate, postTile(world, room));
    staffedRooms.add(room.id);
  }
}

/** Patients stuck at the entrance get routed once a reception has queue capacity. */
function reRouteEntranceWaiters(world: World): void {
  const hasCapacity = world
    .roomsOfType('reception')
    .some((r) => r.door && world.queueFor(r.id).length < BALANCE.reception.queueDepthTiles + 1);
  if (!hasCapacity) return;
  for (const patient of world.patients.values()) {
    if (patient.stage.kind === 'atEntrance') world.routeToCheckIn(patient);
  }
}

function processCheckIn(world: World): void {
  for (const room of world.roomsOfType('reception')) {
    if (!room.door) continue;
    const queue = world.queueFor(room.id);
    const frontId = queue[0];
    if (frontId === undefined) continue;
    const front = world.patients.get(frontId);
    if (!front) {
      queue.shift();
      continue;
    }

    const receptionistReady = [...world.staff.values()].some(
      (s) =>
        s.duty.kind === 'post' &&
        s.duty.roomId === room.id &&
        world.walkerArrived(s) &&
        world.isInsideRoom(s.at, room),
    );

    if (front.stage.kind === 'checkingIn') {
      // The desk only works while staffed (M2 review #4): if the receptionist
      // was fired or hasn't arrived, the check-in reverts to the desk slot and
      // restarts when someone is posted again — never a headless check-in.
      if (!receptionistReady) {
        front.stage = { kind: 'queuedCheckIn', roomId: room.id, slot: 0 };
        continue;
      }
      front.stage.ticksRemaining -= 1;
      if (front.stage.ticksRemaining <= 0) {
        world.leaveQueue(front);
        front.stage = { kind: 'waitingTriage' };
        front.waitingSince = world.clock.tick;
        world.assignWaitingSpot(front);
      }
      continue;
    }

    // Desk processes only when the front patient is AT the desk and a
    // receptionist is posted and has arrived (Flow rule 1).
    if (front.stage.kind !== 'queuedCheckIn' || front.stage.slot !== 0) continue;
    if (!world.walkerArrived(front) || !samePoint(front.at, world.queueSlotTile(room, 0))) continue;
    if (!receptionistReady) continue;
    front.stage = {
      kind: 'checkingIn',
      roomId: room.id,
      ticksRemaining: gameMinutesToTicks(BALANCE.reception.checkInGameMinutes),
    };
  }
}

function makeReservation(
  world: World,
  kind: 'triage' | 'treatment',
  patient: Patient,
  room: Room,
  staffMembers: Staff[],
  stepIndex: number,
): void {
  const reservation: Reservation = {
    id: world.takeId(),
    kind,
    patientId: patient.id,
    roomId: room.id,
    staffIds: staffMembers.map((s) => s.id),
    stepIndex,
    phase: 'gathering',
    ticksRemaining: 0,
  };
  world.reservations.set(reservation.id, reservation);
  patient.stage = { kind: 'reserved', reservationId: reservation.id };
  patient.waitingSince = null;
  patient.waitingRoomId = null;
  const patientSpot = world.freeInteriorTile(room, room.door?.inside);
  world.setWalkerTarget(patient, patientSpot);
  for (const member of staffMembers) {
    member.duty = { kind: 'reserved', reservationId: reservation.id };
    world.setWalkerTarget(member, world.freeInteriorTile(room, patientSpot));
  }
}

function assignTriage(world: World): void {
  const waiting = [...world.patients.values()]
    .filter((p) => p.stage.kind === 'waitingTriage')
    .sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0));
  if (waiting.length === 0) return;
  // Flow rule 5: tell the player WHY nothing is happening — once.
  if (world.roomsOfType('triage').length === 0) {
    world.hintOnce('room:triage', 'Patients need triage — build a Triage Bay');
  }
  if (![...world.staff.values()].some((s) => s.role === 'nurse')) {
    world.hintOnce('role:nurse', 'Nobody can run triage — hire a Nurse');
  }
  const bays = world.roomsOfType('triage').filter((r) => r.door && !roomBusy(world, r.id));
  const nurses = idleStaff(world, (s) => s.role === 'nurse');
  while (waiting.length > 0 && bays.length > 0 && nurses.length > 0) {
    makeReservation(world, 'triage', waiting.shift()!, bays.shift()!, [nurses.shift()!], 0);
  }
}

function assignTreatment(world: World): void {
  const waiting = [...world.patients.values()]
    .filter((p) => p.stage.kind === 'waiting' && p.acuity !== null)
    .sort((a, b) => priorityOf(world, a) - priorityOf(world, b));

  for (const patient of waiting) {
    const def = CONDITION_DEFS[patient.condition];
    const step = def.steps[patient.stepIndex];
    if (!step) continue;
    // Flow rule 5: missing facility/staff hints, once per condition.
    if (world.roomsOfType(step.room).length === 0) {
      world.hintOnce(
        `cond:${patient.condition}:room`,
        `Nobody here can treat ${def.label} — build a ${ROOM_DEFS[step.room].label}`,
      );
    }
    for (const role of step.roles) {
      if (![...world.staff.values()].some((s) => s.role === role)) {
        world.hintOnce(
          `cond:${patient.condition}:${role}`,
          `Treating ${def.label} needs a ${ROLE_DEFS[role].label}`,
        );
      }
    }
    const room = world
      .roomsOfType(step.room)
      .find((r) => r.door && !roomBusy(world, r.id));
    if (!room) continue;
    // All-or-nothing (tech plan §5): every required role or nothing at all.
    const chosen: Staff[] = [];
    for (const role of step.roles) {
      const member = idleStaff(world, (s) => s.role === role && !chosen.includes(s))[0];
      if (!member) break;
      chosen.push(member);
    }
    if (chosen.length !== step.roles.length) continue;
    makeReservation(world, 'treatment', patient, room, chosen, patient.stepIndex);
  }
}

function priorityOf(world: World, patient: Patient): number {
  const waitedHours =
    patient.waitingSince === null
      ? 0
      : ticksToGameMinutes(world.clock.tick - patient.waitingSince) / GAME_MINUTES_PER_HOUR;
  return effectivePriority(patient.acuity ?? BALANCE.decay.untriagedAcuity, waitedHours);
}

/** Everyone has arrived inside the room → start the timer. */
function promoteGatheredReservations(world: World): void {
  for (const reservation of [...world.reservations.values()]) {
    if (reservation.phase !== 'gathering') continue;
    const room = world.rooms.get(reservation.roomId);
    const patient = world.patients.get(reservation.patientId);
    if (!room || !patient) continue;
    const members = reservation.staffIds.map((id) => world.staff.get(id)!);

    // Flow rule 8 / M2 review #1: a participant who has STOPPED (no committed
    // step, no goal) but is not inside the room has no path — cancel the
    // reservation instead of stalling forever with the room and staff leaked.
    const stalled = (w: Walker): boolean =>
      world.walkerArrived(w) && !world.isInsideRoom(w.at, room);
    if (stalled(patient) || members.some(stalled)) {
      world.cancelReservation(reservation);
      continue;
    }

    if (!world.walkerArrived(patient) || !world.isInsideRoom(patient.at, room)) continue;
    if (!members.every((m) => world.walkerArrived(m) && world.isInsideRoom(m.at, room))) continue;

    reservation.phase = 'active';
    if (reservation.kind === 'triage') {
      reservation.ticksRemaining = gameMinutesToTicks(BALANCE.triage.durationGameMinutes);
    } else {
      const step = CONDITION_DEFS[patient.condition].steps[reservation.stepIndex]!;
      const averageSkill = members.reduce((sum, m) => sum + m.skill, 0) / members.length;
      reservation.ticksRemaining = treatmentDurationTicks(
        step.durationGameMinutes,
        averageSkill,
        room.quality,
      );
    }
  }
}
