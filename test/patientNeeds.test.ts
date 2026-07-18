import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/events';
import { gameMinutesToTicks, TICKS_PER_GAME_HOUR } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import { THOUGHTS } from '../src/sim/data/thoughts';
import type { Patient } from '../src/sim/entities/patient';
import {
  meterDecayPerTick,
  patienceDecayPerTick,
} from '../src/sim/formulas';
import { validateRoomExpand, validateRoomSell } from '../src/sim/build';
import { updateDecay } from '../src/sim/systems/decay';
import { updateDispatcher } from '../src/sim/systems/dispatcher';
import { updateMovement } from '../src/sim/systems/movement';
import { updatePatientNeeds } from '../src/sim/systems/patientNeeds';
import { World } from '../src/sim/world';

/**
 * Amenities epic Stage 1 (AMENITIES_PLAN §3.1–3.3 / impl plan §3): need
 * meters, the need side-trip sub-state machine, and its interactions with
 * decay, dispatch, geometry gates, and terminal events.
 */

const N = BALANCE.needs;
const VITALS = BALANCE.stats.vitalsMax;

function setup(seed = 42) {
  const events = new EventBus();
  const world = new World(events, seed);
  return { world, events };
}

/** A parked waiting patient with full meters (fixture writes — allowed). */
function makePatient(
  world: World,
  opts: { at?: { col: number; row: number }; stage?: Patient['stage'] } = {},
): Patient {
  const patient = world.spawnPatient('flu');
  patient.stage = opts.stage ?? { kind: 'waiting' };
  patient.acuity = 3;
  patient.waitingSince = world.clock.tick;
  patient.bladder = VITALS;
  patient.thirst = VITALS;
  if (opts.at) patient.at = { ...opts.at };
  patient.next = null;
  patient.path = [];
  patient.target = null;
  return patient;
}

/** A 2×3 restroom (derives exactly 2 stalls) with an east door. */
function buildRestroom(world: World) {
  world.buildRoom('restroom', { col: 10, row: 10, cols: 2, rows: 3 }, { col: 12, row: 11 }, true);
  return world.roomsOfType('restroom')[0]!;
}

/** Drive needs+movement with an advancing clock (no spawn/decay noise). */
function run(world: World, ticks: number, also?: () => void): void {
  for (let i = 0; i < ticks; i++) {
    world.clock.advance();
    updatePatientNeeds(world);
    updateMovement(world);
    also?.();
  }
}

describe('need meters (§3.1) — spawn + decay', () => {
  it('spawn meters are rng-rolled in [spawnMeterMin, vitalsMax], per-seed deterministic', () => {
    const roll = (seed: number): number[][] => {
      const { world } = setup(seed);
      const values: number[][] = [];
      for (let i = 0; i < 20; i++) {
        const p = world.spawnPatient('flu');
        values.push([p.bladder, p.thirst]);
      }
      return values;
    };
    const a = roll(7);
    for (const [bladder, thirst] of a) {
      expect(bladder).toBeGreaterThanOrEqual(N.spawnMeterMin);
      expect(bladder).toBeLessThanOrEqual(VITALS);
      expect(thirst).toBeGreaterThanOrEqual(N.spawnMeterMin);
      expect(thirst).toBeLessThanOrEqual(VITALS);
    }
    // Genuinely rolled (not a constant) and deterministic per seed.
    expect(new Set(a.flat()).size).toBeGreaterThan(1);
    expect(roll(7)).toEqual(a);
  });

  it('meters decay at the balance per-game-hour rates, in every pre-terminal stage', () => {
    const { world } = setup();
    const waiting = makePatient(world);
    const reserved = makePatient(world, { stage: { kind: 'reserved', reservationId: 999 } });
    updateDecay(world);
    for (const p of [waiting, reserved]) {
      expect(VITALS - p.bladder).toBeCloseTo(meterDecayPerTick(N.bladderPerGameHour), 10);
      expect(VITALS - p.thirst).toBeCloseTo(meterDecayPerTick(N.thirstPerGameHour), 10);
    }
    // Rate sanity: one game-hour of ticks drains exactly the table rate.
    expect(meterDecayPerTick(N.bladderPerGameHour) * TICKS_PER_GAME_HOUR).toBeCloseTo(
      N.bladderPerGameHour,
      10,
    );
  });

  it('thirst clamps at 0 (no event); the unmet multiplier keeps stacking', () => {
    const { world } = setup();
    const p = makePatient(world);
    p.thirst = 0.0001;
    updateDecay(world);
    expect(p.thirst).toBe(0);
    updateDecay(world);
    expect(p.thirst).toBe(0); // clamped, not negative
  });
});

