import type { EventBus } from '../events';
import type { GameLoop, Speed } from '../loop';
import { CONDITION_DEFS } from '../sim/data/conditions';
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
  private repEl!: HTMLElement;
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
    this.repEl = Hud.chip(hudRoot, 'hud-rep');
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
    this.cashEl.textContent = `$${Math.floor(this.world.cash).toLocaleString()}`;
    this.repEl.textContent = `Rep ${Math.round(this.world.reputation)}`;
    this.tickEl.textContent = `tick ${this.world.clock.tick}`;

    const parts: string[] = [];
    const hovered = this.renderer.hoveredTile;
    if (hovered) parts.push(`(${hovered.col}, ${hovered.row})`);
    const selectedId = this.renderer.selectedPatientId;
    const selected = selectedId === null ? undefined : this.world.patients.get(selectedId);
    if (selected) {
      parts.push(
        `${selected.name.full}, ${selected.age} — ${CONDITION_DEFS[selected.condition].label}` +
          ` · ${selected.stage.kind} · ❤${Math.ceil(selected.health)} ☺${Math.ceil(selected.patience)}`,
      );
    }
    this.readoutEl.textContent = parts.join('   ');
  }
}
