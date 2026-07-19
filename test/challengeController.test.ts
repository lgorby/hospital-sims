import { describe, expect, it, vi } from 'vitest';
import { EventBus, type GameOverPayload } from '../src/events';
import { gameMinutesToTicks, TICKS_PER_DAY } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import type { ChallengeSpec } from '../src/sim/data/challenges';
import type { DayReport } from '../src/sim/dailyStats';
import { cleanlinessRepDelta } from '../src/sim/formulas';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';
import { ChallengeController } from '../src/ui/challengeController';
import type { ChallengeResult } from '../src/ui/challengeController';
import type { DailyReportModal } from '../src/ui/dailyReport';
import type { ChallengeResultCard } from '../src/ui/challengeResultCard';
import { MidnightModalCoordinator } from '../src/ui/midnightModal';

/**
 * Phase 2 — Track 2 (UI logic) regression suite: the challenge controller's
 * two-terminal once-latch (plan §5) and the coordinator's single-overlay
 * decision (plan §6). No DOM — the overlays are recording fakes.
 */

function urlSpec(goalDay: number, metric: ChallengeSpec['goal']['metric'] = 'reputation'): ChallengeSpec {
  return { source: 'url', id: null, scenario: { kind: 'default', seed: 1337 }, goal: { metric, day: goalDay } };
}

function fakeWorld(lifetimeTreated: number, lifetimeDied: number): World {
  return { lifetimeTreated, lifetimeDied } as unknown as World;
}

function makeReport(day: number, over: Partial<DayReport> = {}): DayReport {
  return {
    day,
    arrivals: 0,
    treated: 0,
    died: 0,
    leftAma: 0,
    electiveTreated: 0,
    electiveNoShow: 0,
    lostEpisodes: 0,
    revenue: 0,
    payroll: 0,
    hireFees: 0,
    construction: 0,
    sellIncome: 0,
    vendingRevenue: 0,
    messTicks: 0,
    repDelta: 0,
    waitSumTicks: 0,
    waitCount: 0,
    cash: 0,
    reputation: 0,
    avgWaitGameMinutes: null,
    waitBonusAwarded: false,
    ...over,
  };
}

const GAME_OVER: GameOverPayload = { day: 2, cash: -9000, reputation: 120, treated: 4, died: 5 };

describe('ChallengeController — two terminals, once-latch (plan §5)', () => {
  it('resolveIfTerminal is null before goal.day and non-null exactly at it', () => {
    const events = new EventBus();
    const c = new ChallengeController(fakeWorld(0, 0), events, urlSpec(3));
    expect(c.resolveIfTerminal(makeReport(2))).toBeNull();
    const result = c.resolveIfTerminal(makeReport(3, { reputation: 500 }));
    expect(result?.outcome).toBe('reached');
    expect(result?.score).toBe(500);
  });

  it('reached-path terminal reads world.lifetimeTreated/Died directly (plan §5)', () => {
    const events = new EventBus();
    const c = new ChallengeController(fakeWorld(7, 2), events, urlSpec(1));
    const result = c.resolveIfTerminal(makeReport(1));
    expect(result?.context.terminal.lifetimeTreated).toBe(7);
    expect(result?.context.terminal.lifetimeDied).toBe(2);
  });

  it('a reached run that later busts emits challengeComplete exactly ONCE', () => {
    const events = new EventBus();
    const emitted = vi.fn();
    events.on('challengeComplete', emitted);
    const c = new ChallengeController(fakeWorld(0, 0), events, urlSpec(3));

    const reached = c.resolveIfTerminal(makeReport(3, { reputation: 800 }));
    expect(reached?.outcome).toBe('reached');
    // The run plays on and later busts — must NOT emit a second event.
    expect(c.onGameOver(GAME_OVER)).toBeNull();
    expect(emitted).toHaveBeenCalledTimes(1);
    expect(emitted.mock.calls[0]![0].outcome).toBe('reached');
  });

  it('a bust before goal.day emits ONE dnf; a later goal-day close is inert', () => {
    const events = new EventBus();
    const emitted = vi.fn();
    events.on('challengeComplete', emitted);
    const c = new ChallengeController(fakeWorld(0, 0), events, urlSpec(3));

    const dnf = c.onGameOver(GAME_OVER);
    expect(dnf?.outcome).toBe('dnf');
    expect(dnf?.context.day).toBe(2); // bust day, from the payload
    expect(c.resolveIfTerminal(makeReport(3))).toBeNull();
    expect(emitted).toHaveBeenCalledTimes(1);
    expect(emitted.mock.calls[0]![0].outcome).toBe('dnf');
  });

  it('a daily-flow metric scores null on a DNF (no day closed)', () => {
    const events = new EventBus();
    const c = new ChallengeController(fakeWorld(0, 0), events, urlSpec(3, 'dayNet'));
    expect(c.onGameOver(GAME_OVER)?.score).toBeNull();
  });
});

