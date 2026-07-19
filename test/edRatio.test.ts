import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { BALANCE } from '../src/sim/data/balance';
import { ROLE_DEFS, ROLE_IDS, type RoleId } from '../src/sim/data/roles';
import { ROOM_DEFS, type RoomType } from '../src/sim/data/rooms';
import type { Patient } from '../src/sim/entities/patient';
import type { Room } from '../src/sim/entities/room';
import { attentionSkill, staffRatioFor, successChance } from '../src/sim/formulas';
import { setupNewGame } from '../src/sim/newGame';
import { loadWorld, SAVE_VERSION, saveToString, type SaveData } from '../src/sim/save';
import { updateTreatment } from '../src/sim/systems/treatment';
import { updateDispatcher } from '../src/sim/systems/dispatcher';
import { ORTHOGONAL_STEPS, samePoint, type GridPoint } from '../src/sim/types';
import { World } from '../src/sim/world';

/**
 * ED epic Stage B1 — ratio staffing (docs/ED_IMPL_PLAN.md §6). One staffer may
 * hold up to N concurrent reservations IN ONE ROOM (ED nurse/doctor 1:4,
 * everything else 1:1 by construction), sharing costs TIME via the attention
 * penalty, and the ED's bed density doubled so a minimum 3×4 derives 2 bays.
 *
 * Renderer-free and deterministic like every sim suite.
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

function waitingPatient(world: World, condition: Patient['condition'], acuity = 2): Patient {
  const p = world.spawnPatient(condition);
  p.stage = { kind: 'waiting' };
  p.acuity = acuity;
  p.waitingSince = world.clock.tick;
  return p;
}

/** Free-build helper: door on the south edge's middle (capacity.test.ts style). */
function build(
  world: World,
  type: RoomType,
  rect: { col: number; row: number; cols: number; rows: number },
): Room {
  world.buildRoom(type, rect, { col: rect.col + 1, row: rect.row + rect.rows }, true);
  return [...world.rooms.values()].filter((r) => r.type === type).at(-1)!;
}

/** Tick until nothing on this room is still gathering (bounded — movement is real). */
function walkEveryoneIn(world: World, room: Room, limit = 5000): void {
  let guard = 0;
  while (world.reservationsOn(room.id).some((r) => r.phase === 'gathering') && guard++ < limit) {
    world.tick();
  }
}

/**
 * THE shared-panel fixture: a 4-bay ER, ONE nurse, and `patients` nurse-only
 * cases. Idle-first has nobody else to pull, so the ratio shares her across
 * every bay — the short-staffed case B1 exists for.
 */
function panelWorld(patients = 4, seed = 42) {
  const t = setup(seed);
  const room = build(t.world, 'er', { col: 20, row: 20, cols: 4, rows: 6 });
  hire(t.world, 'nurse', 1);
  for (let i = 0; i < patients; i++) waitingPatient(t.world, 'laceration', 3);
  t.world.tick();
  const nurse = [...t.world.staff.values()].find((s) => s.role === 'nurse')!;
  return { ...t, room, nurse };
}

// --------------------------------------------------------------- ratio core

describe('ratio core (§2, §3.2)', () => {
  it('one nurse serves 2 concurrent ER reservations when short-staffed', () => {
    const { world, room, nurse } = panelWorld(2);
    const reservations = world.reservationsOn(room.id);
    expect(reservations).toHaveLength(2);
    // ONE staffer across both bays — pre-B1 this was one reservation and an
    // idle bay, because `idleStaff` required duty.kind === 'idle'.
    expect(new Set(reservations.flatMap((r) => r.staffIds))).toEqual(new Set([nurse.id]));
    expect(world.staffLoadIn(nurse.id, room.id)).toBe(2);
    // `duty` is now one WITNESS of a panel, not "the" reservation.
    expect(nurse.duty.kind).toBe('reserved');
    expect(world.stageViolations).toEqual([]);
  });

  it('the 5th concurrent patient does NOT bind a 1:4 nurse', () => {
    const { world, room, nurse } = panelWorld(0);
    // A 6-bay ER so capacity is never the binding constraint — the RATIO is.
    world.expandRoom(room.id, { col: 20, row: 20, cols: 6, rows: 6 }, true);
    expect(world.capacityOf(room)).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < 6; i++) waitingPatient(world, 'laceration', 3);
    world.tick();
    expect(world.reservationsOn(room.id)).toHaveLength(
      staffRatioFor('er', 'nurse'), // 4 — the cap, not the bed count
    );
    expect(world.staffLoadIn(nurse.id, room.id)).toBe(4);
    // And a fresh pass does not sneak a 5th past the cap.
    world.tick();
    expect(world.staffLoadIn(nurse.id, room.id)).toBe(4);
    expect(world.stageViolations).toEqual([]);
  });

  it('a NON-ED room still needs one staffer per reservation', () => {
    const { world } = setup();
    const room = build(world, 'dialysis', { col: 20, row: 20, cols: 3, rows: 4 });
    hire(world, 'nurse', 1);
    waitingPatient(world, 'kidneyFailure');
    waitingPatient(world, 'kidneyFailure');
    world.tick();
    // 2 machines, 2 patients, 1 nurse → exactly 1 reservation. Dialysis has no
    // `staffRatio`, so N=1 and this is byte-for-byte pre-B1 behaviour.
    expect(world.capacityOf(room)).toBe(2);
    expect(world.reservationsOn(room.id)).toHaveLength(1);
    expect(world.stageViolations).toEqual([]);
  });

  it('staffRatioFor answers 1 for every (room, role) pair without an entry', () => {
    // Mechanical sweep: the ONE reader must default to today's exclusive
    // binding everywhere the data does not deliberately say otherwise.
    for (const type of Object.keys(ROOM_DEFS) as RoomType[]) {
      // `ROOM_DEFS` is an `as const` table, so the optional field only exists
      // on the ONE member that declares it — read it through the RoomDef shape.
      const declared = (ROOM_DEFS[type] as { staffRatio?: Partial<Record<RoleId, number>> })
        .staffRatio;
      for (const role of ROLE_IDS) {
        const expected = declared?.[role] ?? 1;
        expect(staffRatioFor(type, role), `${type}/${role}`).toBe(expected);
        if (declared?.[role] === undefined) expect(staffRatioFor(type, role)).toBe(1);
      }
      // A ratio for a role the room never staffs would be dead data.
      for (const role of Object.keys(declared ?? {}) as RoleId[]) {
        expect(ROOM_DEFS[type].staffedBy, `${type} ratio names a staffed role`).toContain(role);
      }
    }
    // The one room that DOES declare one.
    expect(staffRatioFor('er', 'nurse')).toBe(4);
    expect(staffRatioFor('er', 'doctor')).toBe(4);
    expect(staffRatioFor('er', 'evs')).toBe(1);
  });
});

// -------------------------------------------------------- attention penalty

