import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { gameMinutesToTicks, TICKS_PER_DAY, TICKS_PER_GAME_HOUR } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import type { Patient } from '../src/sim/entities/patient';
import { validateRoomSell } from '../src/sim/build';
import {
  cleanlinessRepDelta,
  patienceDecayPerTick,
  treatmentDurationTicks,
} from '../src/sim/formulas';
import { computeBlockedNeeds } from '../src/sim/needs';
import { SeededRng } from '../src/sim/rng';
import { loadWorld, serializeWorld } from '../src/sim/save';
import { updateDecay } from '../src/sim/systems/decay';
import { updateDispatcher } from '../src/sim/systems/dispatcher';
import { updateMess } from '../src/sim/systems/mess';
import { updateMovement } from '../src/sim/systems/movement';
import { updatePatientNeeds } from '../src/sim/systems/patientNeeds';
import type { GridPoint } from '../src/sim/types';
import { World } from '../src/sim/world';

/**
 * Amenities epic Stage 2 (AMENITIES_PLAN §4 / impl plan §S2): messes, the
 * facility job queue, EVS dispatch, and the cleanliness channels — every
 * bolded FROZEN-clause regression from §S2.7.
 */

const M = BALANCE.mess;
const VITALS = BALANCE.stats.vitalsMax;
const VOMIT_P = M.vomitPerGameHour / TICKS_PER_GAME_HOUR;

function setup(seed = 42): { world: World; events: EventBus } {
  const events = new EventBus();
  const world = new World(events, seed);
  return { world, events };
}

/** A parked patient with pinned vitals (fixture writes — allowed in tests). */
function makePatient(
  world: World,
  opts: { at?: GridPoint; stage?: Patient['stage'] } = {},
): Patient {
  const patient = world.spawnPatient('flu');
  patient.stage = opts.stage ?? { kind: 'waiting' };
  patient.acuity = 3;
  patient.waitingSince = world.clock.tick;
  patient.health = VITALS;
  patient.patience = VITALS;
  patient.bladder = VITALS;
  patient.thirst = VITALS;
  if (opts.at) patient.at = { ...opts.at };
  patient.next = null;
  patient.path = [];
  patient.target = null;
  return patient;
}

function addEvs(world: World, skill = 3): ReturnType<World['addStaffMember']> {
  return world.addStaffMember('evs', skill, 90);
}

/** Drive dispatch + movement with an advancing clock (no spawn/decay noise). */
function run(world: World, ticks: number, also?: () => void): void {
  for (let i = 0; i < ticks; i++) {
    world.clock.advance();
    updateDispatcher(world);
    updateMovement(world);
    also?.();
  }
}

/** An rng state whose NEXT draw lands below the per-tick vomit probability —
 *  lets a test force the Bernoulli hit deterministically. */
function vomitingRngState(): number {
  const rng = new SeededRng(0);
  for (let s = 1; s < 1_000_000; s++) {
    rng.setState(s);
    if (rng.next() < VOMIT_P) return s;
  }
  throw new Error('no vomiting rng state found');
}

const CLEAN_TICKS = (skill: number): number =>
  treatmentDurationTicks(M.cleanGameMinutes, skill, 0);

// --------------------------------------------------------------- mess model

describe('addMess / removeMess (§4.1 — the world surface)', () => {
  it('one mess per tile: a repeat refreshes `since`, never doubles', () => {
    const { world } = setup();
    world.addMess('vomit', { col: 5, row: 5 });
    const first = world.messes.get('5,5')!;
    expect(first.kind).toBe('vomit');
    world.clock.advance();
    world.addMess('litter', { col: 5, row: 5 });
    expect(world.messes.size).toBe(1);
    expect(world.messes.get('5,5')!.since).toBe(world.clock.tick); // refreshed
    expect(world.messes.get('5,5')!.kind).toBe('vomit'); // kind kept — one mess
  });

  it('addMess mints ONE clean job; a repeat mints nothing (one job per target)', () => {
    const { world } = setup();
    world.addMess('vomit', { col: 5, row: 5 });
    expect(world.jobs.size).toBe(1);
    const job = [...world.jobs.values()][0]!;
    expect(job.kind).toBe('clean');
    expect(job.phase).toBe('queued');
    expect(job.staffId).toBeNull();
    world.addMess('vomit', { col: 5, row: 5 });
    expect(world.jobs.size).toBe(1); // still the one job
  });

  it('removeMess deletes the mess AND its job (the general orphan rule), bumping messRevision', () => {
    const { world, events } = setup();
    let jobChanged = 0;
    events.on('jobChanged', () => (jobChanged += 1));
    world.addMess('vomit', { col: 5, row: 5 });
    const before = world.messRevision;
    world.removeMess({ col: 5, row: 5 });
    expect(world.messes.size).toBe(0);
    expect(world.jobs.size).toBe(0);
    expect(world.messRevision).toBeGreaterThan(before);
    expect(jobChanged).toBe(2); // mint + orphan delete
    // No-op on a clean tile: no events, no revision churn.
    const rev = world.messRevision;
    world.removeMess({ col: 9, row: 9 });
    expect(world.messRevision).toBe(rev);
  });

  it('hasMessNear: Chebyshev patienceRadius, invalidated immediately on add/remove', () => {
    const { world } = setup();
    const p = { col: 20, row: 20 };
    expect(world.hasMessNear(p)).toBe(false);
    world.addMess('vomit', { col: 20 + M.patienceRadius, row: 20 + M.patienceRadius });
    expect(world.hasMessNear(p)).toBe(true); // corner of the square patch
    expect(world.hasMessNear({ col: 20, row: 20 - 1 })).toBe(false); // one row out
    world.removeMess({ col: 20 + M.patienceRadius, row: 20 + M.patienceRadius });
    expect(world.hasMessNear(p)).toBe(false); // same tick — messRevision cache
  });
});

