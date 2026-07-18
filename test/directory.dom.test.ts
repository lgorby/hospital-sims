// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/events';
import type { Selection, WorldRenderer } from '../src/render/renderer';
import { BALANCE } from '../src/sim/data/balance';
import { World } from '../src/sim/world';
import { BottomBarDropdowns } from '../src/ui/bottomBar';
import { DirectoryPanel } from '../src/ui/directory';

/**
 * The hospital directory pullout (owner ask 2026-07-18): rooms by category
 * with live status, amenities, staff head-counts; rows jump + select.
 * happy-dom; renderer faked at the type boundary like the other *.dom tests.
 */

function fixture() {
  const events = new EventBus();
  const world = new World(events, 42);
  const jumps: { col: number; row: number }[] = [];
  const pulses: { col: number; row: number; cols: number; rows: number }[] = [];
  const renderer = {
    selected: null as Selection | null,
    pulseRect: (rect: { col: number; row: number; cols: number; rows: number }) =>
      pulses.push({ ...rect }),
  } as unknown as WorldRenderer;
  const root = document.createElement('div');
  const bar = document.createElement('div');
  const bottomBar = new BottomBarDropdowns();
  const panel = new DirectoryPanel(world, events, (col, row) => jumps.push({ col, row }), renderer);
  panel.mount(root, bar, bottomBar);
  const toggle = bar.querySelector('button')!;
  return { world, events, jumps, pulses, renderer, root, bar, panel, toggle };
}

function rows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.dir-row')];
}

function text(root: HTMLElement): string {
  return root.querySelector('#directory')!.textContent ?? '';
}

describe('DirectoryPanel (hospital inventory pullout)', () => {
  it('opens via the bottom-bar toggle and lists rooms by category with size + status', () => {
    const { world, root, toggle } = fixture();
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 11, row: 13 }, true);
    world.buildRoom('xray', { col: 20, row: 10, cols: 3, rows: 4 }, { col: 21, row: 14 }, true);

    expect(root.querySelector('#directory')!.classList.contains('hidden')).toBe(true);
    toggle.click(); // opens + rebuilds via the onOpen callback
    expect(root.querySelector('#directory')!.classList.contains('hidden')).toBe(false);

    const content = text(root);
    expect(content).toContain('Treatment'); // exam's category section
    expect(content).toContain('Imaging'); // xray's
    expect(content).toContain('Exam Room 3×3');
    expect(content).toContain('X-Ray 3×4');
    expect(rows(root).length).toBe(2);
  });

  it('clicking a room row jumps to its center, selects it, and pulses the footprint', () => {
    const { world, root, jumps, pulses, renderer, toggle } = fixture();
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 11, row: 13 }, true);
    const room = world.roomsOfType('exam')[0]!;
    toggle.click();

    rows(root)[0]!.click();
    expect(jumps).toEqual([{ col: 11, row: 11 }]); // rect center
    expect(renderer.selected).toEqual({ kind: 'room', id: room.id });
    // The glow covers the whole footprint (owner ask 2026-07-18).
    expect(pulses).toEqual([{ col: 10, row: 10, cols: 3, rows: 3 }]);
  });

  it('shows live capacity, broken, and amenity statuses', () => {
    const { world, root, toggle, jumps, renderer } = fixture();
    world.buildRoom('dialysis', { col: 10, row: 10, cols: 3, rows: 4 }, { col: 11, row: 14 }, true);
    world.buildRoom('xray', { col: 20, row: 10, cols: 3, rows: 4 }, { col: 21, row: 14 }, true);
    world.breakRoom(world.roomsOfType('xray')[0]!);
    world.amenities.set('5,5', { kind: 'trashcan', tile: { col: 5, row: 5 }, fill: 3 });
    toggle.click();

    const content = text(root);
    expect(content).toContain('Machines 0/2'); // dialysis min size derives 2
    expect(content).toContain('Out of service'); // broken xray
    expect(content).toContain('Amenities');
    expect(content).toContain(`Fill 3/${BALANCE.mess.trashcanCapacity}`);

    // Amenity rows jump AND select by tile identity (review MINOR 1 — the
    // click must be asserted, not just performed).
    const amenityRow = rows(root).find((r) => r.textContent!.includes('Trashcan'))!;
    amenityRow.click();
    expect(jumps).toContainEqual({ col: 5, row: 5 });
    expect(renderer.selected).toEqual({ kind: 'amenity', col: 5, row: 5 });
  });

  it('rebuilds on paused-command invalidation (roomSold while the clock is stopped)', () => {
    const { world, root, toggle, panel } = fixture();
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 11, row: 13 }, true);
    toggle.click();
    expect(text(root)).toContain('Exam Room');

    // Sell WITHOUT advancing the clock — the event invalidation must carry it.
    const queue = { drain: () => [{ type: 'sellRoom' as const, roomId: world.roomsOfType('exam')[0]!.id }], push: () => {} };
    world.applyCommands(queue as never);
    panel.update();
    expect(text(root)).not.toContain('Exam Room');
    expect(text(root)).toContain('Nothing built yet');
  });

  it('shows a staff head-count line and skips zero-count roles', () => {
    const { world, root, toggle } = fixture();
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 11, row: 13 }, true);
    world.addStaffMember('nurse', 3, 150);
    world.addStaffMember('nurse', 3, 150);
    world.addStaffMember('maintenance', 3, 140);
    toggle.click();

    const content = text(root);
    expect(content).toContain('Staff');
    expect(content).toContain('2 Nurses');
    expect(content).toContain('1 Maintenance Tech');
    expect(content).not.toContain('Doctor');
  });

  it('does no DOM work while closed', () => {
    const { world, root, panel } = fixture();
    world.buildRoom('exam', { col: 10, row: 10, cols: 3, rows: 3 }, { col: 11, row: 13 }, true);
    panel.update(); // closed — must not render rows
    expect(rows(root).length).toBe(0);
  });
});