describe('unmet-need patience stack (§3.1, M3-gate composition)', () => {
  it('standing 1.5 × comfort 0.75 × 1.25² — exact multiplication into the stack', () => {
    const { world } = setup();
    world.buildRoom('atrium', { col: 10, row: 10, cols: 4, rows: 4 }, null, true);
    const inComfort = makePatient(world, { at: { col: 11, row: 11 } });
    const outside = makePatient(world, { at: { col: 35, row: 35 } });
    for (const p of [inComfort, outside]) {
      p.waitingRoomId = null; // standing
      p.bladder = N.seekThreshold - 1; // both meters unmet
      p.thirst = N.seekThreshold - 1;
    }
    updateDecay(world);
    const base =
      patienceDecayPerTick(3) *
      BALANCE.decay.standingMultiplier *
      N.unmetPatienceMultiplier ** 2;
    expect(VITALS - outside.patience).toBeCloseTo(base, 10);
    expect(VITALS - inComfort.patience).toBeCloseTo(
      base * BALANCE.wayfinding.comfortAuraPatienceMultiplier,
      10,
    );
  });

  it('worst-case decay-stack bound (design NIT 23): ~3.6h to AMA, under 4h', () => {
    // Acuity 5, standing, both needs unmet: 12 × 1.5 × 1.25² per game-hour.
    const perHour =
      BALANCE.decay.patiencePerGameHour[5]! *
      BALANCE.decay.standingMultiplier *
      N.unmetPatienceMultiplier ** 2;
    const hoursToAma = VITALS / perHour;
    expect(hoursToAma).toBeCloseTo(3.556, 2);
    expect(hoursToAma).toBeLessThan(4);
    expect(hoursToAma).toBeGreaterThan(3);
  });

  it('patience is PAUSED while `using`; a purposeful break walk stays free (rule 3)', () => {
    const { world } = setup();
    const using = makePatient(world);
    using.needBreak = {
      kind: 'restroom',
      roomId: 1,
      slot: 0,
      phase: 'using',
      ticksRemaining: 100,
      startedAt: 0,
    };
    const walking = makePatient(world);
    walking.needBreak = {
      kind: 'vending',
      tile: { col: 5, row: 5 },
      phase: 'walking',
      ticksRemaining: 0,
      startedAt: 0,
    };
    walking.next = { col: 20, row: 38 }; // mid-step: not arrived → rule-3 free
    updateDecay(world);
    expect(using.patience).toBe(VITALS);
    expect(walking.patience).toBe(VITALS);
  });
});