// --------------------------------------------------------------- vomit rolls

describe('vomit rolls (§S2.2 — the FROZEN stage set + Bernoulli)', () => {
  it('per-tick probability realizes the per-game-hour rate (statistical envelope)', () => {
    const { world, events } = setup(7);
    const p = makePatient(world, { at: { col: 20, row: 20 } });
    let vomits = 0;
    events.on('messChanged', () => (vomits += 1)); // add OR refresh — 1 per vomit
    const N = 20_000;
    for (let i = 0; i < N; i++) {
      world.clock.advance();
      p.health = BALANCE.mood.criticalHealthBelow - 1; // pinned sub-critical
      p.patience = VITALS; // never AMA-relevant (decay isn't run)
      updateMess(world);
    }
    const expected = N * VOMIT_P; // = 120 at the shipped numbers
    expect(vomits).toBeGreaterThan(expected * 0.5);
    expect(vomits).toBeLessThan(expected * 1.7);
  });

  it('the frozen stage set rolls; reserved/leaving/dead do not (and consume NO rng)', () => {
    const hit = vomitingRngState();
    const eligible: Patient['stage'][] = [
      { kind: 'atEntrance' },
      { kind: 'queuedCheckIn', roomId: 1, slot: 0 },
      { kind: 'checkingIn', roomId: 1, ticksRemaining: 5 },
      { kind: 'waitingTriage' },
      { kind: 'waiting' },
    ];
    for (const stage of eligible) {
      const { world } = setup();
      const p = makePatient(world, { at: { col: 8, row: 8 }, stage });
      p.health = BALANCE.mood.criticalHealthBelow - 1;
      world.rng.setState(hit);
      updateMess(world);
      expect(world.messes.has('8,8'), `stage ${stage.kind} vomits`).toBe(true);
      expect(world.messes.get('8,8')!.kind).toBe('vomit');
    }
    const ineligible: Patient['stage'][] = [
      { kind: 'reserved', reservationId: 1 },
      { kind: 'leaving', reason: 'ama' },
      { kind: 'dead', since: 0 },
    ];
    for (const stage of ineligible) {
      const { world } = setup();
      const p = makePatient(world, { at: { col: 8, row: 8 }, stage });
      p.health = BALANCE.mood.criticalHealthBelow - 1;
      world.rng.setState(hit);
      updateMess(world);
      expect(world.messes.size, `stage ${stage.kind} never vomits`).toBe(0);
      // Ineligible patients are skipped BEFORE the draw — the stream is
      // untouched (fixed rng order is part of the frozen contract).
      expect(world.rng.getState()).toBe(hit);
    }
  });

  it('healthy patients never roll (no draw); needBreak holders DO roll', () => {
    const hit = vomitingRngState();
    const { world } = setup();
    const healthy = makePatient(world, { at: { col: 8, row: 8 } });
    healthy.health = BALANCE.mood.criticalHealthBelow; // exactly AT threshold — not below
    world.rng.setState(hit);
    updateMess(world);
    expect(world.messes.size).toBe(0);
    expect(world.rng.getState()).toBe(hit); // no draw consumed

    const { world: w2 } = setup();
    const onBreak = makePatient(w2, { at: { col: 9, row: 9 } });
    onBreak.health = BALANCE.mood.criticalHealthBelow - 1;
    onBreak.needBreak = {
      kind: 'restroom',
      roomId: 999,
      slot: 0,
      phase: 'walking',
      ticksRemaining: 0,
      startedAt: 0,
    };
    w2.rng.setState(hit);
    updateMess(w2);
    expect(w2.messes.has('9,9'), 'a needBreak holder still rolls').toBe(true);
  });

  it('the self patience hit follows the accident clamp rule (floor where AMA-ineligible)', () => {
    const hit = vomitingRngState();
    // waiting (AMA-eligible): floor 0.
    const { world } = setup();
    const waiting = makePatient(world, { at: { col: 8, row: 8 } });
    waiting.health = BALANCE.mood.criticalHealthBelow - 1;
    waiting.patience = M.vomitSelfPatienceHit - 2;
    world.rng.setState(hit);
    updateMess(world);
    expect(waiting.patience).toBe(0);
    expect(waiting.stage.kind).toBe('waiting'); // never mints a fail state itself
    // checkingIn (AMA-INeligible): clamped at the accident floor.
    const { world: w2 } = setup();
    const atDesk = makePatient(w2, {
      at: { col: 8, row: 8 },
      stage: { kind: 'checkingIn', roomId: 1, ticksRemaining: 5 },
    });
    atDesk.health = BALANCE.mood.criticalHealthBelow - 1;
    atDesk.patience = M.vomitSelfPatienceHit - 2;
    w2.rng.setState(hit);
    updateMess(w2);
    expect(atDesk.patience).toBe(BALANCE.needs.accidentPatienceFloor);
  });

  it('tallies messTicks += standing messes every tick (the choke-point pattern)', () => {
    const { world } = setup();
    world.addMess('vomit', { col: 5, row: 5 });
    world.addMess('litter', { col: 9, row: 9 });
    expect(world.today.messTicks).toBe(0);
    updateMess(world);
    expect(world.today.messTicks).toBe(2);
    updateMess(world);
    expect(world.today.messTicks).toBe(4);
  });
});

