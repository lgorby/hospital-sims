/** Grid coordinate types owned by the sim — render/iso has its own structural twin. */
export interface GridPoint {
  col: number;
  row: number;
}

export interface Rect {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

export function samePoint(a: GridPoint, b: GridPoint): boolean {
  return a.col === b.col && a.row === b.row;
}

export function rectContains(rect: Rect, p: GridPoint): boolean {
  return (
    p.col >= rect.col &&
    p.col < rect.col + rect.cols &&
    p.row >= rect.row &&
    p.row < rect.row + rect.rows
  );
}

export function rectTiles(rect: Rect): GridPoint[] {
  const tiles: GridPoint[] = [];
  for (let col = rect.col; col < rect.col + rect.cols; col++) {
    for (let row = rect.row; row < rect.row + rect.rows; row++) {
      tiles.push({ col, row });
    }
  }
  return tiles;
}

export const ORTHOGONAL_STEPS: readonly GridPoint[] = [
  { col: 1, row: 0 },
  { col: -1, row: 0 },
  { col: 0, row: 1 },
  { col: 0, row: -1 },
];
