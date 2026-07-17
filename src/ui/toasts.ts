import type { EventBus } from '../events';

const TOAST_LIFETIME_MS = 5000;
const MAX_TOASTS = 6;

/** Top-right notification stack (GDD §9). Click-to-jump camera lands in M3. */
export class Toasts {
  private root!: HTMLElement;

  constructor(private events: EventBus) {}

  mount(parent: HTMLElement): void {
    this.root = document.createElement('div');
    this.root.id = 'toasts';
    this.root.setAttribute('data-ui', '');
    parent.appendChild(this.root);

    this.events.on('patientDied', ({ name, condition }) =>
      this.show(`☠ ${name} has died (${condition})`, 'bad'),
    );
    this.events.on('patientLeftAma', ({ name }) =>
      this.show(`💢 ${name} left without being seen`, 'warn'),
    );
    this.events.on('patientDischarged', ({ name, totalBilled }) =>
      this.show(`💚 ${name} discharged (+$${totalBilled.toLocaleString()})`, 'good'),
    );
    this.events.on('patientComplication', ({ name }) =>
      this.show(`⚠ Complication treating ${name}`, 'warn'),
    );
    this.events.on('staffHired', () => this.show('Staff member hired', 'info'));
    this.events.on('staffFired', () => this.show('Staff member let go', 'info'));
    this.events.on('hint', ({ message }) => this.show(`💡 ${message}`, 'warn'));
  }

  private show(message: string, kind: 'good' | 'warn' | 'bad' | 'info'): void {
    const toast = document.createElement('div');
    toast.className = `toast ${kind}`;
    toast.textContent = message;
    this.root.prepend(toast);
    while (this.root.children.length > MAX_TOASTS) this.root.lastChild?.remove();
    setTimeout(() => toast.remove(), TOAST_LIFETIME_MS);
  }
}