describe('bladder accidents drop a mess (§3.1 Stage-2 upgrade)', () => {
  it('the accident tile gains a vomit mess alongside the Stage-1 hit + reset', () => {
    const { world } = setup();
    const p = makePatient(world, { at: { col: 12, row: 12 } });
    p.bladder = 0.0001;
    updateDecay(world);
    expect(p.bladder).toBe(VITALS); // Stage-1 reset intact
    expect(world.messes.get('12,12')?.kind).toBe('vomit');
    expect(world.jobs.size).toBe(1); // clean job minted
  });
});

// ------------------------------------------------------- litter & trashcans

/** Fixture: complete a vending break NOW (the using-phase completion path
 *  runs dropLitter — the §S2.2 litter rules). */
function completeVendingUse(world: World, patient: Patient, machineTile: GridPoint): void {
  patient.needBreak = {
    kind: 'vending',
    tile: { ...machineTile },
    phase: 'using',
    ticksRemaining: 1,
    startedAt: world.clock.tick,
  };
  patient.thirst = 10;
  updatePatientNeeds(world);
  expect(patient.needBreak).toBeNull(); // premise: completed
}

describe('vending litter vs trashcans (§S2.2 — radius, tie-break, overflow)', () => {
  it('a non-full can within the Chebyshev radius takes the trash SILENTLY', () => {
    const { world, events } = setup();
    world.placeAmenity('vending', { col: 5, row: 5 });
    world.placeAmenity('trashcan', { col: 5 + M.litterTrashcanRadius, row: 6 }); // dist = radius
    let messEvents = 0;
    events.on('messChanged', () => (messEvents += 1));
    const p = makePatient(world, { at: { col: 5, row: 6 } });
    completeVendingUse(world, p, { col: 5, row: 5 });
    expect(world.amenityAt(5 + M.litterTrashcanRadius, 6)!.fill).toBe(1);
    expect(world.messes.size).toBe(0);
    expect(messEvents).toBe(0); // silent — the inspect card is frame-polled
  });

  it('no can in radius → litter lands on the patient tile (with its clean job)', () => {
    const { world } = setup();
    world.placeAmenity('vending', { col: 5, row: 5 });
    world.placeAmenity('trashcan', { col: 5 + M.litterTrashcanRadius + 1, row: 6 }); // 1 too far
    const p = makePatient(world, { at: { col: 5, row: 6 } });
    completeVendingUse(world, p, { col: 5, row: 5 });
    expect(world.amenityAt(5 + M.litterTrashcanRadius + 1, 6)!.fill).toBe(0);
    expect(world.messes.get('5,6')?.kind).toBe('litter');
    expect([...world.jobs.values()][0]?.kind).toBe('clean');
  });

  it('a FULL can is skipped even when nearest; ties go to the FIRST-placed can', () => {
    const { world } = setup();
    world.placeAmenity('vending', { col: 10, row: 10 });
    // Placement order is the tie-break order (insertion order, save-stable).
    world.placeAmenity('trashcan', { col: 13, row: 11 }); // dist 3 — placed FIRST
    world.placeAmenity('trashcan', { col: 7, row: 11 }); // dist 3 — placed second
    world.placeAmenity('trashcan', { col: 10, row: 12 }); // dist 1 but FULL
    world.amenityAt(10, 12)!.fill = M.trashcanCapacity;
    const p = makePatient(world, { at: { col: 10, row: 11 } });
    completeVendingUse(world, p, { col: 10, row: 10 });
    expect(world.amenityAt(13, 11)!.fill).toBe(1); // first-placed tie winner
    expect(world.amenityAt(7, 11)!.fill).toBe(0);
    expect(world.amenityAt(10, 12)!.fill).toBe(M.trashcanCapacity); // untouched
    expect(world.messes.size).toBe(0);
  });

  it('FROZEN overflow order: reaching capacity mints the empty job FIRST — no clean double-mint', () => {
    const { world } = setup();
    world.placeAmenity('vending', { col: 5, row: 5 });
    world.placeAmenity('trashcan', { col: 6, row: 6 });
    world.amenityAt(6, 6)!.fill = M.trashcanCapacity - 1;
    const p = makePatient(world, { at: { col: 5, row: 6 } });
    completeVendingUse(world, p, { col: 5, row: 5 });
    expect(world.amenityAt(6, 6)!.fill).toBe(M.trashcanCapacity);
    // The overflow mess IS in world.messes (the tally and proximity scan see it)…
    expect(world.messes.get('6,6')?.kind).toBe('litter');
    // …and exactly ONE job targets the can tile: the EMPTY job (≤1 per tile
    // held at the overflow instant — addMess's clean mint stood down).
    const jobs = [...world.jobs.values()].filter((j) => j.tile.col === 6 && j.tile.row === 6);
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.kind).toBe('empty');
  });
});

