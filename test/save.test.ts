import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus, type EventName } from '../src/events';
import { TICKS_PER_DAY, TICKS_PER_GAME_HOUR } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import { ROLE_IDS } from '../src/sim/data/roles';
import { emptyCashTotals } from '../src/sim/data/finance';
import { emptyDayTally } from '../src/sim/dailyStats';
import { averageBillPerPatient, shiftWageMultiplier, treatmentDurationTicks } from '../src/sim/formulas';
import { setupNewGame } from '../src/sim/newGame';
import {
  SAVE_VERSION,
  decodeGrid,
  encodeGrid,
  loadWorld,
  saveToString,
  serializeWorld,
  type SaveData,
} from '../src/sim/save';
import { World } from '../src/sim/world';

/**
 * Phase-1 save/load (docs/PERSISTENCE_PLAN.md). The round-trip determinism
 * test is THE acceptance gate (plan rule 4): a loaded world must be
 * indistinguishable from one that never went through JSON — identical event
 * stream, identical final state. It extends the fixed-seed replay test in
 * m3Wayfinding.test.ts.
 */

/**
 * Every event the bus can carry. Record-typed so adding an event to EventMap
 * breaks THIS FILE's compile — new events must be observed by the gate.
 */
const EVENT_NAMES: Record<EventName, true> = {
  speedChanged: true,
  cashChanged: true,
  dayEnded: true,
  gameOver: true,
  roomBuilt: true,
  roomChanged: true,
  roomSold: true,
  roomBroken: true,
  amenityPlaced: true,
  amenitySold: true,
  messChanged: true,
  jobChanged: true,
  buildRejected: true,
  patientSpawned: true,
  patientDied: true,
  patientLeftAma: true,
  patientDischarged: true,
  patientComplication: true,
  patientLost: true,
  patientRecovered: true,
  patientThought: true,
  feeBilled: true,
  staffHired: true,
  staffFired: true,
  staffUpdated: true,
  hint: true,
  reputationChanged: true,
  debugMarkerToggled: true,
  // UI-emitted (challenge controller), never fires in a sim-only save
  // round-trip — listed so the completeness gate stays exhaustive.
  challengeComplete: true,
};
const ALL_EVENTS = Object.keys(EVENT_NAMES) as EventName[];

/** Subscribe to EVERY event; each emission logs `tick|name|payload`. */
function observeAll(events: EventBus, world: World): string[] {
  const log: string[] = [];
  for (const name of ALL_EVENTS) {
    events.on(name, (payload) => {
      log.push(`${world.clock.tick}|${name}|${JSON.stringify(payload)}`);
    });
  }
  return log;
}

const SEED = 20260717;

/**
 * Everything the review (MAJOR 2) requires to exist SIMULTANEOUSLY at the
 * save tick, before the deliberate pre-save pokes are layered on top:
 * an organically-lost patient, an overflowing check-in pipeline
 * (atEntrance + queuedCheckIn + a mid-checkingIn patient), a triage backlog,
 * and both reservation kinds in both phases.
 */
function pipelineRich(world: World): boolean {
  const patients = [...world.patients.values()];
  const stages = new Set<string>(patients.map((p) => p.stage.kind));
  const reservations = [...world.reservations.values()];
  const overflow = patients.filter((p) => p.stage.kind === 'atEntrance' && p.lost === null);
  const breaks = patients.flatMap((p) => (p.needBreak === null ? [] : [p.needBreak]));
  const jobs = [...world.jobs.values()];
  return (
    patients.some((p) => p.lost !== null) &&
    overflow.length >= 3 && // 2 get debugForce'd to leaving/dead; ≥1 must remain
    stages.has('queuedCheckIn') &&
    stages.has('checkingIn') &&
    stages.has('waitingTriage') &&
    reservations.some((r) => r.kind === 'triage') &&
    reservations.some((r) => r.kind === 'treatment') &&
    reservations.some((r) => r.phase === 'gathering') &&
    reservations.some((r) => r.phase === 'active') &&
    // Stage A: a CONCURRENT reservation (slot 1 of the dialysis room) must be
    // live at the save tick, or the gate never exercises multi-slot state.
    reservations.some((r) => r.slotIndex > 0) &&
    // v4 (amenities Stage 1, §3.5 pins): a `walking` AND a `using` break, one
    // restroom AND one vending claim, live at the save tick — else the gate
    // never exercises the needBreak schema corners.
    breaks.some((b) => b.phase === 'walking') &&
    breaks.some((b) => b.phase === 'using') &&
    breaks.some((b) => b.kind === 'restroom') &&
    breaks.some((b) => b.kind === 'vending') &&
    // v5 (amenities Stage 2, §S2.4 pins): the queued+assigned+working job
    // conjunction (2 EVS + a backlog makes it reachable), a filling can,
    // and a nonzero mess tally — all live at the SAME save tick.
    jobs.some((j) => j.phase === 'queued') &&
    jobs.some((j) => j.phase === 'assigned') &&
    jobs.some((j) => j.phase === 'working') &&
    (world.amenityAt(26, 36)?.fill ?? 0) > 0 &&
    world.today.messTicks > 0 &&
    // v6 (amenities Stage 3, §S3.5 pins): a WORKING repair mid-timer at the
    // save tick (the xray/resp re-break rotation + 1 tech keeps one live);
    // the queued repair + water messes are minted AT the save tick by
    // breaking the restroom (commands apply synchronously).
    jobs.some((j) => j.kind === 'repair' && j.phase === 'working') &&
    // v7 (finances, §9.7 pins): the schema corners the finances epic added —
    // a room earning BOTH today and on an earlier day (revenueTotal >
    // revenueToday > 0), a vending machine with lifetime takings, at least two
    // CLOSED days in history, and a nonzero lifetime tally — all at the SAME
    // save tick.
    [...world.rooms.values()].some((r) => r.revenueToday > 0 && r.revenueTotal > r.revenueToday) &&
    [...world.amenities.values()].some((a) => a.kind === 'vending' && a.revenueTotal > 0) &&
    world.history.length >= 2 &&
    world.lifetime.revenue > 0
  );
}

/**
 * Premises asserted EXPLICITLY at the save tick, so a future balance tweak
 * that hollows the gate fails loudly instead of silently (review MAJOR 2).
 */
function assertRichPremises(world: World): void {
  const patients = [...world.patients.values()];
  const stages = new Set<string>(patients.map((p) => p.stage.kind));
  const required = [
    'atEntrance',
    'queuedCheckIn',
    'checkingIn',
    'waitingTriage',
    'reserved',
    'leaving',
    'dead',
  ];
  for (const kind of required) {
    expect(stages.has(kind), `stage '${kind}' present at the save tick`).toBe(true);
  }
  expect(
    patients.some((p) => p.lost !== null),
    'a lost patient at the save tick',
  ).toBe(true);
  expect(
    patients.some((p) => p.dispatchHoldUntil > world.clock.tick),
    'a pending dispatcher retry hold',
  ).toBe(true);
  expect(
    [...world.staff.values()].some((s) => s.firing),
    'a staff member firing mid-active-reservation',
  ).toBe(true);
  const reservations = [...world.reservations.values()];
  expect(new Set(reservations.map((r) => r.kind)), 'both reservation kinds').toEqual(
    new Set(['triage', 'treatment']),
  );
  expect(new Set(reservations.map((r) => r.phase)), 'both reservation phases').toEqual(
    new Set(['gathering', 'active']),
  );
  expect(
    reservations.some((r) => r.slotIndex > 0),
    'a concurrent (nonzero-slot) reservation at the save tick (Stage A)',
  ).toBe(true);
  expect(
    [...world.checkInQueues.values()].some((q) => q.length > 0),
    'a populated check-in queue',
  ).toBe(true);
  // v4 premises (amenities Stage 1, §3.5 — asserted, never assumed):
  const breaks = patients.flatMap((p) => (p.needBreak === null ? [] : [p.needBreak]));
  expect(breaks.some((b) => b.phase === 'walking'), 'a walking need break').toBe(true);
  expect(breaks.some((b) => b.phase === 'using'), 'a using need break').toBe(true);
  expect(breaks.some((b) => b.kind === 'restroom'), 'a restroom stall claim').toBe(true);
  expect(breaks.some((b) => b.kind === 'vending'), 'a vending machine claim').toBe(true);
  expect(world.amenityAt(26, 36)?.kind, 'a placed trashcan').toBe('trashcan');
  expect(
    patients.some((p) => p.needBreakHoldUntil > world.clock.tick),
    'a pending needBreakHoldUntil',
  ).toBe(true);
  // v5 premises (amenities Stage 2, §S2.4 — asserted, never assumed):
  const jobs = [...world.jobs.values()];
  const messKey = (t: { col: number; row: number }): string => `${t.col},${t.row}`;
  expect(
    jobs.some((j) => j.phase === 'queued' && world.messes.has(messKey(j.tile))),
    'a live mess with a queued job',
  ).toBe(true);
  expect(jobs.some((j) => j.phase === 'assigned'), 'an assigned job (worker mid-walk)').toBe(true);
  expect(jobs.some((j) => j.phase === 'working'), 'a working job mid-timer').toBe(true);
  expect(
    jobs.some((j) => j.phase === 'queued' && j.holdUntil > world.clock.tick),
    'a queued job under a retry hold (the Stage-1 hold-pin precedent)',
  ).toBe(true);
  expect(world.amenityAt(26, 36)!.fill, 'a can mid-fill (fill > 0)').toBeGreaterThan(0);
  expect(world.today.messTicks, 'a nonzero mess tally at the save tick').toBeGreaterThan(0);
  // v6 premises (amenities Stage 3, §S3.5 — asserted, never assumed):
  const rooms = [...world.rooms.values()];
  expect(
    rooms.some((r) => r.brokenSince === null && r.wear > 0),
    'an in-service room with nonzero wear',
  ).toBe(true);
  const repairs = jobs.filter((j) => j.kind === 'repair');
  expect(
    repairs.some((j) => j.phase === 'queued'),
    'a broken room with a QUEUED repair (the just-broken restroom)',
  ).toBe(true);
  expect(
    repairs.some((j) => j.phase === 'working'),
    'a broken room with a WORKING repair mid-timer',
  ).toBe(true);
  for (const j of repairs) {
    expect(world.rooms.get(j.roomId!)?.brokenSince, 'every repair targets a broken room').not.toBeNull();
  }
  expect(
    [...world.messes.values()].some(
      (m) => m.kind === 'water' && world.jobAt(m.tile)?.kind === 'clean',
    ),
    'a water mess with its clean job (the piping burst)',
  ).toBe(true);
  // v7 premises (finances, §9.7 — asserted, never assumed):
  expect(
    rooms.some((r) => r.revenueToday > 0 && r.revenueTotal > r.revenueToday),
    'a room earning today AND carrying earlier days (revenueTotal > revenueToday > 0)',
  ).toBe(true);
  expect(
    rooms.some((r) => r.visitsTotal > 0),
    'a room with completed treatment steps',
  ).toBe(true);
  expect(
    [...world.amenities.values()].some((a) => a.kind === 'vending' && a.revenueTotal > 0),
    'a vending machine with lifetime takings',
  ).toBe(true);
  expect(world.history.length, 'at least two closed days in history').toBeGreaterThanOrEqual(2);
  // The byte-identity fixture must never be OVER cap: an over-cap save is
  // trimmed on load and therefore NOT byte-identical on re-save (§9.7).
  expect(world.history.length, 'the fixture stays under historyCapDays').toBeLessThanOrEqual(
    BALANCE.finance.historyCapDays,
  );
  expect(world.lifetime.revenue, 'a nonzero lifetime tally').toBeGreaterThan(0);
  expect(
    world.lifetimeTreatedBase,
    'a fresh (non-migrated) world carries a zero watermark',
  ).toBe(0);
}