describe('the attention penalty (§2b)', () => {
  it('is the identity at load 1 — every non-ratio room is bit-identical to pre-B1', () => {
    for (let skill = BALANCE.stats.min; skill <= BALANCE.stats.max; skill++) {
      expect(attentionSkill(skill, 1)).toBe(skill);
    }
  });

  it('discounts 0.5 per extra concurrent patient: skill 4 across 4 bays treats as 2.5', () => {
    expect(BALANCE.treatment.attentionSkillPenaltyPerPatient).toBe(0.5);
    expect(attentionSkill(4, 4)).toBe(2.5);
    expect(attentionSkill(4, 2)).toBe(3.5);
    expect(attentionSkill(4, 3)).toBe(3);
  });

  it('clamps to the BALANCE.stats scale at BOTH ends', () => {
    // Floor: a skill-1 nurse across 4 bays cannot fall below the scale.
    expect(attentionSkill(BALANCE.stats.min, 4)).toBe(BALANCE.stats.min);
    expect(attentionSkill(2, 99)).toBe(BALANCE.stats.min);
    // Ceiling: load 0 (and any load < 1) must not become a BONUS.
    expect(attentionSkill(BALANCE.stats.max, 0)).toBe(BALANCE.stats.max);
    expect(attentionSkill(BALANCE.stats.max + 3, 1)).toBe(BALANCE.stats.max);
  });

  it('a SHARED nurse treats each bay more slowly than a solo one (same skill, same room)', () => {
    // Same seed, same room rect (hence same quality), same condition, same
    // step, same skill-3 nurse. The ONLY difference is her concurrent load.
    const solo = panelWorld(1);
    walkEveryoneIn(solo.world, solo.room);
    const soloRes = solo.world.reservationsOn(solo.room.id)[0]!;
    expect(soloRes.phase).toBe('active');

    const shared = panelWorld(2);
    walkEveryoneIn(shared.world, shared.room);
    const sharedRes = shared.world.reservationsOn(shared.room.id);
    expect(sharedRes).toHaveLength(2);
    expect(sharedRes.every((r) => r.phase === 'active')).toBe(true);
    expect(shared.world.staffLoadIn(shared.nurse.id, shared.room.id)).toBe(2);

    // Sharing costs TIME — the currency the player already reads.
    expect(sharedRes[0]!.ticksRemaining).toBeGreaterThan(soloRes.ticksRemaining);
    expect(solo.world.stageViolations).toEqual([]);
    expect(shared.world.stageViolations).toEqual([]);
  });

  it('successChance is PROVABLY unaffected by load — it consumes RAW skill', () => {
    // Not a tautology on the pure function: this captures the probability
    // `updateTreatment` actually rolls against, on a nurse at load 2, and
    // pins it to her RAW skill. Deaths stay tied to a health/acuity story.
    const { world, room, nurse } = panelWorld(2);
    walkEveryoneIn(world, room);
    const [first] = world.reservationsOn(room.id);
    expect(world.staffLoadIn(nurse.id, room.id)).toBe(2);
    first!.ticksRemaining = 1;
    const patient = world.patients.get(first!.patientId)!;

    const rolled: number[] = [];
    const realChance = world.rng.chance.bind(world.rng);
    world.rng.chance = (p: number): boolean => {
      rolled.push(p);
      return realChance(p);
    };
    const healthAtRoll = patient.health;
    updateTreatment(world);
    world.rng.chance = realChance;

    expect(rolled).toHaveLength(1);
    expect(rolled[0]).toBe(successChance(nurse.skill, healthAtRoll));
    // …and the discounted skill WOULD have produced a different number, so
    // the assertion above is not accidentally true.
    const discounted = attentionSkill(nurse.skill, 2);
    expect(discounted).not.toBe(nurse.skill);
    expect(successChance(discounted, healthAtRoll)).not.toBe(rolled[0]);
  });
});

// ------------------------------------------------------------- release path

