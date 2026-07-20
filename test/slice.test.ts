import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { TICKS_PER_DAY } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import { CONDITION_DEFS } from '../src/sim/data/conditions';
import type { Reservation } from '../src/sim/entities/staff';
import { gameMinutesToTicks } from '../src/sim/clock';
import {
  reputationArrivalMultiplier,
  scaledFee,
  treatmentDurationTicks,
} from '../src/sim/formulas';
import { setupNewGame } from '../src/sim/newGame';
import { resolveTreatmentOutcome } from '../src/sim/systems/treatment';
import { World } from '../src/sim/world';

function setup(seed = 42) {
  const events = new EventBus();
  const world = new World(events, seed);
  const queue = new CommandQueue();
  const apply = () => world.applyCommands(queue);
  return { world, queue, events, apply };
}

/** Insert a synthetic active reservation so outcome paths can be driven directly. */
function fakeTreatmentReservation(world: World, patientId: number): Reservation {
  const reservation: Reservation = {
    id: world.takeId(),
    kind: 'treatment',
    patientId,
    roomId: -1,
    staffIds: [],
    stepIndex: 0,
    slotIndex: 0,
    phase: 'active',
    ticksRemaining: 0,
    patientWaitingSince: null,
  };
  world.reservations.set(reservation.id, reservation);
  return reservation;
}

describe('M2 vertical slice', () => {
  it('a flu patient flows arrive → check-in → triage → exam → discharged', () => {
    const t = setup();
    setupNewGame(t.world);
    // Triage bay and exam room along the west corridor.
    t.queue.push({
      type: 'buildRoom',
      roomType: 'triage',
      rect: { col: 10, row: 30, cols: 2, rows: 2 },
      doorOutside: { col: 10, row: 32 },
    });
    t.queue.push({
      type: 'buildRoom',
      roomType: 'exam',
      rect: { col: 14, row: 30, cols: 3, rows: 3 },
      doorOutside: { col: 15, row: 33 },
    });
    t.apply();
    expect(t.world.rooms.size).toBe(4); // reception + waiting pre-built

    // Hire one nurse and one doctor from the candidate pool.
    const nurse = t.world.candidates.find((c) => c.role === 'nurse')!;
    const doctor = t.world.candidates.find((c) => c.role === 'doctor')!;
    t.queue.push({ type: 'hireStaff', candidateId: nurse.id, shift: 'day' });
    t.queue.push({ type: 'hireStaff', candidateId: doctor.id, shift: 'day' });
    t.queue.push({ type: 'debugSpawnPatient' });
    t.apply();

    let discharged = 0;
    let died = 0;
    t.events.on('patientDischarged', () => discharged++);
    t.events.on('patientDied', () => died++);

    for (let i = 0; i < TICKS_PER_DAY && discharged === 0; i++) t.world.tick();

    expect(discharged).toBeGreaterThanOrEqual(1);
    expect(died).toBe(0);
  });

  it('with no reception built, patients wait at the entrance and eventually leave AMA', () => {
    const t = setup();
    t.queue.push({ type: 'debugSpawnPatient' });
    t.apply();
    const patient = [...t.world.patients.values()][0]!;
    expect(patient.stage.kind).toBe('atEntrance');
    let left = 0;
    t.events.on('patientLeftAma', () => left++);
    patient.patience = 0.01; // one tick of decay (0.04) empties it
    t.world.tick();
    expect(left).toBe(1);
    expect(t.world.reputation).toBe(
      BALANCE.reputation.starting - BALANCE.reputation.amaLoss,
    );
  });
});

