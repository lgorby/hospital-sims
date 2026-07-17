import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { TICKS_PER_DAY } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import { CONDITION_DEFS, CONDITION_IDS, type ConditionId } from '../src/sim/data/conditions';
import type { Patient } from '../src/sim/entities/patient';
import type { Reservation } from '../src/sim/entities/staff';
import { conditionSpawnWeights } from '../src/sim/formulas';
import { setupNewGame } from '../src/sim/newGame';
import { findPath } from '../src/sim/path/astar';
import { rollCondition } from '../src/sim/systems/spawn';
import { resolveTreatmentOutcome } from '../src/sim/systems/treatment';
import { World } from '../src/sim/world';

/** M3 stage 1: full roster, weighted spawn mix, multi-step paths, dual-staff ER. */

function setup(seed = 42) {
  const events = new EventBus();
  const world = new World(events, seed);
  const queue = new CommandQueue();
  const apply = () => world.applyCommands(queue);
  return { world, queue, events, apply };
}

function fakeReservation(world: World, patient: Patient): Reservation {
  const reservation: Reservation = {
    id: world.takeId(),
    kind: 'treatment',
    patientId: patient.id,
    roomId: -1,
    staffIds: [],
    stepIndex: patient.stepIndex,
    phase: 'active',
    ticksRemaining: 0,
    patientWaitingSince: patient.waitingSince,
  };
  patient.stage = { kind: 'reserved', reservationId: reservation.id };
  world.reservations.set(reservation.id, reservation);
  return reservation;
}

const ER_ROOM = {
  type: 'buildRoom',
  roomType: 'er',
  rect: { col: 10, row: 10, cols: 3, rows: 4 },
  doorOutside: { col: 11, row: 14 },
} as const;

describe('condition spawn mix (GDD §3 + §7 case-mix shift)', () => {
  it('weights match the balance table at starting reputation and shift referral-grade cases with rep', () => {
    const base = conditionSpawnWeights(BALANCE.reputation.starting);
    for (const id of CONDITION_IDS) {
      expect(base[id]).toBe(BALANCE.arrivals.conditionWeights[id]);
    }

    const atMax = conditionSpawnWeights(BALANCE.reputation.max);
    for (const id of CONDITION_IDS) {
      const referral = CONDITION_DEFS[id].acuityMin <= BALANCE.arrivals.referralAcuityMax;
      const expected =
        BALANCE.arrivals.conditionWeights[id] *
        (referral ? 1 + BALANCE.arrivals.caseMixShiftFactor : 1);
      expect(atMax[id]).toBeCloseTo(expected, 10);
    }

    // Low-rep hospitals see FEWER referral cases, never a negative weight.
    const atZero = conditionSpawnWeights(0);
    expect(atZero.chestPain).toBeLessThan(base.chestPain);
    expect(atZero.chestPain).toBeGreaterThan(0);
    expect(atZero.flu).toBe(base.flu);
  });

  it('rollCondition realizes the weighted mix (seeded, all conditions appear)', () => {
    const t = setup(123);
    const draws = 6000;
    const counts = Object.fromEntries(CONDITION_IDS.map((id) => [id, 0])) as Record<
      ConditionId,
      number
    >;
    for (let i = 0; i < draws; i++) counts[rollCondition(t.world)]++;

    const weights = conditionSpawnWeights(t.world.reputation);
    const total = CONDITION_IDS.reduce((sum, id) => sum + weights[id], 0);
    for (const id of CONDITION_IDS) {
      expect(counts[id]).toBeGreaterThan(0);
      const share = counts[id]! / draws;
      expect(Math.abs(share - weights[id] / total)).toBeLessThan(0.05);
    }
  });
});

