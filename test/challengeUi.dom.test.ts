// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/events';
import type { GameLoop } from '../src/loop';
import { TICKS_PER_DAY } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import type { ChallengeSpec } from '../src/sim/data/challenges';
import type { DayReport } from '../src/sim/dailyStats';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';
import { ChallengeController, type ChallengeResult } from '../src/ui/challengeController';
import { appendChallengeResult, ChallengeResultCard } from '../src/ui/challengeResultCard';
import { DailyReportModal } from '../src/ui/dailyReport';
import { GameOverScreen } from '../src/ui/gameOver';
import { MidnightModalCoordinator } from '../src/ui/midnightModal';
import { installAutosave } from '../src/ui/saveLoad';
import { readSlotRaw } from '../src/ui/saveStore';

/**
 * Phase 2 — Track 2 DOM wiring (happy-dom). Covers the paths the node-only
 * suite can't: the DNF fold into the game-over screen, target pass/fail render,
 * and the DOM-level "exactly one overlay visible" guarantee at a day boundary.
 */

class FakeLoop {
  speed = 1;
  setSpeed(s: number): void {
    this.speed = s;
  }
}
const loop = (): GameLoop => new FakeLoop() as unknown as GameLoop;

function fakeWorld(): World {
  return { lifetimeTreated: 0, lifetimeDied: 0 } as unknown as World;
}

function urlSpec(day: number, metric: ChallengeSpec['goal']['metric'] = 'reputation'): ChallengeSpec {
  return { source: 'url', id: null, scenario: { kind: 'default', seed: 1 }, goal: { metric, day } };
}

function makeReport(day: number, over: Partial<DayReport> = {}): DayReport {
  return {
    day,
    arrivals: 0,
    treated: 0,
    died: 0,
    leftAma: 0,
    lostEpisodes: 0,
    revenue: 0,
    payroll: 0,
    hireFees: 0,
    construction: 0,
    sellIncome: 0,
    vendingRevenue: 0,
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

describe('DNF folds into the game-over screen (end-to-end, real World)', () => {
  it('bankruptcy before goal.day emits ONE dnf and renders the result + share line', () => {
    const events = new EventBus();
    const world = new World(events, 1337, true);
    setupNewGame(world);
    const controller = new ChallengeController(world, events, urlSpec(5));
    const completes = vi.fn();
    events.on('challengeComplete', completes);

    const root = document.createElement('div');
    new GameOverScreen(loop(), events, () => {}, controller).mount(root);

    // Deep in debt from the start — bankruptcy fires after the grace day, well
    // before goal.day 5, so the terminal is a DNF.
    world.cash = BALANCE.economy.bankruptcyThreshold - 100_000;
    for (let i = 0; i < TICKS_PER_DAY * 2 && !world.gameOver; i++) world.tick();

    expect(world.gameOver).toBe(true);
    expect(completes).toHaveBeenCalledTimes(1);
    expect(completes.mock.calls[0]![0].outcome).toBe('dnf');

    const overlay = root.querySelector('#gameover');
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toContain('DNF');
    expect(root.querySelector('.share-box')).not.toBeNull();
  });
});

describe('appendChallengeResult renders target pass/fail', () => {
  function targetResult(score: number): ChallengeResult {
    const spec: ChallengeSpec = {
      source: 'builtin',
      id: 'gold-standard',
      scenario: { kind: 'default', seed: 500 },
      goal: { metric: 'reputation', day: 4, target: 600 },
    };
    return {
      spec,
      outcome: 'reached',
      score,
      // report is not read by appendChallengeResult on the reached path.
      context: {
        outcome: 'reached',
        day: 4,
        report: null,
        terminal: { cash: 0, reputation: score, lifetimeTreated: 0, lifetimeDied: 0 },
      },
    };
  }

  it('score at/over target shows Reached ✓', () => {
    const card = document.createElement('div');
    appendChallengeResult(card, targetResult(640));
    expect(card.textContent).toContain('Reached ✓');
  });

  it('score under target shows Missed ✗', () => {
    const card = document.createElement('div');
    appendChallengeResult(card, targetResult(500));
    expect(card.textContent).toContain('Missed ✗');
  });
});

describe('autosave is disabled in challenge mode (post-commit review)', () => {
  it('a challenge midnight never writes the auto slot; a sandbox midnight does', () => {
    localStorage.clear();
    // Challenge run: installAutosave must be inert (it would clobber the
    // player's sandbox autosave with a world that reloads spec-less).
    const challengeEvents = new EventBus();
    const challengeWorld = new World(challengeEvents, 1337, true);
    setupNewGame(challengeWorld);
    installAutosave(challengeEvents, challengeWorld);
    challengeEvents.emit('dayEnded', makeReport(1));
    expect(readSlotRaw('auto')).toBeNull();

    // Sanity (guard is load-bearing, not vacuous): a normal run DOES autosave.
    const events = new EventBus();
    const world = new World(events, 1337);
    setupNewGame(world);
    installAutosave(events, world);
    events.emit('dayEnded', makeReport(1));
    expect(readSlotRaw('auto')).not.toBeNull();
    localStorage.clear();
  });
});

describe('exactly one overlay is visible at a day boundary (no overlap)', () => {
  function wire() {
    const events = new EventBus();
    const root = document.createElement('div');
    const coordinator = new MidnightModalCoordinator(events);
    const daily = new DailyReportModal(loop(), events);
    daily.mount(root);
    coordinator.setDailyReport(daily);
    const controller = new ChallengeController(fakeWorld(), events, urlSpec(2));
    const card = new ChallengeResultCard(loop(), events);
    card.mount(root);
    coordinator.setChallenge(controller, card);
    return { events, root };
  }

  function visibleOverlays(root: HTMLElement): Element[] {
    return [...root.querySelectorAll('.modal-overlay')].filter(
      (el) => !el.classList.contains('hidden'),
    );
  }

  it('ordinary midnight shows only the daily report', () => {
    const { events, root } = wire();
    events.emit('dayEnded', makeReport(1));
    expect(visibleOverlays(root)).toHaveLength(1);
    expect(root.querySelector('#dailyreport')!.classList.contains('hidden')).toBe(false);
    expect(root.querySelector('#challengeresult')!.classList.contains('hidden')).toBe(true);
  });

  it('goal-day midnight shows only the result card', () => {
    const { events, root } = wire();
    events.emit('dayEnded', makeReport(2, { reputation: 700 }));
    expect(visibleOverlays(root)).toHaveLength(1);
    expect(root.querySelector('#challengeresult')!.classList.contains('hidden')).toBe(false);
    expect(root.querySelector('#dailyreport')!.classList.contains('hidden')).toBe(true);
  });
});
