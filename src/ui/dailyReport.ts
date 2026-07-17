import type { EventBus } from '../events';
import type { GameLoop, Speed } from '../loop';
import { GAME_MINUTES_PER_HOUR } from '../sim/clock';
import { BALANCE } from '../sim/data/balance';
import { dayNet, type DayReport } from '../sim/dailyStats';
import { money } from './format';
import { modalRow, modalSection } from './modal';

const RESUME_FALLBACK: Speed = 1;

/**
 * Midnight daily report (M4, GDD §9): a pausing modal built from the
 * `dayEnded` snapshot. Continue restores the speed the day ended at.
 */
export class DailyReportModal {
  private overlay!: HTMLElement;
  private card!: HTMLElement;
  private resumeSpeed: Speed = RESUME_FALLBACK;

  constructor(
    private loop: GameLoop,
    private events: EventBus,
  ) {}

  mount(parent: HTMLElement): void {
    this.overlay = document.createElement('div');
    this.overlay.id = 'dailyreport';
    this.overlay.className = 'modal-overlay hidden';
    this.overlay.setAttribute('data-ui', '');
    this.card = document.createElement('div');
    this.card.className = 'modal-card';
    this.overlay.appendChild(this.card);
    parent.appendChild(this.overlay);
    this.events.on('dayEnded', (report) => this.open(report));
    // Foreclosure trumps bookkeeping: the game-over screen replaces any open
    // report (and the sim is frozen, so no resume either).
    this.events.on('gameOver', () => this.overlay.classList.add('hidden'));
  }

  private open(report: DayReport): void {
    // Fast-forward can close several days back-to-back — keep the first
    // remembered speed, re-render the latest report.
    if (this.overlay.classList.contains('hidden')) {
      this.resumeSpeed = this.loop.speed === 0 ? RESUME_FALLBACK : this.loop.speed;
      this.loop.setSpeed(0);
      this.overlay.classList.remove('hidden');
    }
    this.render(report);
  }

  private render(report: DayReport): void {
    this.card.replaceChildren();
    const title = document.createElement('h2');
    title.textContent = `End of Day ${report.day}`;
    this.card.appendChild(title);

    const patients = this.section('Patients');
    this.row(patients, 'Arrived', String(report.arrivals));
    this.row(patients, 'Treated', String(report.treated), report.treated > 0 ? 'good' : '');
    this.row(patients, 'Died', String(report.died), report.died > 0 ? 'bad' : '');
    this.row(patients, 'Left untreated', String(report.leftAma), report.leftAma > 0 ? 'warn' : '');
    this.row(patients, 'Got lost', `${report.lostEpisodes}×`);

    const moneySection = this.section('Money');
    this.row(moneySection, 'Treatment fees', money(report.revenue), 'good');
    this.row(moneySection, 'Payroll', money(-report.payroll), 'bad');
    if (report.hireFees > 0) this.row(moneySection, 'Hiring', money(-report.hireFees), 'bad');
    if (report.construction > 0) {
      this.row(moneySection, 'Construction', money(-report.construction), 'bad');
    }
    if (report.sellIncome > 0) this.row(moneySection, 'Room sales', money(report.sellIncome), 'good');
    const net = dayNet(report);
    this.row(moneySection, 'Net', money(net), net >= 0 ? 'good' : 'bad');
    this.row(moneySection, 'Cash on hand', money(report.cash));

    const standing = this.section('Standing');
    const wait =
      report.avgWaitGameMinutes === null
        ? '—'
        : formatGameMinutes(report.avgWaitGameMinutes) + (report.waitBonusAwarded ? ' ★' : '');
    this.row(standing, 'Avg wait to treatment', wait, report.waitBonusAwarded ? 'good' : '');
    if (report.waitBonusAwarded) {
      this.row(standing, 'Fast-care bonus', `+${BALANCE.reputation.dayCloseWaitBonus} rep`, 'good');
    }
    const repText = `${report.repDelta >= 0 ? '+' : ''}${report.repDelta} → ${Math.round(report.reputation)}`;
    this.row(standing, 'Reputation', repText, report.repDelta >= 0 ? 'good' : 'bad');

    const cont = document.createElement('button');
    cont.textContent = 'Continue';
    cont.className = 'modal-continue';
    cont.setAttribute('data-ui', '');
    cont.addEventListener('click', () => {
      this.overlay.classList.add('hidden');
      this.loop.setSpeed(this.resumeSpeed);
    });
    this.card.appendChild(cont);
  }

  private section(label: string): HTMLElement {
    return modalSection(this.card, label);
  }

  private row(parent: HTMLElement, label: string, value: string, tone = ''): void {
    modalRow(parent, label, value, tone);
  }
}

/** "1h 23m" from game-minutes (conversions themselves live in clock.ts). */
function formatGameMinutes(gameMinutes: number): string {
  const total = Math.round(gameMinutes);
  const hours = Math.floor(total / GAME_MINUTES_PER_HOUR);
  const minutes = total % GAME_MINUTES_PER_HOUR;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
