import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { TICKS_PER_DAY } from '../src/sim/clock';
import {
  challengeToQuery,
  clearBootParams,
  resolveBoot,
  SEED_MAX,
  type BootAction,
} from '../src/sim/challenge';
import {
  CHALLENGE_DEFS,
  CHALLENGE_IDS,
  SCORE_METRICS,
  type ChallengeContext,
  type ChallengeSpec,
} from '../src/sim/data/challenges';
import type { DayReport } from '../src/sim/dailyStats';
import { scoreChallenge } from '../src/sim/formulas';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';

/**
 * Phase 2 seed challenges — Track 1 (sim) regression suite. Titles reference the
 * contract in docs/CHALLENGES_PLAN.md (§§4/5) + CHALLENGES_IMPL_PLAN.md (§7).
 */

function boot(query: string): BootAction {
  return resolveBoot(new URLSearchParams(query));
}

// --------------------------------------------------------------- resolveBoot

describe('resolveBoot — precedence + every branch', () => {
  it('load param resolves to a load action (slot passed through, not validated here)', () => {
    expect(boot('load=1')).toEqual({ kind: 'load', slot: '1' });
    expect(boot('load=auto')).toEqual({ kind: 'load', slot: 'auto' });
    // load has top precedence — a stray challenge alongside it does not win.
    expect(boot('load=1&challenge=rep-rush')).toEqual({ kind: 'load', slot: '1' });
  });

  it('a known built-in resolves from the table (seed + goal + id)', () => {
    const action = boot('challenge=rep-rush');
    expect(action).toEqual({
      kind: 'challenge',
      spec: {
        source: 'builtin',
        id: 'rep-rush',
        scenario: { kind: 'default', seed: 1337 },
        goal: { metric: 'reputation', day: 5 },
      },
    });
  });

  it('a built-in ignores stray seed/goal params (the table wins)', () => {
    const action = boot('challenge=rep-rush&seed=99&goal=cash:2');
    expect(action.kind).toBe('challenge');
    if (action.kind !== 'challenge') throw new Error('unreachable');
    expect(action.spec.scenario.seed).toBe(1337);
    expect(action.spec.goal).toEqual({ metric: 'reputation', day: 5 });
  });

  it('an unknown challenge id is a failure — NEVER a fresh roll (MAJOR-3)', () => {
    const action = boot('challenge=does-not-exist');
    expect(action.kind).toBe('failure');
  });

  it('Object.prototype keys are NOT valid ids/metrics (prototype-chain guard)', () => {
    // `in` would walk the prototype chain and resolve a bogus def/metric with a
    // NaN seed / unscorable metric — Object.hasOwn closes it (Track-1 review MAJOR).
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(boot(`challenge=${key}`).kind).toBe('failure');
      expect(boot(`seed=42&goal=${key}:5`).kind).toBe('failure');
    }
  });

  it('an ad-hoc seed+goal resolves to a url spec', () => {
    expect(boot('seed=42&goal=cash:3')).toEqual({
      kind: 'challenge',
      spec: {
        source: 'url',
        id: null,
        scenario: { kind: 'default', seed: 42 },
        goal: { metric: 'cash', day: 3 },
      },
    });
  });

  it('bare valid seed resolves to a seed action', () => {
    expect(boot('seed=1337')).toEqual({ kind: 'seed', seed: 1337 });
  });

  it('no params resolves to title', () => {
    expect(boot('')).toEqual({ kind: 'title' });
  });

  it('a malformed BARE seed falls through to title (no silent auto-roll)', () => {
    expect(boot('seed=abc')).toEqual({ kind: 'title' });
    expect(boot('seed=')).toEqual({ kind: 'title' });
  });
});

describe('resolveBoot — malformed challenges are failures, never seed/title (MAJOR-3)', () => {
  const bad: Array<[string, string]> = [
    ['goal without seed', 'goal=cash:3'],
    ['non-numeric seed', 'seed=abc&goal=cash:3'],
    ['seed >= 2^31', `seed=${SEED_MAX}&goal=cash:3`],
    ['unknown metric', 'seed=42&goal=bogus:3'],
    ['day below 1', 'seed=42&goal=cash:0'],
    ['non-integer day', 'seed=42&goal=cash:1.5'],
    ['too many goal segments', 'seed=42&goal=cash:2:3'],
    ['empty goal', 'seed=42&goal='],
  ];
  for (const [name, query] of bad) {
    it(`${name} → failure`, () => {
      expect(boot(query).kind).toBe('failure');
    });
  }
});

