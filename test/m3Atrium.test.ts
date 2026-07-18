import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { BALANCE } from '../src/sim/data/balance';
import { PROP_STYLE, ROOM_DEFS, WAITING_ROOM_BASE_CHAIRS } from '../src/sim/data/rooms';
import { ROLE_DEFS } from '../src/sim/data/roles';
import { propTargetCount } from '../src/sim/formulas';
import { rectTiles } from '../src/sim/types';
import { World } from '../src/sim/world';

/** M3 stage 2: room props, greeter posting, atrium auras + invalidation. */

function setup(seed = 42) {
  const events = new EventBus();
  const world = new World(events, seed);
  const queue = new CommandQueue();
  const apply = () => world.applyCommands(queue);
  return { world, queue, events, apply };
}

const ATRIUM_RECT = { col: 10, row: 10, cols: 4, rows: 4 } as const;

function buildAtrium(t: ReturnType<typeof setup>) {
  t.queue.push({ type: 'buildRoom', roomType: 'atrium', rect: ATRIUM_RECT, doorOutside: null });
  t.apply();
  return t.world.roomsOfType('atrium')[0]!;
}

/** Tick until a posted greeter has arrived at the help desk (bounded). */
function tickUntilStaffed(t: ReturnType<typeof setup>, atriumId: number): void {
  for (let i = 0; i < 3000; i++) {
    t.world.tick();
    const room = t.world.rooms.get(atriumId)!;
    if (t.world.atriumStaffed(room)) return;
  }
  throw new Error('greeter never arrived');
}

