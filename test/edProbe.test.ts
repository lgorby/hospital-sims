import { describe, it } from 'vitest';

import { TICKS_PER_DAY } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import { ROLE_DEFS, type RoleId } from '../src/sim/data/roles';
import { CONDITION_DEFS } from '../src/sim/data/conditions';
import { ROOM_DEFS } from '../src/sim/data/rooms';
import { EventBus } from '../src/events';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';
import type { RoomType } from '../src/sim/data/rooms';
import type { GridPoint, Rect } from '../src/sim/types';
import { GAME_MINUTES_PER_TICK } from '../src/sim/clock';

interface RoomSpec {
  type: RoomType;
  rect: Rect;
  door: GridPoint | null;
}

/** Mirrors test/harness.test.ts STANDARD_ROOMS — the reference build. */
const REFERENCE_BUILD: RoomSpec[] = [
  { type: 'restroom', rect: { col: 5, row: 27, cols: 2, rows: 3 }, door: { col: 7, row: 28 } },
  { type: 'triage', rect: { col: 10, row: 28, cols: 2, rows: 2 }, door: { col: 12, row: 29 } },
  { type: 'exam', rect: { col: 14, row: 27, cols: 3, rows: 3 }, door: { col: 17, row: 28 } },
  { type: 'exam', rect: { col: 18, row: 27, cols: 3, rows: 3 }, door: { col: 21, row: 28 } },
  { type: 'xray', rect: { col: 24, row: 26, cols: 3, rows: 4 }, door: { col: 27, row: 27 } },
  // DEPARTMENTS_PLAN §3.2: `resp` is retired and its two steps route to `exam`.
  // This slot becomes a THIRD EXAM ROOM (both are 3×3 minimum, so the rect is
  // drop-in) — WITHOUT it the reference build silently loses a server, 3 → 2,
  // confounding a 33% capacity cut with the routing change. That is exactly
  // the confounding ED_PLAN §5b had to split into arms.
  { type: 'exam', rect: { col: 28, row: 27, cols: 3, rows: 3 }, door: { col: 31, row: 28 } },
  { type: 'er', rect: { col: 32, row: 26, cols: 3, rows: 4 }, door: { col: 35, row: 27 } },
  { type: 'ultrasound', rect: { col: 8, row: 21, cols: 2, rows: 3 }, door: { col: 10, row: 22 } },
  { type: 'ct', rect: { col: 12, row: 20, cols: 4, rows: 4 }, door: { col: 14, row: 24 } },
  { type: 'mri', rect: { col: 17, row: 20, cols: 4, rows: 4 }, door: { col: 19, row: 24 } },
  { type: 'nucMed', rect: { col: 22, row: 20, cols: 3, rows: 4 }, door: { col: 23, row: 24 } },
  { type: 'dialysis', rect: { col: 26, row: 20, cols: 3, rows: 4 }, door: { col: 27, row: 24 } },
  { type: 'surgery', rect: { col: 30, row: 20, cols: 4, rows: 4 }, door: { col: 32, row: 24 } },
];

const EXPANSION_WING: readonly RoomType[] = [
  'ultrasound', 'ct', 'mri', 'nucMed', 'dialysis', 'surgery',
];

/**
 * ED_PLAN §6 / ED_IMPL_PLAN §6b — the Stage-B1 measurement instrument.
 *
 * Deliberately NOT an assertion suite: it prints a table. Both pre-impl
 * reviews found the old probe could not FALSIFY B1 — it recorded visits,
 * discharged, died and left-untreated, none of which detect a deleted payroll
 * brake or a starved triage queue. The columns below are the ones that can.
 *
 * Run with: npx vitest run test/edProbe.test.ts --reporter=basic
 */

const STAFF: { role: RoleId; count: number }[] = [
  { role: 'nurse', count: 3 },
  { role: 'doctor', count: 2 },
  { role: 'radTech', count: 2 },
  { role: 'respTherapist', count: 1 },
  { role: 'sonographer', count: 1 },
  { role: 'surgeon', count: 1 },
  { role: 'anesthesiologist', count: 1 },
  { role: 'evs', count: 1 },
  { role: 'maintenance', count: 1 },
];