/**
 * A mid-game world exercising the whole schema. Phase A/B: the newGame build
 * plus triage + far-north exam (long treks → organic wrong turns), staff on
 * duty, organic + debug arrivals, a mid-run atrium build + debug marker so the
 * grid diverges from anything room defs could re-derive. Phase C (MAJOR 2):
 * tick until the pipeline is rich (see pipelineRich), then layer on the
 * states only commands/pokes can pin: a mid-active fire, an AMA leaver, a
 * corpse, and a pending dispatch hold — all at the exact save tick.
 */
function bootScenario(): { world: World; events: EventBus } {
  const events = new EventBus();
  const world = new World(events, SEED);
  const queue = new CommandQueue();
  setupNewGame(world);
  world.addStaffMember('nurse', 3, 150);
  world.addStaffMember('nurse', 3, 150);
  world.addStaffMember('nurse', 3, 150); // third: keeps dialysis dual-booking likely
  world.addStaffMember('doctor', 3, 300);
  world.addStaffMember('doctor', 3, 300);
  // v5 (amenities Stage 2, §S2.4 sketch): TWO EVS — the queued+assigned+
  // working job conjunction needs two workers busy plus a backlog.
  world.addStaffMember('evs', 3, 90);
  world.addStaffMember('evs', 3, 90);
  // v6 (amenities Stage 3, §S3.5 sketch): ONE tech — with the xray/resp
  // re-break rotation, one repair is always working while the other (and
  // the save-tick restroom break) queue behind it.
  world.addStaffMember('maintenance', 3, 140);
  queue.push({
    type: 'buildRoom',
    roomType: 'triage',
    rect: { col: 10, row: 30, cols: 2, rows: 2 },
    doorOutside: { col: 10, row: 32 },
  });
  // Dialysis (Stage A gate coverage): min size = TWO machines = capacity 2 —
  // the enrichment loop must reach a tick with CONCURRENT reservations
  // (a nonzero slotIndex) so the round-trip gate exercises multi-slot state.
  queue.push({
    type: 'buildRoom',
    roomType: 'dialysis',
    rect: { col: 28, row: 28, cols: 3, rows: 4 },
    doorOutside: { col: 29, row: 32 },
  });
  // Exam far NORTH (same rect as the m3 determinism test): treated patients
  // trek ~25 corridor tiles, which is what makes wrong turns organic.
  queue.push({
    type: 'buildRoom',
    roomType: 'exam',
    rect: { col: 14, row: 6, cols: 3, rows: 3 },
    doorOutside: { col: 15, row: 9 },
  });
  // v4 (amenities Stage 1): a restroom + vending + trashcan so the gate can
  // pin stall/machine claims and the amenities store (§3.5 pins).
  queue.push({
    type: 'buildRoom',
    roomType: 'restroom',
    rect: { col: 6, row: 30, cols: 2, rows: 3 },
    doorOutside: { col: 8, row: 31 },
  });
  queue.push({ type: 'placeAmenity', kind: 'vending', col: 25, row: 36 });
  queue.push({ type: 'placeAmenity', kind: 'trashcan', col: 26, row: 36 });
  // v6 (Stage 3): two mechanical rooms in a quiet corner — the breakdown
  // rotation's raw material (no staff for them: they exist to break).
  queue.push({
    type: 'buildRoom',
    roomType: 'xray',
    rect: { col: 32, row: 8, cols: 3, rows: 4 },
    doorOutside: { col: 33, row: 12 },
  });
  queue.push({
    type: 'buildRoom',
    roomType: 'resp',
    rect: { col: 32, row: 16, cols: 3, rows: 3 },
    doorOutside: { col: 33, row: 19 },
  });
  queue.push({ type: 'debugSpawnPatient', condition: 'flu' });
  queue.push({ type: 'debugSpawnPatient', condition: 'laceration' });
  world.applyCommands(queue);
  for (let i = 0; i < 1500; i++) world.tick();

  // Mid-run divergence: an atrium in a quiet corner (helpDesk prop blocks a
  // tile), a debug marker, one more arrival, one more hire.
  queue.push({
    type: 'buildRoom',
    roomType: 'atrium',
    rect: { col: 2, row: 2, cols: 4, rows: 4 },
    doorOutside: null,
  });
  queue.push({ type: 'debugToggleMarker', col: 0, row: 0 });
  queue.push({ type: 'debugSpawnPatient', condition: 'fracture' });
  world.applyCommands(queue);
  world.addStaffMember('greeter', 2, 50);
  for (let i = 0; i < 1500; i++) world.tick();

  // --- Phase C (review MAJOR 2): drive to a simultaneously-rich tick -------
  let guard = 0;
  const ENRICH_TICK_LIMIT = 30000;
  while (!pipelineRich(world) && guard < ENRICH_TICK_LIMIT) {
    if (guard % 60 === 0) {
      // v6 (Stage 3): keep the mechanical pair broken — the lone tech cycles
      // repairs, so a WORKING repair job exists at most ticks (repairs run
      // ~50 ticks at skill 3; the rotation re-breaks within 60).
      for (const room of world.rooms.values()) {
        if ((room.type === 'xray' || room.type === 'resp') && room.brokenSince === null) {
          queue.push({ type: 'debugBreakRoom', roomId: room.id });
        }
      }
      world.applyCommands(queue);
    }
    if (guard % 60 === 0) {
      // Keep the check-in queue overflowing (capacity is queueDepthTiles + 1):
      // sustains queuedCheckIn, checkingIn, and atEntrance overflow — but only
      // top up while the backlog is modest, so the population stays bounded.
      const backlog = [...world.patients.values()].filter(
        (p) => p.stage.kind === 'atEntrance' || p.stage.kind === 'queuedCheckIn',
      ).length;
      if (backlog < 12) {
        queue.push({ type: 'debugSpawnPatient', condition: 'flu' });
        queue.push({ type: 'debugSpawnPatient', condition: 'flu' });
        queue.push({ type: 'debugSpawnPatient', condition: 'laceration' });
        queue.push({ type: 'debugSpawnPatient', condition: 'kidneyFailure' });
        queue.push({ type: 'debugSpawnPatient', condition: 'kidneyFailure' });
        world.applyCommands(queue);
      }
    }
    // Everyone navigates terribly (field poke — allowed; stages never poked):
    // wrong turns on the exam trek become likely, so lostness shows up fast.
    for (const p of world.patients.values()) p.wayfinding = 1;
    // Need side-trips (v4 gate): keep a steady stream of below-threshold
    // meters (field pokes) so some tick catches walking + using breaks of
    // BOTH kinds simultaneously with everything above.
    if (guard % 30 === 0) {
      const free = [...world.patients.values()].filter(
        (p) =>
          (p.stage.kind === 'waiting' || p.stage.kind === 'waitingTriage') &&
          p.needBreak === null &&
          p.lost === null,
      );
      if (free[0]) free[0].bladder = BALANCE.needs.seekThreshold - 10;
      if (free[1]) free[1].thirst = BALANCE.needs.seekThreshold - 10;
      if (free[2]) free[2].thirst = BALANCE.needs.seekThreshold - 10;
      // v5 (§S2.4 sketch): keep a few waiters sub-critical (health pokes —
      // the established field-poke pattern, border-valid, self-consistent)
      // so vomits occur ORGANICALLY and the 2 EVS stay busy enough for the
      // queued+assigned+working conjunction to show up at one tick.
      // BOUNDED: unthrottled pokes drowned the floor in standing messes
      // (mess-proximity patience + low health gutted the care pipeline and
      // the dialysis double-booking never recurred). kidneyFailure waiters
      // are spared — they must survive to co-occupy dialysis (slot > 0).
      if (world.messes.size < 8) {
        const pokeable = [...world.patients.values()].filter(
          (p) =>
            (p.stage.kind === 'waiting' ||
              p.stage.kind === 'waitingTriage' ||
              p.stage.kind === 'queuedCheckIn') &&
            p.condition !== 'kidneyFailure' &&
            p.health >= BALANCE.mood.criticalHealthBelow,
        );
        for (const p of pokeable.slice(0, 2)) p.health = BALANCE.mood.criticalHealthBelow - 10;
      }
    }
    world.tick();
    guard += 1;
  }
  expect(pipelineRich(world), 'enrichment loop reached a rich pipeline tick').toBe(true);

  // Same tick, no further ticking — pin the command/poke-only states:
  // fire a member who is mid-ACTIVE reservation → deferred fire (firing=true).
  const active = [...world.reservations.values()].find((r) => r.phase === 'active')!;
  queue.push({ type: 'fireStaff', staffId: active.staffIds[0]! });
  // Terminal stages at the save tick: force an AMA (leaving) and a death
  // (dead) among entrance-overflow patients — releases nothing others need.
  const overflow = [...world.patients.values()].filter(
    (p) => p.stage.kind === 'atEntrance' && p.lost === null,
  );
  queue.push({ type: 'debugForce', patientId: overflow[0]!.id, outcome: 'ama' });
  queue.push({ type: 'debugForce', patientId: overflow[1]!.id, outcome: 'death' });
  world.applyCommands(queue);
  // A pending dispatcher retry hold (field poke — never poke stage directly).
  const held = [...world.patients.values()].find((p) => p.stage.kind === 'waitingTriage')!;
  held.dispatchHoldUntil = world.clock.tick + 500;
  // A pending need-break retry hold (v4 §3.5 pin — same poke pattern).
  held.needBreakHoldUntil = world.clock.tick + 500;
  // v6 (Stage 3, §S3.5 pins), same tick: break the RESTROOM — the piping
  // burst mints water messes + their clean jobs and a QUEUED repair job
  // (the tech is provably mid-repair — pipelineRich requires it) all
  // synchronously, without advancing a tick. In-flight stall claims survive
  // (occupants finish), so the v4 break pins above stay intact.
  const restroom = [...world.rooms.values()].find((r) => r.type === 'restroom')!;
  queue.push({ type: 'debugBreakRoom', roomId: restroom.id });
  world.applyCommands(queue);
  // An in-service room with nonzero wear (field poke — border-valid).
  const dialysisRoom = [...world.rooms.values()].find((r) => r.type === 'dialysis')!;
  dialysisRoom.wear = 3;

  // A queued job under a retry hold (v5 §S2.4 pin — the Stage-1 hold-pin
  // precedent: organic probe failures are rare in an open floor, so the
  // hold is poked at the save tick and must round-trip + be honored).
  const heldJob = [...world.jobs.values()].find((j) => j.phase === 'queued')!;
  heldJob.holdUntil = world.clock.tick + 500;

  assertRichPremises(world);
  return { world, events };
}

