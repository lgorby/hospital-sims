import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { BALANCE } from '../src/sim/data/balance';
import { AMENITY_DEFS, AMENITY_IDS } from '../src/sim/data/amenities';
import { ROOM_DEFS } from '../src/sim/data/rooms';
import type { Patient } from '../src/sim/entities/patient';
import {
  amenitySellback,
  plantCoversTile,
  propTargetCount,
} from '../src/sim/formulas';
import { validateAmenityPlace, validateRoomRect } from '../src/sim/build';
import { dayNet } from '../src/sim/dailyStats';
import { updateDecay } from '../src/sim/systems/decay';
import { updateMovement } from '../src/sim/systems/movement';
import { updatePatientNeeds } from '../src/sim/systems/patientNeeds';
import { World } from '../src/sim/world';

/**
 * Amenities epic Stage 1 (AMENITIES_PLAN §3.4 / impl plan §3): the roomless
 * placeable props — placement validation, the place/sell command handlers,
 * vending economics, and the plant comfort aura.
 */

const N = BALANCE.needs;
const VITALS = BALANCE.stats.vitalsMax;

function setup(seed = 42) {
  const events = new EventBus();
  const world = new World(events, seed);
  const queue = new CommandQueue();
  return { world, events, queue };
}

function makeWaiter(
  world: World,
  at: { col: number; row: number },
  stage: Patient['stage'] = { kind: 'waiting' },
): Patient {
  const patient = world.spawnPatient('flu');
  patient.stage = stage;
  patient.acuity = 3;
  patient.waitingSince = world.clock.tick;
  patient.bladder = VITALS;
  patient.thirst = VITALS;
  patient.at = { ...at };
  patient.next = null;
  patient.path = [];
  patient.target = null;
  return patient;
}

describe('validateAmenityPlace (§3.4 / plan §1.8)', () => {
  it('accepts a plain corridor tile and an ATRIUM (open-plan) tile', () => {
    const { world } = setup();
    world.buildRoom('atrium', { col: 5, row: 5, cols: 4, rows: 4 }, null, true);
    expect(validateAmenityPlace(world, 'trashcan', { col: 20, row: 20 }).ok).toBe(true);
    expect(validateAmenityPlace(world, 'trashcan', { col: 6, row: 6 }).ok).toBe(true);
  });

  it('rejects out of bounds, walled interiors, and occupied/propped tiles', () => {
    const { world } = setup();
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 13, row: 11 }, true);
    expect(validateAmenityPlace(world, 'plant', { col: -1, row: 5 })).toEqual({
      ok: false,
      reason: 'Out of bounds',
    });
    expect(validateAmenityPlace(world, 'plant', { col: 11, row: 11 })).toEqual({
      ok: false,
      reason: 'Must go on a corridor or atrium tile',
    });
    world.placeAmenity('trashcan', { col: 20, row: 20 });
    expect(validateAmenityPlace(world, 'plant', { col: 20, row: 20 })).toEqual({
      ok: false,
      reason: 'Blocked by an object',
    });
  });

  it('rejects the entrance tile EXPLICITLY (review MAJOR 5 — the BFS cannot see its own seed)', () => {
    const { world } = setup();
    expect(validateAmenityPlace(world, 'vending', { ...BALANCE.map.entrance })).toEqual({
      ok: false,
      reason: 'Cannot block the entrance',
    });
  });

  it("rejects a person's at, committed `next`, AND claimed target tile (pre-impl MAJOR 2)", () => {
    const { world } = setup();
    const p = makeWaiter(world, { col: 20, row: 20 });
    expect(validateAmenityPlace(world, 'plant', { col: 20, row: 20 })).toEqual({
      ok: false,
      reason: 'Someone is standing there',
    });
    p.next = { col: 21, row: 20 }; // the committed step — NOT covered by isTileClaimed
    expect(validateAmenityPlace(world, 'plant', { col: 21, row: 20 })).toEqual({
      ok: false,
      reason: 'Someone is standing there',
    });
    p.target = { col: 25, row: 20 };
    expect(validateAmenityPlace(world, 'plant', { col: 25, row: 20 })).toEqual({
      ok: false,
      reason: 'Someone is standing there',
    });
  });

  it('rejects on insufficient cash', () => {
    const { world } = setup();
    world.cash = AMENITY_DEFS.vending.cost - 1;
    expect(validateAmenityPlace(world, 'vending', { col: 20, row: 20 })).toEqual({
      ok: false,
      reason: 'Not enough cash',
    });
    expect(validateAmenityPlace(world, 'trashcan', { col: 20, row: 20 }).ok).toBe(true);
  });

  it('trap-BFS: a pinch-point machine that cuts off a DOOR is rejected (design MAJOR 5 class)', () => {
    const { world } = setup();
    world.buildRoom('exam', { col: 0, row: 0, cols: 3, rows: 3 }, { col: 3, row: 1 }, true);
    // Pinch the corridor so door.outside (3,1) is reachable ONLY via (4,1).
    world.tileAt(3, 0)!.walkable = false;
    world.tileAt(3, 2)!.walkable = false;
    const result = validateAmenityPlace(world, 'vending', { col: 4, row: 1 });
    expect(result).toEqual({ ok: false, reason: 'Would cut off Exam Room from the entrance' });
    // Control: away from the pinch it places fine.
    expect(validateAmenityPlace(world, 'vending', { col: 10, row: 10 }).ok).toBe(true);
  });

  it('trap-BFS: a machine that strands a PERSON in a pocket is rejected', () => {
    const { world } = setup();
    makeWaiter(world, { col: 0, row: 10 });
    // Pocket around (0,10): only (1,10) stays open.
    world.tileAt(0, 9)!.walkable = false;
    world.tileAt(0, 11)!.walkable = false;
    world.tileAt(1, 9)!.walkable = false;
    world.tileAt(1, 11)!.walkable = false;
    const result = validateAmenityPlace(world, 'trashcan', { col: 1, row: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Would trap');
  });
});