interface Probe {
  seed: number;
  erVisits: number;
  examVisits: number;
  discharged: number;
  died: number;
  leftUntreated: number;
  triageCompletions: number;
  meanWaitingTriageMin: number;
  peakErReservations: number;
  meanErStaffLoad: number;
  payrollPerDay: number;
  profitPerDay: number;
  surgeries: number;
  triageStarts: number;
  /** DEPARTMENTS_PLAN §3.2 risk 3 (room-capture): ticks where a DOCTOR-needing
   *  patient waited while every exam room was held by a non-doctor step. */
  doctorBlockedInExam: number;
  /** Deaths by condition — which patients are we losing? */
  deathsByCondition: Map<string, number>;
  /** Died while still WAITING for their surgical step (never reached the OR). */
  diedAwaitingSurgery: number;
  /** Ticks in which a surgery gather failed for want of a role. */
  surgeryGatherBlocked: number;
  /** …of those, the ticks where the missing role was specifically a nurse. */
  surgeryBlockedOnNurse: number;
}

function run(seed: number, days: number, rooms: RoomSpec[], lean = false): Probe {
  const events = new EventBus();
  const world = new World(events, seed);
  setupNewGame(world);
  world.cash += rooms
    .filter((r) => EXPANSION_WING.includes(r.type))
    .reduce((sum, r) => sum + ROOM_DEFS[r.type].cost, 0);
  for (const spec of rooms) world.buildRoom(spec.type, spec.rect, spec.door);
  world.placeAmenity('vending', { col: 26, row: 33 });
  world.placeAmenity('trashcan', { col: 27, row: 33 });
  for (const { role, count } of STAFF) {
    // `lean`: halve the clinical pool (nurses 3→1, doctors 2→1) to test the
    // ratio's actual claim — graceful degradation when SHORT-staffed.
    const n = lean && (role === 'nurse' || role === 'doctor') ? 1 : count;
    for (let i = 0; i < n; i++) {
      world.addStaffMember(role, 3, ROLE_DEFS[role].salaryPerDay);
    }
  }
  const cashAtStart = world.cash;

  const p: Probe = {
    seed,
    erVisits: 0,
    examVisits: 0,
    discharged: 0,
    died: 0,
    leftUntreated: 0,
    triageCompletions: 0,
    meanWaitingTriageMin: 0,
    peakErReservations: 0,
    meanErStaffLoad: 0,
    payrollPerDay: 0,
    profitPerDay: 0,
    surgeries: 0,
    triageStarts: 0,
    doctorBlockedInExam: 0,
    deathsByCondition: new Map(),
    diedAwaitingSurgery: 0,
    surgeryGatherBlocked: 0,
    surgeryBlockedOnNurse: 0,
  };
  events.on('patientDischarged', () => (p.discharged += 1));
  events.on('patientDied', ({ patientId }) => {
    p.died += 1;
    const victim = world.patients.get(patientId);
    if (!victim) return;
    p.deathsByCondition.set(victim.condition, (p.deathsByCondition.get(victim.condition) ?? 0) + 1);
    const step = CONDITION_DEFS[victim.condition].steps[victim.stepIndex];
    if (step?.room === 'surgery' && victim.stage.kind !== 'reserved') p.diedAwaitingSurgery += 1;
  });
  events.on('patientLeftAma', () => (p.leftUntreated += 1));
  const seenRes = new Set<number>();

  let loadSamples = 0;
  let loadSum = 0;
  let waitSamples = 0;
  let waitSum = 0;
  for (let i = 0; i < TICKS_PER_DAY * days; i++) {
    world.tick();
    const ers = [...world.rooms.values()].filter((r) => r.type === 'er');
    let erRes = 0;
    for (const room of ers) {
      const held = world.reservationsOn(room.id);
      erRes += held.length;
      const staffIds = new Set(held.flatMap((r) => r.staffIds));
      for (const id of staffIds) {
        loadSum += world.staffLoadIn(id, room.id);
        loadSamples += 1;
      }
    }
    if (erRes > p.peakErReservations) p.peakErReservations = erRes;
    // Room-capture probe: is a doctor's patient stuck because an RT (or
    // anyone) is holding every exam room? ED_PLAN §5b was staff-capture; this
    // is the same failure class on the ROOM axis.
    // Only rooms that COULD serve someone — a closed or broken room is not
    // "captured", it is out of service, and counting it inflated both arms.
    const exams = [...world.rooms.values()].filter(
      (r) => r.type === 'exam' && !r.closed && r.brokenSince === null,
    );
    if (exams.length > 0 && exams.every((r) => world.openSlots(r) <= 0)) {
      const doctorWaiting = [...world.patients.values()].some((x) => {
        if (x.stage.kind !== 'waiting') return false;
        const st = CONDITION_DEFS[x.condition].steps[x.stepIndex];
        return st?.room === 'exam' && (st.roles as readonly string[]).includes('doctor');
      });
      // ...and at least one room must be held by a step that does NOT need a
      // doctor. Without this the counter fires when three doctors block three
      // doctors, which is ordinary congestion, not ROOM-CAPTURE by another
      // role (post-impl review MINOR 4 — the earlier version could not
      // distinguish them, so §3.8 must not attribute the gap to RT capture).
      const heldByNonDoctor = exams.some((r) =>
        world.reservationsOn(r.id).some((res) => {
          const patient = world.patients.get(res.patientId);
          if (!patient) return false;
          const st = CONDITION_DEFS[patient.condition].steps[res.stepIndex];
          return st !== undefined && !(st.roles as readonly string[]).includes('doctor');
        }),
      );
      if (doctorWaiting && heldByNonDoctor) p.doctorBlockedInExam += 1;
    }
    // Is anyone stuck at the OR door, and which role is missing?
    const orRooms = [...world.rooms.values()].filter((r) => r.type === 'surgery');
    const orWaiting = [...world.patients.values()].some((x) => {
      if (x.stage.kind !== 'waiting') return false;
      return CONDITION_DEFS[x.condition].steps[x.stepIndex]?.room === 'surgery';
    });
    if (orWaiting && orRooms.some((r) => world.openSlots(r) > 0)) {
      p.surgeryGatherBlocked += 1;
      const freeNurse = [...world.staff.values()].some(
        (m) => m.role === 'nurse' && m.duty.kind === 'idle' && !m.firing,
      );
      if (!freeNurse) p.surgeryBlockedOnNurse += 1;
    }
    for (const r of world.reservations.values()) {
      if (seenRes.has(r.id)) continue;
      seenRes.add(r.id);
      if (r.kind === 'triage') p.triageStarts += 1;
      const room = world.rooms.get(r.roomId);
      if (room?.type === 'surgery') p.surgeries += 1;
    }
    for (const patient of world.patients.values()) {
      if (patient.stage.kind === 'waitingTriage' && patient.waitingSince !== null) {
        waitSum += (world.clock.tick - patient.waitingSince) * GAME_MINUTES_PER_TICK;
        waitSamples += 1;
      }
    }
  }

  for (const room of world.rooms.values()) {
    if (room.type === 'er') p.erVisits += room.visitsTotal;
    if (room.type === 'exam') p.examVisits += room.visitsTotal;
  }
  p.triageCompletions = [...world.patients.values()].filter((x) => x.acuity !== null).length;
  p.meanErStaffLoad = loadSamples > 0 ? loadSum / loadSamples : 0;
  p.meanWaitingTriageMin = waitSamples > 0 ? waitSum / waitSamples : 0;
  p.payrollPerDay = [...world.staff.values()].reduce((s, m) => s + m.salaryPerDay, 0);
  p.profitPerDay = (world.cash - cashAtStart) / days;
  return p;
}