describe('save/load round-trip (THE acceptance gate, plan rule 4)', () => {
  it('save → load → run N ticks: identical event logs and identical final state', () => {
    const a = bootScenario(); // asserts every schema-corner premise at the save tick
    // reception, waiting, triage, exam, atrium, dialysis, restroom (v4),
    // xray + resp (v6 — the breakdown-rotation pair)
    expect(a.world.rooms.size).toBe(9);

    const json = saveToString(a.world);
    const loadedEvents = new EventBus();
    const silentDuringLoad = observeAll(loadedEvents, a.world);
    const loaded = loadWorld(loadedEvents, json);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Restore must be silent — no events, no hint replays (plan/spec rule).
    expect(silentDuringLoad).toEqual([]);

    const b = loaded.world;
    const logA = observeAll(a.world.events, a.world);
    const logB = observeAll(loadedEvents, b);
    // Run past the NEXT midnight regardless of how long enrichment took, so
    // dayEnded, payroll, and the wait-bonus path are inside the window.
    const ticksToRun = TICKS_PER_DAY - (a.world.clock.tick % TICKS_PER_DAY) + 200;
    for (let i = 0; i < ticksToRun; i++) {
      a.world.tick();
      b.tick();
    }
    expect(logB).toEqual(logA);
    expect(logA.length).toBeGreaterThan(0);
    expect(logA.some((line) => line.includes('|dayEnded|'))).toBe(true);
    expect(serializeWorld(b)).toEqual(serializeWorld(a.world));
    expect(a.world.stageViolations).toEqual([]);
    expect(b.stageViolations).toEqual([]);
  });

  it('save → load → save is byte-identical (stability)', () => {
    const a = bootScenario();
    const json = saveToString(a.world);
    const loaded = loadWorld(new EventBus(), json);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(saveToString(loaded.world)).toBe(json);
  });
});

/** A small but real save (memoized — deterministic) for tamper tests. */
let cachedSmallSave: string | null = null;
function smallSave(): string {
  if (cachedSmallSave === null) {
    const world = new World(new EventBus(), 7);
    setupNewGame(world);
    world.spawnPatient('flu');
    for (let i = 0; i < 50; i++) world.tick();
    cachedSmallSave = saveToString(world);
  }
  return cachedSmallSave;
}

function parsedSmallSave(): SaveData {
  return JSON.parse(smallSave()) as SaveData;
}

function loadOf(save: unknown): ReturnType<typeof loadWorld> {
  return loadWorld(new EventBus(), JSON.stringify(save));
}

