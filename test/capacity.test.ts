import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { ROLE_DEFS, type RoleId } from '../src/sim/data/roles';
import { PROP_STYLE, ROOM_DEFS } from '../src/sim/data/rooms';
import type { Patient } from '../src/sim/entities/patient';
import { propTargetCount } from '../src/sim/formulas';
import { setupNewGame } from '../src/sim/newGame';
import { loadWorld, saveToString, SAVE_VERSION } from '../src/sim/save';
import { samePoint } from '../src/sim/types';
import { World } from '../src/sim/world';

/**
 * Capacity epic Stage A (CAPACITY_PLAN §3): props ARE the capacity. Beds/
 * machines/chairs scale with the footprint; each slot serves a concurrent
 * reservation with its own staff; waiting-room seats are the placed chairs.
 */

function setup(seed = 42) {
  const events = new EventBus();
  const world = new World(events, seed);
  setupNewGame(world);
  const queue = new CommandQueue();
  return { world, events, queue, apply: () => world.applyCommands(queue) };
}

function hire(world: World, role: RoleId, n = 1): void {
  for (let i = 0; i < n; i++) {
    world.addStaffMember(role, 3, ROLE_DEFS[role].salaryPerDay, {
      first: `T${i}`,
      last: role,
      full: `T${i} ${role}`,
      short: `T${i}.`,
    });
  }
}

/** Park every staff member at their target instantly (fixture: skip walking). */
function teleportStaff(world: World): void {
  for (const s of world.staff.values()) {
    if (s.target) {
      s.at = s.target;
      s.next = null;
      s.path = [];
    }
  }
}

function waitingPatient(world: World, condition: Patient['condition'], acuity = 2): Patient {
  const p = world.spawnPatient(condition);
  p.stage = { kind: 'waiting' };
  p.acuity = acuity;
  p.waitingSince = world.clock.tick;
  return p;
}

// Free-build helper: door on the south edge's middle.
function build(world: World, type: keyof typeof ROOM_DEFS, rect: { col: number; row: number; cols: number; rows: number }): void {
  world.buildRoom(type, rect, { col: rect.col + 1, row: rect.row + rect.rows }, true);
}

describe('density-driven prop placement (§3.2)', () => {
  it('min-size rooms derive exactly their pre-epic counts (the harness rule)', () => {
    const min = (t: keyof typeof ROOM_DEFS) => ({
      col: 0,
      row: 0,
      cols: ROOM_DEFS[t].minCols,
      rows: ROOM_DEFS[t].minRows,
    });
    expect(propTargetCount(ROOM_DEFS.waiting.props[0]!.density, min('waiting'))).toBe(6);
    expect(propTargetCount(ROOM_DEFS.dialysis.props[0]!.density, min('dialysis'))).toBe(2);
    expect(propTargetCount(ROOM_DEFS.exam.props[0]!.density, min('exam'))).toBe(1);
  });

  it('the ER is the DELIBERATE exception to the pre-epic-count rule (ED Stage B1)', () => {
    // CAPACITY_PLAN §3.2's rule — a min-size room derives exactly its pre-epic
    // count — held for every room until ED_PLAN Stage B1, which halves the ER's
    // density (12 → 6 tiles/bed) so a minimum 3×4 derives TWO bays. That is the
    // answer to Stage A's death signal: at λ≈0.54/h and ~63 min mean occupancy,
    // 1 bay queues ~53 min (a 120-min stroke freezes the department) and 2 bays
    // ~9 min. It is a CONTRACT CHANGE, not a re-pin — hence its own test.
    const min = { col: 0, row: 0, cols: ROOM_DEFS.er.minCols, rows: ROOM_DEFS.er.minRows };
    expect(propTargetCount(ROOM_DEFS.er.props[0]!.density, min)).toBe(2);
    // Existing SAVED rooms are unaffected: capacity derives from PLACED prop
    // tiles in the grid, not from the density rule (see the v9 save fixture).
  });

  it('a grown ER derives more beds; fixed props stay fixed', () => {
    // 4×6 = 24 tiles at 1 bed / 6 tiles → 4 beds (Stage B1 density).
    const rect = { col: 0, row: 0, cols: 4, rows: 6 };
    expect(propTargetCount(ROOM_DEFS.er.props[0]!.density, rect)).toBe(4);
    expect(propTargetCount(ROOM_DEFS.exam.props[0]!.density, rect)).toBe(1);
  });

  it('a built grown ER actually places 4 bed strips; slotOrigins sees them all', () => {
    const { world } = setup();
    build(world, 'er', { col: 20, row: 20, cols: 4, rows: 6 });
    const room = [...world.rooms.values()].find((r) => r.type === 'er')!;
    const origins = world.slotOrigins(room);
    expect(origins).toHaveLength(4);
    expect(world.capacityOf(room)).toBe(4);
    // Strip consumption: each origin is the WEST end of a 2-tile strip.
    for (const origin of origins) {
      expect(world.tileAt(origin.col, origin.row)!.object).toBe('traumaBed');
      expect(world.tileAt(origin.col + 1, origin.row)!.object).toBe('traumaBed');
    }
  });
});