function table(label: string, rows: Probe[]): void {
  const avg = (f: (r: Probe) => number): string =>
    (rows.reduce((s, r) => s + f(r), 0) / rows.length).toFixed(1);
  console.log(`\n=== ${label} ===`);
  console.log(
    [
      `ER ${avg((r) => r.erVisits)}`,
      `exam ${avg((r) => r.examVisits)}`,
      `disch ${avg((r) => r.discharged)}`,
      `died ${avg((r) => r.died)}`,
      `AMA ${avg((r) => r.leftUntreated)}`,
      `triaged ${avg((r) => r.triageCompletions)}`,
      `waitTriage ${avg((r) => r.meanWaitingTriageMin)}m`,
      `peakER ${avg((r) => r.peakErReservations)}`,
      `ERload ${avg((r) => r.meanErStaffLoad)}`,
      `surg ${avg((r) => r.surgeries)}`,
      `drBlockedExam ${avg((r) => r.doctorBlockedInExam)}t`,
      `diedPreOR ${avg((r) => r.diedAwaitingSurgery)}`,
      `ORblocked ${avg((r) => r.surgeryGatherBlocked)}t`,
      `noNurse ${avg((r) => r.surgeryBlockedOnNurse)}t`,
      `triageStarts ${avg((r) => r.triageStarts)}`,
      `payroll ${avg((r) => r.payrollPerDay)}`,
      `profit/d ${avg((r) => r.profitPerDay)}`,
    ].join(' | '),
  );
  const deaths = new Map<string, number>();
  for (const r of rows) {
    for (const [c, n] of r.deathsByCondition) deaths.set(c, (deaths.get(c) ?? 0) + n);
  }
  console.log(
    '  deaths by condition: ' +
      [...deaths.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', '),
  );
  for (const r of rows) {
    console.log(
      `  seed ${r.seed}: ER ${r.erVisits} died ${r.died} AMA ${r.leftUntreated} ` +
        `triaged ${r.triageCompletions} waitTriage ${r.meanWaitingTriageMin.toFixed(0)}m ` +
        `ERload ${r.meanErStaffLoad.toFixed(2)} profit/d ${r.profitPerDay.toFixed(0)}`,
    );
  }
}