describe('load border (audit #8: garbage dies here)', () => {
  it('refuses a NEWER save version with a reason naming both versions', () => {
    const newer = { ...parsedSmallSave(), saveVersion: SAVE_VERSION + 1 };
    const result = loadOf(newer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(String(SAVE_VERSION + 1));
    expect(result.reason).toContain(String(SAVE_VERSION));
    expect(result.reason.toLowerCase()).toContain('version');
  });

  it('refuses an unrecognized (below-v1/nonsense) version', () => {
    const zero = { ...parsedSmallSave(), saveVersion: 0 };
    expect(loadOf(zero).ok).toBe(false);
  });

  it('loads a version-1 save (v1→v2 ruling: Expansion 1 is purely additive content)', () => {
    // A v1 payload IS a v2 payload minus the new enum values: every v1
    // room/role/condition/prop id still exists in the v2 tables, so a
    // version-1-stamped save must validate against the current tables as-is.
    const v1 = { ...parsedSmallSave(), saveVersion: 1 };
    const result = loadOf(v1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A re-save stamps the CURRENT version — migration happens on load, once.
    const resaved = JSON.parse(saveToString(result.world)) as SaveData;
    expect(resaved.saveVersion).toBe(SAVE_VERSION);
  });

  it('a GENUINE v1 pool (no Expansion-1 candidates) is topped up on load (review MAJOR)', () => {
    // The earlier v1 fixture was a current-code save restamped v1 — its pool
    // already held the v2 roles. A REAL v1 save has only the six v1 roles;
    // without a restore-time top-up no code path ever mints a sonographer or
    // surgeon candidate, leaving the dispatcher hinting for an unhirable role.
    const save = parsedSmallSave();
    save.saveVersion = 1;
    // Every role minted AFTER v1 must be filtered out, or this fixture is not
    // a v1 save. Pre-impl review MAJOR 4 (ANESTHESIA_PLAN §7): the list and
    // the premise assert below must both be BY NAME. The old premise counted
    // `(ROLE_IDS.length - 2) * candidatesPerRole`, which stays arithmetically
    // true as the roster grows — so adding a role left the fixture holding
    // candidates a real v1 save could never have, green but no longer testing
    // the pre-role case at all. That is the guard for THIS test's own bug
    // (an unhirable surgeon the dispatcher kept hinting for), hollowed out.
    const POST_V1_ROLES = ['sonographer', 'surgeon', 'evs', 'maintenance', 'anesthesiologist'];
    save.candidates = save.candidates.filter((c) => !POST_V1_ROLES.includes(c.role));
    // Premise: the fixture genuinely lacks each of those roles, by name.
    for (const role of POST_V1_ROLES) {
      expect(save.candidates.some((c) => c.role === role), `v1 fixture must lack ${role}`).toBe(
        false,
      );
    }
    const result = loadOf(save);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const role of ROLE_IDS) {
      const count = result.world.candidates.filter((c) => c.role === role).length;
      expect(count, `${role} candidates after v1 migration`).toBe(
        BALANCE.hiring.candidatesPerRole,
      );
    }
    // Minted candidates got fresh unique ids above the restored counter.
    const ids = result.world.candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.max(...ids)).toBeGreaterThanOrEqual(save.nextEntityId);

    // Control: an UNMODIFIED v2 save's pool is untouched by the top-up —
    // byte-identical candidates, no rng consumed on their behalf.
    const v2 = loadWorld(new EventBus(), smallSave());
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(JSON.stringify(serializeWorld(v2.world).candidates)).toBe(
      JSON.stringify(parsedSmallSave().candidates),
    );
  });

  it('refuses one past SAVE_VERSION (the policy is 1..SAVE_VERSION, not >=1)', () => {
    // Version-relative (Stage A bumped to 3; a literal here broke on the bump).
    const future = { ...parsedSmallSave(), saveVersion: SAVE_VERSION + 1 };
    const result = loadOf(future);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.toLowerCase()).toContain('version');
  });

  it('refuses a finished-game save (gameOver) with a readable reason', () => {
    const finished = { ...parsedSmallSave(), gameOver: true };
    const result = loadOf(finished);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('finished game');
  });

  it('returns ok:false (never throws) for garbage strings', () => {
    const garbage = [
      '',
      'not json at all',
      '"just a string"',
      'null',
      '42',
      '[]',
      '{}',
      '{"saveVersion":1}',
      '{"saveVersion":"one"}',
      smallSave().slice(0, 200), // truncated mid-structure
    ];
    for (const raw of garbage) {
      const result = loadWorld(new EventBus(), raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('returns ok:false for structurally-tampered saves (wrong field types)', () => {
    const base = smallSave();
    const tampered: ((s: Record<string, unknown>) => void)[] = [
      (s) => {
        (s.patients as Record<string, unknown>[])[0]!.health = 'full';
      },
      (s) => {
        ((s.patients as Record<string, unknown>[])[0]!.stage as Record<string, unknown>).kind =
          'teleporting';
      },
      (s) => {
        s.grid = 'complete nonsense';
      },
      (s) => {
        s.grid = '5xw'; // far too few tiles
      },
      (s) => {
        s.checkInQueues = [[1]]; // not a [roomId, ids[]] pair
      },
      (s) => {
        s.rngState = 'stateful';
      },
      (s) => {
        (s.staff as Record<string, unknown>[])[0]!.role = 'janitor';
      },
      (s) => {
        (s.today as Record<string, unknown>).arrivals = null;
      },
    ];
    for (const tamper of tampered) {
      const save = JSON.parse(base) as Record<string, unknown>;
      tamper(save);
      expect(loadOf(save).ok).toBe(false);
    }
    // Control: the untampered base still loads.
    expect(loadWorld(new EventBus(), base).ok).toBe(true);
  });
});

describe('load border referential integrity (review MAJOR 1)', () => {
  it('rejects a reservation whose staffIds point at no staff (would brick tick())', () => {
    const save = parsedSmallSave();
    save.reservations.push({
      id: save.nextEntityId,
      kind: 'triage',
      patientId: save.patients[0]!.id,
      roomId: save.rooms[0]!.id,
      staffIds: [424242], // dangling
      stepIndex: 0,
      slotIndex: 0,
      phase: 'gathering',
      ticksRemaining: 33,
      patientWaitingSince: null,
    });
    save.nextEntityId += 1;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('staffIds');
  });

  it('rejects nextEntityId at or below an existing id (takeId would reissue live ids)', () => {
    const save = parsedSmallSave();
    save.nextEntityId = 1;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('nextEntityId');
  });

  it('rejects a patient stage referencing a missing reservation', () => {
    const save = parsedSmallSave();
    save.patients[0]!.stage = { kind: 'reserved', reservationId: 31337 };
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('reservationId');
  });

  it('rejects duplicate entity ids across pools', () => {
    const save = parsedSmallSave();
    save.candidates[0]!.id = save.rooms[0]!.id;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('twice');
  });

  it('rejects a check-in queue referencing a missing patient', () => {
    const save = parsedSmallSave();
    expect(save.checkInQueues.length).toBeGreaterThan(0); // premise
    save.checkInQueues[0]![1].push(987654);
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('patient');
  });

  it('rejects a patient occupying two queue positions', () => {
    const save = parsedSmallSave();
    const pid = save.patients[0]!.id;
    save.checkInQueues = [[save.rooms[0]!.id, [pid, pid]]];
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('at most one queue position');
  });

  it('rejects a room rect outside the map bounds', () => {
    const save = parsedSmallSave();
    save.rooms[0]!.rect.col = 39; // 2-wide room → cols 39..40 exceed a 40-col map
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('map');
  });

  it('rejects grid tiles referencing a nonexistent room (incl. huge RLE roomIds)', () => {
    for (const bogus of ['1xwr31337,1599xw', '1xwr99999999999999999999,1599xw']) {
      const save = parsedSmallSave();
      save.grid = bogus; // 1 + 1599 = 1600 tiles = the full 40×40 map
      const result = loadOf(save);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('grid');
    }
  });
});

// ------------------------------------------------- v4 (amenities Stage 1)

/** A REAL v6 payload: the current shape minus everything v7 added (the room
 *  income counters, the amenity's revenueTotal, and the world's lifetime /
 *  lifetimeTreatedBase / history). v7 added NO role, so the candidate pool is
 *  untouched — this is the first bump whose migration tops up nothing. */
/**
 * Premise check for every backward fixture (review MAJOR 4): assert the roles
 * a fixture is supposed to LACK, by name. The old form multiplied
 * `ROLE_IDS.length - N` by candidatesPerRole, which stays arithmetically true
 * as the roster grows — so each new role silently left these fixtures holding
 * candidates the version under test could never have had, green while no
 * longer testing the migration at all.
 */
function expectPoolLacks(fixture: Record<string, unknown>, roles: string[]): void {
  const pool = fixture.candidates as { role: string }[];
  for (const role of roles) {
    expect(pool.some((c) => c.role === role), `fixture must lack ${role}`).toBe(false);
  }
  // …and genuinely holds the roles it SHOULD, so the filter can't pass by
  // emptying the pool entirely.
  expect(pool.some((c) => c.role === 'nurse')).toBe(true);
}

function v6Fixture(): Record<string, unknown> {
  const save = JSON.parse(smallSave()) as Record<string, unknown>;
  save.saveVersion = 6;
  for (const r of save.rooms as Record<string, unknown>[]) {
    delete r.revenueToday;
    delete r.revenueTotal;
    delete r.visitsTotal;
  }
  for (const a of save.amenities as Record<string, unknown>[]) {
    delete a.revenueTotal;
    delete a.revenueToday; // v8
  }
  delete save.lifetime;
  delete save.lifetimeTreatedBase;
  delete save.history;
  // The anesthesiologist role arrived at v9, so a real v6 pool cannot hold
  // its candidates (review MAJOR 4).
  save.candidates = (save.candidates as { role: string }[]).filter(
    (c) => c.role !== 'anesthesiologist',
  );
  return save;
}

/** A REAL v5 payload: the v6 fixture minus everything v6 added (room
 *  wear/brokenSince, job roomId, and the maintenance candidate pool). */
function v5Fixture(): Record<string, unknown> {
  const save = v6Fixture();
  save.saveVersion = 5;
  for (const r of save.rooms as Record<string, unknown>[]) {
    delete r.wear;
    delete r.brokenSince;
  }
  for (const j of save.jobs as Record<string, unknown>[]) delete j.roomId;
  // Roles minted at v6 or later cannot exist in a v5 pool (review MAJOR 4 —
  // by name, never by a count derived from ROLE_IDS.length).
  save.candidates = (save.candidates as { role: string }[]).filter(
    (c) => !['maintenance', 'anesthesiologist'].includes(c.role),
  );
  return save;
}

/** A REAL v4 payload: the v5 fixture minus everything v5 added (messes,
 *  jobs, the messTicks tally key, and the evs candidate pool). */
function v4Fixture(): Record<string, unknown> {
  const save = v5Fixture();
  save.saveVersion = 4;
  delete save.messes;
  delete save.jobs;
  delete (save.today as Record<string, unknown>).messTicks;
  // Roles minted at v5 or later cannot exist in a v4 pool (review MAJOR 4 —
  // filter BY NAME so a future role addition cannot leave this fixture
  // silently holding candidates a real v4 save never had).
  save.candidates = (save.candidates as { role: string }[]).filter(
    (c) => !['evs', 'maintenance', 'anesthesiologist'].includes(c.role),
  );
  return save;
}

/** A REAL v3 payload: the v4 fixture minus everything v4 added. */
function v3Fixture(): Record<string, unknown> {
  const save = v4Fixture();
  save.saveVersion = 3;
  delete save.amenities;
  delete (save.today as Record<string, unknown>).vendingRevenue;
  for (const p of save.patients as Record<string, unknown>[]) {
    delete p.bladder;
    delete p.thirst;
    delete p.needBreak;
    delete p.needBreakHoldUntil;
  }
  return save;
}

/** A small save carrying a restroom + vending machine (for claim tampering). */
let cachedAmenitySave: string | null = null;
function amenitySave(): string {
  if (cachedAmenitySave === null) {
    const world = new World(new EventBus(), 9);
    setupNewGame(world);
    world.buildRoom('restroom', { col: 5, row: 20, cols: 2, rows: 3 }, { col: 7, row: 21 });
    world.placeAmenity('vending', { col: 10, row: 20 });
    world.spawnPatient('flu');
    world.spawnPatient('flu');
    for (let i = 0; i < 50; i++) world.tick();
    cachedAmenitySave = saveToString(world);
  }
  return cachedAmenitySave;
}

function parsedAmenitySave(): SaveData {
  return JSON.parse(amenitySave()) as SaveData;
}

/** A shape-valid restroom stall claim to graft onto a patient (tamper base). */
function stallClaim(roomId: number, slot: number): Record<string, unknown> {
  return { kind: 'restroom', roomId, slot, phase: 'walking', ticksRemaining: 0, startedAt: 0 };
}

describe('v3 → v4 migration (amenities Stage 1, review MAJOR 3)', () => {
  it('a genuine v3 fixture loads: tally + meter + break defaults applied', () => {
    // The tally default is THE MAJOR-3 regression: readTally throws on any
    // missing key, so an unversioned reader would refuse every pre-v4 save.
    const result = loadOf(v3Fixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.world.today.vendingRevenue).toBe(0);
    expect(result.world.amenities.size).toBe(0);
    expect(result.world.patients.size).toBeGreaterThan(0); // premise
    for (const p of result.world.patients.values()) {
      expect(p.bladder).toBe(BALANCE.stats.vitalsMax);
      expect(p.thirst).toBe(BALANCE.stats.vitalsMax);
      expect(p.needBreak).toBeNull();
      expect(p.needBreakHoldUntil).toBe(0);
    }
    // A re-save stamps v4 with the new surface present.
    const resaved = JSON.parse(saveToString(result.world)) as SaveData;
    expect(resaved.saveVersion).toBe(SAVE_VERSION);
    expect(resaved.amenities).toEqual([]);
    expect(resaved.today.vendingRevenue).toBe(0);
  });

  it('a current-version save with amenities round-trips byte-identically', () => {
    // Stage-2/3 note (§S2.6b precedent): this fixture is minted by CURRENT
    // code, so it is a current-version save — same-version byte identity
    // holds because topUpCandidates is a strict no-op on a complete pool.
    // The former per-version byte-identity roles live on as the v4/v5
    // fixture-LOAD tests (top-up mints the newer roles' candidates on old
    // loads, deliberately diverging the migrated world).
    const loaded = loadWorld(new EventBus(), amenitySave());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.world.amenities.size).toBe(1); // premise: the machine landed
    expect(saveToString(loaded.world)).toBe(amenitySave());
  });
});

describe('v11 → v12 migration (ECONOMY Stage-1: utilities/repairs tally keys)', () => {
  it('a v11 payload (no utilities/repairs keys) loads with them defaulted to 0 — today, lifetime, AND history', () => {
    const world = new World(new EventBus(), 7);
    setupNewGame(world);
    // Run past midnight so a closed-day HISTORY entry exists (its tally travels
    // the readHistory→readDayReport→readTally path too — review finding 4).
    for (let i = 0; i < TICKS_PER_DAY + TICKS_PER_GAME_HOUR; i++) world.tick();
    const save = JSON.parse(saveToString(world)) as Record<string, unknown>;
    const history = save.history as Record<string, number>[];
    expect(history.length).toBeGreaterThan(0); // premise: a closed day
    expect((save.today as Record<string, number>).utilities).toBeGreaterThan(0);

    // Downgrade to a v11 shape: strip the v12-only keys from every tally bucket.
    save.saveVersion = 11;
    for (const bucket of ['today', 'lifetime'] as const) {
      delete (save[bucket] as Record<string, unknown>).utilities;
      delete (save[bucket] as Record<string, unknown>).repairs;
    }
    for (const day of history) {
      delete (day as Record<string, unknown>).utilities;
      delete (day as Record<string, unknown>).repairs;
    }

    // Without TALLY_KEY_VERSIONS {utilities:12, repairs:12} this THROWS
    // (asNumber(undefined)); with it, they default to 0 (the MAJOR regression).
    const result = loadOf(save);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.world.today.utilities).toBe(0);
    expect(result.world.today.repairs).toBe(0);
    expect(result.world.lifetime.utilities).toBe(0);
    expect(result.world.lifetime.repairs).toBe(0);
    expect(result.world.history.length).toBeGreaterThan(0);
    for (const day of result.world.history) {
      expect(day.utilities).toBe(0);
      expect(day.repairs).toBe(0);
    }
    // SHIFTS Stage-1 (v13): a pre-v13 save MINTS A NIGHT ROSTER on load (see the
    // dedicated migration test below) — the read-time null default is transformed
    // to day originals + night twins, so a loaded save keeps 24/7 coverage.
    const loadedShifts = [...result.world.staff.values()].map((s) => s.shift);
    expect(loadedShifts).toContain('day');
    expect(loadedShifts).toContain('night');
    for (const s of result.world.staff.values()) expect(s.onFloor).toBe(true);
  });
});

describe('v12 → v13 migration (SHIFTS Stage-1: mint a night roster)', () => {
  /** Build a world, save it, and re-stamp it to look like a pre-shift v12 save. */
  function v12Save(seed = 5): Record<string, unknown> {
    const world = new World(new EventBus(), seed);
    setupNewGame(world);
    world.addStaffMember('nurse', 3, 200);
    world.addStaffMember('doctor', 4, 300);
    // A v12 world is all always-on (null shift) — readStaff ignores the shift
    // field for saveVersion < 13, so re-stamping the version is enough.
    for (const s of world.staff.values()) s.shift = null;
    const save = JSON.parse(saveToString(world)) as Record<string, unknown>;
    save.saveVersion = 12;
    return save;
  }

  it('mints a night twin per staffer: day originals + night twins, all on-floor', () => {
    const save = v12Save();
    const baseCount = (save.staff as unknown[]).length;
    const basePayroll = (save.staff as { salaryPerDay: number }[]).reduce(
      (a, s) => a + s.salaryPerDay,
      0,
    );

    const result = loadOf(save);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const staff = [...result.world.staff.values()];
    expect(staff.length).toBe(baseCount * 2); // roster doubled
    const day = staff.filter((s) => s.shift === 'day');
    const night = staff.filter((s) => s.shift === 'night');
    expect(day.length).toBe(baseCount);
    expect(night.length).toBe(baseCount);
    for (const s of staff) expect(s.onFloor).toBe(true);
    // Each night twin mirrors a day staffer's role (coverage preserved per role).
    for (const role of new Set(day.map((s) => s.role))) {
      expect(night.filter((s) => s.role === role).length).toBe(
        day.filter((s) => s.role === role).length,
      );
    }
    // Charged payroll rises to ~1.2× baseline: two shifts × the 0.6 wage.
    const charged = staff.reduce((a, s) => a + s.salaryPerDay * shiftWageMultiplier(s.shift), 0);
    expect(charged).toBeCloseTo(1.2 * basePayroll, 6);
  });

  it('surfaces a one-time load notice about the night crew', () => {
    const result = loadOf(v12Save());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notice).toBeDefined();
    expect(result.notice).toMatch(/night crew|day-only/i);
  });

  it('is deterministic across two loads (ids, roles, shifts identical)', () => {
    const save = v12Save();
    const a = loadOf(save);
    const b = loadOf(save);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const key = (w: World) =>
      [...w.staff.values()]
        .map((s) => `${s.id}:${s.role}:${s.shift}:${s.name.full}`)
        .sort()
        .join('|');
    expect(key(a.world)).toBe(key(b.world));
  });

  it('a current v13 save does NOT mint twins (round-trips its roster unchanged)', () => {
    const world = new World(new EventBus(), 5);
    setupNewGame(world);
    world.addStaffMember('nurse', 3, 200).shift = 'night';
    const before = world.staff.size;
    const result = loadOf(JSON.parse(saveToString(world)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.world.staff.size).toBe(before); // no migration at v13
    expect(result.notice).toBeUndefined();
  });
});

describe('v4 → v5 migration (amenities Stage 2, §S2.4)', () => {
  it('a genuine v4 fixture LOADS: empty mess/job maps, messTicks 0, evs pool topped up', () => {
    // The former v4 byte-identity test converts to this fixture-LOAD test
    // (§S2.6b): topUpCandidates mints evs candidates on every v≤4 load, so
    // a v4 save can no longer round-trip byte-identically BY DESIGN.
    const fixture = v4Fixture();
    expectPoolLacks(fixture, ['evs', 'maintenance', 'anesthesiologist']);
    const result = loadOf(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.world.messes.size).toBe(0);
    expect(result.world.jobs.size).toBe(0);
    expect(result.world.today.messTicks).toBe(0);
    const evs = result.world.candidates.filter((c) => c.role === 'evs');
    expect(evs.length, 'evs candidates topped up on load (v1→v2 precedent)').toBe(
      BALANCE.hiring.candidatesPerRole,
    );
    // A re-save stamps v5 with the new surface present.
    const resaved = JSON.parse(saveToString(result.world)) as SaveData;
    expect(resaved.saveVersion).toBe(SAVE_VERSION);
    expect(resaved.messes).toEqual([]);
    expect(resaved.jobs).toEqual([]);
    expect(resaved.today.messTicks).toBe(0);
  });

  it('a genuine v3 fixture still loads through the v5 reader (transitive migration)', () => {
    const result = loadOf(v3Fixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.world.messes.size).toBe(0);
    expect(result.world.jobs.size).toBe(0);
    expect(result.world.today.messTicks).toBe(0);
  });
});

describe('v5 → v6 migration (amenities Stage 3, §S3.5)', () => {
  it('a genuine v5 fixture LOADS: wear 0 / in service, job roomId null, maintenance pool topped up', () => {
    const fixture = v5Fixture();
    expectPoolLacks(fixture, ['maintenance', 'anesthesiologist']);
    const result = loadOf(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.world.rooms.size).toBeGreaterThan(0); // premise
    for (const room of result.world.rooms.values()) {
      expect(room.wear).toBe(0);
      expect(room.brokenSince).toBeNull();
    }
    // (Job roomId defaulting is covered by the messSave-downgrade test below —
    // this fixture serializes no jobs, so a loop here would be vacuous.)
    const techs = result.world.candidates.filter((c) => c.role === 'maintenance');
    expect(techs.length, 'maintenance candidates topped up on load (the evs precedent)').toBe(
      BALANCE.hiring.candidatesPerRole,
    );
    // A re-save stamps v6 with the new surface present.
    const resaved = JSON.parse(saveToString(result.world)) as SaveData;
    expect(resaved.saveVersion).toBe(SAVE_VERSION);
    expect(resaved.rooms.every((r) => r.wear === 0 && r.brokenSince === null)).toBe(true);
  });

  it('a genuine v3 fixture still loads through the v6 reader (transitive migration)', () => {
    const result = loadOf(v3Fixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const room of result.world.rooms.values()) {
      expect(room.wear).toBe(0);
      expect(room.brokenSince).toBeNull();
    }
  });

  it('a v5 payload WITH a job restores roomId null (the messSave downgrade)', () => {
    const save = parsedMessSave() as unknown as Record<string, unknown>;
    save.saveVersion = 5;
    for (const j of save.jobs as Record<string, unknown>[]) delete j.roomId;
    const result = loadOf(save);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.world.jobs.size).toBeGreaterThan(0); // premise — non-vacuous
    for (const job of result.world.jobs.values()) expect(job.roomId).toBeNull();
  });
});

