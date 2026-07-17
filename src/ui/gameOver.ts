import type { EventBus } from '../events';
import type { GameLoop } from '../loop';
import { money } from './format';

/**
 * Bankruptcy game-over screen (M4, GDD §2). The sim is already frozen when
 * `gameOver` fires; this pauses the loop and offers a fresh start.
 */
export class GameOverScreen {
  constructor(
    private loop: GameLoop,
    private events: EventBus,
    private onNewGame: () => void,
  ) {}

  mount(parent: HTMLElement): void {
    this.events.on('gameOver', ({ day, cash, reputation, treated, died }) => {
      this.loop.setSpeed(0);
      const overlay = document.createElement('div');
      overlay.id = 'gameover';
      overlay.className = 'modal-overlay';
      overlay.setAttribute('data-ui', '');

      const card = document.createElement('div');
      card.className = 'modal-card';
      const title = document.createElement('h2');
      title.textContent = 'The bank has foreclosed';
      const blurb = document.createElement('p');
      blurb.textContent = `Your hospital ran below the debt limit for a full day. It lasted ${day} day${day === 1 ? '' : 's'}.`;

      const rows = document.createElement('div');
      rows.className = 'modal-rows';
      const stat = (label: string, value: string): void => {
        const row = document.createElement('div');
        row.className = 'modal-row';
        const l = document.createElement('span');
        l.textContent = label;
        const v = document.createElement('span');
        v.textContent = value;
        row.append(l, v);
        rows.appendChild(row);
      };
      stat('Patients treated', String(treated));
      stat('Patients died', String(died));
      stat('Final reputation', String(Math.round(reputation)));
      stat('Final cash', money(cash));

      const again = document.createElement('button');
      again.textContent = 'New Game';
      again.className = 'modal-continue';
      again.setAttribute('data-ui', '');
      again.addEventListener('click', () => this.onNewGame());

      card.append(title, blurb, rows, again);
      overlay.appendChild(card);
      parent.appendChild(overlay);
    });
  }
}
