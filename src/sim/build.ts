import { AMENITY_DEFS, type AmenityId } from './data/amenities';
import { ROOM_DEFS, type RoomType } from './data/rooms';
import { BALANCE } from './data/balance';
import { expandPrice, priceOf } from './formulas';
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
  // Size-based economy (Stage 0): the check prices the ACTUAL rect, so the
  // ghost turns red the moment a drag grows past what the player can afford.
  if (!free && world.cash < priceOf(type, rect)) return fail('Not enough cash');

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
    // SHIFTS Stage-1: an off-floor (gone-home) staffer is off the map.
    if ('onFloor' in person && !person.onFloor) continue;
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

  return reachabilityWithWalls(world, rect, door, isOpen, null);
}

/**
 * The entrance-reachability BFS with a pending rect's walls overlaid — shared
 * by NEW builds and Stage-B EXPANSIONS (one implementation, tech plan §2.4).
 * Requires: the pending door's outside tile, every existing room's door, and
 * every person's standing tile stay entrance-reachable; open-plan rects need
 * ≥1 reachable footprint tile. `ignoreRoomId` (expansion): the room being
 * grown — its CURRENT door check is superseded by the overlaid pending door.
 */
function reachabilityWithWalls(
  world: World,
  rect: Rect,
  door: Door | null,
  isOpen: boolean,
  ignoreRoomId: number | null,
): Validation {
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
    if (room.id === ignoreRoomId) continue;
    if (room.door && !visited.has(keyOf(room.door.outside))) {
      return fail(`Would cut off ${ROOM_DEFS[room.type].label} from the entrance`);
    }
  }
  // No one may be sealed into a pocket the walls create (M1 review M-5;
  // GDD §5): everyone's standing tile must stay entrance-reachable —
  // patients AND staff (M2 review #2).
  for (const person of [...world.patients.values(), ...world.staff.values()]) {
    if ('onFloor' in person && !person.onFloor) continue; // SHIFTS: off-floor = off map
    const standing = person.next ?? person.at;
    if (!visited.has(keyOf(standing))) {
      return fail(`Would trap ${person.name.full}`);
    }
  }
  return OK;
}

/**
 * Stage B (CAPACITY_PLAN §4.2): may this built room grow to `newRect`?
 * Ratified rules: newRect must be a strict superset; the room must be
 * RESERVATION-free, but seated/standing occupants inside the CURRENT rect are
 * allowed (their tiles don't change — a full waiting room can expand); the
 * DELTA tiles must be clear (no rooms/props/actors/entrance) and must not
 * swallow any door's corridor tile — including the room's own (door-orphan:
 * reject iff newRect contains door.outside). One validator for the UI ghost
 * AND the sim command (SSOT rule 4).
 */
