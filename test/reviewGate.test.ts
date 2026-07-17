import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { gameMinutesToTicks } from '../src/sim/clock';
import { WAITING_ROOM_BASE_CHAIRS } from '../src/sim/data/rooms';
import type { Patient } from '../src/sim/entities/patient';
import type { Reservation } from '../src/sim/entities/staff';
import { setupNewGame } from '../src/sim/newGame';
import { resolveTreatmentOutcome } from '../src/sim/systems/treatment';
import { samePoint } from '../src/sim/types';
import { World } from '../src/sim/world';

/**
 * Regression tests for the M3-gate adversarial review (pre-M3 fixes).
 * One test per finding; titles reference the violated contract.
 */

function setup(seed = 42) {
  const events = new EventBus();
  const world = new World(events, seed);
  const queue = new CommandQueue();
  const apply = () => world.applyCommands(queue);
  return { world, queue, events, apply };
}

function waitingPatient(world: World, acuity: number, condition: 'flu' | 'fracture' = 'flu') {
  const patient = world.spawnPatient(condition);
  patient.stage = { kind: 'waiting' };
  patient.acuity = acuity;
  patient.waitingSince = world.clock.tick;
  return patient;
}

function fakeReservation(world: World, patient: Patient, staffIds: number[] = []): Reservation {
  const reservation: Reservation = {
    id: world.takeId(),
    kind: 'treatment',
    patientId: patient.id,
    roomId: -1,
    staffIds,
    stepIndex: patient.stepIndex,
    phase: 'active',
    ticksRemaining: 0,
    patientWaitingSince: patient.waitingSince,
  };
  patient.stage = { kind: 'reserved', reservationId: reservation.id };
  patient.waitingSince = null;
  world.reservations.set(reservation.id, reservation);
  return reservation;
}

const EXAM_A = {
  type: 'buildRoom',
  roomType: 'exam',
  rect: { col: 5, row: 5, cols: 3, rows: 3 },
  doorOutside: { col: 6, row: 8 },
} as const;
const EXAM_B = {
  type: 'buildRoom',
  roomType: 'exam',
  rect: { col: 12, row: 5, cols: 3, rows: 3 },
  doorOutside: { col: 13, row: 8 },
} as const;

describe('dispatcher hot-loop (Flow rule 8 is a recovery, not a spin)', () => {
  it('never reserves an unreachable room — a reachable same-type room is used instead', () => {
    const t = setup();
    t.queue.push(EXAM_A);
    t.queue.push(EXAM_B);
    t.apply();
    const [examA, examB] = [...t.world.rooms.values()];
    // Sever exam A's door landing AFTER build (M3 wayfinding will produce
    // no-path states routinely; M2 build validation cannot).
    t.world.tileAt(examA!.door!.outside.col, examA!.door!.outside.row)!.walkable = false;
    t.world.addStaffMember('doctor', 3, 300);
    waitingPatient(t.world, 4);

    t.world.tick();

    const reservations = [...t.world.reservations.values()];
    expect(reservations.length).toBe(1);
    expect(reservations[0]!.roomId).toBe(examB!.id);
  });

  it('with ONLY an unreachable room: no reserve/cancel churn, no toast spam', () => {
    const t = setup();
    t.queue.push(EXAM_A);
    t.apply();
    const exam = [...t.world.rooms.values()][0]!;
    t.world.tileAt(exam.door!.outside.col, exam.door!.outside.row)!.walkable = false;
    t.world.addStaffMember('doctor', 3, 300);
    const patient = waitingPatient(t.world, 4);
    let hints = 0;
    t.events.on('hint', () => hints++);

    for (let i = 0; i < 50; i++) {
      t.world.tick();
      expect(t.world.reservations.size).toBe(0); // no doomed reservation, ever
    }
    expect(hints).toBe(0); // nothing was cancelled, so nothing toasts
    expect(patient.stage.kind).toBe('waiting');
  });

  it('a cancelled reservation sets a retry hold and hints at most once', () => {
    const t = setup();
    t.queue.push(EXAM_A);
    t.apply();
    t.world.addStaffMember('doctor', 3, 300);
    const patient = waitingPatient(t.world, 4);
    let hints = 0;
    t.events.on('hint', () => hints++);

    t.world.tick();
    expect(t.world.reservations.size).toBe(1);
    // Stall the patient mid-gather: stopped, outside the room (Flow rule 8).
    patient.next = null;
    patient.path = [];
    patient.target = null;
    t.world.tick(); // promoteGatheredReservations cancels
    expect(t.world.reservations.size).toBe(0);
    expect(hints).toBe(1);
    expect(patient.dispatchHoldUntil).toBeGreaterThan(t.world.clock.tick);

    // During the hold: the dispatcher must NOT re-reserve (the old hot loop).
    while (t.world.clock.tick + 1 < patient.dispatchHoldUntil) {
      t.world.tick();
      expect(t.world.reservations.size).toBe(0);
    }
    // After the hold: retried normally, and still only the one hint.
    for (let i = 0; i < 5 && t.world.reservations.size === 0; i++) t.world.tick();
    expect(t.world.reservations.size).toBe(1);
    expect(hints).toBe(1);
  });
});