// ------------------------------------------------------------- the job queue

describe('assignJobs (§S2.3 — the FROZEN loop)', () => {
  it('oldest job first (lowest id)', () => {
    const { world } = setup();
    world.addMess('vomit', { col: 18, row: 36 });
    world.addMess('vomit', { col: 22, row: 36 });
    const [oldest, newer] = [...world.jobs.values()].sort((a, b) => a.id - b.id);
    addEvs(world);
    run(world, 1);
    expect(oldest!.phase).toBe('assigned');
    expect(newer!.phase).toBe('queued');
  });

  it('a HELD job is skipped, not blocking — a younger workable job assigns the same tick', () => {
    const { world } = setup();
    world.addMess('vomit', { col: 18, row: 36 });
    world.addMess('vomit', { col: 22, row: 36 });
    const [oldest, newer] = [...world.jobs.values()].sort((a, b) => a.id - b.id);
    oldest!.holdUntil = world.clock.tick + 500; // held (fixture write)
    const evs = addEvs(world);
    run(world, 1);
    expect(oldest!.phase).toBe('queued'); // skipped, untouched
    expect(newer!.phase).toBe('assigned'); // younger job assigned the same tick
    expect(evs.duty).toEqual({ kind: 'job', jobId: newer!.id });
  });

  it('a failed probe holds the job and is NOT re-probed until the window expires', () => {
    const { world } = setup();
    // Wall the corner in (fixture grid writes): the mess tile AND both
    // neighbors unwalkable → no work tile can be derived.
    world.tileAt(0, 0)!.walkable = false;
    world.tileAt(1, 0)!.walkable = false;
    world.tileAt(0, 1)!.walkable = false;
    world.addMess('water', { col: 0, row: 0 });
    const job = [...world.jobs.values()][0]!;
    const evs = addEvs(world);
    run(world, 1);
    const holdTicks = gameMinutesToTicks(M.jobRetryGameMinutes);
    const firstHold = job.holdUntil;
    expect(firstHold).toBe(world.clock.tick + holdTicks);
    expect(evs.duty.kind).toBe('idle');
    // Inside the window: skipped — the hold is NOT re-armed every tick.
    run(world, 5);
    expect(job.holdUntil).toBe(firstHold);
    // Past the window: re-probed (fails again) → a NEW, later hold.
    run(world, holdTicks);
    expect(job.holdUntil).toBeGreaterThan(firstHold);
  });

  it('mess under a standing patient → worked from the first free orthogonal neighbor', () => {
    const { world } = setup();
    makePatient(world, { at: { col: 20, row: 30 } }); // arrived — claims the tile
    world.addMess('vomit', { col: 20, row: 30 });
    const evs = addEvs(world);
    run(world, 1);
    expect(evs.target).toEqual({ col: 21, row: 30 }); // first ORTHOGONAL_STEPS neighbor
    run(world, 200);
    expect(world.messes.size).toBe(0); // no starvation — cleaned from beside
  });

  it('idle EVS are never drafted into care dispatch (role filters)', () => {
    const { world } = setup();
    world.buildRoom('triage', { col: 10, row: 10, cols: 2, rows: 2 }, { col: 12, row: 11 }, true);
    makePatient(world, { at: { col: 20, row: 30 }, stage: { kind: 'waitingTriage' } });
    addEvs(world);
    run(world, 5);
    expect(world.reservations.size).toBe(0); // no nurse → no triage, EVS untouched
  });
});