// --------------------------------------------------- coordinator (fakes)

class FakeDaily {
  opened: DayReport[] = [];
  open(report: DayReport): void {
    this.opened.push(report);
  }
}
class FakeCard {
  opened: Array<{ result: ChallengeResult; report: DayReport }> = [];
  open(result: ChallengeResult, report: DayReport): void {
    this.opened.push({ result, report });
  }
}

describe('MidnightModalCoordinator — exactly one overlay per midnight (plan §6)', () => {
  it('with no challenge, every midnight opens the daily report', () => {
    const events = new EventBus();
    const coordinator = new MidnightModalCoordinator(events);
    const daily = new FakeDaily();
    coordinator.setDailyReport(daily as unknown as DailyReportModal);
    events.emit('dayEnded', makeReport(1));
    events.emit('dayEnded', makeReport(2));
    expect(daily.opened.map((r) => r.day)).toEqual([1, 2]);
  });

  it('at goal.day the result card opens and the daily report YIELDS', () => {
    const events = new EventBus();
    const coordinator = new MidnightModalCoordinator(events);
    const daily = new FakeDaily();
    const card = new FakeCard();
    const controller = new ChallengeController(fakeWorld(0, 0), events, urlSpec(3));
    coordinator.setDailyReport(daily as unknown as DailyReportModal);
    coordinator.setChallenge(controller, card as unknown as ChallengeResultCard);

    events.emit('dayEnded', makeReport(2)); // ordinary midnight → daily
    events.emit('dayEnded', makeReport(3, { reputation: 640 })); // goal day → card
    events.emit('dayEnded', makeReport(4)); // latched → daily again

    expect(daily.opened.map((r) => r.day)).toEqual([2, 4]);
    expect(card.opened).toHaveLength(1);
    expect(card.opened[0]!.result.outcome).toBe('reached');
    expect(card.opened[0]!.result.score).toBe(640);
  });
});

