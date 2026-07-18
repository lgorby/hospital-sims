// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { Command, CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import type { Selection, WorldRenderer } from '../src/render/renderer';
import { AMENITY_DEFS } from '../src/sim/data/amenities';
import { BALANCE } from '../src/sim/data/balance';
import { amenitySellback } from '../src/sim/formulas';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';
import { InspectPanel } from '../src/ui/inspect';

/**
 * Amenities Stage 1 — the inspect panel's new surfaces (AMENITIES_IMPL_PLAN
 * §1.11): the amenity card (label + effect + Sell via amenitySellback), the
 * restroom occupancy read from stallClaims (NOT reservations — review MINOR
 * 7), and the patient card's bladder/thirst meters. happy-dom, renderer and
 * commands faked at the type boundary like the other *.dom tests.
 */

function fixture() {
  const events = new EventBus();
  const world = new World(events, 42);
  setupNewGame(world);
  const pushed: Command[] = [];
  const commands = { push: (c: Command) => pushed.push(c) } as unknown as CommandQueue;
  const renderer = {
    selected: null as Selection | null,
    mode: { kind: 'idle' },
    setMode: () => {},
  } as unknown as WorldRenderer;
  const root = document.createElement('div');
  const panel = new InspectPanel(world, commands, renderer);
  panel.mount(root);
  return { world, events, pushed, renderer, root, panel };
}

function bodyText(root: HTMLElement): string {
  return [...root.querySelectorAll('#inspect .inspect-row, #inspect .inspect-name')]
    .map((el) => el.textContent ?? '')
    .join('|');
}

function actionButton(root: HTMLElement): HTMLButtonElement {
  const sell = [...root.querySelectorAll<HTMLButtonElement>('.inspect-action')].find((b) =>
    (b.textContent ?? '').startsWith('Sell'),
  );
  expect(sell).toBeDefined();
  return sell!;
}

describe('InspectPanel (amenities Stage 1)', () => {
  it('amenity card: label + effect line + Sell wired through amenitySellback', () => {
    const { world, pushed, renderer, root, panel } = fixture();
    world.amenities.set('3,4', { kind: 'vending', tile: { col: 3, row: 4 }, fill: 0 });
    renderer.selected = { kind: 'amenity', col: 3, row: 4 };
    panel.update();

    expect(root.querySelector('#inspect')!.classList.contains('hidden')).toBe(false);
    const text = bodyText(root);
    expect(text).toContain(AMENITY_DEFS.vending.label);
    // Price-per-use is the billFee SSOT number, never a literal.
    expect(text).toContain(`$${BALANCE.needs.vendingPrice} per use`);

    // The Sell label IS the formulas derivation (the sellbackAmount pattern).
    const sell = actionButton(root);
    expect(sell.textContent).toBe(`Sell (+$${amenitySellback('vending').toLocaleString()})`);
    sell.click();
    expect(pushed).toEqual([{ type: 'sellAmenity', col: 3, row: 4 }]);

    // Tile-identity liveness: the amenity vanishing hides the panel.
    world.amenities.delete('3,4');
    panel.update();
    expect(root.querySelector('#inspect')!.classList.contains('hidden')).toBe(true);
  });

  it('restroom occupancy reads stallClaims, not reservations (review MINOR 7)', () => {
    const { world, renderer, root, panel } = fixture();
    world.buildRoom('restroom', { col: 5, row: 20, cols: 2, rows: 3 }, { col: 7, row: 20 }, true);
    const room = [...world.rooms.values()].find((r) => r.type === 'restroom')!;
    const patient = world.spawnPatient('flu');
    // Reservations stay EMPTY for the self-service room — occupancy must come
    // from the claim scan. Track S's stub returns empty; feed a fake claim.
    vi.spyOn(world, 'stallClaims').mockImplementation((roomId: number) =>
      roomId === room.id ? new Map([[0, patient.id]]) : new Map(),
    );

    renderer.selected = { kind: 'room', id: room.id };
    panel.update();

    const text = bodyText(root);
    // 2×3 restroom derives exactly 2 stalls (perTiles 3, min 2 — §3.3).
    expect(text).toContain('Stalls');
    expect(text).toContain('1/2');
    expect(text).toContain('In use');
    expect(text).toContain(patient.name.short);
    expect(text).not.toContain('Treating');
  });

  it('staff duty line resolves a job duty to its kind via world.jobs (Stage 2 §S2.5)', () => {
    const { world, renderer, root, panel } = fixture();
    // Any role works — the duty line is role-agnostic (the hire panel is
    // data-driven; nothing here may reference the not-yet-landed evs literal).
    const member = world.addStaffMember('nurse', 3, 100, {
      first: 'Mo',
      last: 'Popov',
      full: 'Mo Popov',
      short: 'Mo P.',
    });
    // Feed a fake clean job — world.jobs is the real (frozen) map; Track S's
    // systems fill it in-game, the card only reads it.
    world.jobs.set(77, {
      id: 77,
      kind: 'clean',
      tile: { col: 4, row: 4 },
      staffId: member.id,
      phase: 'assigned',
      ticksRemaining: 0,
      holdUntil: 0,
    });
    member.duty = { kind: 'job', jobId: 77 };
    renderer.selected = { kind: 'staff', id: member.id };
    panel.update();
    expect(bodyText(root)).toContain('Cleaning');

    // The frozen format.ts fallback: a job deleted mid-frame must never crash
    // the card — the generic record label renders instead.
    world.jobs.delete(77);
    panel.update();
    const text = bodyText(root);
    expect(text).toContain('On a facilities job');
    expect(text).not.toContain('Cleaning');
  });

  it('trashcan card shows a live Fill N/capacity line (Stage 2 §S2.5, frame-polled)', () => {
    const { world, renderer, root, panel } = fixture();
    world.amenities.set('3,4', { kind: 'trashcan', tile: { col: 3, row: 4 }, fill: 3 });
    renderer.selected = { kind: 'amenity', col: 3, row: 4 };
    panel.update();
    // The denominator is the sim's overflow threshold (SSOT), never a literal.
    expect(bodyText(root)).toContain(`Fill3/${BALANCE.mess.trashcanCapacity}`);

    // Frame-polled: a sim-side fill bump shows on the next update, no event.
    world.amenities.get('3,4')!.fill = 4;
    panel.update();
    expect(bodyText(root)).toContain(`Fill4/${BALANCE.mess.trashcanCapacity}`);
  });

  it('patient card renders Bladder + Thirst meters after Patience', () => {
    const { world, renderer, root, panel } = fixture();
    const patient = world.spawnPatient('flu');
    patient.bladder = 40;
    patient.thirst = 20;
    renderer.selected = { kind: 'patient', id: patient.id };
    panel.update();

    const rows = [...root.querySelectorAll('#inspect .inspect-row')].map(
      (el) => el.textContent ?? '',
    );
    const patienceIdx = rows.findIndex((r) => r.includes('Patience'));
    const bladderIdx = rows.findIndex((r) => r.includes('Bladder'));
    const thirstIdx = rows.findIndex((r) => r.includes('Thirst'));
    expect(patienceIdx).toBeGreaterThanOrEqual(0);
    expect(bladderIdx).toBeGreaterThan(patienceIdx);
    expect(thirstIdx).toBeGreaterThan(bladderIdx);
    expect(rows[bladderIdx]).toContain('40');
    expect(rows[thirstIdx]).toContain('20');
  });
});
