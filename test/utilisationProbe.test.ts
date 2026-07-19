import { describe, it } from 'vitest';

import { GAME_MINUTES_PER_TICK, TICKS_PER_DAY } from '../src/sim/clock';
import { ROLE_DEFS, type RoleId } from '../src/sim/data/roles';
import { ROOM_DEFS, type RoomType } from '../src/sim/data/rooms';
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
}

function run(seed: number, days: number): Probe {
  const events = new EventBus();
  const world = new World(events, seed);
  setupNewGame(world);
  world.cash += REFERENCE_BUILD
    .filter((r) => EXPANSION_WING.includes(r.type))
    .reduce((sum, r) => sum + ROOM_DEFS[r.type].cost, 0);
  for (const spec of REFERENCE_BUILD) world.buildRoom(spec.type, spec.rect, spec.door);
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
  };

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
      if (staff.duty.kind === 'reserved') bump(p.roleBusyTicks, staff.role);
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
  it('prints the triage gather-vs-treat split and the nurse time budget', () => {
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
    }

    const runs: Split[] = seeds.map((seed) => {
      const events = new EventBus();
      const world = new World(events, seed);
      setupNewGame(world);
      world.cash += REFERENCE_BUILD
        .filter((r) => EXPANSION_WING.includes(r.type))
        .reduce((sum, r) => sum + ROOM_DEFS[r.type].cost, 0);
      for (const spec of REFERENCE_BUILD) world.buildRoom(spec.type, spec.rect, spec.door);
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
      };
      // reservationId -> ticks seen in each phase, for triage reservations only.
      const seen = new Map<
        number,
        { gather: number; active: number; waitPatient: number; waitStaff: number; waitBoth: number }
      >();

      for (let i = 0; i < TICKS_PER_DAY * days; i++) {
        world.tick();

        for (const room of world.rooms.values()) {
          if (room.type !== 'triage') continue;
          for (const res of world.reservationsOn(room.id)) {
            let rec = seen.get(res.id);
            if (rec === undefined) {
              rec = { gather: 0, active: 0, waitPatient: 0, waitStaff: 0, waitBoth: 0 };
              seen.set(res.id, rec);
            }
            if (res.phase === 'active') {
              rec.active += 1;
            } else {
              rec.gather += 1;
              // WHO is the room waiting for? Same arrival predicate the
              // promotion uses (dispatcher.ts:816-817), so this decomposition
              // cannot drift from the thing it explains.
              const inRoom = (w: { at: GridPoint }): boolean =>
                world.isInsideRoom(w.at, room);
              const patient = world.patients.get(res.patientId);
              const staffHere = res.staffIds.every((id) => {
                const m = world.staff.get(id);
                return m !== undefined && world.walkerArrived(m) && inRoom(m);
              });
              const patientHere =
                patient !== undefined && world.walkerArrived(patient) && inRoom(patient);
              if (staffHere && !patientHere) rec.waitPatient += 1;
              else if (patientHere && !staffHere) rec.waitStaff += 1;
              else if (!patientHere && !staffHere) rec.waitBoth += 1;
            }
          }
        }

        // Where does a nurse's day actually go?
        for (const staff of world.staff.values()) {
          if (staff.role !== 'nurse') continue;
          let bucket = staff.duty.kind as string;
          if (staff.duty.kind === 'reserved') {
            // Split the reserved bucket: walking to the room vs treating in it.
            const res = world.reservations.get(staff.duty.reservationId);
            // NOTE: "in a gather" is NOT all walking. The decomposition below
            // shows 88.8% of triage gather ticks are a staffer who has already
            // ARRIVED, standing in the room waiting for the patient. Do not
            // read this bucket as travel time.
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
        if (rec.active > 0) {
          s.gatherTicks.push(rec.gather);
          s.activeTicks.push(rec.active);
          s.waitPatient += rec.waitPatient;
          s.waitStaff += rec.waitStaff;
          s.waitBoth += rec.waitBoth;
        }
      }
      return s;
    });

    const flatGather = runs.flatMap((r) => r.gatherTicks);
    const flatActive = runs.flatMap((r) => r.activeTicks);
    const avg = (xs: number[]): number =>
      xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
    const toMin = (ticks: number): string => (ticks * GAME_MINUTES_PER_TICK).toFixed(1);

    console.log(`\n=== TRIAGE: GATHER vs TREAT (${seeds.length} seeds x ${days} days) ===`);
    console.log(`completed triage reservations   ${flatActive.length}`);
    console.log(`mean GATHER (walk/wait)         ${toMin(avg(flatGather))} game-min`);
    console.log(`mean ACTIVE (treatment)         ${toMin(avg(flatActive))} game-min`);
    const ratio = avg(flatActive) === 0 ? 0 : avg(flatGather) / avg(flatActive);
    console.log(`gather : treat                  ${ratio.toFixed(2)} : 1`);
    console.log(
      `mean waitingTriage queue        ` +
        `${avg(runs.map((r) => r.queueSum / Math.max(1, r.queueSamples))).toFixed(2)}` +
        `   peak ${Math.max(...runs.map((r) => r.peakQueue))}`,
    );

    // THE decomposition. If the room is mostly awaiting the PATIENT, then the
    // slot is held during a walk nobody can shorten by hiring or building, and
    // the remedy is layout (or not holding the slot during the walk at all).
    const wp = runs.reduce((a, r) => a + r.waitPatient, 0);
    const ws = runs.reduce((a, r) => a + r.waitStaff, 0);
    const wb = runs.reduce((a, r) => a + r.waitBoth, 0);
    const wt = Math.max(1, wp + ws + wb);
    console.log(`\n=== WHO IS THE TRIAGE ROOM WAITING FOR? (share of gather ticks) ===`);
    console.log(`staff there, awaiting PATIENT   ${((100 * wp) / wt).toFixed(1)}%`);
    console.log(`patient there, awaiting STAFF   ${((100 * ws) / wt).toFixed(1)}%`);
    console.log(`awaiting BOTH                   ${((100 * wb) / wt).toFixed(1)}%`);

    console.log(`\n=== NURSE TIME BUDGET (share of nurse-ticks) ===`);
    const buckets = [...new Set(runs.flatMap((r) => [...r.nurse.keys()]))].sort();
    const totals = runs.map((r) => [...r.nurse.values()].reduce((a, b) => a + b, 0));
    for (const b of buckets) {
      const share = avg(
        runs.map((r, i) => ((r.nurse.get(b) ?? 0) / Math.max(1, totals[i] ?? 1)) * 100),
      );
      console.log(`${b.padEnd(24)}${share.toFixed(1).padStart(6)}%`);
    }
    console.log('');
  });
});
