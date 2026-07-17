import { describe, expect, it } from 'vitest';
import { findPath, type PathGrid } from '../src/sim/path/astar';
import type { GridPoint } from '../src/sim/types';

/** Simple grid fake: blocked tiles + optional forbidden edges. */
function makeGrid(cols: number, rows: number, blocked: GridPoint[] = []): PathGrid {
  const blockedKeys = new Set(blocked.map((p) => `${p.col},${p.row}`));
  return {
    cols,
    rows,
    isWalkable: (p) => !blockedKeys.has(`${p.col},${p.row}`),
    canStep: (_from, to) => !blockedKeys.has(`${to.col},${to.row}`),
  };
}

describe('findPath', () => {
  it('returns [start] when start equals goal', () => {
    const path = findPath(makeGrid(5, 5), { col: 2, row: 2 }, { col: 2, row: 2 });
    expect(path).toEqual([{ col: 2, row: 2 }]);
  });

  it('finds a shortest path on an open grid (length = manhattan + 1)', () => {
    const path = findPath(makeGrid(10, 10), { col: 1, row: 1 }, { col: 7, row: 4 });
    expect(path).not.toBeNull();
    expect(path!.length).toBe(6 + 3 + 1);
    expect(path![0]).toEqual({ col: 1, row: 1 });
    expect(path![path!.length - 1]).toEqual({ col: 7, row: 4 });
    // Every step is a single orthogonal move.
    for (let i = 1; i < path!.length; i++) {
      const dc = Math.abs(path![i]!.col - path![i - 1]!.col);
      const dr = Math.abs(path![i]!.row - path![i - 1]!.row);
      expect(dc + dr).toBe(1);
    }
  });

  it('routes around a wall through the gap', () => {
    // Vertical wall at col 5, gap at row 8.
    const blocked: GridPoint[] = [];
    for (let row = 0; row < 10; row++) if (row !== 8) blocked.push({ col: 5, row });
    const path = findPath(makeGrid(10, 10, blocked), { col: 2, row: 2 }, { col: 8, row: 2 });
    expect(path).not.toBeNull();
    expect(path!.some((p) => p.col === 5 && p.row === 8)).toBe(true);
  });

  it('returns null when no path exists', () => {
    const blocked: GridPoint[] = [];
    for (let row = 0; row < 10; row++) blocked.push({ col: 5, row });
    const path = findPath(makeGrid(10, 10, blocked), { col: 2, row: 2 }, { col: 8, row: 2 });
    expect(path).toBeNull();
  });

  it('returns null for an unwalkable goal or start', () => {
    const grid = makeGrid(10, 10, [{ col: 8, row: 8 }]);
    expect(findPath(grid, { col: 1, row: 1 }, { col: 8, row: 8 })).toBeNull();
    expect(findPath(grid, { col: 8, row: 8 }, { col: 1, row: 1 })).toBeNull();
  });

  it('respects canStep edge constraints beyond tile walkability', () => {
    // All tiles walkable, but an edge-wall forbids crossing col 4→5 except at row 0.
    const grid: PathGrid = {
      cols: 10,
      rows: 10,
      isWalkable: () => true,
      canStep: (from, to) => {
        const crossing =
          (from.col === 4 && to.col === 5) || (from.col === 5 && to.col === 4);
        return !crossing || (from.row === 0 && to.row === 0);
      },
    };
    const path = findPath(grid, { col: 2, row: 5 }, { col: 8, row: 5 });
    expect(path).not.toBeNull();
    expect(path!.some((p) => p.row === 0)).toBe(true);
  });
});