describe('bladder accidents (§3.1, design principle 3)', () => {
  it('AMA-eligible stage: −20 hit (floored at 0), meter refills, accident thought', () => {
    const { world, events } = setup();
    const thoughts: string[] = [];
    events.on('patientThought', ({ text }) => thoughts.push(text));
    const p = makePatient(world);
    p.next = { col: 20, row: 38 }; // walking → patience decay skipped (exact hit)
    p.patience = 50;
    p.bladder = 0.0001;
    updateDecay(world);
    expect(p.bladder).toBe(VITALS);
    expect(p.patience).toBe(50 - N.accidentPatienceHit);
    expect(thoughts.some((t) => (THOUGHTS.accident as readonly string[]).includes(t))).toBe(true);
    // Hit to 0 in an AMA-eligible stage: no INSTANT AMA — normal rules apply.
    p.patience = 10;
    p.bladder = 0.0001;
    updateDecay(world);
    expect(p.patience).toBe(0);
    expect(p.stage.kind).toBe('waiting');
  });

  it('non-AMA-eligible stages (checkingIn/reserved) clamp at the floor — never a new fail state', () => {
    const { world } = setup();
    for (const stage of [
      { kind: 'checkingIn', roomId: 999, ticksRemaining: 10 },
      { kind: 'reserved', reservationId: 999 },
    ] as const) {
      const p = makePatient(world, { stage });
      p.patience = 5;
      p.bladder = 0.0001;
      updateDecay(world);
      expect(p.bladder).toBe(VITALS);
      expect(p.patience).toBe(N.accidentPatienceFloor);
      expect(p.stage.kind).toBe(stage.kind);
    }
  });

  it('queuedCheckIn stays AMA-eligible (design erratum, pre-impl MAJOR 6): no clamp', () => {
    const { world } = setup();
    const p = makePatient(world, { stage: { kind: 'queuedCheckIn', roomId: 999, slot: 1 } });
    p.next = { col: 20, row: 38 };
    p.patience = 5;
    p.bladder = 0.0001;
    updateDecay(world);
    expect(p.patience).toBe(0); // floored at 0, NOT the accident floor
  });

  it('5c: an accident mid-restroom-break clears the claim with NO hold; geometry gates release', () => {
    const { world } = setup();
    const room = buildRestroom(world);
    const p = makePatient(world, { at: { col: 14, row: 11 } });
    p.bladder = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(p.needBreak?.kind).toBe('restroom'); // premise: claim exists
    expect(validateRoomSell(world, room.id)).toEqual({ ok: false, reason: 'Occupied' });
    const holdBefore = p.needBreakHoldUntil;
    p.bladder = 0.0001; // accident incoming
    updateDecay(world);
    expect(p.needBreak).toBeNull();
    expect(p.needBreakHoldUntil).toBe(holdBefore); // no hold — the need is gone
    expect(p.bladder).toBe(VITALS);
    expect(validateRoomSell(world, room.id).ok).toBe(true);
  });
});

