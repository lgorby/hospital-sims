import type { GameLoop, Speed } from '../loop';

const RESUME_FALLBACK: Speed = 1;

/**
 * Shared "a visible `.modal-overlay` owns the clock" behavior (CLAUDE.md M4
 * invariant, SSOT/DRY): a full-screen overlay that pauses the loop while
 * visible and restores the pre-open speed on close. The daily report and the
 * challenge result card extend it, so the pause/capture/restore dance — where a
 * subtle mismatch would silently leave the clock paused — lives in ONE place.
 */
export abstract class PausingOverlay {
  protected overlay!: HTMLElement;
  protected card!: HTMLElement;
  private resumeSpeed: Speed = RESUME_FALLBACK;

  constructor(protected readonly loop: GameLoop) {}

  /** Build the hidden overlay + card shell. Subclasses call this from `mount`. */
  protected buildShell(parent: HTMLElement, overlayId: string): void {
    this.overlay = document.createElement('div');
    this.overlay.id = overlayId;
    this.overlay.className = 'modal-overlay hidden';
    this.overlay.setAttribute('data-ui', '');
    this.card = document.createElement('div');
    this.card.className = 'modal-card';
    this.overlay.appendChild(this.card);
    parent.appendChild(this.overlay);
  }

  /** Show + take the clock. Idempotent while already visible (keeps the first
   *  remembered speed, so several back-to-back day closes don't lose it). */
  protected show(): void {
    if (this.overlay.classList.contains('hidden')) {
      this.resumeSpeed = this.loop.speed === 0 ? RESUME_FALLBACK : this.loop.speed;
      this.loop.setSpeed(0);
      this.overlay.classList.remove('hidden');
    }
  }

  /** Close + restore the pre-open speed (the Continue path). */
  protected closeAndResume(): void {
    this.overlay.classList.add('hidden');
    this.loop.setSpeed(this.resumeSpeed);
  }

  /** Hide without resuming — the sim is already frozen (e.g. `gameOver`). */
  protected hide(): void {
    this.overlay.classList.add('hidden');
  }
}
