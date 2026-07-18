import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus, type EventName } from '../src/events';
import { TICKS_PER_DAY } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import { ROLE_IDS } from '../src/sim/data/roles';
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
  roomSold: true,
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
    reservations.some((r) => r.slotIndex > 0)
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

  assertRichPremises(world);
  return { world, events };
}

describe('save/load round-trip (THE acceptance gate, plan rule 4)', () => {
  it('save → load → run N ticks: identical event logs and identical final state', () => {
    const a = bootScenario(); // asserts every schema-corner premise at the save tick
    expect(a.world.rooms.size).toBe(6); // reception, waiting, triage, exam, atrium, dialysis

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
    save.candidates = save.candidates.filter(
      (c) => c.role !== 'sonographer' && c.role !== 'surgeon',
    );
    // Premise: the fixture genuinely lacks the new roles entirely.
    expect(save.candidates.length).toBe(
      (ROLE_IDS.length - 2) * BALANCE.hiring.candidatesPerRole,
    );
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
