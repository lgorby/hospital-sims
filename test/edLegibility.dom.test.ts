// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { Command, CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { gameMinutesToTicks } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import type { Selection, WorldRenderer } from '../src/render/renderer';
import { ROLE_DEFS } from '../src/sim/data/roles';
import { ROOM_DEFS } from '../src/sim/data/rooms';
import type { Reservation } from '../src/sim/entities/staff';
import { staffRatioFor } from '../src/sim/formulas';
import { setupNewGame } from '../src/sim/newGame';
import type { World } from '../src/sim/world';
import { World as WorldClass } from '../src/sim/world';
import { BlockedPanel } from '../src/ui/blockedPanel';
import { InspectPanel } from '../src/ui/inspect';

/**
 * ED epic Stage B1 §5 — the three legibility surfaces (both pre-implementation
 * reviews returned these as MAJOR: the mechanic was not merely invisible, the
 * UI reported the OPPOSITE of reality). happy-dom; renderer and commands faked
 * at the type boundary like the other *.dom tests. Reservations are poked into
 * the frozen `world.reservations` map the way inspect.dom.test.ts pokes
 * `world.jobs` — Track S's dispatcher produces them in-game.
 */

function fixture() {
  const events = new EventBus();
  const world = new WorldClass(events, 42);
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

function buttonStartingWith(root: HTMLElement, prefix: string): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>('.inspect-action')].find((b) =>
    (b.textContent ?? '').startsWith(prefix),
  );
  expect(button).toBeDefined();
  return button!;
}

/** A 3×4 ER — the minimum build, which Stage B1's density derives 2 bays from. */
function buildEr(world: World) {
  world.buildRoom('er', { col: 5, row: 20, cols: 3, rows: 4 }, { col: 8, row: 20 }, true);
  const room = [...world.rooms.values()].find((r) => r.type === 'er');
  expect(room).toBeDefined();
  return room!;
}

function buildExam(world: World) {
  world.buildRoom('exam', { col: 12, row: 20, cols: 3, rows: 3 }, { col: 15, row: 20 }, true);
  return [...world.rooms.values()].find((r) => r.type === 'exam')!;
}

function hire(world: World, role: Parameters<World['addStaffMember']>[0], short: string) {
  return world.addStaffMember(role, 3, ROLE_DEFS[role].salaryPerDay, {
    first: short,
    last: 'Test',
    full: `${short} Test`,
    short: `${short} T.`,
  });
}

let nextReservationId = 900;

/** Poke a live reservation into the world (the dispatcher's product). */
function reserve(
  world: World,
  roomId: number,
  patientId: number,
  staffIds: number[],
  phase: Reservation['phase'],
  slotIndex = 0,
): Reservation {
  const reservation: Reservation = {
    id: (nextReservationId += 1),
    kind: 'treatment',
    patientId,
    roomId,
    staffIds,
    stepIndex: 0,
    slotIndex,
    phase,
    ticksRemaining: 100,
    patientWaitingSince: null,
  };
  world.reservations.set(reservation.id, reservation);
  return reservation;
}