describe('job lifecycle (§S2.3 — arrival, completion, stall, fire)', () => {
  it('arrival flips working with the skill-scaled timer; completion clears mess + job, worker idle', () => {
    const { world } = setup();
    world.addMess('vomit', { col: 20, row: 36 });
    const job = [...world.jobs.values()][0]!;
    const evs = addEvs(world, 2);
    run(world, 1);
    expect(job.phase).toBe('assigned');
    // Walk to the mess (entrance 20,39 → 20,36), then flip working.
    run(world, 60, () => {
      if ((job.phase as string) === 'working' && job.ticksRemaining === CLEAN_TICKS(2)) {
        expect(world.walkerArrived(evs)).toBe(true);
      }
    });
    expect(world.messes.size).toBe(0);
    expect(world.jobs.size).toBe(0);
    expect(evs.duty).toEqual({ kind: 'idle' });
  });

  it('EMPTY completion order: fill=0 → job deleted → removeMess finds no job (no re-entrant delete)', () => {
    const { world } = setup();
    world.placeAmenity('trashcan', { col: 20, row: 36 });
    const can = world.amenityAt(20, 36)!;
    can.fill = M.trashcanCapacity;
    world.mintJob('empty', can.tile); // the overflow sequence, frozen order
    world.addMess('litter', can.tile);
    expect(world.jobs.size).toBe(1);
    const evs = addEvs(world);
    run(world, 120);
    expect(can.fill).toBe(0);
    expect(world.jobs.size).toBe(0);
    expect(world.messes.size).toBe(0); // the overflow decal left with the emptying
    expect(evs.duty).toEqual({ kind: 'idle' });
  });

  it('a mess INSIDE a walled room is workable from inside; completion steps the worker OUT', () => {
    const { world } = setup();
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 13, row: 11 }, true);
    const room = world.roomsOfType('exam')[0]!;
    // A walkable interior tile that isn't the door landing (props took some).
    const spot = [10, 11, 12]
      .flatMap((col) => [10, 11, 12].map((row) => ({ col, row })))
      .find(
        (t) =>
          world.isWalkable(t) &&
          !(t.col === room.door!.inside.col && t.row === room.door!.inside.row),
      )!;
    world.addMess('vomit', spot);
    const evs = addEvs(world);
    run(world, 400);
    expect(world.messes.size).toBe(0); // the same-room exception made it workable
    expect(evs.duty).toEqual({ kind: 'idle' });
    run(world, 200); // walk out
    expect(world.isInsideRoom(evs.at, room)).toBe(false); // the step-out clause
    expect(validateRoomSell(world, room.id).ok).toBe(true); // sale not pinned
  });

  it('a dead-path stop orth-adjacent ACROSS A WALL never flips working (through-wall guard)', () => {
    // The Stage-1 vending-flip bug class: Manhattan adjacency holds through
    // walls. Arrival is checked by RE-DERIVING the work tile, so a corridor
    // stop beside an in-room mess requeues instead of cleaning through the
    // wall.
    const { world } = setup();
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 13, row: 11 }, true);
    const inRoom = [10, 11, 12]
      .map((row) => ({ col: 10, row }))
      .find((t) => world.isWalkable(t))!; // west-column interior tile
    world.addMess('vomit', inRoom);
    const job = [...world.jobs.values()][0]!;
    const evs = addEvs(world);
    run(world, 1);
    expect(job.phase).toBe('assigned'); // premise
    // Simulate a dead-path stop on the corridor tile just across the wall.
    evs.at = { col: 9, row: inRoom.row };
    evs.next = null;
    evs.path = [];
    evs.target = null;
    run(world, 1);
    expect(job.phase).toBe('queued'); // requeued — NOT 'working' through the wall
    expect(job.holdUntil).toBeGreaterThan(world.clock.tick);
    expect(world.messes.size).toBe(1); // nothing got cleaned from the corridor
  });

  it('stalled arrival (dead path reads as "arrived") → requeue + hold, worker released', () => {
    const { world } = setup();
    world.addMess('vomit', { col: 20, row: 30 });
    const job = [...world.jobs.values()][0]!;
    const evs = addEvs(world);
    run(world, 1);
    expect(job.phase).toBe('assigned');
    // Simulate the dead-path stop far from the target (the rule-8 shape).
    evs.path = [];
    evs.target = null;
    evs.next = null;
    run(world, 1);
    expect(job.phase).toBe('queued');
    expect(job.staffId).toBeNull();
    expect(job.holdUntil).toBeGreaterThan(world.clock.tick);
    expect(evs.duty).toEqual({ kind: 'idle' });
  });

  it('firing mid-job requeues WITHOUT a hold, in both live phases (the dangling-staffId branch)', () => {
    for (const phase of ['assigned', 'working'] as const) {
      const { world } = setup();
      const queue = new CommandQueue();
      world.addMess('vomit', { col: 20, row: 36 });
      const job = [...world.jobs.values()][0]!;
      const evs = addEvs(world);
      run(world, 1);
      if (phase === 'working') {
        // Drive tick-by-tick until the flip (walk ≈ 17 ticks) and STOP —
        // running past it would complete the 7-tick clean before the fire.
        let guard = 0;
        while ((job.phase as string) !== 'working' && guard < 100) {
          run(world, 1);
          guard += 1;
        }
        expect(job.phase).toBe('working');
        expect(job.ticksRemaining).toBeGreaterThan(0); // mid-timer
      }
      queue.push({ type: 'fireStaff', staffId: evs.id });
      world.applyCommands(queue);
      expect(world.staff.has(evs.id)).toBe(false); // the existing firing path
      expect(world.jobs.get(job.id)!.phase).toBe('queued');
      expect(world.jobs.get(job.id)!.staffId).toBeNull();
      expect(world.jobs.get(job.id)!.holdUntil).toBeLessThanOrEqual(world.clock.tick); // NO hold
      // The job is workable again the moment another EVS exists.
      addEvs(world);
      run(world, 120);
      expect(world.messes.size).toBe(0);
    }
  });
});

