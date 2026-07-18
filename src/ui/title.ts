import { CHALLENGE_DEFS, CHALLENGE_IDS, type ChallengeId } from '../sim/data/challenges';
import { SaveLoadModal } from './saveLoad';
import { hasAnySave, mostRecentSlot, navigateToLoad } from './saveStore';

/** Boot a built-in challenge — a full reload onto `?challenge=<id>` (the
 *  shareable form), mirroring the new-game `?seed=` navigation. */
function navigateToChallenge(id: ChallengeId): void {
  window.location.assign(`${window.location.pathname}?challenge=${id}`);
}

/**
 * Title screen (M4 new-game flow): shown when the URL carries no seed/load.
 * "New Game" hands off to main.ts, which navigates to `?seed=<random>` —
 * a full reload is the teardown-free way to (re)boot a deterministic world.
 *
 * Phase-1 persistence: with saves present, Continue loads the most recent
 * slot and Load Game opens the save modal in load-only mode. Import is
 * always reachable (a fresh PC has no saves — that's the PC-to-PC story).
 */
export class TitleScreen {
  constructor(private onNewGame: () => void) {}

  mount(parent: HTMLElement): void {
    const overlay = document.createElement('div');
    overlay.id = 'title';
    overlay.className = 'modal-overlay';
    overlay.setAttribute('data-ui', '');

    const card = document.createElement('div');
    card.className = 'title-card';
    const h1 = document.createElement('h1');
    h1.textContent = 'Hospital Simms';
    const tagline = document.createElement('p');
    tagline.textContent = 'Patients arrive. Money moves. People get lost on the way to X-ray.';

    // Load-only modal (no Save buttons, no world to autosave) mounted after
    // the title overlay so it stacks above it when opened. Closing it
    // re-renders the button row — an import/delete made inside the modal must
    // show/remove Continue immediately, not after a reload.
    const modal = new SaveLoadModal(null);

    const buttons = document.createElement('div');
    buttons.className = 'title-buttons';
    modal.onClose = (): void => this.renderButtons(buttons, modal);
    this.renderButtons(buttons, modal);

    card.append(h1, tagline, buttons);
    overlay.appendChild(card);
    parent.appendChild(overlay);
    modal.mount(parent);
  }

  private renderButtons(container: HTMLElement, modal: SaveLoadModal): void {
    container.replaceChildren();
    if (hasAnySave()) {
      this.button(container, 'Continue', 'modal-continue', () => {
        const slot = mostRecentSlot();
        // Saves can vanish out from under a stale button (another tab, storage
        // wipe) — reflect reality instead of silently no-opping.
        if (slot !== null) navigateToLoad(slot);
        else this.renderButtons(container, modal);
      });
      this.button(container, 'New Game', 'title-alt', () => this.onNewGame());
      this.button(container, 'Challenges', 'title-alt', () => this.renderChallenges(container, modal));
      this.button(container, 'Load Game', 'title-alt', () => modal.open());
    } else {
      this.button(container, 'New Game', 'modal-continue', () => this.onNewGame());
      this.button(container, 'Challenges', 'title-alt', () => this.renderChallenges(container, modal));
      this.button(container, 'Import Save', 'title-alt', () => modal.open());
    }
  }

  /** Phase 2 (plan §6): the curated built-in roster. Each entry boots its
   *  `?challenge=<id>` run; Back returns to the main menu. */
  private renderChallenges(container: HTMLElement, modal: SaveLoadModal): void {
    container.replaceChildren();
    for (const id of CHALLENGE_IDS) {
      const def = CHALLENGE_DEFS[id];
      const entry = document.createElement('button');
      entry.className = 'title-challenge';
      entry.setAttribute('data-ui', '');
      const name = document.createElement('span');
      name.className = 'title-challenge-name';
      name.textContent = def.label;
      const blurb = document.createElement('span');
      blurb.className = 'title-challenge-blurb';
      blurb.textContent = def.blurb;
      entry.append(name, blurb);
      entry.addEventListener('click', () => navigateToChallenge(id));
      container.appendChild(entry);
    }
    this.button(container, 'Back', 'title-alt', () => this.renderButtons(container, modal));
  }

  private button(
    parent: HTMLElement,
    label: string,
    className: string,
    onClick: () => void,
  ): void {
    const button = document.createElement('button');
    button.textContent = label;
    button.className = className;
    button.setAttribute('data-ui', '');
    button.addEventListener('click', onClick);
    parent.appendChild(button);
  }
}
