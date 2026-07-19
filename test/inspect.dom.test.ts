// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { Command, CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import type { Selection, WorldRenderer } from '../src/render/renderer';
import { AMENITY_DEFS } from '../src/sim/data/amenities';
import { BALANCE } from '../src/sim/data/balance';
import { amenitySellback, roomEarns } from '../src/sim/formulas';
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
    world.amenities.set('3,4', { kind: 'vending', tile: { col: 3, row: 4 }, fill: 0, revenueTotal: 0, revenueToday: 0 });
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
      roomId: null,
      staffId: member.id,
      phase: 'assigned',
      ticksRemaining: 0,
      holdUntil: 0,
    });
    member.duty = { kind: 'job', jobId: 77 };
    renderer.selected = { kind: 'staff', id: member.id };
    panel.update();
    // Stage-3 live-drive MINOR 2: an ASSIGNED (en-route) job reads as
    // walking, not working — "Cleaning" only once the timer runs.
    expect(bodyText(root)).toContain('Heading to a mess');
    world.jobs.get(77)!.phase = 'working';
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
    world.amenities.set('3,4', { kind: 'trashcan', tile: { col: 3, row: 4 }, fill: 3, revenueTotal: 0, revenueToday: 0 });
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

/**
 * Amenities Stage 3 — broken rooms on the inspect card (impl plan §S3.6):
 * the OUT OF SERVICE status line (pending/underway resolved from world.jobs
 * by roomId), the perProp capacity-line replacement, and the Expand button
 * disable. Fixtures poke `brokenSince` directly and insert Job objects into
 * the frozen world.jobs map — Track S's systems produce both in-game.
 */
describe('InspectPanel (amenities Stage 3 — broken rooms)', () => {
  function expandButton(root: HTMLElement): HTMLButtonElement {
    const expand = [...root.querySelectorAll<HTMLButtonElement>('.inspect-action')].find((b) =>
      (b.textContent ?? '').startsWith('Expand'),
    );
    expect(expand).toBeDefined();
    return expand!;
  }

  function buildXray(world: World) {
    world.buildRoom('xray', { col: 5, row: 20, cols: 3, rows: 4 }, { col: 8, row: 20 }, true);
    const room = [...world.rooms.values()].find((r) => r.type === 'xray');
    expect(room).toBeDefined();
    return room!;
  }

  it('broken single-capacity room shows OUT OF SERVICE — repair pending (no-job edge)', () => {
    const { world, renderer, root, panel } = fixture();
    const room = buildXray(world);
    room.brokenSince = 5;
    renderer.selected = { kind: 'room', id: room.id };
    panel.update();

    const text = bodyText(root);
    expect(text).toContain('OUT OF SERVICE — repair pending');
    expect(text).not.toContain('repair underway');
  });

  it('a working repair job in world.jobs flips the line to repair underway', () => {
    const { world, renderer, root, panel } = fixture();
    const room = buildXray(world);
    room.brokenSince = 5;
    world.jobs.set(91, {
      id: 91,
      kind: 'repair',
      tile: { col: 5, row: 20 },
      roomId: room.id,
      staffId: 1,
      phase: 'working',
      ticksRemaining: 10,
      holdUntil: 0,
    });
    renderer.selected = { kind: 'room', id: room.id };
    panel.update();
    expect(bodyText(root)).toContain('OUT OF SERVICE — repair underway');

    // queued/assigned phases still read pending — only 'working' is underway.
    world.jobs.get(91)!.phase = 'assigned';
    panel.update();
    expect(bodyText(root)).toContain('OUT OF SERVICE — repair pending');
  });

  it('broken restroom: OUT OF SERVICE REPLACES the Stalls line; In use keeps rendering', () => {
    const { world, renderer, root, panel } = fixture();
    world.buildRoom('restroom', { col: 5, row: 20, cols: 2, rows: 3 }, { col: 7, row: 20 }, true);
    const room = [...world.rooms.values()].find((r) => r.type === 'restroom')!;
    const patient = world.spawnPatient('flu');
    // An in-flight claimant legitimately finishes while broken (§S3.6).
    vi.spyOn(world, 'stallClaims').mockImplementation((roomId: number) =>
      roomId === room.id ? new Map([[0, patient.id]]) : new Map(),
    );
    renderer.selected = { kind: 'room', id: room.id };
    panel.update();
    expect(bodyText(root)).toContain('Stalls'); // healthy baseline

    room.brokenSince = 5;
    panel.update();
    const text = bodyText(root);
    expect(text).toContain('OUT OF SERVICE — repair pending');
    expect(text).not.toContain('Stalls');
    expect(text).toContain('In use');
    expect(text).toContain(patient.name.short);
  });

  it('Expand button disabled with the reason while broken, re-enabled on repair (frame-polled)', () => {
    const { world, renderer, root, panel } = fixture();
    const room = buildXray(world);
    renderer.selected = { kind: 'room', id: room.id };
    panel.update();
    expect(expandButton(root).disabled).toBe(false);
    expect(expandButton(root).textContent).toBe('Expand');

    room.brokenSince = 5;
    panel.update();
    const button = expandButton(root);
    expect(button.disabled).toBe(true);
    // The reason mirrors validateRoomExpand's reject string.
    expect(button.textContent).toContain('Out of service — repair it first');

    // Repair completion clears brokenSince — the button must recover WITHOUT
    // a selection change (per-frame re-set, not wireAction-only).
    room.brokenSince = null;
    panel.update();
    expect(expandButton(root).disabled).toBe(false);
    expect(expandButton(root).textContent).toBe('Expand');
  });
});

