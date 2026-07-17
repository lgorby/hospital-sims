import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { gameMinutesToTicks } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import { ROLE_DEFS } from '../src/sim/data/roles';
import type { Patient } from '../src/sim/entities/patient';
import { patienceDecayPerTick, wrongTurnChance } from '../src/sim/formulas';
import { setupNewGame } from '../src/sim/newGame';
import type { EventName } from '../src/events';
import { updateDecay } from '../src/sim/systems/decay';
import { updateDispatcher } from '../src/sim/systems/dispatcher';
import { updateMovement } from '../src/sim/systems/movement';
import { onPatientTileStep, updateWayfinding } from '../src/sim/systems/wayfinding';
import { rectContains } from '../src/sim/types';
import { World } from '../src/sim/world';

/** M3 stage 3/4: wrong turns, wandering, rescue, timeout, comfort decay. */

function setup(seed = 42) {
  const events = new EventBus();
  const world = new World(events, seed);
  const queue = new CommandQueue();
  const apply = () => world.applyCommands(queue);
  return { world, queue, events, apply };
}

/** A parked patient in a chosen stage with a fixed wayfinding stat. */
function makePatient(
  world: World,
  opts: { at?: { col: number; row: number }; wayfinding?: number; stage?: Patient['stage'] } = {},
): Patient {
  const patient = world.spawnPatient('flu');
  patient.stage = opts.stage ?? { kind: 'waiting' };
  patient.acuity = 5; // slowest health decay — keeps long walking tests alive
  patient.waitingSince = world.clock.tick;
  patient.wayfinding = opts.wayfinding ?? 1;
  if (opts.at) {
    patient.at = { ...opts.at };
    patient.next = null;
    patient.path = [];
    patient.target = null;
  }
  return patient;
}

/**
 * Drive ONLY wayfinding+movement (no spawn/decay interference, frozen clock):
 * walk the patient back and forth until they get lost or budget runs out.
 */
function walkUntilLost(world: World, patient: Patient, a: { col: number; row: number }, b: { col: number; row: number }, traversals: number): boolean {
  for (let i = 0; i < traversals && !patient.lost; i++) {
    world.setWalkerTarget(patient, i % 2 === 0 ? b : a);
    for (let t = 0; t < 1000 && !world.walkerArrived(patient) && !patient.lost; t++) {
      updateWayfinding(world);
      updateMovement(world);
    }
  }
  return patient.lost !== null;
}

const FAR_A = { col: 2, row: 2 };
const FAR_B = { col: 2, row: 36 };

describe('wrong turns (GDD §3)', () => {
  it('chance formula: 2%/tile for the worst navigators, 0.4% for the best', () => {
    expect(wrongTurnChance(1)).toBeCloseTo(0.02, 10);
    expect(wrongTurnChance(5)).toBeCloseTo(0.004, 10);
  });

  it('long care walks eventually lose a bad navigator: path abandoned, TARGET retained', () => {
    const t = setup();
    const patient = makePatient(t.world, { at: FAR_A, wayfinding: 1 });
    let lostEvents = 0;
    t.events.on('patientLost', () => lostEvents++);

    expect(walkUntilLost(t.world, patient, FAR_A, FAR_B, 60)).toBe(true);
    expect(lostEvents).toBe(1);
    expect(patient.path.length).toBe(0);
    expect(patient.next).toBeNull();
    expect(patient.target).not.toBeNull(); // the goal survives lostness
  });

  it('inside a staffed guidance aura the same walk NEVER rolls', () => {
    const t = setup();
    t.queue.push({
      type: 'buildRoom',
      roomType: 'atrium',
      rect: { col: 18, row: 16, cols: 4, rows: 4 },
      doorOutside: null,
    });
    t.apply();
    t.world.addStaffMember('greeter', 1, ROLE_DEFS.greeter.salaryPerDay);
    for (let i = 0; i < 3000; i++) {
      t.world.tick();
      if (t.world.atriumStaffed(t.world.roomsOfType('atrium')[0]!)) break;
    }
    // Walk entirely within the aura (row 18 sits inside the footprint rows).
    const patient = makePatient(t.world, { at: { col: 14, row: 18 }, wayfinding: 1 });
    const lost = walkUntilLost(t.world, patient, { col: 14, row: 18 }, { col: 25, row: 18 }, 60);
    expect(lost).toBe(false);
  });

  it('check-in queue walks never roll (structurally ineligible)', () => {
    const t = setup();
    const patient = makePatient(t.world, {
      at: FAR_A,
      wayfinding: 1,
      stage: { kind: 'queuedCheckIn', roomId: 999, slot: 3 },
    });
    expect(walkUntilLost(t.world, patient, FAR_A, FAR_B, 60)).toBe(false);
  });

  it('never rolls on the ARRIVAL tile — an arrived walker cannot go lost (M3 review)', () => {
    const t = setup();
    const patient = makePatient(t.world, { at: FAR_A, wayfinding: 1 });
    expect(t.world.walkerArrived(patient)).toBe(true);
    // Unguarded, 500 rolls at 2% would mark them lost with near-certainty.
    for (let i = 0; i < 500; i++) onPatientTileStep(t.world, patient);
    expect(patient.lost).toBeNull();
  });
});