describe('multi-slot dispatch (§3.3)', () => {
  it('RATIFIED retro jump: a MIN-SIZE dialysis room treats 2 patients concurrently', () => {
    const { world } = setup();
    build(world, 'dialysis', { col: 20, row: 20, cols: 3, rows: 4 });
    hire(world, 'nurse', 2);
    waitingPatient(world, 'kidneyFailure');
    waitingPatient(world, 'kidneyFailure');
    world.tick();
    const room = [...world.rooms.values()].find((r) => r.type === 'dialysis')!;
    const reservations = world.reservationsOn(room.id);
    expect(reservations).toHaveLength(2);
    expect(new Set(reservations.map((r) => r.slotIndex))).toEqual(new Set([0, 1]));
    expect(world.openSlots(room)).toBe(0);
  });

  it('a FULLY staffed multi-bed ER gives each bay its OWN pair (idle-first, ED B1)', () => {
    const { world } = setup();
    build(world, 'er', { col: 20, row: 20, cols: 4, rows: 6 });
    hire(world, 'doctor', 2);
    hire(world, 'nurse', 2);
    waitingPatient(world, 'chestPain', 1);
    waitingPatient(world, 'chestPain', 1);
    world.tick();
    const room = [...world.rooms.values()].find((r) => r.type === 'er')!;
    const reservations = world.reservationsOn(room.id);
    expect(reservations).toHaveLength(2);
    // ED_PLAN Stage B1: `availableStaff` is IDLE-FIRST. A hired staffer's
    // salary is already spent, so overloading one while a colleague stands
    // idle is pure loss — the 3-arm probe measured the load-forward
    // alternative at +1.8 deaths and -23% surgeries against density alone.
    // With staff to spare the ED behaves exactly as it did pre-B1; the ratio
    // is GRACEFUL DEGRADATION for the short-staffed case (next test).
    const staffUsed = new Set(reservations.flatMap((r) => r.staffIds));
    expect(staffUsed.size).toBe(4);
    // Distinct anchors: the two patients walk to DIFFERENT bedside tiles.
    const targets = reservations.map(
      (r) => world.patients.get(r.patientId)!.target ?? world.patients.get(r.patientId)!.at,
    );
    expect(samePoint(targets[0]!, targets[1]!)).toBe(false);
  });

  it('a SHORT-staffed multi-bed ER shares one pair across bays — the ratio (ED B1)', () => {
    const { world } = setup();
    build(world, 'er', { col: 20, row: 20, cols: 4, rows: 6 });
    hire(world, 'doctor', 1);
    hire(world, 'nurse', 1);
    waitingPatient(world, 'chestPain', 1);
    waitingPatient(world, 'chestPain', 1);
    world.tick();
    const room = [...world.rooms.values()].find((r) => r.type === 'er')!;
    const reservations = world.reservationsOn(room.id);
    // The point of ratio staffing: with nobody left to pull, the second bay
    // still runs on the pair already there instead of standing empty. Pre-B1
    // this was ONE reservation and an idle bay.
    expect(reservations).toHaveLength(2);
    const staffUsed = new Set(reservations.flatMap((r) => r.staffIds));
    expect(staffUsed.size).toBe(2);
    for (const id of staffUsed) expect(world.staffLoadIn(id, room.id)).toBe(2);
  });

  it('a single-capacity room still never double-books', () => {
    const { world } = setup();
    build(world, 'exam', { col: 20, row: 20, cols: 5, rows: 5 }); // big but single
    hire(world, 'doctor', 2);
    waitingPatient(world, 'flu', 4);
    waitingPatient(world, 'flu', 4);
    world.tick();
    const room = [...world.rooms.values()].find((r) => r.type === 'exam')!;
    expect(world.capacityOf(room)).toBe(1);
    expect(world.reservationsOn(room.id)).toHaveLength(1);
  });

  it('a released slot is reused: cancel frees the exact slotIndex', () => {
    const { world } = setup();
    build(world, 'dialysis', { col: 20, row: 20, cols: 3, rows: 4 });
    hire(world, 'nurse', 2);
    waitingPatient(world, 'kidneyFailure');
    waitingPatient(world, 'kidneyFailure');
    world.tick();
    const room = [...world.rooms.values()].find((r) => r.type === 'dialysis')!;
    const first = world.reservationsOn(room.id).find((r) => r.slotIndex === 0)!;
    world.cancelReservation(first);
    expect(world.openSlots(room)).toBe(1);
    expect(world.freeSlotIndex(room)).toBe(0); // the freed slot, not 2
  });

  it('bedside anchors sit adjacent to the reservation\'s own bed strip', () => {
    const { world } = setup();
    build(world, 'er', { col: 20, row: 20, cols: 4, rows: 6 });
    hire(world, 'doctor', 2);
    hire(world, 'nurse', 2);
    waitingPatient(world, 'chestPain', 1);
    waitingPatient(world, 'chestPain', 1);
    world.tick();
    const room = [...world.rooms.values()].find((r) => r.type === 'er')!;
    const origins = world.slotOrigins(room);
    for (const r of world.reservationsOn(room.id)) {
      const target = world.patients.get(r.patientId)!.target!;
      const origin = origins[r.slotIndex]!;
      const stripTiles = [origin, { col: origin.col + 1, row: origin.row }];
      const adjacent = stripTiles.some(
        (t) => Math.abs(t.col - target.col) + Math.abs(t.row - target.row) === 1,
      );
      expect(adjacent, `slot ${r.slotIndex} anchor beside its strip`).toBe(true);
    }
  });
});

