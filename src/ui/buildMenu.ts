import type { CommandQueue } from '../commands';
import type { EventBus } from '../events';
import { AMENITY_DEFS, AMENITY_IDS, type AmenityId } from '../sim/data/amenities';
import { ROLE_DEFS } from '../sim/data/roles';
import {
  ROOM_DEFS,
  ROOM_TYPES,
  roomRetired,
  type RoomCategory,
  type RoomType,
} from '../sim/data/rooms';
import type { World } from '../sim/world';
import type { UiMode, WorldRenderer } from '../render/renderer';
import type { BottomBarDropdowns } from './bottomBar';
import { cssHexColor } from './dom';

/**
 * GDD §9 owner ruling: category groups render in exactly this order —
 * insertion order here IS the display order. The Record is the single
 * compile-checked source: a new RoomCategory fails to compile until it gets a
 * label, and the render loop iterates these keys, so nothing can be labeled
 * yet silently missing from the bar. Exported: the hospital directory groups
 * its room inventory by the SAME labels in the SAME order (one source).
 */
export const CATEGORY_LABELS: Record<RoomCategory, string> = {
  basics: 'Basics',
  imaging: 'Imaging',
  treatment: 'Treatment',
  comfort: 'Comfort',
};
const CATEGORIES = Object.keys(CATEGORY_LABELS) as RoomCategory[];

/**
 * Amenities live in the Comfort dropdown (AMENITIES_PLAN §3.4 — freestanding
 * comfort props beside the restroom). One-tile placeables, no staffedBy, no
 * size; rendered FROM AMENITY_DEFS (SSOT rule 1) after the category's rooms,
 * alphabetized with the same pinned-'en' convention as the room list.
 */
const AMENITY_CATEGORY: RoomCategory = 'comfort';

/**
 * Bottom bar: the room catalog as §9 category dropdowns (rendered FROM
 * ROOM_DEFS — SSOT rule 1; whatever the table contains is what shows), sell
 * toggle, debug spawn, and a hint line fed by the renderer + buildRejected.
 * Dropdown exclusivity lives in the BottomBarDropdowns coordinator.
 */
export class BuildMenu {
  private roomButtons = new Map<RoomType, HTMLButtonElement>();
  private amenityButtons = new Map<AmenityId, HTMLButtonElement>();
  private categoryButtons = new Map<RoomCategory, HTMLButtonElement>();
  /** Price spans, re-tinted on cashChanged (RCT-style affordability signal). */
  private costSpans = new Map<RoomType, HTMLElement>();
  private amenityCostSpans = new Map<AmenityId, HTMLElement>();
  private sellButton!: HTMLButtonElement;
  private hintEl!: HTMLElement;
  /** The hire panel registers this button with the coordinator. */
  staffButton!: HTMLButtonElement;

  constructor(
    private renderer: WorldRenderer,
    private commands: CommandQueue,
    private events: EventBus,
    private bottomBar: BottomBarDropdowns,
    /** Read-only: affordability tinting (owner ruling — red price, still
     *  clickable; the sim's placement validation stays the hard gate). */
    private world: World,
    /** Phase 2: a challenge run hides debug affordances (the spawn button) so
     *  the build bar carries no inert, comparability-breaking controls. */
    private challengeMode = false,
  ) {}

  mount(root: HTMLElement): void {
    const bar = document.createElement('div');
    bar.id = 'buildbar';
    bar.setAttribute('data-ui', '');

    for (const category of CATEGORIES) {
      // Rooms alphabetized by label within a category (owner request —
      // presentation only; the table stays the data SSOT). Category ORDER
      // still derives from CATEGORY_LABELS (§9 invariant). Empty categories
      // render nothing.
      // 'en' pinned: bare localeCompare collates per OS locale (review MINOR).
      // Retired types leave the catalog but stay loadable (DEPARTMENTS_PLAN
      // §3.3) — the fact is SSOT in sim/data/rooms.ts, never a UI flag.
      const types = ROOM_TYPES.filter(
        (type) => ROOM_DEFS[type].category === category && !roomRetired(type),
      ).sort(
        (a, b) => ROOM_DEFS[a].label.localeCompare(ROOM_DEFS[b].label, 'en'),
      );
      const hasAmenities = category === AMENITY_CATEGORY && AMENITY_IDS.length > 0;
      if (types.length === 0 && !hasAmenities) continue;
      bar.appendChild(this.categoryDropdown(category, types));
    }

    this.staffButton = BuildMenu.button('Staff'); // wired by HirePanel via the coordinator
    this.sellButton = BuildMenu.button('Sell', () => this.toggleSell());
    this.sellButton.classList.add('sell');
    bar.append(this.staffButton, this.sellButton);
    // Debug spawn button: omitted in challenge mode (the World would reject its
    // debugSpawnPatient anyway — no inert button, provably debug-free, §7).
    if (!this.challengeMode) {
      const spawn = BuildMenu.button('Spawn Patient', () =>
        this.commands.push({ type: 'debugSpawnPatient' }),
      );
      spawn.classList.add('debug');
      bar.appendChild(spawn);
    }

    this.hintEl = document.createElement('div');
    this.hintEl.id = 'hint';
    this.hintEl.setAttribute('data-ui', '');

    root.append(bar, this.hintEl);

    this.renderer.onModeChanged = (mode) => this.syncButtons(mode);
    this.renderer.onHint = (hint) => this.setHint(hint);
    this.events.on('buildRejected', ({ reason }) => this.setHint(reason));
    // Affordability tint (owner ruling — red price, still clickable, live):
    // entries stay selectable so a player can preview a room they're saving
    // toward; the sim's cash check at placement remains the hard gate.
    this.events.on('cashChanged', () => this.refreshAffordability());
    this.refreshAffordability();
  }