describe('lost walkers stay wanderers (M3 review majors)', () => {
  it('a room build/sell recompute never hands a lost patient a purposeful path', () => {
    const t = setup();
    const patient = makePatient(t.world, { at: { col: 20, row: 20 } });
    patient.stage = { kind: 'reserved', reservationId: 777 };
    patient.target = { col: 5, row: 5 }; // retained reservation destination
    patient.lost = { since: t.world.clock.tick };

    t.world.buildRoom(
      'exam',
      { col: 30, row: 5, cols: 3, rows: 3 },
      { col: 31, row: 8 },
    );

    expect(patient.path.length).toBe(0); // still wandering, not marching
    expect(patient.next).toBeNull();
    expect(patient.target).toEqual({ col: 5, row: 5 }); // retained, untouched
  });

  it('cancelling a lost patient’s reservation leaves them wandering with NO walk target', () => {
    const t = setup();
    t.queue.push({
      type: 'buildRoom',
      roomType: 'er',
      rect: { col: 10, row: 10, cols: 3, rows: 4 },
      doorOutside: { col: 11, row: 14 },
    });
    t.apply();
    t.world.addStaffMember('doctor', 5, 300);
    const nurse = t.world.addStaffMember('nurse', 5, 150);
    const patient = makePatient(t.world, { at: FAR_A });
    patient.condition = 'chestPain';
    patient.acuity = 1;
    updateDispatcher(t.world);
    expect(t.world.reservations.size).toBe(1);

    patient.lost = { since: t.world.clock.tick }; // lost mid-gather
    t.queue.push({ type: 'fireStaff', staffId: nurse.id });
    t.apply(); // gathering fire ⇒ rule-8 cancel

    expect(t.world.reservations.size).toBe(0);
    expect(patient.stage.kind).toBe('waiting');
    expect(patient.lost).not.toBeNull(); // still lost — recovery assigns the spot
    expect(patient.target).toBeNull();
    expect(patient.path.length).toBe(0);
  });
});

