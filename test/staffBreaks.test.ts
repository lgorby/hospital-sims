import { describe, expect, it } from 'vitest';

import { EventBus } from '../src/events';
import { gameMinutesToTicks } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import { ROLE_DEFS, type RoleId } from '../src/sim/data/roles';
import type { RoomType } from '../src/sim/data/rooms';
import type { ShiftId } from '../src/sim/data/shifts';
import type { Patient } from '../src/sim/entities/patient';
import type { Room } from '../src/sim/entities/room';
import type { Staff } from '../src/sim/entities/staff';
import { validateRoomExpand, validateRoomSell } from '../src/sim/build';
import { loadWorld, saveToString } from '../src/sim/save';
import { updateShifts } from '../src/sim/systems/shifts';
import { updateStaffBreaks } from '../src/sim/systems/staffBreaks';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';

/**
 * SHIFTS Stage 2 (SHIFTS_STAGE2_CONTRACT §9) — the mid-shift lunch + staff
 * lounge. Renderer-free and deterministic like every sim suite.
 */

function setup(seed = 1) {
  const world = new World(new EventBus(), seed);
  setupNewGame(world);
  return world;
}

function hireShift(world: World, role: RoleId, shift: ShiftId | null): Staff {
  const m = world.addStaffMember(role, 3, ROLE_DEFS[role].salaryPerDay, {
    first: 'S', last: role, full: `S ${role}`, short: 'S.',
  });
  m.shift = shift;
  return m;
}

function build(
  world: World,
  type: RoomType,
  rect: { col: number; row: number; cols: number; rows: number },
): Room {
  world.buildRoom(type, rect, { col: rect.col + 1, row: rect.row + rect.rows }, true);
  return [...world.rooms.values()].filter((r) => r.type === type).at(-1)!;
}

/** A lounge in the open centre, reachable from the mid-map staff spots below. */
function buildLounge(world: World): Room {
  return build(world, 'lounge', { col: 16, row: 14, cols: 3, rows: 3 });
}

/** Place a staffer idle on the floor at a mid-map tile (reachable to the lounge). */
function placeIdle(s: Staff, col: number, row: number): void {
  s.at = { col, row };
  s.next = null;
  s.target = null;
  s.path = [];
  s.duty = { kind: 'idle' };
}

function waitingPatient(world: World, condition: Patient['condition'], acuity = 2): Patient {
  const p = world.spawnPatient(condition);
  p.stage = { kind: 'waitingTriage' };
  p.acuity = acuity;
  p.waitingSince = world.clock.tick;
  return p;
}

/** The tick whose minuteOfDay is `minute` (within the current-phase day). */
function tickForMinute(minute: number): number {
  const raw = (minute - BALANCE.time.dayStartMinute + 1440) % 1440;
  return gameMinutesToTicks(raw);
}

// The DAY lunch window (§3.2): open = shiftStart(360) + 240 = 600 (10:00),
// close = 600 + span(300) = 900 (15:00).
const DAY_WINDOW_OPEN = 600;
const DAY_MID = 720; // noon — inside every day-shift lunch window's span

// ------------------------------------------------------------- stagger + cap

describe('the coverage cap — "never all at once"', () => {
  it('max concurrent same-role on-break stays ≤ headcount − minSameRoleOnFloor', () => {
    const world = setup();
    buildLounge(world);
    const roster = [0, 1, 2].map(() => hireShift(world, 'nurse', 'day'));
    roster.forEach((s, i) => placeIdle(s, 18 + i, 20));

    let maxConcurrent = 0;
    world.clock.tick = tickForMinute(DAY_WINDOW_OPEN) - 1;
    for (let i = 0; i < 1800; i++) {
      world.tick();
      const onBreak = roster.filter((s) => s.onBreak !== null).length;
      maxConcurrent = Math.max(maxConcurrent, onBreak);
    }
    // 3 nurses, floor of 1 → at most 2 on break at once.
    expect(maxConcurrent).toBeLessThanOrEqual(3 - BALANCE.shifts.lunch.minSameRoleOnFloor);
    // Non-vacuous: at least one nurse actually lunched.
    expect(roster.some((s) => s.lunchedThisShift)).toBe(true);
  });

  it('a solo-of-a-role never lunches (the cap blocks the last one)', () => {
    const world = setup();
    buildLounge(world);
    const nurse = hireShift(world, 'nurse', 'day');
    placeIdle(nurse, 18, 20);
    world.clock.tick = tickForMinute(DAY_WINDOW_OPEN) - 1;
    for (let i = 0; i < 1800; i++) world.tick();
    expect(nurse.onBreak).toBeNull();
    expect(nurse.lunchedThisShift).toBe(false);
  });
});