describe('multi-step paths run end-to-end (fracture: X-ray → casting)', () => {
  it('a fracture patient is X-rayed, re-queued, casted, and discharged with per-step billing', () => {
    const t = setup();
    setupNewGame(t.world);
    t.queue.push({
      type: 'buildRoom',
      roomType: 'triage',
      rect: { col: 10, row: 30, cols: 2, rows: 2 },
      doorOutside: { col: 10, row: 32 },
    });
    t.queue.push({
      type: 'buildRoom',
      roomType: 'xray',
      rect: { col: 5, row: 24, cols: 3, rows: 4 },
      doorOutside: { col: 6, row: 28 },
    });
    t.queue.push({
      type: 'buildRoom',
      roomType: 'exam',
      rect: { col: 14, row: 30, cols: 3, rows: 3 },
      doorOutside: { col: 15, row: 33 },
    });
    t.apply();
    t.world.addStaffMember('nurse', 5, 150);
    t.world.addStaffMember('radTech', 5, 200);
    t.world.addStaffMember('doctor', 5, 300);
    t.queue.push({ type: 'debugSpawnPatient', condition: 'fracture' });
    t.apply();
    const fracture = [...t.world.patients.values()][0]!;
    expect(fracture.condition).toBe('fracture');

    let billedOnDischarge = -1;
    t.events.on('patientDischarged', ({ patientId, totalBilled }) => {
      if (patientId === fracture.id) billedOnDischarge = totalBilled;
    });
    const fees: number[] = [];
    t.events.on('feeBilled', ({ amount, label }) => {
      if (label.startsWith(CONDITION_DEFS.fracture.label)) fees.push(amount);
    });

    for (let i = 0; i < 3 * TICKS_PER_DAY && billedOnDischarge < 0; i++) t.world.tick();

    const stepFees = CONDITION_DEFS.fracture.steps.map((s) => s.fee);
    expect(billedOnDischarge).toBe(stepFees.reduce((a, b) => a + b, 0));
    expect(fees).toEqual(stepFees); // one bill per step, in path order
  });
});

describe('dual-staff ER (chest pain: doctor + nurse)', () => {
  it('reservations are all-or-nothing and contention resolves without deadlock', () => {
    const t = setup(7);
    t.queue.push(ER_ROOM);
    t.apply();
    const doctor = t.world.addStaffMember('doctor', 5, 300);
    const nurse = t.world.addStaffMember('nurse', 5, 150);
    const chestPains = [1, 2].map(() => {
      const p = t.world.spawnPatient('chestPain');
      p.stage = { kind: 'waiting' };
      p.acuity = 1;
      p.waitingSince = t.world.clock.tick;
      return p;
    });

    t.world.tick();
    // Exactly ONE reservation with BOTH roles — never a partial hold.
    expect(t.world.reservations.size).toBe(1);
    expect([...t.world.reservations.values()][0]!.staffIds.length).toBe(
      CONDITION_DEFS.chestPain.steps[0]!.roles.length,
    );

    let discharged = 0;
    t.events.on('patientDischarged', () => discharged++);
    for (let i = 0; i < 3 * TICKS_PER_DAY && discharged < 2; i++) {
      t.world.tick();
      for (const r of t.world.reservations.values()) {
        expect(r.staffIds.length).toBe(CONDITION_DEFS.chestPain.steps[0]!.roles.length);
      }
    }
    expect(discharged).toBe(2); // both served in turn — no starvation, no deadlock
    expect(chestPains[0]!.stage.kind).toBe('leaving');
    expect(t.world.reservations.size).toBe(0);
    expect(doctor.duty.kind).toBe('idle');
    expect(nurse.duty.kind).toBe('idle');
  });

  it('firing one of two GATHERED staff cancels per Flow rule 8 (no lockup behind a fired colleague)', () => {
    const t = setup();
    t.queue.push(ER_ROOM);
    t.apply();
    const doctor = t.world.addStaffMember('doctor', 5, 300);
    const nurse = t.world.addStaffMember('nurse', 5, 150);
    const patient = t.world.spawnPatient('chestPain');
    patient.stage = { kind: 'waiting' };
    patient.acuity = 1;
    patient.waitingSince = t.world.clock.tick;
    let hints = 0;
    t.events.on('hint', () => hints++);

    t.world.tick();
    expect(t.world.reservations.size).toBe(1);
    expect([...t.world.reservations.values()][0]!.phase).toBe('gathering');

    t.queue.push({ type: 'fireStaff', staffId: nurse.id });
    t.apply();

    expect(t.world.reservations.size).toBe(0); // cancelled, not locked for 90 min
    expect(t.world.staff.has(nurse.id)).toBe(false); // fired immediately
    expect(t.world.staff.has(doctor.id)).toBe(true);
    expect(doctor.duty.kind).toBe('idle');
    expect(patient.stage.kind).toBe('waiting');
    expect(patient.waitingSince).toBe(0); // wait clock intact (Flow rule 6 ruling)
    expect(hints).toBe(0); // no misleading corridor hint
  });

  it('death mid-gather releases BOTH reserved staff (Flow rule 7, dual-staff)', () => {
    const t = setup();
    t.queue.push(ER_ROOM);
    t.apply();
    const doctor = t.world.addStaffMember('doctor', 5, 300);
    const nurse = t.world.addStaffMember('nurse', 5, 150);
    const patient = t.world.spawnPatient('chestPain');
    patient.stage = { kind: 'waiting' };
    patient.acuity = 1;
    patient.waitingSince = t.world.clock.tick;

    t.world.tick();
    expect(t.world.reservations.size).toBe(1);
    t.queue.push({ type: 'debugForce', patientId: patient.id, outcome: 'death' });
    t.apply();

    expect(t.world.reservations.size).toBe(0);
    expect(doctor.duty.kind).toBe('idle');
    expect(nurse.duty.kind).toBe('idle');
  });
});