// ------------------------------------------------------------ geometry sweeps

describe('geometry sweeps (design MAJOR 4 — jobs never block builds)', () => {
  it('buildRoom over a mess deletes mess + job and releases the assigned worker', () => {
    const { world } = setup();
    world.addMess('vomit', { col: 11, row: 11 });
    const evs = addEvs(world);
    run(world, 1);
    expect(evs.duty.kind).toBe('job'); // premise: mid-assignment
    // Build right over it (free): the sweep runs before the room exists.
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 13, row: 11 }, true);
    expect(world.rooms.size).toBe(1);
    expect(world.messes.size).toBe(0);
    expect(world.jobs.size).toBe(0);
    expect(evs.duty).toEqual({ kind: 'idle' });
  });

  it('expandRoom sweeps the DELTA tiles; sellRoom sweeps the interior', () => {
    const { world } = setup();
    const queue = new CommandQueue();
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 13, row: 11 }, true);
    const room = world.roomsOfType('exam')[0]!;
    world.addMess('vomit', { col: 11, row: 13 }); // delta tile of the grow-south rect
    world.expandRoom(room.id, { col: 10, row: 10, cols: 3, rows: 4 }, true);
    expect(world.messes.size).toBe(0);
    expect(world.jobs.size).toBe(0);
    // Interior accident, then sell: swept with the room.
    const interior = [10, 11, 12]
      .flatMap((col) => [10, 11, 12, 13].map((row) => ({ col, row })))
      .find((t) => world.isWalkable(t))!;
    world.addMess('vomit', interior);
    expect(world.messes.size).toBe(1);
    queue.push({ type: 'sellRoom', roomId: room.id });
    world.applyCommands(queue);
    expect(world.rooms.size).toBe(0); // premise: it sold
    expect(world.messes.size).toBe(0);
    expect(world.jobs.size).toBe(0);
  });

  it('placeAmenity over a mess sweeps it before the prop lands', () => {
    const { world } = setup();
    world.addMess('litter', { col: 6, row: 6 });
    world.placeAmenity('plant', { col: 6, row: 6 });
    expect(world.amenityAt(6, 6)?.kind).toBe('plant');
    expect(world.messes.size).toBe(0);
    expect(world.jobs.size).toBe(0);
  });

  it('selling an OVERFLOWED can: empty job deleted, the overflow mess leaves WITH the can', () => {
    const { world } = setup();
    world.placeAmenity('trashcan', { col: 20, row: 36 });
    const can = world.amenityAt(20, 36)!;
    can.fill = M.trashcanCapacity;
    world.mintJob('empty', can.tile);
    world.addMess('litter', can.tile);
    const evs = addEvs(world);
    run(world, 1);
    expect(evs.duty.kind).toBe('job'); // premise: mid-job when the can sells
    world.sellAmenity({ col: 20, row: 36 });
    expect(world.amenityAt(20, 36)).toBeNull();
    expect(world.jobs.size).toBe(0); // the job vanished with its target
    expect(world.messes.size).toBe(0); // no orphaned rep-leak (pre-impl MAJOR 1)
    expect(evs.duty).toEqual({ kind: 'idle' });
    expect(world.tileAt(20, 36)!.walkable).toBe(true); // the tile underneath is clean
  });
});

// ------------------------------------------------------ cleanliness channels

