/**
 * The build-hint line's tiny state machine (Stage 0 review MAJOR): three
 * writers share one DOM line — mode instructions, error reasons, and the live
 * price readout (re-emitted per geometry change). Without arbitration the
 * price clobbers a rejection reason within one frame (the ghost re-seeds and
 * re-prices immediately), and after a surviving error the price never
 * returns (string-equality suppression). Pure and Pixi-free → unit-tested in
 * `test/hintLine.test.ts`; the renderer owns one instance and never calls
 * `onHint` directly for these flows.
 *
 * Contract: an ERROR owns the line until the price GEOMETRY changes (the
 * player moves/resizes the ghost) — the first re-price after an error is
 * recorded as the new baseline but not emitted, so the reason stays readable;
 * the next change resumes live pricing.
 */
export class HintLine {
  private lastKey = '';
  private hold = false;

  constructor(private emit: (text: string) => void) {}

  /** Mode instructions / clears — always shown, releases any error hold. */
  instruction(text: string): void {
    this.hold = false;
    this.lastKey = '';
    this.emit(text);
  }

  /** A rejection reason — shown now, and held against the next re-price. */
  error(text: string): void {
    this.hold = true;
    this.lastKey = '';
    this.emit(text);
  }

  /**
   * The live price readout. `key` is the GEOMETRY signature (position+dims) —
   * the display text alone can't dedupe, because moving the ghost to another
   * tile at the same size keeps the identical price string, which would pin an
   * error hold forever (caught live; the display-text version passed the unit
   * tests but not the driver). Emitted only when the key changes; the first
   * change after an error records the baseline silently, the next releases.
   */
  price(text: string, key: string): void {
    if (key === this.lastKey) return;
    const suppress = this.hold && this.lastKey === '';
    this.lastKey = key;
    if (suppress) return; // the error stays readable; baseline recorded
    this.hold = false;
    this.emit(text);
  }
}
