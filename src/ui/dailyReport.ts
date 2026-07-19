import type { EventBus } from '../events';
import type { GameLoop } from '../loop';
import { GAME_MINUTES_PER_HOUR, ticksToGameMinutes } from '../sim/clock';
import { BALANCE } from '../sim/data/balance';
import { FINANCE_CATEGORIES } from '../sim/data/finance';
import { dayNet, type DayReport } from '../sim/dailyStats';
import { cleanlinessRepDelta } from '../sim/formulas';
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
  // Referrals are a SUBSET of the rows above, shown only once a clinic exists
  // (the stream is room-gated, so zero means the player has no scanner and the
  // row would be noise). The two streams have opposite reputation economics —
  // +2 a discharge against -2 a no-show — so a merged Arrived/Treated row
  // cannot answer "is my clinic paying for itself?".
  if (report.electiveTreated > 0 || report.electiveNoShow > 0) {
    modalRow(
      patients,
      'Referrals',
      `${report.electiveTreated} seen · ${report.electiveNoShow} no-show`,
      report.electiveNoShow > report.electiveTreated ? 'warn' : '',
    );
  }
  modalRow(patients, 'Got lost', `${report.lostEpisodes}×`);

  const moneySection = modalSection(card, 'Money');
  // The Money rows fold the §9.1 category SSOT (FINANCE_PLAN §9.8) rather than
  // hand-listing themselves, so a new money field cannot be tallied yet
  // invisible here. `reportOrder` carries this report's SHIPPED row order,
  // which deliberately differs from the table's array order (that one is the
  // finances GRID's); `showWhenZero` is the zero-suppression the report has
  // always done ("Patient fees"/"Payroll" always render, the rest only when
  // they happened); `kind` drives BOTH the negation and the tone.
  //
  // Two labels worth keeping in mind while reading the table: "Patient fees",
  // not "Treatment fees", because revenue includes vending — an all-vending
  // day would otherwise read "Treatment fees $15, Treated 0" (live-drive NIT
  // 4). And Vending is a BREAKDOWN of revenue (both tallied at the same
  // billFee choke point): informational, never a net line — dayNet reads
  // `revenue` alone, which already contains it.
  const reportRows = [...FINANCE_CATEGORIES].sort((a, b) => a.reportOrder - b.reportOrder);
  for (const category of reportRows) {
    const amount = report[category.field];
    // `!== 0`, not the shipped `<= 0` (review NIT): byte-identical today,
    // because every cash category is a one-directional running sum — tallyCash
    // is only ever called with a positive magnitude and the save border
    // rejects negatives. But if a category ever CAN go negative (a refund, a
    // fine, a clawback), `<= 0` would silently hide a real loss, which is the
    // exact failure the category SSOT exists to prevent.
    if (!category.showWhenZero && amount === 0) continue;
    const expense = category.kind === 'expense';
    modalRow(moneySection, category.label, money(expense ? -amount : amount), expense ? 'bad' : 'good');
  }
  // Net and Cash on hand stay HAND-RENDERED: they are not categories. Net is
  // the fold ITSELF (netFromCategories, via dayNet) with a sign-driven tone,
  // and Cash on hand is toneless with no grid-row analog.
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
  // Cleanliness (amenities Stage 2, AMENITIES_PLAN §4.2): the SAME formula
  // closeDay applied — a REPUTATION component beside the fast-care bonus,
  // never cash (dayNet ignores messTicks). Absent when it contributed nothing:
  // an empty day, or too little mess for a whole rep point.
  const cleanDelta = cleanlinessRepDelta(report.messTicks, report.arrivals);
  if (cleanDelta !== 0) {
    // Mess-hours context on a penalty — how long messes sat, via clock.ts
    // conversions only (SSOT rule; formulas divides the identical way).
    const messHours = ticksToGameMinutes(report.messTicks) / GAME_MINUTES_PER_HOUR;
    const context = cleanDelta < 0 ? ` (${Math.round(messHours)} mess-hours)` : '';
    modalRow(
      standing,
      'Cleanliness',
      `${signedDelta(cleanDelta)} rep${context}`,
      cleanDelta > 0 ? 'good' : 'bad',
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
