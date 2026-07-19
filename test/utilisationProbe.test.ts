import { describe, it } from 'vitest';

import { GAME_MINUTES_PER_TICK, TICKS_PER_DAY } from '../src/sim/clock';
import { ROLE_DEFS, type RoleId } from '../src/sim/data/roles';
import { ROOM_DEFS, type RoomType } from '../src/sim/data/rooms';
import { CONDITION_DEFS, conditionElective, type ConditionId } from '../src/sim/data/conditions';
import { EventBus } from '../src/events';
import { computeBlockedNeeds } from '../src/sim/needs';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';
import type { GridPoint, Rect } from '../src/sim/types';

/**
 * DEPARTMENTS_PLAN §4.4 — the utilisation instrument.
 *
 * Built because §6 named "radTech utilisation" as a required measurement
 * column and nothing in `src/` could produce it: the ED probe's only load
 * sampling is hardcoded to `r.type === 'er'` (edProbe.test.ts:157). Departments
 * Stage 2a was contracted and reviewed against an ASSUMPTION about imaging
 * contention; §4.3 recorded the arithmetic that contradicts it. This measures
 * the same thing empirically, so the balance pass has a baseline and a
 * falsifiable target rather than a spreadsheet.
 *
 * It answers two open questions at once:
 *   1. §4.4 — what IS per-room and per-role utilisation? The balance pass has
 *      to move the imaging numbers and must know where they start.
 *   2. The capacity-hint milestone — how often does `capacity:<type>` actually
 *      fire? A design reviewer called the hint a live defect ("X-Ray is busy —
 *      build another one" on a 7%-utilised room). That claim did not account
 *      for `capacityHintWaitGameMinutes: 45`, which exists precisely to
 *      suppress the transient flash (see the comment at needs.ts:325). Whether
 *      a defect exists is an empirical question, so it is measured, not argued.
 *
 * Deliberately NOT an assertion suite — it prints tables. Gated so the default
 * suite stays fast.
 *
 * Run with:
 *   UTIL_PROBE=1 npx vitest run test/utilisationProbe.test.ts --disable-console-intercept
 */

interface RoomSpec {
  type: RoomType;
  rect: Rect;
  door: GridPoint | null;
}

/** Mirrors test/edProbe.test.ts REFERENCE_BUILD — the same reference build, so
 *  these numbers are comparable with §3.8's and §5b's. */
const REFERENCE_BUILD: RoomSpec[] = [
  { type: 'restroom', rect: { col: 5, row: 27, cols: 2, rows: 3 }, door: { col: 7, row: 28 } },
  { type: 'triage', rect: { col: 10, row: 28, cols: 2, rows: 2 }, door: { col: 12, row: 29 } },
  { type: 'exam', rect: { col: 14, row: 27, cols: 3, rows: 3 }, door: { col: 17, row: 28 } },
  { type: 'exam', rect: { col: 18, row: 27, cols: 3, rows: 3 }, door: { col: 21, row: 28 } },
  { type: 'xray', rect: { col: 24, row: 26, cols: 3, rows: 4 }, door: { col: 27, row: 27 } },
  { type: 'exam', rect: { col: 28, row: 27, cols: 3, rows: 3 }, door: { col: 31, row: 28 } },
  { type: 'er', rect: { col: 32, row: 26, cols: 3, rows: 4 }, door: { col: 35, row: 27 } },
  { type: 'ultrasound', rect: { col: 8, row: 21, cols: 2, rows: 3 }, door: { col: 10, row: 22 } },
  { type: 'ct', rect: { col: 12, row: 20, cols: 4, rows: 4 }, door: { col: 14, row: 24 } },
  { type: 'mri', rect: { col: 17, row: 20, cols: 4, rows: 4 }, door: { col: 19, row: 24 } },
  { type: 'nucMed', rect: { col: 22, row: 20, cols: 3, rows: 4 }, door: { col: 23, row: 24 } },
  { type: 'dialysis', rect: { col: 26, row: 20, cols: 3, rows: 4 }, door: { col: 27, row: 24 } },
  { type: 'surgery', rect: { col: 30, row: 20, cols: 4, rows: 4 }, door: { col: 32, row: 24 } },
];

