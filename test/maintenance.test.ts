import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { BALANCE } from '../src/sim/data/balance';
import { ROOM_DEFS, roomFailure, ROOM_TYPES } from '../src/sim/data/rooms';
import type { Patient } from '../src/sim/entities/patient';
import type { Reservation, Staff } from '../src/sim/entities/staff';
import type { Room } from '../src/sim/entities/room';
import { validateRoomExpand, validateRoomSell } from '../src/sim/build';
import { breakdownChance, successChance } from '../src/sim/formulas';
import { computeBlockedNeeds } from '../src/sim/needs';
import { SeededRng } from '../src/sim/rng';
import { loadWorld, saveToString } from '../src/sim/save';
import { updateDispatcher } from '../src/sim/systems/dispatcher';
import { updateMovement } from '../src/sim/systems/movement';
import { updatePatientNeeds } from '../src/sim/systems/patientNeeds';
import { updateTreatment } from '../src/sim/systems/treatment';
import type { GridPoint } from '../src/sim/types';
import { World } from '../src/sim/world';

/**
 * Amenities epic Stage 3 (AMENITIES_PLAN §5 / impl plan §S3): use-based
 * wear, breakdowns (disable, never harm), repair jobs on the Stage-2 job
 * machinery, piping bursts, and the broken-room hints — every bolded
 * regression from §S3.9, incl. the three pre-impl MAJORs.
 */

const MAINT = BALANCE.maintenance;
const VITALS = BALANCE.stats.vitalsMax;

function setup(seed = 42): { world: World; events: EventBus } {
  const events = new EventBus();
  const world = new World(events, seed);
  return { world, events };
}

/** Standard breakable fixtures (built free — cash is not under test). */
function buildXray(world: World): Room {
  world.buildRoom('xray', { col: 10, row: 10, cols: 3, rows: 4 }, { col: 11, row: 14 }, true);
  return world.roomsOfType('xray')[0]!;
}

function buildResp(world: World): Room {
  world.buildRoom('resp', { col: 20, row: 10, cols: 3, rows: 3 }, { col: 21, row: 13 }, true);
  return world.roomsOfType('resp')[0]!;
}

/** The pre-impl MAJOR-1 geometry: a 2×3 restroom with the door on the long
 *  WEST edge — the stalls land on the top row and the first stall's only
 *  neighbors are the other stall, the door tile, and through-wall corridor. */
function buildWestDoorRestroom(world: World): Room {
  world.buildRoom('restroom', { col: 10, row: 20, cols: 2, rows: 3 }, { col: 9, row: 21 }, true);
  return world.roomsOfType('restroom')[0]!;
}

/** A parked patient with pinned vitals (fixture writes — allowed in tests). */
function makePatient(
  world: World,
  condition: Parameters<World['spawnPatient']>[0],
  opts: { at?: GridPoint } = {},
): Patient {
  const patient = world.spawnPatient(condition);
  patient.stage = { kind: 'waiting' };
  patient.acuity = 3;
  patient.waitingSince = world.clock.tick;
  patient.health = VITALS;
  patient.patience = VITALS;
  patient.bladder = VITALS;
  patient.thirst = VITALS;
  patient.at = opts.at ? { ...opts.at } : { col: 15, row: 16 };
  patient.next = null;
  patient.path = [];
  patient.target = null;
  return patient;
}

function addTech(world: World, skill = 3): Staff {
  const tech = world.addStaffMember('maintenance', skill, 140);
  tech.at = { col: 15, row: 18 };
  tech.next = null;
  tech.path = [];
  tech.target = null;
  return tech;
}

/** Drive dispatch (incl. jobs) + movement + treatment with an advancing clock. */
function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    world.clock.advance();
    updateDispatcher(world);
    updateMovement(world);
    updateTreatment(world);
  }
}

/** A crafted ACTIVE reservation one tick from completion (fixture writes). */
function activeReservation(world: World, room: Room, patient: Patient, member: Staff): Reservation {
  const reservation: Reservation = {
    id: world.takeId(),
    kind: 'treatment',
    patientId: patient.id,
    roomId: room.id,
    staffIds: [member.id],
    stepIndex: 0,
    slotIndex: 0,
    phase: 'active',
    ticksRemaining: 1,
    patientWaitingSince: null,
  };
  world.reservations.set(reservation.id, reservation);
  patient.stage = { kind: 'reserved', reservationId: reservation.id };
  member.duty = { kind: 'reserved', reservationId: reservation.id };
  return reservation;
}

