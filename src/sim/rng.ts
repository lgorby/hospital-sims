/**
 * Deterministic seeded RNG (mulberry32). The sim never uses Math.random —
 * determinism is what makes replays and the headless balance harness possible.
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, n). */
  intBelow(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Uniform integer in [min, max] inclusive. */
  intInRange(min: number, max: number): number {
    return min + this.intBelow(max - min + 1);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /**
   * Snapshot the internal state for saves (persistence plan rule 2: once
   * numbers have been drawn, the boot seed alone cannot reproduce the stream).
   */
  getState(): number {
    return this.state;
  }

  /** Restore a state captured by getState(); the next draw continues that exact stream. */
  setState(state: number): void {
    this.state = state >>> 0;
  }
}