/** A small save carrying a trashcan, an EVS worker, and a live mess with its
 *  auto-minted queued clean job (the v5 border tamper base). */
let cachedMessSave: string | null = null;
function messSave(): string {
  if (cachedMessSave === null) {
    const world = new World(new EventBus(), 13);
    setupNewGame(world);
    world.placeAmenity('trashcan', { col: 10, row: 20 });
    world.addStaffMember('evs', 3, 90);
    world.addMess('vomit', { col: 12, row: 20 });
    cachedMessSave = saveToString(world);
  }
  return cachedMessSave;
}

function parsedMessSave(): SaveData {
  return JSON.parse(messSave()) as SaveData;
}

describe('load border: messes & jobs (v5, §S2.4)', () => {
  it('accepts the control fixture (a mess + its queued clean job + an EVS)', () => {
    const save = parsedMessSave();
    expect(save.messes.length).toBe(1); // premise
    expect(save.jobs.length).toBe(1);
    expect(save.jobs[0]!.kind).toBe('clean');
    expect(loadOf(save).ok).toBe(true);
  });

  it("accepts a 'water' mess (reserved Stage-3 kind — a clean job cleans any mess)", () => {
    const save = parsedMessSave();
    save.messes[0]!.kind = 'water';
    expect(loadOf(save).ok).toBe(true);
  });

  it("rejects a 'repair' job in a v5 PAYLOAD (version-aware — the v5 union value had no legal target)", () => {
    const save = parsedMessSave() as unknown as Record<string, unknown>;
    save.saveVersion = 5; // downgrade: v5 readers ignore the v6-only keys
    (save.jobs as { kind: string }[])[0]!.kind = 'repair';
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('repair');
  });

  it('rejects a mess outside the map / two messes on one tile', () => {
    const outside = parsedMessSave();
    outside.messes[0]!.tile = { col: 99, row: 99 };
    expect(loadOf(outside).ok).toBe(false);
    const doubled = parsedMessSave();
    doubled.messes.push({ ...doubled.messes[0]! });
    const result = loadOf(doubled);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('one mess per tile');
  });

  it("rejects a clean job with no mess on its tile (both-ways, and vice versa)", () => {
    const jobless = parsedMessSave();
    jobless.jobs = []; // the mess remains — an uncleanable permanent rep leak
    const r1 = loadOf(jobless);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toContain('job targeting the mess tile');
    const messless = parsedMessSave();
    messless.messes = []; // the clean job remains — no target
    const r2 = loadOf(messless);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain("clean job's tile");
  });

  it("rejects an empty job whose tile carries no trashcan", () => {
    const save = parsedMessSave();
    // Retarget the clean job's tile as an empty job on the mess tile (no can).
    save.jobs[0]!.kind = 'empty';
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("empty job's tile");
  });

  it('rejects two jobs targeting one tile', () => {
    const save = parsedMessSave();
    save.jobs.push({ ...save.jobs[0]!, id: save.nextEntityId });
    save.nextEntityId += 1;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('one job per tile');
  });

  it('rejects phase/staffId inconsistency (queued ⇔ staffId null)', () => {
    const evsId = (): number => parsedMessSave().staff.find((s) => s.role === 'evs')!.id;
    const queuedWithStaff = parsedMessSave();
    queuedWithStaff.jobs[0]!.staffId = evsId();
    expect(loadOf(queuedWithStaff).ok).toBe(false);
    const assignedWithoutStaff = parsedMessSave();
    assignedWithoutStaff.jobs[0]!.phase = 'assigned';
    expect(loadOf(assignedWithoutStaff).ok).toBe(false);
  });

  it('accepts a consistent assigned job; rejects a broken back-reference or a non-EVS worker', () => {
    const assignTo = (save: SaveData, staffId: number): void => {
      save.jobs[0]!.phase = 'assigned';
      save.jobs[0]!.staffId = staffId;
      const member = save.staff.find((s) => s.id === staffId)!;
      member.duty = { kind: 'job', jobId: save.jobs[0]!.id };
    };
    const good = parsedMessSave();
    assignTo(good, good.staff.find((s) => s.role === 'evs')!.id);
    expect(loadOf(good).ok).toBe(true);
    // Worker's duty doesn't point back at the job.
    const noBackRef = parsedMessSave();
    noBackRef.jobs[0]!.phase = 'assigned';
    noBackRef.jobs[0]!.staffId = noBackRef.staff.find((s) => s.role === 'evs')!.id;
    const r1 = loadOf(noBackRef);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toContain('back-reference');
    // A receptionist can't work the job queue.
    const wrongRole = parsedMessSave();
    assignTo(wrongRole, wrongRole.staff.find((s) => s.role === 'receptionist')!.id);
    const r2 = loadOf(wrongRole);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain('EVS');
  });

  it("rejects a duty jobId that resolves to no job", () => {
    const save = parsedMessSave();
    const evs = save.staff.find((s) => s.role === 'evs')!;
    evs.duty = { kind: 'job', jobId: 31337 };
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('jobId');
  });

  it('rejects a job timer beyond the longest duration at the slowest skill', () => {
    const save = parsedMessSave();
    const evs = save.staff.find((s) => s.role === 'evs')!;
    save.jobs[0]!.phase = 'working';
    save.jobs[0]!.staffId = evs.id;
    evs.duty = { kind: 'job', jobId: save.jobs[0]!.id };
    // A working worker must stand at/beside the target (adversarial-review
    // border rule) — keep the fixture self-consistent so the TIMER check is
    // what trips below.
    evs.at = { ...save.jobs[0]!.tile };
    evs.next = null;
    evs.path = [];
    evs.target = null;
    save.jobs[0]!.ticksRemaining = treatmentDurationTicks(
      Math.max(BALANCE.mess.cleanGameMinutes, BALANCE.mess.emptyGameMinutes),
      BALANCE.stats.min,
      0,
    );
    expect(loadOf(save).ok).toBe(true); // the exact bound is legal
    save.jobs[0]!.ticksRemaining += 1;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('ticksRemaining');
  });

  it('rejects a job id colliding with another entity id (global uniqueness)', () => {
    const save = parsedMessSave();
    save.jobs[0]!.id = save.rooms[0]!.id;
    // Keep the world otherwise consistent — the register should still trip.
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('twice');
  });
});

