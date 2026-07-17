import type { EventBus } from '../events';
import type { BottomBarDropdowns } from './bottomBar';

/** Capped scrollback (M3 ruling): the feed keeps the most recent 100 thoughts. */
const MAX_ENTRIES = 100;

/**
 * The thought log (GDD §9) — the RCT guest-thoughts analog. A pure projection
 * of `patientThought` events; entries are clickable jumps to where the
 * thought happened. Toggled by a 💭 button, coordinated by BottomBarDropdowns
 * (§9 mutual-exclusion ruling).
 */
export class ThoughtLog {
  private panel!: HTMLElement;
  private list!: HTMLElement;

  constructor(
    private events: EventBus,
    private onJump: (col: number, row: number) => void,
    private bottomBar: BottomBarDropdowns,
  ) {}

  mount(parent: HTMLElement, toggleHost: HTMLElement): void {
    this.panel = document.createElement('div');
    this.panel.id = 'thoughtlog';
    this.panel.setAttribute('data-ui', '');
    this.panel.classList.add('hidden');
    const title = document.createElement('h3');
    title.textContent = 'Patient thoughts';
    this.list = document.createElement('div');
    this.list.className = 'thought-list';
    this.panel.append(title, this.list);
    parent.appendChild(this.panel);

    const toggle = document.createElement('button');
    toggle.textContent = '💭 Thoughts';
    toggle.setAttribute('data-ui', '');
    toggleHost.appendChild(toggle);
    this.bottomBar.register(toggle, this.panel);

    this.events.on('patientThought', ({ name, text, col, row }) => {
      const entry = document.createElement('div');
      entry.className = 'thought';
      entry.setAttribute('data-ui', '');
      entry.title = 'Click to jump there';
      // textContent, not innerHTML — names/thoughts are data, never markup.
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = `${name}:`;
      const quote = document.createElement('em');
      quote.textContent = `“${text}”`;
      entry.append(who, ' ', quote);
      entry.addEventListener('click', () => this.onJump(col, row));
      this.list.prepend(entry);
      while (this.list.children.length > MAX_ENTRIES) this.list.lastChild?.remove();
    });
  }
}