describe('treatment outcomes', () => {
  it('failure = complication: health penalty, same step re-queued, never instant death', () => {
    const t = setup();
    const patient = t.world.spawnPatient('flu');
    patient.acuity = 4;
    const reservation = fakeTreatmentReservation(t.world, patient.id);
    patient.stage = { kind: 'reserved', reservationId: reservation.id };

    resolveTreatmentOutcome(t.world, reservation, false);

    expect(patient.health).toBe(100 - BALANCE.treatment.complicationHealthPenalty);
    expect(patient.stage.kind).toBe('waiting');
    expect(patient.stepIndex).toBe(0); // must repeat the step
    expect(t.world.reservations.size).toBe(0);
  });

  it('success on the last step bills the fee and discharges with reputation gain', () => {
    const t = setup();
    const startCash = t.world.cash;
    const startRep = t.world.reputation;
    const patient = t.world.spawnPatient('flu');
    patient.acuity = 5;
    const reservation = fakeTreatmentReservation(t.world, patient.id);
    patient.stage = { kind: 'reserved', reservationId: reservation.id };

    resolveTreatmentOutcome(t.world, reservation, true);

    // §3.1 rule 6: assert the real data — the LIST fee scaled by the economy knob.
    const fluFee = scaledFee(CONDITION_DEFS.flu.steps[0]!.fee);
    expect(t.world.cash).toBe(startCash + fluFee);
    expect(patient.billed).toBe(fluFee);
    expect(patient.stage).toEqual({ kind: 'leaving', reason: 'discharged' });
    expect(t.world.reputation).toBe(startRep + BALANCE.reputation.dischargeGainMin);
  });

  it('a complication that empties health kills — death only at health 0', () => {
    const t = setup();
    const patient = t.world.spawnPatient('flu');
    patient.acuity = 2;
    patient.health = BALANCE.treatment.complicationHealthPenalty - 1;
    const reservation = fakeTreatmentReservation(t.world, patient.id);
    patient.stage = { kind: 'reserved', reservationId: reservation.id };
    let died = 0;
    t.events.on('patientDied', () => died++);

    resolveTreatmentOutcome(t.world, reservation, false);

    expect(died).toBe(1);
    expect(patient.stage.kind).toBe('dead');
    expect(t.world.reservations.size).toBe(0);
  });
});

describe('death and reservation release', () => {
  it('death mid-reservation frees the staff (Flow rule 7) and fades out', () => {
    const t = setup();
    const doctor = t.world.addStaffMember('doctor', 3, 300);
    const patient = t.world.spawnPatient('flu');
    const reservation = fakeTreatmentReservation(t.world, patient.id);
    reservation.staffIds.push(doctor.id);
    doctor.duty = { kind: 'reserved', reservationId: reservation.id };
    patient.stage = { kind: 'reserved', reservationId: reservation.id };

    t.queue.push({ type: 'debugForce', patientId: patient.id, outcome: 'death' });
    t.apply();

    expect(doctor.duty.kind).toBe('idle');
    expect(t.world.reservations.size).toBe(0);
    expect(patient.stage.kind).toBe('dead');
    // Fade window elapses → entity removed.
    for (let i = 0; i <= BALANCE.deathFadeTicks + 1; i++) t.world.tick();
    expect(t.world.patients.has(patient.id)).toBe(false);
  });

  it('firing a busy staff member defers removal until the job releases', () => {
    const t = setup();
    const doctor = t.world.addStaffMember('doctor', 3, 300);
    const patient = t.world.spawnPatient('flu');
    patient.acuity = 4;
    const reservation = fakeTreatmentReservation(t.world, patient.id);
    reservation.staffIds.push(doctor.id);
    doctor.duty = { kind: 'reserved', reservationId: reservation.id };
    patient.stage = { kind: 'reserved', reservationId: reservation.id };

    t.queue.push({ type: 'fireStaff', staffId: doctor.id });
    t.apply();
    expect(t.world.staff.has(doctor.id)).toBe(true); // still mid-job

    resolveTreatmentOutcome(t.world, reservation, true);
    expect(t.world.staff.has(doctor.id)).toBe(false); // gone once released
  });
});

