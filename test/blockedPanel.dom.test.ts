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
  return { world, events, root, panel };
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

  it('amenityPlaced/amenitySold invalidate without a tick (amenities Stage 1, MINOR 18)', () => {
    // Same paused-staleness rule as builds: amenity commands apply at speed 0,
    // so the panel must recompute on the events, not wait for the clock.
    const { world, events, root, panel } = fixture();
    const patient = world.spawnPatient('flu');
    patient.stage = { kind: 'waitingTriage' };
    world.tick();
    panel.update();
    expect(rows(root).some((l) => l.includes('Triage Bay'))).toBe(true);

    // Clear the need by DIRECT mutation — no event, no tick. The panel is
    // (correctly) stale: this proves the tick gate is closed, so the assertion
    // after the emit can only pass via the amenity-event invalidation.
    world.patients.delete(patient.id);
    panel.update();
    expect(rows(root).some((l) => l.includes('Triage Bay'))).toBe(true);

    events.emit('amenityPlaced', { col: 1, row: 1, kind: 'trashcan' });
    panel.update();
    expect(rows(root).some((l) => l.includes('Triage Bay'))).toBe(false);

    // amenitySold, same shape: recreate the need silently, then emit.
    const second = world.spawnPatient('flu');
    second.stage = { kind: 'waitingTriage' };
    panel.update();
    expect(rows(root).some((l) => l.includes('Triage Bay'))).toBe(false); // stale again

    events.emit('amenitySold', { col: 1, row: 1, kind: 'trashcan' });
    panel.update();
    expect(rows(root).some((l) => l.includes('Triage Bay'))).toBe(true);
  });

  it('messChanged/jobChanged invalidate without a tick (amenities Stage 2, §S2.1)', () => {
    // The Stage-1 paused-staleness rule extended: a geometry sweep deletes a
    // mess (and its job) inside a paused build command — the `role:evs` need
    // must recompute on the events, not wait for the clock.
    const { world, events, root, panel } = fixture();
    const patient = world.spawnPatient('flu');
    patient.stage = { kind: 'waitingTriage' };
    world.tick();
    panel.update();
    expect(rows(root).some((l) => l.includes('Triage Bay'))).toBe(true);

    // Clear the need by DIRECT mutation — no event, no tick. The panel stays
    // (correctly) stale, proving the tick gate is closed; the assertion after
    // each emit can only pass via that event's invalidation.
    world.patients.delete(patient.id);
    panel.update();
    expect(rows(root).some((l) => l.includes('Triage Bay'))).toBe(true);

    events.emit('messChanged', { col: 1, row: 1 });
    panel.update();
    expect(rows(root).some((l) => l.includes('Triage Bay'))).toBe(false);

    // jobChanged, same shape: recreate the need silently, then emit.
    const second = world.spawnPatient('flu');
    second.stage = { kind: 'waitingTriage' };
    panel.update();
    expect(rows(root).some((l) => l.includes('Triage Bay'))).toBe(false); // stale again

    events.emit('jobChanged', { jobId: 1 });
    panel.update();
    expect(rows(root).some((l) => l.includes('Triage Bay'))).toBe(true);
  });

  it('roomBroken invalidates without a tick (amenities Stage 3, §S3.6)', () => {
    // debugBreakRoom fires while paused — the broken-room row must appear on
    // the roomBroken event, not wait for the clock. Same proof shape as the
    // Stage-1/2 paused-staleness tests above.
    const { world, events, root, panel } = fixture();
    const patient = world.spawnPatient('flu');
    patient.stage = { kind: 'waitingTriage' };
    world.tick();
    panel.update();
    expect(rows(root).some((l) => l.includes('Triage Bay'))).toBe(true);

    // Clear the need by DIRECT mutation — no event, no tick. The panel stays
    // (correctly) stale, proving the tick gate is closed; the assertion after
    // the emit can only pass via the roomBroken invalidation.
    world.patients.delete(patient.id);
    panel.update();
    expect(rows(root).some((l) => l.includes('Triage Bay'))).toBe(true);

    events.emit('roomBroken', { roomId: 1 });
    panel.update();
    expect(rows(root).some((l) => l.includes('Triage Bay'))).toBe(false);
  });

  it('caps visible rows at 8 + a "+N more" tail (live-drive MAJOR 2: never occlude the inspect card)', () => {
    const { world, root, panel } = fixture();
    // A wide condition spread in a bare hospital produces well over 8 needs
    // (each condition's full chain: rooms + roles, plus check-in/triage).
    for (const condition of [
      'gallstones',
      'stroke',
      'kidneyFailure',
      'asthma',
      'fracture',
      'pneumonia',
    ] as const) {
      const p = world.spawnPatient(condition);
      p.stage = { kind: 'waiting' };
      p.acuity = 3;
    }
    world.tick();
    panel.update();
    const lines = rows(root);
    // Premise: the world genuinely wants more than the cap (else vacuous).
    const MAX_ROWS = 8;
    expect(lines.length).toBe(MAX_ROWS + 1);
    expect(lines[MAX_ROWS]).toMatch(/^\+\d+ more$/);
    // Urgent rows survive the cut — the tail drops upcoming rows only.
    expect(lines.slice(0, MAX_ROWS).some((l) => !l.startsWith('soon:') && !l.startsWith('+'))).toBe(
      true,
    );
  });
});