describe('concurrency seams (Stage A review MINOR 4)', () => {
  function twoActiveDialysis() {
    const t = setup();
    build(t.world, 'dialysis', { col: 20, row: 20, cols: 3, rows: 4 });
    hire(t.world, 'nurse', 2);
    waitingPatient(t.world, 'kidneyFailure');
    waitingPatient(t.world, 'kidneyFailure');
    t.world.tick(); // dispatch both
    const room = [...t.world.rooms.values()].find((r) => r.type === 'dialysis')!;
    // Walk everyone in by ticking (movement is real); bounded guard.
    let guard = 0;
    while (
      t.world.reservationsOn(room.id).some((r) => r.phase === 'gathering') &&
      guard++ < 5000
    ) {
      t.world.tick();
    }
    return { ...t, room };
  }

  it('two ACTIVE treatments in one room: one completing leaves the sibling intact', () => {
    const { world, room } = twoActiveDialysis();
    const reservations = world.reservationsOn(room.id);
    expect(reservations).toHaveLength(2);
    expect(reservations.every((r) => r.phase === 'active')).toBe(true);
    // Let the FIRST finish (dialysis is a long step; force its timer down —
    // fixture write on ticksRemaining only, phases stay real).
    const [first, second] = reservations;
    first!.ticksRemaining = 1;
    const siblingTicksBefore = second!.ticksRemaining;
    world.tick();
    // First released; sibling untouched and still active on its own slot.
    expect(world.reservations.has(first!.id)).toBe(false);
    expect(world.reservations.has(second!.id)).toBe(true);
    expect(second!.phase).toBe('active');
    expect(second!.ticksRemaining).toBe(siblingTicksBefore - 1);
    expect(world.openSlots(room)).toBe(1);
    expect(world.stageViolations).toEqual([]);
  });

  it('a rule-8 STALL cancel of one sibling leaves the other gathering undisturbed', () => {
    const t = setup();
    build(t.world, 'dialysis', { col: 20, row: 20, cols: 3, rows: 4 });
    hire(t.world, 'nurse', 2);
    waitingPatient(t.world, 'kidneyFailure');
    waitingPatient(t.world, 'kidneyFailure');
    t.world.tick();
    const room = [...t.world.rooms.values()].find((r) => r.type === 'dialysis')!;
    const [a, b] = t.world.reservationsOn(room.id);
    expect(a && b).toBeTruthy();
    // Stall reservation A's patient: ARRIVED (walkerArrived = no committed
    // step AND no pending goal → next/target null) but outside the room —
    // exactly the rule-8 shape promoteGatheredReservations must cancel.
    const stalled = t.world.patients.get(a!.patientId)!;
    stalled.at = { col: 5, row: 5 };
    stalled.next = null;
    stalled.path = [];
    stalled.target = null;
    t.world.tick();
    expect(t.world.reservations.has(a!.id)).toBe(false); // cancelled (rule 8)
    expect(t.world.reservations.has(b!.id)).toBe(true); // sibling untouched
    expect(t.world.openSlots(room)).toBe(1);
    expect(t.world.stageViolations).toEqual([]);
  });
});

