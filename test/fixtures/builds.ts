import type { RoomType } from '../../src/sim/data/rooms';
import type { RoleId } from '../../src/sim/data/roles';
import type { GridPoint, Rect } from '../../src/sim/types';

/** A room to hand to `world.buildRoom(type, rect, door)`. */
export interface RoomSpec {
  type: RoomType;
  rect: Rect;
  door: GridPoint | null;
}

/**
 * THE REFERENCE BUILD — the fixture behind every balance number this project
 * has recorded (mirrors `test/harness.test.ts` STANDARD_ROOMS). Extracted here
 * so the ED probe and the economy probe measure the SAME hospital (SSOT/DRY):
 * a balance number is only comparable across probes if the build is identical.
 *
 * The last `exam` slot is the third exam room that replaced the retired `resp`
 * room (DEPARTMENTS_PLAN §3.2) — capacity-neutral, so dropping it measures the
 * "player never rebuilt" arm without confounding a routing change.
 */
export const REFERENCE_BUILD: RoomSpec[] = [
  { type: 'restroom', rect: { col: 5, row: 27, cols: 2, rows: 3 }, door: { col: 7, row: 28 } },
  { type: 'triage', rect: { col: 10, row: 28, cols: 2, rows: 2 }, door: { col: 12, row: 29 } },
  { type: 'exam', rect: { col: 14, row: 27, cols: 3, rows: 3 }, door: { col: 17, row: 28 } },
  { type: 'exam', rect: { col: 18, row: 27, cols: 3, rows: 3 }, door: { col: 21, row: 28 } },
  { type: 'xray', rect: { col: 24, row: 26, cols: 3, rows: 4 }, door: { col: 27, row: 27 } },
  { type: 'exam', rect: { col: 28, row: 27, cols: 3, rows: 3 }, door: { col: 31, row: 28 } },
  { type: 'er', rect: { col: 32, row: 26, cols: 3, rows: 4 }, door: { col: 35, row: 27 } },
  { type: 'ultrasound', rect: { col: 8, row: 21, cols: 2, rows: 3 }, door: { col: 10, row: 22 } },
  { type: 'ct', rect: { col: 12, row: 20, cols: 4, rows: 4 }, door: { col: 14, row: 24 } },
  { type: 'mri', rect: { col: 17, row: 20, cols: 4, rows: 4 }, door: { col: 19, row: 24 } },
  { type: 'nucMed', rect: { col: 22, row: 20, cols: 3, rows: 4 }, door: { col: 23, row: 24 } },
  { type: 'dialysis', rect: { col: 26, row: 20, cols: 3, rows: 4 }, door: { col: 27, row: 24 } },
  { type: 'surgery', rect: { col: 30, row: 20, cols: 4, rows: 4 }, door: { col: 32, row: 24 } },
];

/**
 * THE MEASUREMENT-VALIDITY ARM (`LAYOUT_PLAN` §3): the same 13 rooms, sizes,
 * staffing and cash as REFERENCE — only the placement differs, packed close to
 * the entrance so triage sits 7 tiles out instead of 18. A plausible player
 * layout, not a best case. Extracted alongside REFERENCE for the same reason.
 */
export const COMPACT_BUILD: RoomSpec[] = [
  // Band A — rows 34-37, doors onto the row-38 corridor.
  { type: 'restroom', rect: { col: 5, row: 35, cols: 2, rows: 3 }, door: { col: 5, row: 38 } },
  { type: 'exam', rect: { col: 8, row: 35, cols: 3, rows: 3 }, door: { col: 9, row: 38 } },
  { type: 'er', rect: { col: 12, row: 34, cols: 3, rows: 4 }, door: { col: 13, row: 38 } },
  { type: 'triage', rect: { col: 26, row: 36, cols: 2, rows: 2 }, door: { col: 26, row: 38 } },
  { type: 'exam', rect: { col: 28, row: 35, cols: 3, rows: 3 }, door: { col: 29, row: 38 } },
  { type: 'exam', rect: { col: 32, row: 35, cols: 3, rows: 3 }, door: { col: 33, row: 38 } },
  // Band B — rows 27-30, doors onto the row-31 corridor.
  { type: 'xray', rect: { col: 5, row: 27, cols: 3, rows: 4 }, door: { col: 6, row: 31 } },
  { type: 'ultrasound', rect: { col: 9, row: 28, cols: 2, rows: 3 }, door: { col: 9, row: 31 } },
  { type: 'ct', rect: { col: 12, row: 27, cols: 4, rows: 4 }, door: { col: 13, row: 31 } },
  { type: 'mri', rect: { col: 17, row: 27, cols: 4, rows: 4 }, door: { col: 18, row: 31 } },
  { type: 'nucMed', rect: { col: 22, row: 27, cols: 3, rows: 4 }, door: { col: 23, row: 31 } },
  { type: 'dialysis', rect: { col: 26, row: 27, cols: 3, rows: 4 }, door: { col: 27, row: 31 } },
  { type: 'surgery', rect: { col: 30, row: 27, cols: 4, rows: 4 }, door: { col: 31, row: 31 } },
];

/**
 * The imaging/OR rooms whose CAPITAL cost the probes bankroll (they measure the
 * operating envelope of a build already paid for, not the capex of reaching it).
 */
export const EXPANSION_WING: readonly RoomType[] = [
  'ultrasound', 'ct', 'mri', 'nucMed', 'dialysis', 'surgery',
];

/**
 * The mature reference roster (mirrors the ED probe). A FACTORY, not a shared
 * const: the ED probe mutates its roster in place for the "3rd radTech" arm, so
 * each caller must own a fresh array.
 */
export function matureStaffRoster(): { role: RoleId; count: number }[] {
  return [
    { role: 'nurse', count: 3 },
    { role: 'doctor', count: 2 },
    { role: 'radTech', count: 2 },
    { role: 'respTherapist', count: 1 },
    { role: 'sonographer', count: 1 },
    { role: 'surgeon', count: 1 },
    { role: 'anesthesiologist', count: 1 },
    { role: 'evs', count: 1 },
    { role: 'maintenance', count: 1 },
  ];
}
