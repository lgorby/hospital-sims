import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { gameMinutesToTicks } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import { waitingQualityMultiplier } from '../src/sim/formulas';
import { updateDecay } from '../src/sim/systems/decay';
import { updateDispatcher } from '../src/sim/systems/dispatcher';
import { updateWayfinding } from '../src/sim/systems/wayfinding';
import { samePoint } from '../src/sim/types';
import { World } from '../src/sim/world';

/** Regression tests for the full-codebase audit findings. */

describe('audit #1: lost-timeout on a TRIAGE reservation', () => {
  it('returns the patient to waitingTriage — never strands an untriaged patient in waiting', () => {
    const world = new World(new EventBus(), 42);
    world.buildRoom('triage', { col: 30, row: 28, cols: 2, rows: 2 }, { col: 32, row: 29 }, true);
    expect(world.rooms.size).toBe(1);
    world.addStaffMember('nurse', 3, 150);

    const patient = world.spawnPatient('flu');
    patient.stage = { kind: 'waitingTriage' };
    patient.waitingSince = 0;
    patient.at = { col: 5, row: 5 };
    patient.next = null;
    patient.path = [];
    patient.target = null;

    updateDispatcher(world);
    expect(patient.stage.kind).toBe('reserved');
    expect(world.reservations.size).toBe(1);

    // Lost long enough that the 60-min timeout fires immediately.
    const timeoutTicks = gameMinutesToTicks(BALANCE.wayfinding.lostReservationTimeoutGameMinutes);
    patient.lost = { since: world.clock.tick - timeoutTicks };
    patient.path = [];
    patient.next = null;
    updateWayfinding(world);

    expect(world.reservations.size).toBe(0);
    // THE regression: 'waiting' here (with acuity null) was undispatchable forever.
    expect(patient.stage.kind).toBe('waitingTriage');
    expect(patient.acuity).toBeNull();
    expect(world.stageViolations).toEqual([]);

    // And the patient is genuinely re-dispatchable after recovery.
    patient.lost = null;
    patient.dispatchHoldUntil = 0;
    updateDispatcher(world);
    expect(patient.stage.kind).toBe('reserved');
    expect(world.reservations.size).toBe(1);
  });
});

describe('audit #5: stage-transition guard', () => {
  it('flags entering waiting without acuity (the #1 bug class) and illegal kind jumps', () => {
    const world = new World(new EventBus(), 1);
    const patient = world.spawnPatient('flu');
    expect(patient.acuity).toBeNull();

    world.setPatientStage(patient, { kind: 'waiting' }); // untriaged → waiting: illegal
    expect(world.stageViolations).toHaveLength(1);

    world.setPatientStage(patient, { kind: 'dead', since: 0 });
    world.setPatientStage(patient, { kind: 'atEntrance' }); // resurrection: illegal
    expect(world.stageViolations).toHaveLength(2);
  });
});

describe('audit #4: waiting-room quality slows patience decay (GDD §5)', () => {
  it('formula: 1 at quality 0, scaled down with size, floored', () => {
    expect(waitingQualityMultiplier(0)).toBe(1);
    expect(waitingQualityMultiplier(7)).toBeCloseTo(
      1 - BALANCE.decay.waitingQualityFactor * 7,
      10,
    );
    expect(waitingQualityMultiplier(1000)).toBe(BALANCE.decay.waitingQualityFloor);
  });

  it('system: a seated waiter in a roomy waiting room outlasts one in a minimal room', () => {
    const world = new World(new EventBus(), 7);
    world.buildRoom('waiting', { col: 4, row: 4, cols: 3, rows: 3 }, { col: 7, row: 5 }, true);
    world.buildRoom('waiting', { col: 20, row: 4, cols: 5, rows: 5 }, { col: 25, row: 6 }, true);
    const [small, big] = [...world.rooms.values()];
    expect(big!.quality).toBeGreaterThan(small!.quality);

    const park = (roomId: number, col: number, row: number): number => {
      const p = world.spawnPatient('flu');
      p.acuity = 3;
      p.stage = { kind: 'waiting' };
      p.waitingRoomId = roomId;
      p.at = { col, row };
      p.next = null;
      p.path = [];
      p.target = null;
      return p.id;
    };
    const inSmall = park(small!.id, 5, 5);
    const inBig = park(big!.id, 22, 6);

    updateDecay(world);
    const patienceSmall = world.patients.get(inSmall)!.patience;
    const patienceBig = world.patients.get(inBig)!.patience;
    expect(patienceBig).toBeGreaterThan(patienceSmall);
  });
});

describe('audit #8: debug command payloads are guarded at the sim boundary', () => {
  it('rejects non-finite cash and negative/NaN fast-forwards', () => {
    const world = new World(new EventBus(), 3);
    const queue = new CommandQueue();
    const cashBefore = world.cash;

    queue.push({ type: 'debugSetCash', amount: Number.NaN });
    queue.push({ type: 'debugSetCash', amount: Number.POSITIVE_INFINITY });
    queue.push({ type: 'debugFastForward', ticks: -100 });
    queue.push({ type: 'debugFastForward', ticks: Number.NaN });
    world.applyCommands(queue);

    expect(world.cash).toBe(cashBefore);
    expect(world.clock.tick).toBe(0);
  });
});

describe('audit #13: entrance overflow uses exclusive standing spots (Flow rules 1/14)', () => {
  it('three no-reception arrivals do not stack on the entrance tile', () => {
    const world = new World(new EventBus(), 9); // bare world: no reception at all
    const spots = [1, 2, 3].map(() => {
      const p = world.spawnPatient('flu');
      return p.target ?? p.at;
    });
    for (let a = 0; a < spots.length; a++) {
      for (let b = a + 1; b < spots.length; b++) {
        expect(samePoint(spots[a]!, spots[b]!)).toBe(false);
      }
    }
  });
});
