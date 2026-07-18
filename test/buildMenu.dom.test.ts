// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { Command, CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import type { UiMode, WorldRenderer } from '../src/render/renderer';
import { AMENITY_DEFS, AMENITY_IDS } from '../src/sim/data/amenities';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';
import { BottomBarDropdowns } from '../src/ui/bottomBar';
import { BuildMenu } from '../src/ui/buildMenu';

/**
 * Amenities Stage 1 — the Comfort dropdown's amenity entries
 * (AMENITIES_IMPL_PLAN §1.11): rendered from AMENITY_DEFS, alphabetized with
 * the room-list 'en' convention, arming/disarming placeAmenity mode like room
 * tools, and live affordability tinting on cashChanged.
 */

function fixture() {
  const events = new EventBus();
  const world = new World(events, 42);
  setupNewGame(world);
  const pushed: Command[] = [];
  const commands = { push: (c: Command) => pushed.push(c) } as unknown as CommandQueue;
  const rendererImpl = {
    mode: { kind: 'idle' } as UiMode,
    onModeChanged: undefined as ((mode: UiMode) => void) | undefined,
    onHint: undefined as ((hint: string) => void) | undefined,
    setMode(mode: UiMode): void {
      this.mode = mode;
      this.onModeChanged?.(mode);
    },
  };
  const renderer = rendererImpl as unknown as WorldRenderer;
  const root = document.createElement('div');
  const menu = new BuildMenu(renderer, commands, events, new BottomBarDropdowns(), world);
  menu.mount(root);
  return { world, events, renderer: rendererImpl, root, menu };
}

/** The amenity entry buttons, in DOM order, keyed by their label span. */
function amenityEntries(root: HTMLElement): Map<string, HTMLButtonElement> {
  const labels = new Set<string>(AMENITY_IDS.map((k) => AMENITY_DEFS[k].label));
  const found = new Map<string, HTMLButtonElement>();
  for (const button of root.querySelectorAll<HTMLButtonElement>('.dropdown-panel button')) {
    const label = button.querySelector('.room-label')?.textContent ?? '';
    if (labels.has(label)) found.set(label, button);
  }
  return found;
}

describe('BuildMenu (amenities Stage 1)', () => {
  it('renders every AMENITY_DEFS entry in the Comfort dropdown, alphabetized, with its cost', () => {
    const { root } = fixture();
    const entries = amenityEntries(root);
    const expected = AMENITY_IDS.map((k) => AMENITY_DEFS[k].label).sort((a, b) =>
      a.localeCompare(b, 'en'),
    );
    // All present, and DOM order IS the alphabetized order (Map preserves it).
    expect([...entries.keys()]).toEqual(expected);
    for (const kind of AMENITY_IDS) {
      const button = entries.get(AMENITY_DEFS[kind].label)!;
      expect(button.querySelector('.room-cost')!.textContent).toBe(
        `$${AMENITY_DEFS[kind].cost.toLocaleString()}`,
      );
      // Amenity rows are deliberately simple: no size, no staffedBy roles.
      expect(button.querySelector('.room-size')).toBeNull();
      expect(button.querySelector('.room-roles')).toBeNull();
    }
  });

  it('clicking arms placeAmenity mode, highlights the entry, and re-clicking disarms', () => {
    const { renderer, root } = fixture();
    const vending = amenityEntries(root).get(AMENITY_DEFS.vending.label)!;

    vending.click();
    expect(renderer.mode).toEqual({ kind: 'placeAmenity', amenity: 'vending' });
    expect(vending.classList.contains('active')).toBe(true);

    vending.click(); // toggle off, matching room-entry behavior
    expect(renderer.mode).toEqual({ kind: 'idle' });
    expect(vending.classList.contains('active')).toBe(false);
  });

  it('tints unaffordable amenity prices on cashChanged but keeps them clickable', () => {
    const { world, events, renderer, root } = fixture();
    const entries = amenityEntries(root);
    const vendingCost = entries
      .get(AMENITY_DEFS.vending.label)!
      .querySelector<HTMLElement>('.room-cost')!;
    const trashcanCost = entries
      .get(AMENITY_DEFS.trashcan.label)!
      .querySelector<HTMLElement>('.room-cost')!;

    world.cash = AMENITY_DEFS.vending.cost - 1; // trashcan still affordable
    events.emit('cashChanged', { cash: world.cash });
    expect(vendingCost.classList.contains('unaffordable')).toBe(true);
    expect(trashcanCost.classList.contains('unaffordable')).toBe(false);

    // Owner ruling: red price, STILL clickable — arming works while broke.
    entries.get(AMENITY_DEFS.vending.label)!.click();
    expect(renderer.mode).toEqual({ kind: 'placeAmenity', amenity: 'vending' });
  });
});
