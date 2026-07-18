import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { ROLE_DEFS } from '../src/sim/data/roles';
import type { Patient } from '../src/sim/entities/patient';
import { setupNewGame } from '../src/sim/newGame';
import { computeBlockedNeeds } from '../src/sim/needs';
import { World } from '../src/sim/world';

/**
 * Hints milestone (docs/HINTS_PLAN.md): the `computeBlockedNeeds` derivation +
 * the urgent-only toast consumer. The look-ahead regression of record is the
 * owner's exact scenario: a gallstones patient far from surgery must surface
 * the Operating Room + Surgeon needs AHEAD of time.
 */

function setup() {
  const events = new EventBus();
  const world = new World(events, 42);
  setupNewGame(world); // reception + waiting room + one receptionist
  const queue = new CommandQueue();
  return { world, events, queue };
}

function hire(world: World, role: keyof typeof ROLE_DEFS): void {
  world.addStaffMember(role, 3, ROLE_DEFS[role].salaryPerDay, {
    first: 'Test',
    last: role,
    full: `Test ${role}`,
    short: `T. ${role}`,
  });
}

/** Force a patient into a stage (test fixture write — allowed by HANDOFF). */
function forceStage(patient: Patient, stage: Patient['stage']): void {
  patient.stage = stage;
}

function needKeys(world: World): string[] {
  return computeBlockedNeeds(world).map((n) => n.key);
}

function need(world: World, key: string) {
  return computeBlockedNeeds(world).find((n) => n.key === key);
}

