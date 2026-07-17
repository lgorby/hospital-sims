import type { EventBus } from '../events';
import type { GameLoop, Speed } from '../loop';
import { CONDITION_DEFS } from '../sim/data/conditions';
import { isTextEditable } from './dom';
import { money } from './format';
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
    private seed: number,
  ) {}

  mount(hudRoot: HTMLElement, readoutRoot: HTMLElement): void {
    this.clockEl = Hud.chip(hudRoot, 'hud-clock');
    this.cashEl = Hud.chip(hudRoot, 'hud-cash');
    this.repEl = Hud.chip(hudRoot, 'hud-rep');
    this.tickEl = Hud.chip(hudRoot, 'hud-tick');
    // The seed is part of the new-game contract (M4): display it so a run can
    // be named, shared, and replayed via ?seed=.
    Hud.chip(hudRoot, 'hud-seed').textContent = `Seed ${this.seed}`;

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
    this.bindShortcuts();
  }

  /** M4 keyboard shortcuts: Space toggles pause, digits pick a speed. */
  private bindShortcuts(): void {
    let lastRunningSpeed: Speed = this.loop.speed === 0 ? 1 : this.loop.speed;
    this.events.on('speedChanged', ({ speed }) => {
      if (speed !== 0) lastRunningSpeed = speed;
    });
    window.addEventListener('keydown', (e) => {
      if (isTextEditable(e.target)) return;
      // A visible modal owns the clock (M4 review #3): shortcuts must not
      // unpause the sim behind the daily report / game-over overlay.
      if (document.querySelector('.modal-overlay:not(.hidden)')) return;
      if (e.key === ' ') {
        e.preventDefault(); // Space must not "click" the last-focused button
        this.loop.setSpeed(this.loop.speed === 0 ? lastRunningSpeed : 0);
        return;
      }
      for (const { value } of SPEEDS) {
        if (value !== 0 && e.key === String(value)) this.loop.setSpeed(value);
      }
    });
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
    // money() handles debt correctly ("−$20,080", not "$-20,080") — negative
    // cash is a first-class state now that bankruptcy exists (M4 review #9).
    this.cashEl.textContent = money(this.world.cash);
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
