import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { BALANCE } from '../src/sim/data/balance';
import { ROOM_DEFS } from '../src/sim/data/rooms';
import { World } from '../src/sim/world';

function setup() {
  const events = new EventBus();
  const world = new World(events, 1);
  const queue = new CommandQueue();
  const rejections: string[] = [];
  events.on('buildRejected', ({ reason }) => rejections.push(reason));
  const apply = () => world.applyCommands(queue);
  return { world, queue, events, rejections, apply };
}

// A 3×3 exam room at (10,10) with its door opening south from (11,12) to (11,13).
const EXAM_RECT = { col: 10, row: 10, cols: 3, rows: 3 };
const EXAM_DOOR_OUTSIDE = { col: 11, row: 13 };

function buildExam(t: ReturnType<typeof setup>) {
  t.queue.push({
    type: 'buildRoom',
    roomType: 'exam',
    rect: EXAM_RECT,
    doorOutside: EXAM_DOOR_OUTSIDE,
  });
  t.apply();
}

describe('room building', () => {
  it('builds a valid room: cash deducted, tiles claimed, quality computed', () => {
    const t = setup();
    buildExam(t);
    expect(t.rejections).toEqual([]);
    expect(t.world.rooms.size).toBe(1);
    expect(t.world.cash).toBe(BALANCE.economy.startingCash - ROOM_DEFS.exam.cost);
    expect(t.world.tileAt(10, 10)!.roomId).not.toBeNull();
    expect(t.world.tileAt(13, 10)?.roomId ?? null).toBeNull(); // outside rect
    const room = [...t.world.rooms.values()][0]!;
    expect(room.quality).toBe(0); // exact minimum footprint
    expect(room.door).toEqual({ inside: { col: 11, row: 12 }, outside: { col: 11, row: 13 } });
  });

  it('walls block boundary crossings everywhere except the door edge', () => {
    const t = setup();
    buildExam(t);
    // North boundary: (10,10)↔(10,9) blocked both ways.
    expect(t.world.canStep({ col: 10, row: 9 }, { col: 10, row: 10 })).toBe(false);
    expect(t.world.canStep({ col: 10, row: 10 }, { col: 10, row: 9 })).toBe(false);
    // Interior movement fine (avoiding the bed tiles at (10,10)/(11,10)).
    expect(t.world.canStep({ col: 10, row: 12 }, { col: 10, row: 11 })).toBe(true);
    // Door edge open both ways.
    expect(t.world.canStep({ col: 11, row: 13 }, { col: 11, row: 12 })).toBe(true);
    expect(t.world.canStep({ col: 11, row: 12 }, { col: 11, row: 13 })).toBe(true);
  });

  it('places a 2-tile bed in exam rooms that never blocks the door tile', () => {
    const t = setup();
    buildExam(t);
    const bedTiles: string[] = [];
    for (let col = 10; col < 13; col++) {
      for (let row = 10; row < 13; row++) {
        if (t.world.tileAt(col, row)!.object === 'bed') bedTiles.push(`${col},${row}`);
      }
    }
    expect(bedTiles.length).toBe(2);
    expect(bedTiles).not.toContain('11,12'); // door inside tile stays clear
  });

  it('rejects overlap, undersize, entrance, and insufficient cash', () => {
    const t = setup();
    buildExam(t);
    t.queue.push({
      type: 'buildRoom',
      roomType: 'waiting',
      rect: { col: 12, row: 12, cols: 3, rows: 3 }, // overlaps exam corner
      doorOutside: { col: 12, row: 15 },
    });
    t.queue.push({
      type: 'buildRoom',
      roomType: 'waiting',
      rect: { col: 0, row: 0, cols: 2, rows: 2 }, // below 3×3 minimum
      doorOutside: { col: 2, row: 0 },
    });
    const e = BALANCE.map.entrance;
    t.queue.push({
      type: 'buildRoom',
      roomType: 'waiting',
      rect: { col: e.col - 1, row: e.row - 2, cols: 3, rows: 3 }, // covers entrance
      doorOutside: { col: e.col - 2, row: e.row - 2 },
    });
    t.apply();
    t.world.cash = 100;
    t.queue.push({
      type: 'buildRoom',
      roomType: 'waiting',
      rect: { col: 0, row: 0, cols: 3, rows: 3 },
      doorOutside: { col: 3, row: 0 },
    });
    t.apply();
    expect(t.rejections.length).toBe(4);
    expect(t.world.rooms.size).toBe(1);
  });

  it('rejects a door that does not touch the rect, or on a diagonal', () => {
    const t = setup();
    t.queue.push({
      type: 'buildRoom',
      roomType: 'exam',
      rect: EXAM_RECT,
      doorOutside: { col: 9, row: 9 }, // diagonal corner
    });
    t.queue.push({
      type: 'buildRoom',
      roomType: 'exam',
      rect: EXAM_RECT,
      doorOutside: { col: 20, row: 20 }, // nowhere near
    });
    t.apply();
    expect(t.rejections.length).toBe(2);
    expect(t.world.rooms.size).toBe(0);
  });

  it('rejects a build that would sever an existing room from the entrance', () => {
    const t = setup();
    // Room A in the far north-west, door opening east.
    t.queue.push({
      type: 'buildRoom',
      roomType: 'exam',
      rect: { col: 0, row: 0, cols: 3, rows: 3 },
      doorOutside: { col: 3, row: 1 },
    });
    t.apply();
    expect(t.world.rooms.size).toBe(1);
    // A full-width wall band below it would strand A's door from the south entrance.
    t.queue.push({
      type: 'buildRoom',
      roomType: 'waiting',
      rect: { col: 0, row: 4, cols: 40, rows: 3 },
      doorOutside: { col: 20, row: 7 },
    });
    t.apply();
    expect(t.rejections.length).toBe(1);
    expect(t.rejections[0]).toContain('cut off');
    expect(t.world.rooms.size).toBe(1);
  });

  it('rejects building on top of another room’s door landing', () => {
    const t = setup();
    buildExam(t);
    t.queue.push({
      type: 'buildRoom',
      roomType: 'waiting',
      rect: { col: 10, row: 13, cols: 3, rows: 3 }, // sits on (11,13), exam's door outside
      doorOutside: { col: 10, row: 16 },
    });
    t.apply();
    expect(t.rejections.length).toBe(1);
    expect(t.world.rooms.size).toBe(1);
  });

  it('rejects building where a patient is standing', () => {
    const t = setup();
    t.queue.push({ type: 'debugSpawnPatient' });
    t.apply();
    const patient = [...t.world.patients.values()][0]!;
    patient.at = { col: 11, row: 11 };
    buildExam(t);
    expect(t.rejections.length).toBe(1);
    expect(t.world.rooms.size).toBe(0);
  });

  it('allows a door opening onto an atrium tile (open-plan tiles are public)', () => {
    const t = setup();
    t.queue.push({
      type: 'buildRoom',
      roomType: 'atrium',
      rect: { col: 20, row: 20, cols: 4, rows: 4 },
      doorOutside: null,
    });
    t.apply();
    t.queue.push({
      type: 'buildRoom',
      roomType: 'exam',
      rect: { col: 17, row: 20, cols: 3, rows: 3 }, // east side touches the atrium
      doorOutside: { col: 20, row: 21 }, // an atrium tile
    });
    t.apply();
    expect(t.rejections).toEqual([]);
    expect(t.world.rooms.size).toBe(2);
    // Exiting the exam through its door into the atrium works.
    expect(t.world.canStep({ col: 19, row: 21 }, { col: 20, row: 21 })).toBe(true);
  });

  it('rejects a build that would seal a person into a pocket', () => {
    const t = setup();
    t.queue.push({ type: 'debugSpawnPatient' });
    t.apply();
    const patient = [...t.world.patients.values()][0]!;
    patient.at = { col: 5, row: 0 }; // north edge, far from the footprint
    // Full-width band across rows 2–4 with a south-facing door would seal
    // rows 0–1 (map edge + walls) with the patient inside.
    t.queue.push({
      type: 'buildRoom',
      roomType: 'waiting',
      rect: { col: 0, row: 2, cols: 40, rows: 3 },
      doorOutside: { col: 20, row: 5 },
    });
    t.apply();
    expect(t.rejections.length).toBe(1);
    expect(t.rejections[0]).toContain('trap');
    expect(t.world.rooms.size).toBe(0);
    // Control: the identical build succeeds once no one is standing there.
    patient.at = { col: 5, row: 10 };
    t.queue.push({
      type: 'buildRoom',
      roomType: 'waiting',
      rect: { col: 0, row: 2, cols: 40, rows: 3 },
      doorOutside: { col: 20, row: 5 },
    });
    t.apply();
    expect(t.world.rooms.size).toBe(1);
  });

  it('adjacent rooms sharing a boundary stay mutually walled', () => {
    const t = setup();
    buildExam(t);
    t.queue.push({
      type: 'buildRoom',
      roomType: 'waiting',
      rect: { col: 13, row: 10, cols: 3, rows: 3 }, // flush against exam's east side
      doorOutside: { col: 14, row: 13 },
    });
    t.apply();
    expect(t.world.rooms.size).toBe(2);
    expect(t.world.canStep({ col: 12, row: 11 }, { col: 13, row: 11 })).toBe(false);
    expect(t.world.canStep({ col: 13, row: 11 }, { col: 12, row: 11 })).toBe(false);
  });

  it('bed placement keeps every walkable interior tile door-reachable (north-middle door)', () => {
    const t = setup();
    t.queue.push({
      type: 'buildRoom',
      roomType: 'exam',
      rect: { col: 10, row: 10, cols: 3, rows: 3 },
      doorOutside: { col: 11, row: 9 }, // door inside = (11,10), top-middle
    });
    t.apply();
    expect(t.rejections).toEqual([]);
    // Flood from door inside across walkable room tiles.
    const walkable = new Set<string>();
    for (let col = 10; col < 13; col++) {
      for (let row = 10; row < 13; row++) {
        if (t.world.tileAt(col, row)!.walkable) walkable.add(`${col},${row}`);
      }
    }
    const visited = new Set<string>(['11,10']);
    const queue = [{ col: 11, row: 10 }];
    while (queue.length > 0) {
      const c = queue.shift()!;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const n = { col: c.col + dc, row: c.row + dr };
        const k = `${n.col},${n.row}`;
        if (!walkable.has(k) || visited.has(k)) continue;
        if (!t.world.canStep(c, n)) continue;
        visited.add(k);
        queue.push(n);
      }
    }
    expect(visited.size).toBe(walkable.size);
    expect(walkable.size).toBe(9 - 2); // 3×3 minus the 2-tile bed
  });

  it('atrium builds open-plan: no door, boundary freely crossable', () => {
    const t = setup();
    t.queue.push({
      type: 'buildRoom',
      roomType: 'atrium',
      rect: { col: 20, row: 20, cols: 4, rows: 4 },
      doorOutside: null,
    });
    t.apply();
    expect(t.rejections).toEqual([]);
    const room = [...t.world.rooms.values()][0]!;
    expect(room.door).toBeNull();
    expect(t.world.canStep({ col: 19, row: 20 }, { col: 20, row: 20 })).toBe(true);
    expect(t.world.canStep({ col: 20, row: 20 }, { col: 19, row: 20 })).toBe(true);
  });

  it('sell refunds 50%, clears tiles, and removes walls', () => {
    const t = setup();
    buildExam(t);
    const roomId = [...t.world.rooms.keys()][0]!;
    t.queue.push({ type: 'sellRoom', roomId });
    t.apply();
    expect(t.world.rooms.size).toBe(0);
    expect(t.world.cash).toBe(
      BALANCE.economy.startingCash -
        ROOM_DEFS.exam.cost +
        Math.floor(ROOM_DEFS.exam.cost * BALANCE.economy.roomSellbackRatio),
    );
    expect(t.world.tileAt(10, 10)!.roomId).toBeNull();
    expect(t.world.tileAt(10, 10)!.walkable).toBe(true); // bed removed too
    expect(t.world.canStep({ col: 10, row: 9 }, { col: 10, row: 10 })).toBe(true);
  });

  it('refuses to sell a room with someone inside', () => {
    const t = setup();
    buildExam(t);
    t.queue.push({ type: 'debugSpawnPatient' });
    t.apply();
    const patient = [...t.world.patients.values()][0]!;
    patient.at = { col: 11, row: 12 };
    const roomId = [...t.world.rooms.keys()][0]!;
    t.queue.push({ type: 'sellRoom', roomId });
    t.apply();
    expect(t.rejections.length).toBe(1);
    expect(t.world.rooms.size).toBe(1);
  });
});