describe('recovery (GDD §3)', () => {
  it('staff within rescue radius recover a lost patient instantly; beyond it, not', () => {
    const t = setup();
    const r = BALANCE.wayfinding.staffRescueRadius;
    const near = makePatient(t.world, { at: { col: 10, row: 10 } });
    near.lost = { since: t.world.clock.tick };
    t.world.addStaffMember('doctor', 3, 300).at = { col: 10 + r, row: 10 };

    const far = makePatient(t.world, { at: { col: 30, row: 30 } });
    far.lost = { since: t.world.clock.tick };

    updateWayfinding(t.world);
    expect(near.lost).toBeNull();
    expect(far.lost).not.toBeNull();
  });

  it('entering a guidance aura recovers and re-paths to the retained target', () => {
    const t = setup();
    t.queue.push({
      type: 'buildRoom',
      roomType: 'atrium',
      rect: { col: 10, row: 10, cols: 4, rows: 4 },
      doorOutside: null,
    });
    t.apply();
    const atrium = t.world.roomsOfType('atrium')[0]!;
    const greeter = t.world.addStaffMember('greeter', 1, ROLE_DEFS.greeter.salaryPerDay);
    for (let i = 0; i < 3000 && !t.world.atriumStaffed(atrium); i++) t.world.tick();

    // Lost at the aura's edge — well beyond the greeter's rescue radius.
    const auraEdge = { col: 10, row: 10 - BALANCE.wayfinding.guidanceAuraRadius };
    const dc = auraEdge.col - greeter.at.col;
    const dr = auraEdge.row - greeter.at.row;
    expect(dc * dc + dr * dr).toBeGreaterThan(BALANCE.wayfinding.staffRescueRadius ** 2);
    const patient = makePatient(t.world, { at: auraEdge });
    patient.target = { col: 30, row: 30 }; // retained destination
    patient.lost = { since: t.world.clock.tick };

    updateWayfinding(t.world);
    expect(patient.lost).toBeNull();
    expect(patient.target).toEqual({ col: 30, row: 30 });
    expect(patient.next).not.toBeNull(); // re-pathed and walking again
  });

  it('self-recovery rolls every 5 game-min and eventually succeeds', () => {
    const t = setup(11);
    const patient = makePatient(t.world, { at: { col: 30, row: 5 } });
    patient.lost = { since: t.world.clock.tick };
    const rollTicks = gameMinutesToTicks(BALANCE.wayfinding.selfRecoveryRollGameMinutes);

    let ticks = 0;
    const maxTicks = rollTicks * 60;
    while (patient.lost && ticks < maxTicks) {
      t.world.clock.advance();
      updateWayfinding(t.world);
      updateMovement(t.world);
      ticks++;
    }
    expect(patient.lost).toBeNull();
    expect(ticks).toBeGreaterThanOrEqual(rollTicks); // never before the first roll
  });
});

describe('lost reservation timeout (GDD §3, M3-gate semantics)', () => {
  it('releases room+staff, keeps the wait clock, sets NO walk target, fires no hint', () => {
    const t = setup();
    t.queue.push({
      type: 'buildRoom',
      roomType: 'exam',
      rect: { col: 30, row: 28, cols: 3, rows: 3 },
      doorOutside: { col: 31, row: 31 },
    });
    t.apply();
    const doctor = t.world.addStaffMember('doctor', 3, 300);
    doctor.at = { col: 35, row: 35 };
    const patient = makePatient(t.world, { at: FAR_A });
    patient.waitingSince = 0;
    updateDispatcher(t.world);
    expect(t.world.reservations.size).toBe(1);

    const timeoutTicks = gameMinutesToTicks(BALANCE.wayfinding.lostReservationTimeoutGameMinutes);
    patient.lost = { since: t.world.clock.tick - timeoutTicks }; // timeout due NOW
    let hints = 0;
    t.events.on('hint', () => hints++);

    updateWayfinding(t.world);
    expect(t.world.reservations.size).toBe(0);
    expect(patient.stage.kind).toBe('waiting');
    expect(patient.waitingSince).toBe(0); // wait clock survived (Flow rule 6)
    expect(patient.target).toBeNull(); // spot/re-path happen at RECOVERY
    expect(patient.lost).not.toBeNull(); // still wandering
    expect(doctor.duty.kind).toBe('idle');
    expect(hints).toBe(0);
  });
});

describe('wandering', () => {
  it('a lost wanderer never crosses a door edge into a walled room', () => {
    const t = setup();
    t.queue.push({
      type: 'buildRoom',
      roomType: 'exam',
      rect: { col: 10, row: 10, cols: 3, rows: 3 },
      doorOutside: { col: 11, row: 13 },
    });
    t.apply();
    const rect = { col: 10, row: 10, cols: 3, rows: 3 };
    const patient = makePatient(t.world, { at: { col: 11, row: 13 } }); // ON the door landing
    patient.lost = { since: t.world.clock.tick };
    // No staff, no auras; frozen clock → no self-recovery rolls. Pure wander.
    for (let i = 0; i < 500; i++) {
      updateWayfinding(t.world);
      updateMovement(t.world);
      expect(rectContains(rect, patient.at)).toBe(false);
      if (patient.next) expect(rectContains(rect, patient.next)).toBe(false);
    }
  });
});