// ------------------------------------------------------------- lounge vs off-floor

describe('lounge lunch vs off-floor lunch', () => {
  function driveOneLunch(world: World, roster: Staff[], want: 'lounge' | 'offFloor'): Staff {
    world.clock.tick = tickForMinute(DAY_MID) - 1;
    let luncher: Staff | undefined;
    for (let i = 0; i < 2500 && !luncher; i++) {
      world.tick();
      luncher = roster.find((s) => s.onBreak?.mode === want && s.onBreak.phase === 'using');
    }
    expect(luncher, `a staffer reached a ${want} lunch`).toBeTruthy();
    return luncher!;
  }

  it('a staffer walks to a lounge seat, occupies it, then releases it', () => {
    const world = setup();
    const lounge = buildLounge(world);
    const roster = [0, 1].map(() => hireShift(world, 'nurse', 'day'));
    roster.forEach((s, i) => placeIdle(s, 18 + i, 20));

    const luncher = driveOneLunch(world, roster, 'lounge');
    const slot = luncher.onBreak!.slot!;
    expect(world.loungeSeatClaims(lounge.id).get(slot)).toBe(luncher.id); // seat held
    expect(luncher.onFloor).toBe(true); // on-site, still on the floor

    for (let i = 0; i < 400 && luncher.onBreak !== null; i++) world.tick();
    expect(luncher.onBreak).toBeNull(); // lunch ended
    expect(world.loungeSeatClaims(lounge.id).size).toBe(0); // seat freed
    expect(luncher.lunchedThisShift).toBe(true);
    expect(luncher.duty.kind).toBe('idle'); // back in the pool
  });

  it('with NO lounge, a staffer leaves the floor to eat, then returns on the floor', () => {
    const world = setup(); // no lounge built
    const roster = [0, 1].map(() => hireShift(world, 'nurse', 'day'));
    roster.forEach((s, i) => placeIdle(s, 18 + i, 20));

    const luncher = driveOneLunch(world, roster, 'offFloor');
    expect(luncher.onFloor).toBe(false); // off-map while eating
    expect(world.isTileClaimed(luncher.at)).toBe(false); // frees no tile

    for (let i = 0; i < 500 && luncher.onBreak !== null; i++) world.tick();
    expect(luncher.onBreak).toBeNull();
    expect(luncher.onFloor).toBe(true); // back on the floor (placeAtEntrance)
    expect(luncher.lunchedThisShift).toBe(true);
  });

  it('a completed lunch does NOT re-arm — at most one lunch per shift', () => {
    const world = setup();
    const roster = [0, 1].map(() => hireShift(world, 'nurse', 'day'));
    roster.forEach((s, i) => placeIdle(s, 18 + i, 20));

    const luncher = driveOneLunch(world, roster, 'offFloor');
    for (let i = 0; i < 500 && luncher.onBreak !== null; i++) world.tick();
    expect(luncher.lunchedThisShift).toBe(true);

    // Keep running through the rest of the day window — she never lunches again.
    let secondLunch = false;
    for (let i = 0; i < 1500; i++) {
      world.tick();
      if (luncher.onBreak !== null) secondLunch = true;
    }
    expect(secondLunch).toBe(false);
  });
});

// ------------------------------------------------------------- anti-capture

describe('anti-capture — a staffer with live work does not lunch', () => {
  it('a nurse holding a reservation (gathering/active) never starts a lunch', () => {
    const world = setup();
    build(world, 'triage', { col: 14, row: 14, cols: 2, rows: 2 });
    buildLounge(world);
    const roster = [0, 1].map(() => hireShift(world, 'nurse', 'day'));
    roster.forEach((s, i) => placeIdle(s, 18 + i, 20));
    world.clock.tick = tickForMinute(DAY_MID) - 1;
    waitingPatient(world, 'flu', 2);

    // Drive until a nurse is bound to a reservation (gathering, then active).
    let guard = 0;
    while (!roster.some((s) => s.duty.kind === 'reserved') && guard++ < 800) world.tick();
    const reserved = roster.find((s) => s.duty.kind === 'reserved')!;
    expect(reserved.duty.kind).toBe('reserved'); // premise

    // While she holds the reservation she must never go on break (the strand fix).
    for (let i = 0; i < 60; i++) {
      world.tick();
      if (reserved.duty.kind === 'reserved') expect(reserved.onBreak).toBeNull();
    }
  });
});

// ------------------------------------------------------------- pool exclusion

