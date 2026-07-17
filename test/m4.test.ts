import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/events';
import { gameMinutesToTicks, TICKS_PER_DAY } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import type { DayReport } from '../src/sim/dailyStats';
import { ROLE_DEFS } from '../src/sim/data/roles';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';

/** M4: daily report, day-close bonus, bankruptcy lose-state. */
describe('daily report (M4)', () => {
  it('snapshots the day tally at midnight and resets it', () => {
    const events = new EventBus();
    const world = new World(events, 42);
    const reports: DayReport[] = [];
    events.on('dayEnded', (report) => reports.push(report));

    const victim = world.spawnPatient('flu');
    world.spawnPatient('laceration');
    world.killPatient(victim);
    world.billFee(500, 'test fee');

    for (let i = 0; i < TICKS_PER_DAY; i++) world.tick();

    expect(reports).toHaveLength(1);
    const day1 = reports[0]!;
    expect(day1.day).toBe(1);
    // Two manual spawns plus whatever the spawn system produced.
    expect(day1.arrivals).toBeGreaterThanOrEqual(2);
    // Decay deaths need ~20 game-hours from spawn — day 1 can only contain ours.
    expect(day1.died).toBe(1);
    expect(day1.revenue).toBe(500);
    expect(day1.treated).toBe(0);
    expect(day1.waitCount).toBe(0);
    expect(day1.avgWaitGameMinutes).toBeNull();
    expect(day1.waitBonusAwarded).toBe(false);
    expect(day1.cash).toBe(world.cash);

    // Tally reset: day 2's report starts from zero (no manual events now).
    for (let i = 0; i < TICKS_PER_DAY; i++) world.tick();
    expect(reports).toHaveLength(2);
    expect(reports[1]!.revenue).toBe(0);
    expect(reports[1]!.day).toBe(2);
  });

  it('repDelta records the APPLIED delta when clamping at 0', () => {
    const world = new World(new EventBus(), 1);
    world.reputation = 5;
    world.applyReputation(-BALANCE.reputation.deathLoss);
    expect(world.reputation).toBe(0);
    expect(world.today.repDelta).toBe(-5);
  });

  it('awards the day-close bonus when avg wait is under the threshold', () => {
    // Twin deterministic worlds, same seed: identical days except one had a
    // fast first-treatment injected. The rep gap must be exactly the bonus.
    const run = (waitGameMinutes: number): { report: DayReport; world: World } => {
      const events = new EventBus();
      const world = new World(events, 7);
      const reports: DayReport[] = [];
      events.on('dayEnded', (r) => reports.push(r));
      world.today.waitCount = 1;
      world.today.waitSumTicks = gameMinutesToTicks(waitGameMinutes);
      for (let i = 0; i < TICKS_PER_DAY; i++) world.tick();
      return { report: reports[0]!, world };
    };

    const fast = run(30);
    const slow = run(BALANCE.reputation.dayCloseWaitThresholdGameMinutes + 30);

    expect(fast.report.waitBonusAwarded).toBe(true);
    expect(fast.report.avgWaitGameMinutes).toBeCloseTo(30, 0);
    expect(slow.report.waitBonusAwarded).toBe(false);
    expect(fast.world.reputation - slow.world.reputation).toBe(
      BALANCE.reputation.dayCloseWaitBonus,
    );
    expect(fast.report.repDelta - slow.report.repDelta).toBe(BALANCE.reputation.dayCloseWaitBonus);
  });

});

