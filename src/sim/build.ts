import { ROOM_DEFS, type RoomType } from './data/rooms';
import { BALANCE } from './data/balance';
import type { Door } from './entities/room';
import {
  ORTHOGONAL_STEPS,
  rectContains,
  rectTiles,
  samePoint,
  type GridPoint,
  type Rect,
} from './types';
import type { World } from './world';

export type Validation = { ok: true } | { ok: false; reason: string };

const fail = (reason: string): Validation => ({ ok: false, reason });
const OK: Validation = { ok: true };

/** Does the rect satisfy the room's minimum footprint in either orientation? */
function fitsMinimum(type: RoomType, rect: Rect): boolean {
  const def = ROOM_DEFS[type];
  return (
    (rect.cols >= def.minCols && rect.rows >= def.minRows) ||
    (rect.cols >= def.minRows && rect.rows >= def.minCols)
  );
}

/**
 * Phase-1 validation: is this rect a legal footprint for this room type?
 * (GDD §5 placement validation, minus the door/reachability checks.)
 * Used by both the UI ghost preview and the sim's command handler — one
 * function, per SSOT rule 4.
 */
export function validateRoomRect(
  world: World,
  type: RoomType,
  rect: Rect,
  free = false,
): Validation {
  if (rect.cols < 1 || rect.rows < 1) return fail('Drag out a room footprint');
  if (
    rect.col < 0 ||
    rect.row < 0 ||
    rect.col + rect.cols > world.cols ||
    rect.row + rect.rows > world.rows
  ) {
    return fail('Out of bounds');
  }
  if (!fitsMinimum(type, rect)) {
    const def = ROOM_DEFS[type];
    return fail(`${def.label} needs at least ${def.minCols}×${def.minRows}`);
  }
  if (!free && world.cash < ROOM_DEFS[type].cost) return fail('Not enough cash');

  const entrance = BALANCE.map.entrance;
  for (const tile of rectTiles(rect)) {
    const t = world.tileAt(tile.col, tile.row)!;
    if (t.roomId !== null) return fail('Overlaps another room');
    if (!t.walkable) return fail('Blocked by an object');
    if (samePoint(tile, entrance)) return fail('Cannot build over the entrance');
  }
  // Open-plan footprints (atrium) keep their tiles walkable, so covering a
  // door landing is fine for them (M1 review M-2).
  if (ROOM_DEFS[type].kind !== 'open') {
    for (const room of world.rooms.values()) {
      if (room.door && rectContains(rect, room.door.outside)) {
        return fail(`Blocks the door of ${ROOM_DEFS[room.type].label}`);
      }
    }
  }
  // GDD §5 "no actors on the footprint" — patients AND staff (M2 review #2).
  for (const person of [...world.patients.values(), ...world.staff.values()]) {
    if (rectContains(rect, person.at) || (person.next && rectContains(rect, person.next))) {
      return fail('Someone is standing there');
    }
  }
  return OK;
}

/** Derive the door edge from a clicked outside tile; null if not a legal door position. */
export function doorFromOutsideTile(rect: Rect, outside: GridPoint): Door | null {
  if (rectContains(rect, outside)) return null;
  let inside: GridPoint | null = null;
  for (const step of ORTHOGONAL_STEPS) {
    const neighbor = { col: outside.col + step.col, row: outside.row + step.row };
    if (rectContains(rect, neighbor)) {
      if (inside) return null; // unreachable for an axis-aligned rect, but be safe
      inside = neighbor;
    }
  }
  return inside ? { inside, outside } : null;
}

/**
 * Phase-2 validation: door legality + the entrance-reachability BFS
 * (tech plan §2.4). The BFS overlays the pending room's walls on the current
 * world and requires that (a) the new door's outside tile and (b) every
 * existing room's door outside tile remain reachable from the entrance.
 * Open-plan rooms (kind 'open') skip the door but still must not sever
 * anything — pass door: null.
 */