describe('side-trip trigger gates (§3.2, design MAJOR 1 / pre-impl MAJOR 4)', () => {
  it('a below-threshold waiter claims the free stall and walks; seat released at break start', () => {
    const { world } = setup();
    world.buildRoom('waiting', { col: 20, row: 20, cols: 3, rows: 3 }, { col: 23, row: 21 }, true);
    const waitingRoom = world.roomsOfType('waiting')[0]!;
    const room = buildRestroom(world);
    const p = makePatient(world, { at: { col: 21, row: 21 } });
    p.waitingRoomId = waitingRoom.id;
    p.bladder = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(p.needBreak).toEqual({
      kind: 'restroom',
      roomId: room.id,
      slot: 0,
      phase: 'walking',
      ticksRemaining: 0,
      startedAt: world.clock.tick,
    });
    expect(p.waitingRoomId).toBeNull(); // seat released (review MINOR 13)
    expect(p.target).not.toBeNull(); // walking to the stall anchor
    expect(world.stallClaims(room.id).get(0)).toBe(p.id);
  });

  it('walks to the stall, flips `using` INSIDE the room, completes: meter full + re-spotted', () => {
    const { world } = setup();
    const room = buildRestroom(world);
    const p = makePatient(world, { at: { col: 14, row: 11 } });
    p.bladder = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(p.needBreak?.phase).toBe('walking');
    run(world, 200);
    expect(p.needBreak).toBeNull(); // walked, used, completed inside 200 ticks
    expect(p.bladder).toBe(VITALS);
    expect(p.stage.kind).toBe('waiting'); // stage never changed (sub-state!)
    expect(world.stallClaims(room.id).size).toBe(0);
  });

  it('the flip happened inside the room and lasted restroomUseGameMinutes', () => {
    const { world } = setup();
    const room = buildRestroom(world);
    const p = makePatient(world, { at: { col: 14, row: 11 } });
    p.bladder = N.seekThreshold - 5;
    updatePatientNeeds(world);
    let usingTicks = 0;
    run(world, 200, () => {
      if (p.needBreak?.phase === 'using') {
        usingTicks += 1;
        expect(world.isInsideRoom(p.at, room)).toBe(true);
      }
    });
    expect(usingTicks).toBe(gameMinutesToTicks(N.restroomUseGameMinutes));
  });

  it('an unreachable restroom is NEVER claimed; the failed probe sets the retry hold once', () => {
    const { world } = setup();
    buildRestroom(world);
    const p = makePatient(world, { at: { col: 30, row: 30 } });
    // Seal the patient in a pocket (fixture grid pokes): no path to anything.
    for (const [col, row] of [
      [29, 30],
      [31, 30],
      [30, 29],
      [30, 31],
    ] as const) {
      world.tileAt(col, row)!.walkable = false;
    }
    p.bladder = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(p.needBreak).toBeNull();
    const hold = p.needBreakHoldUntil;
    expect(hold).toBe(world.clock.tick + gameMinutesToTicks(N.breakRetryGameMinutes));
    // Probed once per hold window (pre-impl MAJOR 4): freeing the path does
    // NOT re-probe while the hold stands…
    for (const [col, row] of [
      [29, 30],
      [31, 30],
      [30, 29],
      [30, 31],
    ] as const) {
      world.tileAt(col, row)!.walkable = true;
    }
    world.clock.advance();
    updatePatientNeeds(world);
    expect(p.needBreak).toBeNull();
    expect(p.needBreakHoldUntil).toBe(hold); // unchanged — no re-probe
    // …and the trigger re-arms the tick the hold expires.
    world.clock.tick = hold;
    updatePatientNeeds(world);
    expect(p.needBreak?.kind).toBe('restroom');
  });

  it('no restroom built at all: no claim AND no hold (the first build helps immediately)', () => {
    const { world } = setup();
    const p = makePatient(world, { at: { col: 20, row: 20 } });
    p.bladder = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(p.needBreak).toBeNull();
    expect(p.needBreakHoldUntil).toBe(0); // zero-cost probe — no penalty window
    buildRestroom(world);
    world.clock.advance();
    updatePatientNeeds(world);
    expect(p.needBreak?.kind).toBe('restroom'); // immediate, no 15-min wait
  });

  it('break starts emit the need thought (needsRestroom / needsVending)', () => {
    const { world, events } = setup();
    const thoughts: string[] = [];
    events.on('patientThought', ({ text }) => thoughts.push(text));
    buildRestroom(world);
    world.placeAmenity('vending', { col: 20, row: 20 });
    const a = makePatient(world, { at: { col: 14, row: 11 } });
    a.bladder = N.seekThreshold - 5;
    const b = makePatient(world, { at: { col: 22, row: 20 } });
    b.thirst = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(a.needBreak?.kind).toBe('restroom'); // premise
    expect(b.needBreak?.kind).toBe('vending'); // premise
    expect(thoughts.some((t) => (THOUGHTS.needsRestroom as readonly string[]).includes(t))).toBe(
      true,
    );
    expect(thoughts.some((t) => (THOUGHTS.needsVending as readonly string[]).includes(t))).toBe(
      true,
    );
  });

  it('one user per machine: a second thirsty waiter cannot claim a claimed machine (hold)', () => {
    const { world } = setup();
    world.placeAmenity('vending', { col: 20, row: 20 });
    const first = makePatient(world, { at: { col: 22, row: 20 } });
    const second = makePatient(world, { at: { col: 24, row: 20 } });
    for (const p of [first, second]) p.thirst = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(first.needBreak?.kind).toBe('vending');
    expect(second.needBreak).toBeNull(); // machine claimed → failed claim
    expect(second.needBreakHoldUntil).toBeGreaterThan(world.clock.tick);
    expect(world.vendingClaimedBy('20,20')).toBe(first.id);
  });

  it('lost patients never trigger a side-trip', () => {
    const { world } = setup();
    buildRestroom(world);
    const p = makePatient(world, { at: { col: 14, row: 11 } });
    p.lost = { since: world.clock.tick };
    p.bladder = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(p.needBreak).toBeNull();
  });

  it('ineligible stages (queuedCheckIn/reserved) never trigger', () => {
    const { world } = setup();
    buildRestroom(world);
    for (const stage of [
      { kind: 'queuedCheckIn', roomId: 999, slot: 0 },
      { kind: 'reserved', reservationId: 999 },
    ] as const) {
      const p = makePatient(world, { at: { col: 14, row: 11 }, stage });
      p.bladder = N.seekThreshold - 5;
      updatePatientNeeds(world);
      expect(p.needBreak).toBeNull();
      expect(p.needBreakHoldUntil).toBe(0);
    }
  });

  it('5b: a stalled arrival (dead path reads as "arrived") abandons IMMEDIATELY with hold', () => {
    const { world } = setup();
    buildRestroom(world);
    const p = makePatient(world, { at: { col: 20, row: 20 } });
    p.bladder = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(p.needBreak?.phase).toBe('walking'); // premise
    // Simulate setWalkerTarget's no-path outcome mid-walk (Flow rule 8):
    // committed step finished, target nulled, still in the corridor.
    p.next = null;
    p.path = [];
    p.target = null;
    const meterBefore = p.bladder;
    world.clock.advance();
    updatePatientNeeds(world);
    expect(p.needBreak).toBeNull(); // abandoned NOW — not `using` in a corridor
    expect(p.needBreakHoldUntil).toBeGreaterThan(world.clock.tick);
    expect(p.bladder).toBe(meterBefore); // no relief
  });
});

