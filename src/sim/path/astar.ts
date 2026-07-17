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

/** Deterministic mix of (seed, tile) → a rotation of the 4 neighbor steps. */
function neighborRotation(seed: number, p: GridPoint): number {
  let h = (seed ^ Math.imul(p.col + 1, 0x9e3779b1) ^ Math.imul(p.row + 1, 0x85ebca6b)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0; // keep unsigned — ^ yields a SIGNED 32-bit int
  return h % ORTHOGONAL_STEPS.length;
}

/**
 * A* over the tile grid, 4-directional (tech plan §2.4). Returns the full
 * path INCLUDING the start tile, or null when no path exists — callers must
 * treat null as a first-class outcome (Flow rule 8).
 *
 * `varietySeed` (the walker's entity id, per the hash-the-id convention for
 * render variety) deterministically permutes neighbor expansion order per
 * tile, so walkers sharing a start/goal spread across different equally-short
 * paths instead of marching single-file. Never affects path LENGTH, only
 * which optimal path is chosen; 0 = legacy fixed order.
 */
export function findPath(
  grid: PathGrid,
  start: GridPoint,
  goal: GridPoint,
  varietySeed = 0,
): GridPoint[] | null {
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

    const rotation = varietySeed === 0 ? 0 : neighborRotation(varietySeed, current.point);
    for (let s = 0; s < ORTHOGONAL_STEPS.length; s++) {
      const step = ORTHOGONAL_STEPS[(s + rotation) % ORTHOGONAL_STEPS.length]!;
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
