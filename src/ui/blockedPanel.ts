import type { EventBus } from '../events';
import { computeBlockedNeeds } from '../sim/needs';
import type { World } from '../sim/world';

/**
 * Persistent "what's blocked" panel (HINTS_PLAN §2.3): the look-ahead surface.
 * Lists every unmet room/staff need — urgent rows plain, upcoming rows dimmed
 * with a "soon:" prefix — and hides itself entirely when nothing is blocked.
 * Row wording IS the need's `label` (single-sourced with the toasts).
 *
 * Mounted into `#leftstack` under the checklist. Reads World directly each
 * sim tick (never caches authoritative state); the DOM is rebuilt only when
 * the needs actually changed.
 */
/** Row cap (Stage-1 live-drive review MAJOR 2): unbounded, a busy early-game
 *  panel grew tall enough to physically cover — and CLICK-BLOCK — the inspect
 *  card's Expand/Sell buttons. Urgent rows sort first, so the cap drops only
 *  the least-pressing tail behind a "+N more" row; ui.css adds a max-height
 *  scroll as belt-and-suspenders. */
const MAX_VISIBLE_ROWS = 8;

export class BlockedPanel {
  private panel!: HTMLElement;
  private list!: HTMLElement;
  private lastTick = -1;
  private lastRenderKey = '';

  constructor(
    private world: World,
    events: EventBus,
  ) {
    // Commands apply while PAUSED (HANDOFF: "build while paused"), so a
    // tick-gate alone would leave the panel stale — building the missing room
    // at speed 0 would check off the checklist item while the panel beside it
    // still demanded it (review MINOR 3). Any roster/room change forces the
    // next update() to recompute regardless of the clock.
    const invalidate = (): void => {
      this.lastTick = -1;
    };
    events.on('roomBuilt', invalidate);
    events.on('roomChanged', invalidate); // expansions (pre-push review: the
    // moment needs read capacityOf, a missing listener = paused staleness)
    events.on('roomSold', invalidate);
    events.on('staffHired', invalidate);
    events.on('staffFired', invalidate);
    // Amenities Stage 1 (pre-impl MINOR 18): a vending machine placed/sold
    // while paused changes need computation the same way a room does.
    events.on('amenityPlaced', invalidate);
    events.on('amenitySold', invalidate);
    // Amenities Stage 2 (impl plan §S2.1): mess add/remove and job lifecycle
    // changes drive the `role:evs` need — both fire while paused (e.g. a
    // build-command geometry sweep deletes a mess at speed 0), so they join
    // the same invalidation list.
    events.on('messChanged', invalidate);
    events.on('jobChanged', invalidate);
    // Amenities Stage 3 (impl plan §S3.6): a breakdown (debugBreakRoom fires
    // while paused) must surface the broken:<roomId> row without a tick.
    // Repair-completion staleness is covered by jobChanged/roomChanged above.
    events.on('roomBroken', invalidate);
  }

  mount(parent: HTMLElement): void {
    this.panel = document.createElement('div');
    this.panel.id = 'blocked';
    this.panel.classList.add('hidden');
    this.panel.setAttribute('data-ui', '');
    const h = document.createElement('h3');
    h.textContent = 'Needs attention';
    this.list = document.createElement('div');
    this.panel.append(h, this.list);
    parent.appendChild(this.panel);
  }

  /** Called from the render loop (like Hud.update); cheap between sim ticks. */
  update(): void {
    if (this.world.clock.tick === this.lastTick) return;
    this.lastTick = this.world.clock.tick;
    const needs = computeBlockedNeeds(this.world);
    // Rebuild only on real change (labels or urgency) — not 10×/s forever.
    const renderKey = needs.map((n) => `${n.urgent ? '!' : '~'}${n.label}`).join('|');
    if (renderKey === this.lastRenderKey) return;
    this.lastRenderKey = renderKey;

    this.panel.classList.toggle('hidden', needs.length === 0);
    this.list.replaceChildren();
    for (const need of needs.slice(0, MAX_VISIBLE_ROWS)) {
      const row = document.createElement('div');
      row.className = need.urgent ? 'blocked-item' : 'blocked-item soon';
      row.textContent = need.urgent ? need.label : `soon: ${need.label}`;
      this.list.appendChild(row);
    }
    if (needs.length > MAX_VISIBLE_ROWS) {
      const more = document.createElement('div');
      more.className = 'blocked-item soon';
      more.textContent = `+${needs.length - MAX_VISIBLE_ROWS} more`;
      this.list.appendChild(more);
    }
  }
}
