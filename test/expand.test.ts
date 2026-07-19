import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { growExpandRect } from '../src/render/placement';
import { validateRoomExpand } from '../src/sim/build';
import { ROLE_DEFS } from '../src/sim/data/roles';
import { ROOM_DEFS } from '../src/sim/data/rooms';
import { expandPrice, priceOf, roomQuality, sellbackAmount } from '../src/sim/formulas';
import { setupNewGame } from '../src/sim/newGame';
import { loadWorld, saveToString } from '../src/sim/save';
import { rectTiles, type Rect } from '../src/sim/types';
import { World } from '../src/sim/world';

/**
 * Capacity epic Stage B — the expand tool (CAPACITY_PLAN §4.2, ratified).
 * Growing a built room: strict superset, delta-clear, door preserved,
 * reservation-free (seated occupants allowed), priced on the Stage-0 curve,
 * ADDITIVE re-densify (existing prop tiles byte-preserved).
 */

function setup(seed = 42) {
  const events = new EventBus();
  const world = new World(events, seed);
  setupNewGame(world);
  const queue = new CommandQueue();
  return { world, events, queue };
}

function build(world: World, type: keyof typeof ROOM_DEFS, rect: Rect) {
  // WEST-side door: expansion tests grow south/east, and a door on the grown
  // side would (correctly) trip the door-orphan rejection.
  world.buildRoom(type, rect, { col: rect.col - 1, row: rect.row + 1 }, true);
  return [...world.rooms.values()].at(-1)!;
}

function hire(world: World, role: keyof typeof ROLE_DEFS, n = 1): void {
  for (let i = 0; i < n; i++) {
    world.addStaffMember(role, 3, ROLE_DEFS[role].salaryPerDay, {
      first: `T${i}`,
      last: role,
      full: `T${i} ${role}`,
      short: `T${i}.`,
    });
  }
}

describe('growExpandRect (pure preview math)', () => {
  const old: Rect = { col: 10, row: 10, cols: 3, rows: 4 };

  it('cursor inside returns the room unchanged', () => {
    expect(growExpandRect(old, { col: 11, row: 12 })).toEqual(old);
  });

  it('grows toward each side as a strict superset', () => {
    expect(growExpandRect(old, { col: 14, row: 11 })).toEqual({ col: 10, row: 10, cols: 5, rows: 4 });
    expect(growExpandRect(old, { col: 8, row: 11 })).toEqual({ col: 8, row: 10, cols: 5, rows: 4 });
    expect(growExpandRect(old, { col: 11, row: 16 })).toEqual({ col: 10, row: 10, cols: 3, rows: 7 });
    expect(growExpandRect(old, { col: 15, row: 16 })).toEqual({ col: 10, row: 10, cols: 6, rows: 7 });
  });
});

describe('validateRoomExpand', () => {
  it('accepts a clean southeast growth; rejects a non-superset', () => {
    const { world } = setup();
    const room = build(world, 'er', { col: 20, row: 20, cols: 3, rows: 4 });
    expect(validateRoomExpand(world, room.id, { col: 20, row: 20, cols: 4, rows: 6 }, true).ok).toBe(
      true,
    );
    const moved = validateRoomExpand(world, room.id, { col: 21, row: 20, cols: 4, rows: 6 }, true);
    expect(moved.ok).toBe(false);
  });

  it('rejects the unchanged rect (nothing to buy)', () => {
    const { world } = setup();
    const room = build(world, 'er', { col: 20, row: 20, cols: 3, rows: 4 });
    expect(validateRoomExpand(world, room.id, { ...room.rect }, true).ok).toBe(false);
  });

  it('door-orphan: growing over the door corridor tile is rejected', () => {
    const { world } = setup();
    // Explicit SOUTH door — growing south swallows its corridor tile.
    world.buildRoom('er', { col: 20, row: 20, cols: 3, rows: 4 }, { col: 21, row: 24 }, true);
    const room = [...world.rooms.values()].at(-1)!;
    const south = validateRoomExpand(world, room.id, { col: 20, row: 20, cols: 3, rows: 5 }, true);
    expect(south.ok).toBe(false);
    if (!south.ok) expect(south.reason).toContain('door');
  });

  it('delta occupied by another room / an actor is rejected; cash is priced on the delta', () => {
    const { world } = setup();
    const room = build(world, 'er', { col: 20, row: 20, cols: 3, rows: 4 });
    // Exam with an EAST door (27,21) so only its FOOTPRINT can collide with
    // the ER's growth — a west door would sit in the growth path and mask
    // the overlap/cash cases with a door-block rejection.
    world.buildRoom('exam', { col: 24, row: 20, cols: 3, rows: 3 }, { col: 27, row: 21 }, true);
    const overlap = validateRoomExpand(world, room.id, { col: 20, row: 20, cols: 5, rows: 4 }, true);
    expect(overlap.ok).toBe(false); // cols 24 hits the exam room at col 24
    // Actor on the delta:
    const p = world.spawnPatient('flu');
    p.at = { col: 20, row: 25 };
    p.next = null;
    const onDelta = validateRoomExpand(
      world,
      room.id,
      { col: 20, row: 20, cols: 3, rows: 6 },
      true,
    );
    expect(onDelta.ok).toBe(false);
    // Cash: exactly the expand price is required (not the full room price).
    world.patients.clear();
    world.cash = expandPrice('er', room.rect, { col: 20, row: 20, cols: 4, rows: 4 });
    expect(validateRoomExpand(world, room.id, { col: 20, row: 20, cols: 4, rows: 4 }).ok).toBe(true);
    world.cash -= 1;
    const short = validateRoomExpand(world, room.id, { col: 20, row: 20, cols: 4, rows: 4 });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.reason).toBe('Not enough cash');
  });

  it('a RESERVED room cannot expand; a merely-OCCUPIED waiting room can', () => {
    const { world } = setup();
    // Reserved ER blocks:
    const er = build(world, 'er', { col: 20, row: 20, cols: 3, rows: 4 });
    hire(world, 'doctor');
    hire(world, 'nurse');
    const p = world.spawnPatient('chestPain');
    p.stage = { kind: 'waiting' };
    p.acuity = 1;
    p.waitingSince = world.clock.tick;
    world.tick();
    expect(world.reservationsOn(er.id)).toHaveLength(1);
    const busy = validateRoomExpand(world, er.id, { col: 20, row: 20, cols: 4, rows: 4 }, true);
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.reason).toContain('busy');

    // Seated occupants in the STARTER waiting room don't block its expansion.
    const waiting = [...world.rooms.values()].find((r) => r.type === 'waiting')!;
    const sitter = world.spawnPatient('flu');
    sitter.stage = { kind: 'waitingTriage' };
    world.assignWaitingSpot(sitter);
    sitter.at = sitter.target!; // seated on a chair inside the room
    sitter.next = null;
    sitter.target = null;
    // Grow the waiting room 1 col east (delta must be clear on this layout).
    const grown = {
      col: waiting.rect.col,
      row: waiting.rect.row,
      cols: waiting.rect.cols + 1,
      rows: waiting.rect.rows,
    };
    const check = validateRoomExpand(world, waiting.id, grown, true);
    expect(check.ok, check.ok ? '' : check.reason).toBe(true);
  });
});