/**
 * The COMPACT layout arm, hand-synced with `test/edProbe.test.ts:62-78`.
 *
 * IMAGING_4B pre-impl review MAJOR 6b: this probe is the ONLY source of xray
 * and radTech utilisation — the prize and the risk of §4B respectively — and
 * it had no compact arm, while `edProbe` has the compact arm but reports
 * neither number. "Measure on both layout arms" (LAYOUT_PLAN §3.4) was
 * therefore not executable for the two metrics that matter most. It is now.
 *
 * Same 13 rooms, same types/sizes, same staffing, same cash — only placement
 * differs. LAYOUT_PLAN §3.2: the compact arm is where staff contention stops
 * being hidden by walking, so a radTech reading here is the load-bearing one.
 */
const COMPACT_BUILD: RoomSpec[] = [
  // Band A — rows 34-37, doors onto the row-38 corridor.
  { type: 'restroom', rect: { col: 5, row: 35, cols: 2, rows: 3 }, door: { col: 5, row: 38 } },
  { type: 'exam', rect: { col: 8, row: 35, cols: 3, rows: 3 }, door: { col: 9, row: 38 } },
  { type: 'er', rect: { col: 12, row: 34, cols: 3, rows: 4 }, door: { col: 13, row: 38 } },
  { type: 'triage', rect: { col: 26, row: 36, cols: 2, rows: 2 }, door: { col: 26, row: 38 } },
  { type: 'exam', rect: { col: 28, row: 35, cols: 3, rows: 3 }, door: { col: 29, row: 38 } },
  { type: 'exam', rect: { col: 32, row: 35, cols: 3, rows: 3 }, door: { col: 33, row: 38 } },
  // Band B — rows 27-30, doors onto the row-31 corridor.
  { type: 'xray', rect: { col: 5, row: 27, cols: 3, rows: 4 }, door: { col: 6, row: 31 } },
  { type: 'ultrasound', rect: { col: 9, row: 28, cols: 2, rows: 3 }, door: { col: 9, row: 31 } },
  { type: 'ct', rect: { col: 12, row: 27, cols: 4, rows: 4 }, door: { col: 13, row: 31 } },
  { type: 'mri', rect: { col: 17, row: 27, cols: 4, rows: 4 }, door: { col: 18, row: 31 } },
  { type: 'nucMed', rect: { col: 22, row: 27, cols: 3, rows: 4 }, door: { col: 23, row: 31 } },
  { type: 'dialysis', rect: { col: 26, row: 27, cols: 3, rows: 4 }, door: { col: 27, row: 31 } },
  { type: 'surgery', rect: { col: 30, row: 27, cols: 4, rows: 4 }, door: { col: 31, row: 31 } },
];

/**
 * The layout arm (owner ask 2026-07-19). Identical to REFERENCE_BUILD except
 * triage moves next to the entrance (20,39): door 3 tiles away instead of 18.
 * Everything else — room count, sizes, staffing, cash — is held constant, so a
 * difference is attributable to the WALK and nothing else.
 */
const NEAR_TRIAGE_BUILD: RoomSpec[] = REFERENCE_BUILD.map((r) =>
  r.type === 'triage'
    ? { type: 'triage', rect: { col: 22, row: 36, cols: 2, rows: 2 }, door: { col: 22, row: 38 } }
    : r,
);

