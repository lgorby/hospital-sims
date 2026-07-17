import { ORTHOGONAL_STEPS, samePoint, type GridPoint } from '../types';

/** The walkability contract A* needs — World implements it; tests can fake it. */
export interface PathGrid {
  cols: number;
  rows: number;
  isWalkable(p: GridPoint): boolean;
  /** May a single orthogonal step be taken? (Edge walls live here.) */
  canStep(from: GridPoint, to: GridPoint): boolean;
}

interface Node {
  point: GridPoint;
  g: number;
  f: number;
  parent: Node | null;
}

function heuristic(a: GridPoint, b: GridPoint): number {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

/**
 * A* over the tile grid, 4-directional (tech plan §2.4). Returns the full
 * path INCLUDING the start tile, or null when no path exists — callers must
 * treat null as a first-class outcome (Flow rule 8).
 */
export function findPath(grid: PathGrid, start: GridPoint, goal: GridPoint): GridPoint[] | null {
  if (!grid.isWalkable(goal) || !grid.isWalkable(start)) return null;
  if (samePoint(start, goal)) return [start];

  const key = (p: GridPoint): number => p.col * grid.rows + p.row;
  const open: Node[] = [{ point: start, g: 0, f: heuristic(start, goal), parent: null }];
  const bestG = new Map<number, number>();
  bestG.set(key(start), 0);

  while (open.length > 0) {
    // Linear min-extract — fine at 40×40; swap for a heap if maps grow.
    let bestIndex = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i]!.f < open[bestIndex]!.f) bestIndex = i;
    }
    const current = open.splice(bestIndex, 1)[0]!;

    if (samePoint(current.point, goal)) {
      const path: GridPoint[] = [];
      for (let n: Node | null = current; n; n = n.parent) path.push(n.point);
      return path.reverse();
    }

    for (const step of ORTHOGONAL_STEPS) {
      const next = { col: current.point.col + step.col, row: current.point.row + step.row };
      if (next.col < 0 || next.row < 0 || next.col >= grid.cols || next.row >= grid.rows) continue;
      if (!grid.isWalkable(next) || !grid.canStep(current.point, next)) continue;
      const g = current.g + 1;
      const k = key(next);
      const known = bestG.get(k);
      if (known !== undefined && known <= g) continue;
      bestG.set(k, g);
      open.push({ point: next, g, f: g + heuristic(next, goal), parent: current });
    }
  }
  return null;
}