describe('first-treatment wait pipeline (M4 review #4)', () => {
  it('records exactly one wait per patient, at treatment (not triage), spanning arrival→promotion', () => {
    const events = new EventBus();
    const world = new World(events, 11);
    setupNewGame(world);
    // Fracture is two-step (X-ray → casting): proves step 2 records nothing.
    world.buildRoom('triage', { col: 10, row: 28, cols: 2, rows: 2 }, { col: 12, row: 29 });
    world.buildRoom('exam', { col: 14, row: 27, cols: 3, rows: 3 }, { col: 17, row: 28 });
    world.buildRoom('xray', { col: 24, row: 26, cols: 3, rows: 4 }, { col: 27, row: 27 });
    expect(world.rooms.size).toBe(5);
    world.addStaffMember('nurse', 5, ROLE_DEFS.nurse.salaryPerDay);
    world.addStaffMember('doctor', 5, ROLE_DEFS.doctor.salaryPerDay);
    world.addStaffMember('radTech', 5, ROLE_DEFS.radTech.salaryPerDay);

    const patient = world.spawnPatient('fracture');

    // Ambient spawns also reach treatment, so assert the GLOBAL invariant:
    // tally = Σ spans over patients with a recorded first treatment (day 1).
    const tallyMatchesPatients = (): void => {
      let sum = 0;
      let count = 0;
      for (const p of world.patients.values()) {
        if (p.firstTreatedAtTick !== null) {
          sum += p.firstTreatedAtTick - p.arrivedAtTick;
          count += 1;
        }
      }
      expect(world.today.waitCount).toBe(count);
      expect(world.today.waitSumTicks).toBe(sum);
    };

    // Triage must NOT record: run until acuity is assigned, check nothing yet.
    const bound = TICKS_PER_DAY / 2;
    let i = 0;
    while (patient.acuity === null && i < bound) {
      world.tick();
      i++;
    }
    expect(patient.acuity).not.toBeNull();
    expect(patient.firstTreatedAtTick).toBeNull();

    // First treatment (X-ray) promotion records the span exactly once.
    while (patient.firstTreatedAtTick === null && i < bound) {
      world.tick();
      i++;
    }
    expect(patient.firstTreatedAtTick).not.toBeNull();
    expect(patient.firstTreatedAtTick!).toBeGreaterThan(patient.arrivedAtTick);
    tallyMatchesPatients();

    // Step 2 (casting) and everything after must not add a second record.
    while (world.patients.get(patient.id)?.stage.kind !== 'leaving' && i < bound) {
      world.tick();
      i++;
    }
    expect(patient.stage.kind).toBe('leaving');
    tallyMatchesPatients();
  });
});

describe('bankruptcy lose-state (M4)', () => {
  const grace = gameMinutesToTicks(BALANCE.economy.bankruptcyGraceGameMinutes);

  it('fires gameOver after a full day below the threshold and freezes the sim', () => {
    const events = new EventBus();
    const world = new World(events, 3);
    const overs: { day: number; cash: number }[] = [];
    events.on('gameOver', (p) => overs.push(p));

    world.cash = BALANCE.economy.bankruptcyThreshold - 1;
    for (let i = 0; i < grace + 5; i++) world.tick();

    expect(overs).toHaveLength(1);
    expect(world.gameOver).toBe(true);

    // Frozen: no clock advance, no further events, ever.
    const tickAtGameOver = world.clock.tick;
    for (let i = 0; i < 100; i++) world.tick();
    expect(world.clock.tick).toBe(tickAtGameOver);
    expect(overs).toHaveLength(1);
  });

  it('sitting exactly AT the threshold is not bankruptcy (strictly below)', () => {
    const world = new World(new EventBus(), 3);
    world.cash = BALANCE.economy.bankruptcyThreshold;
    for (let i = 0; i < grace + 5; i++) world.tick();
    expect(world.gameOver).toBe(false);
    expect(world.bankruptSinceTick).toBeNull();
  });

  it('recovering above the threshold resets the countdown', () => {
    const world = new World(new EventBus(), 3);
    world.cash = BALANCE.economy.bankruptcyThreshold - 1;
    for (let i = 0; i < Math.floor(grace / 2); i++) world.tick();
    expect(world.bankruptSinceTick).not.toBeNull();

    world.cash = 0; // rescued
    world.tick();
    expect(world.bankruptSinceTick).toBeNull();

    // Dipping below again starts a FRESH day-long countdown.
    world.cash = BALANCE.economy.bankruptcyThreshold - 1;
    for (let i = 0; i < Math.floor(grace / 2); i++) world.tick();
    expect(world.gameOver).toBe(false);
    for (let i = 0; i < Math.ceil(grace / 2) + 5; i++) world.tick();
    expect(world.gameOver).toBe(true);
  });
});