describe('computeBlockedNeeds — enumeration', () => {
  it('an empty world has no needs', () => {
    const { world } = setup();
    expect(computeBlockedNeeds(world)).toEqual([]);
  });

  it('a patient at the entrance with no reception → urgent room:reception', () => {
    const events = new EventBus();
    const world = new World(events, 42); // bare — no setupNewGame
    world.spawnPatient('flu');
    const reception = need(world, 'room:reception');
    expect(reception).toBeDefined();
    expect(reception!.urgent).toBe(true);
    expect(reception!.label).toBe("Build a Reception — patients can't check in");
  });

  it('reception built but nobody hired → urgent role:receptionist (checkin wording)', () => {
    const { world } = setup();
    // Remove the starting receptionist entirely (fixture write).
    for (const [id, s] of world.staff) if (s.role === 'receptionist') world.staff.delete(id);
    world.spawnPatient('flu');
    const receptionist = need(world, 'role:receptionist');
    expect(receptionist).toBeDefined();
    expect(receptionist!.urgent).toBe(true);
    expect(receptionist!.label).toBe("Hire a Receptionist — patients can't check in");
    expect(needKeys(world)).not.toContain('room:reception');
  });

  it('a hired receptionist still WALKING to the desk is NOT a need (anti-flash)', () => {
    const { world } = setup();
    world.spawnPatient('flu'); // receptionist hired at setup, still en route
    expect(needKeys(world)).not.toContain('role:receptionist');
  });

  it('check-in stages see triage needs as upcoming; waitingTriage makes them urgent', () => {
    const { world } = setup();
    const patient = world.spawnPatient('flu');
    // No triage room, no nurse: upcoming while the patient is checking in…
    let triage = need(world, 'room:triage');
    let nurse = need(world, 'role:nurse');
    expect(triage!.urgent).toBe(false);
    expect(nurse!.urgent).toBe(false);
    // …urgent once they are waiting for triage.
    forceStage(patient, { kind: 'waitingTriage' });
    triage = need(world, 'room:triage');
    nurse = need(world, 'role:nurse');
    expect(triage!.urgent).toBe(true);
    expect(nurse!.urgent).toBe(true);
    // The Triage Bay skips the self-evident reason; the nurse names it (a flu
    // chain needs no nurse, so triage is this need's only reason).
    expect(triage!.label).toBe('Build a Triage Bay');
    expect(nurse!.label).toBe('Hire a Nurse — needed for triage');
  });

  it('REGRESSION OF RECORD: a gallstones patient still pre-surgery surfaces the OR chain ahead of time', () => {
    const { world } = setup();
    hire(world, 'nurse');
    const patient = world.spawnPatient('gallstones');
    forceStage(patient, { kind: 'waiting' });
    patient.acuity = 3;
    // stepIndex 0 = Ultrasound. Surgery (step 1) needs surgeon+nurse and an OR.
    const surgery = need(world, 'room:surgery');
    const surgeon = need(world, 'role:surgeon');
    expect(surgery).toBeDefined();
    expect(surgeon).toBeDefined();
    expect(surgery!.urgent).toBe(false); // upcoming — the look-ahead
    expect(surgeon!.urgent).toBe(false);
    expect(surgery!.label).toBe('Build an Operating Room — needed for Gallstones');
    expect(surgeon!.label).toBe('Hire a Surgeon — needed for Gallstones');
    // The CURRENT step's needs are urgent.
    expect(need(world, 'room:ultrasound')!.urgent).toBe(true);
    expect(need(world, 'role:sonographer')!.urgent).toBe(true);
    // The nurse is hired, so surgery's second role is NOT a need.
    expect(needKeys(world)).not.toContain('role:nurse');
  });

  it('the same needs turn urgent when the patient reaches the surgery step', () => {
    const { world } = setup();
    hire(world, 'nurse');
    const patient = world.spawnPatient('gallstones');
    forceStage(patient, { kind: 'waiting' });
    patient.acuity = 3;
    patient.stepIndex = 1; // ultrasound done — surgery is now the current step
    expect(need(world, 'room:surgery')!.urgent).toBe(true);
    expect(need(world, 'role:surgeon')!.urgent).toBe(true);
  });

  it('a reserved (mid-treatment) patient still surfaces REMAINING steps as upcoming', () => {
    const { world } = setup();
    hire(world, 'nurse');
    const patient = world.spawnPatient('gallstones');
    forceStage(patient, { kind: 'reserved', reservationId: 999 });
    patient.acuity = 3; // in the ultrasound reservation, stepIndex 0
    const surgery = need(world, 'room:surgery');
    expect(surgery).toBeDefined();
    expect(surgery!.urgent).toBe(false);
  });

  it('leaving and dead patients (still in world.patients) contribute nothing', () => {
    const { world } = setup();
    const leaver = world.spawnPatient('gallstones');
    forceStage(leaver, { kind: 'leaving', reason: 'ama' });
    const corpse = world.spawnPatient('appendicitis');
    forceStage(corpse, { kind: 'dead', since: 0 });
    expect(world.patients.size).toBe(2); // premise: both really are in the map
    expect(needKeys(world)).not.toContain('room:surgery');
    expect(needKeys(world)).not.toContain('role:surgeon');
  });

  it('lost patients DO count toward needs', () => {
    const { world } = setup();
    const patient = world.spawnPatient('gallstones');
    forceStage(patient, { kind: 'waiting' });
    patient.acuity = 3;
    patient.lost = { since: 0 };
    expect(need(world, 'room:surgery')).toBeDefined();
  });

  it('needs dedupe across patients: counts and condition union in table order', () => {
    const { world } = setup();
    hire(world, 'nurse');
    for (const condition of ['gallstones', 'gallstones', 'appendicitis'] as const) {
      const p = world.spawnPatient(condition);
      forceStage(p, { kind: 'waiting' });
      p.acuity = 3;
      p.stepIndex = 1; // both conditions' step 1 is surgery
    }
    const surgery = need(world, 'room:surgery');
    expect(surgery!.patients).toBe(3);
    // CONDITION_DEFS table order: gallstones before appendicitis.
    expect(surgery!.conditions).toEqual(['Gallstones', 'Appendicitis']);
    expect(surgery!.label).toBe('Build an Operating Room — needed for Gallstones, Appendicitis');
  });

  it('hiring the missing role clears the need; a FIRING member still counts as hired', () => {
    const { world } = setup();
    hire(world, 'nurse');
    const patient = world.spawnPatient('gallstones');
    forceStage(patient, { kind: 'waiting' });
    patient.acuity = 3;
    patient.stepIndex = 1;
    expect(need(world, 'role:surgeon')).toBeDefined();
    hire(world, 'surgeon');
    expect(needKeys(world)).not.toContain('role:surgeon');
    // A deferred fire (mid-duty) marks `firing` but keeps the member on the
    // roster — they still count, so the panel must not flash the need. Pinned
    // by fixture write: an idle fire removes immediately and would make this
    // vacuous (review MINOR 1 — no conditional guard, the assert always runs).
    const surgeon = [...world.staff.values()].find((s) => s.role === 'surgeon')!;
    surgeon.firing = true;
    expect(world.staff.has(surgeon.id)).toBe(true); // premise: still hired
    expect(needKeys(world)).not.toContain('role:surgeon');
  });

  it('building the missing room clears the need', () => {
    const { world } = setup();
    const patient = world.spawnPatient('flu');
    forceStage(patient, { kind: 'waitingTriage' });
    expect(need(world, 'room:triage')).toBeDefined();
    world.buildRoom('triage', { col: 5, row: 20, cols: 2, rows: 2 }, { col: 7, row: 20 }, true);
    expect(needKeys(world)).not.toContain('room:triage');
  });

  it('sort order is deterministic: urgent first, then most patients, then key', () => {
    // Exact-sequence assertion (review MINOR 2: the old `rank(a) <= rank(b)`
    // array comparison string-coerced — it passed broken orders and failed
    // correct ones — and the fixture never varied the patients dimension).
    const { world } = setup();
    hire(world, 'nurse');
    for (const condition of ['gallstones', 'appendicitis'] as const) {
      const p = world.spawnPatient(condition);
      forceStage(p, { kind: 'waiting' });
      p.acuity = 3;
      p.stepIndex = 1; // both need surgery NOW → room:surgery/role:surgeon ×2
    }
    const solo = world.spawnPatient('kidneyFailure');
    forceStage(solo, { kind: 'waiting' });
    solo.acuity = 3; // dialysis room missing, nurse hired → room:dialysis ×1
    // All urgent; 2-patient needs before the 1-patient need; key breaks the
    // tie. room:restroom (amenities Stage 1) trails as an UPCOMING row —
    // patients exist, none below the bladder threshold, no restroom built.
    expect(needKeys(world)).toEqual([
      'role:surgeon',
      'room:surgery',
      'room:dialysis',
      'room:restroom',
    ]);
    // The ordering is total: keys are unique.
    const needs = computeBlockedNeeds(world);
    expect(new Set(needs.map((n) => n.key)).size).toBe(needs.length);
  });
});

