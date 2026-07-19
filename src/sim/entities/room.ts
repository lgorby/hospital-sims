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
  /**
   * Use count since the last breakdown/repair (amenities Stage 3, §5.1):
   * incremented at each use completion for rooms with a failure def,
   * rolled against formulas.breakdownChance. Always 0 while broken
   * (applyRoomUse no-ops — the border pins broken ⇒ wear 0).
   */
  wear: number;
  /**
   * Tick of the current breakdown, null = in service. One field serves
   * the flag AND the instance-keyed hint `broken:<roomId>:<brokenSince>`
   * (design MINOR 8 — `hintedOnce` persists per save, so a room-keyed
   * toast would announce only the first breakdown ever). DESIGN DELTA
   * from §5.1's `broken: boolean`, recorded in the impl plan.
   */
  brokenSince: number | null;
  /**
   * ED epic Stage B1 (owner ask 2026-07-19): the player has CLOSED this room.
   * Same disable-never-harm semantics as `brokenSince` — `capacityOf` returns
   * 0, gathering reservations cancel, active treatments finish — but under
   * the player's control. It exists because a busy room can never be expanded
   * or sold: both validations reject while ANY reservation is live, so the
   * department that most needs more bays is the one you can never grow.
   * Closing lets it DRAIN, then grow.
   */
  closed: boolean;
  /**
   * Per-unit income (FINANCE_PLAN §4.1, the RCT ride-window analog) — credited
   * at the ONE treatment billing choke point (`billFee` with a `roomId`).
   * `revenueToday` resets in `closeDay` BEFORE `dayEnded` is emitted, so the
   * autosave never persists phantom earnings (§9.5 frozen order).
   */
  revenueToday: number;
  revenueTotal: number;
  /**
   * Completed treatment STEPS in this room — NOT discharges. A 2-step patient
   * credits two rooms once each, which is why this is "Patients seen" in the
   * UI and never reuses the `treated`/`lifetimeTreated` vocabulary.
   */
  visitsTotal: number;
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
