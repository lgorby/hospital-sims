import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/events';
import { gameMinutesToTicks, TICKS_PER_DAY, TICKS_PER_GAME_HOUR } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import type { ConditionId } from '../src/sim/data/conditions';
import { ROLE_DEFS, type RoleId } from '../src/sim/data/roles';
import { ROOM_DEFS, type RoomType } from '../src/sim/data/rooms';
import { setupNewGame } from '../src/sim/newGame';
import type { GridPoint, Rect } from '../src/sim/types';
import { World } from '../src/sim/world';

/**
 * M4 headless balance harness (tech plan §4 M4): build/hire configs, run N
 * game-days renderer-free, assert the survivability envelope. This is the
 * payoff of the deterministic sim — a whole day simulates in well under a
 * second. Also owes two risk-table assertions (tech plan §5): acuity-5
 * patients get treated under sustained load, and a zero-atrium long-walk
 * hospital degrades but does not deadlock.
 */

interface RoomSpec {
  type: RoomType;
  rect: Rect;
  door: GridPoint | null;
}

/**
 * Near-entrance treatment wing: short walks, full coverage of all 14
 * conditions. The V1 band (rows 26–30) is the M4 reference build; the
 * Expansion-1 band (rows 20–24, GDD §12) sits one corridor north of it.
 */
const STANDARD_ROOMS: RoomSpec[] = [
  // Amenities Stage 1 (§4 exit gate): the reference build runs with meters
  // live — a restroom keeps bladder side-trips short; see AMENITY_SPOTS.
  { type: 'restroom', rect: { col: 5, row: 27, cols: 2, rows: 3 }, door: { col: 7, row: 28 } },
  { type: 'triage', rect: { col: 10, row: 28, cols: 2, rows: 2 }, door: { col: 12, row: 29 } },
  { type: 'exam', rect: { col: 14, row: 27, cols: 3, rows: 3 }, door: { col: 17, row: 28 } },
  { type: 'exam', rect: { col: 18, row: 27, cols: 3, rows: 3 }, door: { col: 21, row: 28 } },
  { type: 'xray', rect: { col: 24, row: 26, cols: 3, rows: 4 }, door: { col: 27, row: 27 } },
  { type: 'resp', rect: { col: 28, row: 27, cols: 3, rows: 3 }, door: { col: 31, row: 28 } },
  { type: 'er', rect: { col: 32, row: 26, cols: 3, rows: 4 }, door: { col: 35, row: 27 } },
  { type: 'ultrasound', rect: { col: 8, row: 21, cols: 2, rows: 3 }, door: { col: 10, row: 22 } },
  { type: 'ct', rect: { col: 12, row: 20, cols: 4, rows: 4 }, door: { col: 14, row: 24 } },
  { type: 'mri', rect: { col: 17, row: 20, cols: 4, rows: 4 }, door: { col: 19, row: 24 } },
  { type: 'nucMed', rect: { col: 22, row: 20, cols: 3, rows: 4 }, door: { col: 23, row: 24 } },
  { type: 'dialysis', rect: { col: 26, row: 20, cols: 3, rows: 4 }, door: { col: 27, row: 24 } },
  { type: 'surgery', rect: { col: 30, row: 20, cols: 4, rows: 4 }, door: { col: 32, row: 24 } },
];

/** The Expansion-1 wing — bankrolled separately (its 81k exceeds starting cash). */
const EXPANSION_WING: readonly RoomType[] = [
  'ultrasound',
  'ct',
  'mri',
  'nucMed',
  'dialysis',
  'surgery',
];

/**
 * Same coverage moved to the far north edge: every treatment walk is ~30
 * tiles. (Offset re-tuned −24 → −18 for Expansion 1: the added band at rows
 * 20–24 must stay on the map; far doors land at rows 6–11, still a ~30-tile
 * trek from the south entrance — the long-walk premise is intact.)
 */
const FAR_ROOMS: RoomSpec[] = STANDARD_ROOMS.map((r) => ({
  ...r,
  rect: { ...r.rect, row: r.rect.row - 18 },
  door: r.door ? { ...r.door, row: r.door.row - 18 } : null,
}));