describe('per-step billing is final (GDD §6)', () => {
  it('an AMA after step 1 keeps the X-ray fee', () => {
    const t = setup();
    const startCash = t.world.cash;
    const patient = t.world.spawnPatient('fracture');
    patient.acuity = 3;
    patient.waitingSince = 0;
    const reservation = fakeReservation(t.world, patient);

    resolveTreatmentOutcome(t.world, reservation, true); // X-ray billed
    const xrayFee = CONDITION_DEFS.fracture.steps[0]!.fee;
    expect(t.world.cash).toBe(startCash + xrayFee);

    t.world.patientLeavesAma(patient);
    expect(t.world.cash).toBe(startCash + xrayFee); // no refund, no extra charge
    expect(patient.billed).toBe(xrayFee);
  });

  it('death after step 1 keeps the X-ray fee (death mirrors AMA)', () => {
    const t = setup();
    const startCash = t.world.cash;
    const patient = t.world.spawnPatient('fracture');
    patient.acuity = 3;
    patient.waitingSince = 0;
    const reservation = fakeReservation(t.world, patient);

    resolveTreatmentOutcome(t.world, reservation, true);
    const xrayFee = CONDITION_DEFS.fracture.steps[0]!.fee;
    t.world.killPatient(patient);
    expect(t.world.cash).toBe(startCash + xrayFee);
  });
});

describe('A* path variety (deterministic per-walker tie-breaking)', () => {
  it('same seed → identical path; different seeds spread across equally-short paths', () => {
    const t = setup(); // empty 40×40 grid — many equal-length routes
    const start = { col: 0, row: 0 };
    const goal = { col: 8, row: 8 };
    const baseline = findPath(t.world, start, goal)!;
    const paths = [1, 2, 3, 4, 5].map((seed) => findPath(t.world, start, goal, seed)!);

    for (const path of paths) {
      expect(path.length).toBe(baseline.length); // variety never costs steps
      expect(path[0]).toEqual(start);
      expect(path[path.length - 1]).toEqual(goal);
    }
    expect(findPath(t.world, start, goal, 3)).toEqual(paths[2]); // deterministic

    const shapes = new Set(paths.map((p) => JSON.stringify(p)));
    expect(shapes.size).toBeGreaterThan(1); // at least two distinct routes
  });
});