describe('proximity patience (§4.2 channel 1)', () => {
  it('×patienceMultiplier ONCE (not per mess), composing with the standing stack', () => {
    const { world } = setup();
    const near = makePatient(world, { at: { col: 20, row: 20 } });
    const far = makePatient(world, { at: { col: 35, row: 35 } });
    for (const p of [near, far]) p.waitingRoomId = null; // standing
    world.addMess('vomit', { col: 20 + M.patienceRadius, row: 20 }); // in radius
    world.addMess('litter', { col: 20, row: 20 + M.patienceRadius }); // second, also in
    updateDecay(world);
    const base = patienceDecayPerTick(3) * BALANCE.decay.standingMultiplier;
    expect(VITALS - far.patience).toBeCloseTo(base, 10);
    expect(VITALS - near.patience).toBeCloseTo(base * M.patienceMultiplier, 10); // once
  });

  it('a mess just outside the Chebyshev radius adds nothing', () => {
    const { world } = setup();
    const p = makePatient(world, { at: { col: 20, row: 20 } });
    p.waitingRoomId = null;
    world.addMess('vomit', { col: 20 + M.patienceRadius + 1, row: 20 });
    updateDecay(world);
    expect(VITALS - p.patience).toBeCloseTo(
      patienceDecayPerTick(3) * BALANCE.decay.standingMultiplier,
      10,
    );
  });
});

describe('cleanlinessRepDelta + closeDay (§4.2 channel 2)', () => {
  it('formula boundaries: spotless+arrivals bonus, the EMPTY-DAY gate, the 4h step, the cap', () => {
    expect(cleanlinessRepDelta(0, 5)).toBe(M.cleanDayRepBonus);
    expect(cleanlinessRepDelta(0, 0)).toBe(0); // an empty hospital isn't clean, it's closed
    const hourTicks = TICKS_PER_GAME_HOUR;
    const stepTicks = M.messHoursPerRepPoint * hourTicks;
    expect(cleanlinessRepDelta(stepTicks - 1, 1) === 0).toBe(true); // under the step
    expect(cleanlinessRepDelta(stepTicks, 1)).toBe(-1);
    expect(cleanlinessRepDelta(2 * stepTicks, 1)).toBe(-2);
    expect(cleanlinessRepDelta(1_000_000 * hourTicks, 1)).toBe(-M.dailyRepCap);
  });

  it('closeDay applies the delta beside the wait bonus, BEFORE the snapshot', () => {
    const { world, events } = setup();
    let report: { messTicks: number; arrivals: number; repDelta: number; reputation: number } | null =
      null;
    events.on('dayEnded', (r) => (report = r));
    // Pin a penalized tally at one tick before midnight (fixture writes).
    world.clock.tick = TICKS_PER_DAY - 1;
    world.today.messTicks = 2 * M.messHoursPerRepPoint * TICKS_PER_GAME_HOUR; // → −2
    world.today.arrivals = 3;
    const repBefore = world.reputation;
    world.tick();
    expect(report).not.toBeNull();
    const r = report!;
    const expected = cleanlinessRepDelta(r.messTicks, r.arrivals);
    expect(expected).toBe(-2); // premise: genuinely penalized
    expect(r.repDelta).toBe(expected); // landed INSIDE the tally before reset
    expect(r.reputation).toBe(repBefore + expected); // …and inside the snapshot
    expect(world.reputation).toBe(repBefore + expected);
  });

  it('a spotless day with arrivals earns the bonus through the same path', () => {
    const { world, events } = setup();
    let reputation = -1;
    events.on('dayEnded', (r) => (reputation = r.reputation));
    world.clock.tick = TICKS_PER_DAY - 1;
    world.today.arrivals = 4;
    const before = world.reputation;
    world.tick();
    expect(reputation).toBe(before + M.cleanDayRepBonus);
  });
});

// --------------------------------------------------------------- hints/needs

describe("needs 'role:evs' (§S2.5)", () => {
  const evsNeed = (world: World): ReturnType<typeof computeBlockedNeeds>[number] | undefined =>
    computeBlockedNeeds(world).find((n) => n.key === 'role:evs');

  it('absent with no messes; upcoming at 1; urgent at 3; patients = the MESS count', () => {
    const { world } = setup();
    expect(evsNeed(world)).toBeUndefined();
    world.addMess('vomit', { col: 5, row: 5 });
    let need = evsNeed(world)!;
    expect(need.urgent).toBe(false);
    expect(need.patients).toBe(1);
    expect(need.label).toBe('Hire an EVS Worker — messes need cleaning');
    world.addMess('vomit', { col: 7, row: 7 });
    world.addMess('litter', { col: 9, row: 9 });
    need = evsNeed(world)!;
    expect(need.urgent).toBe(true);
    expect(need.patients).toBe(3);
  });

  it('hiring an EVS clears the need entirely (even with messes standing)', () => {
    const { world } = setup();
    world.addMess('vomit', { col: 5, row: 5 });
    world.addMess('vomit', { col: 7, row: 7 });
    world.addMess('vomit', { col: 9, row: 9 });
    expect(evsNeed(world)?.urgent).toBe(true);
    addEvs(world);
    expect(evsNeed(world)).toBeUndefined();
  });
});