describe('claim exclusivity + watchdog (§3.2/§3.3)', () => {
  it('6: three below-threshold waiters, two stalls → sequential slots, third held', () => {
    const { world } = setup();
    const room = buildRestroom(world);
    const a = makePatient(world, { at: { col: 14, row: 10 } });
    const b = makePatient(world, { at: { col: 14, row: 11 } });
    const c = makePatient(world, { at: { col: 14, row: 12 } });
    for (const p of [a, b, c]) p.bladder = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(a.needBreak?.slot).toBe(0);
    expect(b.needBreak?.slot).toBe(1); // claim-aware: never double-books slot 0
    expect(c.needBreak).toBeNull(); // full — failed claim, hold set
    expect(c.needBreakHoldUntil).toBeGreaterThan(world.clock.tick);
    expect(world.stallClaims(room.id)).toEqual(
      new Map([
        [0, a.id],
        [1, b.id],
      ]),
    );
    expect(world.freeStallIndex(room)).toBeNull();
  });

  it('7: watchdog abandons a never-arrived break — non-lost re-spotted + hold; lost target-null', () => {
    const { world } = setup();
    buildRestroom(world);
    const walker = makePatient(world, { at: { col: 25, row: 25 } });
    const lost = makePatient(world, { at: { col: 30, row: 30 } });
    for (const p of [walker, lost]) p.bladder = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(walker.needBreak?.phase).toBe('walking');
    expect(lost.needBreak?.phase).toBe('walking');
    lost.lost = { since: world.clock.tick }; // goes lost mid-break
    lost.path = [];
    lost.next = null;
    world.clock.tick += gameMinutesToTicks(N.breakWatchdogGameMinutes);
    updatePatientNeeds(world);
    for (const p of [walker, lost]) {
      expect(p.needBreak).toBeNull();
      expect(p.needBreakHoldUntil).toBe(
        world.clock.tick + gameMinutesToTicks(N.breakRetryGameMinutes),
      );
    }
    expect(walker.target).not.toBeNull(); // assignWaitingSpot gave a real spot
    expect(lost.target).toBeNull(); // lost-timeout semantics (MINOR 10)
  });
});