export function validateRoomBuild(
  world: World,
  type: RoomType,
  rect: Rect,
  door: Door | null,
  free = false,
): Validation {
  const rectCheck = validateRoomRect(world, type, rect, free);
  if (!rectCheck.ok) return rectCheck;

  const isOpen = ROOM_DEFS[type].kind === 'open';
  if (!isOpen) {
    if (!door) return fail('Pick a door position');
    const derived = doorFromOutsideTile(rect, door.outside);
    if (!derived || !samePoint(derived.inside, door.inside)) return fail('Invalid door position');
    const outsideTile = world.tileAt(door.outside.col, door.outside.row);
    // GDD §5: doors open onto a "corridor/open tile" — atrium tiles stay
    // public, so a door may face into an open-plan room (M1 review M-2).
    const outsideRoom =
      outsideTile?.roomId != null ? (world.rooms.get(outsideTile.roomId) ?? null) : null;
    const opensToOpenRoom = outsideRoom !== null && ROOM_DEFS[outsideRoom.type].kind === 'open';
    if (!outsideTile || !outsideTile.walkable || (outsideTile.roomId !== null && !opensToOpenRoom)) {
      return fail('Door must open onto a corridor or atrium');
    }
  }

  // Reachability BFS from the entrance, with the pending walls overlaid.
  const pendingWalled = !isOpen;
  const stepAllowed = (from: GridPoint, to: GridPoint): boolean => {
    if (pendingWalled) {
      const inFrom = rectContains(rect, from);
      const inTo = rectContains(rect, to);
      if (inFrom !== inTo) {
        if (!door) return false;
        const inside = inFrom ? from : to;
        const outside = inFrom ? to : from;
        if (!samePoint(door.inside, inside) || !samePoint(door.outside, outside)) return false;
      }
    }
    return world.canStep(from, to);
  };

  const visited = new Set<number>();
  const keyOf = (p: GridPoint): number => p.col * world.rows + p.row;
  const queue: GridPoint[] = [BALANCE.map.entrance];
  visited.add(keyOf(BALANCE.map.entrance));
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const step of ORTHOGONAL_STEPS) {
      const next = { col: current.col + step.col, row: current.row + step.row };
      if (!world.tileAt(next.col, next.row)) continue;
      const k = keyOf(next);
      if (visited.has(k)) continue;
      if (!world.tileAt(next.col, next.row)!.walkable) continue;
      if (!stepAllowed(current, next)) continue;
      visited.add(k);
      queue.push(next);
    }
  }

  if (door && !visited.has(keyOf(door.outside))) {
    return fail('Door would be unreachable from the entrance');
  }
  // Open-plan rooms have no door, but a sealed atrium is useless: at least one
  // footprint tile must be entrance-reachable (GDD Flow rule 9, M3 ruling).
  if (isOpen && !rectTiles(rect).some((t) => visited.has(keyOf(t)))) {
    return fail('Atrium must be reachable from the entrance');
  }
  for (const room of world.rooms.values()) {
    if (room.door && !visited.has(keyOf(room.door.outside))) {
      return fail(`Would cut off ${ROOM_DEFS[room.type].label} from the entrance`);
    }
  }
  // No one may be sealed into a pocket the walls create (M1 review M-5;
  // GDD §5): everyone's standing tile must stay entrance-reachable —
  // patients AND staff (M2 review #2).
  for (const person of [...world.patients.values(), ...world.staff.values()]) {
    const standing = person.next ?? person.at;
    if (!visited.has(keyOf(standing))) {
      return fail(`Would trap ${person.name.full}`);
    }
  }
  return OK;
}

/** Sell validation: unoccupied and unreserved (Flow rule 9). */
export function validateRoomSell(world: World, roomId: number): Validation {
  const room = world.rooms.get(roomId);
  if (!room) return fail('No such room');
  for (const reservation of world.reservations.values()) {
    if (reservation.roomId === roomId) return fail('Room is reserved');
  }
  // Open-plan exemption (Flow rule 9, M3 ruling): an atrium holds no one —
  // its tiles are public through-traffic, so people standing on them never
  // block the sale (they stay exactly where they are, on plain corridor).
  if (ROOM_DEFS[room.type].kind !== 'open') {
    for (const person of [...world.patients.values(), ...world.staff.values()]) {
      if (
        rectContains(room.rect, person.at) ||
        (person.next && rectContains(room.rect, person.next))
      ) {
        return fail('Someone is inside');
      }
    }
  }
  return OK;
}