describe('placeAmenity / sellAmenity handlers (§1.7)', () => {
  it('18: EVERY amenity id places non-walkable — the room-build "Blocked by an object" rule', () => {
    const { world } = setup();
    let col = 10;
    for (const kind of AMENITY_IDS) {
      const tile = { col, row: 20 };
      world.placeAmenity(kind, tile);
      const t = world.tileAt(tile.col, tile.row)!;
      expect(t.object).toBe(kind);
      expect(t.walkable, `${kind} must be non-walkable (NIT 22 rule)`).toBe(false);
      expect(world.amenityAt(tile.col, tile.row)).toEqual({
        kind,
        tile,
        fill: 0,
        revenueTotal: 0,
        revenueToday: 0,
      });
      // The rule's PAYOFF: a room over the amenity tile is rejected by the
      // existing object check — a walkable amenity would silently lose this.
      expect(
        validateRoomRect(world, 'waiting', { col: col - 1, row: 19, cols: 3, rows: 3 }, true),
      ).toEqual({ ok: false, reason: 'Blocked by an object' });
      col += 4;
    }
  });

  it('purchase hits cash + the construction tally; sale refunds amenitySellback into sellIncome', () => {
    const { world, events } = setup();
    let cashEvents = 0;
    events.on('cashChanged', () => (cashEvents += 1));
    const placed: string[] = [];
    const sold: string[] = [];
    events.on('amenityPlaced', (e) => placed.push(`${e.kind}@${e.col},${e.row}`));
    events.on('amenitySold', (e) => sold.push(`${e.kind}@${e.col},${e.row}`));
    const cash0 = world.cash;
    world.placeAmenity('vending', { col: 20, row: 20 });
    expect(world.cash).toBe(cash0 - AMENITY_DEFS.vending.cost);
    expect(world.today.construction).toBe(AMENITY_DEFS.vending.cost);
    expect(placed).toEqual(['vending@20,20']);
    world.sellAmenity({ col: 20, row: 20 });
    expect(world.cash).toBe(cash0 - AMENITY_DEFS.vending.cost + amenitySellback('vending'));
    expect(world.today.sellIncome).toBe(amenitySellback('vending'));
    expect(sold).toEqual(['vending@20,20']);
    expect(world.amenityAt(20, 20)).toBeNull();
    expect(world.tileAt(20, 20)!.walkable).toBe(true);
    expect(world.tileAt(20, 20)!.object).toBeNull();
    expect(cashEvents).toBe(2);
    // amenitySellback IS cost × roomSellbackRatio (the sellbackAmount pattern).
    expect(amenitySellback('vending')).toBe(
      Math.floor(AMENITY_DEFS.vending.cost * BALANCE.economy.roomSellbackRatio),
    );
  });

  it('a rejected placement emits buildRejected and moves no money', () => {
    const { world, events } = setup();
    const reasons: string[] = [];
    events.on('buildRejected', ({ reason }) => reasons.push(reason));
    const cash0 = world.cash;
    world.placeAmenity('vending', { ...BALANCE.map.entrance });
    expect(reasons).toEqual(['Cannot block the entrance']);
    expect(world.cash).toBe(cash0);
    expect(world.amenities.size).toBe(0);
    world.sellAmenity({ col: 20, row: 20 });
    expect(reasons).toEqual(['Cannot block the entrance', 'No amenity there']);
  });

  it('12b: placeAmenity re-routes a mid-path walker; sellAmenity re-routes back (both call recomputePaths)', () => {
    const { world } = setup();
    const p = makeWaiter(world, { col: 5, row: 20 });
    world.setWalkerTarget(p, { col: 15, row: 20 });
    const onPath = (col: number, row: number): boolean =>
      p.path.some((t) => t.col === col && t.row === row) ||
      (p.next !== null && p.next.col === col && p.next.row === row);
    expect(onPath(10, 20)).toBe(true); // premise: the straight path crosses it
    world.placeAmenity('vending', { col: 10, row: 20 });
    expect(p.target).toEqual({ col: 15, row: 20 }); // goal survives
    expect(onPath(10, 20)).toBe(false); // path repaired around the machine
    world.sellAmenity({ col: 10, row: 20 });
    expect(onPath(10, 20)).toBe(true); // freed tile rejoins the optimal path
  });

  it('13: selling a machine mid-use clears the claim via the ABANDON path (hold, meter unchanged)', () => {
    const { world } = setup();
    world.placeAmenity('vending', { col: 20, row: 20 });
    const p = makeWaiter(world, { col: 23, row: 20 });
    p.thirst = N.seekThreshold - 5;
    updatePatientNeeds(world);
    expect(p.needBreak?.kind).toBe('vending'); // premise: live claim
    for (let i = 0; i < 60 && p.needBreak?.phase !== 'using'; i++) {
      world.clock.advance();
      updatePatientNeeds(world);
      updateMovement(world);
    }
    expect(p.needBreak?.phase).toBe('using'); // premise: mid-use
    const thirstBefore = p.thirst;
    world.sellAmenity({ col: 20, row: 20 });
    expect(p.needBreak).toBeNull();
    expect(p.needBreakHoldUntil).toBeGreaterThan(world.clock.tick); // hold set
    expect(p.thirst).toBe(thirstBefore); // NO relief — the meter is untouched
    expect(world.cash).toBeGreaterThan(0);
  });
});

