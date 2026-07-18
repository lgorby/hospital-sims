import type { EventBus } from '../events';
import type { DayReport } from '../sim/dailyStats';
import type { ChallengeController } from './challengeController';
import type { ChallengeResultCard } from './challengeResultCard';
import type { DailyReportModal } from './dailyReport';

/**
 * The SINGLE `dayEnded` subscriber (plan §6, mirrors the `BottomBarDropdowns`
 * coordinator). The daily report and the challenge result card register here
 * and never subscribe to `dayEnded` themselves, so WHICH overlay opens at a day
 * boundary is decided by ONE owner — a plain synchronous return value, NOT
 * EventBus emit/registration order (that ordering was the v1 race, IMPL_PLAN
 * MAJOR-2). This is also what enforces "no two overlays open at once": exactly
 * one branch below runs per midnight.
 */
export class MidnightModalCoordinator {
  private dailyReport: DailyReportModal | null = null;
  private controller: ChallengeController | null = null;
  private resultCard: ChallengeResultCard | null = null;

  constructor(events: EventBus) {
    events.on('dayEnded', (report) => this.onDayEnded(report));
  }

  /** Always present (every game has a daily report). */
  setDailyReport(modal: DailyReportModal): void {
    this.dailyReport = modal;
  }

  /** Present only in a challenge run; the pair is set together so there is no
   *  half-wired state where a controller exists without its card. */
  setChallenge(controller: ChallengeController, card: ChallengeResultCard): void {
    this.controller = controller;
    this.resultCard = card;
  }

  private onDayEnded(report: DayReport): void {
    // Synchronous: the controller latches + emits `challengeComplete` here if
    // this is the goal-day close, and returns the result to open the card;
    // otherwise the daily report opens as usual. Exactly one overlay opens.
    const result = this.controller?.resolveIfTerminal(report) ?? null;
    if (result && this.resultCard) {
      this.resultCard.open(result, report);
    } else {
      this.dailyReport?.open(report);
    }
  }
}
