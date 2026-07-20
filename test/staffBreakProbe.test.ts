import { describe, it } from 'vitest';

import { TICKS_PER_DAY } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import { ROLE_DEFS, type RoleId } from '../src/sim/data/roles';
import { EventBus } from '../src/events';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';
import { REFERENCE_BUILD, matureStaffRoster } from './fixtures/builds';

/**
 * THE STAFF-BREAK PROBE — SHIFTS_STAGE2_CONTRACT §6, the measurement the design
 * review demanded before any Stage-2 balance number is frozen. It measures the
 * COVERAGE COST of the mid-shift lunch on a BUSY, 24/7-staffed reference build
 * (both shifts, so day lunches land in the 10:00–15:00 arrival peak), across
 * three arms:
 *   - OFF: no lunches (the cap set impossibly high) — the Stage-1 baseline.
 *   - NO-LOUNGE: lunches fire, staff leave the building to eat (off-floor).
 *   - LOUNGE: lunches fire, staff use an on-site lounge placed at a REALISTIC,
 *     non-optimal distance (south-central, below the working rooms) — the walk
 *     is counted, per the LAYOUT distance lesson.
 *
 * Deciding metric (§6): discharges/throughput + walkouts, NOT deaths (the
 * thrice-burned, 5-seed-unfalsifiable metric — printed for the spread only).
 * The lounge's value = discharges recovered between NO-LOUNGE and LOUNGE.
 *
 * LOAD is swept (a moderate and a busy reputation) to expose the skip-under-
 * capture inversion (§3.4): coverage cost should SHRINK as the hospital gets
 * busier (captured staff skip lunch). Also prints max-concurrent-on-break per
 * run (the "never all at once" guarantee holding under real load).
 *
 * Run: STAFF_BREAK_PROBE=1 npx vitest run test/staffBreakProbe.test.ts --disable-console-intercept
 */

// A realistic, non-optimal lounge: a spare SW corner clear of the setup
// reception/waiting rooms and the imaging block — a plausible player spot, not
// a best case (the LAYOUT §1.1 near/far discipline). NOT central.
const LOUNGE_SPEC = {
  rect: { col: 8, row: 33, cols: 3, rows: 3 },
  door: { col: 9, row: 36 },
} as const;

type Arm = 'off' | 'no-lounge' | 'lounge';

interface Row {
  seed: number;
  discharged: number;
  died: number;
  leftAma: number;
  lunchStarts: number;
  maxConcurrentBreak: number;
  days: number;
}

/** Configure a 24/7 mature roster (both shifts), ≥2-per-role where the fixture
 *  has them (nurse/doctor/radTech) so lunches can actually fire per shift. */
function configure247(world: World): void {
  const receptionist = [...world.staff.values()].find((s) => s.role === 'receptionist')!;
  receptionist.shift = 'day';
  const add = (role: RoleId, shift: 'day' | 'night'): void => {
    world.addStaffMember(role, 3, ROLE_DEFS[role].salaryPerDay).shift = shift;
  };
  add('receptionist', 'night');
  for (const { role, count } of matureStaffRoster()) {
    for (let i = 0; i < count; i++) {
      add(role, 'day');
      add(role, 'night');
    }
  }
}