describe('releaseReservation with a live panel (§3.4)', () => {
  it('a death in bay 1 leaves the nurse bound to the others — duty re-pointed, path untouched', () => {
    const { world, room, nurse } = panelWorld(4);
    walkEveryoneIn(world, room);
    const before = world.reservationsOn(room.id);
    expect(before).toHaveLength(4);
    const pathBefore = [...nurse.path];
    const targetBefore = nurse.target;
    const atBefore = { ...nurse.at };

    const doomed = world.patients.get(before[0]!.patientId)!;
    world.killPatient(doomed);

    // Three bays survive, and she is still on ALL of them.
    const after = world.reservationsOn(room.id);
    expect(after).toHaveLength(3);
    expect(world.staffLoadIn(nurse.id, room.id)).toBe(3);
    expect(nurse.duty.kind).toBe('reserved');
    if (nurse.duty.kind !== 'reserved') return;
    // The witness re-points to a SURVIVING reservation, preferring an active
    // one (the duty label used to lie: "Walking to a patient" while treating).
    const witness = world.reservations.get(nurse.duty.reservationId);
    expect(witness, 'witness resolves').toBeDefined();
    expect(witness!.staffIds).toContain(nurse.id);
    expect(after.some((r) => r.id === witness!.id)).toBe(true);
    expect(witness!.phase).toBe('active');
    // NOT idled, NOT stepped out — a death in bay 1 must not free her.
    expect(nurse.path).toEqual(pathBefore);
    expect(nurse.target).toBe(targetBefore);
    expect(nurse.at).toEqual(atBefore);
    expect(world.stageViolations).toEqual([]);
  });

  it('the LAST release idles her and clears path + target', () => {
    const { world, room, nurse } = panelWorld(3);
    walkEveryoneIn(world, room);
    const all = world.reservationsOn(room.id);
    expect(all).toHaveLength(3);
    for (const r of all.slice(0, 2)) world.killPatient(world.patients.get(r.patientId)!);
    expect(nurse.duty.kind, 'still held by the last bay').toBe('reserved');

    const bayTarget = nurse.target;
    world.killPatient(world.patients.get(all[2]!.patientId)!);
    expect(world.reservationsOn(room.id)).toHaveLength(0);
    expect(nurse.duty.kind).toBe('idle');
    expect(world.staffLoadIn(nurse.id, room.id)).toBe(0);
    // The stale walk to the released bay is gone, and the walled-room step-out
    // has aimed her OUT of the ER — so "Someone is inside" can't pin a sale on
    // an idle loiterer (Flow rules 9/11).
    expect(nurse.target).not.toBe(bayTarget);
    expect(nurse.target, 'stepping out').not.toBeNull();
    expect(world.isInsideRoom(nurse.target!, room), 'target is outside the ER').toBe(false);
    expect(world.stageViolations).toEqual([]);
  });

  it('a FIRING nurse with a live panel survives until the last release and takes no new patients', () => {
    const { world, room, nurse, queue, apply } = panelWorld(2);
    walkEveryoneIn(world, room);
    const held = world.reservationsOn(room.id);
    expect(held).toHaveLength(2);

    queue.push({ type: 'fireStaff', staffId: nurse.id });
    apply();
    // Both are ACTIVE, so she is flagged and finishes what she is treating.
    expect(nurse.firing).toBe(true);
    expect(world.staff.has(nurse.id)).toBe(true);
    expect(world.reservationsOn(room.id)).toHaveLength(2);

    // …and takes NO new patients meanwhile — `availableStaff` excludes firing.
    waitingPatient(world, 'laceration', 3);
    world.tick();
    expect(world.reservationsOn(room.id)).toHaveLength(2);

    for (const r of world.reservationsOn(room.id).slice(0, 1)) {
      world.killPatient(world.patients.get(r.patientId)!);
    }
    expect(world.staff.has(nurse.id), 'not removed while a bay is live').toBe(true);
    const last = world.reservationsOn(room.id)[0]!;
    world.killPatient(world.patients.get(last.patientId)!);
    // The LAST release honours the deferred firing.
    expect(world.staff.has(nurse.id)).toBe(false);
    expect(world.stageViolations).toEqual([]);
  });

  it('fireStaff on a mixed gathering+active panel cancels the gathering ones and leaves NO dangling staffIds', () => {
    // §3.5's regression: pre-B1 `fireStaff` looked at `duty.reservationId`
    // alone, so firing a ratio nurse holding four bays cancelled ONE and
    // removed her — leaving three reservations naming a deleted staffer, and
    // `promoteGatheredReservations` does `world.staff.get(id)!`.
    const { world, room, nurse, queue, apply } = panelWorld(3);
    walkEveryoneIn(world, room);
    // Re-open a bay and let a fresh patient start GATHERING beside two actives.
    world.killPatient(world.patients.get(world.reservationsOn(room.id)[0]!.patientId)!);
    waitingPatient(world, 'laceration', 3);
    world.tick();
    const mixed = world.reservationsOn(room.id);
    expect(mixed.filter((r) => r.phase === 'active').length).toBeGreaterThan(0);
    expect(mixed.filter((r) => r.phase === 'gathering').length).toBeGreaterThan(0);

    queue.push({ type: 'fireStaff', staffId: nurse.id });
    apply();

    expect(world.reservationsOn(room.id).every((r) => r.phase === 'active')).toBe(true);
    for (const r of world.reservations.values()) {
      for (const id of r.staffIds) {
        expect(world.staff.has(id), `reservation ${r.id} names a live staffer`).toBe(true);
      }
    }
    // The whole panel is still hers, and the sim survives the next tick.
    expect(nurse.firing).toBe(true);
    world.tick();
    expect(world.stageViolations).toEqual([]);
  });

  it('breakRoom on an ER with several gathering reservations releases them ALL', () => {
    const { world, room, nurse } = panelWorld(3);
    expect(world.reservationsOn(room.id)).toHaveLength(3);
    expect(world.reservationsOn(room.id).every((r) => r.phase === 'gathering')).toBe(true);

    world.breakRoom(room);

    expect(world.reservationsOn(room.id)).toHaveLength(0);
    expect(world.reservationsOfStaff(nurse.id)).toEqual([]);
    expect(nurse.duty.kind).toBe('idle');
    expect(world.capacityOf(room)).toBe(0);
    expect(world.stageViolations).toEqual([]);
  });

  it('releaseReservation called twice is a NO-OP the second time', () => {
    const { world, events, room, nurse } = panelWorld(2);
    const [a, b] = world.reservationsOn(room.id);

    let touched = 0;
    events.on('staffUpdated', (e) => {
      if (e.staffId === nurse.id) touched += 1;
    });

    world.releaseReservation(a!);
    expect(touched, 'the real release re-points her witness').toBe(1);
    expect(nurse.duty.kind).toBe('reserved');
    if (nurse.duty.kind !== 'reserved') return;
    expect(nurse.duty.reservationId).toBe(b!.id);

    // A second call on the DETACHED reservation must return at the delete
    // guard: without it the body re-runs against a panel that no longer holds
    // this reservation, and a staffer who has legitimately moved on gets
    // re-pointed, idled or stepped out under a caller-controlled ordering
    // (`fireStaff` is the codebase's first such ordering — review MINOR 7).
    // The event count is the observable: the no-op must touch NOTHING.
    world.releaseReservation(a!);
    expect(touched, 'the second call did nothing at all').toBe(1);
    expect(world.reservations.has(b!.id)).toBe(true);
    expect(nurse.duty.kind).toBe('reserved');
    expect(world.staffLoadIn(nurse.id, room.id)).toBe(1);
    expect(world.stageViolations).toEqual([]);
  });
});

// ---------------------------------------------------------------- dispatch