describe('dispatcher × breaks + terminal clears (§3.2)', () => {
  it('8: the dispatcher skips on-break patients; re-enters the pool when the break ends', () => {
    const { world } = setup();
    world.buildRoom('exam', { col: 20, row: 20, cols: 3, rows: 3 }, { col: 23, row: 21 }, true);
    world.addStaffMember('doctor', 3, 300);
    world.addStaffMember('nurse', 3, 150);
    const p = makePatient(world, { at: { col: 25, row: 25 } });
    p.needBreak = {
      kind: 'restroom',
      roomId: 999,
      slot: 0,
      phase: 'walking',
      ticksRemaining: 0,
      startedAt: world.clock.tick,
    };
    for (let i = 0; i < 5; i++) updateDispatcher(world);
    expect(world.reservations.size).toBe(0);
    p.needBreak = null;
    updateDispatcher(world);
    expect(world.reservations.size).toBe(1);
  });

  it('9: all three terminal choke points clear the break (stall freed by construction)', () => {
    const { world } = setup();
    const room = buildRestroom(world);
    const terminals = [
      (w: World, p: Patient) => w.killPatient(p),
      (w: World, p: Patient) => w.patientLeavesAma(p),
      (w: World, p: Patient) => w.dischargePatient(p, 0),
    ];
    for (const terminal of terminals) {
      const p = makePatient(world, { at: { col: 14, row: 11 } });
      p.bladder = N.seekThreshold - 5;
      updatePatientNeeds(world);
      expect(p.needBreak?.kind).toBe('restroom'); // premise
      terminal(world, p);
      expect(p.needBreak).toBeNull();
      expect(world.stallClaims(room.id).size).toBe(0); // derived → auto-freed
      world.patients.delete(p.id); // isolate iterations
    }
  });

  it('10: waitingRoomId cleared at break start; seat RE-COMPETED on return', () => {
    const { world } = setup();
    world.buildRoom('waiting', { col: 20, row: 20, cols: 3, rows: 3 }, { col: 23, row: 21 }, true);
    const waitingRoom = world.roomsOfType('waiting')[0]!;
    buildRestroom(world);
    const p = makePatient(world, { at: { col: 21, row: 21 } });
    // Stage-2 re-pin (§S2.6b): the evs candidate mints shifted the seed-42
    // stream and this patient now rolled a low wayfinding stat — they got
    // LOST on the restroom trek, and the watchdog abandon leaves lost
    // patients unseated by design. Lostness is noise for THIS test's
    // premise (seat re-competition after a COMPLETED break) — pin the stat.
    p.wayfinding = BALANCE.stats.max;
    p.waitingRoomId = waitingRoom.id;
    p.bladder = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(p.waitingRoomId).toBeNull();
    run(world, 250);
    expect(p.needBreak).toBeNull(); // premise: completed
    expect(p.waitingRoomId).toBe(waitingRoom.id); // seats free → re-seated
  });

  it('11: restroom expand AND sell reject "Occupied" while claimed (walking counts); clear after', () => {
    const { world } = setup();
    const room = buildRestroom(world);
    const p = makePatient(world, { at: { col: 14, row: 11 } });
    p.bladder = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(p.needBreak?.phase).toBe('walking'); // premise: WALKING claimant gates too
    const grown = { col: 9, row: 10, cols: 3, rows: 3 }; // west — away from the door
    expect(validateRoomExpand(world, room.id, grown, true)).toEqual({
      ok: false,
      reason: 'Occupied',
    });
    expect(validateRoomSell(world, room.id)).toEqual({ ok: false, reason: 'Occupied' });
    world.clearNeedBreak(p, { hold: true });
    expect(validateRoomExpand(world, room.id, grown, true).ok).toBe(true);
    expect(validateRoomSell(world, room.id).ok).toBe(true);
  });
});