describe('ED B1 §5.1 — the duty label stops lying', () => {
  it('a panel of gathering + active reads "Treating 2 patients", not "Walking to a patient"', () => {
    const { world, renderer, root, panel } = fixture();
    const room = buildEr(world);
    const nurse = hire(world, 'nurse', 'Ada');
    const p1 = world.spawnPatient('laceration');
    const p2 = world.spawnPatient('laceration');
    // The witness is the GATHERING one — precisely the state that used to
    // render "Walking to a patient" while the nurse stood still, mid-treatment.
    const gathering = reserve(world, room.id, p1.id, [nurse.id], 'gathering', 0);
    reserve(world, room.id, p2.id, [nurse.id], 'active', 1);
    nurse.duty = { kind: 'reserved', reservationId: gathering.id };

    renderer.selected = { kind: 'staff', id: nurse.id };
    panel.update();
    const text = bodyText(root);
    expect(text).toContain('Treating 2 patients');
    expect(text).not.toContain('Walking to a patient');
  });

  it('a panel of 2 gathering reads "Walking to 2 patients" — no treatment is claimed', () => {
    const { world, renderer, root, panel } = fixture();
    const room = buildEr(world);
    const nurse = hire(world, 'nurse', 'Ada');
    const p1 = world.spawnPatient('laceration');
    const p2 = world.spawnPatient('laceration');
    const first = reserve(world, room.id, p1.id, [nurse.id], 'gathering', 0);
    reserve(world, room.id, p2.id, [nurse.id], 'gathering', 1);
    nurse.duty = { kind: 'reserved', reservationId: first.id };

    renderer.selected = { kind: 'staff', id: nurse.id };
    panel.update();
    expect(bodyText(root)).toContain('Walking to 2 patients');
  });

  it('N == 1 keeps today’s wording exactly (every non-ratio room, by construction)', () => {
    const { world, renderer, root, panel } = fixture();
    const room = buildExam(world);
    const doctor = hire(world, 'doctor', 'Ben');
    const patient = world.spawnPatient('flu');
    const only = reserve(world, room.id, patient.id, [doctor.id], 'gathering');
    doctor.duty = { kind: 'reserved', reservationId: only.id };
    renderer.selected = { kind: 'staff', id: doctor.id };
    panel.update();
    expect(bodyText(root)).toContain('Walking to a patient');

    only.phase = 'active';
    panel.update();
    const text = bodyText(root);
    expect(text).toContain('Treating a patient');
    expect(text).not.toContain('patients');
  });

  it('a reservation deleted mid-frame does not crash the card (the frozen fallback)', () => {
    const { world, renderer, root, panel } = fixture();
    const room = buildExam(world);
    const doctor = hire(world, 'doctor', 'Ben');
    const patient = world.spawnPatient('flu');
    const only = reserve(world, room.id, patient.id, [doctor.id], 'active');
    doctor.duty = { kind: 'reserved', reservationId: only.id };
    renderer.selected = { kind: 'staff', id: doctor.id };
    panel.update();
    world.reservations.delete(only.id);
    panel.update();
    expect(bodyText(root)).toContain('Walking to a patient');
  });
});

describe('ED B1 §5.2 — load readouts', () => {
  it('staff card shows "ER Bay 2/4" from staffRatioFor, frame-polled', () => {
    const { world, renderer, root, panel } = fixture();
    const room = buildEr(world);
    const nurse = hire(world, 'nurse', 'Ada');
    const ratio = staffRatioFor('er', 'nurse');
    expect(ratio).toBeGreaterThan(1); // premise, not vacuous
    const p1 = world.spawnPatient('laceration');
    const p2 = world.spawnPatient('laceration');
    const first = reserve(world, room.id, p1.id, [nurse.id], 'active', 0);
    reserve(world, room.id, p2.id, [nurse.id], 'active', 1);
    nurse.duty = { kind: 'reserved', reservationId: first.id };

    renderer.selected = { kind: 'staff', id: nurse.id };
    panel.update();
    expect(bodyText(root)).toContain(`Panel${ROOM_DEFS.er.label} 2/${ratio}`);

    // Frame-polled like every other card field: a release shows next update.
    world.reservations.delete(first.id);
    panel.update();
    expect(bodyText(root)).toContain(`Panel${ROOM_DEFS.er.label} 1/${ratio}`);
  });

  it('a 1:1 room renders NO panel line — no "(1/1)" noise on every card', () => {
    const { world, renderer, root, panel } = fixture();
    const room = buildExam(world);
    expect(staffRatioFor('exam', 'doctor')).toBe(1); // premise
    const doctor = hire(world, 'doctor', 'Ben');
    const patient = world.spawnPatient('flu');
    const only = reserve(world, room.id, patient.id, [doctor.id], 'active');
    doctor.duty = { kind: 'reserved', reservationId: only.id };
    renderer.selected = { kind: 'staff', id: doctor.id };
    panel.update();
    expect(bodyText(root)).not.toContain('Panel');
  });

  it('room card shows per-staffer load per role: "1 nurse (2/4) · 1 doctor (1/4)"', () => {
    const { world, renderer, root, panel } = fixture();
    const room = buildEr(world);
    const nurse = hire(world, 'nurse', 'Ada');
    const doctor = hire(world, 'doctor', 'Ben');
    const nurseRatio = staffRatioFor('er', 'nurse');
    const doctorRatio = staffRatioFor('er', 'doctor');
    const p1 = world.spawnPatient('laceration');
    const p2 = world.spawnPatient('chestPain');
    reserve(world, room.id, p1.id, [nurse.id], 'active', 0);
    reserve(world, room.id, p2.id, [nurse.id, doctor.id], 'active', 1);

    renderer.selected = { kind: 'room', id: room.id };
    panel.update();
    const text = bodyText(root);
    expect(text).toContain(
      `Staffing1 doctor (1/${doctorRatio}) · 1 nurse (2/${nurseRatio})`,
    );
  });

  it('two staffers of one role are listed individually and id-sorted', () => {
    const { world, renderer, root, panel } = fixture();
    const room = buildEr(world);
    const first = hire(world, 'nurse', 'Ada');
    const second = hire(world, 'nurse', 'Bo');
    expect(second.id).toBeGreaterThan(first.id); // premise for the sort
    const ratio = staffRatioFor('er', 'nurse');
    const p1 = world.spawnPatient('laceration');
    const p2 = world.spawnPatient('laceration');
    const p3 = world.spawnPatient('laceration');
    reserve(world, room.id, p1.id, [first.id], 'active', 0);
    reserve(world, room.id, p2.id, [first.id], 'active', 1);
    reserve(world, room.id, p3.id, [second.id], 'active', 0);

    renderer.selected = { kind: 'room', id: room.id };
    panel.update();
    expect(bodyText(root)).toContain(`Staffing2 nurses (2/${ratio}, 1/${ratio})`);
  });

  it('a 1:1 room card renders no Staffing line at all', () => {
    const { world, renderer, root, panel } = fixture();
    const room = buildExam(world);
    const doctor = hire(world, 'doctor', 'Ben');
    const patient = world.spawnPatient('flu');
    reserve(world, room.id, patient.id, [doctor.id], 'active');
    renderer.selected = { kind: 'room', id: room.id };
    panel.update();
    expect(bodyText(root)).not.toContain('Staffing');
  });
});

