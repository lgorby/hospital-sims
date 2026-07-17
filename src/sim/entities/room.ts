import type { RoomType } from '../data/rooms';
import type { GridPoint, Rect } from '../types';

/**
 * Walls are EDGE-based, not tile-based: a room's footprint tiles are all
 * interior/walkable, and walls live on the boundary edges of the rect. This
 * keeps the GDD's 2×2 triage bay possible (a tile-thick wall would leave it
 * no interior at all). Crossing a boundary edge is only legal at the door.
 */
export interface Door {
  inside: GridPoint;
  outside: GridPoint;
}

export interface Room {
  id: number;
  type: RoomType;
  rect: Rect;
  /** null for open-plan rooms (atrium) — no walls, no door. */
  door: Door | null;
  /** Extra tiles above the minimum footprint (GDD §5 room quality). */
  quality: number;
}

export interface WallEdge {
  inside: GridPoint;
  outside: GridPoint;
}

/** Every boundary edge of the rect (inside tile + the outside neighbor it faces). */
export function boundaryEdges(rect: Rect): WallEdge[] {
  const edges: WallEdge[] = [];
  for (let col = rect.col; col < rect.col + rect.cols; col++) {
    edges.push({ inside: { col, row: rect.row }, outside: { col, row: rect.row - 1 } });
    edges.push({
      inside: { col, row: rect.row + rect.rows - 1 },
      outside: { col, row: rect.row + rect.rows },
    });
  }
  for (let row = rect.row; row < rect.row + rect.rows; row++) {
    edges.push({ inside: { col: rect.col, row }, outside: { col: rect.col - 1, row } });
    edges.push({
      inside: { col: rect.col + rect.cols - 1, row },
      outside: { col: rect.col + rect.cols, row },
    });
  }
  return edges;
}
