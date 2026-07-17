import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { TICKS_PER_DAY } from '../src/sim/clock';
import { World } from '../src/sim/world';

describe('World commands', () => {
  it('applies commands without ticking — the "build while paused" guarantee', () => {
    const events = new EventBus();
    const world = new World(events, 1);
    const queue = new CommandQueue();

    let eventFired = false;
    events.on('debugMarkerToggled', ({ col, row, present }) => {
      eventFired = true;
      expect(col).toBe(5);
      expect(row).toBe(7);
      expect(present).toBe(true);
    });

    queue.push({ type: 'debugToggleMarker', col: 5, row: 7 });
    world.applyCommands(queue);

    // The world mutated and the event fired, yet no time passed.
    expect(world.tileAt(5, 7)!.marker).toBe(true);
    expect(eventFired).toBe(true);
    expect(world.clock.tick).toBe(0);
  });

  it('toggling twice removes the marker', () => {
    const world = new World(new EventBus(), 1);
    const queue = new CommandQueue();
    queue.push({ type: 'debugToggleMarker', col: 3, row: 3 });
    queue.push({ type: 'debugToggleMarker', col: 3, row: 3 });
    world.applyCommands(queue);
    expect(world.tileAt(3, 3)!.marker).toBe(false);
  });

  it('ignores out-of-bounds commands', () => {
    const world = new World(new EventBus(), 1);
    const queue = new CommandQueue();
    queue.push({ type: 'debugToggleMarker', col: 999, row: -1 });
    expect(() => world.applyCommands(queue)).not.toThrow();
  });

  it('emits dayEnded exactly at midnight', () => {
    const events = new EventBus();
    const world = new World(events, 1);
    const endedDays: number[] = [];
    events.on('dayEnded', ({ day }) => endedDays.push(day));
    for (let i = 0; i < TICKS_PER_DAY * 2; i++) world.tick();
    expect(endedDays).toEqual([1, 2]);
  });
});
