import { describe, expect, it } from 'vitest';
import { depthKey, TILE_H, TILE_W, toScreen, toTile, toTileFractional } from '../src/render/iso';

describe('iso projection', () => {
  it('toTileFractional is the exact inverse of toScreen', () => {
    for (let col = -3; col <= 45; col += 4) {
      for (let row = -3; row <= 45; row += 4) {
        const s = toScreen(col, row);
        const f = toTileFractional(s.x, s.y);
        expect(f.col).toBeCloseTo(col, 10);
        expect(f.row).toBeCloseTo(row, 10);
      }
    }
  });

  it('picks the tile whose diamond visually contains the point', () => {
    // toScreen returns the diamond's TOP vertex; its center is TILE_H/2 below.
    // Offsets are strictly inside the diamond: |dx|/(W/2) + |dy|/(H/2) < 1.
    const insideOffsets: [number, number][] = [
      [0, 0], // center
      [20, 0], // right quadrant
      [-20, 0], // left quadrant
      [0, 10], // bottom quadrant
      [0, -10], // top quadrant
      [15, 7],
      [-15, -7],
      [-15, 7],
      [15, -7],
    ];
    const tiles: [number, number][] = [
      [0, 0],
      [5, 7],
      [39, 39],
      [12, 3],
    ];
    for (const [col, row] of tiles) {
      const top = toScreen(col, row);
      const cx = top.x;
      const cy = top.y + TILE_H / 2;
      for (const [dx, dy] of insideOffsets) {
        // Sanity: the probe point really is inside the diamond.
        expect(Math.abs(dx) / (TILE_W / 2) + Math.abs(dy) / (TILE_H / 2)).toBeLessThan(1);
        expect(toTile(cx + dx, cy + dy), `tile (${col},${row}) offset (${dx},${dy})`).toEqual({
          col,
          row,
        });
      }
    }
  });

  it('depthKey increases toward the camera (south/east)', () => {
    expect(depthKey(5, 5)).toBeGreaterThan(depthKey(4, 5));
    expect(depthKey(5, 5)).toBeGreaterThan(depthKey(5, 4));
    expect(depthKey(3, 7)).toBe(depthKey(7, 3)); // same diagonal, same depth
  });
});