/** An rng state whose NEXT draw is ≥ `threshold` (forces a chance() miss). */
function stateWithNextAtLeast(threshold: number): number {
  const rng = new SeededRng(0);
  for (let s = 1; s < 1_000_000; s++) {
    rng.setState(s);
    if (rng.next() >= threshold) return s;
  }
  throw new Error('no state found');
}

// ------------------------------------------------------------- the formula

describe('breakdownChance (§5.1 — the ONE derivation)', () => {
  it('is 0 at zero wear, linear in wear, and clamps at 1', () => {
    expect(breakdownChance('mechanical', 0)).toBe(0);
    expect(breakdownChance('piping', 0)).toBe(0);
    expect(breakdownChance('mechanical', 10)).toBeCloseTo(MAINT.wearFactor.mechanical * 10, 12);
    expect(breakdownChance('piping', 10)).toBeCloseTo(MAINT.wearFactor.piping * 10, 12);
    expect(breakdownChance('mechanical', 1_000_000)).toBe(1);
  });

  it('failure roster matches §5.1 (ratified): gantries+OR+resp mechanical, restroom+dialysis piping', () => {
    const roster: Record<string, 'mechanical' | 'piping' | undefined> = {};
    for (const type of ROOM_TYPES) roster[type] = roomFailure(type)?.kind;
    expect(roster).toEqual({
      reception: undefined,
      waiting: undefined,
      triage: undefined,
      exam: undefined,
      xray: 'mechanical',
      resp: 'mechanical',
      er: undefined,
      ultrasound: undefined, // a cart, not a gantry — explicitly excluded
      ct: 'mechanical',
      mri: 'mechanical',
      nucMed: 'mechanical',
      dialysis: 'piping',
      surgery: 'mechanical',
      restroom: 'piping',
      atrium: undefined,
    });
  });
});

// ------------------------------------------------------------ applyRoomUse

describe('applyRoomUse (§S3.1 — THE wear choke point)', () => {
  it('increments wear on a failure room', () => {
    const { world } = setup();
    const xray = buildXray(world);
    world.applyRoomUse(xray);
    expect(xray.wear).toBe(1);
  });

  it('is a zero-rng no-op for rooms without a failure def', () => {
    const { world } = setup();
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 11, row: 13 }, true);
    const exam = world.roomsOfType('exam')[0]!;
    const before = world.rng.getState();
    world.applyRoomUse(exam);
    expect(exam.wear).toBe(0);
    expect(world.rng.getState()).toBe(before); // no draw — stream untouched
  });

  it('is a zero-rng no-op while broken (broken ⇒ wear stays 0; no double-break)', () => {
    const { world } = setup();
    const xray = buildXray(world);
    world.breakRoom(xray);
    const since = xray.brokenSince;
    const before = world.rng.getState();
    world.applyRoomUse(xray);
    expect(xray.wear).toBe(0);
    expect(xray.brokenSince).toBe(since);
    expect(world.rng.getState()).toBe(before);
  });

  it('breaks the room when the roll hits (wear high enough ⇒ chance clamps to 1)', () => {
    const { world } = setup();
    const xray = buildXray(world);
    xray.wear = 1_000_000; // next use is a certain failure
    world.applyRoomUse(xray);
    expect(xray.brokenSince).toBe(world.clock.tick);
    expect(xray.wear).toBe(0);
  });
});

// ---------------------------------------------------------------- breakRoom