describe('dispatch under the ratio (§3.2, §3.3, §3.6)', () => {
  it('the soft hold reserves ONE unit, not the whole ratio staffer', () => {
    /*
     * NON-VACUITY PROOF (the anesthesia precedent, §3.6):
     *
     * Revert dispatcher.ts's `availableStaff` units term —
     *   `return load + (hold?.units ?? 0) < staffRatioFor(room.type, s.role);`
     * — to the pre-B1 identity exclusion, i.e. add back into the `eligible`
     * filter (or into assignTreatment's per-role filter):
     *   `if (held?.has(s.id)) return false;`
     * and this test FAILS (verified by actually reverting it): the chest-pain
     * gather secures the DOCTOR and then comes up a nurse short, so he is held
     * by IDENTITY; the fracture below finds no doctor at all and
     * `world.reservations.size` is 0 instead of 1. The whole ratio capacity of
     * a 1:4 ED doctor would be locked out over one missing nurse — exactly the
     * pass-starvation §3.6 exists to prevent.
     *
     * The role ORDER matters and is why this fixture is shaped as it is:
     * chestPain's step is `['doctor', 'nurse']`, so a missing NURSE is the one
     * that leaves something already secured to hold. Hiring the other way
     * round would break out of the role loop with `chosen` empty, nothing
     * would ever be held, and the test would be vacuous under BOTH variants.
     */
    const { world } = setup();
    const room = build(world, 'er', { col: 20, row: 20, cols: 4, rows: 6 });
    hire(world, 'doctor', 1); // NO nurse — the gather will come up short.

    waitingPatient(world, 'chestPain', 1); // acuity 1: served first, doctor THEN nurse
    const fracture = waitingPatient(world, 'fracture', 5); // acuity 5: doctor only
    fracture.stepIndex = 1; // the ED casting step

    world.tick();

    const reservations = world.reservationsOn(room.id);
    expect(reservations, 'the fracture still gets the doctor\'s spare unit').toHaveLength(1);
    const served = world.patients.get(reservations[0]!.patientId)!;
    expect(served.condition).toBe('fracture');
    // One unit held, one unit spent — not the whole 1:4 staffer.
    const doctor = [...world.staff.values()].find((s) => s.role === 'doctor')!;
    expect(world.staffLoadIn(doctor.id, room.id)).toBe(1);
    expect(world.stageViolations).toEqual([]);
  });

  it('a staffer held for ONE room is not handed to another room', () => {
    // The bug the anesthesia soft-hold regression caught, reintroduced through
    // the ratio: a nurse secured by a one-role-short SURGERY must not be given
    // to a lower-priority ER patient just because she has ratio units spare in
    // the ER. A hold is room-scoped — §1's one-staffer-one-room rule.
    const { world } = setup();
    build(world, 'surgery', { col: 10, row: 10, cols: 4, rows: 4 });
    const er = build(world, 'er', { col: 20, row: 20, cols: 4, rows: 6 });
    hire(world, 'surgeon', 1);
    hire(world, 'nurse', 1); // no anesthesiologist — surgery is one role short

    const surgical = world.spawnPatient('appendicitis');
    world.releasePatientHoldings(surgical);
    surgical.stage = { kind: 'waiting' };
    surgical.acuity = 1;
    surgical.stepIndex = 1; // the OR step
    surgical.waitingSince = world.clock.tick;
    waitingPatient(world, 'laceration', 5);

    world.tick();

    expect(world.reservations.size, 'the nurse was NOT given to the ER').toBe(0);
    expect(world.reservationsOn(er.id)).toHaveLength(0);
    const nurse = [...world.staff.values()].find((s) => s.role === 'nurse')!;
    expect(nurse.duty.kind).toBe('idle');
    expect(world.stageViolations).toEqual([]);
  });

  it('makeReservation does not re-path a staffer already gathering', () => {
    const { world, room, nurse } = panelWorld(1);
    const first = world.reservationsOn(room.id)[0]!;
    expect(nurse.duty.kind).toBe('reserved');
    if (nurse.duty.kind !== 'reserved') return;
    expect(nurse.duty.reservationId).toBe(first.id);
    const targetBefore = nurse.target;
    const pathBefore = [...nurse.path];
    expect(targetBefore, 'she is walking to bay 1').not.toBeNull();

    // A second bay binds her while she is still WALKING to the first: the
    // `wasIdle` gate must leave her walk alone. Re-pathing would yank her off
    // the walk her first reservation is gathering on — and would be the only
    // thing that could flip `walkerArrived` false under a gathering one.
    waitingPatient(world, 'laceration', 3);
    world.tick();

    expect(world.reservationsOn(room.id)).toHaveLength(2);
    expect(nurse.duty.kind).toBe('reserved');
    if (nurse.duty.kind !== 'reserved') return;
    expect(nurse.duty.reservationId, 'witness untouched').toBe(first.id);
    expect(nurse.target).toBe(targetBefore);
    expect(nurse.path.length, 'still on the original walk').toBeLessThanOrEqual(pathBefore.length);
    walkEveryoneIn(world, room);
    expect(world.reservationsOn(room.id).every((r) => r.phase === 'active')).toBe(true);
    expect(world.stageViolations).toEqual([]);
  });

  it('assignTriage: ZERO bays returns early — no canReachRoom (A*) per patient', () => {
    // §3.2 MAJOR 1: `availableStaff` needs the room, so the nurse can no
    // longer be picked BEFORE it. Without the `bays.length === 0` guard the
    // reorder would run an A* findPath per waiting patient per tick on the
    // game's busiest funnel. `canStep` is findPath's per-edge probe, so its
    // call count is the observable proxy for "did we path at all".
    function countCanStep(withTriage: boolean): number {
      const { world } = setup();
      if (withTriage) build(world, 'triage', { col: 20, row: 20, cols: 3, rows: 3 });
      for (let i = 0; i < 4; i++) {
        const p = world.spawnPatient('flu');
        p.stage = { kind: 'waitingTriage' };
        p.waitingSince = world.clock.tick;
        world.assignWaitingSpot(p);
      }
      let calls = 0;
      const real = world.canStep.bind(world);
      world.canStep = (a: GridPoint, b: GridPoint): boolean => {
        calls += 1;
        return real(a, b);
      };
      updateDispatcher(world);
      world.canStep = real;
      return calls;
    }
    // Everything else about the two passes is identical, so the DELTA is
    // exactly the per-patient `canReachRoom` the early return skips.
    const withoutBays = countCanStep(false);
    const withBays = countCanStep(true);
    expect(withBays, 'a bay makes the pass path per patient').toBeGreaterThan(withoutBays);
  });

  it('assignTriage: an unreachable bay skips THAT patient, it does not abort the pass', () => {
    const { world } = setup();
    hire(world, 'nurse', 1);
    const triage = build(world, 'triage', { col: 20, row: 20, cols: 3, rows: 3 });
    expect(triage.door, 'the bay has a door').not.toBeNull();

    // Fence the FIRST-waiting patient into a one-tile pocket (grid poke — the
    // established fixture style). `canReachRoom` fails for her, and the guard
    // must `continue`, not `return`.
    const stranded = world.spawnPatient('flu');
    stranded.stage = { kind: 'waitingTriage' };
    stranded.waitingSince = world.clock.tick;
    stranded.at = { col: 2, row: 2 };
    stranded.next = null;
    stranded.path = [];
    stranded.target = null;
    for (const step of ORTHOGONAL_STEPS) {
      world.tileAt(2 + step.col, 2 + step.row)!.walkable = false;
    }

    const reachable = world.spawnPatient('flu');
    reachable.stage = { kind: 'waitingTriage' };
    reachable.waitingSince = world.clock.tick + 1; // later in the sort order
    world.assignWaitingSpot(reachable);

    world.tick();

    const triaged = world.reservationsOn(triage.id);
    expect(triaged, 'the reachable patient was still served').toHaveLength(1);
    expect(triaged[0]!.patientId).toBe(reachable.id);
  });

  it('assignTriage: no nurse aborts the pass — nothing is reserved at all', () => {
    const { world } = setup();
    const triage = build(world, 'triage', { col: 20, row: 20, cols: 3, rows: 3 });
    for (let i = 0; i < 3; i++) {
      const p = world.spawnPatient('flu');
      p.stage = { kind: 'waitingTriage' };
      p.waitingSince = world.clock.tick;
      world.assignWaitingSpot(p);
    }
    world.tick();
    expect(world.reservationsOn(triage.id)).toHaveLength(0);
    // …and the nurse arriving is all it takes (the abort left nothing stuck).
    hire(world, 'nurse', 1);
    world.tick();
    expect(world.reservationsOn(triage.id)).toHaveLength(1);
    expect(world.stageViolations).toEqual([]);
  });
});

// ------------------------------------------------------- triage starvation

/**
 * Contract test 17 (pre-impl review MAJOR 5) — a CHARACTERIZATION suite.
 *
 * The mechanism, read off the shipped code: `availableStaff` admits a
 * `reserved` staffer only when her WITNESS reservation is in the room being
 * dispatched, so a nurse holding ER bays is excluded from a triage bay
 * OUTRIGHT; and `releaseReservation`'s remaining-panel branch means she never
 * returns to `idle` while ANY bay is live. `assignTriage` running FIRST buys
 * nothing — it gates on availability, and she is never available.
 *
 * WHAT I OBSERVED (1 nurse, a triage bay, a 4-bay ER, 1,200 ticks):
 *   • sustained ED inflow  → idle ticks 0, triage reservations 0, the triage
 *     patient still `waitingTriage`; the ER panel never fell below 3. At 4,000
 *     ticks that patient DIED of untriaged health decay.
 *   • finite ED queue      → the ED drains, she idles (471 ticks), triage
 *     fires at tick ~369. So the starvation is LOAD-DEPENDENT, not absolute.
 *   • a rescue nurse hired mid-capture → triage claims her the SAME tick.
 *   • but two nurses hired BEFORE any triage patient exists → BOTH are
 *     absorbed by the 4-bay ED and triage still starves. Headcount alone is
 *     not the remedy; an IDLE nurse at the moment triage asks is.
 *
 * These tests assert exactly that — including that it starves — so the
 * behaviour is recorded and any future carve-out (Title 22 excludes the triage
 * RN from the 1:4 count, so one is available and research-backed) trips them
 * deliberately rather than changing the game by accident. Related: ED_PLAN
 * §5b item 5, surgeries 11.2 → 7.2 on the same nurse-capture mechanism.
 */
