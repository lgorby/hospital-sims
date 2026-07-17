/**
 * The one place isometric projection math lives (tech plan §3.1 rule 5).
 * Standard 2:1 diamond projection; picking is the exact inverse of placement.
 */
export const TILE_W = 64;
export const TILE_H = 32;

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface TilePoint {
  col: number;
  row: number;
}

/** Grid → screen. Returns the center-top of the tile diamond. */
export function toScreen(col: number, row: number): ScreenPoint {
  return {
    x: ((col - row) * TILE_W) / 2,
    y: ((col + row) * TILE_H) / 2,
  };
}

/** Screen → grid (fractional). Exact inverse of toScreen. */
export function toTileFractional(x: number, y: number): { col: number; row: number } {
  return {
    col: x / TILE_W + y / TILE_H,
    row: y / TILE_H - x / TILE_W,
  };
}

/** Screen → nearest whole tile (may be out of bounds — caller validates). */
export function toTile(x: number, y: number): TilePoint {
  const f = toTileFractional(x, y);
  return { col: Math.floor(f.col), row: Math.floor(f.row) };
}

/** Depth-sort key for the shared sorted layer (tech plan §2.5). */
export function depthKey(col: number, row: number): number {
  return col + row;
}