// ------------------------------------------------------------- standableTile

describe('standableTile (§S2.1 — the one standing-zone rule)', () => {
  it('corridor yes; walled interior only via sameRoomAs; door tiles never', () => {
    const { world } = setup();
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 13, row: 11 }, true);
    const room = world.roomsOfType('exam')[0]!;
    const interior = [10, 11, 12]
      .flatMap((col) => [10, 11, 12].map((row) => ({ col, row })))
      .find(
        (t) =>
          world.isWalkable(t) &&
          !(t.col === room.door!.inside.col && t.row === room.door!.inside.row),
      )!;
    expect(world.standableTile({ col: 20, row: 20 })).toBe(true); // corridor
    expect(world.standableTile(interior)).toBe(false); // the vending pick can't leak in
    expect(world.standableTile(interior, { sameRoomAs: interior })).toBe(true); // job rule
    expect(world.standableTile(room.door!.inside, { sameRoomAs: interior })).toBe(false);
    expect(world.standableTile(room.door!.outside)).toBe(false); // door landings never
  });
});

describe('Stage-2 adversarial review regressions', () => {
  it('MAJOR: an in-room mess with a claimed tile is NEVER worked from across the wall', () => {
    // The reviewer's reproduced shape: exam room 10..12 x 10..12 (east door);
    // vomit at interior tile (10,11) with a patient STANDING on it (messes
    // spawn at patient.at - the common in-room case); every interior
    // neighbor claimed. The neighbor scan previously returned the corridor
    // tile (9,11) - Manhattan-adjacent ACROSS the west edge-wall - and the
    // EVS "cleaned" the mess through the wall without entering the room.
    const { world } = setup();
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 13, row: 11 }, true);
    world.addMess('vomit', { col: 10, row: 11 });
    makePatient(world, { at: { col: 10, row: 11 } }); // stands ON the mess
    makePatient(world, { at: { col: 11, row: 11 } }); // claims the E neighbor
    makePatient(world, { at: { col: 10, row: 10 } }); // claims the N neighbor
    makePatient(world, { at: { col: 10, row: 12 } }); // claims the S neighbor
    const evs = addEvs(world);
    evs.at = { col: 5, row: 11 };
    const job = [...world.jobs.values()][0]!;
    run(world, 400, () => {
      // The corridor tile across the wall must never become the work spot.
      if (evs.duty.kind === 'job') {
        expect(!(evs.at.col === 9 && evs.at.row === 11) || job.phase !== 'working').toBe(true);
      }
    });
    // Unworkable from outside: the job survives (held/queued cycles), the
    // mess is still there, and no through-wall clean ever completed.
    expect(world.messes.has('10,11')).toBe(true);
    expect(world.jobs.has(job.id)).toBe(true);
    expect(job.phase).toBe('queued');
    expect(job.holdUntil).toBeGreaterThan(0); // probes failed into holds
  });

  it('MAJOR mirror: with an interior neighbor free, the mess IS worked from inside the room', () => {
    const { world } = setup();
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 13, row: 11 }, true);
    world.addMess('vomit', { col: 10, row: 11 });
    makePatient(world, { at: { col: 10, row: 11 } }); // mess tile claimed...
    const evs = addEvs(world);
    evs.at = { col: 20, row: 11 };
    const job = [...world.jobs.values()][0]!;
    let workedFrom: GridPoint | null = null;
    run(world, 600, () => {
      // Only while the job is LIVE — the completed job object retains its
      // last phase after removeMess deletes it from the map, and the worker
      // has stepped out by then (stale-closure instrumentation bug).
      if (workedFrom === null && world.jobs.has(job.id) && job.phase === 'working') {
        workedFrom = { ...evs.at };
      }
    });
    expect(world.messes.has('10,11')).toBe(false); // ...but an interior neighbor was legal
    expect(workedFrom).not.toBeNull();
    expect(world.roomAt(workedFrom!)?.type).toBe('exam'); // worked from INSIDE
  });

  it('border: fill above trashcanCapacity is refused (review MINOR - a dead can post-load)', () => {
    const { world, events } = setup();
    world.placeAmenity('trashcan', { col: 20, row: 20 });
    const data = serializeWorld(world);
    data.amenities[0]!.fill = M.trashcanCapacity + 1;
    const result = loadWorld(events, JSON.stringify(data));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('fill');
  });
});