describe('challenge seed canonicalization ([0, 2^31))', () => {
  it('accepts the max in-range seed and rejects the boundary', () => {
    expect(boot(`seed=${SEED_MAX - 1}&goal=cash:1`).kind).toBe('challenge');
    expect(boot(`seed=${SEED_MAX}&goal=cash:1`).kind).toBe('failure');
  });

  it('every built-in seed is already canonical', () => {
    for (const id of CHALLENGE_IDS) {
      const seed = CHALLENGE_DEFS[id].seed;
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(SEED_MAX);
    }
  });
});

describe('clearBootParams — "New Game" escapes a challenge (post-commit MAJOR)', () => {
  it('scrubs challenge/goal/load so a fresh roll resolves to a bare seed', () => {
    // Without the scrub, New Game from a challenge game-over kept ?challenge=
    // in the URL and re-booted the SAME challenge (the table wins over a stray
    // seed) — the startNewGame flow is scrub + set seed, mirrored here.
    for (const query of [
      'challenge=rep-rush',
      'seed=42&goal=cash:3',
      'load=1&challenge=rep-rush&goal=cash:3',
    ]) {
      const params = new URLSearchParams(query);
      clearBootParams(params);
      params.set('seed', '12345');
      expect(resolveBoot(params)).toEqual({ kind: 'seed', seed: 12345 });
    }
  });
});

// ---------------------------------------------------- share-URL round-trip

describe('challengeToQuery is the exact inverse of the parse grammar', () => {
  it('round-trips every built-in', () => {
    for (const id of CHALLENGE_IDS) {
      const action = boot(`challenge=${id}`);
      if (action.kind !== 'challenge') throw new Error(`${id} did not resolve`);
      const reResolved = boot(challengeToQuery(action.spec));
      expect(reResolved).toEqual(action);
    }
  });

  it('round-trips an ad-hoc url spec', () => {
    const spec: ChallengeSpec = {
      source: 'url',
      id: null,
      scenario: { kind: 'default', seed: 314159 },
      goal: { metric: 'treated', day: 6 },
    };
    const reResolved = boot(challengeToQuery(spec));
    expect(reResolved).toEqual({ kind: 'challenge', spec });
  });
});

// ------------------------------------------------------------- scoreChallenge

function makeReport(overrides: Partial<DayReport>): DayReport {
  return {
    day: 3,
    arrivals: 0,
    treated: 0,
    died: 0,
    leftAma: 0,
    lostEpisodes: 0,
    revenue: 0,
    payroll: 0,
    hireFees: 0,
    construction: 0,
    sellIncome: 0,
    repDelta: 0,
    waitSumTicks: 0,
    waitCount: 0,
    cash: 0,
    reputation: 0,
    avgWaitGameMinutes: null,
    waitBonusAwarded: false,
    ...overrides,
  };
}

function reachedCtx(overrides: Partial<DayReport>): ChallengeContext {
  const report = makeReport(overrides);
  return {
    outcome: 'reached',
    day: report.day,
    report,
    terminal: {
      cash: report.cash,
      reputation: report.reputation,
      lifetimeTreated: 0,
      lifetimeDied: 0,
    },
  };
}

