// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/events';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';
import { Checklist } from '../src/ui/checklist';

/**
 * Stage-1 live-drive review MAJOR 1 regression: vending revenue rides the
 * same `billFee` choke point as treatment fees, and a $5 soda sale was
 * checking off "Treat your first patient" on a hospital that had treated
 * nobody. The `feeBilled` event now carries a source discriminator and the
 * checklist completes 'treat' only on `source: 'treatment'`.
 */

function fixture() {
  const events = new EventBus();
  const world = new World(events, 42);
  setupNewGame(world);
  const root = document.createElement('div');
  const checklist = new Checklist(world, events);
  checklist.mount(root);
  return { world, root };
}

function treatRow(root: HTMLElement): HTMLElement {
  const row = [...root.querySelectorAll('.check-item')].find((el) =>
    (el.textContent ?? '').includes('Treat your first patient'),
  );
  expect(row, 'the treat checklist row exists').toBeDefined();
  return row as HTMLElement;
}

describe('Checklist × feeBilled source (live-drive MAJOR 1)', () => {
  it('a vending sale does NOT complete "Treat your first patient"; a treatment fee does', () => {
    const { world, root } = fixture();
    expect(treatRow(root).classList.contains('checked')).toBe(false);

    // End-to-end through the real choke point: the vending path bills with
    // source 'vending' (patientNeeds completion), which must be ignored.
    world.billFee(5, 'Vending', 'vending');
    expect(treatRow(root).classList.contains('checked')).toBe(false);

    // The treatment path uses the default source and must complete it.
    world.billFee(100, 'Exam');
    expect(treatRow(root).classList.contains('checked')).toBe(true);
  });
});