/** A save carrying a broken X-Ray with its queued repair job + an idle tech
 *  (the v6 border tamper base). Built via the REAL breakdown path. */
let cachedBrokenSave: string | null = null;
function brokenSave(): string {
  if (cachedBrokenSave === null) {
    const world = new World(new EventBus(), 21);
    setupNewGame(world);
    world.buildRoom('xray', { col: 10, row: 10, cols: 3, rows: 4 }, { col: 11, row: 14 }, true);
    world.addStaffMember('maintenance', 3, 140);
    world.breakRoom(world.roomsOfType('xray')[0]!);
    cachedBrokenSave = saveToString(world);
  }
  return cachedBrokenSave;
}

function parsedBrokenSave(): SaveData {
  return JSON.parse(brokenSave()) as SaveData;
}

describe('load border: failures & repair (v6, §S3.5)', () => {
  const brokenRoom = (save: SaveData): SaveData['rooms'][number] =>
    save.rooms.find((r) => r.brokenSince !== null)!;
  const repairJob = (save: SaveData): SaveData['jobs'][number] =>
    save.jobs.find((j) => j.kind === 'repair')!;

  it('accepts the control fixture (a broken room + its queued repair job)', () => {
    const save = parsedBrokenSave();
    expect(brokenRoom(save)).toBeDefined(); // premise
    expect(repairJob(save)).toBeDefined();
    expect(repairJob(save).roomId).toBe(brokenRoom(save).id);
    expect(loadOf(save).ok).toBe(true);
  });

  it('rejects a repair job with no roomId', () => {
    const save = parsedBrokenSave();
    repairJob(save).roomId = null;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('repair');
  });

  it('rejects a repair job targeting an IN-SERVICE room', () => {
    const save = parsedBrokenSave();
    brokenRoom(save).brokenSince = null;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('BROKEN');
  });

  it('rejects a broken room with NO repair job (nothing would ever fix it)', () => {
    const save = parsedBrokenSave();
    save.jobs = [];
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('repair job for broken room');
  });

  it('rejects TWO repair jobs for one room', () => {
    const save = parsedBrokenSave();
    const dup = { ...repairJob(save), id: save.nextEntityId, tile: { col: 10, row: 12 } };
    save.jobs.push(dup);
    save.nextEntityId += 1;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('one repair job per room');
  });

  it('rejects a repair anchor outside the room footprint', () => {
    const save = parsedBrokenSave();
    repairJob(save).tile = { col: 30, row: 30 };
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('footprint');
  });

  it('rejects nonzero wear on a broken room (applyRoomUse no-ops while broken)', () => {
    const save = parsedBrokenSave();
    brokenRoom(save).wear = 2;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('0 while broken');
  });

  it('rejects a brokenSince beyond the played timeline, and a negative one', () => {
    const future = parsedBrokenSave();
    brokenRoom(future).brokenSince = future.tick + 100;
    expect(loadOf(future).ok).toBe(false);
    const negative = parsedBrokenSave();
    brokenRoom(negative).brokenSince = -1;
    expect(loadOf(negative).ok).toBe(false);
  });

  it('rejects a broken flag on a room type that never breaks', () => {
    const save = parsedBrokenSave();
    const reception = save.rooms.find((r) => r.type === 'reception')!;
    reception.brokenSince = 0;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('never breaks');
  });

  it('rejects negative wear (readRoom bound)', () => {
    const save = parsedBrokenSave();
    save.rooms.find((r) => r.brokenSince === null)!.wear = -1;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('non-negative use count');
  });

  it('rejects a clean job carrying a roomId', () => {
    const save = parsedMessSave();
    save.jobs[0]!.roomId = save.rooms[0]!.id;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("'clean' job");
  });

  it('bounds a repair timer KIND-AWARELY (pre-impl MINOR 6 — clean stays tight)', () => {
    const save = parsedBrokenSave();
    const tech = save.staff.find((s) => s.role === 'maintenance')!;
    const job = repairJob(save);
    job.phase = 'working';
    job.staffId = tech.id;
    tech.duty = { kind: 'job', jobId: job.id };
    // A working worker stands at/beside the anchor, INSIDE the room.
    tech.at = { col: job.tile.col, row: job.tile.row + 1 };
    tech.next = null;
    tech.path = [];
    tech.target = null;
    const repairBound = treatmentDurationTicks(
      BALANCE.maintenance.repairGameMinutes,
      BALANCE.stats.min,
      0,
    );
    job.ticksRemaining = repairBound;
    expect(loadOf(save).ok).toBe(true); // the exact repair bound is legal…
    job.ticksRemaining = repairBound + 1;
    expect(loadOf(save).ok).toBe(false); // …and one past it is not
    // The clean/empty bound did NOT widen to the repair bound:
    const cleanSave = parsedMessSave();
    cleanSave.jobs[0]!.ticksRemaining = repairBound;
    expect(loadOf(cleanSave).ok).toBe(false);
  });

  it('the reservation slot bound stays GRID-derived and broken-blind (§5.2: actives finish)', () => {
    // An ACTIVE reservation holding slot 1 of a BROKEN dialysis room is a
    // legal world — a capacityOf-aware bound (0 while broken) would refuse
    // the game's own save while a treatment finishes.
    const world = new World(new EventBus(), 23);
    setupNewGame(world);
    world.buildRoom('dialysis', { col: 10, row: 10, cols: 3, rows: 4 }, { col: 11, row: 14 }, true);
    const dialysis = world.roomsOfType('dialysis')[0]!;
    const nurse = world.addStaffMember('nurse', 3, 150);
    const patient = world.spawnPatient('kidneyFailure');
    patient.acuity = 3;
    const reservation = {
      id: world.takeId(),
      kind: 'treatment' as const,
      patientId: patient.id,
      roomId: dialysis.id,
      staffIds: [nurse.id],
      stepIndex: 0,
      slotIndex: 1, // the CONCURRENT slot — grid capacity 2, capacityOf 0
      phase: 'active' as const,
      ticksRemaining: 50,
      patientWaitingSince: null,
    };
    world.reservations.set(reservation.id, reservation);
    patient.stage = { kind: 'reserved', reservationId: reservation.id };
    nurse.duty = { kind: 'reserved', reservationId: reservation.id };
    world.breakRoom(dialysis); // actives survive; the repair job mints
    expect(world.reservations.size).toBe(1); // premise
    const result = loadWorld(new EventBus(), saveToString(world));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.world.reservations.size).toBe(1);
    expect(result.world.roomsOfType('dialysis')[0]!.brokenSince).not.toBeNull();
  });
});

