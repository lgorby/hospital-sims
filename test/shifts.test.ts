import { describe, expect, it } from 'vitest';

import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { gameMinutesToTicks } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import { ROLE_DEFS, type RoleId } from '../src/sim/data/roles';
import type { RoomType } from '../src/sim/data/rooms';
import type { Patient } from '../src/sim/entities/patient';
import type { Room } from '../src/sim/entities/room';
import type { ShiftId } from '../src/sim/data/shifts';
import { onShift } from '../src/sim/formulas';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';

/**
 * SHIFTS Stage-1 mechanics (SHIFTS_IMPL_PLAN §B–§C): the per-tick reconciliation,
 * walk-home / off-floor, off-shift exclusion, and gather-cancel at the boundary.
 * Renderer-free and deterministic like every sim suite.
 */

function setup(seed = 1) {
  const events = new EventBus();
  const world = new World(events, seed);
  setupNewGame(world);
  return { world, events };
}

function hireShift(world: World, role: RoleId, shift: ShiftId | null): void {
  const m = world.addStaffMember(role, 3, ROLE_DEFS[role].salaryPerDay, {
    first: 'S', last: role, full: `S ${role}`, short: 'S.',
  });
  m.shift = shift;
}

function build(world: World, type: RoomType, rect: { col: number; row: number; cols: number; rows: number }): Room {
  world.buildRoom(type, rect, { col: rect.col + 1, row: rect.row + rect.rows }, true);
  return [...world.rooms.values()].filter((r) => r.type === type).at(-1)!;
}

function waitingPatient(world: World, condition: Patient['condition'], acuity = 2): Patient {
  const p = world.spawnPatient(condition);
  p.stage = { kind: 'waiting' };
  p.acuity = acuity;
  p.waitingSince = world.clock.tick;
  return p;
}

/** The tick whose minuteOfDay is `minute` (within the current-phase day). */
function tickForMinute(minute: number): number {
  const raw = (minute - BALANCE.time.dayStartMinute + 1440) % 1440;
  return gameMinutesToTicks(raw);
}
const NIGHT_MINUTE = 1320; // 22:00 — deep in the night window, day staff off
const DAY_ROLLOVER_TICK = gameMinutesToTicks(1440); // tick where minuteOfDay wraps to 06:00

describe('onShift — the pure clock gate', () => {
  it('day window [06:00, 18:30) with the two 30-min overlaps', () => {
    expect(onShift('day', 360)).toBe(true); // 06:00 open
    expect(onShift('day', 1109)).toBe(true); // 18:29 last minute
    expect(onShift('day', 1110)).toBe(false); // 18:30 closed
    expect(onShift('day', 359)).toBe(false); // 05:59 before open
  });

  it('night window wraps midnight [18:00, 06:30)', () => {
    expect(onShift('night', 1080)).toBe(true); // 18:00 open
    expect(onShift('night', 0)).toBe(true); // 00:00 (wrap)
    expect(onShift('night', 389)).toBe(true); // 06:29 last minute
    expect(onShift('night', 390)).toBe(false); // 06:30 closed
    expect(onShift('night', 720)).toBe(false); // noon
  });

  it('the two overlaps have BOTH shifts present; null is always on', () => {
    expect(onShift('day', 360) && onShift('night', 360)).toBe(true); // 06:00 overlap
    expect(onShift('day', 1080) && onShift('night', 1080)).toBe(true); // 18:00 overlap
    expect(onShift(null, 720)).toBe(true); // always-on (inert default)
    expect(onShift(null, 0)).toBe(true);
  });
});

describe('walk-home / off-floor lifecycle', () => {
  it('an off-shift staffer walks home (off-floor), frees her tile, and returns on shift', () => {
    const { world } = setup();
    build(world, 'exam', { col: 14, row: 14, cols: 3, rows: 3 });
    hireShift(world, 'doctor', 'day');
    const doc = [...world.staff.values()].find((s) => s.role === 'doctor')!;
    // Position her on an interior tile so walk-home is a real walk, not instant.
    doc.at = { col: 18, row: 20 };
    doc.next = null;
    doc.target = null;

    // Jump to night; tick until she reaches home (bounded — movement is real).
    world.clock.tick = tickForMinute(NIGHT_MINUTE) - 1;
    let guard = 0;
    while (doc.onFloor && guard++ < 3000) world.tick();
    expect(doc.onFloor).toBe(false);
    // Off the map: her tile is no longer claimed and she is not tile-claimed anywhere.
    expect(world.isTileClaimed(doc.at)).toBe(false);

    // Next day rollover (06:00) — she respawns on the floor, idle and available.
    world.clock.tick = DAY_ROLLOVER_TICK - 1;
    world.tick();
    expect(doc.onFloor).toBe(true);
    expect(doc.duty.kind).toBe('idle');
  });

  it('isTileClaimed excludes an off-floor staffer', () => {
    const { world } = setup();
    hireShift(world, 'doctor', 'day');
    const doc = [...world.staff.values()].find((s) => s.role === 'doctor')!;
    doc.at = { col: 12, row: 12 };
    doc.next = null;
    doc.target = null;
    expect(world.isTileClaimed({ col: 12, row: 12 })).toBe(true); // on the floor
    doc.onFloor = false;
    expect(world.isTileClaimed({ col: 12, row: 12 })).toBe(false); // gone home
  });
});

