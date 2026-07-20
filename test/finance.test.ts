import { describe, expect, it } from 'vitest';
import { CommandQueue, type Command } from '../src/commands';
import { EventBus } from '../src/events';
import { TICKS_PER_DAY } from '../src/sim/clock';
import { dayNet, emptyDayTally, type DayReport } from '../src/sim/dailyStats';
import { AMENITY_DEFS } from '../src/sim/data/amenities';
import { BALANCE } from '../src/sim/data/balance';
import { CONDITION_DEFS } from '../src/sim/data/conditions';
import {
  FINANCE_CATEGORIES,
  NON_CASH_TALLY_KEYS,
  emptyCashTotals,
  type CashTallyKey,
} from '../src/sim/data/finance';
import {
  RETIRED_ROOMS,
  ROOM_DEFS,
  ROOM_TYPES,
  type RoomCategory,
  type RoomType,
} from '../src/sim/data/rooms';
import type { Patient } from '../src/sim/entities/patient';
import type { Reservation } from '../src/sim/entities/staff';
import {
  amenitySellback,
  averageBillPerPatient,
  departmentCapital,
  hospitalValue,
  netFromCategories,
  priceOf,
  roomEarns,
  scaledFee,
  sellbackAmount,
} from '../src/sim/formulas';
import { setupNewGame } from '../src/sim/newGame';
import { updatePatientNeeds } from '../src/sim/systems/patientNeeds';
import { resolveTreatmentOutcome } from '../src/sim/systems/treatment';
import { World } from '../src/sim/world';

/**
 * Finances epic (docs/FINANCE_PLAN.md §11 tests 1–10 — the sim side). The DOM
 * surfaces are pinned by their own tracks' `*.dom.test.ts`; everything here is
 * renderer-free, rng-free and deterministic.
 */

/** sellRoom/hireStaff are command-only mutations (the CommandQueue is the
 *  public mutation API) — this is the tests' one-liner for them. */
function apply(world: World, ...commands: Command[]): void {
  const queue = new CommandQueue();
  for (const command of commands) queue.push(command);
  world.applyCommands(queue);
}

// ------------------------------------------------------------------ §11.1