describe('patience decay (Flow rule 3: not while purposefully walking)', () => {
  it('a patient walking to the check-in queue loses no patience; a queued one does', () => {
    const t = setup();
    setupNewGame(t.world);
    const receptionist = [...t.world.staff.values()][0]!;
    t.queue.push({ type: 'fireStaff', staffId: receptionist.id });
    t.queue.push({ type: 'debugSpawnPatient' });
    t.apply();
    const patient = [...t.world.patients.values()][0]!;
    expect(patient.stage.kind).toBe('queuedCheckIn');

    for (let i = 0; i < 2000 && !t.world.walkerArrived(patient); i++) t.world.tick();
    expect(t.world.walkerArrived(patient)).toBe(true);
    expect(patient.patience).toBe(100); // the walk was free (Flow rule 3)

    t.world.tick();
    expect(patient.patience).toBeLessThan(100); // waiting in place drains
  });
});

describe('priority aging survives re-queues (Flow rule 6 ruling)', () => {
  it('a complication re-queue keeps the accumulated wait clock', () => {
    const t = setup();
    t.queue.push(EXAM_A);
    t.apply();
    t.world.addStaffMember('doctor', 3, 300);
    const patient = waitingPatient(t.world, 3);
    expect(patient.waitingSince).toBe(0);

    t.world.tick(); // dispatcher reserves; the wait clock is stashed
    const reservation = [...t.world.reservations.values()][0]!;
    expect(reservation.patientWaitingSince).toBe(0);

    resolveTreatmentOutcome(t.world, reservation, false); // complication
    expect(patient.stage.kind).toBe('waiting');
    expect(patient.waitingSince).toBe(0); // NOT reset to clock.tick (=1)
  });

  it('a between-steps re-queue (multi-step path) keeps the accumulated wait clock', () => {
    const t = setup();
    const patient = t.world.spawnPatient('fracture');
    patient.stage = { kind: 'waiting' };
    patient.acuity = 3;
    patient.waitingSince = 123;
    const reservation = fakeReservation(t.world, patient);

    resolveTreatmentOutcome(t.world, reservation, true); // X-ray done → casting queue
    expect(patient.stepIndex).toBe(1);
    expect(patient.stage.kind).toBe('waiting');
    expect(patient.waitingSince).toBe(123);
  });

  it('an aged low-priority patient beats a fresh higher-acuity one (aging test the M2 suite lacked)', () => {
    const aged = setup();
    aged.queue.push(EXAM_A);
    aged.apply();
    aged.world.addStaffMember('doctor', 3, 300);
    const fresh3 = waitingPatient(aged.world, 3);
    const old4 = waitingPatient(aged.world, 4);
    // 4 hours of aging: 4 − 0.5×4 = 2.0 effective, beating a fresh 3.
    old4.waitingSince = -gameMinutesToTicks(4 * 60);
    aged.world.tick();
    expect([...aged.world.reservations.values()][0]!.patientId).toBe(old4.id);
    expect(fresh3.stage.kind).toBe('waiting');

    // Control: with equal waits, plain acuity order wins.
    const control = setup();
    control.queue.push(EXAM_A);
    control.apply();
    control.world.addStaffMember('doctor', 3, 300);
    const p3 = waitingPatient(control.world, 3);
    waitingPatient(control.world, 4);
    control.world.tick();
    expect([...control.world.reservations.values()][0]!.patientId).toBe(p3.id);
  });
});