// ------------------------------------------------- v7 (finances, §9.7)

/** A save carrying live v7 surface: a room with income + visits, a vending
 *  machine with takings, two closed days of history and a nonzero lifetime.
 *  Built by poking the counters (they are plain running sums), which keeps the
 *  fixture cheap and its border shape exact. */
let cachedFinanceSave: string | null = null;
function financeSave(): string {
  if (cachedFinanceSave === null) {
    const world = new World(new EventBus(), 37);
    setupNewGame(world);
    world.buildRoom('exam', { col: 14, row: 27, cols: 3, rows: 3 }, { col: 17, row: 28 }, true);
    world.placeAmenity('vending', { col: 25, row: 36 });
    // Two closed days through the REAL closeDay path (history, trim, resets).
    // SHIFTS Stage-1: the day-shifted setup receptionist stalls check-in at night,
    // so patients pile up in checkInQueues; clear those alongside patients (the
    // blunt test-only clear doesn't unwind queue refs the way a real despawn does).
    for (let d = 0; d < 2; d++) {
      for (let i = TICKS_PER_DAY - (world.clock.tick % TICKS_PER_DAY); i > 0; i--) world.tick();
      world.patients.clear();
      world.checkInQueues.clear();
    }
    const exam = world.roomsOfType('exam')[0]!;
    exam.revenueToday = 150;
    exam.revenueTotal = 900;
    exam.visitsTotal = 5;
    world.amenityAt(25, 36)!.revenueTotal = 15;
    world.tallyCash('revenue', 915);
    cachedFinanceSave = saveToString(world);
  }
  return cachedFinanceSave;
}

function parsedFinanceSave(): SaveData {
  return JSON.parse(financeSave()) as SaveData;
}

describe('v6 → v7 migration (finances, FINANCE_PLAN §9.7)', () => {
  it('a genuine v6 fixture LOADS: counters 0, lifetime zeros, history empty, watermark set', () => {
    const fixture = v6Fixture();
    // Premise: the fixture genuinely lacks the v7 surface…
    expect(fixture.lifetime).toBeUndefined();
    expect(fixture.history).toBeUndefined();
    // …and carries pre-upgrade discharges, so the watermark is not vacuously 0
    // (re-review MAJOR N2 — the whole point of the field).
    const imported = 400;
    fixture.lifetimeTreated = imported;
    // A v6 pool predates the anesthesiologist (v9), so topUpCandidates must
    // mint it on load — asserted by name below rather than by a count.
    expectPoolLacks(fixture, ['anesthesiologist']);

    const result = loadOf(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const w = result.world;
    expect(w.rooms.size).toBeGreaterThan(0); // premise
    for (const room of w.rooms.values()) {
      expect(room.revenueToday).toBe(0);
      expect(room.revenueTotal).toBe(0);
      expect(room.visitsTotal).toBe(0);
    }
    for (const a of w.amenities.values()) {
      expect(a.revenueTotal).toBe(0);
      expect(a.revenueToday).toBe(0); // v8
    }
    expect(w.lifetime).toEqual(emptyCashTotals());
    expect(w.history).toEqual([]);
    // THE N2 assertion: the watermark IS the restored discharge count, so the
    // average-bill row counts post-upgrade discharges only.
    expect(w.lifetimeTreatedBase).toBe(imported);
    expect(w.lifetimeTreated).toBe(imported);
    expect(averageBillPerPatient(w.lifetime, w.lifetimeTreated, w.lifetimeTreatedBase)).toBeNull();

    // A re-save stamps v7 with the new surface present.
    const resaved = JSON.parse(saveToString(w)) as SaveData;
    expect(resaved.saveVersion).toBe(SAVE_VERSION);
    expect(resaved.lifetime).toEqual(emptyCashTotals());
    expect(resaved.lifetimeTreatedBase).toBe(imported);
    expect(resaved.history).toEqual([]);
    expect(resaved.rooms.every((r) => r.revenueTotal === 0 && r.visitsTotal === 0)).toBe(true);
  });

  // ANESTHESIA_PLAN §7/§8.10. Its own test because hiring charges the hire
  // fee, which would perturb the lifetime-counter assertions above.
  it('tops a pre-role save up so the anesthesiologist is actually HIREABLE', () => {
    const fixture = v6Fixture();
    expectPoolLacks(fixture, ['anesthesiologist']);
    const result = loadOf(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const w = result.world;

    const offered = w.candidates.filter((c) => c.role === 'anesthesiologist');
    expect(offered.length).toBe(BALANCE.hiring.candidatesPerRole);
    // Through the CommandQueue — the public mutation API — so this proves the
    // real player path, not merely that a pool entry exists. The v1→v2
    // surgeon bug was exactly a role the dispatcher hinted for and no pool
    // could offer.
    const queue = new CommandQueue();
    queue.push({ type: 'hireStaff', candidateId: offered[0]!.id, shift: 'day' });
    w.applyCommands(queue);
    expect([...w.staff.values()].some((st) => st.role === 'anesthesiologist')).toBe(true);
  });

  it('a genuine v3 fixture still loads through the v7 reader (transitive migration)', () => {
    const result = loadOf(v3Fixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.world.lifetime).toEqual(emptyCashTotals());
    expect(result.world.history).toEqual([]);
    for (const room of result.world.rooms.values()) expect(room.revenueTotal).toBe(0);
  });

  it('a v7 save with live income, history and lifetime round-trips byte-identically', () => {
    const save = parsedFinanceSave();
    // Premises: every §9.7 round-trip pin is genuinely present.
    const exam = save.rooms.find((r) => r.type === 'exam')!;
    expect(exam.revenueToday).toBeGreaterThan(0);
    expect(exam.revenueTotal).toBeGreaterThan(exam.revenueToday);
    expect(exam.visitsTotal).toBeGreaterThan(0);
    expect(save.amenities[0]!.revenueTotal).toBeGreaterThan(0);
    expect(save.history.length).toBeGreaterThanOrEqual(2);
    expect(save.history.length).toBeLessThanOrEqual(BALANCE.finance.historyCapDays);
    expect(save.lifetime.revenue).toBeGreaterThan(0);

    const loaded = loadWorld(new EventBus(), financeSave());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.world.history).toHaveLength(save.history.length);
    expect(loaded.world.lifetime.revenue).toBe(save.lifetime.revenue);
    expect(loaded.world.roomsOfType('exam')[0]!.visitsTotal).toBe(exam.visitsTotal);
    expect(saveToString(loaded.world)).toBe(financeSave());
  });

  it('writeDayReport delegates to writeTally: every tally key rides along', () => {
    const save = parsedFinanceSave();
    const entry = save.history[0]! as unknown as Record<string, unknown>;
    for (const key of Object.keys(emptyDayTally())) {
      expect(entry[key], `history entry carries ${key}`).toBeTypeOf('number');
    }
    for (const key of ['day', 'cash', 'reputation', 'waitBonusAwarded']) {
      expect(entry, `history entry carries ${key}`).toHaveProperty(key);
    }
  });
});

describe('load border: finances (v7, §9.7)', () => {
  it('accepts the control fixture', () => {
    expect(loadOf(parsedFinanceSave()).ok).toBe(true);
  });

  it('rejects negative room income counters and a negative visit count', () => {
    for (const key of ['revenueToday', 'revenueTotal', 'visitsTotal'] as const) {
      const save = parsedFinanceSave();
      save.rooms.find((r) => r.type === 'exam')![key] = -1;
      const result = loadOf(save);
      expect(result.ok, key).toBe(false);
      if (!result.ok) expect(result.reason).toContain(key);
    }
  });

  // Review MINOR: the pair is checkable, so the border checks it — the same
  // philosophy as `lifetimeTreatedBase ≤ lifetimeTreated` two functions away.
  // No legitimate world can produce this (billFee moves both by the same
  // amount; closeDay only lowers revenueToday), but a payload carrying it
  // renders "Income today $1,000,000 / Income total $0" and a department
  // subtotal that outruns its own lifetime column.
  it('rejects a room whose income today exceeds its lifetime income', () => {
    const save = parsedFinanceSave();
    const exam = save.rooms.find((r) => r.type === 'exam')!;
    exam.revenueToday = 1_000_000;
    exam.revenueTotal = 0;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('revenueToday');
  });

  // v8: machines gained the per-DAY partner of revenueTotal.
  it('v8: a machine round-trips its day AND lifetime takings, and the pair is bounded', () => {
    const world = new World(new EventBus(), 9);
    setupNewGame(world);
    world.placeAmenity('vending', { col: 4, row: 4 });
    const machine = world.amenityAt(4, 4)!;
    machine.revenueToday = 35;
    machine.revenueTotal = 220;

    const result = loadOf(JSON.parse(saveToString(world)) as SaveData);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const restored = result.world.amenityAt(4, 4)!;
    expect(restored.revenueToday).toBe(35);
    expect(restored.revenueTotal).toBe(220);

    // …and today may never exceed the lifetime figure (the rooms' rule).
    const hostile = JSON.parse(saveToString(world)) as SaveData;
    hostile.amenities[0]!.revenueToday = 999_999;
    hostile.amenities[0]!.revenueTotal = 0;
    const rejected = loadOf(hostile);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toContain('revenueToday');
  });

  it('v7 saves load with amenity revenueToday defaulted to 0', () => {
    const v7 = parsedFinanceSave();
    v7.saveVersion = 7;
    for (const a of v7.amenities) delete (a as Partial<typeof a>).revenueToday;
    const result = loadOf(v7);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const a of result.world.amenities.values()) expect(a.revenueToday).toBe(0);
  });

  it('rejects a negative amenity revenueTotal and a negative lifetime category', () => {
    const amenity = parsedFinanceSave();
    amenity.amenities[0]!.revenueTotal = -5;
    expect(loadOf(amenity).ok).toBe(false);
    const lifetime = parsedFinanceSave();
    lifetime.lifetime.revenue = -1;
    const result = loadOf(lifetime);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('lifetime.revenue');
  });

  it('rejects a watermark above lifetimeTreated, and a negative one', () => {
    const above = parsedFinanceSave();
    above.lifetimeTreatedBase = above.lifetimeTreated + 1;
    const result = loadOf(above);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('lifetimeTreatedBase');
    const negative = parsedFinanceSave();
    negative.lifetimeTreatedBase = -1;
    expect(loadOf(negative).ok).toBe(false);
  });

  it('rejects non-monotonic / duplicated / future-dated history days', () => {
    const reversed = parsedFinanceSave();
    reversed.history.reverse();
    const r1 = loadOf(reversed);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toContain('history');
    const duplicated = parsedFinanceSave();
    duplicated.history[1]!.day = duplicated.history[0]!.day;
    expect(loadOf(duplicated).ok).toBe(false);
    const future = parsedFinanceSave();
    future.history[future.history.length - 1]!.day = 9999;
    const r2 = loadOf(future);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain('played timeline');
  });

  it('TRIMS an over-cap history to the NEWEST cap entries — never rejects it', () => {
    // Review MAJOR 7: `historyCapDays` is a BALANCE tunable. A load-time reject
    // would brick every existing save — production autosaves included — the day
    // the cap is lowered. The trim keeps the same end closeDay keeps.
    const save = parsedFinanceSave();
    const template = save.history[0]!;
    const over = BALANCE.finance.historyCapDays + 5;
    save.history = Array.from({ length: over }, (_, i) => ({ ...template, day: i + 1 }));
    save.tick = over * TICKS_PER_DAY; // the days must be inside the timeline
    const result = loadOf(save);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.world.history).toHaveLength(BALANCE.finance.historyCapDays);
    expect(result.world.history[0]!.day).toBe(over - BALANCE.finance.historyCapDays + 1);
    expect(result.world.history[result.world.history.length - 1]!.day).toBe(over);
  });

  it('rejects a structurally absurd history (the hostile-input bound only)', () => {
    const save = parsedFinanceSave();
    const template = save.history[0]!;
    save.history = Array.from({ length: 1001 }, (_, i) => ({ ...template, day: i + 1 }));
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('history');
  });

  it('rejects a history entry missing a tally key (readTally is version-aware, not lenient)', () => {
    const save = parsedFinanceSave() as unknown as Record<string, unknown>;
    delete (save.history as Record<string, unknown>[])[0]!.revenue;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('revenue');
  });
});

