/**
 * Title screen (M4 new-game flow): shown when the URL carries no seed.
 * "New Game" hands off to main.ts, which navigates to `?seed=<random>` —
 * a full reload is the teardown-free way to (re)boot a deterministic world.
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

    const start = document.createElement('button');
    start.textContent = 'New Game';
    start.className = 'modal-continue';
    start.setAttribute('data-ui', '');
    start.addEventListener('click', () => this.onNewGame());

    card.append(h1, tagline, start);
    overlay.appendChild(card);
    parent.appendChild(overlay);
  }
}
