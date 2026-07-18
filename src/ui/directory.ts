import type { EventBus } from '../events';
import type { WorldRenderer } from '../render/renderer';
import { AMENITY_DEFS } from '../sim/data/amenities';
import { BALANCE } from '../sim/data/balance';
import { ROLE_DEFS, ROLE_IDS } from '../sim/data/roles';
import { PROP_STYLE, ROOM_DEFS, type RoomCategory } from '../sim/data/rooms';
import type { Room } from '../sim/entities/room';
import { roomEarns } from '../sim/formulas';
import type { World } from '../sim/world';
import type { BottomBarDropdowns, DropdownHandle } from './bottomBar';
import { CATEGORY_LABELS } from './buildMenu';
import { cssHexColor } from './dom';
import { money } from './format';

/**
 * The hospital directory (owner ask 2026-07-18: "a pullout … to see which
 * rooms and what is in the existing hospital … like an inventory list").
 * A right-side pullout (the thought-log slot — BottomBarDropdowns keeps the
 * two mutually exclusive) listing every built room by build-menu category
 * plus every placed amenity, each with a live status, and a staff head-count
 * line. Rows are click-to-jump AND click-to-select: the camera centers on
 * the room/amenity and the inspect card opens — the browse loop the owner
 * asked for.
 *
 * Reads World directly (never caches authoritative state); the DOM is
 * rebuilt only when the rendered content actually changed (the blockedPanel
 * idiom: tick-gated recompute + event invalidation for paused commands),
 * and only while the panel is open.
 */

/** Category display order = the build menu's (CATEGORY_LABELS is the ONE
 *  source — §9 invariant: insertion order is display order). */
const CATEGORIES = Object.keys(CATEGORY_LABELS) as RoomCategory[];

export class DirectoryPanel {
  private panel!: HTMLElement;
  private list!: HTMLElement;
  private handle!: DropdownHandle;
  private lastTick = -1;
  private lastRenderKey = '';

  constructor(
    private world: World,
    events: EventBus,
    private onJump: (col: number, row: number) => void,
    private renderer: WorldRenderer,
  ) {
    // Commands apply while PAUSED (build/sell/place/break via debug), so a
    // tick-gate alone would show a stale inventory at speed 0 — the same
    // invalidation list the blocked panel earned finding-by-finding.
    const invalidate = (): void => {
      this.lastTick = -1;
    };
    events.on('roomBuilt', invalidate);
    events.on('roomChanged', invalidate);
    events.on('roomSold', invalidate);
    events.on('roomBroken', invalidate);
    events.on('amenityPlaced', invalidate);
    events.on('amenitySold', invalidate);
    events.on('staffHired', invalidate);
    events.on('staffFired', invalidate);
  }

  mount(parent: HTMLElement, toggleHost: HTMLElement, bottomBar: BottomBarDropdowns): void {
    this.panel = document.createElement('div');
    this.panel.id = 'directory';
    this.panel.setAttribute('data-ui', '');
    this.panel.classList.add('hidden');
    const title = document.createElement('h3');
    title.textContent = 'Hospital directory';
    this.list = document.createElement('div');
    this.list.className = 'dir-list';
    this.panel.append(title, this.list);
    parent.appendChild(this.panel);

    const toggle = document.createElement('button');
    toggle.textContent = '🏥 Directory';
    toggle.setAttribute('data-ui', '');
    toggleHost.appendChild(toggle);
    // Rebuild on every open — the panel may have been closed through any
    // number of changes, and the open click is the natural refresh moment.
    this.handle = bottomBar.register(toggle, this.panel, () => {
      this.lastTick = -1;
      this.lastRenderKey = '';
      this.update();
    });
  }

  /** Live status, mirroring the inspect card's used-count semantics (SSOT:
   *  restroom stalls by claims, waiting seats by seated waiters, treatment
   *  slots by reservations; broken replaces the capacity readout — §S3.6). */
  private roomStatus(room: Room): string {
    if (room.brokenSince !== null) return 'Out of service';
    const rule = ROOM_DEFS[room.type].capacity;
    if (rule.kind === 'perProp') {
      const total = this.world.capacityOf(room);
      const used =
        room.type === 'restroom'
          ? this.world.stallClaims(room.id).size
          : room.type === 'waiting'
            ? [...this.world.patients.values()].filter((p) => p.waitingRoomId === room.id).length
            : this.world.reservationsOn(room.id).length;
      return `${rule.noun} ${used}/${total}`;
    }
    return this.world.reservationsOn(room.id).length > 0 ? 'In use' : '';
  }

  private amenityStatus(amenity: { kind: string; fill: number; tile: { col: number; row: number } }): string {
    if (amenity.kind === 'trashcan') {
      return `Fill ${amenity.fill}/${BALANCE.mess.trashcanCapacity}`;
    }
    if (amenity.kind === 'vending') {
      const key = `${amenity.tile.col},${amenity.tile.row}`;
      return this.world.vendingClaimedBy(key) !== null ? 'In use' : '';
    }
    return '';
  }

  /** One clickable row: swatch + name, dim status and earned-today value
   *  right-aligned. `earned` is the pre-RENDERED money string (never a raw
   *  float) — the same string the renderKey is built from, so what the key
   *  compares is exactly what the row shows. Empty for amenity rows. */
  private row(
    swatchColor: number,
    label: string,
    status: string,
    earned: string,
    onClick: () => void,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'dir-row';
    row.setAttribute('data-ui', '');
    row.title = 'Click to jump there';
    const swatch = document.createElement('span');
    swatch.className = 'dir-swatch';
    swatch.style.background = cssHexColor(swatchColor);
    const name = document.createElement('span');
    name.className = 'dir-name';
    name.textContent = label;
    const state = document.createElement('span');
    state.className = 'dir-status';
    state.textContent = status;
    row.append(swatch, name, state);
    if (earned !== '') {
      const value = document.createElement('span');
      value.className = 'dir-earned';
      value.textContent = earned;
      row.appendChild(value);
    }
    row.addEventListener('click', onClick);
    return row;
  }