const STANDARD_STAFF: { role: RoleId; count: number }[] = [
  { role: 'nurse', count: 3 }, // triage + dialysis + the ER/OR dual-staff pool
  { role: 'doctor', count: 2 },
  { role: 'radTech', count: 2 }, // §12: the deliberate multi-scanner bottleneck role
  { role: 'respTherapist', count: 1 },
  { role: 'sonographer', count: 1 },
  { role: 'surgeon', count: 1 },
  // Amenities Stage 2 (§S2.6b exit gate): the reference build cleans up —
  // messes occur organically (vomit + litter) and the envelope must stay
  // green with one EVS working the job queue.
  { role: 'evs', count: 1 },
  // Amenities Stage 3 (§S3.8 exit gate): the reference build repairs —
  // wear accrues per use, breakdowns occur organically (MTBF ≈31/≈45 uses),
  // and the envelope must stay green with one tech cycling repairs.
  { role: 'maintenance', count: 1 },
  // ANESTHESIA_PLAN §4 (pre-impl review MAJOR 1): the OR is a THREE-role
  // gather now, so the reference build must actually hire one — without it
  // gallstones and appendicitis discharge ZERO for every seed and the
  // per-condition asserts below fail unconditionally. This is a ROSTER
  // change, not a re-pin. Roster payroll $2,640 → $3,060/day (+16%), a real
  // tightening of the operating envelope the balance pass must absorb.
  { role: 'anesthesiologist', count: 1 },
];

interface RunSummary {
  world: World;
  treatedByCondition: Map<ConditionId, number>;
  treatedAcuity5: number;
  totalTreated: number;
  treatedPerDay: number[];
  totalDied: number;
  totalAma: number;
  /** Stage 2 (§S2.6b): summed daily messTicks — proves messes occur
   *  organically in the reference run (the gate premise is asserted). */
  messTicksTotal: number;
  /** Stage 3 (§S3.8): organic breakdown count — the wear/repair loop ran. */
  breakdowns: number;
  /** Stage 3 probe: repairs completed (a breakdown that never un-breaks
   *  would pass the count above while the tech spins). */
  roomsBrokenAtEnd: number;
  lostEpisodes: number;
  chestPainArrived: number;
  /** Per-tick probe: the longest ANY reservation lived, in ticks. */
  maxReservationAgeTicks: number;
  /** Probe saw at least one reservation whose patient was lost mid-walk. */
  lostHolderObserved: boolean;
}

function runHospital(
  seed: number,
  rooms: RoomSpec[],
  days: number,
  opts: { pinReputation?: number } = {},
): RunSummary {
  const events = new EventBus();
  const world = new World(events, seed);
  setupNewGame(world); // reception + waiting room + receptionist

  // Bankroll exactly the Expansion-1 wing: the full-roster reference build
  // costs more than starting cash, and the harness measures the OPERATING
  // envelope — post-construction cash stays at the M4 baseline (startingCash
  // minus the V1 band) instead of moving with the expansion's capital cost.
  world.cash += rooms
    .filter((r) => EXPANSION_WING.includes(r.type))
    .reduce((sum, r) => sum + ROOM_DEFS[r.type].cost, 0);

  for (const spec of rooms) world.buildRoom(spec.type, spec.rect, spec.door);
  // A failed build (validation bug in the spec) would silently gut the config.
  expect(world.rooms.size).toBe(rooms.length + 2);
  // Amenities Stage 1 (§4): vending + trashcan near the waiting room, fixed
  // corridor tiles clear of both the standard and far-north room bands.
  world.placeAmenity('vending', { col: 26, row: 33 });
  world.placeAmenity('trashcan', { col: 27, row: 33 });
  expect(world.amenities.size).toBe(2); // placement validated, not assumed
  for (const { role, count } of STANDARD_STAFF) {
    for (let i = 0; i < count; i++) {
      world.addStaffMember(role, 3, ROLE_DEFS[role].salaryPerDay);
    }
  }

  const summary: RunSummary = {
    world,
    treatedByCondition: new Map(),
    treatedAcuity5: 0,
    totalTreated: 0,
    treatedPerDay: [],
    totalDied: 0,
    totalAma: 0,
    messTicksTotal: 0,
    breakdowns: 0,
    roomsBrokenAtEnd: 0,
    lostEpisodes: 0,
    chestPainArrived: 0,
    maxReservationAgeTicks: 0,
    lostHolderObserved: false,
  };
  events.on('patientDischarged', ({ patientId }) => {
    const patient = world.patients.get(patientId);
    summary.totalTreated += 1;
    if (patient) {
      const prev = summary.treatedByCondition.get(patient.condition) ?? 0;
      summary.treatedByCondition.set(patient.condition, prev + 1);
      if (patient.acuity === 5) summary.treatedAcuity5 += 1;
    }
  });
  events.on('patientDied', () => (summary.totalDied += 1));
  events.on('roomBroken', () => (summary.breakdowns += 1));
  events.on('patientLeftAma', () => (summary.totalAma += 1));
  events.on('patientLost', () => (summary.lostEpisodes += 1));
  events.on('patientSpawned', ({ patientId }) => {
    if (world.patients.get(patientId)?.condition === 'chestPain') summary.chestPainArrived += 1;
  });
  events.on('dayEnded', (r) => {
    summary.treatedPerDay.push(r.treated);
    summary.messTicksTotal += r.messTicks;
  });

  // In-run probe (M4 review #1): a deadlocked reservation shows up as an age
  // that grows without bound — sampling every tick makes the check impossible
  // to satisfy vacuously at a lucky end-tick snapshot.
  const firstSeen = new Map<number, number>();
  for (let i = 0; i < TICKS_PER_DAY * days; i++) {
    if (opts.pinReputation !== undefined) world.reputation = opts.pinReputation;
    world.tick();
    for (const reservation of world.reservations.values()) {
      const born = firstSeen.get(reservation.id) ?? world.clock.tick;
      firstSeen.set(reservation.id, born);
      const age = world.clock.tick - born;
      if (age > summary.maxReservationAgeTicks) summary.maxReservationAgeTicks = age;
      if (world.patients.get(reservation.patientId)?.lost) summary.lostHolderObserved = true;
    }
  }
  // Stage discipline (audit #5): days of full-pipeline sim must produce zero
  // illegal lifecycle transitions.
  expect(world.stageViolations).toEqual([]);
  for (const room of world.rooms.values()) {
    if (room.brokenSince !== null) summary.roomsBrokenAtEnd += 1;
  }
  return summary;
}

