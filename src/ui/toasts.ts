import type { EventBus } from '../events';
import type { World } from '../sim/world';

const TOAST_LIFETIME_MS = 5000;
const MAX_TOASTS = 6;

/** Where a toast jumps: the live entity if it still exists, else the snapshot. */
interface JumpRef {
  patientId?: number;
  col: number;
  row: number;
}

/**
 * Top-right notification stack (GDD §9). Clicking a toast snaps the camera to
 * the entity/tile it references — events carry a `{col,row}` snapshot at emit
 * time, so a death toast outlives its (faded-out) patient (M3 ruling).
 */
export class Toasts {
  private root!: HTMLElement;

  constructor(
    private events: EventBus,
    private world: World,
    private onJump: (col: number, row: number) => void,
  ) {}

  mount(parent: HTMLElement): void {
    this.root = document.createElement('div');
    this.root.id = 'toasts';
    this.root.setAttribute('data-ui', '');
    parent.appendChild(this.root);

    this.events.on('patientDied', ({ name, condition, patientId, col, row }) =>
      this.show(`☠ ${name} has died (${condition})`, 'bad', { patientId, col, row }),
    );
    this.events.on('patientLeftAma', ({ name, patientId, col, row }) =>
      this.show(`💢 ${name} left without being seen`, 'warn', { patientId, col, row }),
    );
    this.events.on('patientDischarged', ({ name, totalBilled, patientId, col, row }) =>
      this.show(`💚 ${name} discharged (+$${totalBilled.toLocaleString()})`, 'good', {
        patientId,
        col,
        row,
      }),
    );
    this.events.on('patientComplication', ({ name, patientId, col, row }) =>
      this.show(`⚠ Complication treating ${name}`, 'warn', { patientId, col, row }),
    );
    this.events.on('patientLost', ({ name, patientId, col, row }) =>
      this.show(`❓ ${name} got lost`, 'warn', { patientId, col, row }),
    );
    this.events.on('staffHired', () => this.show('Staff member hired', 'info'));
    this.events.on('staffFired', () => this.show('Staff member let go', 'info'));
    this.events.on('hint', ({ message }) => this.show(`💡 ${message}`, 'warn'));
  }

  private show(message: string, kind: 'good' | 'warn' | 'bad' | 'info', jump?: JumpRef): void {
    const toast = document.createElement('div');
    toast.className = `toast ${kind}`;
    toast.textContent = message;
    if (jump) {
      toast.classList.add('jump');
      toast.setAttribute('data-ui', '');
      toast.title = 'Click to jump there';
      toast.addEventListener('click', () => {
        const live = jump.patientId === undefined ? undefined : this.world.patients.get(jump.patientId);
        const target = live ? live.at : jump;
        this.onJump(target.col, target.row);
      });
    }
    this.root.prepend(toast);
    while (this.root.children.length > MAX_TOASTS) this.root.lastChild?.remove();
    setTimeout(() => toast.remove(), TOAST_LIFETIME_MS);
  }
}