describe('triage starvation under a captured ratio nurse (test 17 — characterization)', () => {
  function edWorld(nurses = 1) {
    const t = setup();
    const triage = build(t.world, 'triage', { col: 30, row: 20, cols: 3, rows: 3 });
    const er = build(t.world, 'er', { col: 20, row: 20, cols: 4, rows: 6 });
    hire(t.world, 'nurse', nurses);
    const feed = (): Patient => waitingPatient(t.world, 'laceration', 3);
    for (let i = 0; i < 4; i++) feed();
    t.world.tick(); // the ED captures the nurse pool
    // The triage patient arrives AFTER the capture — the MAJOR 5 ordering.
    const stuck = t.world.spawnPatient('flu');
    stuck.stage = { kind: 'waitingTriage' };
    stuck.waitingSince = t.world.clock.tick;
    t.world.assignWaitingSpot(stuck);
    return { ...t, triage, er, stuck, feed };
  }

  /** Run `ticks`, optionally topping the ED up, and report what triage got. */
  function run(
    w: ReturnType<typeof edWorld>,
    ticks: number,
    opts: { sustain: boolean; rescueAt?: number },
  ) {
    const nurses = () => [...w.world.staff.values()].filter((s) => s.role === 'nurse');
    let idleTicks = 0;
    let firstTriageTick = -1;
    let minErPanel = Number.POSITIVE_INFINITY;
    for (let i = 0; i < ticks; i++) {
      if (opts.sustain && w.world.reservationsOn(w.er.id).length < 4) w.feed();
      // Pin patience: this test measures the DISPATCHER, not the AMA timer —
      // without it the subject walks out and the starvation is masked by a
      // different rule entirely.
      w.stuck.patience = 10_000;
      if (i === opts.rescueAt) hire(w.world, 'nurse', 1);
      w.world.tick();
      if (nurses().some((s) => s.duty.kind === 'idle')) idleTicks += 1;
      minErPanel = Math.min(minErPanel, w.world.reservationsOn(w.er.id).length);
      if (w.world.reservationsOn(w.triage.id).length > 0 && firstTriageTick < 0) {
        firstTriageTick = i;
      }
    }
    return { idleTicks, firstTriageTick, minErPanel };
  }

  it('IT STARVES: a sustained ED load holds the only nurse forever and triage never fires', () => {
    const w = edWorld(1);
    const { idleTicks, firstTriageTick, minErPanel } = run(w, 1_200, { sustain: true });

    // Premise: the ED really did stay busy for the whole run.
    expect(minErPanel, 'the ED panel never emptied').toBeGreaterThan(0);
    // The mechanism: a ratio staffer never returns to `idle` while a bay lives.
    expect(idleTicks, 'she is never idle for a single tick').toBe(0);
    // The consequence, PINNED AS THE CURRENT BEHAVIOUR: triage is starved out.
    expect(firstTriageTick, 'triage never fires').toBe(-1);
    expect(w.world.reservationsOn(w.triage.id)).toHaveLength(0);
    expect(w.stuck.stage.kind).toBe('waitingTriage');
    // …while the ED kept feeding her new patients the whole time. She is
    // available to the department that already has her, and to nobody else.
    const nurse = [...w.world.staff.values()].find((s) => s.role === 'nurse')!;
    expect(w.world.staffLoadIn(nurse.id, w.er.id)).toBeGreaterThan(0);
    expect(w.world.stageViolations).toEqual([]);
  });

  it('but it is LOAD-dependent: a finite ED queue drains, she idles, and triage proceeds', () => {
    // The contrast that keeps the test above honest — the capture is not
    // permanent in principle, only for as long as the department stays full.
    const w = edWorld(1);
    const { idleTicks, firstTriageTick, minErPanel } = run(w, 1_200, { sustain: false });

    expect(minErPanel, 'the ED drained').toBe(0);
    expect(idleTicks, 'she returned to idle').toBeGreaterThan(0);
    expect(firstTriageTick, 'triage fired once she was free').toBeGreaterThan(-1);
    expect(w.world.stageViolations).toEqual([]);
  });

  it('an IDLE nurse is all triage needs: a rescue hire is claimed the tick she appears', () => {
    // `assignTriage` runs FIRST, so a newly hired (idle) nurse is taken by
    // triage before `assignTreatment` can pull her into the ED. This is the
    // shape any future carve-out has to preserve.
    const w = edWorld(1);
    const rescueAt = 300;
    const { firstTriageTick } = run(w, 900, { sustain: true, rescueAt });

    expect(firstTriageTick, 'triage claims her immediately, not eventually').toBe(rescueAt);
    expect(w.world.stageViolations).toEqual([]);
  });

  it('HEADCOUNT ALONE IS NOT THE REMEDY: two nurses hired first are both absorbed', () => {
    // The finding that makes this more than "hire another nurse": a 4-bay ED
    // takes BOTH nurses before any triage patient exists, and neither ever
    // comes back. Recorded so a future fix is measured against it.
    const w = edWorld(2);
    const { idleTicks, firstTriageTick } = run(w, 1_200, { sustain: true });

    expect(idleTicks, 'neither nurse is ever idle').toBe(0);
    expect(firstTriageTick, 'triage still starves with two nurses').toBe(-1);
    expect(w.world.stageViolations).toEqual([]);
  });
});

// -------------------------------------------------------------- close/reopen

