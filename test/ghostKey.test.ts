import { describe, expect, it } from 'vitest';
import { ghostValidityKey, type GhostKeyInput } from '../src/render/ghostKey';

/**
 * The build/expand/amenity ghost re-validates (which reads live cash) only when
 * this key changes. The bug this guards: the key used the sim tick as its
 * freshness signal, but build/sell/place commands spend cash WHILE PAUSED with
 * the tick frozen — so a paused spend left a stale-green ghost. The fix folds
 * `cash` into the key; these tests pin that cash is a real, independent input.
 */
describe('ghostValidityKey', () => {
  const base: GhostKeyInput = {
    tick: 100,
    cash: 50_000,
    amenity: null,
    buildType: 'exam',
    buildPhase: 'drag',
    expandRoomId: null,
    rect: { col: 5, row: 6, cols: 3, rows: 3 },
    hoveredTile: { col: 5, row: 9 },
  };

  it('is stable for identical inputs', () => {
    expect(ghostValidityKey(base)).toBe(ghostValidityKey({ ...base }));
  });

  it('emits the exact key format (locks segment order against extraction drift)', () => {
    // build/drag: mode:tick:cash:rect:door — door is '-' outside the door phase.
    expect(ghostValidityKey(base)).toBe('exam:drag:100:50000:5,6,3,3:-');
    expect(ghostValidityKey({ ...base, amenity: 'plant', buildType: null })).toBe(
      'amenity:plant:100:50000:5,9',
    );
    expect(
      ghostValidityKey({ ...base, buildType: null, buildPhase: null, expandRoomId: 7 }),
    ).toBe('expand:7:100:50000:5,6,3,3:-');
  });

  it('changes when ONLY cash changes at the SAME tick (the paused-spend bug)', () => {
    const spent = { ...base, cash: 1_000 };
    expect(ghostValidityKey(spent)).not.toBe(ghostValidityKey(base));
  });

  it('folds cash into the amenity branch too', () => {
    const amenity: GhostKeyInput = { ...base, amenity: 'plant', buildType: null };
    const spent = { ...amenity, cash: 1_000 };
    expect(ghostValidityKey(spent)).not.toBe(ghostValidityKey(amenity));
  });

  it('folds cash into the expand branch too', () => {
    const expand: GhostKeyInput = {
      ...base,
      buildType: null,
      buildPhase: null,
      expandRoomId: 7, // real room ids are numbers (world.takeId)
    };
    const spent = { ...expand, cash: 1_000 };
    expect(ghostValidityKey(spent)).not.toBe(ghostValidityKey(expand));
  });

  it('still changes on tick and geometry (freshness signals preserved)', () => {
    expect(ghostValidityKey({ ...base, tick: 101 })).not.toBe(ghostValidityKey(base));
    expect(ghostValidityKey({ ...base, rect: { col: 5, row: 6, cols: 4, rows: 3 } })).not.toBe(
      ghostValidityKey(base),
    );
  });

  it('is empty when no tool is armed (no ghost, no revalidation churn)', () => {
    const idle: GhostKeyInput = { ...base, buildType: null, expandRoomId: null, amenity: null };
    expect(ghostValidityKey(idle)).toBe('');
    // ...and stays empty regardless of tick/cash, so an idle screen never redraws.
    expect(ghostValidityKey({ ...idle, tick: 999, cash: 7 })).toBe('');
  });

  it('keys the door tile only in the door phase (build hover)', () => {
    const dragHover = { ...base, buildPhase: 'drag', hoveredTile: { col: 9, row: 9 } };
    const dragHover2 = { ...base, buildPhase: 'drag', hoveredTile: { col: 1, row: 1 } };
    // In drag phase the hovered tile is NOT part of the key (door segment '-').
    expect(ghostValidityKey(dragHover)).toBe(ghostValidityKey(dragHover2));
    const doorHover = { ...base, buildPhase: 'door', hoveredTile: { col: 9, row: 9 } };
    const doorHover2 = { ...base, buildPhase: 'door', hoveredTile: { col: 1, row: 1 } };
    // In door phase it IS — the door preview tracks the cursor.
    expect(ghostValidityKey(doorHover)).not.toBe(ghostValidityKey(doorHover2));
  });
});