describe('End-to-end reached run drives the coordinator (real World)', () => {
  it('ticking a challenge World to goal.day close opens the card, not the daily report', () => {
    const events = new EventBus();
    const world = new World(events, 1337, true);
    setupNewGame(world);
    const controller = new ChallengeController(world, events, urlSpec(1)); // goal day 1
    const coordinator = new MidnightModalCoordinator(events);
    const daily = new FakeDaily();
    const card = new FakeCard();
    coordinator.setDailyReport(daily as unknown as DailyReportModal);
    coordinator.setChallenge(controller, card as unknown as ChallengeResultCard);

    const emitted = vi.fn();
    events.on('challengeComplete', emitted);
    for (let i = 0; i < TICKS_PER_DAY; i++) world.tick();

    expect(emitted).toHaveBeenCalledTimes(1);
    const payload = emitted.mock.calls[0]![0];
    expect(payload.outcome).toBe('reached');
    expect(typeof payload.score).toBe('number');
    // The card — not the daily report — owns the goal-day midnight.
    expect(card.opened).toHaveLength(1);
    expect(daily.opened).toHaveLength(0);
  });

  it('the reached score includes the day-close wait bonus (applied BEFORE the snapshot)', () => {
    // Non-vacuous (post-commit review: the previous score===report.reputation
    // assert was A===A by construction). Here the bonus is provably AWARDED and
    // the score must equal the PRE-close reputation plus the bonus — which
    // fails if closeDay ever snapshots before applying it.
    const events = new EventBus();
    const world = new World(events, 1337, true);
    setupNewGame(world);
    const controller = new ChallengeController(world, events, urlSpec(1));
    const coordinator = new MidnightModalCoordinator(events);
    const daily = new FakeDaily();
    const card = new FakeCard();
    coordinator.setDailyReport(daily as unknown as DailyReportModal);
    coordinator.setChallenge(controller, card as unknown as ChallengeResultCard);
    const emitted = vi.fn();
    events.on('challengeComplete', emitted);

    for (let i = 0; i < TICKS_PER_DAY - 1; i++) world.tick();
    // Fabricate a fast-care day (fixture write): one first-treatment wait well
    // under the bonus threshold, so closeDay MUST award the bonus.
    world.today.waitCount = 1;
    world.today.waitSumTicks = gameMinutesToTicks(30);
    const preClose = world.reputation;
    world.tick(); // midnight → closeDay → dayEnded → coordinator → controller

    expect(emitted).toHaveBeenCalledTimes(1);
    const payload = emitted.mock.calls[0]![0];
    expect(payload.context.report.waitBonusAwarded).toBe(true);
    // Stage-2 re-pin: closeDay now ALSO applies the cleanliness delta beside
    // the wait bonus (before the snapshot) — this untreated day accumulates
    // real vomit mess-ticks, so the exact score carries both terms. The
    // assert stays non-vacuous for its original target: snapshotting before
    // applying the bonus still fails it.
    const report = payload.context.report;
    expect(payload.score).toBe(
      preClose +
        BALANCE.reputation.dayCloseWaitBonus +
        cleanlinessRepDelta(report.messTicks, report.arrivals),
    );
  });

  it('tie-break: a bust exactly ON the goal-day midnight is a DNF (bank forecloses first)', () => {
    // Pinned ruling (CHALLENGES_PLAN §5): checkBankruptcy runs before closeDay,
    // so when grace expires exactly at goal.day's midnight tick, dayEnded never
    // fires and the outcome is dnf with the bust day === goal.day.
    const events = new EventBus();
    const world = new World(events, 1337, true);
    setupNewGame(world);
    const controller = new ChallengeController(world, events, urlSpec(2)); // goal day 2
    const coordinator = new MidnightModalCoordinator(events);
    const daily = new FakeDaily();
    const card = new FakeCard();
    coordinator.setDailyReport(daily as unknown as DailyReportModal);
    coordinator.setChallenge(controller, card as unknown as ChallengeResultCard);
    events.on('gameOver', (p) => controller.onGameOver(p)); // as GameOverScreen does
    const emitted = vi.fn();
    events.on('challengeComplete', emitted);

    for (let i = 0; i < TICKS_PER_DAY - 1; i++) world.tick();
    world.cash = -10_000_000; // fixture write: deep below the threshold
    // The next tick is day-1 midnight: bankruptSinceTick lands ON it, so grace
    // (exactly one day) expires ON the day-2 midnight — the goal-day close.
    for (let i = 0; i < TICKS_PER_DAY + 1 && !world.gameOver; i++) world.tick();

    expect(world.gameOver).toBe(true);
    expect(world.clock.tick).toBe(2 * TICKS_PER_DAY);
    expect(emitted).toHaveBeenCalledTimes(1);
    const payload = emitted.mock.calls[0]![0];
    expect(payload.outcome).toBe('dnf');
    expect(payload.context.day).toBe(2); // === goal.day (the documented tie-break)
    expect(card.opened).toHaveLength(0); // the reached card never opened
    expect(daily.opened.map((r) => r.day)).toEqual([1]); // only day 1 closed
  });
});