describe('breakRoom (§5.2 — disable, never harm)', () => {
  it('flags the room, zeroes capacity, and mints ONE repair job anchored inside the rect', () => {
    const { world, events } = setup();
    const xray = buildXray(world);
    xray.wear = 7;
    let brokenEvents = 0;
    events.on('roomBroken', () => (brokenEvents += 1));
    world.breakRoom(xray);
    expect(xray.brokenSince).toBe(world.clock.tick);
    expect(xray.wear).toBe(0);
    expect(world.capacityOf(xray)).toBe(0);
    expect(brokenEvents).toBe(1);
    const jobs = [...world.jobs.values()];
    expect(jobs.length).toBe(1);
    const job = jobs[0]!;
    expect(job.kind).toBe('repair');
    expect(job.roomId).toBe(xray.id);
    expect(job.phase).toBe('queued');
    expect(
      job.tile.col >= xray.rect.col &&
        job.tile.col < xray.rect.col + xray.rect.cols &&
        job.tile.row >= xray.rect.row &&
        job.tile.row < xray.rect.row + xray.rect.rows,
    ).toBe(true);
  });

  it('cancels GATHERING reservations (rule-8: re-queue + retry hold), staff released', () => {
    const { world } = setup();
    const xray = buildXray(world);
    const tech = world.addStaffMember('radTech', 3, 200);
    tech.at = { col: 15, row: 18 };
    tech.next = null;
    tech.path = [];
    tech.target = null;
    const patient = makePatient(world, 'fracture');
    world.clock.advance();
    updateDispatcher(world); // organic reservation — gathering phase
    const reservation = [...world.reservations.values()][0];
    expect(reservation?.phase).toBe('gathering'); // premise
    world.breakRoom(xray);
    expect(world.reservations.size).toBe(0);
    expect(patient.stage.kind).toBe('waiting');
    expect(patient.dispatchHoldUntil).toBeGreaterThan(world.clock.tick);
    expect(tech.duty.kind).toBe('idle');
  });

  it('ACTIVE reservations finish and bill normally on a broken room', () => {
    const { world } = setup();
    const xray = buildXray(world);
    const radTech = world.addStaffMember('radTech', 3, 200);
    const patient = makePatient(world, 'fracture');
    activeReservation(world, xray, patient, radTech);
    world.breakRoom(xray);
    expect(world.reservations.size).toBe(1); // active survived
    const revenueBefore = world.today.revenue;
    // Force a SUCCESS so the completion path is deterministic: next() < p.
    world.rng.setState(1);
    if (world.rng.next() >= successChance(3, VITALS)) throw new Error('pick another state');
    world.rng.setState(1);
    world.clock.advance();
    updateTreatment(world);
    expect(world.today.revenue).toBeGreaterThan(revenueBefore); // billed
    expect(world.reservations.size).toBe(0);
    expect(xray.brokenSince).not.toBeNull(); // the finishing use adds NO wear/roll
    expect(xray.wear).toBe(0);
  });

  it('dispatcher never reserves a broken room (capacityOf 0 gates hasOpenSlot)', () => {
    const { world } = setup();
    const xray = buildXray(world);
    const radTech = world.addStaffMember('radTech', 3, 200);
    radTech.at = { col: 15, row: 18 };
    radTech.next = null;
    radTech.path = [];
    radTech.target = null;
    makePatient(world, 'fracture');
    world.breakRoom(xray);
    world.clock.advance();
    updateDispatcher(world);
    expect(world.reservations.size).toBe(0);
    // Restore service (fixture write) → the SAME dispatch pass now reserves.
    xray.brokenSince = null;
    world.clock.advance();
    updateDispatcher(world);
    expect(world.reservations.size).toBe(1);
  });
});

// -------------------------------------------------------- wear hook: treatment

describe('treatment wear hooks (§S3.2 — outcome-agnostic)', () => {
  it('a SUCCESSFUL completion increments wear', () => {
    const { world } = setup();
    const xray = buildXray(world);
    const radTech = world.addStaffMember('radTech', 3, 200);
    const patient = makePatient(world, 'fracture');
    activeReservation(world, xray, patient, radTech);
    world.rng.setState(1);
    if (world.rng.next() >= successChance(3, VITALS)) throw new Error('pick another state');
    world.rng.setState(1);
    const revenueBefore = world.today.revenue;
    world.clock.advance();
    updateTreatment(world);
    expect(world.today.revenue).toBeGreaterThan(revenueBefore); // success — billed
    expect(patient.health).toBe(VITALS); // no complication penalty
    expect(xray.wear).toBe(1);
  });

  it("the hook is UNCONDITIONAL: a missing patient (defensive early-return) still counts the use", () => {
    const { world } = setup();
    const xray = buildXray(world);
    const radTech = world.addStaffMember('radTech', 3, 200);
    const patient = makePatient(world, 'fracture');
    activeReservation(world, xray, patient, radTech);
    world.patients.delete(patient.id); // the defensive branch's premise
    world.clock.advance();
    updateTreatment(world);
    expect(world.reservations.size).toBe(0); // released by the early-return
    expect(xray.wear).toBe(1); // one rng-order rule, no forks (pre-impl NIT 8)
  });

  it('a COMPLICATION increments wear too (the machine ran)', () => {
    const { world } = setup();
    const xray = buildXray(world);
    const radTech = world.addStaffMember('radTech', 3, 200);
    const patient = makePatient(world, 'fracture');
    activeReservation(world, xray, patient, radTech);
    world.rng.setState(stateWithNextAtLeast(successChance(3, VITALS)));
    const revenueBefore = world.today.revenue;
    world.clock.advance();
    updateTreatment(world);
    expect(patient.stage.kind).toBe('waiting'); // complication — re-queued
    expect(patient.health).toBe(VITALS - BALANCE.treatment.complicationHealthPenalty);
    expect(world.today.revenue).toBe(revenueBefore); // nothing billed
    expect(xray.wear).toBe(1);
  });
});