describe('dispatch-pool exclusion', () => {
  it('an on-break staffer is not dispatched; an available colleague is', () => {
    const world = setup();
    build(world, 'triage', { col: 14, row: 14, cols: 2, rows: 2 });
    const lounge = buildLounge(world);
    const [onBreakNurse, freeNurse] = [0, 1].map(() => hireShift(world, 'nurse', 'day'));
    placeIdle(freeNurse!, 15, 18);
    // Park onBreakNurse mid-lunch in the lounge (using, long timer).
    onBreakNurse!.at = { col: 17, row: 15 };
    onBreakNurse!.onBreak = {
      mode: 'lounge', roomId: lounge.id, slot: 0, phase: 'using', ticksRemaining: 1000, startedAt: 0,
    };
    onBreakNurse!.lunchedThisShift = true;

    world.clock.tick = tickForMinute(DAY_MID) - 1;
    waitingPatient(world, 'flu', 2);
    for (let i = 0; i < 60; i++) world.tick();

    expect(onBreakNurse!.onBreak).not.toBeNull(); // still on lunch
    expect(onBreakNurse!.duty.kind).not.toBe('reserved'); // never dispatched
    expect(freeNurse!.duty.kind).toBe('reserved'); // the available one took it
  });
});

// ------------------------------------------------------------- shift boundary

describe('shift-boundary interaction', () => {
  it('the boundary cancels an in-flight lunch — she goes home, not back to the floor', () => {
    const world = setup();
    const lounge = buildLounge(world);
    const roster = [0, 1].map(() => hireShift(world, 'nurse', 'day'));
    roster.forEach((s, i) => placeIdle(s, 18 + i, 20));
    // Get one nurse onto a lounge lunch.
    world.clock.tick = tickForMinute(DAY_MID) - 1;
    let luncher: Staff | undefined;
    for (let i = 0; i < 2500 && !luncher; i++) {
      world.tick();
      luncher = roster.find((s) => s.onBreak?.mode === 'lounge' && s.onBreak.phase === 'using');
    }
    expect(luncher).toBeTruthy();

    // Cross into night: the lunch is cancelled, the seat frees, she heads home.
    world.clock.tick = tickForMinute(1320) - 1; // 22:00
    world.tick();
    expect(luncher!.onBreak).toBeNull();
    expect(world.loungeSeatClaims(lounge.id).size).toBe(0);
    let guard = 0;
    while (luncher!.onFloor && guard++ < 3000) world.tick();
    expect(luncher!.onFloor).toBe(false); // walked home, did not return to duty
  });

  it('updateShifts does NOT snap an off-floor luncher back to the floor (respawn gate)', () => {
    const world = setup();
    const nurse = hireShift(world, 'nurse', 'day');
    // An off-floor OFF-FLOOR lunch, on-shift (mid-day): onFloor false, onBreak set.
    world.clock.tick = tickForMinute(DAY_MID) - 1;
    nurse.onFloor = false;
    nurse.onBreak = { mode: 'offFloor', phase: 'using', ticksRemaining: 500, startedAt: 0 };
    updateShifts(world);
    expect(nurse.onFloor).toBe(false); // NOT respawned
    expect(nurse.onBreak).not.toBeNull();
  });

  it('lunchedThisShift resets when a staffer comes back on shift', () => {
    const world = setup();
    const nurse = hireShift(world, 'nurse', 'day');
    nurse.lunchedThisShift = true;
    nurse.onFloor = false; // home, waiting for her shift
    nurse.onBreak = null;
    world.clock.tick = tickForMinute(DAY_MID) - 1; // her day shift is on
    updateShifts(world); // respawns her
    expect(nurse.onFloor).toBe(true);
    expect(nurse.lunchedThisShift).toBe(false); // a new shift re-enables lunch
  });
});

// ------------------------------------------------------------- watchdog

describe('watchdog', () => {
  it('a walk that never arrives is aborted (no stuck staffer)', () => {
    const world = setup();
    const lounge = buildLounge(world);
    const nurse = hireShift(world, 'nurse', 'day');
    placeIdle(nurse, 18, 20);
    world.clock.tick = 10_000;
    const watchdog = gameMinutesToTicks(BALANCE.shifts.lunch.breakWatchdogGameMinutes);
    nurse.onBreak = {
      mode: 'lounge', roomId: lounge.id, slot: 0, phase: 'walking',
      ticksRemaining: 0, startedAt: world.clock.tick - watchdog - 1,
    };
    nurse.lunchedThisShift = true;
    updateStaffBreaks(world);
    expect(nurse.onBreak).toBeNull(); // aborted
    expect(nurse.duty.kind).toBe('idle'); // returned to duty, not wedged
    expect(nurse.lunchedThisShift).toBe(true); // abort CONSUMES the lunch (§3.5) — no re-arm thrash
  });
});

