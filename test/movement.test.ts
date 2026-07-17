import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { BALANCE } from '../src/sim/data/balance';
import type { Patient } from '../src/sim/entities/patient';
import { World } from '../src/sim/world';

function setup() {
  const events = new EventBus();
  const world = new World(events, 7);
  const queue = new CommandQueue();
  const apply = () => world.applyCommands(queue);
  return { world, queue, apply };
}

function spawnAndWalk(t: ReturnType<typeof setup>, col: number, row: number): Patient {
  t.queue.push({ type: 'debugSpawnPatient' });
  t.queue.push({ type: 'debugWalkTo', col, row });
  t.apply();
  return [...t.world.patients.values()][0]!;
}

/** Generous tick budget: distance ÷ tiles-per-tick, doubled. */
function ticksFor(tiles: number): number {
  const perTick = BALANCE.movement.patientTilesPerSecond / BALANCE.time.ticksPerSecond;
  return Math.ceil((tiles / perTick) * 2);
}

describe('movement', () => {
  it('spawns at the entrance with a generated name', () => {
    const t = setup();
    t.queue.push({ type: 'debugSpawnPatient' });
    t.apply();
    const patient = [...t.world.patients.values()][0]!;
    expect(patient.at).toEqual(BALANCE.map.entrance);
    expect(patient.name.full.length).toBeGreaterThan(3);
  });

  it('walks to a target and arrives, then idles', () => {
    const t = setup();
    const patient = spawnAndWalk(t, 20, 30);
    for (let i = 0; i < ticksFor(10); i++) t.world.tick();
    expect(patient.at).toEqual({ col: 20, row: 30 });
    expect(patient.next).toBeNull();
    expect(patient.target).toBeNull();
    expect(patient.progress).toBe(0);
  });

  it('enters a room only through its door', () => {
    const t = setup();
    // Room with door on the south side, target deep inside.
    t.queue.push({
      type: 'buildRoom',
      roomType: 'waiting',
      rect: { col: 18, row: 20, cols: 3, rows: 3 },
      doorOutside: { col: 19, row: 23 },
    });
    t.apply();
    const patient = spawnAndWalk(t, 19, 20); // inside, far corner from door
    // The path must pass through the door edge (19,23)→(19,22).
    const full = [patient.next!, ...patient.path];
    const doorIndex = full.findIndex((p) => p.col === 19 && p.row === 23);
    expect(doorIndex).toBeGreaterThanOrEqual(0);
    expect(full[doorIndex + 1]).toEqual({ col: 19, row: 22 });
    for (let i = 0; i < ticksFor(40); i++) t.world.tick();
    expect(patient.at).toEqual({ col: 19, row: 20 });
  });

  it('reroutes when a room is built across its path', () => {
    const t = setup();
    const patient = spawnAndWalk(t, 20, 10); // straight north of the entrance
    for (let i = 0; i < ticksFor(5); i++) t.world.tick(); // partway there
    // Wall band across most of the map, gap at the east edge (cols 37–39).
    t.queue.push({
      type: 'buildRoom',
      roomType: 'waiting',
      rect: { col: 0, row: 20, cols: 37, rows: 3 },
      doorOutside: { col: 18, row: 23 },
    });
    t.apply();
    expect(t.world.rooms.size).toBe(1);
    expect(patient.target).toEqual({ col: 20, row: 10 }); // still reachable via the gap
    for (let i = 0; i < ticksFor(90); i++) t.world.tick();
    expect(patient.at).toEqual({ col: 20, row: 10 });
  });

  it('clears target immediately when told to walk to its own tile', () => {
    const t = setup();
    const e = BALANCE.map.entrance;
    const patient = spawnAndWalk(t, e.col, e.row);
    expect(patient.target).toBeNull();
    expect(patient.next).toBeNull();
  });

  it('stops after the committed step when a build makes the target unreachable', () => {
    const t = setup();
    const patient = spawnAndWalk(t, 20, 10);
    for (let i = 0; i < ticksFor(4); i++) t.world.tick(); // mid-walk
    expect(patient.next).not.toBeNull();
    // Full-width band seals the north region containing the target.
    t.queue.push({
      type: 'buildRoom',
      roomType: 'waiting',
      rect: { col: 0, row: 15, cols: 40, rows: 3 },
      doorOutside: { col: 20, row: 18 },
    });
    t.apply();
    expect(t.world.rooms.size).toBe(1);
    expect(patient.target).toBeNull(); // Flow rule 8: no-path clears the goal
    for (let i = 0; i < ticksFor(4); i++) t.world.tick(); // finish committed step
    expect(patient.next).toBeNull();
    expect(patient.at.row).toBeGreaterThan(17); // never crossed the band
  });

  it('stops cleanly when the target becomes unreachable', () => {
    const t = setup();
    // Pen the target: a room fully enclosing (0,0) region minus door... simpler:
    // walk to a tile, then make it unwalkable via a bed by building exam over it
    // is invalid (patient check). Instead: target inside a room, then the only
    // door path is fine — so use walkTo INTO a bed tile (unwalkable).
    t.queue.push({
      type: 'buildRoom',
      roomType: 'exam',
      rect: { col: 10, row: 10, cols: 3, rows: 3 },
      doorOutside: { col: 11, row: 13 },
    });
    t.apply();
    // Find a bed tile — unwalkable, so no path exists to it.
    let bed: { col: number; row: number } | null = null;
    for (let col = 10; col < 13 && !bed; col++) {
      for (let row = 10; row < 13 && !bed; row++) {
        if (t.world.tileAt(col, row)!.object === 'bed') bed = { col, row };
      }
    }
    expect(bed).not.toBeNull();
    const patient = spawnAndWalk(t, bed!.col, bed!.row);
    expect(patient.target).toBeNull(); // no-path outcome: never started
    const before = { ...patient.at };
    for (let i = 0; i < 20; i++) t.world.tick();
    expect(patient.at).toEqual(before);
  });
});