// ------------------------------------------------- wear hook: restroom + claims

describe('restroom wear + broken-restroom claims (§S3.1/§S3.2)', () => {
  function usingBreak(world: World, room: Room, patient: Patient): void {
    patient.stage = { kind: 'waiting' };
    patient.needBreak = {
      kind: 'restroom',
      roomId: room.id,
      slot: 0,
      phase: 'using',
      ticksRemaining: 1,
      startedAt: world.clock.tick,
    };
    patient.at = { ...room.door!.inside };
    patient.next = null;
    patient.path = [];
    patient.target = null;
  }

  it('a completed restroom visit increments wear', () => {
    const { world } = setup();
    const restroom = buildWestDoorRestroom(world);
    const patient = makePatient(world, 'flu');
    usingBreak(world, restroom, patient);
    world.clock.advance();
    updatePatientNeeds(world);
    expect(patient.needBreak).toBeNull();
    expect(patient.bladder).toBe(VITALS);
    expect(restroom.wear).toBe(1);
  });

  it('a broken restroom rejects NEW claims (failed probe → retry hold)', () => {
    const { world } = setup();
    const restroom = buildWestDoorRestroom(world);
    world.breakRoom(restroom);
    const patient = makePatient(world, 'flu');
    patient.bladder = BALANCE.needs.seekThreshold - 5;
    world.clock.advance();
    updatePatientNeeds(world);
    expect(patient.needBreak).toBeNull();
    expect(patient.needBreakHoldUntil).toBeGreaterThan(world.clock.tick);
  });

  it('an in-flight claimant finishes inside a broken restroom with NO wear roll', () => {
    const { world } = setup();
    const restroom = buildWestDoorRestroom(world);
    const patient = makePatient(world, 'flu');
    usingBreak(world, restroom, patient);
    world.breakRoom(restroom);
    world.clock.advance();
    updatePatientNeeds(world);
    expect(patient.bladder).toBe(VITALS); // occupants finish — disable, never harm
    expect(restroom.wear).toBe(0); // applyRoomUse no-ops while broken
    expect(restroom.brokenSince).not.toBeNull();
    // Live-drive review MINOR 1: the break instant must never dump a
    // claimant into the lost fallback — completion returns them to plain
    // waiting (the flicker observed live was the ambient wrong-turn
    // mechanic on the walk back, not a break side effect).
    expect(patient.lost).toBeNull();
    expect(patient.stage.kind).toBe('waiting');
    expect(patient.needBreak).toBeNull();
  });
});

// ----------------------------------------------- the repair anchor (MAJOR 1/2a)