describe('closing a room (§0 — what makes a busy ED expandable)', () => {
  it('closing zeroes capacity and cancels gathering, but lets ACTIVES finish', () => {
    const { world, room, queue, apply } = panelWorld(3);
    walkEveryoneIn(world, room);
    expect(world.reservationsOn(room.id).every((r) => r.phase === 'active')).toBe(true);
    // Re-open a bay so there is a GATHERING reservation beside the actives.
    world.killPatient(world.patients.get(world.reservationsOn(room.id)[0]!.patientId)!);
    waitingPatient(world, 'laceration', 3);
    world.tick();
    const gathering = world.reservationsOn(room.id).filter((r) => r.phase === 'gathering');
    expect(gathering.length).toBeGreaterThan(0);
    const actives = world.reservationsOn(room.id).filter((r) => r.phase === 'active').length;

    queue.push({ type: 'setRoomClosed', roomId: room.id, closed: true });
    apply();

    expect(room.closed).toBe(true);
    expect(world.capacityOf(room), 'closed disables exactly like broken').toBe(0);
    expect(world.reservationsOn(room.id)).toHaveLength(actives);
    expect(world.reservationsOn(room.id).every((r) => r.phase === 'active')).toBe(true);
    // No new dispatch while closed.
    waitingPatient(world, 'laceration', 3);
    world.tick();
    expect(world.reservationsOn(room.id).every((r) => r.phase === 'active')).toBe(true);
    expect(world.stageViolations).toEqual([]);
  });

  it('a closed + drained 3x4 ER can be EXPANDED, and its capacity grows', () => {
    // The owner's whole motivation: `validateRoomExpand` rejects while ANY
    // reservation is live, so without a drain the room that most needs more
    // bays could never grow.
    const { world, queue, apply } = setup();
    // NORTH door, so a south/east expansion cannot swallow the doorway.
    world.buildRoom('er', { col: 20, row: 20, cols: 3, rows: 4 }, { col: 21, row: 19 }, true);
    const room = [...world.rooms.values()].find((r) => r.type === 'er')!;
    expect(world.capacityOf(room)).toBe(2);
    hire(world, 'nurse', 1);
    waitingPatient(world, 'laceration', 3);
    waitingPatient(world, 'laceration', 3);
    world.tick();
    expect(world.reservationsOn(room.id)).toHaveLength(2);
    // Busy: expansion is refused.
    world.expandRoom(room.id, { col: 20, row: 20, cols: 6, rows: 6 }, true);
    expect(room.rect.cols).toBe(3);

    queue.push({ type: 'setRoomClosed', roomId: room.id, closed: true });
    apply();
    // Drain: gathering cancelled outright; anything active runs out.
    let guard = 0;
    while (world.reservationsOn(room.id).length > 0 && guard++ < 20_000) world.tick();
    expect(world.reservationsOn(room.id)).toHaveLength(0);

    world.expandRoom(room.id, { col: 20, row: 20, cols: 6, rows: 6 }, true);
    expect(room.rect.cols, 'the drained room grew').toBe(6);
    expect(room.closed, 'still closed — reopening is the player\'s call').toBe(true);
    expect(world.capacityOf(room), 'closed still reads 0').toBe(0);

    queue.push({ type: 'setRoomClosed', roomId: room.id, closed: false });
    apply();
    expect(world.capacityOf(room)).toBeGreaterThan(2);
    expect(world.stageViolations).toEqual([]);
  });

  it('reopening restores dispatch', () => {
    const { world, room, queue, apply } = panelWorld(0);
    queue.push({ type: 'setRoomClosed', roomId: room.id, closed: true });
    apply();
    waitingPatient(world, 'laceration', 3);
    world.tick();
    expect(world.reservationsOn(room.id)).toHaveLength(0);

    queue.push({ type: 'setRoomClosed', roomId: room.id, closed: false });
    apply();
    expect(room.closed).toBe(false);
    world.tick();
    expect(world.reservationsOn(room.id)).toHaveLength(1);
    expect(world.stageViolations).toEqual([]);
  });

  it('close is a NO-OP on a broken room, but REOPEN is always allowed (asymmetric)', () => {
    const { world, room, queue, apply } = panelWorld(0);
    world.breakRoom(room);
    expect(room.brokenSince).not.toBeNull();
    queue.push({ type: 'setRoomClosed', roomId: room.id, closed: true });
    apply();
    // Closing is refused — already disabled, and letting the two flags
    // interleave would just complicate the repair path for no gain.
    expect(room.closed).toBe(false);
    expect(world.capacityOf(room)).toBe(0);

    // The other direction must NOT be refused. A closed room still drains its
    // actives and `applyRoomUse` still rolls wear on them, so the last
    // draining treatment can break a room that is ALREADY closed. If reopen
    // were symmetrically guarded, that room would be stranded: both flags set,
    // reopen refused, and after the repair `closed` is still true with no hint
    // — a department that silently serves nobody forever.
    const closable = panelWorld(0);
    closable.queue.push({ type: 'setRoomClosed', roomId: closable.room.id, closed: true });
    closable.apply();
    closable.world.breakRoom(closable.room); // breaks while already closed
    expect(closable.room.closed).toBe(true);
    expect(closable.room.brokenSince).not.toBeNull();

    closable.queue.push({ type: 'setRoomClosed', roomId: closable.room.id, closed: false });
    closable.apply();
    expect(closable.room.closed, 'reopen went through while broken').toBe(false);
    // Harmless: capacity is 0 while broken regardless, so the room comes back
    // the moment maintenance finishes rather than needing a second unstick.
    expect(closable.world.capacityOf(closable.room)).toBe(0);
    closable.room.brokenSince = null; // fixture: stand in for a completed repair
    expect(closable.world.capacityOf(closable.room)).toBeGreaterThan(0);
  });

  it('`closed` round-trips through save/load, and pre-v10 restores false', () => {
    const { world, room, queue, apply } = panelWorld(0);
    queue.push({ type: 'setRoomClosed', roomId: room.id, closed: true });
    apply();

    const json = saveToString(world);
    expect(JSON.parse(json).saveVersion).toBe(SAVE_VERSION);
    const loaded = loadWorld(new EventBus(), json);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const reloaded = [...loaded.world.rooms.values()].find((r) => r.type === 'er')!;
    expect(reloaded.closed).toBe(true);
    expect(loaded.world.capacityOf(reloaded)).toBe(0);

    // Pre-v10: the field did not exist. Migration is a read-time default.
    const payload = JSON.parse(json) as SaveData & { saveVersion: number };
    payload.saveVersion = 9;
    for (const r of payload.rooms) delete (r as Partial<SaveData['rooms'][number]>).closed;
    const old = loadWorld(new EventBus(), JSON.stringify(payload));
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    for (const r of old.world.rooms.values()) expect(r.closed).toBe(false);
  });
});

// ------------------------------------------------------------------- save

