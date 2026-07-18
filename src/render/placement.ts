import { ROOM_DEFS, type RoomType } from '../sim/data/rooms';
import type { GridPoint, Rect } from '../sim/types';

/**
 * Hybrid-placement rect math (owner ruling 2026-07-18) — pure and Pixi-free so
 * the grow/clamp behavior is unit-testable (`test/placement.test.ts`), unlike
 * the rest of the renderer. The renderer calls these; it never re-derives.
 */

/** The room's default (minimum) footprint with `tile` as its NW corner —
 *  the hover-preview AND the click-stamp shape. Canonical orientation. */
export function minRectAt(type: RoomType, tile: GridPoint): Rect {
  const def = ROOM_DEFS[type];
  return { col: tile.col, row: tile.row, cols: def.minCols, rows: def.minRows };
}

/**
 * The drag rect: spans from the anchor toward the cursor, clamped so it never
 * shrinks below a VALID minimum footprint — in EITHER orientation. The sim's
 * `fitsMinimum` accepts the swapped footprint (a 2×3 Reception may be built
 * 3×2), so the clamp offers both and picks whichever needs the least growth
 * for the current drag (ties → canonical). A horizontal drag of a Reception
 * therefore yields 3×2, a vertical drag 2×3 — orientation follows the hand
 * (build-UX review MAJOR: a canonical-only clamp made rotated layouts
 * unreachable from the UI while the sim still accepted them).
 *
 * The anchor-side corner stays fixed; the rect always contains the cursor.
 */
export function growRect(type: RoomType, anchor: GridPoint, cursor: GridPoint): Rect {
  const def = ROOM_DEFS[type];
  const spanCols = Math.abs(cursor.col - anchor.col) + 1;
  const spanRows = Math.abs(cursor.row - anchor.row) + 1;
  const canonical = {
    cols: Math.max(spanCols, def.minCols),
    rows: Math.max(spanRows, def.minRows),
  };
  const swapped = {
    cols: Math.max(spanCols, def.minRows),
    rows: Math.max(spanRows, def.minCols),
  };
  const pick =
    swapped.cols * swapped.rows < canonical.cols * canonical.rows ? swapped : canonical;
  return {
    col: cursor.col >= anchor.col ? anchor.col : anchor.col - pick.cols + 1,
    row: cursor.row >= anchor.row ? anchor.row : anchor.row - pick.rows + 1,
    cols: pick.cols,
    rows: pick.rows,
  };
}