describe('ED B1 §5.3 — Close / Reopen and the busy reject', () => {
  it('Close pushes setRoomClosed, Reopen pushes the inverse (read at click time)', () => {
    const { world, pushed, renderer, root, panel } = fixture();
    const room = buildEr(world);
    renderer.selected = { kind: 'room', id: room.id };
    panel.update();

    buttonStartingWith(root, 'Close').click();
    expect(pushed).toEqual([{ type: 'setRoomClosed', roomId: room.id, closed: true }]);

    // The flag is re-read on every click — no captured stale value, and no
    // re-selection needed for the button to invert.
    room.closed = true;
    panel.update();
    buttonStartingWith(root, 'Reopen').click();
    expect(pushed[1]).toEqual({ type: 'setRoomClosed', roomId: room.id, closed: false });
  });

  it('CLOSED — draining while reservations live, CLOSED once empty; capacity line replaced', () => {
    const { world, renderer, root, panel } = fixture();
    const room = buildEr(world);
    const nurse = hire(world, 'nurse', 'Ada');
    const patient = world.spawnPatient('laceration');
    const active = reserve(world, room.id, patient.id, [nurse.id], 'active', 0);
    renderer.selected = { kind: 'room', id: room.id };
    panel.update();
    expect(bodyText(root)).toContain('Beds'); // healthy baseline

    world.setRoomClosed(room.id, true);
    panel.update();
    let text = bodyText(root);
    expect(text).toContain('CLOSED — draining');
    // capacityOf reads 0 while closed — a draining "Beds 1/0" is exactly the
    // confusion the status line exists to prevent.
    expect(text).not.toContain('Beds');
    expect(buttonStartingWith(root, 'Reopen').textContent).toBe('Reopen — still draining');

    world.reservations.delete(active.id);
    panel.update();
    text = bodyText(root);
    expect(text).toContain('CLOSED');
    expect(text).not.toContain('draining');
    expect(buttonStartingWith(root, 'Reopen').textContent).toBe('Reopen');
  });

  it('the busy Expand reject is legible next to Close, and clears once drained', () => {
    const { world, renderer, root, panel } = fixture();
    const room = buildEr(world);
    const nurse = hire(world, 'nurse', 'Ada');
    const patient = world.spawnPatient('laceration');
    const active = reserve(world, room.id, patient.id, [nurse.id], 'active', 0);
    renderer.selected = { kind: 'room', id: room.id };
    panel.update();

    // The reject mirrors validateRoomExpand's string — previously invisible
    // until the player had already dragged a rect.
    const expand = buttonStartingWith(root, 'Expand');
    expect(expand.textContent).toContain('Room is busy — wait for treatments to finish');
    expect(expand.disabled).toBe(true);
    // …and the gesture that resolves it names the outcome, right beside it.
    expect(buttonStartingWith(root, 'Close').textContent).toBe(
      'Close — stop new patients so it can drain',
    );

    // Drain: Expand recovers WITHOUT a re-selection (per-frame re-set).
    world.reservations.delete(active.id);
    panel.update();
    expect(buttonStartingWith(root, 'Expand').textContent).toBe('Expand');
    expect(buttonStartingWith(root, 'Expand').disabled).toBe(false);
  });

  it('a broken room cannot be closed — the button says why instead of dead-clicking', () => {
    const { world, renderer, root, panel } = fixture();
    const room = buildEr(world);
    room.brokenSince = 5;
    renderer.selected = { kind: 'room', id: room.id };
    panel.update();
    const close = buttonStartingWith(root, 'Close');
    // setRoomClosed is a no-op on a broken room — never invite the click.
    expect(close.disabled).toBe(true);
    expect(close.textContent).toContain('Out of service — repair it first');
    // Broken wins the status line: "repair it" is the only actionable state.
    expect(bodyText(root)).toContain('OUT OF SERVICE');
  });

  it('non-room selections render no Close button', () => {
    const { world, renderer, root, panel } = fixture();
    const patient = world.spawnPatient('flu');
    renderer.selected = { kind: 'patient', id: patient.id };
    panel.update();
    const visible = [...root.querySelectorAll<HTMLButtonElement>('.inspect-action')].filter(
      (b) => b.style.display !== 'none',
    );
    expect(visible.map((b) => b.textContent)).not.toContain('Close');
  });
});

