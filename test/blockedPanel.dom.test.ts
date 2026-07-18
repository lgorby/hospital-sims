// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/events';
import { ROLE_DEFS } from '../src/sim/data/roles';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';
import { BlockedPanel } from '../src/ui/blockedPanel';

/** Hints milestone — the persistent panel (HINTS_PLAN §2.3), happy-dom. */

function fixture() {
  const events = new EventBus();
  const world = new World(events, 42);
  setupNewGame(world);
  const root = document.createElement('div');
  const panel = new BlockedPanel(world, events);
  panel.mount(root);
  return { world, root, panel };
}

function rows(root: HTMLElement): string[] {
  return [...root.querySelectorAll('.blocked-item')].map((el) => el.textContent ?? '');
}

describe('BlockedPanel', () => {
  it('hides when nothing is blocked, shows urgent + "soon:" rows when needs exist', () => {
    const { world, root, panel } = fixture();
    panel.update();
    expect(root.querySelector('#blocked')!.classList.contains('hidden')).toBe(true);

    // A gallstones patient waiting on an unbuilt ultrasound: urgent current-step
    // needs + upcoming surgery-chain needs (the look-ahead surface).
    const patient = world.spawnPatient('gallstones');
    patient.stage = { kind: 'waiting' };
    patient.acuity = 3;
    world.tick(); // advance the clock so update() recomputes
    panel.update();

    const blocked = root.querySelector('#blocked')!;
    expect(blocked.classList.contains('hidden')).toBe(false);
    const lines = rows(root);
    expect(lines.some((l) => l.startsWith('Build an Ultrasound'))).toBe(true);
    expect(lines).toContain('soon: Build an Operating Room — needed for Gallstones');
    expect(lines).toContain('soon: Hire a Surgeon — needed for Gallstones');
    // Urgent rows sort before upcoming rows.
    const firstSoon = lines.findIndex((l) => l.startsWith('soon:'));
    expect(lines.slice(firstSoon).every((l) => l.startsWith('soon:'))).toBe(true);
  });

  it('leaves the DOM untouched across ticks when needs are unchanged, updates when one clears', () => {
    const { world, root, panel } = fixture();
    const patient = world.spawnPatient('gallstones');
    patient.stage = { kind: 'waiting' };
    patient.acuity = 3;
    world.tick();
    panel.update();
    const firstRow = root.querySelector('.blocked-item');
    expect(firstRow).not.toBeNull();

    world.tick(); // needs unchanged — same rows, same NODES (no rebuild)
    panel.update();
    expect(root.querySelector('.blocked-item')).toBe(firstRow);

    // Hire the surgeon: its need clears on the next recompute.
    world.addStaffMember('surgeon', 3, ROLE_DEFS.surgeon.salaryPerDay, {
      first: 'Sam',
      last: 'Cutter',
      full: 'Sam Cutter',
      short: 'Sam C.',
    });
    world.tick();
    panel.update();
    expect(rows(root).some((l) => l.includes('Hire a Surgeon'))).toBe(false);
  });

  it('a build WHILE PAUSED refreshes the panel without a tick (review MINOR 3)', () => {
    // Commands apply at speed 0 — the checklist checks off instantly, so the
    // panel beside it must not keep demanding the just-built room until unpause.
    const { world, root, panel } = fixture();
    const patient = world.spawnPatient('flu');
    patient.stage = { kind: 'waitingTriage' };
    world.tick();
    panel.update();
    expect(rows(root).some((l) => l.includes('Triage Bay'))).toBe(true);

    // Paused: NO tick between the build and the next render update.
    world.buildRoom('triage', { col: 5, row: 20, cols: 2, rows: 2 }, { col: 7, row: 20 }, true);
    panel.update();
    expect(rows(root).some((l) => l.includes('Triage Bay'))).toBe(false);
  });
});