describe('repair anchor workability (pre-impl MAJORs 1 + 2a)', () => {
  it('MAJOR-1 regression: the 2×3 west-door restroom anchors WORKABLY and gets repaired', () => {
    const { world } = setup();
    const restroom = buildWestDoorRestroom(world);
    world.breakRoom(restroom);
    // Premise: the naive first prop tile (10,20) is structurally unworkable —
    // its neighbors are the other stall, the door tile, and through-wall.
    const job = [...world.jobs.values()].find((j) => j.kind === 'repair')!;
    expect(job.tile).not.toEqual({ col: 10, row: 20 });
    addTech(world);
    run(world, 600);
    expect(restroom.brokenSince).toBeNull(); // repaired — never an eternal re-hold loop
    // The piping burst's clean jobs remain (no EVS hired) — only the REPAIR
    // job must be gone.
    expect([...world.jobs.values()].every((j) => j.kind === 'clean')).toBe(true);
  });

  it('post-impl MAJOR 1: a mess on a WALKABLE repair anchor RE-ANCHORS the job — the save never bricks', () => {
    const { world } = setup();
    const restroom = buildWestDoorRestroom(world);
    world.breakRoom(restroom);
    const job = [...world.jobs.values()].find((j) => j.kind === 'repair')!;
    // Force the walkable-anchor class (fixture write — a legal pass-2 anchor
    // shape): patients stand on walkable tiles, and accidents/vomit drop at
    // patient.at, so a mess CAN land exactly on this tile.
    job.tile = { col: 10, row: 21 };
    world.addMess('vomit', { col: 10, row: 21 });
    // The clean mint was NOT suppressed; the repair job moved off the tile.
    expect(world.jobAt({ col: 10, row: 21 })!.kind).toBe('clean');
    expect(job.tile).not.toEqual({ col: 10, row: 21 });
    expect(world.jobs.size).toBe(2 + [...world.messes.values()].length - 1); // repair + a clean per mess
    // The world's own save loads MID-repair…
    expect(loadWorld(new EventBus(), saveToString(world)).ok).toBe(true);
    // …and POST-repair (the repair job leaves; the mess keeps its clean job).
    addTech(world);
    run(world, 600);
    expect(restroom.brokenSince).toBeNull();
    expect(world.jobAt({ col: 10, row: 21 })?.kind).toBe('clean');
    expect(loadWorld(new EventBus(), saveToString(world)).ok).toBe(true);
  });

  it('post-impl MAJOR 1b: re-anchoring an ASSIGNED repair releases the tech to re-converge', () => {
    const { world } = setup();
    const xray = buildXray(world);
    world.breakRoom(xray);
    const tech = addTech(world);
    world.clock.advance();
    updateDispatcher(world);
    const job = [...world.jobs.values()].find((j) => j.kind === 'repair')!;
    expect(job.phase).toBe('assigned'); // premise: tech bound, mid-walk
    job.tile = { col: 10, row: 11 }; // walkable interior (fixture write)
    world.addMess('vomit', { col: 10, row: 11 });
    expect(job.phase).toBe('queued'); // released — a stale walk can't satisfy the border
    expect(job.staffId).toBeNull();
    expect(tech.duty.kind).toBe('idle');
    expect(loadWorld(new EventBus(), saveToString(world)).ok).toBe(true);
    run(world, 600); // and the repair still completes on the NEW anchor
    expect(xray.brokenSince).toBeNull();
  });

  it('MAJOR-2a regression: an anchor tile under an existing job is skipped — the repair mint is guaranteed', () => {
    const { world } = setup();
    const restroom = buildWestDoorRestroom(world);
    // A mess + auto-minted clean job on the SECOND stall tile (the workable
    // anchor the scan would otherwise pick — the first is the MAJOR-1 dud).
    world.addMess('vomit', { col: 11, row: 20 });
    world.breakRoom(restroom);
    const repairs = [...world.jobs.values()].filter((j) => j.kind === 'repair');
    expect(repairs.length).toBe(1); // the mint was NOT suppressed
    expect(repairs[0]!.tile).not.toEqual({ col: 11, row: 20 });
    expect(repairs[0]!.roomId).toBe(restroom.id);
  });
});

// ------------------------------------------------------------- piping bursts