describe('scoreChallenge — each metric kind reads the right field', () => {
  it('snapshot metrics read the terminal scalars', () => {
    const ctx = reachedCtx({ cash: 1200, reputation: 742 });
    expect(scoreChallenge({ metric: 'reputation', day: 3 }, ctx)).toBe(742);
    expect(scoreChallenge({ metric: 'cash', day: 3 }, ctx)).toBe(1200);
  });

  it('cumulative metrics read the lifetime counters', () => {
    const ctx: ChallengeContext = {
      outcome: 'reached',
      day: 3,
      report: makeReport({}),
      terminal: { cash: 0, reputation: 0, lifetimeTreated: 55, lifetimeDied: 9 },
    };
    expect(scoreChallenge({ metric: 'treated', day: 3 }, ctx)).toBe(55);
    expect(scoreChallenge({ metric: 'died', day: 3 }, ctx)).toBe(9);
  });

  it('daily-flow metrics read the goal-day report', () => {
    const ctx = reachedCtx({ treated: 12, revenue: 900, payroll: 300 });
    expect(scoreChallenge({ metric: 'dayTreated', day: 3 }, ctx)).toBe(12);
    // dayNet = revenue + sellIncome - payroll - hireFees - construction
    expect(scoreChallenge({ metric: 'dayNet', day: 3 }, ctx)).toBe(600);
  });

  it('daily-flow metrics return null on a DNF (no day closed); terminal metrics still score', () => {
    const dnf: ChallengeContext = {
      outcome: 'dnf',
      day: 2,
      report: null,
      terminal: { cash: -5000, reputation: 100, lifetimeTreated: 3, lifetimeDied: 8 },
    };
    expect(scoreChallenge({ metric: 'dayTreated', day: 3 }, dnf)).toBeNull();
    expect(scoreChallenge({ metric: 'dayNet', day: 3 }, dnf)).toBeNull();
    expect(scoreChallenge({ metric: 'cash', day: 3 }, dnf)).toBe(-5000);
    expect(scoreChallenge({ metric: 'died', day: 3 }, dnf)).toBe(8);
  });

  it('every SCORE_METRICS entry is scorable on a reached terminal', () => {
    const ctx = reachedCtx({ treated: 1, revenue: 1 });
    for (const metric of Object.keys(SCORE_METRICS) as Array<keyof typeof SCORE_METRICS>) {
      expect(scoreChallenge({ metric, day: 3 }, ctx)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------- world.challengeMode gate

function makeWorld(challengeMode: boolean): { world: World; queue: CommandQueue } {
  const world = new World(new EventBus(), 42, challengeMode);
  setupNewGame(world);
  return { world, queue: new CommandQueue() };
}

describe('world.challengeMode — the one debug mutation gate (owner ruling §10.3)', () => {
  it('rejects every debug* command when true', () => {
    const { world, queue } = makeWorld(true);
    const cashBefore = world.cash;
    const patientsBefore = world.patients.size;
    queue.push({ type: 'debugSetCash', amount: 999_999 });
    queue.push({ type: 'debugSpawnPatient', condition: 'flu' });
    queue.push({ type: 'debugForce', patientId: 1, outcome: 'death' });
    queue.push({ type: 'debugFastForward', ticks: 100 });
    queue.push({ type: 'debugWalkTo', col: 1, row: 1 });
    queue.push({ type: 'debugToggleMarker', col: 1, row: 1 });
    world.applyCommands(queue);
    expect(world.cash).toBe(cashBefore);
    expect(world.patients.size).toBe(patientsBefore);
    expect(world.clock.tick).toBe(0); // debugFastForward did not advance
  });

  it('allows debug* commands when false (normal game)', () => {
    const { world, queue } = makeWorld(false);
    queue.push({ type: 'debugSetCash', amount: 12_345 });
    queue.push({ type: 'debugSpawnPatient', condition: 'flu' });
    world.applyCommands(queue);
    expect(world.cash).toBe(12_345);
    expect(world.patients.size).toBe(1);
  });

  it('rejection is a pure no-op — the rng stream is unperturbed', () => {
    // A rejected debugSpawnPatient must NOT draw world.rng: a challenge run
    // that receives a (rejected) debug command has the same stream as one that
    // received nothing. Compare against a debug command that WOULD draw rng.
    const { world, queue } = makeWorld(true);
    const stateBefore = world.rng.getState();
    queue.push({ type: 'debugSpawnPatient', condition: 'flu' });
    queue.push({ type: 'debugForce', patientId: 1, outcome: 'complication' });
    world.applyCommands(queue);
    expect(world.rng.getState()).toBe(stateBefore);

    // Sanity: the SAME command DOES draw rng in a normal world (so the guard is
    // load-bearing, not vacuous — spawnPatient consumes draws).
    const normal = makeWorld(false);
    const normalBefore = normal.world.rng.getState();
    normal.queue.push({ type: 'debugSpawnPatient', condition: 'flu' });
    normal.world.applyCommands(normal.queue);
    expect(normal.world.rng.getState()).not.toBe(normalBefore);
  });
});

// -------------------------------------------------------- determinism replay

describe('determinism — same spec ⇒ identical arrival stream', () => {
  function arrivalTicks(seed: number, days: number): number[] {
    const events = new EventBus();
    const world = new World(events, seed, true);
    setupNewGame(world);
    const ticks: number[] = [];
    events.on('patientSpawned', () => ticks.push(world.clock.tick));
    for (let i = 0; i < TICKS_PER_DAY * days; i++) world.tick();
    return ticks;
  }

  it('two runs of one built-in seed produce the same arrivals', () => {
    const seed = CHALLENGE_DEFS['rep-rush'].seed;
    const a = arrivalTicks(seed, 2);
    const b = arrivalTicks(seed, 2);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });
});

// -------------------------------------------------- float-op determinism lint

describe('src/sim is free of non-IEEE-safe float ops (Phase-2 invariant §2)', () => {
  // Cross-device comparability depends on identical streams: Math.sin/pow/etc.
  // are not bit-reproducible across engines. Guard the whole sim tree.
  const BANNED =
    /\bMath\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|pow|sqrt|cbrt|exp|expm1|log|log2|log10|log1p|hypot)\b/;

  // Vite's raw glob (node-free, so it survives the node-typeless build tsc).
  const sources = import.meta.glob('../src/sim/**/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  it('no banned Math.* transcendental/irrational calls anywhere in src/sim', () => {
    const offenders: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      src.split('\n').forEach((line, i) => {
        if (BANNED.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
    // Guard the guard: the glob must actually see the tree (a bad pattern that
    // matches nothing would pass vacuously).
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });
});
