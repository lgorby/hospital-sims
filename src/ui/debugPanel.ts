import type { CommandQueue } from '../commands';
import type { WorldRenderer } from '../render/renderer';
import { TICKS_PER_DAY } from '../sim/clock';

const HOURS_PER_DAY = 24;
const SPAWN_BATCH = 5;

/**
 * Dev-only panel (tech plan M2): backtick toggles it. Interactive balancing
 * starts here, not at M4.
 */
export class DebugPanel {
  private panel!: HTMLElement;

  constructor(
    private renderer: WorldRenderer,
    private commands: CommandQueue,
  ) {}

  mount(parent: HTMLElement): void {
    this.panel = document.createElement('div');
    this.panel.id = 'debugpanel';
    this.panel.setAttribute('data-ui', '');
    this.panel.classList.add('hidden');

    const title = document.createElement('h3');
    title.textContent = 'Debug';
    this.panel.appendChild(title);

    this.button('Spawn flu patient', () => this.commands.push({ type: 'debugSpawnPatient' }));
    this.button('Spawn 5 flu patients', () => {
      for (let i = 0; i < SPAWN_BATCH; i++) this.commands.push({ type: 'debugSpawnPatient' });
    });
    this.button('Force death (selected)', () => this.force('death'));
    this.button('Force AMA (selected)', () => this.force('ama'));
    this.button('Force complication (selected)', () => this.force('complication'));
    this.button('Fast-forward 1 hour', () =>
      this.commands.push({ type: 'debugFastForward', ticks: TICKS_PER_DAY / HOURS_PER_DAY }),
    );
    this.button('Fast-forward 1 day', () =>
      this.commands.push({ type: 'debugFastForward', ticks: TICKS_PER_DAY }),
    );
    this.button('Toggle walkability overlay', () => {
      this.renderer.showWalkOverlay = !this.renderer.showWalkOverlay;
    });

    parent.appendChild(this.panel);

    window.addEventListener('keydown', (e) => {
      if (e.key !== '`') return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))
      ) {
        return;
      }
      this.panel.classList.toggle('hidden');
    });
  }

  private force(outcome: 'death' | 'ama' | 'complication'): void {
    const patientId = this.renderer.selectedPatientId;
    if (patientId !== null) this.commands.push({ type: 'debugForce', patientId, outcome });
  }

  private button(label: string, onClick: () => void): void {
    const button = document.createElement('button');
    button.textContent = label;
    button.setAttribute('data-ui', '');
    button.addEventListener('click', () => {
      onClick();
      button.blur();
    });
    this.panel.appendChild(button);
  }
}
