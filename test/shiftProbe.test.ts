import { describe, it } from 'vitest';

import { TICKS_PER_DAY } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import { shiftWageMultiplier } from '../src/sim/formulas';
import { ROLE_DEFS, type RoleId } from '../src/sim/data/roles';
import type { ShiftId } from '../src/sim/data/shifts';
import { EventBus } from '../src/events';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';
import { REFERENCE_BUILD, matureStaffRoster, type RoomSpec } from './fixtures/builds';

/**
 * THE SHIFT PROBE — SHIFTS_STAGE1_CONTRACT §"v2 REVIEW OUTCOME", the measurement
 * both pre-impl reviews demanded before any shift balance number is written.
 *
 * The design review proved the drafted contract pre-committed to the two levers
 * the arithmetic says break the starter — whole-roster payroll and the 06:00
 * window — so this probe makes BOTH probe OUTPUTS and measures the binding
 * EARLY-GAME arm:
 *   - PAYROLL MODEL: 6a (whole-roster, full wage even off-shift) vs a per-shift
 *     wage (~0.6× day). Per-shift keeps "24/7 = 2× day-only" WITHOUT nailing
 *     day-only to today's absolute cost.
 *   - WINDOW PHASE: 06:00–18:30 (strands the 18:30–22:00 evening rush) vs a later
 *     ~09:30–22:00 (captures the evening, gives up the sleepy morning).
 *   - POSTURE: BASELINE (always-on 1× roster), DAY-ONLY (1× roster, day shift),
 *     24/7 (2× roster, both shifts).
 *
 * The sim's onShift availability gate is LIVE but INERT until a shift is assigned
 * (a staffer's `shift` defaults null = always on). This probe assigns shifts and
 * sweeps the SHIPPED wage mechanism (`BALANCE.shifts.wageFactor`, applied ONCE in
 * `economy.ts` via `shiftWageMultiplier`) — the economyProbe.withArm precedent —
 * so it measures the REAL dispatch AND payroll behaviour, not an injected one.
 *
 * NB the payroll model is the SWEPT `wageFactor`, NOT a salary the probe pre-scales:
 * the wage mechanism now lives in `economy.ts` (commit 4c973b1), so pre-scaling the
 * salary AND letting economy multiply again would double-discount every shifted
 * staffer (the "6a" arm would read out a 0.6× roster). The probe therefore assigns
 * BASE salaries and sweeps `wageFactor ∈ {1.0 = 6a, 0.6 = per-shift}` around each arm.
 *
 * Deciding metrics, stated up front (the ones that FALSIFY the design):
 *   - day-only starter net/day > 0 (across seeds) — the binding question;
 *   - incremental night-shift ROI = 24/7 net − day-only net (is "24/7 later" real
 *     or a trap?);
 *   - deaths+walkouts during UNSTAFFED night hours (incl. patients stranded past
 *     the boundary), and the multi-day reputation trajectory (does day-only
 *     spiral?).
 *
 * Caveat: the probe runs the availability gate only — off-shift staff are excluded
 * from NEW work but do NOT yet walk home, and a gather formed before the boundary
 * still completes (the M1 gather-cancel is implementation, not measurement). This
 * slightly OVER-counts off-shift coverage, so a day-only net that is already
 * negative here is conservatively negative.
 *
 * Run: SHIFT_PROBE=1 npx vitest run test/shiftProbe.test.ts --disable-console-intercept
 */

// The early-game arm — the BINDING build (mirrors the economy probe's starter).
const EARLY_GAME_BUILD: RoomSpec[] = [
  { type: 'triage', rect: { col: 10, row: 28, cols: 2, rows: 2 }, door: { col: 12, row: 29 } },
  { type: 'exam', rect: { col: 14, row: 27, cols: 3, rows: 3 }, door: { col: 17, row: 28 } },
  { type: 'er', rect: { col: 32, row: 26, cols: 3, rows: 4 }, door: { col: 35, row: 27 } },
];
const EARLY_ROLES: RoleId[] = ['nurse', 'doctor']; // + the setup receptionist

/** The day on-floor window in minuteOfDay, used to classify a death as "night". */
const dayWindow = () => BALANCE.shifts.day;
function inNight(minuteOfDay: number): boolean {
  const w = dayWindow();
  return !(minuteOfDay >= w.startMinute && minuteOfDay < w.endMinute);
}

type Posture = 'baseline' | 'day-only' | '24-7';

interface ShiftProbe {
  seed: number;
  revenue: number;
  profit: number;
  payrollPerDay: number;
  discharged: number;
  died: number;
  leftAma: number;
  diedNight: number;
  amaNight: number;
  repTrajectory: number[];
  days: number;
}

/**
 * Configure the roster for a posture, at BASE salaries. The wage model is the
 * SWEPT `BALANCE.shifts.wageFactor` (applied once in economy.ts) — the probe must
 * NOT pre-scale salary or the factor is double-counted. BASELINE is null-shift
 * (always-on), so it is wage-factor-independent by construction.
 */