  /** A category header, optionally carrying the department's earned-today
   *  subtotal (FINANCE_PLAN §5.2 — the inventory list doubles as the P&L
   *  browser). Pre-rendered like the row values, for the same reason. */
  private section(label: string, subtotal = ''): HTMLElement {
    const h = document.createElement('h4');
    h.className = 'dir-section';
    const name = document.createElement('span');
    name.textContent = label;
    h.appendChild(name);
    if (subtotal !== '') {
      const value = document.createElement('span');
      value.className = 'dir-subtotal';
      value.textContent = subtotal;
      h.appendChild(value);
    }
    return h;
  }

  /** Called from the render loop; a no-op while closed or unchanged. */
  update(): void {
    if (!this.handle.isOpen) return;
    if (this.world.clock.tick === this.lastTick) return;
    this.lastTick = this.world.clock.tick;

    const rooms = [...this.world.rooms.values()];
    const amenities = [...this.world.amenities.values()];
    const staffCounts = ROLE_IDS.map(
      (role) => [...this.world.staff.values()].filter((s) => s.role === role).length,
    );

    // §5.2 money columns, computed ONCE as their RENDERED money() strings: the
    // rows show them and the renderKey compares them. Keying on the raw float
    // instead would rebuild the whole list on every billed fee — and on
    // payroll's sub-cent dust, forever — churning DOM and hover state while
    // the panel is open (plan review MINOR 16). money() rounds, so a subtotal
    // can tick over while no single room's string does; both go in the key.
    // Only rooms that CAN bill carry a value (both reviews): a waiting room's
    // "$0" is not the RCT "this ride earns nothing" signal, it is a category
    // error repeated down the panel, and it contradicted the inspect card,
    // which gates the same information on `roomEarns`. Subtotals still sum
    // every room in the category — non-earners contribute 0, so no number
    // changes.
    const earnedByRoom = new Map<number, string>(
      rooms.filter((r) => roomEarns(r.type)).map((r) => [r.id, money(r.revenueToday)]),
    );
    const subtotals = new Map<RoomCategory, string>(
      CATEGORIES.map((category) => [
        category,
        money(
          rooms
            .filter((r) => ROOM_DEFS[r.type].category === category)
            .reduce((sum, r) => sum + r.revenueToday, 0),
        ),
      ]),
    );

    // Rebuild only on real change — not 10×/s forever (the blockedPanel rule).
    const renderKey = [
      rooms
        .map(
          (r) =>
            `${r.id}:${r.type}:${r.rect.cols}x${r.rect.rows}:${this.roomStatus(r)}:${earnedByRoom.get(r.id)}`,
        )
        .join('|'),
      [...subtotals.values()].join(','),
      amenities.map((a) => `${a.kind}@${a.tile.col},${a.tile.row}:${this.amenityStatus(a)}`).join('|'),
      staffCounts.join(','),
    ].join('||');
    if (renderKey === this.lastRenderKey) return;
    this.lastRenderKey = renderKey;

    this.list.replaceChildren();
    if (rooms.length === 0 && amenities.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dir-empty';
      empty.textContent = 'Nothing built yet — open Basics to start.';
      this.list.appendChild(empty);
      return;
    }

    for (const category of CATEGORIES) {
      const inCategory = rooms.filter((r) => ROOM_DEFS[r.type].category === category);
      if (inCategory.length === 0) continue;
      this.list.appendChild(this.section(CATEGORY_LABELS[category], subtotals.get(category)));
      for (const room of inCategory) {
        const def = ROOM_DEFS[room.type];
        this.list.appendChild(
          this.row(
            def.floorColor,
            `${def.label} ${room.rect.cols}×${room.rect.rows}`,
            this.roomStatus(room),
            earnedByRoom.get(room.id) ?? '',
            () => {
              this.onJump(
                room.rect.col + Math.floor(room.rect.cols / 2),
                room.rect.row + Math.floor(room.rect.rows / 2),
              );
              this.renderer.selected = { kind: 'room', id: room.id };
              // The glow covers the WHOLE footprint, not just the center
              // tile the jump pulsed (owner ask — single slot, this wins).
              this.renderer.pulseRect(room.rect);
            },
          ),
        );
      }
    }

    if (amenities.length > 0) {
      this.list.appendChild(this.section('Amenities'));
      for (const amenity of amenities) {
        this.list.appendChild(
          this.row(
            PROP_STYLE[amenity.kind].color,
            AMENITY_DEFS[amenity.kind].label,
            this.amenityStatus(amenity),
            '', // amenity income lives on its inspect card (§4.2), not here
            () => {
              this.onJump(amenity.tile.col, amenity.tile.row);
              this.renderer.selected = {
                kind: 'amenity',
                col: amenity.tile.col,
                row: amenity.tile.row,
              };
            },
          ),
        );
      }
    }

    const staffLine = ROLE_IDS.map((role, i) => ({ role, count: staffCounts[i]! }))
      .filter(({ count }) => count > 0)
      .map(({ role, count }) => `${count} ${ROLE_DEFS[role].label}${count > 1 ? 's' : ''}`)
      .join(' · ');
    if (staffLine !== '') {
      this.list.appendChild(this.section('Staff'));
      const line = document.createElement('div');
      line.className = 'dir-staff';
      line.textContent = staffLine;
      this.list.appendChild(line);
    }
  }
}
