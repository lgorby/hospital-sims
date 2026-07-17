import type { EventBus } from '../events';
import type { GameLoop, Speed } from '../loop';
import type { WorldRenderer } from '../render/renderer';
import type { World } from '../sim/world';

const SPEEDS: { value: Speed; label: string }[] = [
  { value: 0, label: '⏸' },
  { value: 1, label: '1×' },
  { value: 2, label: '2×' },
  { value: 3, label: '3×' },
];

/**
 * DOM overlay HUD — a pure projection of World state (tech plan §3.1 rule 3):
 * continuous values (clock, cash, tick) are polled each frame; speed buttons
 * react to the speedChanged event.
 */
export class Hud {
  private clockEl!: HTMLElement;
  private cashEl!: HTMLElement;
  private tickEl!: HTMLElement;
  private readoutEl!: HTMLElement;
  private speedButtons = new Map<Speed, HTMLButtonElement>();

  constructor(
    private world: World,
    private loop: GameLoop,
    private renderer: WorldRenderer,
    private events: EventBus,
  ) {}

  mount(hudRoot: HTMLElement, readoutRoot: HTMLElement): void {
    this.clockEl = Hud.chip(hudRoot, 'hud-clock');
    this.cashEl = Hud.chip(hudRoot, 'hud-cash');
    this.tickEl = Hud.chip(hudRoot, 'hud-tick');

    const speedGroup = document.createElement('div');
    speedGroup.className = 'speed-group';
    speedGroup.setAttribute('data-ui', '');
    for (const { value, label } of SPEEDS) {
      const button = document.createElement('button');
      button.textContent = label;
      button.setAttribute('data-ui', '');
      button.addEventListener('click', () => {
        this.loop.setSpeed(value);
        // Drop focus so keyboard camera pan isn't swallowed by the button.
        button.blur();
      });
      speedGroup.appendChild(button);
      this.speedButtons.set(value, button);
    }
    hudRoot.appendChild(speedGroup);

    this.readoutEl = readoutRoot;
    this.events.on('speedChanged', ({ speed }) => this.markActiveSpeed(speed));
    this.markActiveSpeed(this.loop.speed);
  }

  private static chip(parent: HTMLElement, className: string): HTMLElement {
    const el = document.createElement('span');
    el.className = `hud-chip ${className}`;
    el.setAttribute('data-ui', '');
    parent.appendChild(el);
    return el;
  }

  private markActiveSpeed(speed: Speed): void {
    for (const [value, button] of this.speedButtons) {
      button.classList.toggle('active', value === speed);
    }
  }

  /** Polled once per frame by the loop's render callback. */
  update(): void {
    this.clockEl.textContent = this.world.clock.display;
    this.cashEl.textContent = `$${this.world.cash.toLocaleString()}`;
    this.tickEl.textContent = `tick ${this.world.clock.tick}`;
    const hovered = this.renderer.hoveredTile;
    this.readoutEl.textContent = hovered ? `(${hovered.col}, ${hovered.row})` : '';
  }
}
