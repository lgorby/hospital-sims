import type { EventBus } from '../events';
import type { GameLoop } from '../loop';
import { GAME_MINUTES_PER_HOUR } from '../sim/clock';
import { BALANCE } from '../sim/data/balance';
import { dayNet, type DayReport } from '../sim/dailyStats';
import { money, signedDelta } from './format';
import { modalRow, modalSection } from './modal';
import { PausingOverlay } from './pausingOverlay';

/**
 * The report body — Patients / Money / Standing sections — as ONE builder
 * (SSOT/DRY): the daily modal renders it, and the challenge result card embeds
 * it so a goal-day report yields nothing when the card takes over the midnight.
 */
export function appendDailyReportSections(card: HTMLElement, report: DayReport): void {
  const patients = modalSection(card, 'Patients');
  modalRow(patients, 'Arrived', String(report.arrivals));
  modalRow(patients, 'Treated', String(report.treated), report.treated > 0 ? 'good' : '');
  modalRow(patients, 'Died', String(report.died), report.died > 0 ? 'bad' : '');
  modalRow(patients, 'Left untreated', String(report.leftAma), report.leftAma > 0 ? 'warn' : '');
  modalRow(patients, 'Got lost', `${report.lostEpisodes}×`);

  const moneySection = modalSection(card, 'Money');
  // "Patient fees", not "Treatment fees": revenue includes vending (below) —
  // an all-vending day would otherwise read "Treatment fees $15, Treated 0"
  // (live-drive review NIT 4).
  modalRow(moneySection, 'Patient fees', money(report.revenue), 'good');
  // Vending is a BREAKDOWN of revenue (both tallied at the same billFee choke
  // point, amenities Stage 1) — informational, deliberately NOT a new net
  // line: dayNet reads `revenue` alone, which already contains it. Rendered
  // only when it exists, like the hiring/construction conditionals below.
  if (report.vendingRevenue > 0) {
    modalRow(moneySection, 'Vending', money(report.vendingRevenue), 'good');
  }
  modalRow(moneySection, 'Payroll', money(-report.payroll), 'bad');
  if (report.hireFees > 0) modalRow(moneySection, 'Hiring', money(-report.hireFees), 'bad');
  if (report.construction > 0) {
    modalRow(moneySection, 'Construction', money(-report.construction), 'bad');
  }
  // Amenity sellbacks land in the same bucket (live-drive NIT 4).
  if (report.sellIncome > 0) {
    modalRow(moneySection, 'Sell-back income', money(report.sellIncome), 'good');
  }
  const net = dayNet(report);
  modalRow(moneySection, 'Net', money(net), net >= 0 ? 'good' : 'bad');
  modalRow(moneySection, 'Cash on hand', money(report.cash));

  const standing = modalSection(card, 'Standing');
  const wait =
    report.avgWaitGameMinutes === null
      ? '—'
      : formatGameMinutes(report.avgWaitGameMinutes) + (report.waitBonusAwarded ? ' ★' : '');
  modalRow(standing, 'Avg wait to treatment', wait, report.waitBonusAwarded ? 'good' : '');
  if (report.waitBonusAwarded) {
    modalRow(
      standing,
      'Fast-care bonus',
      `${signedDelta(BALANCE.reputation.dayCloseWaitBonus)} rep`,
      'good',
    );
  }
  const repText = `${signedDelta(report.repDelta)} → ${Math.round(report.reputation)}`;
  modalRow(standing, 'Reputation', repText, report.repDelta >= 0 ? 'good' : 'bad');
}

/**
 * Midnight daily report (M4, GDD §9): a pausing modal built from the
 * `dayEnded` snapshot. Continue restores the speed the day ended at.
 *
 * Phase 2: this NO LONGER subscribes to `dayEnded` itself — the
 * `MidnightModalCoordinator` is the single `dayEnded` owner and calls `open()`.
 * The `gameOver` hide subscription stays (foreclosure trumps bookkeeping).
 * Clock ownership (pause on open, restore on Continue) is inherited from
 * `PausingOverlay`.
 */
export class DailyReportModal extends PausingOverlay {
  constructor(
    loop: GameLoop,
    private events: EventBus,
  ) {
    super(loop);
  }

  mount(parent: HTMLElement): void {
    this.buildShell(parent, 'dailyreport');
    // Foreclosure trumps bookkeeping: the game-over screen replaces any open
    // report (and the sim is frozen, so no resume either).
    this.events.on('gameOver', () => this.hide());
  }

  /** Opened by the coordinator on an ordinary midnight (plan §6). */
  open(report: DayReport): void {
    this.show();
    this.render(report);
  }

  private render(report: DayReport): void {
    this.card.replaceChildren();
    const title = document.createElement('h2');
    title.textContent = `End of Day ${report.day}`;
    this.card.appendChild(title);

    appendDailyReportSections(this.card, report);

    const cont = document.createElement('button');
    cont.textContent = 'Continue';
    cont.className = 'modal-continue';
    cont.setAttribute('data-ui', '');
    cont.addEventListener('click', () => this.closeAndResume());
    this.card.appendChild(cont);
  }
}

/** "1h 23m" from game-minutes (conversions themselves live in clock.ts). */
function formatGameMinutes(gameMinutes: number): string {
  const total = Math.round(gameMinutes);
  const hours = Math.floor(total / GAME_MINUTES_PER_HOUR);
  const minutes = total % GAME_MINUTES_PER_HOUR;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
