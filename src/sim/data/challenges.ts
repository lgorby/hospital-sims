import type { DayReport } from '../dailyStats';

/**
 * Phase 2 seed challenges — SSOT (tech plan §3.1 rule 1). Every challenge
 * number, metric, and built-in def lives here as an `as const` table; types
 * derive via `keyof typeof`. Parsing/resolution logic lives in
 * `src/sim/challenge.ts`; scoring lives in `src/sim/formulas.ts`. This module
 * is pure data + types (no functions), like `rooms.ts`/`conditions.ts`.
 *
 * See `docs/CHALLENGES_PLAN.md` (design) and `docs/CHALLENGES_IMPL_PLAN.md`.
 */

// ------------------------------------------------------------------ scoring

/**
 * A scored metric. `kind` selects the source of the number at the terminal
 * (formulas.scoreChallenge is the ONE place a metric becomes a number):
 * - `snapshot`   — a live scalar (cash/reputation); scored on BOTH terminals.
 * - `cumulative` — a lifetime counter; scored on BOTH terminals.
 * - `dailyFlow`  — the goal-day's flow tally; `null` on a DNF (no day closed).
 * `field` names the exact source key so no metric hardcodes a formula.
 */
// `unit` is the DISPLAY format (money vs count) — kept on the table so the UI
// never re-derives it from field names (the whole metric is data, not code).
interface ScoreMetricBase {
  readonly label: string;
  readonly unit: 'money' | 'count';
}
type ScoreMetricDef =
  | (ScoreMetricBase & { readonly kind: 'snapshot'; readonly field: 'cash' | 'reputation' })
  | (ScoreMetricBase & { readonly kind: 'cumulative'; readonly field: 'lifetimeTreated' | 'lifetimeDied' })
  | (ScoreMetricBase & { readonly kind: 'dailyFlow'; readonly field: 'treated' | 'net' });

/** SSOT goal-metric registry. A challenge's `goal.metric` is data, not code. */
export const SCORE_METRICS = {
  reputation: { label: 'Reputation', unit: 'count', kind: 'snapshot', field: 'reputation' },
  cash: { label: 'Cash', unit: 'money', kind: 'snapshot', field: 'cash' },
  treated: { label: 'Patients treated', unit: 'count', kind: 'cumulative', field: 'lifetimeTreated' },
  died: { label: 'Patients died', unit: 'count', kind: 'cumulative', field: 'lifetimeDied' },
  dayTreated: { label: 'Goal-day discharges', unit: 'count', kind: 'dailyFlow', field: 'treated' },
  dayNet: { label: 'Goal-day net cash', unit: 'money', kind: 'dailyFlow', field: 'net' },
} as const satisfies Record<string, ScoreMetricDef>;

export type ScoreMetricId = keyof typeof SCORE_METRICS;

// ------------------------------------------------------------------- goal

/** A challenge objective: a metric sampled at a day's close. */
export interface ChallengeGoal {
  readonly metric: ScoreMetricId;
  /** Integer ≥ 1; scored at this day's close (`report.day === goal.day`). */
  readonly day: number;
  /** Optional pass/fail threshold; absent = compare raw (leaderboard-style). */
  readonly target?: number;
}

// -------------------------------------------------------------- scoring ctx

/**
 * Terminal scalars, present on BOTH terminals: the goal-day `DayReport`
 * snapshot on `reached`, the `gameOver` payload on `dnf` (§5). Lets snapshot +
 * cumulative metrics score even on a DNF.
 */
export interface ChallengeTerminal {
  readonly cash: number;
  readonly reputation: number;
  readonly lifetimeTreated: number;
  readonly lifetimeDied: number;
}

/** Assembled once at the terminal; the sole input to `scoreChallenge` (§5). */
export interface ChallengeContext {
  readonly outcome: 'reached' | 'dnf';
  /** The day the terminal occurred: `goal.day` on `reached`, the bust day on
   *  `dnf` (drives the "DNF (busted day N)" share line — the two can differ). */
  readonly day: number;
  /** The goal-day report on `reached`; `null` on `dnf` (no day closed). */
  readonly report: DayReport | null;
  readonly terminal: ChallengeTerminal;
}

// ------------------------------------------------------------------- spec

/**
 * The resolved, validated form the game runs on. BOTH a built-in def and an
 * ad-hoc URL resolve to this — nothing downstream knows which source. `seed`
 * lives inside the scenario (it is meaningful only for a generated run; a
 * future Phase-3 save scenario carries `rngState` instead — plan §3).
 */
export interface ChallengeSpec {
  readonly source: 'builtin' | 'url';
  /** Built-in id, or `null` for an ad-hoc URL challenge. */
  readonly id: string | null;
  readonly scenario: { readonly kind: 'default'; readonly seed: number };
  readonly goal: ChallengeGoal;
}

// -------------------------------------------------------------- built-ins

/**
 * Curated built-in roster (owner ruling §10.5). The record KEY is the id —
 * `?challenge=<key>` — so the id is never stored twice (SSOT/DRY, mirrors
 * `ROOM_DEFS`/`CONDITION_DEFS` where the key is the type). Seeds are already
 * canonical `[0, 2^31)` (see `SEED_MAX` in `challenge.ts`); `challenge.ts`
 * re-canonicalizes on resolve so the URL, `world.seed`, and HUD always agree.
 */
interface ChallengeDef {
  readonly label: string;
  readonly blurb: string;
  readonly seed: number;
  readonly goal: ChallengeGoal;
}

export const CHALLENGE_DEFS = {
  'rep-rush': {
    label: 'Reputation Rush',
    blurb: 'Build the best-regarded hospital in town by the end of day 5.',
    seed: 1337,
    goal: { metric: 'reputation', day: 5 },
  },
  'cash-cow': {
    label: 'Cash Cow',
    blurb: 'Run the fattest bank balance you can by the close of day 7.',
    seed: 777,
    goal: { metric: 'cash', day: 7 },
  },
  'triage-trial': {
    label: 'Triage Trial',
    blurb: 'Discharge as many patients as possible across the first 3 days.',
    seed: 2024,
    goal: { metric: 'treated', day: 3 },
  },
  'gold-standard': {
    label: 'Gold Standard',
    blurb: 'Reach a reputation of 600 by the end of day 4.',
    seed: 500,
    goal: { metric: 'reputation', day: 4, target: 600 },
  },
} as const satisfies Record<string, ChallengeDef>;

export type ChallengeId = keyof typeof CHALLENGE_DEFS;
export const CHALLENGE_IDS = Object.keys(CHALLENGE_DEFS) as ChallengeId[];