// ------------------------------------------------------------- coverage cap edge

describe('coverage cap edge cases', () => {
  it('a firing colleague does not count as coverage (never break the last real one)', () => {
    const world = setup();
    buildLounge(world);
    const roster = [0, 1].map(() => hireShift(world, 'nurse', 'day'));
    roster.forEach((s, i) => placeIdle(s, 18 + i, 20));
    // One nurse is firing (leaving) — she must not count as the colleague that
    // lets the other go to lunch, or the floor could hit zero when she's removed.
    roster[0]!.firing = true;
    world.clock.tick = tickForMinute(DAY_MID) - 1;
    for (let i = 0; i < 800; i++) world.tick();
    // The non-firing nurse is now effectively solo → she never lunches.
    expect(roster[1]!.onBreak).toBeNull();
    expect(roster[1]!.lunchedThisShift).toBe(false);
  });
});

// ------------------------------------------------------------- geometry gates

describe('geometry gates', () => {
  it('a lounge with a live lunch claim cannot be sold or expanded', () => {
    const world = setup();
    const lounge = buildLounge(world);
    const nurse = hireShift(world, 'nurse', 'day');
    nurse.onBreak = {
      mode: 'lounge', roomId: lounge.id, slot: 0, phase: 'walking', ticksRemaining: 0, startedAt: 0,
    };
    expect(validateRoomSell(world, lounge.id).ok).toBe(false); // walking claimant blocks
    const bigger = { col: 16, row: 14, cols: 4, rows: 3 };
    expect(validateRoomExpand(world, lounge.id, bigger, true).ok).toBe(false);

    nurse.onBreak = null; // claim released → geometry frees up
    expect(validateRoomSell(world, lounge.id).ok).toBe(true);
  });
});

// ------------------------------------------------------------- save / determinism

describe('save, migration & determinism', () => {
  it('a pre-v14 save loads inert (no lunch, not lunched)', () => {
    const world = new World(new EventBus(), 7);
    setupNewGame(world);
    world.addStaffMember('nurse', 3, 200).shift = 'day';
    const save = JSON.parse(saveToString(world)) as Record<string, unknown>;
    // Strip the v14-only fields and re-stamp to a pre-shift-2 version.
    for (const s of save.staff as Record<string, unknown>[]) {
      delete s.onBreak;
      delete s.lunchedThisShift;
    }
    save.saveVersion = 13;
    const result = loadWorld(new EventBus(), JSON.stringify(save));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const s of result.world.staff.values()) {
      expect(s.onBreak).toBeNull();
      expect(s.lunchedThisShift).toBe(false);
    }
  });

  it('save → load → run is byte-identical with a lunch in flight (determinism)', () => {
    const world = setup();
    const lounge = buildLounge(world);
    const roster = [0, 1].map(() => hireShift(world, 'nurse', 'day'));
    roster.forEach((s, i) => placeIdle(s, 18 + i, 20));
    // Drive to a SETTLED lounge lunch (phase 'using') — the strongest in-flight
    // state at the save tick (a claimed seat + a running timer to round-trip).
    world.clock.tick = tickForMinute(DAY_MID) - 1;
    for (
      let i = 0;
      i < 2500 && !roster.some((s) => s.onBreak?.mode === 'lounge' && s.onBreak.phase === 'using');
      i++
    ) {
      world.tick();
    }
    expect(roster.some((s) => s.onBreak?.phase === 'using')).toBe(true);
    void lounge;

    const json = saveToString(world);
    const loaded = loadWorld(new EventBus(), json);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    for (let i = 0; i < 300; i++) {
      world.tick();
      loaded.world.tick();
    }
    expect(saveToString(loaded.world)).toBe(saveToString(world));
  });
});

// ------------------------------------------------------------- night wrap

describe('night shift', () => {
  it('a night crew lunches across the midnight-wrapping window', () => {
    const world = setup();
    buildLounge(world);
    const roster = [0, 1].map(() => hireShift(world, 'nurse', 'night'));
    roster.forEach((s, i) => placeIdle(s, 18 + i, 20));
    // Start just after the night lunch window opens (22:10) and sweep through the
    // midnight wrap to ~02:00 — without the mod-1440 wrap fix, a night staffer
    // whose personal start lands ≥ 1440 would never lunch.
    world.clock.tick = tickForMinute(1330) - 1;
    for (let i = 0; i < 2600; i++) world.tick();
    expect(roster.some((s) => s.lunchedThisShift)).toBe(true);
  });
});