function configureRoster(world: World, posture: Posture): void {
  const receptionist = [...world.staff.values()].find((s) => s.role === 'receptionist')!;
  const addShifted = (role: RoleId, shift: ShiftId | null): void => {
    world.addStaffMember(role, 3, ROLE_DEFS[role].salaryPerDay).shift = shift;
  };

  if (posture === 'baseline') {
    // Always-on 1× roster (today). The setup receptionist stays null.
    for (const role of EARLY_ROLES) addShifted(role, null);
    return;
  }
  // Both shifted postures: the setup receptionist works the DAY shift.
  receptionist.shift = 'day';
  for (const role of EARLY_ROLES) addShifted(role, 'day');
  if (posture === '24-7') {
    addShifted('receptionist', 'night');
    for (const role of EARLY_ROLES) addShifted(role, 'night');
  }
}

/** Same, for a mature build (the reference roster, shifted). */
function configureMature(world: World, posture: Posture): void {
  const receptionist = [...world.staff.values()].find((s) => s.role === 'receptionist')!;
  const roster = matureStaffRoster();
  const add = (role: RoleId, shift: ShiftId | null): void => {
    world.addStaffMember(role, 3, ROLE_DEFS[role].salaryPerDay).shift = shift;
  };
  if (posture === 'baseline') {
    for (const { role, count } of roster) for (let i = 0; i < count; i++) add(role, null);
    return;
  }
  receptionist.shift = 'day';
  for (const { role, count } of roster) for (let i = 0; i < count; i++) add(role, 'day');
  if (posture === '24-7') {
    add('receptionist', 'night');
    for (const { role, count } of roster) for (let i = 0; i < count; i++) add(role, 'night');
  }
}

function runShift(
  seed: number,
  build: RoomSpec[],
  configure: (w: World, p: Posture) => void,
  posture: Posture,
  days: number,
  bankroll: number,
  reputation?: number,
): ShiftProbe {
  const events = new EventBus();
  const world = new World(events, seed);
  setupNewGame(world);
  if (reputation !== undefined) world.reputation = reputation;
  world.cash += bankroll;
  for (const spec of build) world.buildRoom(spec.type, spec.rect, spec.door);
  world.placeAmenity('vending', { col: 26, row: 33 });
  world.placeAmenity('trashcan', { col: 27, row: 33 });
  configure(world, posture);

  const p: ShiftProbe = {
    seed,
    revenue: 0,
    profit: 0,
    // The CHARGED payroll: base salary × the swept wage multiplier (matches
    // economy.ts). A raw salary sum would print a payroll the sim never deducts.
    payrollPerDay: [...world.staff.values()].reduce(
      (s, m) => s + m.salaryPerDay * shiftWageMultiplier(m.shift),
      0,
    ),
    discharged: 0,
    died: 0,
    leftAma: 0,
    diedNight: 0,
    amaNight: 0,
    repTrajectory: [],
    days,
  };
  events.on('patientDischarged', () => (p.discharged += 1));
  events.on('patientDied', () => {
    p.died += 1;
    if (inNight(world.clock.minuteOfDay)) p.diedNight += 1;
  });
  events.on('patientLeftAma', () => {
    p.leftAma += 1;
    if (inNight(world.clock.minuteOfDay)) p.amaNight += 1;
  });

  const cash0 = world.cash;
  const rev0 = world.lifetime.revenue;
  for (let i = 0; i < TICKS_PER_DAY * days; i++) {
    world.tick();
    if (world.clock.tick % TICKS_PER_DAY === 0) p.repTrajectory.push(Math.round(world.reputation));
  }
  p.revenue = (world.lifetime.revenue - rev0) / days;
  p.profit = (world.cash - cash0) / days;
  return p;
}

function summarize(label: string, rows: ShiftProbe[]): number {
  const n = rows.length;
  const avg = (f: (r: ShiftProbe) => number) => rows.reduce((s, r) => s + f(r), 0) / n;
  const profit = avg((r) => r.profit);
  console.log(`\n=== ${label} ===`);
  console.log(
    [
      `rev/d $${avg((r) => r.revenue).toFixed(0)}`,
      `payroll/d $${avg((r) => r.payrollPerDay).toFixed(0)}`,
      `PROFIT/d $${profit.toFixed(0)}`,
      `disch/d ${avg((r) => r.discharged / r.days).toFixed(1)}`,
      `died/d ${avg((r) => r.died / r.days).toFixed(2)}`,
      `AMA/d ${avg((r) => r.leftAma / r.days).toFixed(1)}`,
      `nightDeaths/d ${avg((r) => r.diedNight / r.days).toFixed(2)}`,
      `nightAMA/d ${avg((r) => r.amaNight / r.days).toFixed(1)}`,
    ].join(' | '),
  );
  console.log(
    '  per-seed profit/d: ' + rows.map((r) => `${r.seed} $${r.profit.toFixed(0)}`).join('  '),
  );
  console.log('  rep trajectory (seed ' + rows[0]!.seed + '): ' + rows[0]!.repTrajectory.join(' → '));
  return profit;
}

