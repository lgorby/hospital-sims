import { describe, expect, it } from 'vitest';
import { growRect, minRectAt } from '../src/render/placement';
import { validateRoomRect } from '../src/sim/build';
import { EventBus } from '../src/events';
import { ROOM_DEFS } from '../src/sim/data/rooms';
import { World } from '../src/sim/world';

/**
 * Hybrid placement rect math (owner ruling 2026-07-18; build-UX review). The
 * MAJOR of record: a canonical-only min clamp made ROTATED footprints (which
 * the sim's `fitsMinimum` accepts) unreachable from the UI — growRect must
 * offer both orientations and follow the drag.
 */

describe('minRectAt', () => {
  it('is the default footprint with the tile as NW corner, canonical orientation', () => {
    expect(minRectAt('triage', { col: 7, row: 9 })).toEqual({ col: 7, row: 9, cols: 2, rows: 2 });
    expect(minRectAt('reception', { col: 3, row: 4 })).toEqual({ col: 3, row: 4, cols: 2, rows: 3 });
  });
});

describe('growRect — clamp, containment, orientation', () => {
  const a = { col: 10, row: 10 };

  it('a click (cursor on the anchor) yields the default size at the anchor', () => {
    expect(growRect('surgery', a, a)).toEqual({ col: 10, row: 10, cols: 4, rows: 4 });
  });

  it('never shrinks below a valid minimum while dragging inside it', () => {
    const rect = growRect('surgery', a, { col: 11, row: 11 }); // span 2×2 < min 4×4
    expect(rect).toEqual({ col: 10, row: 10, cols: 4, rows: 4 });
  });

  it('grows past the minimum toward the cursor', () => {
    expect(growRect('triage', a, { col: 14, row: 12 })).toEqual({
      col: 10,
      row: 10,
      cols: 5,
      rows: 3,
    });
  });

  it('REGRESSION OF RECORD: a horizontal drag rotates a non-square room (3×2 Reception)', () => {
    // Reception min 2×3. Dragging 3 wide × 1 tall: canonical clamp = 3×3 (9),
    // swapped = 3×2 (6) — the swapped orientation needs less growth and wins.
    const rect = growRect('reception', a, { col: 12, row: 10 });
    expect(rect).toEqual({ col: 10, row: 10, cols: 3, rows: 2 });
    // And the sim accepts it (fitsMinimum's swap clause — one contract).
    const world = new World(new EventBus(), 1);
    expect(validateRoomRect(world, 'reception', rect, true).ok).toBe(true);
  });

  it('a vertical drag keeps the canonical orientation (2×3 Reception)', () => {
    expect(growRect('reception', a, { col: 10, row: 12 })).toEqual({
      col: 10,
      row: 10,
      cols: 2,
      rows: 3,
    });
  });

  it('dragging up-left keeps the anchor corner fixed and still contains the cursor', () => {
    const cursor = { col: 8, row: 7 };
    const rect = growRect('surgery', a, cursor); // span 3×4, min 4×4 → 4×4
    expect(rect).toEqual({ col: 7, row: 7, cols: 4, rows: 4 });
    // Containment on both axes (the corner-flip must never detach the rect).
    expect(cursor.col).toBeGreaterThanOrEqual(rect.col);
    expect(cursor.col).toBeLessThan(rect.col + rect.cols);
    expect(cursor.row).toBeGreaterThanOrEqual(rect.row);
    expect(cursor.row).toBeLessThan(rect.row + rect.rows);
    // The anchor stays inside too.
    expect(a.col).toBeLessThan(rect.col + rect.cols);
    expect(a.row).toBeLessThan(rect.row + rect.rows);
  });

  it('every room type: a bare click always yields a sim-valid minimum footprint', () => {
    const world = new World(new EventBus(), 1);
    for (const type of Object.keys(ROOM_DEFS) as Array<keyof typeof ROOM_DEFS>) {
      const rect = growRect(type, a, a);
      expect(validateRoomRect(world, type, rect, true).ok).toBe(true);
    }
  });

  it('every room type + drag direction: the result always satisfies the sim minimum', () => {
    const world = new World(new EventBus(), 1);
    const cursors = [
      { col: 12, row: 10 }, // E
      { col: 10, row: 12 }, // S
      { col: 8, row: 10 }, // W
      { col: 10, row: 8 }, // N
      { col: 13, row: 6 }, // NE far
    ];
    for (const type of Object.keys(ROOM_DEFS) as Array<keyof typeof ROOM_DEFS>) {
      for (const cursor of cursors) {
        const rect = growRect(type, a, cursor);
        const check = validateRoomRect(world, type, rect, true);
        expect(check.ok, `${type} → ${JSON.stringify(cursor)}: ${JSON.stringify(rect)}`).toBe(true);
      }
    }
  });
});