function runArm(seed: number, arm: Arm, rep: number, days: number): Row {
  const events = new EventBus();
  const world = new World(events, seed);
  setupNewGame(world);
  world.reputation = rep;
  world.cash += 10_000_000; // operating envelope, not capex
  for (const spec of REFERENCE_BUILD) world.buildRoom(spec.type, spec.rect, spec.door);
  if (arm === 'lounge') {
    world.buildRoom('lounge', LOUNGE_SPEC.rect, LOUNGE_SPEC.door);
    // Measurement-validity guard: a silently-failed build would make the LOUNGE
    // arm identical to NO-LOUNGE and read out "the lounge does nothing".
    if (![...world.rooms.values()].some((r) => r.type === 'lounge')) {
      throw new Error('LOUNGE arm: the lounge failed to build — probe is invalid');
    }
  }
  configure247(world);

  const row: Row = {
    seed,
    discharged: 0,
    died: 0,
    leftAma: 0,
    lunchStarts: 0,
    maxConcurrentBreak: 0,
    days,
  };
  events.on('patientDischarged', () => (row.discharged += 1));
  events.on('patientDied', () => (row.died += 1));
  events.on('patientLeftAma', () => (row.leftAma += 1));

  const wasOnBreak = new Map<number, boolean>();
  for (let i = 0; i < TICKS_PER_DAY * days; i++) {
    world.tick();
    let concurrent = 0;
    for (const s of world.staff.values()) {
      const on = s.onBreak !== null;
      if (on) concurrent += 1;
      if (on && wasOnBreak.get(s.id) !== true) row.lunchStarts += 1; // null→break transition
      wasOnBreak.set(s.id, on);
    }
    row.maxConcurrentBreak = Math.max(row.maxConcurrentBreak, concurrent);
  }
  return row;
}

/** Sweep the coverage cap in place (OFF = impossibly high → no lunch ever fires). */
function withCap(min: number, fn: () => void): void {
  const l = BALANCE.shifts.lunch as { minSameRoleOnFloor: number };
  const saved = l.minSameRoleOnFloor;
  l.minSameRoleOnFloor = min;
  try {
    fn();
  } finally {
    l.minSameRoleOnFloor = saved;
  }
}

function summarize(label: string, rows: Row[]): { disch: number; ama: number } {
  const n = rows.length;
  const avg = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0) / n;
  const disch = avg((r) => r.discharged / r.days);
  const ama = avg((r) => r.leftAma / r.days);
  console.log(
    `  ${label.padEnd(12)} | disch/d ${disch.toFixed(1)} | AMA/d ${ama.toFixed(1)} | ` +
      `died/d ${avg((r) => r.died / r.days).toFixed(2)} | lunches/d ${avg((r) => r.lunchStarts / r.days).toFixed(1)} | ` +
      `maxConcurrentBreak ${Math.max(...rows.map((r) => r.maxConcurrentBreak))}`,
  );
  return { disch, ama };
}

declare const process: { env: Record<string, string | undefined> } | undefined;
const describeProbe =
  typeof process !== 'undefined' && process.env.STAFF_BREAK_PROBE ? describe : describe.skip;

describeProbe('Staff-break probe (SHIFTS_STAGE2_CONTRACT §6)', () => {
  it('measures the lunch coverage cost + lounge recovery, load-swept', () => {
    const seeds = [1337, 1338, 31337, 4242, 90210];
    const days = 5;

    for (const rep of [300, 800]) {
      console.log(`\n########## LOAD: reputation ${rep} (higher = busier) ##########`);
      const off = withCapReturn(9999, () => seeds.map((s) => runArm(s, 'off', rep, days)));
      const noLounge = seeds.map((s) => runArm(s, 'no-lounge', rep, days));
      const lounge = seeds.map((s) => runArm(s, 'lounge', rep, days));

      const offS = summarize('OFF', off);
      const noLoungeS = summarize('NO-LOUNGE', noLounge);
      const loungeS = summarize('LOUNGE', lounge);

      console.log(
        `  >> coverage cost (OFF − NO-LOUNGE) disch/d = ${(offS.disch - noLoungeS.disch).toFixed(2)} | ` +
          `LOUNGE recovers ${(loungeS.disch - noLoungeS.disch).toFixed(2)} disch/d vs no-lounge`,
      );
    }
  }, 600_000);
});

/** withCap that returns the fn result (for the OFF arm). */
function withCapReturn<T>(min: number, fn: () => T): T {
  let out!: T;
  withCap(min, () => {
    out = fn();
  });
  return out;
}