export function validateRoomExpand(
  world: World,
  roomId: number,
  newRect: Rect,
  free = false,
): Validation {
  const room = world.rooms.get(roomId);
  if (!room) return fail('No such room');
  const old = room.rect;
  const superset =
    newRect.col <= old.col &&
    newRect.row <= old.row &&
    newRect.col + newRect.cols >= old.col + old.cols &&
    newRect.row + newRect.rows >= old.row + old.rows;
  if (!superset) return fail('Expansion must grow the room, not move it');
  if (newRect.cols * newRect.rows === old.cols * old.rows) {
    return fail('Drag outside the room to grow it');
  }
  if (
    newRect.col < 0 ||
    newRect.row < 0 ||
    newRect.col + newRect.cols > world.cols ||
    newRect.row + newRect.rows > world.rows
  ) {
    return fail('Out of bounds');
  }
  // Stage 3 (§5.2): a broken room cannot grow — capacity is 0 while broken,
  // and a "Beds 2/0" readout is exactly the confusion this reject prevents.
  if (room.brokenSince !== null) return fail('Out of service — repair it first');
  for (const reservation of world.reservations.values()) {
    if (reservation.roomId === roomId) return fail('Room is busy — wait for treatments to finish');
  }
  // Live stall claims gate geometry (amenities Stage 1, §3.3 / §8 Q7): slot
  // indices are row-major over the rect, so expansion RENUMBERS them — and
  // stall claims are derived, without Reservation.slotIndex's stored-stable
  // protection. Walking claimants included, symmetric with the gate above.
  for (const p of world.patients.values()) {
    if (p.needBreak?.roomId === roomId) return fail('Occupied');
  }
  // SHIFTS Stage 2 (§2): lounge seat claims (staff on lunch) renumber on
  // expand exactly like stalls — walking claimants included.
  if (world.loungeHasLiveClaim(roomId)) return fail('Occupied');
  if (room.door && rectContains(newRect, room.door.outside)) {
    return fail('Expansion would swallow the door — grow away from it');
  }
  if (!free && world.cash < expandPrice(room.type, old, newRect)) {
    return fail('Not enough cash');
  }

  const entrance = BALANCE.map.entrance;
  const isOpen = ROOM_DEFS[room.type].kind === 'open';
  for (const tile of rectTiles(newRect)) {
    if (rectContains(old, tile)) continue; // existing interior — occupants allowed
    const t = world.tileAt(tile.col, tile.row)!;
    if (t.roomId !== null) return fail('Overlaps another room');
    if (!t.walkable) return fail('Blocked by an object');
    if (samePoint(tile, entrance)) return fail('Cannot build over the entrance');
    for (const person of [...world.patients.values(), ...world.staff.values()]) {
      if ('onFloor' in person && !person.onFloor) continue; // SHIFTS: off-floor = off map
      if (samePoint(person.at, tile) || (person.next && samePoint(person.next, tile))) {
        return fail('Someone is standing there');
      }
    }
    if (!isOpen) {
      for (const other of world.rooms.values()) {
        if (other.id !== roomId && other.door && samePoint(other.door.outside, tile)) {
          return fail(`Blocks the door of ${ROOM_DEFS[other.type].label}`);
        }
      }
    }
  }

  // POST-expansion interior connectivity (Stage B review MAJOR 2): the outer
  // BFS runs against the CURRENT grid where the old boundary walls are still
  // live, so it can't see that a delta tile may only connect to the door
  // through the old interior — which props can seal (an ultrasound's bed fills
  // its whole top row; growing north creates a pocket the dispatcher would
  // anchor into, grinding reservations forever). Simulate the POST state:
  // within newRect there are no interior walls, so a plain walkable-tile BFS
  // from door.inside must reach EVERY walkable tile of the grown room.
  if (!isOpen && room.door) {
    const keyOf = (p: GridPoint): number => p.col * world.rows + p.row;
    const inside = room.door.inside;
    const seen = new Set<number>([keyOf(inside)]);
    const queue: GridPoint[] = [inside];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const step of ORTHOGONAL_STEPS) {
        const next = { col: current.col + step.col, row: current.row + step.row };
        if (!rectContains(newRect, next)) continue;
        const k = keyOf(next);
        if (seen.has(k)) continue;
        // Delta tiles are corridor today (validated walkable above); old
        // tiles keep their prop walkability — both read straight off the grid.
        if (!world.tileAt(next.col, next.row)!.walkable) continue;
        seen.add(k);
        queue.push(next);
      }
    }
    for (const tile of rectTiles(newRect)) {
      if (world.tileAt(tile.col, tile.row)!.walkable && !seen.has(keyOf(tile))) {
        return fail('Expansion would create space unreachable from the door');
      }
    }
  }

  return reachabilityWithWalls(world, newRect, room.door, isOpen, roomId);
}

/**
 * Amenity placement validation (amenities Stage 1, AMENITIES_PLAN §3.4 /
 * plan §1.8). One validator for the UI ghost AND the sim command (SSOT rule
 * 4). Rules, in order: bounds; tile walkable with no object; roomless OR
 * open-plan (walled-room interiors rejected); explicitly NOT the entrance
 * tile (review MAJOR 5 — the reachability BFS seeds AT the entrance and
 * cannot see its own start tile become unwalkable); no person's `at` OR
 * committed `next` on the tile and the tile unclaimed as a walk target
 * (the build-validator clause — NOT isTileClaimed, which misses `next`);
 * cash; and the blocked-tile reachability BFS (the §3.4 variant): with the
 * candidate tile removed from the walkable set, the entrance must still
 * reach every room door AND every person's standing tile (no trapping).
 */