describe('Stage B review MAJORs (regressions of record)', () => {
  it('MAJOR 1: the prop top-up NEVER places onto a person standing in the old footprint', () => {
    const { world } = setup();
    const room = build(world, 'er', { col: 20, row: 20, cols: 3, rows: 4 });
    // A discharged walker legally inside the reservation-free room, standing
    // exactly where the deterministic scan would drop bed #2.
    const p = world.spawnPatient('flu');
    p.at = { col: 22, row: 20 };
    p.next = null;
    p.target = null;
    p.path = [];
    world.expandRoom(room.id, { col: 20, row: 20, cols: 4, rows: 6 }, true);
    expect(room.rect.cols).toBe(4); // the expansion itself succeeded
    // Their tile is untouched and walkable — nobody is entombed in a machine.
    const tile = world.tileAt(22, 20)!;
    expect(tile.object).toBeNull();
    expect(tile.walkable).toBe(true);
    // And the extra beds still landed (elsewhere): capacity grew.
    // 2 → 4 at ED Stage B1's density (1 bed / 6 tiles); the assertion's point
    // is that the top-up SUCCEEDED around the occupant, not the exact count.
    expect(world.capacityOf(room)).toBe(4);
  });

  it('MAJOR 2: an expansion that would pocket space behind equipment is REJECTED', () => {
    const { world } = setup();
    // Ultrasound 2×3: its 2-tile bed fills the entire TOP row of the rect.
    // Growing 1 row NORTH would put the delta behind that unwalkable row —
    // reachable from nowhere once the old boundary wall drops.
    const room = build(world, 'ultrasound', { col: 20, row: 20, cols: 2, rows: 3 });
    const topRowBlocked = [20, 21].every((col) => !world.tileAt(col, 20)!.walkable);
    expect(topRowBlocked, 'premise: the bed seals the top row').toBe(true);
    const north = validateRoomExpand(
      world,
      room.id,
      { col: 20, row: 19, cols: 2, rows: 4 },
      true,
    );
    expect(north.ok).toBe(false);
    if (!north.ok) expect(north.reason).toContain('unreachable');
    // Growth on an open side stays legal.
    const south = validateRoomExpand(world, room.id, { col: 20, row: 20, cols: 2, rows: 4 }, true);
    expect(south.ok, south.ok ? '' : south.reason).toBe(true);
  });
});