const EXPANSION_WING: readonly RoomType[] = [
  'ultrasound', 'ct', 'mri', 'nucMed', 'dialysis', 'surgery',
];

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
  ticks: number;
  /** Ticks in which >=1 reservation was ACTIVE on a room of this type,
   *  divided by (ticks x rooms of that type) at print time. */
  roomBusyTicks: Map<RoomType, number>;
  roomCount: Map<RoomType, number>;
  /** Ticks in which this staffer held >=1 reservation, summed over the role. */
  roleBusyTicks: Map<RoleId, number>;
  roleCount: Map<RoleId, number>;
  /** Ticks in which a `capacity:<type>` row was present in the panel. */
  capacityHintTicks: Map<string, number>;
  /** Distinct hint keys ever seen, for the wording audit. */
  hintLabels: Map<string, string>;
  /** Of the ticks a ROOM-capacity row was shown, those where a required-role
   *  staffer was simultaneously IDLE — i.e. the room was reserved, not the
   *  binding constraint, and "build another one" was the wrong remedy. */
  roomHintWithIdleStaff: Map<string, number>;
  visits: Map<RoomType, number>;
  /**
   * IMAGING_4B pre-impl review MAJORs 4, 5, 6a and 10 — the counters the §4B
   * falsification set names but no probe could produce. All land BEFORE the
   * change they guard (the harness.test.ts:287-289 rule).
   */
  /** Discharges by condition — the per-condition floor for X-ray preemption
   *  (MAJOR 5: acuity-1 chestPain outranks fresh fracture at the single slot). */
  dischargedByCondition: Map<ConditionId, number>;
  /** Arrivals by condition — the denominator. Revenue/ARRIVAL, not
   *  revenue/completion, is what MAJOR 4 says can move while profit hides it. */
  arrivedByCondition: Map<ConditionId, number>;
  /** Elective referrals arrived vs completed (MAJOR 6a: the §4B falsifier that
   *  existed in NEITHER probe). */
  electiveArrived: number;
  electiveDischarged: number;
  /** Ticks this role held an ACTIVE reservation — scanning, not walking.
   *  `roleBusyTicks` counts gather too, and at a 4.25:1 gather:treat ratio it
   *  is dominated by walking (review MINOR). Report both or read neither. */
  roleActiveTicks: Map<RoleId, number>;
  /** MAJOR 10: xray is `failure: mechanical`, MTBF ~31 uses, and §4B raises
   *  its use ~54%. A broken room returns capacity 0 — with ONE maintenance
   *  tech and acuity-1 patients now depending on it. */
  breakdownsByRoom: Map<RoomType, number>;
  roomBrokenTicks: Map<RoomType, number>;
  totalRevenue: number;
  totalArrived: number;
  died: number;
  ama: number;
}