export function validateAmenityPlace(world: World, kind: AmenityId, tile: GridPoint): Validation {
  const t = world.tileAt(tile.col, tile.row);
  if (!t) return fail('Out of bounds');
  if (!t.walkable || t.object !== null) return fail('Blocked by an object');
  if (t.roomId !== null) {
    const room = world.rooms.get(t.roomId);
    if (!room || ROOM_DEFS[room.type].kind !== 'open') {
      return fail('Must go on a corridor or atrium tile');
    }
  }
  if (samePoint(tile, BALANCE.map.entrance)) return fail('Cannot block the entrance');
  for (const person of [...world.patients.values(), ...world.staff.values()]) {
    if ('onFloor' in person && !person.onFloor) continue; // SHIFTS: off-floor = off map
    if (
      samePoint(person.at, tile) ||
      (person.next && samePoint(person.next, tile)) ||
      (person.target && samePoint(person.target, tile))
    ) {
      return fail('Someone is standing there');
    }
  }
  if (world.cash < AMENITY_DEFS[kind].cost) return fail('Not enough cash');

  // Blocked-tile BFS: the room-build BFS overlays WALLS, which is not
  // sufficient here — this variant removes the candidate tile itself from the
  // walkable set (the machine will occupy it) and asserts nothing is cut off.
  const keyOf = (p: GridPoint): number => p.col * world.rows + p.row;
  const blockedKey = keyOf(tile);
  const visited = new Set<number>([keyOf(BALANCE.map.entrance)]);
  const queue: GridPoint[] = [BALANCE.map.entrance];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const step of ORTHOGONAL_STEPS) {
      const next = { col: current.col + step.col, row: current.row + step.row };
      if (!world.tileAt(next.col, next.row)?.walkable) continue;
      const k = keyOf(next);
      if (k === blockedKey || visited.has(k)) continue;
      if (!world.canStep(current, next)) continue;
      visited.add(k);
      queue.push(next);
    }
  }
  for (const room of world.rooms.values()) {
    if (room.door && !visited.has(keyOf(room.door.outside))) {
      return fail(`Would cut off ${ROOM_DEFS[room.type].label} from the entrance`);
    }
  }
  for (const person of [...world.patients.values(), ...world.staff.values()]) {
    if ('onFloor' in person && !person.onFloor) continue; // SHIFTS: off-floor = off map
    const standing = person.next ?? person.at;
    if (!visited.has(keyOf(standing))) {
      return fail(`Would trap ${person.name.full}`);
    }
  }
  return OK;
}

/** Amenity sell validation (plan §1.8): the amenity must exist. */
export function validateAmenitySell(world: World, tile: GridPoint): Validation {
  return world.amenityAt(tile.col, tile.row) === null ? fail('No amenity there') : OK;
}

/** Sell validation: unoccupied and unreserved (Flow rule 9). */
export function validateRoomSell(world: World, roomId: number): Validation {
  const room = world.rooms.get(roomId);
  if (!room) return fail('No such room');
  for (const reservation of world.reservations.values()) {
    if (reservation.roomId === roomId) return fail('Room is reserved');
  }
  // Live stall claims block the sale (amenities Stage 1, §3.3 / §8 Q7) —
  // walking claimants included; the gate clears in minutes.
  for (const p of world.patients.values()) {
    if (p.needBreak?.roomId === roomId) return fail('Occupied');
  }
  // SHIFTS Stage 2 (§2): a staffer on lunch claims a lounge seat (walking
  // included) — "Someone is inside" only catches an ARRIVED on-floor claimant.
  if (world.loungeHasLiveClaim(roomId)) return fail('Occupied');
  // Open-plan exemption (Flow rule 9, M3 ruling): an atrium holds no one —
  // its tiles are public through-traffic, so people standing on them never
  // block the sale (they stay exactly where they are, on plain corridor).
  if (ROOM_DEFS[room.type].kind !== 'open') {
    for (const person of [...world.patients.values(), ...world.staff.values()]) {
      if ('onFloor' in person && !person.onFloor) continue; // SHIFTS: off-floor = off map
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