describe('waiting-room seats = placed chairs (§3.3)', () => {
  it('a big waiting room seats MORE than the old constant 6', () => {
    const { world } = setup();
    build(world, 'waiting', { col: 20, row: 20, cols: 4, rows: 5 }); // 20 tiles → 13 target
    const room = [...world.rooms.values()].filter((r) => r.type === 'waiting').at(-1)!;
    expect(world.capacityOf(room)).toBeGreaterThan(6);
  });

  it('the 7th patient SITS in a big room (was: forced to stand at 6)', () => {
    const { world } = setup();
    // Replace the min-size starter waiting room with a big one far away.
    build(world, 'waiting', { col: 20, row: 20, cols: 4, rows: 5 });
    const big = [...world.rooms.values()].filter((r) => r.type === 'waiting').at(-1)!;
    const seatsAvailable = world.capacityOf(big);
    let seatedInBig = 0;
    for (let i = 0; i < 6 + 1; i++) {
      const p = world.spawnPatient('flu');
      p.stage = { kind: 'waitingTriage' };
      world.assignWaitingSpot(p);
      if (p.waitingRoomId === big.id) seatedInBig += 1;
    }
    // The starter room seats 6; with the big room present, EVERYONE seats
    // somewhere (7 ≤ 6 + seatsAvailable) — nobody stands.
    const standing = [...world.patients.values()].filter((p) => p.waitingRoomId === null).length;
    expect(seatsAvailable).toBeGreaterThan(6);
    expect(standing).toBe(0);
    expect(seatedInBig).toBeGreaterThan(0);
  });

  it('every seated patient above the old 6-cap gets a REAL distinct chair tile', () => {
    const { world } = setup();
    build(world, 'waiting', { col: 20, row: 20, cols: 4, rows: 5 });
    const big = [...world.rooms.values()].filter((r) => r.type === 'waiting').at(-1)!;
    const seats = world.capacityOf(big);
    expect(seats).toBeGreaterThan(6);
    const targets: string[] = [];
    for (let i = 0; i < seats; i++) {
      const p = world.spawnPatient('flu');
      p.stage = { kind: 'waitingTriage' };
      // Force everyone into the BIG room's seats (fixture: bypass the starter
      // room by filling waitingRoomId directly through assignWaitingSpot's
      // pick — the starter fills first; keep spawning until big fills).
      world.assignWaitingSpot(p);
      if (p.waitingRoomId === big.id) {
        const t = p.target!;
        expect(world.tileAt(t.col, t.row)!.object).toBe('chair');
        targets.push(`${t.col},${t.row}`);
      }
    }
    // Distinct chairs — no two seated patients share a tile (rule 14).
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets.length).toBeGreaterThan(0);
  });
});