/**
 * FINANCE_PLAN §4 / §11.11 — the per-unit Income block (our RCT ride-window
 * Income tab). Rooms that can bill get income today / total / patients seen;
 * everything else renders no block at all. Vending machines get their own
 * lifetime line, so a machine nobody walks past is visibly dead.
 */
describe('InspectPanel (FINANCE_PLAN §4 — per-unit income)', () => {
  /** The Income rows' label→value pairs, in render order. */
  function incomeRows(root: HTMLElement): [string, string][] {
    return [...root.querySelectorAll('#inspect .inspect-row.income')].map((row) => {
      const spans = row.querySelectorAll('span');
      return [spans[0]!.textContent ?? '', spans[1]!.textContent ?? ''];
    });
  }

  it('an earning room shows Income today / Income total / Patients seen, frame-polled', () => {
    const { world, renderer, root, panel } = fixture();
    world.buildRoom('xray', { col: 5, row: 20, cols: 3, rows: 4 }, { col: 8, row: 20 }, true);
    const room = [...world.rooms.values()].find((r) => r.type === 'xray')!;
    expect(roomEarns(room.type)).toBe(true); // premise, not vacuous

    renderer.selected = { kind: 'room', id: room.id };
    panel.update();
    // A never-used earning room reads $0 — the RCT "this ride earns nothing"
    // read, which is the whole point of showing the block on a dead room.
    expect(incomeRows(root)).toEqual([
      ['Income today', '$0'],
      ['Income total', '$0'],
      ['Patients seen', '0'],
    ]);

    // Frame-polled like every other line on the card: a sim-side credit shows
    // on the next update with no event.
    room.revenueToday = 450;
    room.revenueTotal = 3900;
    room.visitsTotal = 17;
    panel.update();
    expect(incomeRows(root)).toEqual([
      ['Income today', '$450'],
      ['Income total', '$3,900'],
      ['Patients seen', '17'],
    ]);
  });

  it('"Patients seen" counts STEPS, never discharges — the label must not say Treated', () => {
    const { world, renderer, root, panel } = fixture();
    world.buildRoom('exam', { col: 5, row: 20, cols: 3, rows: 3 }, { col: 8, row: 20 }, true);
    const room = [...world.rooms.values()].find((r) => r.type === 'exam')!;
    room.visitsTotal = 2;
    renderer.selected = { kind: 'room', id: room.id };
    panel.update();
    const text = bodyText(root);
    expect(text).toContain('Patients seen');
    // A 2-step patient credits two rooms once each; borrowing the
    // treated/lifetimeTreated (= DISCHARGES) vocabulary here would be a lie.
    expect(text).not.toContain('Treated');
  });

  it('a non-earning room renders NO Income block (not a permanent $0)', () => {
    const { world, renderer, root, panel } = fixture();
    world.buildRoom('waiting', { col: 5, row: 20, cols: 3, rows: 3 }, { col: 8, row: 20 }, true);
    const room = [...world.rooms.values()].find((r) => r.type === 'waiting')!;
    expect(roomEarns(room.type)).toBe(false); // premise
    renderer.selected = { kind: 'room', id: room.id };
    panel.update();
    expect(incomeRows(root)).toEqual([]);
    expect(bodyText(root)).not.toContain('Income');
  });

  it('vending machines show Income total; trashcans and plants show none (§4.2)', () => {
    const { world, renderer, root, panel } = fixture();
    world.amenities.set('3,4', {
      kind: 'vending',
      tile: { col: 3, row: 4 },
      fill: 0,
      revenueTotal: 220,
      revenueToday: 0,
    });
    world.amenities.set('6,4', {
      kind: 'trashcan',
      tile: { col: 6, row: 4 },
      fill: 0,
      revenueTotal: 0,
      revenueToday: 0,
    });
    world.amenities.set('9,4', { kind: 'plant', tile: { col: 9, row: 4 }, fill: 0, revenueTotal: 0, revenueToday: 0 });

    renderer.selected = { kind: 'amenity', col: 3, row: 4 };
    panel.update();
    expect(incomeRows(root)).toEqual([['Income total', '$220']]);

    // A machine nobody walks past reads $0 — visibly dead, by design.
    world.amenities.get('3,4')!.revenueTotal = 0;
    panel.update();
    expect(incomeRows(root)).toEqual([['Income total', '$0']]);

    for (const tile of [
      { col: 6, row: 4 },
      { col: 9, row: 4 },
    ]) {
      renderer.selected = { kind: 'amenity', ...tile };
      panel.update();
      expect(incomeRows(root)).toEqual([]);
      expect(bodyText(root)).not.toContain('Income');
    }
  });
});