// Sweep BALANCE.shifts windows in place (the economyProbe.withArm precedent).
function withWindow(name: string, day: { s: number; e: number }, night: { s: number; e: number }, fn: () => void): void {
  const sh = BALANCE.shifts as { day: { startMinute: number; endMinute: number }; night: { startMinute: number; endMinute: number } };
  const saved = { d: { ...sh.day }, n: { ...sh.night } };
  sh.day.startMinute = day.s;
  sh.day.endMinute = day.e;
  sh.night.startMinute = night.s;
  sh.night.endMinute = night.e;
  try {
    console.log(`\n########## WINDOW: ${name} (day ${day.s}-${day.e}) ##########`);
    fn();
  } finally {
    Object.assign(sh.day, saved.d);
    Object.assign(sh.night, saved.n);
  }
}

// Sweep the SHIPPED wage factor in place: 1.0 = 6a whole-roster, 0.6 = per-shift.
// economy.ts applies it exactly once (shiftWageMultiplier), so the probe assigns
// base salaries and lets this be the ONLY place the factor is applied.
function withWage(name: string, factor: number, fn: () => void): void {
  const sh = BALANCE.shifts as { wageFactor: number };
  const saved = sh.wageFactor;
  sh.wageFactor = factor;
  try {
    console.log(`\n---------- WAGE: ${name} (factor ${factor}) ----------`);
    fn();
  } finally {
    sh.wageFactor = saved;
  }
}

declare const process: { env: Record<string, string | undefined> } | undefined;
const describeProbe =
  typeof process !== 'undefined' && process.env.SHIFT_PROBE ? describe : describe.skip;

describeProbe('Shift probe (SHIFTS_STAGE1_CONTRACT §measurement)', () => {
  it('prints day-only viability + night ROI across payroll models and windows', () => {
    const seeds = [1337, 1338, 31337, 4242, 90210];
    const early = (posture: Posture, rep?: number) =>
      seeds.map((s) => runShift(s, EARLY_GAME_BUILD, configureRoster, posture, 10, 0, rep));

    // BASELINE is shift-independent (null-shift = wage-factor-independent) — run once.
    console.log('\n>>>>> EARLY-GAME ARM (binding) <<<<<');
    const base = summarize('EARLY baseline (always-on 1×)', early('baseline'));

    for (const [wname, day, night] of [
      ['06:00–18:30 (default)', { s: 360, e: 1110 }, { s: 1080, e: 390 }],
      ['09:30–22:00 (evening-capture)', { s: 570, e: 1320 }, { s: 1290, e: 600 }],
    ] as const) {
      withWindow(wname, day, night, () => {
        for (const [tag, factor] of [['6a whole-roster', 1], ['per-shift 0.6×', 0.6]] as const) {
          withWage(tag, factor, () => {
            const dayOnly = summarize(`EARLY day-only · ${tag}`, early('day-only'));
            const round = summarize(`EARLY 24/7 · ${tag}`, early('24-7'));
            console.log(
              `  >> NIGHT ROI (24/7 − day-only) = $${(round - dayOnly).toFixed(0)}/d | ` +
                `day-only vs baseline: $${(dayOnly - base).toFixed(0)}/d`,
            );
          });
        }
      });
    }

    // SHOCK: day-only starter opening at rep 150 (does it recover or spiral?).
    withWindow('06:00–18:30 (default)', { s: 360, e: 1110 }, { s: 1080, e: 390 }, () => {
      withWage('6a whole-roster', 1, () => {
        summarize('EARLY day-only · 6a · SHOCK rep150', early('day-only', 150));
      });
    });

    // CEILING: the mature reference build, default window, whole-roster (6a) payroll.
    console.log('\n>>>>> REFERENCE ARM (mature ceiling) <<<<<');
    withWage('6a whole-roster', 1, () => {
      const matureBase = summarize(
        'REF baseline',
        seeds.map((s) => runShift(s, REFERENCE_BUILD, configureMature, 'baseline', 5, 10_000_000)),
      );
      const matureDay = summarize(
        'REF day-only · 6a',
        seeds.map((s) => runShift(s, REFERENCE_BUILD, configureMature, 'day-only', 5, 10_000_000)),
      );
      const matureRound = summarize(
        'REF 24/7 · 6a',
        seeds.map((s) => runShift(s, REFERENCE_BUILD, configureMature, '24-7', 5, 10_000_000)),
      );
      console.log(
        `  >> REF night ROI = $${(matureRound - matureDay).toFixed(0)}/d | ` +
          `day-only vs baseline: $${(matureDay - matureBase).toFixed(0)}/d`,
      );
    });
  }, 600_000);
});
