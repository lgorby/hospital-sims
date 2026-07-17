import type { EventBus } from '../events';
import type { GameLoop, Speed } from '../loop';
import { CONDITION_DEFS } from '../sim/data/conditions';
import { isModalOpen, isTextEditable } from './dom';
import { money, patientStageLabel } from './format';
import type { WorldRenderer } from '../render/renderer';
import type { World } from '../sim/world';

const SPEEDS: { value: Speed; label: string }[] = [
  { value: 0, label: '⏸' },
  { value: 1, label: '1×' },
  { value: 2, label: '2×' },
  { value: 3, label: '3×' },
];

/**
 * Write-if-changed text cell: update() runs every frame, and unconditional
 * textContent writes measured as costly as the whole Pixi actor sync
 * (2026-07-17 QA profile) — the browser doesn't dedupe them for us.
 */
class CachedText {
  private last: string | null = null;
  constructor(private readonly el: HTMLElement) {}
  set(text: string): void {
    if (text === this.last) return;
    this.last = text;
    this.el.textContent = text;
  }
}

/**
 * DOM overlay HUD — a pure projection of World state (tech plan §3.1 rule 3):
 * continuous values (clock, cash, tick) are polled each frame; speed buttons
 * react to the speedChanged event.
 */
export class Hud {
  private clockEl!: CachedText;
  private cashEl!: CachedText;
  private repEl!: CachedText;
  private tickEl!: CachedText;
  private readoutEl!: CachedText;
  private speedButtons = new Map<Speed, HTMLButtonElement>();

  constructor(
    private world: World,
    private loop: GameLoop,
    private renderer: WorldRenderer,
    private events: EventBus,
  ) {}

  mount(hudRoot: HTMLElement, readoutRoot: HTMLElement): void {
    this.clockEl = new CachedText(Hud.chip(hudRoot, 'hud-clock'));
    this.cashEl = new CachedText(Hud.chip(hudRoot, 'hud-cash'));
    this.repEl = new CachedText(Hud.chip(hudRoot, 'hud-rep'));
    this.tickEl = new CachedText(Hud.chip(hudRoot, 'hud-tick'));
    // The seed is part of the new-game contract (M4): display it so a run can
    // be named, shared, and replayed via ?seed=. Read from the World (the
    // authoritative field) — a loaded save carries its original seed.
    Hud.chip(hudRoot, 'hud-seed').textContent = `Seed ${this.world.seed}`;

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

    this.readoutEl = new CachedText(readoutRoot);
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
      if (isModalOpen()) return;
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
    this.clockEl.set(this.world.clock.display);
    // money() handles debt correctly ("−$20,080", not "$-20,080") — negative
    // cash is a first-class state now that bankruptcy exists (M4 review #9).
    this.cashEl.set(money(this.world.cash));
    this.repEl.set(`Rep ${Math.round(this.world.reputation)}`);
    this.tickEl.set(`tick ${this.world.clock.tick}`);

    const parts: string[] = [];
    const hovered = this.renderer.hoveredTile;
    if (hovered) parts.push(`(${hovered.col}, ${hovered.row})`);
    const selectedId = this.renderer.selectedPatientId;
    const selected = selectedId === null ? undefined : this.world.patients.get(selectedId);
    if (selected) {
      // Same raw-identifier leak as the inspect panel (QA nit) — one label map.
      const phase =
        selected.stage.kind === 'reserved'
          ? this.world.reservations.get(selected.stage.reservationId)?.phase
          : undefined;
      parts.push(
        `${selected.name.full}, ${selected.age} — ${CONDITION_DEFS[selected.condition].label}` +
          ` · ${patientStageLabel(selected.stage, phase)}` +
          ` · ❤${Math.ceil(selected.health)} ☺${Math.ceil(selected.patience)}`,
      );
    }
    this.readoutEl.set(parts.join('   '));
  }
}