describe('decay while lost / comfort aura (rules 3, 13; GDD §5)', () => {
  it('a lost patient in stage RESERVED drains patience and AMAs at zero, clearing lostness', () => {
    const t = setup();
    const patient = makePatient(t.world, { at: FAR_A });
    // Fake a reserved stage: lostness must decay patience regardless of stage.
    patient.stage = { kind: 'reserved', reservationId: 12345 };
    patient.lost = { since: t.world.clock.tick };
    patient.patience = 0.001;

    updateDecay(t.world);
    expect(patient.stage.kind).toBe('leaving');
    expect(patient.lost).toBeNull(); // exits clear lostness
  });

  it('comfort aura multiplies with the standing multiplier: 1.5 × 0.75', () => {
    const t = setup();
    t.queue.push({
      type: 'buildRoom',
      roomType: 'atrium',
      rect: { col: 10, row: 10, cols: 4, rows: 4 },
      doorOutside: null,
    });
    t.apply();
    const inComfort = makePatient(t.world, { at: { col: 11, row: 11 } });
    const outside = makePatient(t.world, { at: { col: 35, row: 35 } });
    for (const p of [inComfort, outside]) {
      p.acuity = 3;
      p.waitingRoomId = null; // standing
    }

    updateDecay(t.world);
    const base = patienceDecayPerTick(3) * BALANCE.decay.standingMultiplier;
    expect(100 - outside.patience).toBeCloseTo(base, 10);
    expect(100 - inComfort.patience).toBeCloseTo(
      base * BALANCE.wayfinding.comfortAuraPatienceMultiplier,
      10,
    );
  });
});

describe('dispatcher × lostness', () => {
  it('the dispatcher never reserves for a lost patient; recovery makes them eligible again', () => {
    const t = setup();
    t.queue.push({
      type: 'buildRoom',
      roomType: 'exam',
      rect: { col: 10, row: 10, cols: 3, rows: 3 },
      doorOutside: { col: 11, row: 13 },
    });
    t.apply();
    t.world.addStaffMember('doctor', 3, 300).at = { col: 38, row: 38 };
    const patient = makePatient(t.world, { at: { col: 20, row: 20 } });
    patient.lost = { since: t.world.clock.tick };

    for (let i = 0; i < 5; i++) updateDispatcher(t.world);
    expect(t.world.reservations.size).toBe(0);

    patient.lost = null;
    updateDispatcher(t.world);
    expect(t.world.reservations.size).toBe(1);
  });
});

describe('determinism (fixed-seed replay)', () => {
  it('two identical runs produce IDENTICAL EVENT LOGS — and the run exercises lostness', () => {
    const LOGGED: EventName[] = [
      'patientSpawned',
      'patientLost',
      'patientRecovered',
      'patientDied',
      'patientLeftAma',
      'patientDischarged',
      'patientComplication',
      'patientThought',
      'feeBilled',
      'staffHired',
      'hint',
    ];
    const run = (): string[] => {
      const t = setup(99);
      setupNewGame(t.world);
      const log: string[] = [];
      for (const name of LOGGED) {
        t.events.on(name, (payload) =>
          log.push(`${t.world.clock.tick}|${name}|${JSON.stringify(payload)}`),
        );
      }
      t.queue.push({
        type: 'buildRoom',
        roomType: 'triage',
        rect: { col: 10, row: 30, cols: 2, rows: 2 },
        doorOutside: { col: 10, row: 32 },
      });
      // Exam far NORTH: treated patients trek ~25 tiles of corridor, so the
      // run reliably produces lost patients and exercises wayfinding rng.
      t.queue.push({
        type: 'buildRoom',
        roomType: 'exam',
        rect: { col: 14, row: 6, cols: 3, rows: 3 },
        doorOutside: { col: 15, row: 9 },
      });
      t.queue.push({
        type: 'buildRoom',
        roomType: 'atrium',
        rect: { col: 24, row: 28, cols: 4, rows: 4 },
        doorOutside: null,
      });
      t.apply();
      t.world.addStaffMember('nurse', 3, 150);
      t.world.addStaffMember('doctor', 3, 300);
      t.world.addStaffMember('greeter', 2, 50);
      for (let i = 0; i < 4800; i++) t.world.tick();
      log.push(
        `final|${JSON.stringify({
          cash: t.world.cash,
          rep: t.world.reputation,
          rng: t.world.rng.next(),
          patients: [...t.world.patients.values()].map((p) => [
            p.id,
            p.at.col,
            p.at.row,
            p.stage.kind,
            p.lost !== null,
          ]),
        })}`,
      );
      return log;
    };
    const first = run();
    expect(run()).toEqual(first); // full event stream, tick-stamped
    expect(first.some((line) => line.includes('|patientLost|'))).toBe(true);
  });
});