describe('room props (GDD §5 equipment, auto-placed)', () => {
  it('every room type places its declared props; unwalkable ones never strand the interior', () => {
    const expectations = [
      { type: 'reception', rect: { col: 5, row: 5, cols: 2, rows: 3 }, door: { col: 7, row: 6 } },
      { type: 'waiting', rect: { col: 10, row: 5, cols: 3, rows: 3 }, door: { col: 11, row: 8 } },
      { type: 'triage', rect: { col: 15, row: 5, cols: 2, rows: 2 }, door: { col: 15, row: 7 } },
      { type: 'exam', rect: { col: 19, row: 5, cols: 3, rows: 3 }, door: { col: 20, row: 8 } },
      { type: 'xray', rect: { col: 24, row: 5, cols: 3, rows: 4 }, door: { col: 25, row: 9 } },
      { type: 'resp', rect: { col: 29, row: 5, cols: 3, rows: 3 }, door: { col: 30, row: 8 } },
      { type: 'er', rect: { col: 34, row: 5, cols: 3, rows: 4 }, door: { col: 35, row: 9 } },
    ] as const;
    const t = setup();
    for (const spec of expectations) {
      t.queue.push({
        type: 'buildRoom',
        roomType: spec.type,
        rect: spec.rect,
        doorOutside: spec.door,
      });
    }
    t.apply();
    expect(t.world.rooms.size).toBe(expectations.length);

    for (const spec of expectations) {
      const def = ROOM_DEFS[spec.type];
      const expectedTiles = def.props.reduce(
        (sum, p) => sum + PROP_STYLE[p.id].tiles * propTargetCount(p.density, spec.rect),
        0,
      );
      const tiles = rectTiles(spec.rect).map((p) => t.world.tileAt(p.col, p.row)!);
      const propTiles = tiles.filter((tile) => tile.object !== null);
      expect(propTiles.length).toBe(expectedTiles);
      // Walkability matches each prop's spec.
      for (const prop of def.props) {
        const ofThis = tiles.filter((tile) => tile.object === prop.id);
        expect(ofThis.length).toBe(PROP_STYLE[prop.id].tiles * propTargetCount(prop.density, spec.rect));
        for (const tile of ofThis) expect(tile.walkable).toBe(prop.walkable);
      }
      // The room still works: at least two walkable interior tiles remain.
      expect(tiles.filter((tile) => tile.walkable).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('a waiting room seats its chair count and seated patients head for chair tiles', () => {
    const t = setup();
    t.queue.push({
      type: 'buildRoom',
      roomType: 'waiting',
      rect: { col: 10, row: 10, cols: 3, rows: 3 },
      doorOutside: { col: 11, row: 13 },
    });
    t.apply();
    const room = t.world.roomsOfType('waiting')[0]!;
    const chairTiles = rectTiles(room.rect).filter(
      (p) => t.world.tileAt(p.col, p.row)!.object === 'chair',
    );
    expect(chairTiles.length).toBe(WAITING_ROOM_BASE_CHAIRS);

    const patient = t.world.spawnPatient('flu');
    patient.stage = { kind: 'waiting' };
    patient.acuity = 3;
    t.world.assignWaitingSpot(patient);
    expect(patient.waitingRoomId).toBe(room.id);
    expect(chairTiles.some((c) => c.col === patient.target!.col && c.row === patient.target!.row)).toBe(
      true,
    );
  });
});

describe('atrium auras (GDD §5, M3-gate geometry rulings)', () => {
  it('comfort is immediate and unstaffed; guidance requires a posted greeter who has ARRIVED', () => {
    const t = setup();
    const atrium = buildAtrium(t);
    const inside = { col: 11, row: 11 };
    expect(t.world.hasComfortAura(inside)).toBe(true); // staffed or not
    expect(t.world.hasGuidanceAura(inside)).toBe(false); // nobody posted yet

    t.world.addStaffMember('greeter', 1, ROLE_DEFS.greeter.salaryPerDay);
    t.world.tick(); // posted, starts walking from the entrance
    expect(t.world.hasGuidanceAura(inside)).toBe(false); // posted ≠ arrived

    tickUntilStaffed(t, atrium.id);
    expect(t.world.hasGuidanceAura(inside)).toBe(true); // arrival invalidated the grid
  });

  it('radius is Euclidean from the nearest footprint tile — edge in, corner-diagonal out', () => {
    const t = setup();
    buildAtrium(t); // rect cols 10–13, rows 10–13
    const r = BALANCE.wayfinding.guidanceAuraRadius;
    expect(t.world.hasComfortAura({ col: 10, row: 10 - r })).toBe(true); // exactly r
    expect(t.world.hasComfortAura({ col: 10, row: 10 - r - 1 })).toBe(false); // r+1
    // Diagonal from the corner: 6,6 from (10,10) → √72 > 8 → outside.
    expect(t.world.hasComfortAura({ col: 4, row: 4 })).toBe(false);
    // 5,5 from (10,10) → √50 < 8 → inside.
    expect(t.world.hasComfortAura({ col: 5, row: 5 })).toBe(true);
  });

  it('selling the atrium clears both auras even with people standing on its tiles', () => {
    const t = setup();
    const atrium = buildAtrium(t);
    const loiterer = t.world.spawnPatient('flu');
    loiterer.at = { col: 11, row: 11 }; // standing ON the atrium — public tiles
    expect(t.world.hasComfortAura({ col: 11, row: 11 })).toBe(true);

    t.queue.push({ type: 'sellRoom', roomId: atrium.id });
    t.apply();
    expect(t.world.rooms.has(atrium.id)).toBe(false); // open-plan sell exemption
    expect(t.world.hasComfortAura({ col: 11, row: 11 })).toBe(false);
    expect(t.world.hasGuidanceAura({ col: 11, row: 11 })).toBe(false);
  });

  it('firing the greeter kills guidance but not comfort; auras from a second atrium union', () => {
    const t = setup();
    const atrium = buildAtrium(t);
    t.world.addStaffMember('greeter', 1, ROLE_DEFS.greeter.salaryPerDay);
    tickUntilStaffed(t, atrium.id);
    const inside = { col: 11, row: 11 };
    expect(t.world.hasGuidanceAura(inside)).toBe(true);

    const greeter = [...t.world.staff.values()].find((s) => s.role === 'greeter')!;
    t.queue.push({ type: 'fireStaff', staffId: greeter.id });
    t.apply();
    expect(t.world.hasGuidanceAura(inside)).toBe(false);
    expect(t.world.hasComfortAura(inside)).toBe(true);

    // Second atrium far away: both coverages exist independently.
    t.queue.push({
      type: 'buildRoom',
      roomType: 'atrium',
      rect: { col: 30, row: 30, cols: 4, rows: 4 },
      doorOutside: null,
    });
    t.apply();
    expect(t.world.hasComfortAura({ col: 31, row: 31 })).toBe(true);
    expect(t.world.hasComfortAura(inside)).toBe(true);
  });

  it('a sealed atrium is rejected: at least one footprint tile must be entrance-reachable', () => {
    const t = setup();
    // Wall off a pocket manually (M3 wayfinding-era states; illegal via commands).
    for (let col = 8; col <= 16; col++) {
      for (let row = 8; row <= 16; row++) {
        const edge = col === 8 || col === 16 || row === 8 || row === 16;
        if (edge) t.world.tileAt(col, row)!.walkable = false;
      }
    }
    const rejections: string[] = [];
    t.events.on('buildRejected', ({ reason }) => rejections.push(reason));
    t.queue.push({ type: 'buildRoom', roomType: 'atrium', rect: ATRIUM_RECT, doorOutside: null });
    t.apply();
    expect(t.world.roomsOfType('atrium').length).toBe(0);
    expect(rejections).toEqual(['Atrium must be reachable from the entrance']);
  });
});

describe('greeter standing post', () => {
  it('the greeter posts beside the help desk, not on an arbitrary corner', () => {
    const t = setup();
    const atrium = buildAtrium(t);
    const greeter = t.world.addStaffMember('greeter', 1, ROLE_DEFS.greeter.salaryPerDay);
    t.world.tick();
    expect(greeter.duty).toEqual({ kind: 'post', roomId: atrium.id });

    const desk = rectTiles(atrium.rect).find(
      (p) => t.world.tileAt(p.col, p.row)!.object === 'helpDesk',
    )!;
    const goal = greeter.target!;
    const manhattan = Math.abs(goal.col - desk.col) + Math.abs(goal.row - desk.row);
    expect(manhattan).toBe(1); // orthogonally adjacent to the desk
  });
});