describe('piping bursts (§S3.3)', () => {
  it('drops 2–4 NEW water messes in-room / adjacent corridor only, each with a clean job', () => {
    const { world } = setup();
    const restroom = buildWestDoorRestroom(world);
    // A walled neighbor sharing the restroom's east edge — water must never
    // enter it (§5.4 NIT 21: no water through walls).
    world.buildRoom('exam', { col: 12, row: 20, cols: 3, rows: 3 }, { col: 13, row: 23 }, true);
    // A pre-existing mess inside the restroom: its tile is EXCLUDED from the
    // candidate set (pre-impl MINOR 5 — every burst placement is a real mess).
    world.addMess('vomit', { col: 10, row: 21 });
    world.breakRoom(restroom);
    const water = [...world.messes.values()].filter((m) => m.kind === 'water');
    expect(water.length).toBeGreaterThanOrEqual(MAINT.burstMessesMin);
    expect(water.length).toBeLessThanOrEqual(MAINT.burstMessesMax);
    expect(world.messes.get('10,21')!.kind).toBe('vomit'); // never overwritten
    const rect = restroom.rect;
    for (const mess of water) {
      const inRoom =
        mess.tile.col >= rect.col &&
        mess.tile.col < rect.col + rect.cols &&
        mess.tile.row >= rect.row &&
        mess.tile.row < rect.row + rect.rows;
      const room = world.roomAt(mess.tile);
      if (inRoom) {
        expect(room!.id).toBe(restroom.id);
      } else {
        // Ring tile: corridor or open-plan — NEVER a walled neighbor's interior.
        expect(room === null || ROOM_DEFS[room.type].kind === 'open').toBe(true);
        const adjacent =
          (mess.tile.col >= rect.col - 1 &&
            mess.tile.col <= rect.col + rect.cols &&
            mess.tile.row >= rect.row - 1 &&
            mess.tile.row <= rect.row + rect.rows);
        expect(adjacent).toBe(true);
      }
      const job = world.jobAt(mess.tile);
      expect(job?.kind).toBe('clean'); // every burst mess is cleanable
    }
  });

  it('mechanical breakdowns burst nothing', () => {
    const { world } = setup();
    const xray = buildXray(world);
    world.breakRoom(xray);
    expect(world.messes.size).toBe(0);
  });
});

// ----------------------------------------------------- trade split + lifecycle

describe('repair jobs on the Stage-2 machinery (§S3.4)', () => {
  it('trade split: maintenance takes repair, EVS takes clean — never crossed', () => {
    const { world } = setup();
    const xray = buildXray(world);
    world.addMess('vomit', { col: 30, row: 30 });
    world.breakRoom(xray);
    const evs = world.addStaffMember('evs', 3, 90);
    evs.at = { col: 28, row: 30 };
    evs.next = null;
    evs.path = [];
    evs.target = null;
    const tech = addTech(world);
    world.clock.advance();
    updateDispatcher(world);
    const byKind = new Map([...world.jobs.values()].map((j) => [j.kind, j]));
    expect(byKind.get('repair')!.staffId).toBe(tech.id);
    expect(byKind.get('clean')!.staffId).toBe(evs.id);
  });

  it('EVS alone NEVER takes a repair job (it stays queued)', () => {
    const { world } = setup();
    const xray = buildXray(world);
    world.breakRoom(xray);
    const evs = world.addStaffMember('evs', 3, 90);
    evs.at = { col: 15, row: 18 };
    evs.next = null;
    evs.path = [];
    evs.target = null;
    run(world, 50);
    const repair = [...world.jobs.values()].find((j) => j.kind === 'repair')!;
    expect(repair.phase).toBe('queued');
    expect(evs.duty.kind).toBe('idle');
  });

  it('full lifecycle: assigned → working ("Repairing") → service restored → tech steps out (sale unpinned)', () => {
    const { world } = setup();
    const xray = buildXray(world);
    world.breakRoom(xray);
    const tech = addTech(world);
    let sawWorking = false;
    for (let i = 0; i < 600 && xray.brokenSince !== null; i++) {
      run(world, 1);
      const job = [...world.jobs.values()].find((j) => j.kind === 'repair');
      if (job?.phase === 'working') {
        sawWorking = true;
        expect(job.staffId).toBe(tech.id);
      }
    }
    expect(sawWorking).toBe(true);
    expect(xray.brokenSince).toBeNull();
    expect(world.capacityOf(xray)).toBe(1); // service restored
    expect(world.jobs.size).toBe(0);
    run(world, 100); // step-out walk completes
    expect(validateRoomSell(world, xray.id).ok).toBe(true); // nobody left inside
  });

  it('oldest repair first (lowest id); a HELD repair is skipped, never blocking', () => {
    const { world } = setup();
    const xray = buildXray(world);
    const resp = buildResp(world);
    world.breakRoom(xray); // older job (lower id)
    world.breakRoom(resp);
    const tech = addTech(world);
    const [older, younger] = [...world.jobs.values()].sort((a, b) => a.id - b.id);
    world.clock.advance();
    updateDispatcher(world);
    expect(older!.staffId).toBe(tech.id); // oldest-first
    // Reset and hold the older job: the younger one must assign instead.
    older!.staffId = null;
    older!.phase = 'queued';
    tech.duty = { kind: 'idle' };
    tech.path = [];
    tech.target = null;
    older!.holdUntil = world.clock.tick + 1_000;
    world.clock.advance();
    updateDispatcher(world);
    expect(younger!.staffId).toBe(tech.id);
    expect(older!.phase).toBe('queued');
  });

  it('a stalled arrival (dead path reads as "arrived") requeues the repair + holds', () => {
    const { world } = setup();
    const xray = buildXray(world);
    world.breakRoom(xray);
    const tech = addTech(world);
    world.clock.advance();
    updateDispatcher(world);
    const job = [...world.jobs.values()].find((j) => j.kind === 'repair')!;
    expect(job.phase).toBe('assigned');
    // Kill the walk mid-flight (fixture write): arrived-but-elsewhere.
    tech.next = null;
    tech.path = [];
    tech.target = null;
    world.clock.advance();
    updateDispatcher(world);
    expect(job.phase).toBe('queued');
    expect(job.staffId).toBeNull();
    expect(job.holdUntil).toBeGreaterThan(world.clock.tick); // the rule-8 analogue
  });

  it('fire-mid-repair requeues the job (assigned AND working phases)', () => {
    const { world } = setup();
    const xray = buildXray(world);
    world.breakRoom(xray);
    const tech = addTech(world);
    world.clock.advance();
    updateDispatcher(world);
    const job = [...world.jobs.values()].find((j) => j.kind === 'repair')!;
    expect(job.phase).toBe('assigned');
    const queue = new CommandQueue();
    queue.push({ type: 'fireStaff', staffId: tech.id });
    world.applyCommands(queue);
    expect(world.staff.has(tech.id)).toBe(false);
    expect(job.phase).toBe('queued');
    expect(job.staffId).toBeNull();
    // A second tech picks it up and finishes.
    addTech(world);
    run(world, 600);
    expect(xray.brokenSince).toBeNull();
  });
});