describe('off-shift exclusion — takes no new work', () => {
  it('a night patient is NOT treated by a day-only clinical roster', () => {
    const { world } = setup();
    const exam = build(world, 'exam', { col: 14, row: 14, cols: 3, rows: 3 });
    hireShift(world, 'doctor', 'day');
    // Deep night: the day doctor is off-shift (and walks home).
    world.clock.tick = tickForMinute(NIGHT_MINUTE) - 1;
    const p = waitingPatient(world, 'flu', 2);
    for (let i = 0; i < 600; i++) world.tick();
    // No reservation formed on the exam room, and the patient never got treated.
    expect(world.reservationsOn(exam.id)).toHaveLength(0);
    expect(p.stage.kind).toBe('waiting');
  });
});

describe('night reception stall', () => {
  it('a day-shift receptionist cannot check patients in at night', () => {
    const { world } = setup();
    const recept = [...world.staff.values()].find((s) => s.role === 'receptionist')!;
    recept.shift = 'day';
    world.clock.tick = tickForMinute(NIGHT_MINUTE) - 1;
    const p = world.spawnPatient('flu'); // arrives at reception, checkingIn
    for (let i = 0; i < 600; i++) world.tick();
    // The receptionist walked home; no one checks the patient in — the patient
    // sits in the check-in queue and never reaches `waiting`.
    expect(recept.onFloor).toBe(false);
    expect(p.stage.kind).toBe('queuedCheckIn');
    expect(p.stage.kind).not.toBe('waiting');
  });
});

describe('hire + setStaffShift commands (through the queue)', () => {
  it('the setup receptionist works the day shift (new game opens day-staffed)', () => {
    const { world } = setup();
    const recept = [...world.staff.values()].find((s) => s.role === 'receptionist')!;
    expect(recept.shift).toBe('day');
  });

  it('hireStaff assigns the CHOSEN shift; addStaffMember stays null-shift', () => {
    const { world } = setup();
    const queue = new CommandQueue();
    const cand = world.candidates.find((c) => c.role === 'nurse')!;
    world.cash += 1000;
    queue.push({ type: 'hireStaff', candidateId: cand.id, shift: 'night' });
    world.applyCommands(queue);
    const hired = [...world.staff.values()].find((s) => s.role === 'nurse')!;
    expect(hired.shift).toBe('night');
    // A directly-added staffer (test path) stays always-on.
    expect(world.addStaffMember('doctor', 3, 100).shift).toBeNull();
  });

  it('setStaffShift rebalances an existing staffer; a missing id is a no-op', () => {
    const { world } = setup();
    const queue = new CommandQueue();
    const recept = [...world.staff.values()].find((s) => s.role === 'receptionist')!;
    queue.push({ type: 'setStaffShift', staffId: recept.id, shift: 'night' });
    queue.push({ type: 'setStaffShift', staffId: 999999, shift: 'day' }); // no such staffer
    expect(() => world.applyCommands(queue)).not.toThrow();
    expect(recept.shift).toBe('night');
  });
});

describe('gather-cancel and active-bay survival at the boundary', () => {
  it('a GATHERING bay is cancelled when its staffer goes off-shift; the patient re-queues', () => {
    const { world } = setup();
    const exam = build(world, 'exam', { col: 14, row: 14, cols: 3, rows: 3 });
    hireShift(world, 'doctor', 'day');
    const p = waitingPatient(world, 'flu', 2);
    // Day: let a gathering reservation form (patient walking to the room).
    let guard = 0;
    while (!world.reservationsOn(exam.id).some((r) => r.phase === 'gathering') && guard++ < 500) {
      world.tick();
    }
    expect(world.reservationsOn(exam.id).some((r) => r.phase === 'gathering')).toBe(true);

    // Cross into night — the gather is cancelled, the patient re-queues.
    world.clock.tick = tickForMinute(NIGHT_MINUTE) - 1;
    world.tick();
    expect(world.reservationsOn(exam.id).some((r) => r.phase === 'gathering')).toBe(false);
    expect(p.stage.kind).toBe('waiting');
  });

  it('an ACTIVE bay is NOT cancelled at the boundary — the staffer finishes it (anti-capture)', () => {
    const { world } = setup();
    const exam = build(world, 'exam', { col: 14, row: 14, cols: 3, rows: 3 });
    hireShift(world, 'doctor', 'day');
    const doc = [...world.staff.values()].find((s) => s.role === 'doctor')!;
    waitingPatient(world, 'flu', 2);
    // Day: drive the bay to ACTIVE (patient + doctor both in the room).
    let guard = 0;
    while (!world.reservationsOn(exam.id).some((r) => r.phase === 'active') && guard++ < 2000) {
      world.tick();
    }
    expect(world.reservationsOn(exam.id).some((r) => r.phase === 'active')).toBe(true);

    // Cross into night — the active bay survives and the doctor stays on the floor
    // (busy), not yanked mid-treatment.
    world.clock.tick = tickForMinute(NIGHT_MINUTE) - 1;
    world.tick();
    expect(world.reservationsOn(exam.id).some((r) => r.phase === 'active')).toBe(true);
    expect(doc.onFloor).toBe(true);
  });
});
