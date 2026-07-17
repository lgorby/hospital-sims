import { BALANCE } from './data/balance';
import { ROLE_DEFS } from './data/roles';
import type { World } from './world';

/**
 * GDD §9 first-run: a new game starts with a reception desk and waiting room
 * pre-built (free — they're part of the starting hospital, not a purchase)
 * and one receptionist already hired.
 */
export function setupNewGame(world: World): void {
  const e = BALANCE.map.entrance;
  // Reception north-west of the entrance with an EAST-facing door, so the
  // check-in queue extends along the corridor instead of clamping against the
  // map's south edge (M2 review #12).
  world.buildRoom(
    'reception',
    { col: e.col - 4, row: e.row - 6, cols: 2, rows: 3 },
    { col: e.col - 2, row: e.row - 5 },
    true,
  );
  // Waiting room north-east of the entrance, clear of the queue line.
  world.buildRoom(
    'waiting',
    { col: e.col + 2, row: e.row - 7, cols: 3, rows: 3 },
    { col: e.col + 3, row: e.row - 4 },
    true,
  );
  world.addStaffMember('receptionist', 3, ROLE_DEFS.receptionist.salaryPerDay, {
    first: 'June',
    last: 'Abernathy',
    full: 'June Abernathy',
    short: 'June A.',
  });
}