describe('headless balance harness (M4)', () => {
  it('a sensible hospital survives 5 days in the black and treats the load', () => {
    // 5 days, not the M4 pass's 3 (review re-tune, premise intact): the rarest
    // §12 paths (gallstones at 6/148 sharing one OR with appendicitis) need a
    // longer window to reliably produce a discharge of EVERY condition.
    // Seed re-pin 1337→1338 (amenities Stage 1): the two spawn-meter rng
    // draws shift every fixed-seed trajectory; at 1337 only 4 appendicitis
    // arrived in 5 days and none cleared the shared OR — arrival luck, not
    // balance (cash/rep/treated all healthy there; audited across 5 seeds).
    // Assertions unchanged — the seed is the fixture.
    // Stage 2 (§S2.6b): the evs role's constructor candidates + per-patient
    // vomit draws + the EVS hire shifted every stream AGAIN. Seed 1338
    // re-validated green as-is (probe: ~16.8k mess-ticks over 5 days, a can
    // overflow, EVS steady-state ~5 standing messes, 124 treated / 0 died,
    // rep 545) — no alternate-seed hunt needed; the fixture seed stands.
    // Stage 3 (§S3.8): the maintenance role + wear rolls shifted every
    // stream a third time. Pre-balance-pass 1338 failed appendicitis
    // (arrival luck, audited across 5 seeds) — but the SAME audit exposed
    // the break-watchdog defect (30 game-min ≈ a 14-tile walk: 373 restroom
    // claims → 23 completions, the owner's "bathrooms don't look used").
    // After the watchdog/meter balance pass, 1338 re-validated green
    // (probe: 132 restroom visits, 5 organic breakdowns incl. the restroom's
    // piping, 0 broken at end, 111 treated / 3 died, rep 459) — the fixture
    // seed stands un-re-pinned.
    const s = runHospital(1338, STANDARD_ROOMS, 5);
    const w = s.world;

    expect(w.gameOver).toBe(false);
    expect(w.cash).toBeGreaterThan(BALANCE.economy.bankruptcyThreshold);
    // Survivability envelope: real throughput, and death is the exception.
    expect(s.totalTreated).toBeGreaterThan(30);
    expect(s.totalDied).toBeLessThan(s.totalTreated / 2);
    expect(w.reputation).toBeGreaterThan(0);
    // Stage-2 gate premise, asserted not assumed (§S2.6b): messes occurred
    // ORGANICALLY in this run — the envelope above was earned with the
    // cleanliness layer live, not on a spotless fluke.
    expect(s.messTicksTotal).toBeGreaterThan(0);
    // Stage-3 gate premises (§S3.8): breakdowns occurred ORGANICALLY (the
    // wear loop is live, MTBFs are in a felt range) AND the lone tech kept
    // up — the run must not END with a broken-room backlog (a repair that
    // never completes would pass the count while the hospital rots).
    expect(s.breakdowns).toBeGreaterThan(0);
    expect(s.roomsBrokenAtEnd).toBeLessThanOrEqual(1); // at most one mid-repair at the bell
    // End-to-end coverage of every §12 path (review MINOR): each expansion
    // condition must actually DISCHARGE — an idle nucMed or dialysis room
    // would otherwise pass every aggregate gate above.
    const expansionConditions: ConditionId[] = [
      'kidneyStones',
      'backInjury',
      'thyroid',
      'kidneyFailure',
      'gallstones',
      'headInjury',
      'appendicitis',
      'stroke',
    ];
    for (const id of expansionConditions) {
      expect(s.treatedByCondition.get(id) ?? 0, `${id} discharged`).toBeGreaterThan(0);
    }
    // Finance state, asserted LIVE rather than assumed, so the seeded run is
    // not making a vacuous claim. (History note: the finances epic was the
    // first save bump that added no role and so kept seed 1338 un-re-pinned —
    // ANESTHESIA_PLAN §6 ended that, because a new RoleId mints constructor
    // candidates and shifts every seeded stream from tick 0. The seed was
    // re-pinned deliberately there; a red seed is still a finding to be
    // FOUND, but "a role was added" is now a legitimate cause.)
    expect(w.history).toHaveLength(5); // one entry per closed day, under cap
    expect(w.history.length).toBeLessThanOrEqual(BALANCE.finance.historyCapDays);
    expect(w.lifetime.revenue).toBeGreaterThan(0);
    expect(w.lifetime.payroll).toBeGreaterThan(0);
    expect(w.lifetimeTreatedBase, 'a fresh game carries a zero watermark').toBe(0);
    // The tallyCash invariant, end to end: lifetime = Σ closed days + today.
    const historicRevenue = w.history.reduce((sum, r) => sum + r.revenue, 0);
    expect(historicRevenue + w.today.revenue).toBe(w.lifetime.revenue);
    // Per-unit attribution is live too: rooms and the machine earned.
    expect([...w.rooms.values()].some((r) => r.visitsTotal > 0 && r.revenueTotal > 0)).toBe(true);
    expect([...w.amenities.values()].some((a) => a.revenueTotal > 0)).toBe(true);
  });

  it('a neglected hospital (no treatment rooms) does NOT survive the same numbers', () => {
    const events = new EventBus();
    const world = new World(events, 1337);
    setupNewGame(world); // reception + waiting only — nobody can treat anything
    let treated = 0;
    events.on('patientDischarged', () => (treated += 1));
    for (let i = 0; i < TICKS_PER_DAY * 3; i++) world.tick();

    expect(treated).toBe(0);
    // Everyone AMAs or dies; reputation collapses well below starting.
    expect(world.reputation).toBeLessThan(BALANCE.reputation.starting / 2);
    // And nothing deadlocks: no reservations exist, patients keep cycling out.
    expect(world.reservations.size).toBe(0);
  });

  it('risk: acuity-5 patients still get treated under SUSTAINED overload (priority aging)', () => {
    // Reputation pinned at max ⇒ ~2× arrival multiplier + referral case-mix
    // shift: arrivals permanently exceed this build's throughput (the AMA
    // assertion proves the overload is real, not comfortable headroom).
    // Mutation note (M4 review #2): removing aging from effectivePriority
    // does NOT starve flu in this config — the single ER throttles chest
    // pain and X-ray throttles fractures, so room partitioning independently
    // shields the exam lane. This test asserts the SYSTEM outcome the tech
    // plan §5 asks for; the aging mechanism itself is regression-guarded by
    // the M3 formula/dispatcher unit tests (which DO fail under that mutation).
    const s = runHospital(99, STANDARD_ROOMS, 3, { pinReputation: BALANCE.reputation.max });
    expect(s.chestPainArrived).toBeGreaterThan(0);
    expect(s.totalAma).toBeGreaterThan(0); // genuine overload, not comfort
    expect(s.treatedAcuity5).toBeGreaterThan(0); // no starvation of the lowest tier
  });

  it('risk: a zero-atrium long-walk hospital degrades but does not deadlock', () => {
    const s = runHospital(4242, FAR_ROOMS, 2);

    // Degrades: long unguided walks produce real lostness, including lost
    // patients holding live reservations (probe non-vacuity, M4 review #1).
    expect(s.lostEpisodes).toBeGreaterThan(0);
    expect(s.lostHolderObserved).toBe(true);
    // Does not deadlock: throughput persists into day 2…
    expect(s.treatedPerDay.length).toBe(2);
    expect(s.treatedPerDay[1]!).toBeGreaterThan(0);
    // …and NO reservation ever lived past walk + lost-timeout + treatment:
    // sampled every tick of the whole run, so a single stuck reservation
    // (leaked staff + idle room) fails this even if it resolves by day end.
    const lifecycleBound =
      gameMinutesToTicks(BALANCE.wayfinding.lostReservationTimeoutGameMinutes) +
      3 * TICKS_PER_GAME_HOUR;
    expect(s.maxReservationAgeTicks).toBeGreaterThan(0);
    expect(s.maxReservationAgeTicks).toBeLessThan(lifecycleBound);
  });

});