describe('M2 review regression cases', () => {
  it('a gathering reservation with an unpathable participant is cancelled, not stalled', () => {
    const t = setup();
    // Exam room + doctor; patient reserved but standing OUTSIDE with no path/goal.
    t.queue.push({
      type: 'buildRoom',
      roomType: 'exam',
      rect: { col: 10, row: 10, cols: 3, rows: 3 },
      doorOutside: { col: 11, row: 13 },
    });
    t.apply();
    const room = [...t.world.rooms.values()][0]!;
    const doctor = t.world.addStaffMember('doctor', 3, 300);
    const patient = t.world.spawnPatient('flu');
    patient.acuity = 4;
    const reservation = fakeTreatmentReservation(t.world, patient.id);
    reservation.roomId = room.id;
    reservation.staffIds.push(doctor.id);
    reservation.phase = 'gathering';
    doctor.duty = { kind: 'reserved', reservationId: reservation.id };
    patient.stage = { kind: 'reserved', reservationId: reservation.id };
    // Patient is stopped (arrived, no target) far from the room — a stall.
    // (Spawn now assigns entrance-overflow standing spots — audit #13 — so
    // clear the walk explicitly to stage the stall this test is about.)
    patient.next = null;
    patient.path = [];
    patient.target = null;
    expect(t.world.walkerArrived(patient)).toBe(true);

    t.world.tick();

    expect(t.world.reservations.size).toBe(0);
    expect(patient.stage.kind).toBe('waiting'); // re-queued, not pinned
    expect(doctor.duty.kind).toBe('idle');
  });

  it('rejects building on top of a staff member', () => {
    const t = setup();
    const doctor = t.world.addStaffMember('doctor', 3, 300);
    doctor.at = { col: 11, row: 11 };
    t.queue.push({
      type: 'buildRoom',
      roomType: 'exam',
      rect: { col: 10, row: 10, cols: 3, rows: 3 },
      doorOutside: { col: 11, row: 13 },
    });
    const rejections: string[] = [];
    t.events.on('buildRejected', ({ reason }) => rejections.push(reason));
    t.apply();
    expect(rejections.length).toBe(1);
    expect(t.world.rooms.size).toBe(0);
  });

  it('check-in reverts to the desk slot when the receptionist is fired mid-timer', () => {
    const t = setup();
    setupNewGame(t.world);
    t.queue.push({ type: 'debugSpawnPatient' });
    t.apply();
    const patient = [...t.world.patients.values()][0]!;
    // Walk + start check-in.
    for (let i = 0; i < 2000 && patient.stage.kind !== 'checkingIn'; i++) t.world.tick();
    expect(patient.stage.kind).toBe('checkingIn');
    const receptionist = [...t.world.staff.values()][0]!;
    t.queue.push({ type: 'fireStaff', staffId: receptionist.id });
    t.apply();
    t.world.tick();
    expect(patient.stage.kind).toBe('queuedCheckIn'); // reverted, not headless
    for (let i = 0; i < 100; i++) t.world.tick();
    expect(patient.stage.kind).toBe('queuedCheckIn'); // and it stays that way
  });

  it('realized arrival rate stays within ±20% of base × curve × reputation', () => {
    const t = setup(7);
    let spawned = 0;
    t.events.on('patientSpawned', () => spawned++);
    // Patients pile up atEntrance (no reception) — cheap and deterministic.
    const days = 2;
    for (let i = 0; i < TICKS_PER_DAY * days; i++) t.world.tick();
    // Expected/day = base × repMult(starting) × Σ(blockHours × multiplier),
    // computed from the real balance data (§3.1 rule 6), not a re-derived copy.
    let curveHours = 0;
    let prevUntil = 0;
    for (const block of BALANCE.arrivals.timeOfDayCurve) {
      curveHours += (block.untilHour - prevUntil) * block.multiplier;
      prevUntil = block.untilHour;
    }
    const expected =
      BALANCE.arrivals.basePatientsPerGameHour *
      reputationArrivalMultiplier(BALANCE.reputation.starting) *
      curveHours *
      days;
    expect(spawned).toBeGreaterThan(expected * 0.8);
    expect(spawned).toBeLessThan(expected * 1.2);
  });

  it('treatment duration is floored — giant rooms cannot make treatments instant', () => {
    const t = setup();
    void t;
    const floored = treatmentDurationTicks(30, 3, 1000);
    // At skill 3 the skill modifier is exactly 1.0, so the floor is the whole
    // story: 30 min × durationQualityFloor — never 1 tick (§3.1 rule 6 data).
    expect(floored).toBe(gameMinutesToTicks(30 * BALANCE.treatment.durationQualityFloor));
  });

  it('pure decay reaches death and costs reputation', () => {
    const t = setup();
    const patient = t.world.spawnPatient('flu');
    patient.health = 0.01;
    const startRep = t.world.reputation;
    t.world.tick();
    expect(patient.stage.kind).toBe('dead');
    expect(t.world.reputation).toBe(startRep - BALANCE.reputation.deathLoss);
  });
});

describe('economy', () => {
  it('charges salaries hourly, pro-rated from per-day rates', () => {
    const t = setup();
    t.world.addStaffMember('doctor', 3, 300);
    t.world.addStaffMember('nurse', 3, 150);
    const startCash = t.world.cash;
    const ticksPerHour = TICKS_PER_DAY / 24;
    for (let i = 0; i < ticksPerHour; i++) t.world.tick();
    expect(t.world.cash).toBeCloseTo(startCash - 450 / 24, 5);
  });
});
