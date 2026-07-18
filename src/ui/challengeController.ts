import type { EventBus, GameOverPayload } from '../events';
import type { ChallengeContext, ChallengeSpec } from '../sim/data/challenges';
import type { DayReport } from '../sim/dailyStats';
import { scoreChallenge } from '../sim/formulas';
import type { World } from '../sim/world';

/** The result of a challenge terminal — self-contained (carries its own spec) so
 *  the result card and the game-over screen can render it without threading the
 *  spec separately. Mirrors the `challengeComplete` event payload. */
export interface ChallengeResult {
  spec: ChallengeSpec;
  outcome: 'reached' | 'dnf';
  score: number | null;
  context: ChallengeContext;
}

/**
 * Owns the challenge's TWO terminals (plan §5), whichever comes first:
 * - `resolveIfTerminal(report)` — the coordinator calls this SYNCHRONOUSLY at
 *   every day close; non-null ONLY at `goal.day` (outcome `reached`).
 * - `onGameOver(payload)` — the game-over path calls this on bankruptcy before
 *   `goal.day` (outcome `dnf`).
 *
 * Both once-latch on a single `completed` flag: the FIRST terminal wins and
 * emits `challengeComplete` exactly once — a `reached` run that plays on and
 * later busts must NOT emit a second event (plan §5 once-latch).
 */
export class ChallengeController {
  private completed = false;

  constructor(
    private readonly world: World,
    private readonly events: EventBus,
    private readonly spec: ChallengeSpec,
  ) {}

  resolveIfTerminal(report: DayReport): ChallengeResult | null {
    if (this.completed || report.day !== this.spec.goal.day) return null;
    const context: ChallengeContext = {
      outcome: 'reached',
      day: report.day,
      report,
      terminal: {
        cash: report.cash,
        reputation: report.reputation,
        // Lifetime counters are live + public on World (plan §5) — read directly.
        lifetimeTreated: this.world.lifetimeTreated,
        lifetimeDied: this.world.lifetimeDied,
      },
    };
    return this.complete(context);
  }

  onGameOver(payload: GameOverPayload): ChallengeResult | null {
    if (this.completed) return null;
    const context: ChallengeContext = {
      outcome: 'dnf',
      day: payload.day,
      report: null,
      terminal: {
        cash: payload.cash,
        reputation: payload.reputation,
        lifetimeTreated: payload.treated,
        lifetimeDied: payload.died,
      },
    };
    return this.complete(context);
  }

  private complete(context: ChallengeContext): ChallengeResult {
    this.completed = true;
    const score = scoreChallenge(this.spec.goal, context);
    const result: ChallengeResult = {
      spec: this.spec,
      outcome: context.outcome,
      score,
      context,
    };
    // The UI opens overlays via the RETURN value (race-free, §5); this event is
    // the typed record of the terminal. No production consumer in Phase 2 — it
    // is the seam for the Phase-3 telemetry/verifiable-share hook.
    this.events.emit('challengeComplete', {
      spec: this.spec,
      outcome: context.outcome,
      score,
      context,
    });
    return result;
  }
}