describe('vending economics (§3.4 / §8 Q3, review MAJOR 3)', () => {
  it('14: a use charges $5 through billFee — revenue AND the breakdown line, single-counted', () => {
    const { world, events } = setup();
    const fees: { amount: number; label: string }[] = [];
    events.on('feeBilled', (f) => fees.push(f));
    world.placeAmenity('vending', { col: 20, row: 20 });
    world.today.construction = 0; // isolate the use from the purchase
    const cash0 = world.cash;
    const p = makeWaiter(world, { col: 23, row: 20 });
    p.thirst = N.seekThreshold - 5;
    for (let i = 0; i < 120 && p.needBreak?.phase !== 'using'; i++) {
      world.clock.advance();
      updatePatientNeeds(world);
      updateMovement(world);
    }
    expect(p.needBreak?.phase).toBe('using'); // premise
    for (let i = 0; i < 60 && p.needBreak !== null; i++) {
      world.clock.advance();
      updatePatientNeeds(world);
      updateMovement(world);
    }
    expect(p.needBreak).toBeNull(); // premise: completed
    expect(p.thirst).toBe(VITALS);
    // `source: 'vending'` is load-bearing (live-drive MAJOR 1): the checklist
    // ignores non-treatment fees, so the discriminator must survive here.
    expect(fees).toEqual([{ amount: N.vendingPrice, label: 'Vending', source: 'vending' }]);
    expect(world.cash).toBe(cash0 + N.vendingPrice);
    expect(world.today.revenue).toBe(N.vendingPrice); // inside revenue…
    expect(world.today.vendingRevenue).toBe(N.vendingPrice); // …breakdown line
    // Single-count: dayNet reads revenue only — the breakdown is never re-added.
    expect(dayNet(world.today)).toBe(N.vendingPrice);
  });
});

