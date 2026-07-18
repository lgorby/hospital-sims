import type { EventBus } from '../events';
import type { GameLoop } from '../loop';
import type { ChallengeController } from './challengeController';
import { appendChallengeResult } from './challengeResultCard';
import { money } from './format';
import { modalRow, modalSection } from './modal';

/**
 * Bankruptcy game-over screen (M4, GDD §2). The sim is already frozen when
 * `gameOver` fires; this pauses the loop and offers a fresh start.
 *
 * Phase 2: in a challenge run a bankruptcy before `goal.day` is the DNF
 * terminal (plan §5). The result folds INTO this screen (§6) — the game-over
 * screen already hides any open daily report (M4 invariant), so there is no
 * coordinator conflict and no second overlay.
 */
export class GameOverScreen {
  constructor(
    private loop: GameLoop,
    private events: EventBus,
    private onNewGame: () => void,
    private controller: ChallengeController | null = null,
  ) {}

  mount(parent: HTMLElement): void {
    this.events.on('gameOver', (payload) => {
      const { day, cash, reputation, treated, died } = payload;
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

      card.append(title, blurb);
      const rows = modalSection(card, 'Final standing');
      modalRow(rows, 'Patients treated', String(treated));
      modalRow(rows, 'Patients died', String(died));
      modalRow(rows, 'Final reputation', String(Math.round(reputation)));
      modalRow(rows, 'Final cash', money(cash));

      // DNF terminal (plan §5): latches + emits `challengeComplete`, then the
      // shared renderer folds the outcome + share line into this same card.
      const result = this.controller?.onGameOver(payload) ?? null;
      if (result) appendChallengeResult(card, result);

      const again = document.createElement('button');
      again.textContent = 'New Game';
      again.className = 'modal-continue';
      again.setAttribute('data-ui', '');
      again.addEventListener('click', () => this.onNewGame());
      card.appendChild(again);
      overlay.appendChild(card);
      parent.appendChild(overlay);
    });
  }
}