// ------------------------------------------------------------ geometry rules

describe('broken-room geometry (§5.2 / pre-impl MAJOR 3)', () => {
  it('expand is rejected while broken', () => {
    const { world } = setup();
    const xray = buildXray(world);
    world.breakRoom(xray);
    const grown = { col: 10, row: 10, cols: 4, rows: 4 };
    const result = validateRoomExpand(world, xray.id, grown, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Out of service');
  });

  it('selling a broken room with a QUEUED repair deletes the job (orphan rule)', () => {
    const { world } = setup();
    const xray = buildXray(world);
    world.breakRoom(xray);
    expect(world.jobs.size).toBe(1);
    const queue = new CommandQueue();
    queue.push({ type: 'sellRoom', roomId: xray.id });
    world.applyCommands(queue);
    expect(world.rooms.size).toBe(0);
    expect(world.jobs.size).toBe(0);
  });

  it('selling while the repair is ASSIGNED (tech still outside) releases the mid-walk tech', () => {
    const { world } = setup();
    const xray = buildXray(world);
    world.breakRoom(xray);
    const tech = addTech(world);
    world.clock.advance();
    updateDispatcher(world);
    const job = [...world.jobs.values()].find((j) => j.kind === 'repair')!;
    expect(job.phase).toBe('assigned'); // premise: bound, walking, outside
    expect(world.roomAt(tech.at)).toBeNull();
    const queue = new CommandQueue();
    queue.push({ type: 'sellRoom', roomId: xray.id });
    world.applyCommands(queue);
    expect(world.rooms.size).toBe(0);
    expect(world.jobs.size).toBe(0);
    expect(world.staff.has(tech.id)).toBe(true); // released, not removed
    expect(tech.duty.kind).toBe('idle');
  });

  it('MAJOR-3 pair: sale REJECTED while the tech works inside; job + worker released on a legal sale', () => {
    const { world } = setup();
    const xray = buildXray(world);
    world.breakRoom(xray);
    const tech = addTech(world);
    // Drive until the tech is INSIDE working.
    for (let i = 0; i < 600; i++) {
      run(world, 1);
      const job = [...world.jobs.values()].find((j) => j.kind === 'repair');
      if (job?.phase === 'working') break;
    }
    const job = [...world.jobs.values()].find((j) => j.kind === 'repair')!;
    expect(job.phase).toBe('working'); // premise
    expect(world.roomAt(tech.at)?.id).toBe(xray.id); // premise: inside
    const blocked = validateRoomSell(world, xray.id);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain('Someone is inside');
    // Fire-then-sell is the player remedy: job requeues, tech leaves, sale legal.
    const queue = new CommandQueue();
    queue.push({ type: 'fireStaff', staffId: tech.id });
    queue.push({ type: 'sellRoom', roomId: xray.id });
    world.applyCommands(queue);
    expect(world.rooms.size).toBe(0);
    expect(world.jobs.size).toBe(0);
  });
});

// ------------------------------------------------------------- debugBreakRoom

describe('debugBreakRoom (§S3.1 — the debugForce precedent)', () => {
  it('mirrors the REAL path (piping burst included) and is border-guarded', () => {
    const { world } = setup();
    const restroom = buildWestDoorRestroom(world);
    world.buildRoom('exam', { col: 20, row: 20, cols: 3, rows: 3 }, { col: 21, row: 23 }, true);
    const exam = world.roomsOfType('exam')[0]!;
    const queue = new CommandQueue();
    queue.push({ type: 'debugBreakRoom', roomId: 31337 }); // unknown — inert
    queue.push({ type: 'debugBreakRoom', roomId: exam.id }); // no failure def — inert
    queue.push({ type: 'debugBreakRoom', roomId: restroom.id }); // real
    queue.push({ type: 'debugBreakRoom', roomId: restroom.id }); // already broken — inert
    world.applyCommands(queue);
    expect(exam.brokenSince).toBeNull();
    expect(restroom.brokenSince).not.toBeNull();
    expect([...world.jobs.values()].filter((j) => j.kind === 'repair').length).toBe(1);
    expect([...world.messes.values()].some((m) => m.kind === 'water')).toBe(true); // burst ran
  });

  it('is dropped in challenge mode (the one debug gate)', () => {
    const events = new EventBus();
    const world = new World(events, 42, true); // challengeMode
    world.buildRoom('xray', { col: 10, row: 10, cols: 3, rows: 4 }, { col: 11, row: 14 }, true);
    const xray = world.roomsOfType('xray')[0]!;
    const queue = new CommandQueue();
    queue.push({ type: 'debugBreakRoom', roomId: xray.id });
    world.applyCommands(queue);
    expect(xray.brokenSince).toBeNull();
  });
});

// -------------------------------------------------------------------- hints

describe('broken-room hints (§6 / §S3.6)', () => {
  it('a broken room yields an instance-keyed urgent row; a re-break re-keys (design MINOR 8)', () => {
    const { world } = setup();
    const xray = buildXray(world);
    world.breakRoom(xray);
    const firstKey = `broken:${xray.id}:${xray.brokenSince}`;
    let needs = computeBlockedNeeds(world);
    let row = needs.find((n) => n.kind === 'broken');
    expect(row?.key).toBe(firstKey);
    expect(row?.urgent).toBe(true);
    expect(row?.label).toBe('X-Ray is broken — needs repair');
    // Repair (fixture write), advance, re-break: the key must CHANGE so the
    // second breakdown toasts again (hintedOnce persists per save).
    xray.brokenSince = null;
    world.jobs.clear();
    for (let i = 0; i < 5; i++) world.clock.advance();
    world.breakRoom(xray);
    needs = computeBlockedNeeds(world);
    row = needs.find((n) => n.kind === 'broken');
    expect(row?.key).toBe(`broken:${xray.id}:${xray.brokenSince}`);
    expect(row?.key).not.toBe(firstKey);
  });

  it('role:maintenance is urgent while anything is broken and nobody is hired; hired ⇒ gone', () => {
    const { world } = setup();
    const xray = buildXray(world);
    const resp = buildResp(world);
    world.breakRoom(xray);
    world.breakRoom(resp);
    const need = computeBlockedNeeds(world).find((n) => n.key === 'role:maintenance');
    expect(need?.urgent).toBe(true);
    expect(need?.patients).toBe(2); // broken-room count drives the tie-break
    expect(need?.label).toBe('Hire a Maintenance Tech — a room needs repair');
    addTech(world);
    expect(
      computeBlockedNeeds(world).find((n) => n.key === 'role:maintenance'),
    ).toBeUndefined();
  });

  it('no broken rooms ⇒ no broken/maintenance rows', () => {
    const { world } = setup();
    buildXray(world);
    const needs = computeBlockedNeeds(world);
    expect(needs.some((n) => n.kind === 'broken')).toBe(false);
    expect(needs.some((n) => n.key === 'role:maintenance')).toBe(false);
  });
});