describe('plant comfort aura (§3.4 / §8 Q1b)', () => {
  it('15: plantCoversTile radius; placing/selling via COMMANDS bumps auraRevision; patience applies', () => {
    const { world, queue } = setup();
    const plantAt = { col: 20, row: 20 };
    const r = N.plantAuraRadius;
    expect(plantCoversTile(plantAt, { col: 20 + r, row: 20 + r }, r)).toBe(true);
    expect(plantCoversTile(plantAt, { col: 20 + r + 1, row: 20 }, r)).toBe(false);

    expect(world.hasComfortAura({ col: 21, row: 20 })).toBe(false);
    const revBefore = world.auraRevision;
    // Through the command queue: the applyCommands auraCheckedTick=-1 path.
    queue.push({ type: 'placeAmenity', kind: 'plant', col: plantAt.col, row: plantAt.row });
    world.applyCommands(queue);
    expect(world.hasComfortAura({ col: 21, row: 20 })).toBe(true);
    expect(world.hasComfortAura({ col: 20 + r, row: 20 + r })).toBe(true);
    expect(world.hasComfortAura({ col: 20 + r + 1, row: 20 })).toBe(false);
    expect(world.auraRevision).toBeGreaterThan(revBefore); // overlay cache key moved

    // The multiplier applies through the normal decay stack.
    const inAura = makeWaiter(world, { col: 21, row: 20 });
    const outside = makeWaiter(world, { col: 35, row: 35 });
    updateDecay(world);
    expect(VITALS - inAura.patience).toBeCloseTo(
      (VITALS - outside.patience) * BALANCE.wayfinding.comfortAuraPatienceMultiplier,
      10,
    );

    const revPlaced = world.auraRevision;
    queue.push({ type: 'sellAmenity', col: plantAt.col, row: plantAt.row });
    world.applyCommands(queue);
    expect(world.hasComfortAura({ col: 21, row: 20 })).toBe(false);
    expect(world.auraRevision).toBeGreaterThan(revPlaced);
  });
});

describe('restroom capacity derivation (§3.3)', () => {
  it('19: a 2×3 restroom derives EXACTLY 2 stalls (perTiles 3, min 2 — harness-safe rule)', () => {
    const { world } = setup();
    const def = ROOM_DEFS.restroom;
    expect(def.capacity).toEqual({ kind: 'perProp', prop: 'toiletStall', noun: 'Stalls' });
    const minRect = { col: 10, row: 10, cols: def.minCols, rows: def.minRows };
    expect(propTargetCount(def.props[0]!.density, minRect)).toBe(2);
    world.buildRoom('restroom', minRect, { col: 12, row: 11 }, true);
    const room = world.roomsOfType('restroom')[0]!;
    expect(world.capacityOf(room)).toBe(2); // the placed props ARE the capacity
    expect(world.freeStallIndex(room)).toBe(0);
  });
});
