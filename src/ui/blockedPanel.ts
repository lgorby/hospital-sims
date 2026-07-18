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
    for (const need of needs) {
      const row = document.createElement('div');
      row.className = need.urgent ? 'blocked-item' : 'blocked-item soon';
      row.textContent = need.urgent ? need.label : `soon: ${need.label}`;
      this.list.appendChild(row);
    }
  }
}