function run(seed: number, days: number, build: RoomSpec[] = REFERENCE_BUILD): Probe {
  const events = new EventBus();
  const world = new World(events, seed);
  setupNewGame(world);
  world.cash += build
    .filter((r) => EXPANSION_WING.includes(r.type))
    .reduce((sum, r) => sum + ROOM_DEFS[r.type].cost, 0);
  for (const spec of build) world.buildRoom(spec.type, spec.rect, spec.door);
  // The edProbe.test.ts:420-436 guard, for the same reason: `buildRoom`
  // REJECTS SILENTLY, so a compact rect overlapping the pre-built reception/
  // waiting would simply not exist and the arm would measure 12 rooms against
  // 13 while reporting a layout effect (DEPARTMENTS_PLAN §3.2 risk 1).
  const expected = build.length + 2; // + pre-built reception and waiting
  if (world.rooms.size !== expected) {
    throw new Error(`layout invalid: expected ${expected} rooms, built ${world.rooms.size}`);
  }
  // Mirrors edProbe's roster construction exactly (skill 3, table salary), so
  // the numbers are comparable with §3.8's and §5b's.
  for (const { role, count } of STAFF) {
    for (let i = 0; i < count; i++) {
      world.addStaffMember(role, 3, ROLE_DEFS[role].salaryPerDay);
    }
  }

  const p: Probe = {
    seed,
    ticks: TICKS_PER_DAY * days,
    roomBusyTicks: new Map(),
    roomCount: new Map(),
    roleBusyTicks: new Map(),
    roleCount: new Map(),
    capacityHintTicks: new Map(),
    hintLabels: new Map(),
    roomHintWithIdleStaff: new Map(),
    visits: new Map(),
    dischargedByCondition: new Map(),
    arrivedByCondition: new Map(),
    electiveArrived: 0,
    electiveDischarged: 0,
    roleActiveTicks: new Map(),
    breakdownsByRoom: new Map(),
    roomBrokenTicks: new Map(),
    totalRevenue: 0,
    totalArrived: 0,
    died: 0,
    ama: 0,
  };

  // Condition is read off the LIVE patient at each moment (the harness.test.ts
  // :177 precedent) — `patientDischarged` carries no condition, and the
  // patient still exists when it fires.
  events.on('patientSpawned', ({ patientId }) => {
    const patient = world.patients.get(patientId);
    if (patient === undefined) return;
    p.totalArrived += 1;
    p.arrivedByCondition.set(patient.condition, (p.arrivedByCondition.get(patient.condition) ?? 0) + 1);
    if (conditionElective(patient.condition)) p.electiveArrived += 1;
  });
  events.on('patientDischarged', ({ patientId, totalBilled }) => {
    p.totalRevenue += totalBilled;
    const patient = world.patients.get(patientId);
    if (patient === undefined) return;
    p.dischargedByCondition.set(
      patient.condition,
      (p.dischargedByCondition.get(patient.condition) ?? 0) + 1,
    );
    if (conditionElective(patient.condition)) p.electiveDischarged += 1;
  });
  events.on('patientDied', () => (p.died += 1));
  events.on('patientLeftAma', () => (p.ama += 1));
  events.on('roomBroken', ({ roomId }) => {
    const room = world.rooms.get(roomId);
    if (room === undefined) return;
    p.breakdownsByRoom.set(room.type, (p.breakdownsByRoom.get(room.type) ?? 0) + 1);
  });

  for (const room of world.rooms.values()) {
    p.roomCount.set(room.type, (p.roomCount.get(room.type) ?? 0) + 1);
  }
  for (const staff of world.staff.values()) {
    p.roleCount.set(staff.role, (p.roleCount.get(staff.role) ?? 0) + 1);
  }

  const bump = <K>(m: Map<K, number>, k: K): void => {
    m.set(k, (m.get(k) ?? 0) + 1);
  };

  for (let i = 0; i < p.ticks; i++) {
    world.tick();

    // Room occupancy: an ACTIVE reservation means the machine is in use.
    // `gathering` deliberately does not count — a room awaiting staff is idle
    // capacity, which is the distinction the whole balance question turns on.
    for (const room of world.rooms.values()) {
      const active = world.reservationsOn(room.id).filter((r) => r.phase === 'active');
      if (active.length > 0) bump(p.roomBusyTicks, room.type);
    }

    // Staff load: holding any reservation at all, active or gathering. A
    // staffer walking to a room is NOT available to anyone else, so for a
    // utilisation question (unlike the attention penalty, which is
    // activeOnly) the walk counts.
    for (const staff of world.staff.values()) {
      if (staff.duty.kind !== 'reserved') continue;
      bump(p.roleBusyTicks, staff.role);
      // ACTIVE-only: the same staffer, but counted only while the reservation
      // they hold is actually being treated. The gap between this and the line
      // above IS the walk (review MINOR — a radTech "utilisation" that moves
      // because a chain grew a gather has not told you the scanner got busier).
      const res = world.reservations.get(staff.duty.reservationId);
      if (res?.phase === 'active') bump(p.roleActiveTicks, staff.role);
    }

    for (const room of world.rooms.values()) {
      if (room.brokenSince !== null) bump(p.roomBrokenTicks, room.type);
    }

    // The hint audit. computeBlockedNeeds is pure and mutates nothing but
    // `hintedOnce`, which the panel path already tolerates being called every
    // tick (blockedPanel recomputes on tick change).
    for (const need of computeBlockedNeeds(world)) {
      if (need.kind !== 'capacity') continue;
      bump(p.capacityHintTicks, need.key);
      p.hintLabels.set(need.key, need.label);
      // THE DECISIVE QUESTION for the hint fix. A room-capacity row
      // ("build another one") is only the right remedy if the ROOM is what
      // binds. If a staffer of a required role is sitting idle at the same
      // tick, the room is merely RESERVED — held by a gather that is waiting
      // on someone else — and a second room would not have helped. The
      // `continue` at needs.ts:375 means the code never asks this.
      if (need.role !== undefined || need.room === undefined) continue;
      const idleFree = ROOM_DEFS[need.room].staffedBy.some((role: RoleId) =>
        [...world.staff.values()].some(
          (s) => s.role === role && !s.firing && s.duty.kind === 'idle',
        ),
      );
      if (idleFree) bump(p.roomHintWithIdleStaff, need.key);
    }
  }

  for (const room of world.rooms.values()) {
    p.visits.set(room.type, (p.visits.get(room.type) ?? 0) + room.visitsTotal);
  }
  return p;
}