describe('room:restroom need (amenities Stage 1, §1.11 / pre-impl MINOR 9)', () => {
  const BLADDER_LOW = 10; // below BALANCE.needs.seekThreshold (35)

  it('no patients → no restroom row; patients with full meters → UPCOMING row', () => {
    const { world } = setup();
    expect(needKeys(world)).not.toContain('room:restroom');
    const p = world.spawnPatient('flu');
    p.bladder = 100; // full — nobody is seeking
    const row = need(world, 'room:restroom');
    expect(row).toBeDefined();
    expect(row!.urgent).toBe(false);
    // Label is EXACT — the panel + toast wording SSOT.
    expect(row!.label).toBe('Build a Restroom — patients need the restroom');
  });

  it('urgent only for below-threshold patients in the ACTIONABLE stages (waiting/waitingTriage)', () => {
    const { world } = setup();
    const p = world.spawnPatient('flu');
    p.bladder = BLADDER_LOW;
    // Below threshold but still in the check-in pipeline: NOT actionable.
    expect(need(world, 'room:restroom')!.urgent).toBe(false);
    forceStage(p, { kind: 'waitingTriage' });
    expect(need(world, 'room:restroom')!.urgent).toBe(true);
    forceStage(p, { kind: 'waiting' });
    p.acuity = 3;
    const row = need(world, 'room:restroom')!;
    expect(row.urgent).toBe(true);
    expect(row.patients).toBe(1);
  });

  it('building a restroom clears the need entirely', () => {
    const { world } = setup();
    const p = world.spawnPatient('flu');
    forceStage(p, { kind: 'waitingTriage' });
    p.bladder = BLADDER_LOW;
    expect(need(world, 'room:restroom')).toBeDefined();
    world.buildRoom('restroom', { col: 5, row: 20, cols: 2, rows: 3 }, { col: 7, row: 21 }, true);
    expect(needKeys(world)).not.toContain('room:restroom');
  });

  it('leaving/dead patients keep no restroom need alive', () => {
    const { world } = setup();
    const leaver = world.spawnPatient('flu');
    forceStage(leaver, { kind: 'leaving', reason: 'ama' });
    const corpse = world.spawnPatient('flu');
    forceStage(corpse, { kind: 'dead', since: 0 });
    expect(needKeys(world)).not.toContain('room:restroom');
  });
});

describe('urgent-need toasts (dispatcher consumer, HINTS_PLAN §2.2)', () => {
  it('urgent needs toast once; upcoming needs are panel-only; no re-emission', () => {
    const { world, events } = setup();
    const hints: string[] = [];
    events.on('hint', ({ message }) => hints.push(message));
    const patient = world.spawnPatient('gallstones');
    forceStage(patient, { kind: 'waitingTriage' });
    world.tick();
    // Urgent: triage room + nurse (whose label unions the triage duty AND the
    // gallstones surgery step). Upcoming (ultrasound/surgery chain): NO toast.
    expect(hints).toContain('Build a Triage Bay');
    expect(hints).toContain('Hire a Nurse — needed for triage, Gallstones');
    expect(hints.some((h) => h.includes('Operating Room'))).toBe(false);
    expect(hints.some((h) => h.includes('Ultrasound'))).toBe(false);
    const after = hints.length;
    world.tick();
    expect(hints.length).toBe(after); // hintOnce: no re-emission
  });

  it('legacy saves with old cond:* keys still get the need:* hints exactly once', () => {
    const { world, events } = setup();
    // Simulate a legacy save's hintedOnce (old namespace) restored into the world.
    const priv = world.exportPrivateState();
    world.restorePrivateState({
      hintedOnce: ['cond:gallstones:room', 'room:triage', 'role:nurse'],
      nextEntityId: priv.nextEntityId,
    });
    const hints: string[] = [];
    events.on('hint', ({ message }) => hints.push(message));
    const patient = world.spawnPatient('gallstones');
    forceStage(patient, { kind: 'waitingTriage' });
    world.tick();
    expect(hints).toContain('Build a Triage Bay'); // new key fires despite old keys
    // Once latched under the NEW key, a save/restore round-trip keeps it latched.
    const latched = world.exportPrivateState();
    expect(latched.hintedOnce).toContain('need:room:triage');
    world.restorePrivateState(latched);
    const after = hints.length;
    world.tick();
    expect(hints.length).toBe(after);
  });
});
