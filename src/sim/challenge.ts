import {
  CHALLENGE_DEFS,
  SCORE_METRICS,
  type ChallengeGoal,
  type ChallengeId,
  type ChallengeSpec,
  type ScoreMetricId,
} from './data/challenges';

/**
 * The ONE module that owns boot-param grammar (tech plan §3.1, plan §3): URL
 * parse → validate → resolve, seed canonicalization, and the inverse
 * (share-URL) grammar. Pure and renderer-free — no Pixi, no DOM, no
 * `Math.random`/`Date.now`. `main.ts` calls `resolveBoot` and never re-parses.
 *
 * See `docs/CHALLENGES_PLAN.md` §4 (URL contract) + `CHALLENGES_IMPL_PLAN.md`.
 */

/**
 * Exclusive upper bound for challenge seeds: `[0, 2^31)`. Challenge seeds are
 * canonicalized to this range so the URL, `world.seed`, and the HUD chip always
 * agree (a looser range would alias under `SeededRng`'s `seed >>> 0`). Also the
 * bound `main.ts` rolls a fresh new-game seed within — one SSOT constant.
 */
export const SEED_MAX = 0x80000000;

/** The entire boot decision as a discriminated union (frozen contract §2). */
export type BootAction =
  | { kind: 'load'; slot: string }
  | { kind: 'challenge'; spec: ChallengeSpec }
  | { kind: 'seed'; seed: number }
  | { kind: 'title' }
  | { kind: 'failure'; reason: string };

/** Canonical challenge seed, or `null` if not a whole number in `[0, 2^31)`. */
function parseChallengeSeed(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n < SEED_MAX ? n : null;
}

/** Parse `<metric>:<day>` into a validated goal, or `null` if malformed. */
function parseGoalExpr(raw: string | null): ChallengeGoal | null {
  if (raw === null) return null;
  const parts = raw.split(':');
  if (parts.length !== 2) return null;
  const metric = parts[0]!;
  const dayRaw = parts[1]!;
  // `Object.hasOwn`, NOT `in`: `in` walks the prototype chain, so `goal=toString:5`
  // / `goal=constructor:5` would slip past and yield an unscorable metric.
  if (!Object.hasOwn(SCORE_METRICS, metric)) return null;
  if (!/^\d+$/.test(dayRaw)) return null;
  const day = Number.parseInt(dayRaw, 10);
  if (!Number.isInteger(day) || day < 1) return null;
  // metric is validated above; the `in` guard narrows it to a known key.
  return { metric: metric as ScoreMetricId, day };
}

/** Resolve a built-in def to a runnable spec (canonicalizing its seed). */
function resolveBuiltin(id: ChallengeId): ChallengeSpec {
  const def = CHALLENGE_DEFS[id];
  // Built-in seeds are authored canonical (a test enforces it); the `% SEED_MAX`
  // is a defensive clamp so the seed shown/run always matches what the URL
  // would round-trip, even if a future def were authored out of range.
  return {
    source: 'builtin',
    id,
    scenario: { kind: 'default', seed: def.seed % SEED_MAX },
    goal: def.goal,
  };
}

/**
 * The whole boot-branch decision (frozen contract §2). Precedence (plan §4):
 * `load` → `challenge`/`goal` → bare `seed` → title. Presence of
 * `challenge`/`goal` disables the bare-seed fallback entirely, so a malformed
 * challenge is a readable boot-failure, NEVER a fresh random roll (the MAJOR-3
 * fix — a shared challenge URL must give every recipient the SAME world).
 */
export function resolveBoot(params: URLSearchParams): BootAction {
  const loadParam = params.get('load');
  if (loadParam !== null) return { kind: 'load', slot: loadParam };

  const challengeParam = params.get('challenge');
  const goalParam = params.get('goal');
  if (challengeParam !== null || goalParam !== null) {
    if (challengeParam !== null) {
      // A built-in is self-contained: the table supplies seed + goal, and any
      // stray `seed`/`goal` alongside a valid id is ignored (the table wins),
      // so a copy-paste artifact can't produce a conflicting run.
      // `Object.hasOwn`, NOT `in`: `in` walks the prototype chain, so
      // `?challenge=constructor` / `__proto__` would resolve a bogus def
      // (NaN seed, undefined goal) instead of a boot-failure card (MAJOR-3).
      if (Object.hasOwn(CHALLENGE_DEFS, challengeParam)) {
        return { kind: 'challenge', spec: resolveBuiltin(challengeParam as ChallengeId) };
      }
      return { kind: 'failure', reason: `"${challengeParam}" is not a known challenge.` };
    }
    // Ad-hoc: `?seed=N&goal=<metric>:<day>` — seed required, resolves to 'url'.
    const seedRaw = params.get('seed');
    if (seedRaw === null) {
      return { kind: 'failure', reason: 'A challenge URL needs a seed (?seed=…&goal=…).' };
    }
    const seed = parseChallengeSeed(seedRaw);
    if (seed === null) {
      return {
        kind: 'failure',
        reason: `The challenge seed must be a whole number from 0 to ${SEED_MAX - 1}.`,
      };
    }
    const goal = parseGoalExpr(goalParam);
    if (goal === null) {
      return {
        kind: 'failure',
        reason: `"${goalParam}" is not a valid goal — expected <metric>:<day>, e.g. reputation:5.`,
      };
    }
    return {
      kind: 'challenge',
      spec: { source: 'url', id: null, scenario: { kind: 'default', seed }, goal },
    };
  }

  const seedParam = params.get('seed');
  if (seedParam !== null) {
    // Bare-seed range is left alone (plan §4) — `SeededRng` clamps via `>>> 0`.
    // A malformed bare seed falls through to the title screen (a deliberate
    // refinement of the old auto-roll: the URL and the world can no longer
    // silently disagree, and this keeps `resolveBoot` pure + total).
    if (/^\d{1,10}$/.test(seedParam)) {
      return { kind: 'seed', seed: Number.parseInt(seedParam, 10) };
    }
    return { kind: 'title' };
  }

  return { kind: 'title' };
}

/**
 * Inverse of the parse grammar — the share-URL query string (no leading `?`).
 * SSOT for the round-trip so a shared link always re-resolves to the same spec.
 * All components are URL-safe by construction (slug ids, integer seed/day,
 * `SCORE_METRICS` keys), so no percent-encoding is needed.
 *
 * A built-in round-trips its `goal.target` losslessly (it lives in the table,
 * keyed by id). An ad-hoc `url` spec is target-less by construction —
 * `parseGoalExpr` never produces a `target`, so the `<metric>:<day>` grammar
 * carries everything a `url` spec can hold (no silent loss).
 */
export function challengeToQuery(spec: ChallengeSpec): string {
  if (spec.source === 'builtin' && spec.id !== null) {
    return `challenge=${spec.id}`;
  }
  return `seed=${spec.scenario.seed}&goal=${spec.goal.metric}:${spec.goal.day}`;
}