/**
 * ED B1 §5.3 — the shortage scan. The rows come from `sim/needs.ts`'s
 * `capacityNeeds` (kind: 'capacity'), so panel and toasts single-source their
 * wording and the availability test cannot drift from `availableStaff`.
 * A shortage is only reported once a patient has actually been stuck for
 * `capacityHintWaitGameMinutes` — every 1:1 room is briefly "all staff busy"
 * between patients, and that transient must never surface as a hire hint.
 */
describe('ED B1 §5.3 — capacity needs on the BlockedPanel', () => {
  function panelFixture() {
    const events = new EventBus();
    const world = new WorldClass(events, 42);
    setupNewGame(world);
    const root = document.createElement('div');
    const blocked = new BlockedPanel(world, events);
    blocked.mount(root);
    return { world, events, root, blocked };
  }

  function rows(root: HTMLElement): string[] {
    return [...root.querySelectorAll('.blocked-item')].map((el) => el.textContent ?? '');
  }

  /** Back-date the wait clock past `capacityHintWaitGameMinutes` — a shortage
   *  is a SUSTAINED block, not a staffer mid-walk. */
  function blockedLongEnough(world: WorldClass, patient: { waitingSince: number | null }): void {
    patient.waitingSince =
      world.clock.tick - gameMinutesToTicks(BALANCE.dispatcher.capacityHintWaitGameMinutes) - 1;
  }

  it('every bay held ⇒ expand, named with the room capacity noun', () => {
    const { world, root, blocked } = panelFixture();
    const room = buildEr(world);
    const nurse = hire(world, 'nurse', 'Ada');
    const bays = world.capacityOf(room);
    for (let slot = 0; slot < bays; slot++) {
      const p = world.spawnPatient('laceration');
      reserve(world, room.id, p.id, [nurse.id], 'active', slot);
    }
    const waiting = world.spawnPatient('laceration');
    waiting.stage = { kind: 'waiting' };
    blockedLongEnough(world, waiting);
    world.tick();
    blocked.update();

    const lines = rows(root);
    // The ER's capacity noun is "Beds", so the remedy says beds — a hardcoded
    // "bays" was wrong for dialysis (Machines) and the waiting room (Seats).
    expect(lines).toContain(`${ROOM_DEFS.er.label} is full — expand it to add beds`);
    expect(lines.some((l) => l.includes('hire another'))).toBe(false);
  });

  it('a FULL single-capacity room says BUILD ANOTHER, never expand (owner report)', () => {
    // Owner, 2026-07-19: expanded Respiratory Therapy on this hint's advice
    // and got no new capacity, and the row would not clear. `resp` is
    // `capacity: 'single'` — expanding it buys QUALITY, never a second
    // patient — so "expand it to add bays" was impossible advice. Only
    // waiting/er/dialysis/restroom are perProp; every other treatment room
    // is single, so this was wrong for the MAJORITY of rooms.
    const { world, root, blocked } = panelFixture();
    expect(ROOM_DEFS.resp.capacity.kind).toBe('single'); // premise, not assumed
    world.buildRoom('resp', { col: 5, row: 20, cols: 3, rows: 3 }, { col: 8, row: 21 }, true);
    const room = [...world.rooms.values()].find((r) => r.type === 'resp')!;
    const rt = hire(world, 'respTherapist', 'Rhea');
    const busy = world.spawnPatient('asthma');
    reserve(world, room.id, busy.id, [rt.id], 'active', 0);
    const waiting = world.spawnPatient('asthma');
    waiting.stage = { kind: 'waiting' };
    blockedLongEnough(world, waiting);
    world.tick();
    blocked.update();

    const lines = rows(root);
    expect(lines).toContain(
      `${ROOM_DEFS.resp.label} is busy — build another one (it treats one patient at a time)`,
    );
    // The impossible advice must not appear in ANY form.
    expect(lines.some((l) => l.includes('expand'))).toBe(false);
  });

  it('free bay + every nurse at her ratio cap ⇒ hire, never expand', () => {
    const { world, root, blocked } = panelFixture();
    // A 6×6 ER derives more bays than the nurse ratio — a FREE bay with a
    // capped nurse, which is the state that must read "hire", not "expand".
    world.buildRoom('er', { col: 5, row: 20, cols: 6, rows: 6 }, { col: 11, row: 20 }, true);
    const room = [...world.rooms.values()].find((r) => r.type === 'er')!;
    const nurse = hire(world, 'nurse', 'Ada');
    const ratio = staffRatioFor('er', 'nurse');
    expect(world.capacityOf(room)).toBeGreaterThan(ratio); // premise
    for (let slot = 0; slot < ratio; slot++) {
      const p = world.spawnPatient('laceration');
      reserve(world, room.id, p.id, [nurse.id], 'active', slot);
    }
    nurse.duty = { kind: 'reserved', reservationId: [...world.reservations.keys()][0]! };
    const waiting = world.spawnPatient('laceration');
    waiting.stage = { kind: 'waiting' };
    blockedLongEnough(world, waiting);
    world.tick();
    blocked.update();

    const lines = rows(root);
    expect(lines).toContain(
      `Every ${ROLE_DEFS.nurse.label} is busy — hire another for the ${ROOM_DEFS.er.label}`,
    );
    expect(lines.some((l) => l.includes('expand it to add'))).toBe(false);
  });

  it('an idle nurse under the cap ⇒ no capacity row at all (no false alarm)', () => {
    const { world, root, blocked } = panelFixture();
    buildEr(world);
    hire(world, 'nurse', 'Ada');
    const waiting = world.spawnPatient('laceration');
    waiting.stage = { kind: 'waiting' };
    blockedLongEnough(world, waiting);
    world.tick();
    blocked.update();
    expect(rows(root).some((l) => l.includes('at capacity') || l.includes('add bays'))).toBe(false);
  });

  it('no nurse hired at all stays sim/needs.ts’ "Hire a Nurse" — never duplicated', () => {
    const { world, root, blocked } = panelFixture();
    buildEr(world);
    const waiting = world.spawnPatient('laceration');
    waiting.stage = { kind: 'waiting' };
    blockedLongEnough(world, waiting);
    world.tick();
    blocked.update();
    const lines = rows(root);
    expect(lines.some((l) => l.startsWith(`Hire a ${ROLE_DEFS.nurse.label}`))).toBe(true);
    expect(lines.some((l) => l.includes('at capacity'))).toBe(false);
  });

  it('a 1:1 room never produces a capacity row (the scope gate: ratio rooms only)', () => {
    const { world, root, blocked } = panelFixture();
    const room = buildExam(world);
    const doctor = hire(world, 'doctor', 'Ben');
    const patient = world.spawnPatient('flu');
    reserve(world, room.id, patient.id, [doctor.id], 'active');
    const waiting = world.spawnPatient('flu');
    waiting.stage = { kind: 'waiting' };
    world.tick();
    blocked.update();
    // Every 1:1 room is momentarily "all staff at cap" between patients —
    // hinting on that is exactly the transient noise needs.ts avoids.
    expect(rows(root).some((l) => l.includes('at capacity') || l.includes('add bays'))).toBe(false);
  });

  it('a CLOSED room produces no capacity row — the close was the player’s own act', () => {
    const { world, root, blocked } = panelFixture();
    const room = buildEr(world);
    hire(world, 'nurse', 'Ada');
    world.setRoomClosed(room.id, true);
    const waiting = world.spawnPatient('laceration');
    waiting.stage = { kind: 'waiting' };
    blockedLongEnough(world, waiting);
    world.tick();
    blocked.update();
    // capacityOf is 0 while closed — without the guard this would read
    // an expand hint, which is not the remedy.
    expect(rows(root).some((l) => l.includes('add bays'))).toBe(false);
  });
});