describe('the category SSOT (§9.1)', () => {
  it('FINANCE_CATEGORIES + NON_CASH_TALLY_KEYS exactly partition DayTally', () => {
    // THE completeness gate (review MAJOR 4): a new tally key must be declared
    // cash (a category) or not-cash (the guard list) — it cannot be tallied yet
    // invisible, and it cannot be counted twice.
    const union = [...NON_CASH_TALLY_KEYS, ...FINANCE_CATEGORIES.map((c) => c.field)];
    expect(new Set(union).size, 'no key appears in both halves').toBe(union.length);
    expect([...union].sort()).toEqual(Object.keys(emptyDayTally()).sort());
  });

  it('emptyCashTotals covers exactly the category fields, all zero', () => {
    expect(Object.keys(emptyCashTotals()).sort()).toEqual(
      [...new Set(FINANCE_CATEGORIES.map((c) => c.field))].sort(),
    );
    expect(Object.values(emptyCashTotals()).every((n) => n === 0)).toBe(true);
  });

  it('reportOrder is a total order (the daily report reads it, not array order)', () => {
    const orders = FINANCE_CATEGORIES.map((c) => c.reportOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

// ------------------------------------------------------------------ §11.2

describe('dayNet folds the table (§9.6)', () => {
  it('is byte-equal to the legacy formula on a sample tally', () => {
    const tally = emptyDayTally();
    tally.revenue = 2400;
    tally.vendingRevenue = 45; // already INSIDE revenue
    tally.sellIncome = 2000;
    tally.payroll = 1880;
    tally.hireFees = 100;
    tally.construction = 8000;
    tally.utilities = 1200; // ECONOMY Stage-1 expenses — set nonzero so the fold
    tally.repairs = 400; // is actually exercised, not blind (dayNet review note).
    const legacy =
      tally.revenue +
      tally.sellIncome -
      tally.payroll -
      tally.hireFees -
      tally.construction -
      tally.utilities -
      tally.repairs;
    expect(dayNet(tally)).toBe(legacy);
    expect(netFromCategories(tally)).toBe(legacy);
  });

  it('never sums a breakdown row: a vending-only day nets `revenue` exactly once', () => {
    const tally = emptyDayTally();
    tally.revenue = BALANCE.needs.vendingPrice;
    tally.vendingRevenue = BALANCE.needs.vendingPrice;
    expect(dayNet(tally)).toBe(BALANCE.needs.vendingPrice);
  });

  it('a lifetime CashTotals folds through the same derivation', () => {
    const lifetime = emptyCashTotals();
    lifetime.revenue = 500;
    lifetime.payroll = 200;
    expect(netFromCategories(lifetime)).toBe(300);
  });
});

// ------------------------------------------------------------------ §11.3

/** A world with a free exam + xray, ready for hand-built reservations (the
 *  save-test precedent: fields are poked, lifecycle stages never are). */
function treatmentWorld(): World {
  const world = new World(new EventBus(), 5);
  setupNewGame(world);
  world.buildRoom('exam', { col: 14, row: 27, cols: 3, rows: 3 }, { col: 17, row: 28 }, true);
  world.buildRoom('xray', { col: 24, row: 26, cols: 3, rows: 4 }, { col: 27, row: 27 }, true);
  return world;
}

function reserve(world: World, patient: Patient, roomId: number, stepIndex: number): Reservation {
  world.releasePatientHoldings(patient); // leave the check-in queue / seat first
  const nurse = world.addStaffMember('nurse', 3, 150);
  const reservation: Reservation = {
    id: world.takeId(),
    kind: 'treatment',
    patientId: patient.id,
    roomId,
    staffIds: [nurse.id],
    stepIndex,
    slotIndex: 0,
    phase: 'active',
    ticksRemaining: 1,
    patientWaitingSince: null,
  };
  world.reservations.set(reservation.id, reservation);
  patient.stage = { kind: 'reserved', reservationId: reservation.id };
  nurse.duty = { kind: 'reserved', reservationId: reservation.id };
  return reservation;
}

describe('per-room attribution (§4.1)', () => {
  it('a successful step credits ITS room — revenue today, total, and one visit', () => {
    const world = treatmentWorld();
    const exam = world.roomsOfType('exam')[0]!;
    const xray = world.roomsOfType('xray')[0]!;
    const patient = world.spawnPatient('flu');
    patient.acuity = 5;
    const fee = scaledFee(CONDITION_DEFS.flu.steps[0]!.fee);

    resolveTreatmentOutcome(world, reserve(world, patient, exam.id, 0), true);

    expect(exam.revenueToday).toBe(fee);
    expect(exam.revenueTotal).toBe(fee);
    expect(exam.visitsTotal).toBe(1);
    // The room that did NOT treat stays at zero — the RCT "this ride earns
    // nothing" read has to be truthful to be worth showing.
    expect(xray.revenueTotal).toBe(0);
    expect(xray.visitsTotal).toBe(0);
    expect(world.today.revenue).toBe(fee);
    expect(world.lifetime.revenue).toBe(fee);
    expect(world.stageViolations).toEqual([]);
  });

  it('a complication credits nothing (no fee, no visit)', () => {
    const world = treatmentWorld();
    const exam = world.roomsOfType('exam')[0]!;
    const patient = world.spawnPatient('flu');
    patient.acuity = 5;

    resolveTreatmentOutcome(world, reserve(world, patient, exam.id, 0), false);

    expect(exam.revenueTotal).toBe(0);
    expect(exam.visitsTotal).toBe(0);
    expect(world.today.revenue).toBe(0);
    expect(world.lifetime.revenue).toBe(0);
  });

  it('a multi-step condition credits each room separately (visits ≠ discharges)', () => {
    const world = treatmentWorld();
    const exam = world.roomsOfType('exam')[0]!;
    const xray = world.roomsOfType('xray')[0]!;
    const patient = world.spawnPatient('fracture');
    patient.acuity = 3;
    const step1 = CONDITION_DEFS.fracture.steps[0]!;
    const step2 = CONDITION_DEFS.fracture.steps[1]!;

    resolveTreatmentOutcome(world, reserve(world, patient, xray.id, 0), true);
    resolveTreatmentOutcome(world, reserve(world, patient, exam.id, 1), true);

    expect(xray.revenueTotal).toBe(scaledFee(step1.fee));
    expect(exam.revenueTotal).toBe(scaledFee(step2.fee));
    expect(xray.visitsTotal).toBe(1);
    expect(exam.visitsTotal).toBe(1);
    // TWO visits, ONE discharge — exactly the vocabulary split §4.1 insists on.
    expect(world.lifetimeTreated).toBe(1);
    expect(world.lifetime.revenue).toBe(scaledFee(step1.fee) + scaledFee(step2.fee));
  });

  it('tallyCash moves today AND lifetime together at every migrated site', () => {
    const world = new World(new EventBus(), 3);
    setupNewGame(world);
    world.cash += 100_000;
    // The real call sites, exercised through the sim rather than asserted by
    // inspection: build, expand, amenity place, amenity sell, sell, hire.
    world.buildRoom('exam', { col: 14, row: 27, cols: 3, rows: 3 }, { col: 17, row: 28 });
    world.expandRoom(world.roomsOfType('exam')[0]!.id, { col: 14, row: 27, cols: 4, rows: 3 });
    world.placeAmenity('vending', { col: 25, row: 36 });
    world.sellAmenity({ col: 25, row: 36 });
    world.buildRoom('resp', { col: 28, row: 27, cols: 3, rows: 3 }, { col: 31, row: 28 });
    apply(world, { type: 'sellRoom', roomId: world.roomsOfType('resp')[0]!.id });
    apply(world, { type: 'hireStaff', candidateId: world.candidates[0]!.id, shift: 'day' });

    for (const key of ['construction', 'sellIncome', 'hireFees'] as CashTallyKey[]) {
      expect(world.today[key], `${key} tallied today`).toBeGreaterThan(0);
      expect(world.lifetime[key], `${key} tallied lifetime`).toBe(world.today[key]);
    }
    // Payroll rides the same path (the fractional hourly accrual is key-agnostic).
    world.tallyCash('payroll', 12.5);
    expect(world.today.payroll).toBe(12.5);
    expect(world.lifetime.payroll).toBe(12.5);
  });
});

// ------------------------------------------------------------------ §11.4

const VENDING_TILE = { col: 25, row: 36 };

function vendingWorld(): World {
  const world = new World(new EventBus(), 17);
  setupNewGame(world);
  world.placeAmenity('vending', VENDING_TILE);
  return world;
}

/** Park a patient in a legal `using` claim one tick from completion. */
function midVend(world: World): Patient {
  const patient = world.spawnPatient('flu');
  patient.acuity = 5;
  world.releasePatientHoldings(patient);
  patient.stage = { kind: 'waiting' };
  patient.at = { col: VENDING_TILE.col - 1, row: VENDING_TILE.row };
  patient.next = null;
  patient.path = [];
  patient.target = null;
  patient.needBreak = {
    kind: 'vending',
    tile: { ...VENDING_TILE },
    phase: 'using',
    ticksRemaining: 1,
    startedAt: world.clock.tick,
  };
  return patient;
}

describe('vending revenue lands on the MACHINE (§4.2)', () => {
  it('credits the machine and the vending breakdown, never a room', () => {
    const world = vendingWorld();
    midVend(world);
    updatePatientNeeds(world);

    const machine = world.amenityAt(VENDING_TILE.col, VENDING_TILE.row)!;
    expect(machine.revenueTotal).toBe(BALANCE.needs.vendingPrice);
    expect(world.today.vendingRevenue).toBe(BALANCE.needs.vendingPrice);
    expect(world.lifetime.vendingRevenue).toBe(BALANCE.needs.vendingPrice);
    // Inside `revenue` (the breakdown rule) — and no room saw a cent of it.
    expect(world.today.revenue).toBe(BALANCE.needs.vendingPrice);
    for (const room of world.rooms.values()) expect(room.revenueTotal).toBe(0);
  });

  it('selling a machine MID-USE yields no revenue and no crash (review NIT 18)', () => {
    const world = vendingWorld();
    midVend(world);
    // sellAmenity clears live claims through clearNeedBreak, so the completion
    // path can never fire for a machine that no longer exists.
    world.sellAmenity(VENDING_TILE);
    expect(world.amenityAt(VENDING_TILE.col, VENDING_TILE.row)).toBeNull();
    expect(() => updatePatientNeeds(world)).not.toThrow();
    expect(world.today.vendingRevenue).toBe(0);
    expect(world.lifetime.vendingRevenue).toBe(0);
  });
});

// ---------------------------------------------------------------- §11.5/11.6

/** Tick to the next midnight, returning the report `dayEnded` carried. */
function closeOneDay(world: World): DayReport {
  const reports: DayReport[] = [];
  const off = world.events.on('dayEnded', (r) => reports.push(r));
  for (let i = TICKS_PER_DAY - (world.clock.tick % TICKS_PER_DAY); i > 0; i--) world.tick();
  off();
  return reports[reports.length - 1]!;
}

describe('closeDay FROZEN order (§9.5)', () => {
  it('snapshots the day, stores a COPY, resets revenueToday but not revenueTotal', () => {
    const world = treatmentWorld();
    const exam = world.roomsOfType('exam')[0]!;
    const patient = world.spawnPatient('flu');
    patient.acuity = 5;
    resolveTreatmentOutcome(world, reserve(world, patient, exam.id, 0), true);
    const fee = scaledFee(CONDITION_DEFS.flu.steps[0]!.fee);
    expect(exam.revenueToday).toBe(fee); // premise

    const report = closeOneDay(world);

    expect(report.revenue).toBeGreaterThanOrEqual(fee);
    expect(world.history).toHaveLength(1);
    expect(world.history[0]).toEqual(report);
    // …but NOT the same object: mutating what the event handed out must never
    // rewrite the stored past (review MINOR 13).
    expect(world.history[0]).not.toBe(report);
    report.revenue = -999;
    expect(world.history[0]!.revenue).not.toBe(-999);
    // revenueToday resets; the lifetime counters survive.
    expect(exam.revenueToday).toBe(0);
    expect(exam.revenueTotal).toBe(fee);
    expect(world.today.revenue).toBe(0);
    expect(world.lifetime.revenue).toBeGreaterThanOrEqual(fee);
  });

  // v8: machines reset in the SAME step as rooms, so no surface can pair a
  // fresh room figure with a stale machine one.
  it('resets amenity revenueToday alongside rooms, keeping the lifetime total', () => {
    const world = treatmentWorld();
    world.placeAmenity('vending', { col: 4, row: 4 });
    const machine = world.amenityAt(4, 4)!;
    machine.revenueToday = 35;
    machine.revenueTotal = 220;

    closeOneDay(world);

    // The day figure is zeroed...
    expect(machine.revenueToday).toBe(0);
    // ...while the lifetime figure is NOT (it may have grown, since closing a
    // day runs a day and patients may buy — the claim is that it never resets).
    expect(machine.revenueTotal).toBeGreaterThanOrEqual(220);
  });

  it('no dayEnded consumer can observe a nonzero revenueToday (the autosave rule)', () => {
    const world = treatmentWorld();
    const exam = world.roomsOfType('exam')[0]!;
    const patient = world.spawnPatient('flu');
    patient.acuity = 5;
    resolveTreatmentOutcome(world, reserve(world, patient, exam.id, 0), true);
    expect(exam.revenueToday).toBeGreaterThan(0); // premise: there IS something to leak

    const seen: number[] = [];
    world.events.on('dayEnded', () => {
      for (const room of world.rooms.values()) seen.push(room.revenueToday);
      // The `today` reset is half of the same consistency guarantee.
      seen.push(world.today.revenue);
    });
    closeOneDay(world);
    expect(seen.length).toBeGreaterThan(0); // non-vacuous
    expect(seen.every((n) => n === 0)).toBe(true);
  });

  it('trims to historyCapDays, keeping the NEWEST days', () => {
    const world = new World(new EventBus(), 19);
    const cap = BALANCE.finance.historyCapDays;
    const days = cap + 5;
    for (let d = 0; d < days; d++) {
      closeOneDay(world);
      // Nobody can be treated (no rooms, no staff) and the walker set is
      // irrelevant to this assertion — clearing keeps 35 sim-days cheap.
      world.patients.clear();
    }

    expect(world.history).toHaveLength(cap);
    expect(world.history[0]!.day).toBe(days - cap + 1);
    expect(world.history[world.history.length - 1]!.day).toBe(days);
    // One entry per closed day, strictly increasing — the border's own rule.
    for (let i = 1; i < world.history.length; i++) {
      expect(world.history[i]!.day).toBe(world.history[i - 1]!.day + 1);
    }
  });
});

// ------------------------------------------------------------------ §11.7

describe('hospital value & department capital (§3.2, §5)', () => {
  it('hospitalValue = cash + every room and amenity sell-back (rect-aware)', () => {
    const world = new World(new EventBus(), 23);
    setupNewGame(world);
    world.cash += 100_000;
    world.buildRoom('exam', { col: 14, row: 27, cols: 3, rows: 3 }, { col: 17, row: 28 });
    world.placeAmenity('vending', VENDING_TILE);

    const expected = (): number => {
      let value = world.cash;
      for (const room of world.rooms.values()) value += sellbackAmount(room.type, room.rect);
      for (const a of world.amenities.values()) value += amenitySellback(a.kind);
      return value;
    };
    expect(hospitalValue(world)).toBe(expected());

    // Expanding moves BOTH sides of the identity (the rect is the input).
    const exam = world.roomsOfType('exam')[0]!;
    world.expandRoom(exam.id, { col: 14, row: 27, cols: 4, rows: 3 });
    expect(hospitalValue(world)).toBe(expected());
  });

  it('selling is value-NEUTRAL: the asset leaves, its sell-back lands in cash', () => {
    // Worth stating so nobody "fixes" it: company value is cash + sell-backs,
    // and sellRoom pays exactly sellbackAmount — so the total is conserved.
    // What drops is the DEPARTMENT's capital (asserted below), which is the
    // number the §5 departments block actually shows.
    const world = new World(new EventBus(), 23);
    setupNewGame(world);
    world.cash += 100_000;
    world.buildRoom('exam', { col: 14, row: 27, cols: 3, rows: 3 }, { col: 17, row: 28 });
    const exam = world.roomsOfType('exam')[0]!;
    const sellback = sellbackAmount(exam.type, exam.rect);
    const before = hospitalValue(world);

    apply(world, { type: 'sellRoom', roomId: exam.id });

    expect(world.rooms.has(exam.id)).toBe(false);
    expect(world.today.sellIncome).toBe(sellback);
    expect(hospitalValue(world)).toBe(before);
  });

  it('departmentCapital sums priceOf per category over LIVE rooms', () => {
    const world = new World(new EventBus(), 29);
    setupNewGame(world);
    world.cash += 100_000;
    world.buildRoom('exam', { col: 14, row: 27, cols: 3, rows: 3 }, { col: 17, row: 28 });
    world.buildRoom('xray', { col: 24, row: 26, cols: 3, rows: 4 }, { col: 27, row: 27 });

    const expected = (category: RoomCategory): number => {
      let sum = 0;
      for (const room of world.rooms.values()) {
        if (ROOM_DEFS[room.type].category === category) sum += priceOf(room.type, room.rect);
      }
      return sum;
    };
    const categories: RoomCategory[] = ['basics', 'imaging', 'treatment', 'comfort'];
    for (const category of categories) {
      expect(departmentCapital(world, category), category).toBe(expected(category));
    }
    expect(departmentCapital(world, 'imaging')).toBeGreaterThan(0); // non-vacuous
    // The free-built starting rooms DO count — a replacement-cost read of what
    // the department is worth, never a receipt (§5, NIT N4).
    expect(departmentCapital(world, 'basics')).toBeGreaterThan(0);

    const xray = world.roomsOfType('xray')[0]!;
    const xrayPrice = priceOf(xray.type, xray.rect);
    const imagingBefore = departmentCapital(world, 'imaging');
    apply(world, { type: 'sellRoom', roomId: xray.id });
    expect(departmentCapital(world, 'imaging')).toBe(imagingBefore - xrayPrice);
  });
});

// ------------------------------------------------------------------ §11.8

describe('averageBillPerPatient (§3.2, re-review MAJOR N2)', () => {
  it('excludes vending and is null before the first discharge', () => {
    const lifetime = emptyCashTotals();
    expect(averageBillPerPatient(lifetime, 0, 0)).toBeNull();
    lifetime.revenue = 1_000;
    lifetime.vendingRevenue = 100;
    expect(averageBillPerPatient(lifetime, 0, 0)).toBeNull(); // still no discharges
    expect(averageBillPerPatient(lifetime, 3, 0)).toBe(300); // (1000 − 100) / 3
  });

  it('uses the WATERMARKED denominator on a migrated save, never a skewed one', () => {
    // The N2 regression: a v6→v7 import restores lifetimeTreated NONZERO while
    // lifetime cash starts at 0. Without the watermark the average divides
    // fresh revenue by pre-upgrade discharges and reads permanently, invisibly
    // low — the fabricated number §7 Q7 forbids.
    const lifetime = emptyCashTotals();
    const imported = 400; // discharges that predate lifetime tracking
    expect(averageBillPerPatient(lifetime, imported, imported)).toBeNull();
    lifetime.revenue = 600;
    expect(averageBillPerPatient(lifetime, imported + 2, imported)).toBe(300);
    // What an unwatermarked denominator would have reported instead:
    expect(averageBillPerPatient(lifetime, imported + 2, 0)).toBeLessThan(2);
  });
});

// ----------------------------------------------------------------- §11.10

describe('roomEarns is DERIVED from CONDITION_DEFS (§9.2)', () => {
  it('pins the current earning set', () => {
    const earning = ROOM_TYPES.filter(roomEarns).sort();
    const pinned: RoomType[] = [
      'ct',
      'dialysis',
      'er',
      'exam',
      'mri',
      'nucMed',
      // RETIRED (DEPARTMENTS_PLAN §3.6 ruling 2) — no step routes here any
      // more, but a standing `resp` room in a live save holds real accumulated
      // revenue, and dropping its Income row would hide where that money went.
      'resp',
      'surgery',
      'ultrasound',
      'xray',
    ];
    expect(earning).toEqual(pinned.sort());
  });

  it('is exactly the set of rooms some BILLING condition step routes to (no hand-kept flag)', () => {
    // Mirrors the implementation's `fee > 0` filter (review NIT): today every
    // step bills, so an unfiltered derivation agrees by coincidence — but a
    // future free observation/consult step would fail THIS test rather than
    // the pinned-set test above, which is the one meant to catch a changed set.
    const fromTable = new Set<RoomType>();
    for (const def of Object.values(CONDITION_DEFS)) {
      for (const step of def.steps) if (step.fee > 0) fromTable.add(step.room);
    }
    // The derivation is CONDITION_DEFS ∪ RETIRED_ROOMS — still derived, still
    // no hand-kept flag. Retired rooms earned historically and keep the row.
    for (const type of RETIRED_ROOMS) fromTable.add(type);
    for (const type of ROOM_TYPES) expect(roomEarns(type), type).toBe(fromTable.has(type));
    // The support cast bills nothing — no fee routes through them.
    for (const type of ['reception', 'waiting', 'triage', 'restroom', 'atrium'] as RoomType[]) {
      expect(roomEarns(type), type).toBe(false);
    }
  });
});

describe('amenity spend is a cash category', () => {
  it('placing and selling a machine tallies construction and sell-back income', () => {
    const world = new World(new EventBus(), 31);
    setupNewGame(world);
    world.placeAmenity('vending', VENDING_TILE);
    expect(world.today.construction).toBe(AMENITY_DEFS.vending.cost);
    expect(world.lifetime.construction).toBe(AMENITY_DEFS.vending.cost);
    world.sellAmenity(VENDING_TILE);
    expect(world.today.sellIncome).toBe(amenitySellback('vending'));
    expect(world.lifetime.sellIncome).toBe(amenitySellback('vending'));
  });
});