describe('save v10 and the duty↔reservation border (§4)', () => {
  /** A v10 world with ONE nurse holding three ER reservations. */
  function panelSave() {
    const { world, room, nurse } = panelWorld(3);
    expect(world.reservationsOfStaff(nurse.id)).toHaveLength(3);
    return { world, room, nurse, json: saveToString(world) };
  }

  it('a v10 round-trip with one nurse on 3 ER reservations is byte-identical', () => {
    const { json } = panelSave();
    expect(JSON.parse(json).saveVersion).toBe(SAVE_VERSION);
    const loaded = loadWorld(new EventBus(), json);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(saveToString(loaded.world)).toBe(json);
    // …and the panel survived as a panel, not three loose reservations.
    const room = [...loaded.world.rooms.values()].find((r) => r.type === 'er')!;
    const staffIds = new Set(loaded.world.reservationsOn(room.id).flatMap((r) => r.staffIds));
    expect(staffIds.size).toBe(1);
    const nurseId = [...staffIds][0]!;
    expect(loaded.world.staffLoadIn(nurseId, room.id)).toBe(3);
    expect(loaded.world.reservationsOfStaff(nurseId)).toHaveLength(3);
  });

  /**
   * Contract test 18 (pre-impl review MINOR 9). A new border rule that rejects
   * old saves is the save-bricking class, so the v9 path must be exercised
   * with LIVE RESERVATIONS — a fixture with none never reaches rules 1-3 and
   * the test is vacuous. The fixture is shaped as v9 ACTUALLY produced saves:
   * v9's `makeReservation` bound `duty` unconditionally and v9's `idleStaff`
   * required `duty.kind === 'idle'`, so no v9 staffer can appear in two
   * `staffIds` — one staffer per reservation, and both phases represented.
   */
  function v9Fixture() {
    const { world } = setup();
    const room = build(world, 'er', { col: 20, row: 20, cols: 4, rows: 6 });
    hire(world, 'nurse', 3); // fully staffed ⇒ idle-first gives each bay its own
    for (let i = 0; i < 3; i++) waitingPatient(world, 'laceration', 3);
    world.tick();
    walkEveryoneIn(world, room);
    expect(world.reservationsOn(room.id).every((r) => r.phase === 'active')).toBe(true);
    // Free one nurse, then start a fresh gather so BOTH phases are live.
    world.killPatient(world.patients.get(world.reservationsOn(room.id)[0]!.patientId)!);
    waitingPatient(world, 'laceration', 3);
    world.tick();
    const live = world.reservationsOn(room.id);
    expect(live.filter((r) => r.phase === 'active')).toHaveLength(2);
    expect(live.filter((r) => r.phase === 'gathering')).toHaveLength(1);
    // The v9 invariant this fixture must honour: nobody holds two bays.
    for (const r of live) expect(r.staffIds).toHaveLength(1);
    expect(new Set(live.flatMap((r) => r.staffIds)).size).toBe(3);

    const payload = JSON.parse(saveToString(world)) as SaveData & { saveVersion: number };
    payload.saveVersion = 9;
    for (const r of payload.rooms) delete (r as Partial<SaveData['rooms'][number]>).closed;
    return { world, room, payload };
  }

  it('a v9 save with a LIVE gathering AND a live active reservation loads through rules 1-3', () => {
    const { payload } = v9Fixture();
    const result = loadWorld(new EventBus(), JSON.stringify(payload));
    expect(result.ok, !result.ok ? result.reason : '').toBe(true);
    if (!result.ok) return;

    const room = [...result.world.rooms.values()].find((r) => r.type === 'er')!;
    const live = result.world.reservationsOn(room.id);
    expect(live).toHaveLength(3);
    expect(live.filter((r) => r.phase === 'active')).toHaveLength(2);
    expect(live.filter((r) => r.phase === 'gathering')).toHaveLength(1);
    // Rule 3's bound is ≥1 for every room/role, so it can never be stricter
    // than v9 reality — each nurse came back holding exactly her own bay.
    for (const r of live) {
      expect(r.staffIds).toHaveLength(1);
      const member = result.world.staff.get(r.staffIds[0]!)!;
      expect(member, 'rule 2: every staffIds member resolves').toBeDefined();
      expect(member.duty.kind, 'rule 2: …and is on reserved duty').toBe('reserved');
      expect(result.world.staffLoadIn(member.id, room.id)).toBe(1);
      // Rule 1: the witness names a reservation that lists her.
      if (member.duty.kind !== 'reserved') continue;
      const witness = result.world.reservations.get(member.duty.reservationId)!;
      expect(witness.staffIds).toContain(member.id);
    }
    expect(room.closed, 'pre-v10 rooms restore closed=false').toBe(false);
    // And the loaded world keeps running.
    result.world.tick();
    expect(result.world.stageViolations).toEqual([]);
  });

  it('an existing v9 ER keeps capacity 1 — the new density does NOT retro-fit bays', () => {
    // Capacity derives from PLACED prop tiles in the grid, never from the
    // density rule, so B1's 12 → 6 tiles/bed affects new builds and expansions
    // only. A v9 3×4 ER shipped with ONE bed and must load with ONE bed —
    // otherwise every existing save silently gains a bay it never paid for.
    const { world } = setup();
    const room = build(world, 'er', { col: 20, row: 20, cols: 3, rows: 4 });
    expect(world.capacityOf(room), 'a FRESH 3×4 build derives 2 (B1 density)').toBe(2);
    // Strip it back to the single bed a v9 save would hold (grid poke).
    const [, second] = world.slotOrigins(room);
    for (let i = 0; i < 2; i++) {
      const tile = world.tileAt(second!.col + i, second!.row)!;
      tile.object = null;
      tile.walkable = true;
    }
    expect(world.capacityOf(room)).toBe(1);

    const payload = JSON.parse(saveToString(world)) as SaveData & { saveVersion: number };
    payload.saveVersion = 9;
    for (const r of payload.rooms) delete (r as Partial<SaveData['rooms'][number]>).closed;
    const result = loadWorld(new EventBus(), JSON.stringify(payload));
    expect(result.ok, !result.ok ? result.reason : '').toBe(true);
    if (!result.ok) return;

    const loaded = [...result.world.rooms.values()].find((r) => r.type === 'er')!;
    expect(loaded.rect.cols).toBe(3);
    expect(loaded.rect.rows).toBe(4);
    expect(result.world.capacityOf(loaded), 'still ONE bay — no migration').toBe(1);
    expect(result.world.slotOrigins(loaded)).toHaveLength(1);
  });

  it('border rule 1 REJECTS a duty naming a reservation that omits the member', () => {
    const { json } = panelSave();
    const payload = JSON.parse(json) as SaveData;
    const nurse = payload.staff.find((s) => s.duty.kind === 'reserved')!;
    // Strip her out of her OWN witness (she stays in the other two, so rule 2
    // still passes — this isolates rule 1).
    if (nurse.duty.kind !== 'reserved') return;
    const witnessId = nurse.duty.reservationId;
    const witness = payload.reservations.find((r) => r.id === witnessId)!;
    witness.staffIds = witness.staffIds.filter((id) => id !== nurse.id);
    const result = loadWorld(new EventBus(), JSON.stringify(payload));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('lists this staffer');
  });

  it('border rule 2 REJECTS a staffIds member whose duty is idle', () => {
    const { json } = panelSave();
    const payload = JSON.parse(json) as SaveData;
    const nurse = payload.staff.find((s) => s.duty.kind === 'reserved')!;
    nurse.duty = { kind: 'idle' };
    const result = loadWorld(new EventBus(), JSON.stringify(payload));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('reserved duty');
  });

  it('border rule 3 REJECTS a nurse over the room\'s ratio', () => {
    // A 6-bay ER, so the tampered 5th reservation sits on a REAL free slot and
    // the only thing wrong with the payload is the ratio (4) being exceeded.
    const { world, room, nurse } = panelWorld(0);
    world.expandRoom(room.id, { col: 20, row: 20, cols: 6, rows: 6 }, true);
    expect(world.capacityOf(room)).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < 5; i++) waitingPatient(world, 'laceration', 3);
    world.tick();
    expect(world.reservationsOfStaff(nurse.id)).toHaveLength(staffRatioFor('er', 'nurse'));
    const spare = [...world.patients.values()].find((p) => p.stage.kind === 'waiting')!;

    const payload = JSON.parse(saveToString(world)) as SaveData;
    const template = payload.reservations.find((r) => r.roomId === room.id)!;
    const usedSlots = new Set(
      payload.reservations.filter((r) => r.roomId === room.id).map((r) => r.slotIndex),
    );
    const freeSlot = [0, 1, 2, 3, 4, 5].find((s) => !usedSlots.has(s))!;
    const extraId = payload.nextEntityId;
    payload.reservations.push({ ...template, id: extraId, slotIndex: freeSlot, patientId: spare.id });
    payload.nextEntityId += 1;
    const savedSpare = payload.patients.find((p) => p.id === spare.id)!;
    savedSpare.stage = { kind: 'reserved', reservationId: extraId };
    savedSpare.waitingSince = null;
    savedSpare.waitingRoomId = null;

    const result = loadWorld(new EventBus(), JSON.stringify(payload));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('ratio');
  });

  it('border rule 3 REJECTS a nurse holding reservations in TWO rooms', () => {
    const { world, room } = panelWorld(2);
    // A second ER far away, so the tampered payload is otherwise coherent.
    const other = build(world, 'er', { col: 30, row: 20, cols: 4, rows: 6 });
    const payload = JSON.parse(saveToString(world)) as SaveData;
    const held = payload.reservations.filter((r) => r.roomId === room.id);
    expect(held.length).toBe(2); // premise
    held[1]!.roomId = other.id;
    const result = loadWorld(new EventBus(), JSON.stringify(payload));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('ONE room');
  });
});