describe('save v3 (§5)', () => {
  function concurrentWorld() {
    const { world, events } = setup();
    build(world, 'dialysis', { col: 20, row: 20, cols: 3, rows: 4 });
    hire(world, 'nurse', 2);
    waitingPatient(world, 'kidneyFailure');
    waitingPatient(world, 'kidneyFailure');
    world.tick();
    teleportStaff(world);
    return { world, events };
  }

  it('two concurrent reservations round-trip with their slotIndices intact', () => {
    const { world } = concurrentWorld();
    const result = loadWorld(new EventBus(), saveToString(world));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const room = [...result.world.rooms.values()].find((r) => r.type === 'dialysis')!;
    const slots = result.world
      .reservationsOn(room.id)
      .map((r) => r.slotIndex)
      .sort();
    expect(slots).toEqual([0, 1]);
    expect(JSON.parse(saveToString(world)).saveVersion).toBe(SAVE_VERSION);
  });

  it('a pre-v3 save (no slotIndex) migrates to slot 0', () => {
    const { world } = setup();
    build(world, 'exam', { col: 20, row: 20, cols: 3, rows: 3 });
    hire(world, 'doctor');
    waitingPatient(world, 'flu', 4);
    world.tick();
    expect(world.reservations.size).toBe(1);
    const payload = JSON.parse(saveToString(world));
    payload.saveVersion = 2;
    for (const r of payload.reservations) delete r.slotIndex;
    const result = loadWorld(new EventBus(), JSON.stringify(payload));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.world.reservations.values()][0]!.slotIndex).toBe(0);
  });

  it('border: a v3 slotIndex beyond the room\'s grid-derived capacity is refused', () => {
    const { world } = concurrentWorld();
    const payload = JSON.parse(saveToString(world));
    payload.reservations[0].slotIndex = 5; // dialysis min = 2 machines
    const result = loadWorld(new EventBus(), JSON.stringify(payload));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('slot');
  });

  it('border: two reservations holding the SAME slot of one room are refused', () => {
    const { world } = concurrentWorld();
    const payload = JSON.parse(saveToString(world));
    payload.reservations[1].slotIndex = payload.reservations[0].slotIndex;
    const result = loadWorld(new EventBus(), JSON.stringify(payload));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('slot');
  });

  it('border: a negative slotIndex is refused', () => {
    const { world } = concurrentWorld();
    const payload = JSON.parse(saveToString(world));
    payload.reservations[0].slotIndex = -1;
    const result = loadWorld(new EventBus(), JSON.stringify(payload));
    expect(result.ok).toBe(false);
  });
});

describe('inspect readout source (capacityOf is the one SSOT)', () => {
  it('PROP_STYLE strip math holds: capacity = prop tiles / strip length', () => {
    const { world } = setup();
    build(world, 'er', { col: 20, row: 20, cols: 4, rows: 6 });
    const room = [...world.rooms.values()].find((r) => r.type === 'er')!;
    let bedTiles = 0;
    for (let col = room.rect.col; col < room.rect.col + room.rect.cols; col++) {
      for (let row = room.rect.row; row < room.rect.row + room.rect.rows; row++) {
        if (world.tileAt(col, row)!.object === 'traumaBed') bedTiles += 1;
      }
    }
    expect(world.capacityOf(room)).toBe(bedTiles / PROP_STYLE.traumaBed.tiles);
  });
});