  private refreshAffordability(): void {
    for (const [type, span] of this.costSpans) {
      // Min-size price on purpose (see the catalog label note above); the
      // sized check happens in validateRoomRect against the live ghost.
      span.classList.toggle('unaffordable', ROOM_DEFS[type].cost > this.world.cash);
    }
    // Same owner ruling for amenities: red price, still clickable — the sim's
    // validateAmenityPlace cash check remains the hard gate.
    for (const [kind, span] of this.amenityCostSpans) {
      span.classList.toggle('unaffordable', AMENITY_DEFS[kind].cost > this.world.cash);
    }
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
      swatch.style.background = cssHexColor(def.floorColor);
      const label = document.createElement('span');
      label.className = 'room-label';
      label.textContent = def.label;
      const size = document.createElement('span');
      size.className = 'room-size';
      size.textContent = `${def.minCols}×${def.minRows}`;
      button.append(swatch, label);
      // Who runs the room (owner request: dialysis "hire a dialysis member"
      // confusion — the roles were invisible). Data-driven from staffedBy.
      if (def.staffedBy.length > 0) {
        const roles = document.createElement('span');
        roles.className = 'room-roles';
        // Neutral separator: staffedBy = "roles that can staff this room" —
        // some steps need all of them at once (surgery), others either-or
        // (exam), so neither '+' nor '/' would be honest for every room.
        roles.textContent = def.staffedBy.map((role) => ROLE_DEFS[role].label).join(', ');
        button.appendChild(roles);
      }
      const cost = document.createElement('span');
      cost.className = 'room-cost';
      // INTENTIONALLY the MIN-size price (CAPACITY_PLAN §6): `def.cost ===
      // priceOf(type, minRect)` (pinned by test/pricing.test.ts); the live
      // grown price shows in the placement hint line, not the catalog.
      cost.textContent = `$${def.cost.toLocaleString()}`;
      this.costSpans.set(type, cost);
      button.append(size, cost);
      panel.appendChild(button);
      this.roomButtons.set(type, button);
    }

    // Amenities (Stage 1): 1-tile roomless props after the category's rooms.
    // Deliberately simpler rows than rooms — no staffedBy roles (unstaffed by
    // definition), no size (always one tile); label + price only.
    if (category === AMENITY_CATEGORY) {
      const kinds = [...AMENITY_IDS].sort((a, b) =>
        AMENITY_DEFS[a].label.localeCompare(AMENITY_DEFS[b].label, 'en'),
      );
      for (const kind of kinds) {
        const def = AMENITY_DEFS[kind];
        const button = BuildMenu.button('', () => {
          this.toggleAmenity(kind);
          this.bottomBar.closeAll(); // same dismissal as picking a room tool
        });
        const label = document.createElement('span');
        label.className = 'room-label';
        label.textContent = def.label;
        const cost = document.createElement('span');
        cost.className = 'room-cost';
        cost.textContent = `$${def.cost.toLocaleString()}`;
        this.amenityCostSpans.set(kind, cost);
        button.append(label, cost);
        panel.appendChild(button);
        this.amenityButtons.set(kind, button);
      }
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

  /** Arm/disarm the 1-tile amenity placement mode (mirrors toggleBuild). */
  private toggleAmenity(kind: AmenityId): void {
    const current = this.renderer.mode;
    if (current.kind === 'placeAmenity' && current.amenity === kind) {
      this.renderer.setMode({ kind: 'idle' });
    } else {
      this.renderer.setMode({ kind: 'placeAmenity', amenity: kind });
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
    for (const [kind, button] of this.amenityButtons) {
      button.classList.toggle('active', mode.kind === 'placeAmenity' && mode.amenity === kind);
    }
    // With its dropdown closed, the category button still shows where the
    // active build tool lives (amenity tools light up their home category).
    for (const [category, button] of this.categoryButtons) {
      button.classList.toggle(
        'active',
        (mode.kind === 'build' && ROOM_DEFS[mode.type].category === category) ||
          (mode.kind === 'placeAmenity' && category === AMENITY_CATEGORY),
      );
    }
    this.sellButton.classList.toggle('active', mode.kind === 'sell');
  }

  private setHint(hint: string): void {
    this.hintEl.textContent = hint;
    this.hintEl.classList.toggle('visible', hint.length > 0);
  }
}