// `process` is not in this project's DOM/vite tsconfig types, and adding
// @types/node for one env read is not worth it (edProbe.test.ts:316 precedent).
declare const process: { env: Record<string, string | undefined> } | undefined;
const describeProbe =
  typeof process !== 'undefined' && process.env.UTIL_PROBE ? describe : describe.skip;

describeProbe('Utilisation probe (DEPARTMENTS_PLAN §4.4)', () => {
  it('prints per-room utilisation, per-role utilisation and capacity-hint frequency', () => {
    const seeds = [1337, 1338, 1339, 1340, 1341];
    const days = 5;
    const runs = seeds.map((s) => run(s, days));

    const pct = (n: number, d: number): string =>
      d === 0 ? '   n/a' : `${((100 * n) / d).toFixed(1).padStart(5)}%`;
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

    console.log(`\n=== PER-ROOM UTILISATION (${seeds.length} seeds x ${days} days) ===`);
    console.log('room          rooms   visits/day   utilisation');
    // Every run uses the same REFERENCE_BUILD, so run 0's counts are the
    // roster for all of them. `noUncheckedIndexedAccess` still needs the guard.
    const first = runs[0];
    if (first === undefined) throw new Error('no runs');
    const roomTypes = [...new Set(runs.flatMap((r) => [...r.roomCount.keys()]))];
    for (const type of roomTypes) {
      const count = first.roomCount.get(type) ?? 0;
      const util = mean(
        runs.map((r) => (r.roomBusyTicks.get(type) ?? 0) / (r.ticks * Math.max(1, count))),
      );
      const visitsPerDay = mean(runs.map((r) => (r.visits.get(type) ?? 0) / days));
      console.log(
        `${ROOM_DEFS[type].label.padEnd(22)}${String(count).padStart(2)}` +
          `${visitsPerDay.toFixed(1).padStart(12)}   ${pct(util, 1)}`,
      );
    }

    console.log(`\n=== PER-ROLE UTILISATION ===`);
    console.log('role                  hired   utilisation');
    const roles = [...new Set(runs.flatMap((r) => [...r.roleCount.keys()]))];
    for (const role of roles) {
      const count = first.roleCount.get(role) ?? 0;
      const util = mean(
        runs.map((r) => (r.roleBusyTicks.get(role) ?? 0) / (r.ticks * Math.max(1, count))),
      );
      console.log(
        `${ROLE_DEFS[role].label.padEnd(24)}${String(count).padStart(2)}   ${pct(util, 1)}`,
      );
    }

    console.log(`\n=== CAPACITY HINT FREQUENCY (% of ticks the row is shown) ===`);
    console.log("key                            shown  wrong-remedy  label");
    console.log("(wrong-remedy = share of shown ticks with a required role IDLE)");
    const keys = [...new Set(runs.flatMap((r) => [...r.capacityHintTicks.keys()]))].sort();
    if (keys.length === 0) {
      console.log('  (no capacity hint fired in any seed)');
    }
    for (const key of keys) {
      const share = mean(runs.map((r) => (r.capacityHintTicks.get(key) ?? 0) / r.ticks));
      const label = runs.find((r) => r.hintLabels.has(key))?.hintLabels.get(key) ?? '';
      // Of the ticks this ROOM row was shown, how often was a required-role
      // staffer idle? High = the room was merely reserved and the remedy was
      // wrong. Blank for role-specific rows, which are not room remedies.
      const wrong = mean(
        runs.map((r) => {
          const shown = r.capacityHintTicks.get(key) ?? 0;
          return shown === 0 ? 0 : (r.roomHintWithIdleStaff.get(key) ?? 0) / shown;
        }),
      );
      const flag = key.split(':').length > 2 ? '      ' : pct(wrong, 1);
      console.log(`${key.padEnd(30)}${pct(share, 1)}  ${flag}  "${label}"`);
    }
    console.log('');
  });

  /**
   * IMAGING_4B §6 — the baseline table, on BOTH layout arms.
   *
   * This lands BEFORE the chain change it measures and is proven green on the
   * OLD (chestPain = single ER step) build. `harness.test.ts:287-289` states
   * the rule it follows: "a regression of record is worthless if it ships
   * alongside its own change." The same applies to a baseline — a before/after
   * where the "before" was produced by a differently-instrumented probe is not
   * a comparison.
   *
   * Reports, per arm, everything the §4B falsification set names:
   * xray + radTech utilisation (reserved AND active-only), per-condition
   * discharges for the X-ray consumers, elective completion rate, revenue per
   * ARRIVAL, deaths, AMA, and X-ray breakdowns/downtime.
   */
  it('prints the IMAGING_4B baseline on both layout arms', () => {
    const seeds = [1337, 1338, 1339, 1340, 1341];
    const days = 5;
    const arms: { name: string; build: RoomSpec[] }[] = [
      { name: 'REFERENCE', build: REFERENCE_BUILD },
      { name: 'COMPACT', build: COMPACT_BUILD },
    ];
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const spread = (xs: number[]): string => `${Math.min(...xs).toFixed(1)}–${Math.max(...xs).toFixed(1)}`;
    const pct = (n: number): string => `${(100 * n).toFixed(1)}%`;

    for (const { name, build } of arms) {
      const runs = seeds.map((s) => run(s, days, build));
      console.log(`\n=== IMAGING_4B BASELINE — ${name} arm (${seeds.length} seeds x ${days} days) ===`);

      const xrayCount = runs[0]?.roomCount.get('xray') ?? 0;
      const xrayUtil = runs.map((r) => (r.roomBusyTicks.get('xray') ?? 0) / (r.ticks * Math.max(1, xrayCount)));
      const radCount = runs[0]?.roleCount.get('radTech') ?? 0;
      const radBusy = runs.map((r) => (r.roleBusyTicks.get('radTech') ?? 0) / (r.ticks * Math.max(1, radCount)));
      const radActive = runs.map((r) => (r.roleActiveTicks.get('radTech') ?? 0) / (r.ticks * Math.max(1, radCount)));

      console.log(`xray utilisation        ${pct(mean(xrayUtil))}   (per-seed ${spread(xrayUtil.map((x) => 100 * x))})`);
      console.log(`xray visits/day         ${mean(runs.map((r) => (r.visits.get('xray') ?? 0) / days)).toFixed(2)}`);
      console.log(`radTech RESERVED        ${pct(mean(radBusy))}   (per-seed ${spread(radBusy.map((x) => 100 * x))})  <- includes the walk`);
      console.log(`radTech ACTIVE-only     ${pct(mean(radActive))}   (per-seed ${spread(radActive.map((x) => 100 * x))})  <- actual scanning`);

      // The X-ray consumers. MAJOR 5: chestPain arrives at this queue carrying
      // acuity 1-2 PLUS its accumulated wait, so it can outrank a fresh
      // fracture (acuity 3, weight 15) at a single-slot room.
      console.log('per-condition discharges (X-ray consumers + the control):');
      for (const id of ['chestPain', 'fracture', 'pneumonia', 'laceration'] as ConditionId[]) {
        const got = runs.map((r) => r.dischargedByCondition.get(id) ?? 0);
        const arrived = runs.map((r) => r.arrivedByCondition.get(id) ?? 0);
        console.log(
          `  ${CONDITION_DEFS[id].label.padEnd(14)} discharged ${mean(got).toFixed(1).padStart(6)}` +
            `  arrived ${mean(arrived).toFixed(1).padStart(6)}  (per-seed discharged ${spread(got)})`,
        );
      }

      const electiveRate = runs.map((r) => (r.electiveArrived === 0 ? 0 : r.electiveDischarged / r.electiveArrived));
      console.log(`elective completion     ${pct(mean(electiveRate))}   (arrived ${mean(runs.map((r) => r.electiveArrived)).toFixed(1)}, completed ${mean(runs.map((r) => r.electiveDischarged)).toFixed(1)})`);

      // MAJOR 4: per ARRIVAL, not per completion. A patient who now dies
      // mid-chain banks the first step's fee where they previously banked $0,
      // so worse outcomes partially pay for themselves in profit terms.
      console.log(`revenue per ARRIVAL     $${mean(runs.map((r) => r.totalRevenue / Math.max(1, r.totalArrived))).toFixed(0)}`);
      const deaths = runs.map((r) => r.died / days);
      console.log(`deaths/day              ${mean(deaths).toFixed(2)}   (per-seed ${spread(deaths)})  <- NOISE FLOOR for §3.1`);
      console.log(`AMA/day                 ${mean(runs.map((r) => r.ama / days)).toFixed(2)}`);
      console.log(`xray breakdowns         ${mean(runs.map((r) => r.breakdownsByRoom.get('xray') ?? 0)).toFixed(2)}   downtime ${pct(mean(runs.map((r) => (r.roomBrokenTicks.get('xray') ?? 0) / (r.ticks * Math.max(1, xrayCount)))))}`);
    }
    console.log('');
  });

  /**
   * The triage-throughput thread (owner ask 2026-07-19), opened by the hint
   * measurement above: `capacity:triage` is shown 85% of ticks while triage
   * rooms are ACTIVE only 17.3% of the time, and in 68% of those ticks a
   * nurse was idle. That gap is the question — where does the time go?
   *
   * Hypothesis under test: the GATHER dominates the treatment. Triage is 10
   * game-minutes (balance.ts:86), the entrance is (20,39) and the reference
   * triage door is (12,29) — 18 tiles at ~2.1 game-min/tile. If the gather is
   * several times the treatment, then triage throughput is bounded by WALKING,
   * and neither "build another triage bay" nor "hire another nurse" is the
   * first-order remedy: moving triage next to the entrance is.
   */
  it('prints the triage gather-vs-treat split, two layout arms', () => {
    const seeds = [1337, 1338, 1339];
    const days = 5;

    interface Split {
      gatherTicks: number[];
      activeTicks: number[];
      waitPatient: number;
      waitStaff: number;
      waitBoth: number;
      nurse: Map<string, number>;
      queueSamples: number;
      queueSum: number;
      peakQueue: number;
      triaged: number;
    }

    const measure = (build: RoomSpec[]): Split[] =>
      seeds.map((seed) => {
        const events = new EventBus();
        const world = new World(events, seed);
        setupNewGame(world);
        world.cash += build
          .filter((r) => EXPANSION_WING.includes(r.type))
          .reduce((sum, r) => sum + ROOM_DEFS[r.type].cost, 0);
        for (const spec of build) world.buildRoom(spec.type, spec.rect, spec.door);
        for (const { role, count } of STAFF) {
          for (let i = 0; i < count; i++) {
            world.addStaffMember(role, 3, ROLE_DEFS[role].salaryPerDay);
          }
        }

        const s: Split = {
          gatherTicks: [],
          activeTicks: [],
          waitPatient: 0,
          waitStaff: 0,
          waitBoth: 0,
          nurse: new Map(),
          queueSamples: 0,
          queueSum: 0,
          peakQueue: 0,
          triaged: 0,
        };
        const seen = new Map<
          number,
          { gather: number; active: number; wp: number; ws: number; wb: number }
        >();

        for (let i = 0; i < TICKS_PER_DAY * days; i++) {
          world.tick();

          for (const room of world.rooms.values()) {
            if (room.type !== 'triage') continue;
            for (const res of world.reservationsOn(room.id)) {
              let rec = seen.get(res.id);
              if (rec === undefined) {
                rec = { gather: 0, active: 0, wp: 0, ws: 0, wb: 0 };
                seen.set(res.id, rec);
              }
              if (res.phase === 'active') {
                rec.active += 1;
                continue;
              }
              rec.gather += 1;
              // WHO is the room waiting for? Same arrival predicate the
              // promotion uses (dispatcher.ts:816-817), so this decomposition
              // cannot drift from the thing it explains.
              const patient = world.patients.get(res.patientId);
              const staffHere = res.staffIds.every((id) => {
                const m = world.staff.get(id);
                return m !== undefined && world.walkerArrived(m) && world.isInsideRoom(m.at, room);
              });
              const patientHere =
                patient !== undefined &&
                world.walkerArrived(patient) &&
                world.isInsideRoom(patient.at, room);
              if (staffHere && !patientHere) rec.wp += 1;
              else if (patientHere && !staffHere) rec.ws += 1;
              else if (!patientHere && !staffHere) rec.wb += 1;
            }
          }

          for (const staff of world.staff.values()) {
            if (staff.role !== 'nurse') continue;
            let bucket = staff.duty.kind as string;
            if (staff.duty.kind === 'reserved') {
              // NOTE: "in a gather" is NOT travel time. The decomposition
              // above shows it is overwhelmingly a staffer who has already
              // ARRIVED, standing in the room waiting for the patient.
              const res = world.reservations.get(staff.duty.reservationId);
              bucket = res?.phase === 'active' ? 'treating' : 'in a gather (mostly waiting)';
            }
            s.nurse.set(bucket, (s.nurse.get(bucket) ?? 0) + 1);
          }

          const queued = [...world.patients.values()].filter(
            (p) => p.stage.kind === 'waitingTriage',
          ).length;
          s.queueSum += queued;
          s.queueSamples += 1;
          if (queued > s.peakQueue) s.peakQueue = queued;
        }

        for (const rec of seen.values()) {
          // Completed reservations only — one still gathering at the last tick
          // would understate the gather, which is the number under test.
          if (rec.active === 0) continue;
          s.gatherTicks.push(rec.gather);
          s.activeTicks.push(rec.active);
          s.waitPatient += rec.wp;
          s.waitStaff += rec.ws;
          s.waitBoth += rec.wb;
          s.triaged += 1;
        }
        return s;
      });

    const avg = (xs: number[]): number =>
      xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
    const toMin = (ticks: number): string => (ticks * GAME_MINUTES_PER_TICK).toFixed(1);

    const report = (name: string, runs: Split[]): void => {
      const gather = avg(runs.flatMap((r) => r.gatherTicks));
      const active = avg(runs.flatMap((r) => r.activeTicks));
      const wp = runs.reduce((a, r) => a + r.waitPatient, 0);
      const ws = runs.reduce((a, r) => a + r.waitStaff, 0);
      const wb = runs.reduce((a, r) => a + r.waitBoth, 0);
      const wt = Math.max(1, wp + ws + wb);
      console.log(`\n--- ${name} ---`);
      console.log(`triage completions (total)      ${runs.reduce((a, r) => a + r.triaged, 0)}`);
      console.log(`mean GATHER                     ${toMin(gather)} game-min`);
      console.log(`mean ACTIVE                     ${toMin(active)} game-min`);
      console.log(
        `gather : treat                  ${(active === 0 ? 0 : gather / active).toFixed(2)} : 1`,
      );
      console.log(
        `waitingTriage queue             ` +
          `${avg(runs.map((r) => r.queueSum / Math.max(1, r.queueSamples))).toFixed(2)} mean, ` +
          `${Math.max(...runs.map((r) => r.peakQueue))} peak`,
      );
      console.log(
        `gather spent awaiting PATIENT   ${((100 * wp) / wt).toFixed(1)}%` +
          `   (staff ${((100 * ws) / wt).toFixed(1)}%, both ${((100 * wb) / wt).toFixed(1)}%)`,
      );
      const buckets = [...new Set(runs.flatMap((r) => [...r.nurse.keys()]))].sort();
      const totals = runs.map((r) => [...r.nurse.values()].reduce((a, b) => a + b, 0));
      const parts = buckets.map((b) => {
        const share = avg(
          runs.map((r, i) => ((r.nurse.get(b) ?? 0) / Math.max(1, totals[i] ?? 1)) * 100),
        );
        return `${b} ${share.toFixed(1)}%`;
      });
      console.log(`nurse time                      ${parts.join(' · ')}`);
    };

    console.log(`\n=== TRIAGE LAYOUT ARMS (${seeds.length} seeds x ${days} days) ===`);
    report('FAR triage — reference build, door 18 tiles from the entrance', measure(REFERENCE_BUILD));
    report('NEAR triage — door 3 tiles from the entrance', measure(NEAR_TRIAGE_BUILD));
    console.log('');
  });
});