// Arms are produced by mutating the data tables in place — the probe is a
// measurement rig, not shipped code, and this is the only way to isolate
// density from ratio (they are confounded: without the ratio, 2 bays demand
// 2 staff pairs, so density alone does not deliver B1's fix).
/* eslint-disable @typescript-eslint/no-explicit-any */
function withArm(arm: 'baseline' | 'density' | 'b1', fn: () => void): void {
  const erDef = ROOM_DEFS.er as any;
  const density = erDef.props[0].density as any;
  const treat = BALANCE.treatment as any;
  const savedRatio = erDef.staffRatio;
  const savedTiles = density.tilesPerProp;
  const savedMin = density.min;
  const savedPenalty = treat.attentionSkillPenaltyPerPatient;
  if (arm === 'baseline') {
    density.tilesPerProp = 12;
    density.min = 1;
  }
  if (arm !== 'b1') {
    delete erDef.staffRatio;
    treat.attentionSkillPenaltyPerPatient = 0;
  }
  try {
    fn();
  } finally {
    erDef.staffRatio = savedRatio;
    density.tilesPerProp = savedTiles;
    density.min = savedMin;
    treat.attentionSkillPenaltyPerPatient = savedPenalty;
  }
}

// A MEASUREMENT INSTRUMENT, not a test: it prints a table and asserts nothing,
// and a full 3-arm × 5-seed × 5-day sweep takes ~135s — which would triple the
// cost of the per-milestone `npm test` gate forever (post-impl review MAJOR 2).
// Its output belongs in ED_PLAN §5b, where it is recorded. Run deliberately:
//   ED_PROBE=1 npx vitest run test/edProbe.test.ts --disable-console-intercept
// `process` is not in this project's DOM/vite tsconfig types, and adding
// @types/node for one env read is not worth the dependency.
declare const process: { env: Record<string, string | undefined> } | undefined;
const describeProbe =
  typeof process !== 'undefined' && process.env.ED_PROBE ? describe : describe.skip;

describeProbe('ED Stage B1 probe (ED_IMPL_PLAN §6b)', () => {
  it('prints the 3-arm 5-seed table', () => {
    const seeds = [1337, 1338, 31337, 4242, 90210];
    for (const arm of ['baseline', 'density', 'b1'] as const) {
      withArm(arm, () => {
        table(arm, seeds.map((s) => run(s, 5, REFERENCE_BUILD)));
      });
    }
    for (const arm of ['density', 'b1'] as const) {
      withArm(arm, () => {
        table(`${arm} LEAN (1 nurse, 1 doctor)`, seeds.map((s) => run(s, 5, REFERENCE_BUILD, true)));
      });
    }
    // DEPARTMENTS_PLAN §3.2 risk 1 — the routing change and a 33% server cut
    // must NOT be measured together. REFERENCE_BUILD already carries the third
    // exam room (capacity-neutral); this arm drops it, which is what a real
    // player who never rebuilds actually experiences.
    // Drop the LAST exam room by identity, not by a magic coordinate: a moved
    // fixture rect would silently turn this into a duplicate of the 3-room arm.
    const lastExam = [...REFERENCE_BUILD].reverse().find((r) => r.type === 'exam')!;
    const twoExam = REFERENCE_BUILD.filter((r) => r !== lastExam);
    if (twoExam.length !== REFERENCE_BUILD.length - 1) {
      throw new Error('two-exam arm did not drop exactly one room');
    }
    table('resp routing, 2 exam rooms (no rebuild)', seeds.map((s) => run(s, 5, twoExam)));
  }, 600_000);
});
