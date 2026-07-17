import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { GameLoop, type LoopHost } from '../src/loop';
import { World } from '../src/sim/world';

/** Hand-cranked frame scheduler standing in for rAF + document visibility. */
class FakeHost implements LoopHost {
  private frameCallback: ((now: number) => void) | null = null;
  private visibilityCallback: (() => void) | null = null;
  hidden = false;

  requestFrame(callback: (now: number) => void): void {
    this.frameCallback = callback;
  }
  onVisibilityChange(callback: () => void): void {
    this.visibilityCallback = callback;
  }
  isHidden(): boolean {
    return this.hidden;
  }
  /** Fire the pending frame at the given timestamp (ms). */
  step(now: number): void {
    const cb = this.frameCallback;
    this.frameCallback = null;
    cb?.(now);
  }
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.visibilityCallback?.();
  }
}

function makeLoop() {
  const events = new EventBus();
  const world = new World(events, 1);
  const commands = new CommandQueue();
  const host = new FakeHost();
  const alphas: number[] = [];
  const loop = new GameLoop(world, commands, events, (a) => alphas.push(a), host);
  return { world, commands, host, loop, alphas };
}

describe('GameLoop', () => {
  it('runs one tick per 100ms at 1×, scaled by speed', () => {
    const { world, host, loop } = makeLoop();
    loop.start();
    host.step(0); // first frame just records lastTime
    host.step(100);
    expect(world.clock.tick).toBe(1);
    loop.setSpeed(3);
    host.step(200); // 100ms × 3 = 3 ticks
    expect(world.clock.tick).toBe(4);
  });

  it('caps catch-up at MAX_TICKS_PER_FRAME and clamps the backlog', () => {
    const { world, host, loop } = makeLoop();
    loop.start();
    host.step(0);
    host.step(10_000); // 100 ticks owed — must run only 10
    expect(world.clock.tick).toBe(10);
    host.step(10_100); // backlog was clamped to 10 ticks: 10 more, not 90
    expect(world.clock.tick).toBe(20);
  });

  it('drains commands while paused without advancing time', () => {
    const { world, commands, host, loop } = makeLoop();
    loop.start();
    loop.setSpeed(0);
    commands.push({ type: 'debugToggleMarker', col: 2, row: 2 });
    host.step(0);
    host.step(5_000);
    expect(world.tileAt(2, 2)!.marker).toBe(true);
    expect(world.clock.tick).toBe(0);
  });

  it('auto-pauses on hide and does NOT replay hidden time on restore', () => {
    const { world, host, loop } = makeLoop();
    loop.start();
    host.step(0);
    host.step(100);
    expect(world.clock.tick).toBe(1);

    host.setHidden(true);
    expect(loop.speed).toBe(0);

    host.setHidden(false); // 60s "later" — restore must not burst-tick
    expect(loop.speed).toBe(1);
    host.step(60_000);
    expect(world.clock.tick).toBe(1); // frame timer was reset: no catch-up
    host.step(60_100);
    expect(world.clock.tick).toBe(2); // normal cadence resumes
  });

  it('keeps render alpha within [0, 1] even when tick-capped', () => {
    const { host, loop, alphas } = makeLoop();
    loop.start();
    host.step(0);
    host.step(10_000);
    expect(Math.max(...alphas)).toBeLessThanOrEqual(1);
    expect(Math.min(...alphas)).toBeGreaterThanOrEqual(0);
  });
});
