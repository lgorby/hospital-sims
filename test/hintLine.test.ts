import { describe, expect, it } from 'vitest';
import { HintLine } from '../src/render/hintLine';

/**
 * Stage 0 review MAJOR: three writers share the build-hint line, and the live
 * price readout must not clobber a rejection reason within one frame (the
 * ghost re-seeds + re-prices immediately after a failed drag release). Prices
 * dedupe on a GEOMETRY key, not display text — the same-size ghost shows an
 * identical string on every tile, which would otherwise pin an error forever
 * (caught by the live drive, not the first unit-test round — model it here).
 */

function setup() {
  const shown: string[] = [];
  const line = new HintLine((text) => shown.push(text));
  return { shown, line, last: () => shown[shown.length - 1] };
}

const OR_PRICE = 'Operating Room 4×4 — $20,000 · click to place, drag to grow';

describe('HintLine', () => {
  it('emits a price only when the geometry key changes (no per-frame spam)', () => {
    const { shown, line } = setup();
    line.price(OR_PRICE, '10,10,4,4');
    line.price(OR_PRICE, '10,10,4,4');
    line.price(OR_PRICE, '10,10,4,4');
    expect(shown).toEqual([OR_PRICE]);
    line.price('Operating Room 5×4 — $26,680 · …', '10,10,5,4');
    expect(shown).toHaveLength(2);
  });

  it('REGRESSION (review MAJOR): an error survives the immediate re-seed/re-price', () => {
    const { line, last } = setup();
    line.instruction('Click to place the Operating Room — hold and drag to grow it');
    line.price('Operating Room 5×5 — $32,525 · …', '10,10,5,5'); // failed grown drag
    line.error('Not enough cash'); // finishDrag rejection
    // Next frame: the ghost re-seeds at min size on the same tile — the error
    // must stay on screen.
    line.price(OR_PRICE, '10,10,4,4');
    expect(last()).toBe('Not enough cash');
    // Micro-movement within the tile: same geometry, error still holds.
    line.price(OR_PRICE, '10,10,4,4');
    expect(last()).toBe('Not enough cash');
  });

  it('REGRESSION (caught live): moving to ANOTHER TILE at the same size resumes pricing', () => {
    const { line, last } = setup();
    line.price(OR_PRICE, '10,10,4,4');
    line.error('Not enough cash');
    line.price(OR_PRICE, '10,10,4,4'); // re-seed, same tile — held
    expect(last()).toBe('Not enough cash');
    // SAME display text, different tile — the text-keyed version pinned the
    // error forever here; the geometry key must release it.
    line.price(OR_PRICE, '14,12,4,4');
    expect(last()).toBe(OR_PRICE);
  });

  it('a min-size click rejection survives its identical re-price on the same tile', () => {
    const { line, last } = setup();
    line.price('Triage Bay 2×2 — $1,500 · …', '10,10,2,2');
    line.error('Someone is standing there');
    line.price('Triage Bay 2×2 — $1,500 · …', '10,10,2,2');
    expect(last()).toBe('Someone is standing there');
  });

  it('instructions always display and release an error hold', () => {
    const { line, last } = setup();
    line.error('Out of bounds');
    line.instruction('Click a corridor tile beside the room to place the door');
    expect(last()).toBe('Click a corridor tile beside the room to place the door');
    line.price('X — $1', '0,0,1,1');
    expect(last()).toBe('X — $1'); // no lingering hold after an instruction
  });

  it('back-to-back errors each display', () => {
    const { shown, line } = setup();
    line.error('Out of bounds');
    line.error('Overlaps another room');
    expect(shown).toEqual(['Out of bounds', 'Overlaps another room']);
  });
});
