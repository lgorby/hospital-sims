import type { CommandQueue } from '../commands';
import type { EventBus } from '../events';
import { ROOM_DEFS, ROOM_TYPES, type RoomCategory, type RoomType } from '../sim/data/rooms';
import type { UiMode, WorldRenderer } from '../render/renderer';
import type { BottomBarDropdowns } from './bottomBar';

const HEX_RADIX = 16;
const CSS_HEX_DIGITS = 6;

/**
 * GDD §9 owner ruling: category groups render in exactly this order —
 * insertion order here IS the display order. The Record is the single
 * compile-checked source: a new RoomCategory fails to compile until it gets a
 * label, and the render loop iterates these keys, so nothing can be labeled
 * yet silently missing from the bar.
 */
const CATEGORY_LABELS: Record<RoomCategory, string> = {
  basics: 'Basics',
  imaging: 'Imaging',
  treatment: 'Treatment',
  comfort: 'Comfort',
};
const CATEGORIES = Object.keys(CATEGORY_LABELS) as RoomCategory[];

/**
 * Bottom bar: the room catalog as §9 category dropdowns (rendered FROM
 * ROOM_DEFS — SSOT rule 1; whatever the table contains is what shows), sell
 * toggle, debug spawn, and a hint line fed by the renderer + buildRejected.
 * Dropdown exclusivity lives in the BottomBarDropdowns coordinator.
 */
export class BuildMenu {
  private roomButtons = new Map<RoomType, HTMLButtonElement>();
  private categoryButtons = new Map<RoomCategory, HTMLButtonElement>();
  private sellButton!: HTMLButtonElement;
  private hintEl!: HTMLElement;
  /** The hire panel registers this button with the coordinator. */
  staffButton!: HTMLButtonElement;

  constructor(
    private renderer: WorldRenderer,
    private commands: CommandQueue,
    private events: EventBus,
    private bottomBar: BottomBarDropdowns,
  ) {}

  mount(root: HTMLElement): void {
    const bar = document.createElement('div');
    bar.id = 'buildbar';
    bar.setAttribute('data-ui', '');

    for (const category of CATEGORIES) {
      // Table order within a category (§9); an empty category renders nothing.
      const types = ROOM_TYPES.filter((type) => ROOM_DEFS[type].category === category);
      if (types.length === 0) continue;
      bar.appendChild(this.categoryDropdown(category, types));
    }

    this.staffButton = BuildMenu.button('Staff'); // wired by HirePanel via the coordinator
    this.sellButton = BuildMenu.button('Sell', () => this.toggleSell());
    this.sellButton.classList.add('sell');
    const spawn = BuildMenu.button('Spawn Patient', () =>
      this.commands.push({ type: 'debugSpawnPatient' }),
    );
    spawn.classList.add('debug');
    bar.append(this.staffButton, this.sellButton, spawn);

    this.hintEl = document.createElement('div');
    this.hintEl.id = 'hint';
    this.hintEl.setAttribute('data-ui', '');

    root.append(bar, this.hintEl);

    this.renderer.onModeChanged = (mode) => this.syncButtons(mode);
    this.renderer.onHint = (hint) => this.setHint(hint);
    this.events.on('buildRejected', ({ reason }) => this.setHint(reason));
  }

  /** One §9 category group: a toggle button plus its dropdown of room entries. */
  private categoryDropdown(category: RoomCategory, types: readonly RoomType[]): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'dropdown-wrap';

    const toggle = BuildMenu.button(`${CATEGORY_LABELS[category]} ▾`);
    const panel = document.createElement('div');
    panel.className = 'dropdown-panel hidden';
    panel.setAttribute('data-ui', '');

    for (const type of types) {
      const def = ROOM_DEFS[type];
      const button = BuildMenu.button('', () => {
        this.toggleBuild(type);
        // Picking a tool dismisses the catalog — ghost preview and hint take over.
        this.bottomBar.closeAll();
      });
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = `#${def.floorColor.toString(HEX_RADIX).padStart(CSS_HEX_DIGITS, '0')}`;
      const label = document.createElement('span');
      label.className = 'room-label';
      label.textContent = def.label;
      const size = document.createElement('span');
      size.className = 'room-size';
      size.textContent = `${def.minCols}×${def.minRows}`;
      button.append(swatch, label, size, `$${def.cost.toLocaleString()}`);
      panel.appendChild(button);
      this.roomButtons.set(type, button);
    }

    wrap.append(toggle, panel);
    this.bottomBar.register(toggle, panel);
    this.categoryButtons.set(category, toggle);
    return wrap;
  }

  private static button(label: string, onClick?: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.setAttribute('data-ui', '');
    if (label) button.textContent = label;
    if (onClick) {
      button.addEventListener('click', () => {
        onClick();
        button.blur();
      });
    }
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
    this.bottomBar.closeAll(); // a mode swap shouldn't leave a panel floating over it
  }

  private syncButtons(mode: UiMode): void {
    for (const [type, button] of this.roomButtons) {
      button.classList.toggle('active', mode.kind === 'build' && mode.type === type);
    }
    // With its dropdown closed, the category button still shows where the
    // active build tool lives.
    for (const [category, button] of this.categoryButtons) {
      button.classList.toggle(
        'active',
        mode.kind === 'build' && ROOM_DEFS[mode.type].category === category,
      );
    }
    this.sellButton.classList.toggle('active', mode.kind === 'sell');
  }

  private setHint(hint: string): void {
    this.hintEl.textContent = hint;
    this.hintEl.classList.toggle('visible', hint.length > 0);
  }
}