describe('load border: need-break claims (v4, AMENITIES_PLAN §3.5)', () => {
  it('accepts a well-formed stall claim (control)', () => {
    const save = parsedAmenitySave();
    const restroom = save.rooms.find((r) => r.type === 'restroom')!;
    save.patients[0]!.needBreak = stallClaim(restroom.id, 0) as never;
    expect(loadOf(save).ok).toBe(true);
  });

  it('rejects a stall claim on a missing room', () => {
    const save = parsedAmenitySave();
    save.patients[0]!.needBreak = stallClaim(31337, 0) as never;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('needBreak');
  });

  it('rejects a stall claim on a NON-restroom room', () => {
    const save = parsedAmenitySave();
    const reception = save.rooms.find((r) => r.type === 'reception')!;
    save.patients[0]!.needBreak = stallClaim(reception.id, 0) as never;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('restroom');
  });

  it('rejects a slot at/above the grid-derived stall count (min restroom = 2)', () => {
    const save = parsedAmenitySave();
    const restroom = save.rooms.find((r) => r.type === 'restroom')!;
    save.patients[0]!.needBreak = stallClaim(restroom.id, 2) as never;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('slot');
  });

  it('rejects two patients holding one stall (claim exclusivity, NIT 19)', () => {
    const save = parsedAmenitySave();
    const restroom = save.rooms.find((r) => r.type === 'restroom')!;
    save.patients[0]!.needBreak = stallClaim(restroom.id, 1) as never;
    save.patients[1]!.needBreak = stallClaim(restroom.id, 1) as never;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('exclusive');
  });

  it('rejects a vending claim whose tile carries no machine; accepts the real one', () => {
    const vend = (col: number, row: number): Record<string, unknown> => ({
      kind: 'vending',
      tile: { col, row },
      phase: 'walking',
      ticksRemaining: 0,
      startedAt: 0,
    });
    const good = parsedAmenitySave();
    good.patients[0]!.needBreak = vend(10, 20) as never; // the placed machine
    expect(loadOf(good).ok).toBe(true);
    const bad = parsedAmenitySave();
    bad.patients[0]!.needBreak = vend(11, 20) as never; // bare corridor
    const result = loadOf(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('vending');
  });

  it('rejects two patients claiming one machine (one user at a time)', () => {
    const save = parsedAmenitySave();
    const vend = { kind: 'vending', tile: { col: 10, row: 20 }, phase: 'walking', ticksRemaining: 0, startedAt: 0 };
    save.patients[0]!.needBreak = vend as never;
    save.patients[1]!.needBreak = { ...vend } as never;
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('one user per machine');
  });
});

describe('load border: amenities ↔ grid, both ways (v4)', () => {
  it('rejects an amenities entry whose tile does not carry the prop', () => {
    const save = parsedAmenitySave();
    save.amenities[0]!.tile = { col: 0, row: 0 }; // bare corridor
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('amenities[0]');
  });

  it('rejects a grid amenity-prop tile with NO amenities entry (reverse)', () => {
    const save = parsedAmenitySave();
    save.amenities = []; // the grid RLE still carries the vending prop
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no amenities entry');
  });

  it('rejects duplicate amenities entries on one tile', () => {
    const save = parsedAmenitySave();
    save.amenities.push({ ...save.amenities[0]! });
    const result = loadOf(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('one amenity per tile');
  });
});

describe('grid RLE', () => {
  it('encode → decode restores every tile exactly (rooms, props, markers)', () => {
    const world = new World(new EventBus(), 11);
    const queue = new CommandQueue();
    setupNewGame(world); // reception desk (blocking prop) + waiting-room chairs
    queue.push({
      type: 'buildRoom',
      roomType: 'triage',
      rect: { col: 10, row: 30, cols: 2, rows: 2 },
      doorOutside: { col: 10, row: 32 },
    });
    queue.push({ type: 'debugToggleMarker', col: 5, row: 5 });
    queue.push({ type: 'debugToggleMarker', col: 39, row: 39 });
    world.applyCommands(queue);

    // Premises: the grid genuinely contains post-build mutations to round-trip.
    const flat = world.grid.flat();
    expect(flat.some((t) => t.object !== null && !t.walkable)).toBe(true); // desk/cart blocks
    expect(flat.some((t) => t.object === 'chair' && t.walkable)).toBe(true); // walkable seat
    expect(flat.filter((t) => t.marker).length).toBe(2);
    expect(flat.some((t) => t.roomId !== null)).toBe(true);

    const decoded = decodeGrid(encodeGrid(world.grid), world.cols, world.rows);
    expect(decoded).toEqual(world.grid);
    // Fresh objects, not aliases — mutating the decode must not touch the world.
    decoded[0]![0]!.marker = true;
    expect(world.grid[0]![0]!.marker).toBe(false);
  });
});
