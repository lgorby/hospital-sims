import type { CommandQueue } from '../commands';
import type { EventBus } from '../events';
import { ROOM_DEFS, ROOM_TYPES, type RoomType } from '../sim/data/rooms';
import type { UiMode, WorldRenderer } from '../render/renderer';

const HEX_RADIX = 16;
const CSS_HEX_DIGITS = 6;

/**
 * Bottom bar: room catalog (rendered FROM ROOM_DEFS — SSOT rule 1), sell
 * toggle, debug spawn, and a hint line fed by the renderer + buildRejected.
 */
export class BuildMenu {
  private buttons = new Map<string, HTMLButtonElement>();
  private hintEl!: HTMLElement;

  constructor(
    private renderer: WorldRenderer,
    private commands: CommandQueue,
    private events: EventBus,
  ) {}

  mount(root: HTMLElement): void {
    const bar = document.createElement('div');
    bar.id = 'buildbar';
    bar.setAttribute('data-ui', '');

    for (const type of ROOM_TYPES) {
      const def = ROOM_DEFS[type];
      const button = this.addButton(bar, `room:${type}`, '', () => this.toggleBuild(type));
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = `#${def.floorColor.toString(HEX_RADIX).padStart(CSS_HEX_DIGITS, '0')}`;
      button.append(swatch, `${def.label} $${def.cost.toLocaleString()}`);
    }

    this.addButton(bar, 'sell', 'Sell', () => this.toggleSell()).classList.add('sell');
    this.addButton(bar, 'spawn', 'Spawn Patient', () =>
      this.commands.push({ type: 'debugSpawnPatient' }),
    ).classList.add('debug');

    this.hintEl = document.createElement('div');
    this.hintEl.id = 'hint';
    this.hintEl.setAttribute('data-ui', '');

    root.append(bar, this.hintEl);

    this.renderer.onModeChanged = (mode) => this.syncButtons(mode);
    this.renderer.onHint = (hint) => this.setHint(hint);
    this.events.on('buildRejected', ({ reason }) => this.setHint(reason));
  }

  private addButton(
    parent: HTMLElement,
    key: string,
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.setAttribute('data-ui', '');
    if (label) button.textContent = label;
    button.addEventListener('click', () => {
      onClick();
      button.blur();
    });
    parent.appendChild(button);
    this.buttons.set(key, button);
    return button;
  }

  private toggleBuild(type: RoomType): void {
    const current = this.renderer.mode;
    if (current.kind === 'build' && current.type === type) {
      this.renderer.setMode({ kind: 'idle' });
    } else {
      this.renderer.setMode({ kind: 'build', type });
    }
  }

  private toggleSell(): void {
    this.renderer.setMode(this.renderer.mode.kind === 'sell' ? { kind: 'idle' } : { kind: 'sell' });
  }

  private syncButtons(mode: UiMode): void {
    for (const [key, button] of this.buttons) {
      const active =
        (mode.kind === 'build' && key === `room:${mode.type}`) ||
        (mode.kind === 'sell' && key === 'sell');
      button.classList.toggle('active', active);
    }
  }

  private setHint(hint: string): void {
    this.hintEl.textContent = hint;
    this.hintEl.classList.toggle('visible', hint.length > 0);
  }
}
