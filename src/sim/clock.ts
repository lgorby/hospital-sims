import { BALANCE } from './data/balance';

const GAME_MINUTES_PER_DAY = 24 * 60;
const REAL_SECONDS_PER_DAY = BALANCE.time.gameDayRealMinutes * 60;
/** Exported for tests and systems — never re-derive or hardcode this. */
export const TICKS_PER_DAY = REAL_SECONDS_PER_DAY * BALANCE.time.ticksPerSecond;

/** The one place time conversions live (tech plan §3.1 rule 5). */
export const GAME_MINUTES_PER_TICK = GAME_MINUTES_PER_DAY / TICKS_PER_DAY;

export function gameMinutesToTicks(gameMinutes: number): number {
  return Math.round(gameMinutes / GAME_MINUTES_PER_TICK);
}

export function ticksToGameMinutes(ticks: number): number {
  return ticks * GAME_MINUTES_PER_TICK;
}

export class GameClock {
  /** Total sim ticks since new game. The sim's canonical time unit. */
  tick = 0;

  advance(): void {
    this.tick += 1;
  }

  /** 1-based day number. */
  get day(): number {
    return Math.floor(this.tick / TICKS_PER_DAY) + 1;
  }

  /** Game-minutes elapsed within the current day [0, 1440). */
  get minuteOfDay(): number {
    return ticksToGameMinutes(this.tick % TICKS_PER_DAY);
  }

  get hourOfDay(): number {
    return Math.floor(this.minuteOfDay / 60);
  }

  /** "Day 3, 14:05" */
  get display(): string {
    const h = this.hourOfDay;
    const m = Math.floor(this.minuteOfDay % 60);
    const hh = String(h).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    return `Day ${this.day}, ${hh}:${mm}`;
  }

  /** True exactly once per day rollover (checked after advance()). */
  get isMidnight(): boolean {
    return this.tick % TICKS_PER_DAY === 0;
  }
}