describe('Stage-1 adversarial review regressions', () => {
  it('MAJOR 1: a machine hugging a walled room never stands its user inside the room', () => {
    const { world } = setup();
    // Exam room 10..12 × 10..12 (east door); vending hugs its WEST wall at
    // (9,11) — the machine's EAST neighbor (10,11) is walled-room interior
    // and ORTHOGONAL_STEPS tries east first. The stand pick must skip it
    // (walkable ≠ standable) and take the corridor tile (8,11) instead.
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 13, row: 11 }, true);
    world.placeAmenity('vending', { col: 9, row: 11 });
    expect(world.amenityAt(9, 11)).not.toBeNull(); // premise: placement legal
    const p = makePatient(world, { at: { col: 5, row: 11 } });
    p.thirst = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(p.needBreak?.kind).toBe('vending');
    expect(p.target).toEqual({ col: 8, row: 11 }); // corridor, NEVER (10,11)
    // Drive to completion: the whole break happens outside any walled room.
    run(world, 300, () => {
      if (p.needBreak?.phase === 'using') {
        expect(world.roomAt(p.at)).toBeNull();
      }
    });
    expect(p.needBreak).toBeNull();
    expect(p.thirst).toBe(VITALS); // completed — from the corridor side
  });

  it('MAJOR 1 mirror: only-interior-neighbor machines read failed (hold), not claimed', () => {
    const { world } = setup();
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 13, row: 11 }, true);
    world.placeAmenity('vending', { col: 9, row: 11 });
    // Wall off every legal (non-interior) neighbor of the machine.
    for (const [col, row] of [
      [8, 11],
      [9, 10],
      [9, 12],
    ] as const) {
      world.tileAt(col, row)!.walkable = false;
    }
    const p = makePatient(world, { at: { col: 5, row: 11 } });
    p.thirst = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(p.needBreak).toBeNull(); // interior neighbor must NOT be picked
    expect(p.needBreakHoldUntil).toBe(
      world.clock.tick + gameMinutesToTicks(N.breakRetryGameMinutes),
    );
  });

  it('MINOR 2: a full restroom does not starve the vending trigger — same-tick fallback', () => {
    const { world } = setup();
    const room = buildRestroom(world);
    world.placeAmenity('vending', { col: 20, row: 20 });
    // Both stalls held by walking claimants (fixture writes — claims are
    // derived from needBreak, so this is the real full-restroom state).
    for (const slot of [0, 1]) {
      const holder = makePatient(world, { at: { col: 20, row: 30 } });
      holder.needBreak = {
        kind: 'restroom',
        roomId: room.id,
        slot,
        phase: 'walking',
        ticksRemaining: 0,
        startedAt: world.clock.tick,
      };
      // Genuinely mid-walk (target set) — an arrived-outside holder would be
      // stalled-abandoned by advanceBreak, freeing the stalls this tick.
      holder.target = { col: 11, row: 11 };
    }
    const p = makePatient(world, { at: { col: 22, row: 20 } });
    p.bladder = N.seekThreshold - 5; // restroom wanted — but full
    p.thirst = N.seekThreshold - 5; // vending wanted — and free
    updatePatientNeeds(world);
    expect(p.needBreak?.kind).toBe('vending'); // claimed the SAME tick
    expect(p.needBreakHoldUntil).toBe(0); // no hold — something was claimed
    // Control: with the machine also gone, the failed probes set ONE hold.
    const q = makePatient(world, { at: { col: 22, row: 21 } });
    q.bladder = N.seekThreshold - 5;
    q.thirst = N.seekThreshold - 5;
    world.sellAmenity({ col: 20, row: 20 });
    updatePatientNeeds(world);
    expect(q.needBreak).toBeNull();
    expect(q.needBreakHoldUntil).toBe(
      world.clock.tick + gameMinutesToTicks(N.breakRetryGameMinutes),
    );
  });
});