describe('world.expandRoom (the command path)', () => {
  it('ER 3×4 → 4×6: capacity 2→4, beds added, FIRST beds byte-preserved, priced + quality recomputed', () => {
    const { world, queue } = setup();
    const room = build(world, 'er', { col: 20, row: 20, cols: 3, rows: 4 });
    const bedTilesBefore = rectTiles(room.rect).filter(
      (t) => world.tileAt(t.col, t.row)!.object === 'traumaBed',
    );
    expect(world.capacityOf(room)).toBe(2); // ED Stage B1 density: 3×4 = 2 bays
    const cashBefore = world.cash;
    const newRect = { col: 20, row: 20, cols: 4, rows: 6 };
    const price = expandPrice('er', room.rect, newRect);
    expect(price).toBe(priceOf('er', newRect) - priceOf('er', room.rect));

    const changed: number[] = [];
    world.events.on('roomChanged', ({ roomId }) => changed.push(roomId));
    queue.push({ type: 'expandRoom', roomId: room.id, rect: newRect });
    world.applyCommands(queue);

    expect(room.rect).toEqual(newRect);
    expect(world.capacityOf(room)).toBe(4); // 2 → 4 bays at ED B1 density
    expect(changed).toEqual([room.id]);
    expect(cashBefore - world.cash).toBe(price);
    expect(world.today.construction).toBe(price);
    expect(room.quality).toBe(roomQuality('er', newRect));
    // Additive: the original bed's tiles are EXACTLY where they were.
    for (const t of bedTilesBefore) {
      expect(world.tileAt(t.col, t.row)!.object).toBe('traumaBed');
    }
    // Every delta tile belongs to the room now.
    for (const t of rectTiles(newRect)) {
      expect(world.tileAt(t.col, t.row)!.roomId).toBe(room.id);
    }
    // Rect-aware sellback now reflects the grown footprint.
    expect(sellbackAmount('er', room.rect)).toBe(
      Math.floor(priceOf('er', newRect) * 0.5),
    );
  });

  it('an invalid expansion is rejected sim-side with a buildRejected reason', () => {
    const { world, queue } = setup();
    // SOUTH door: growing south swallows its corridor tile → sim-side reject.
    world.buildRoom('er', { col: 20, row: 20, cols: 3, rows: 4 }, { col: 21, row: 24 }, true);
    const room = [...world.rooms.values()].at(-1)!;
    const reasons: string[] = [];
    world.events.on('buildRejected', ({ reason }) => reasons.push(reason));
    queue.push({ type: 'expandRoom', roomId: room.id, rect: { col: 20, row: 20, cols: 3, rows: 5 } });
    world.applyCommands(queue); // swallows the door
    expect(room.rect.rows).toBe(4); // unchanged
    expect(reasons).toHaveLength(1);
  });

  it('waiting-room expansion adds chairs and seats', () => {
    const { world } = setup();
    const waiting = [...world.rooms.values()].find((r) => r.type === 'waiting')!;
    expect(world.capacityOf(waiting)).toBe(6);
    const grown = {
      col: waiting.rect.col,
      row: waiting.rect.row,
      cols: waiting.rect.cols + 1,
      rows: waiting.rect.rows,
    };
    world.expandRoom(waiting.id, grown, true);
    expect(waiting.rect).toEqual(grown);
    expect(world.capacityOf(waiting)).toBeGreaterThan(6);
  });

  it('atrium expansion widens live aura coverage (signature includes the rect)', () => {
    const { world } = setup();
    world.buildRoom('atrium', { col: 8, row: 8, cols: 4, rows: 4 }, null, true);
    const atrium = [...world.rooms.values()].find((r) => r.type === 'atrium')!;
    // Beyond radius 8 of the original east edge (col 11), within radius of
    // the grown east edge (col 15): 11+8 < 20 <= 15+8.
    const probe = { col: 20, row: 9 };
    expect(world.hasComfortAura(probe)).toBe(false);
    const revBefore = world.auraRevision;
    world.expandRoom(atrium.id, { col: 8, row: 8, cols: 8, rows: 4 }, true);
    world.tick(); // aura signature recheck happens per tick / per command
    expect(world.hasComfortAura(probe)).toBe(true);
    expect(world.auraRevision).toBeGreaterThan(revBefore);
  });

  it('an expanded room round-trips through save/load (grid carries everything)', () => {
    const { world } = setup();
    const room = build(world, 'er', { col: 20, row: 20, cols: 3, rows: 4 });
    world.expandRoom(room.id, { col: 20, row: 20, cols: 4, rows: 6 }, true);
    const result = loadWorld(new EventBus(), saveToString(world));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const loaded = [...result.world.rooms.values()].find((r) => r.type === 'er')!;
    expect(loaded.rect).toEqual({ col: 20, row: 20, cols: 4, rows: 6 });
    expect(result.world.capacityOf(loaded)).toBe(4);
  });

  it('expandRoom is a NORMAL command — allowed in challenge mode', () => {
    const events = new EventBus();
    const world = new World(events, 42, true); // challengeMode
    setupNewGame(world);
    const room = build(world, 'er', { col: 20, row: 20, cols: 3, rows: 4 });
    const queue = new CommandQueue();
    world.cash = 1_000_000;
    queue.push({ type: 'expandRoom', roomId: room.id, rect: { col: 20, row: 20, cols: 4, rows: 6 } });
    world.applyCommands(queue);
    expect(room.rect.cols).toBe(4); // applied, not debug-gated
  });
});
