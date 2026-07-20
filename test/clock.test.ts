import { describe, expect, it } from 'vitest';
import {
  GameClock,
  gameMinutesToTicks,
  ticksToGameMinutes,
  TICKS_PER_DAY,
} from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';

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
  it('opens at Day 1, 06:00 (SHIFTS Stage-1 clock re-base)', () => {
    const clock = new GameClock();
    expect(clock.day).toBe(1);
    expect(clock.hourOfDay).toBe(6);
    expect(clock.minuteOfDay).toBe(BALANCE.time.dayStartMinute);
    expect(clock.display).toBe('Day 1, 06:00');
  });

  it('the clock offset equals the day-shift start (co-phase-lock, drift-pin)', () => {
    // A separate constant from shifts.day.startMinute (so the probe can sweep the
    // window without moving the clock), but they MUST hold the same value.
    expect(BALANCE.time.dayStartMinute).toBe(BALANCE.shifts.day.startMinute);
  });

  it('rolls over to Day 2 on the raw tick boundary, flagging isDayRollover once', () => {
    // The rollover is on the raw tick boundary — with the 06:00 offset it lands at
    // the day-shift open (06:00), NOT wall-clock midnight, so the daily report +
    // autosave fire then (owner-decided).
    const clock = new GameClock();
    let rollovers = 0;
    for (let i = 0; i < TICKS_PER_DAY + 10; i++) {
      clock.advance();
      if (clock.isDayRollover) rollovers++;
    }
    expect(rollovers).toBe(1);
    expect(clock.day).toBe(2);
  });

  it('the day rollover displays 06:00 (not midnight)', () => {
    const clock = new GameClock();
    for (let i = 0; i < TICKS_PER_DAY; i++) clock.advance();
    expect(clock.isDayRollover).toBe(true);
    expect(clock.display).toBe('Day 2, 06:00');
  });

  it('reports hour of day correctly mid-day (phase-shifted by the 06:00 offset)', () => {
    // 8 game-hours after the 06:00 open = 14:00. Tick math is measured from the
    // raw day start, so 8h of ticks lands the display at 14:05.
    const clock = new GameClock();
    const ticksTo8hIn = gameMinutesToTicks(8 * 60 + 5);
    for (let i = 0; i < ticksTo8hIn; i++) clock.advance();
    expect(clock.hourOfDay).toBe(14);
    expect(clock.display).toBe('Day 1, 14:05');
  });
});