describe('waiting-room overflow standing spots (Flow rules 4/14)', () => {
  it('overflow waiters get a real standing spot — outside walled rooms, never sharing a tile', () => {
    const t = setup();
    setupNewGame(t.world);
    t.queue.push({
      type: 'buildRoom',
      roomType: 'triage',
      rect: { col: 10, row: 30, cols: 2, rows: 2 },
      doorOutside: { col: 10, row: 32 },
    });
    t.apply();
    const reception = t.world.roomsOfType('reception')[0]!;
    for (let i = 0; i < WAITING_ROOM_BASE_CHAIRS; i++) {
      t.world.assignWaitingSpot(waitingPatient(t.world, 3));
    }

    // Overflow #1 finished triage and is standing INSIDE the triage bay.
    const inBay = waitingPatient(t.world, 3);
    inBay.at = { col: 10, row: 30 };
    t.world.assignWaitingSpot(inBay);
    expect(inBay.waitingRoomId).toBeNull();
    expect(inBay.target).not.toBeNull();
    const bayRoom = t.world.roomAt(inBay.target!);
    expect(bayRoom === null || bayRoom.type === 'waiting').toBe(true);

    // Overflow #2 finished check-in and is standing ON the desk slot.
    const atDesk = waitingPatient(t.world, 3);
    atDesk.at = { ...reception.door!.outside };
    t.world.assignWaitingSpot(atDesk);
    expect(atDesk.target).not.toBeNull();
    expect(samePoint(atDesk.target!, reception.door!.outside)).toBe(false); // off the desk
    expect(samePoint(atDesk.target!, inBay.target!)).toBe(false); // exclusive spots
  });
});

describe('check-in routing prefers staffed desks', () => {
  it('new arrivals queue at the staffed reception, not the empty unstaffed one', () => {
    const t = setup();
    setupNewGame(t.world);
    t.world.tick(); // receptionist gets posted
    const staffedId = [...t.world.staffedReceptionIds()][0]!;
    t.queue.push({
      type: 'buildRoom',
      roomType: 'reception',
      rect: { col: 26, row: 30, cols: 2, rows: 3 },
      doorOutside: { col: 28, row: 31 },
    });
    t.apply();

    const patient = t.world.spawnPatient('flu');
    expect(patient.stage.kind).toBe('queuedCheckIn');
    expect((patient.stage as { roomId: number }).roomId).toBe(staffedId);
  });

  it('patients stuck in a dead (unstaffed) queue migrate to a staffed desk with capacity', () => {
    const t = setup();
    setupNewGame(t.world);
    t.world.tick();
    const staffedId = [...t.world.staffedReceptionIds()][0]!;
    t.queue.push({
      type: 'buildRoom',
      roomType: 'reception',
      rect: { col: 26, row: 30, cols: 2, rows: 3 },
      doorOutside: { col: 28, row: 31 },
    });
    t.apply();
    const unstaffed = [...t.world.rooms.values()].find(
      (r) => r.type === 'reception' && r.id !== staffedId,
    )!;

    // Force a patient into the unstaffed queue (as pre-fix routing could).
    const patient = t.world.spawnPatient('flu');
    t.world.leaveQueue(patient);
    t.world.queueFor(unstaffed.id).push(patient.id);
    patient.stage = { kind: 'queuedCheckIn', roomId: unstaffed.id, slot: 0 };

    t.world.tick();
    expect((patient.stage as { roomId: number }).roomId).toBe(staffedId);
    expect(t.world.queueFor(unstaffed.id).length).toBe(0);
  });
});

describe('released staff (Flow rules 9/11)', () => {
  it('an idle-released staff member steps out of the walled room instead of loitering', () => {
    const t = setup();
    t.queue.push(EXAM_A);
    t.apply();
    const exam = [...t.world.rooms.values()][0]!;
    const doctor = t.world.addStaffMember('doctor', 3, 300);
    doctor.at = { col: 5, row: 6 }; // inside the exam room, off the bed tiles
    const patient = waitingPatient(t.world, 4);
    const reservation = fakeReservation(t.world, patient, [doctor.id]);
    reservation.roomId = exam.id;
    doctor.duty = { kind: 'reserved', reservationId: reservation.id };

    t.world.releaseReservation(reservation);
    expect(doctor.target).not.toBeNull();
    expect(t.world.roomAt(doctor.target!)).toBeNull(); // corridor, room sellable again
  });

  it('a released staff member en route stops walking to the released room', () => {
    const t = setup();
    t.queue.push(EXAM_A);
    t.apply();
    const exam = [...t.world.rooms.values()][0]!;
    const doctor = t.world.addStaffMember('doctor', 3, 300);
    t.world.setWalkerTarget(doctor, { col: 7, row: 5 }); // interior tile
    const patient = waitingPatient(t.world, 4);
    const reservation = fakeReservation(t.world, patient, [doctor.id]);
    reservation.roomId = exam.id;
    doctor.duty = { kind: 'reserved', reservationId: reservation.id };

    t.world.releaseReservation(reservation);
    expect(doctor.target).toBeNull(); // stale walk target cleared
    expect(doctor.path.length).toBe(0);
  });
});
