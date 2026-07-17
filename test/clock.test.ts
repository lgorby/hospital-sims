import { describe, expect, it } from 'vitest';
import {
  GameClock,
  gameMinutesToTicks,
  ticksToGameMinutes,
  TICKS_PER_DAY,
} from '../src/sim/clock';

describe('clock conversions', () => {
  it('one game day is the expected tick count (8 real min × 10 tps = 4800)', () => {
    expect(gameMinutesToTicks(24 * 60)).toBe(TICKS_PER_DAY);
    expect(TICKS_PER_DAY).toBe(4800);
  });

  it('round-trips minutes ↔ ticks', () => {
    expect(ticksToGameMinutes(gameMinutesToTicks(90))).toBeCloseTo(90);
  });
});

describe('GameClock', () => {
  it('starts at Day 1, 00:00', () => {
    const clock = new GameClock();
    expect(clock.day).toBe(1);
    expect(clock.hourOfDay).toBe(0);
    expect(clock.display).toBe('Day 1, 00:00');
  });

  it('rolls over to Day 2 at midnight, flagging isMidnight exactly once', () => {
    const clock = new GameClock();
    let midnights = 0;
    for (let i = 0; i < TICKS_PER_DAY + 10; i++) {
      clock.advance();
      if (clock.isMidnight) midnights++;
    }
    expect(midnights).toBe(1);
    expect(clock.day).toBe(2);
  });

  it('reports hour of day correctly mid-day', () => {
    const clock = new GameClock();
    const ticksTo14h = gameMinutesToTicks(14 * 60 + 5);
    for (let i = 0; i < ticksTo14h; i++) clock.advance();
    expect(clock.hourOfDay).toBe(14);
    expect(clock.display).toBe('Day 1, 14:05');
  });
});