// ------------------------------------------------------- density & placement

describe('ED bed density and slot placement (§2, §7)', () => {
  /** Every walkable tile of the room reachable from its door-inside tile. */
  function interiorConnected(world: World, room: Room): boolean {
    const inside = room.door!.inside;
    const key = (p: GridPoint): string => `${p.col},${p.row}`;
    const walkable: GridPoint[] = [];
    for (let col = room.rect.col; col < room.rect.col + room.rect.cols; col++) {
      for (let row = room.rect.row; row < room.rect.row + room.rect.rows; row++) {
        if (world.tileAt(col, row)!.walkable) walkable.push({ col, row });
      }
    }
    const seen = new Set<string>([key(inside)]);
    const queue: GridPoint[] = [inside];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const step of ORTHOGONAL_STEPS) {
        const next = { col: cur.col + step.col, row: cur.row + step.row };
        if (next.col < room.rect.col || next.col >= room.rect.col + room.rect.cols) continue;
        if (next.row < room.rect.row || next.row >= room.rect.row + room.rect.rows) continue;
        if (seen.has(key(next)) || !world.canStep(cur, next)) continue;
        seen.add(key(next));
        queue.push(next);
      }
    }
    return seen.size === walkable.length;
  }

  /** Every outside tile orthogonally adjacent to the rect — the door candidates. */
  function doorCandidates(rect: { col: number; row: number; cols: number; rows: number }) {
    const out: GridPoint[] = [];
    for (let col = rect.col; col < rect.col + rect.cols; col++) {
      out.push({ col, row: rect.row - 1 }, { col, row: rect.row + rect.rows });
    }
    for (let row = rect.row; row < rect.row + rect.rows; row++) {
      out.push({ col: rect.col - 1, row }, { col: rect.col + rect.cols, row });
    }
    return out;
  }

  it('a fresh 3x4 ER derives capacity 2 on EVERY legal door edge, interior connected, no bed on the landing', () => {
    const rect = { col: 20, row: 20, cols: 3, rows: 4 };
    let built = 0;
    for (const outside of doorCandidates(rect)) {
      const { world } = setup();
      world.buildRoom('er', rect, outside, true);
      const room = [...world.rooms.values()].find((r) => r.type === 'er');
      if (!room) continue; // this edge is not a legal door position — skip
      built += 1;
      const where = `door ${outside.col},${outside.row}`;
      // Failed strip placements skip SILENTLY and capacity derives from what
      // landed, so this must be swept, not asserted on one build (§2 MINOR 10).
      expect(world.capacityOf(room), where).toBe(2);
      expect(world.slotOrigins(room), where).toHaveLength(2);
      expect(interiorConnected(world, room), `${where}: interior connected`).toBe(true);
      // The door landing is never a bed tile — it is refused in tryPlaceStripAt.
      const landing = room.door!.inside;
      expect(world.tileAt(landing.col, landing.row)!.object, where).toBeNull();
      expect(world.tileAt(landing.col, landing.row)!.walkable, where).toBe(true);
    }
    expect(built, 'the sweep actually built rooms').toBeGreaterThan(3);
  });

  it('the approachability rule STAGGERS the beds — it changes where they land, not how many', () => {
    /*
     * The observable consequence of `everySlotApproachable`, NOT a restatement
     * of its own predicate (which would pass whether or not the check exists).
     *
     * Measured on a 4×6 ER with the check REVERTED, bed origins land at row
     * offsets [0, 0, 1, 1] — four beds packed into the first two rows, with
     * `roomInteriorConnected` still passing because the remaining tiles are
     * connected to each other. WITH the check they land at [0, 0, 1, 2]: the
     * row-1 pair is refused and the layout staggers. 6×6 behaves the same way
     * ([0,0,0,1,1,1] → [0,0,0,1,2,2]).
     *
     * Capacity is IDENTICAL in both variants (4 and 6), which is the whole
     * point — the rule moves beds, it does not delete them. So the two things
     * worth asserting are the staggering itself and the thing the staggering
     * buys: `slotAnchorTile` returning a real bedside tile instead of falling
     * through to `freeInteriorTile`. Under the reverted check the packed
     * layout's slot 0 has NO walkable neighbour at all and its anchor comes
     * back at row offset 2 — nowhere near its own strip.
     */
    const cases = [
      { rect: { col: 20, row: 20, cols: 4, rows: 6 }, capacity: 4, distinctRows: 3 },
      { rect: { col: 20, row: 20, cols: 6, rows: 6 }, capacity: 6, distinctRows: 3 },
      // 3×4 holds only 2 beds, which fit in 2 rows either way — carried to
      // show the rule is not silently shrinking the minimum build.
      { rect: { col: 20, row: 20, cols: 3, rows: 4 }, capacity: 2, distinctRows: 2 },
    ];
    for (const { rect, capacity, distinctRows } of cases) {
      const { world } = setup();
      const room = build(world, 'er', rect);
      const origins = world.slotOrigins(room);
      const where = `${rect.cols}x${rect.rows}`;

      // (a) The rule costs no bays.
      expect(world.capacityOf(room), `${where} capacity`).toBe(capacity);
      expect(origins, `${where} origins`).toHaveLength(capacity);

      // (b) The beds are STAGGERED across rows rather than packed into the
      // first two. This is the assertion the reverted check fails.
      const rows = new Set(origins.map((o) => o.row - rect.row));
      expect(rows.size, `${where}: bed rows ${[...rows].join(',')}`).toBe(distinctRows);

      // (c) What the staggering buys: every bay's anchor is a REAL bedside
      // tile — orthogonally adjacent to that bay's OWN strip, never the
      // freeInteriorTile fallback.
      origins.forEach((origin, slotIndex) => {
        const anchor = world.slotAnchorTile(room, slotIndex);
        const stripTiles = [origin, { col: origin.col + 1, row: origin.row }];
        const beside = stripTiles.some(
          (t) => Math.abs(t.col - anchor.col) + Math.abs(t.row - anchor.row) === 1,
        );
        expect(beside, `${where}: slot ${slotIndex} anchors beside its OWN strip`).toBe(true);
        // …and it is somewhere a person can actually stand.
        expect(world.tileAt(anchor.col, anchor.row)!.walkable, `${where} slot ${slotIndex}`).toBe(
          true,
        );
        expect(samePoint(anchor, room.door!.inside), `${where}: not the doorway`).toBe(false);
      });
    }
  });
});
