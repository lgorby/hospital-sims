import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { CONDITION_DEFS } from '../src/sim/data/conditions';
import { ROLE_DEFS, ROLE_IDS } from '../src/sim/data/roles';
import { ROOM_DEFS } from '../src/sim/data/rooms';
import { computeBlockedNeeds } from '../src/sim/needs';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';

/**
 * The anesthesiologist milestone (docs/ANESTHESIA_PLAN.md §8). Owner ask: the
 * game should MODEL anesthesiology rather than run an OR on a spare nurse.
 * Renderer-free and deterministic like every sim suite.
 */

function orWorld(seed = 11): World {
  const world = new World(new EventBus(), seed);
  setupNewGame(world);
  world.buildRoom('surgery', { col: 10, row: 10, cols: 4, rows: 4 }, { col: 12, row: 14 }, true);
  return world;
}

/** A post-imaging surgery patient: stepIndex 1 is the OR step for both
 *  surgical conditions (fixtures may assign stage directly; sim code uses
 *  setPatientStage). */
function surgeryPatient(world: World, condition: 'gallstones' | 'appendicitis', acuity: number) {
  const p = world.spawnPatient(condition);
  world.releasePatientHoldings(p);
  p.stage = { kind: 'waiting' };
  p.acuity = acuity;
  p.stepIndex = 1;
  p.waitingSince = world.clock.tick;
  return p;
}

describe('the role (§2)', () => {
  it('exists with a colour distinct from every other role', () => {
    expect(ROLE_DEFS.anesthesiologist.label).toBe('Anesthesiologist');
    expect(ROLE_DEFS.anesthesiologist.standingPost).toBe(false);
    // All-pairs, mechanical — the art review's standing complaint is that the
    // clinical roles cluster in green, so a duplicate must fail loudly rather
    // than rely on someone eyeballing the palette.
    const colors = ROLE_IDS.map((id) => ROLE_DEFS[id].color);
    expect(new Set(colors).size, 'every role colour is unique').toBe(colors.length);
  });

  it('is priced between the nurse and the surgeon', () => {
    // The brake that stops "just hire three" being free (§2). Not a magic
    // number check — a RELATION, so a future salary pass can move all three.
    expect(ROLE_DEFS.anesthesiologist.salaryPerDay).toBeGreaterThan(ROLE_DEFS.nurse.salaryPerDay);
    expect(ROLE_DEFS.anesthesiologist.salaryPerDay).toBeLessThan(ROLE_DEFS.surgeon.salaryPerDay);
  });
});

describe('where it is required (§3)', () => {
  it('the OR needs surgeon + nurse + anesthesiologist, in the room AND both steps', () => {
    expect([...ROOM_DEFS.surgery.staffedBy].sort()).toEqual([
      'anesthesiologist',
      'nurse',
      'surgeon',
    ]);
    for (const condition of ['gallstones', 'appendicitis'] as const) {
      const step = CONDITION_DEFS[condition].steps.find((s) => s.room === 'surgery')!;
      expect(step, `${condition} has an OR step`).toBeDefined();
      expect([...step.roles].sort(), condition).toEqual([
        'anesthesiologist',
        'nurse',
        'surgeon',
      ]);
    }
  });

  it('no OTHER step requires it — surgery is its only consumer', () => {
    // Stated so the next person knows this is deliberate, not an oversight:
    // it is what makes the role idle between cases, and what §4 lever 4 had
    // to compensate for.
    for (const def of Object.values(CONDITION_DEFS)) {
      for (const step of def.steps) {
        if (step.room === 'surgery') continue;
        expect(step.roles).not.toContain('anesthesiologist');
      }
    }
  });
});

describe('the three-way gather (§8.3–8.4)', () => {
  it('reserves only when ALL THREE are available, and binds one of each', () => {
    const world = orWorld();
    world.addStaffMember('surgeon', 4, 500);
    world.addStaffMember('nurse', 4, 150);
    surgeryPatient(world, 'appendicitis', 2);

    // Two of three: nothing at all (all-or-nothing, tech plan §5).
    world.tick();
    expect(world.reservations.size).toBe(0);

    world.addStaffMember('anesthesiologist', 4, 420);
    world.tick();
    expect(world.reservations.size).toBe(1);
    const reservation = [...world.reservations.values()][0]!;
    const roles = reservation.staffIds.map((id) => world.staff.get(id)!.role).sort();
    expect(roles).toEqual(['anesthesiologist', 'nurse', 'surgeon']);
    expect(world.stageViolations).toEqual([]);
  });

  it('losing ANY one of the three cancels the whole gathering (Flow rule 8)', () => {
    const world = orWorld();
    world.addStaffMember('surgeon', 4, 500);
    world.addStaffMember('nurse', 4, 150);
    const gas = world.addStaffMember('anesthesiologist', 4, 420);
    surgeryPatient(world, 'gallstones', 3);
    world.tick();
    expect(world.reservations.size).toBe(1); // premise

    // Fire the anesthesiologist mid-gather: rule 8 releases everything rather
    // than leaving a surgeon and nurse held by a reservation that can never
    // complete. Tested on the NEW role specifically — the third role is the
    // one no prior test covered.
    const queue = new CommandQueue();
    queue.push({ type: 'fireStaff', staffId: gas.id });
    world.applyCommands(queue);
    world.tick();

    expect(world.reservations.size).toBe(0);
    for (const staff of world.staff.values()) {
      expect(staff.duty.kind, `${staff.role} released`).not.toBe('reserved');
    }
    expect(world.stageViolations).toEqual([]);
  });
});

describe('the partial-gather soft hold (§4 lever 4 — pre-impl review MAJOR 3)', () => {
  /**
   * THE regression for the starvation this milestone had to fix. Before the
   * hold: the top-priority surgery patient gathers surgeon + nurse, misses the
   * anesthesiologist, gives up — and the nurse it just released is taken by a
   * LOWER-priority exam patient later in the same pass. Next tick the
   * anesthesiologist is free and the nurse is gone, forever.
   */
  it('does not hand a one-role-short surgery its staff away to a lower priority patient', () => {
    const world = orWorld();
    world.buildRoom('er', { col: 20, row: 10, cols: 3, rows: 4 }, { col: 21, row: 14 }, true);
    world.addStaffMember('surgeon', 4, 500);
    world.addStaffMember('nurse', 4, 150);

    // Acuity 1 outranks acuity 5, so surgery is served first in the sort.
    surgeryPatient(world, 'appendicitis', 1);
    const walkIn = world.spawnPatient('laceration'); // exam step needs a NURSE
    world.releasePatientHoldings(walkIn);
    walkIn.stage = { kind: 'waiting' };
    walkIn.acuity = 5;
    walkIn.stepIndex = 0;
    walkIn.waitingSince = world.clock.tick;

    world.tick();

    // The nurse is HELD, not spent: no reservation exists at all this tick.
    expect(world.reservations.size).toBe(0);
    const nurse = [...world.staff.values()].find((s) => s.role === 'nurse')!;
    expect(nurse.duty.kind, 'the nurse was not given to the walk-in').toBe('idle');

    // …and the moment the missing role arrives, surgery reserves — proving
    // the hold released cleanly rather than deadlocking anyone.
    world.addStaffMember('anesthesiologist', 4, 420);
    world.tick();
    expect(world.reservations.size).toBe(1);
    const reserved = [...world.reservations.values()][0]!;
    expect(reserved.staffIds).toHaveLength(3);
    expect(world.stageViolations).toEqual([]);
  });

  it('holds nothing when the top patient gathers successfully (no collateral starvation)', () => {
    // The hold must not become a general brake: a satisfied top-priority
    // patient leaves everyone else free to dispatch in the SAME pass.
    const world = orWorld();
    // The walk-in is a laceration, which ED_PLAN Stage A routes to the ER.
    world.buildRoom('er', { col: 20, row: 10, cols: 3, rows: 4 }, { col: 21, row: 14 }, true);
    world.addStaffMember('surgeon', 4, 500);
    world.addStaffMember('anesthesiologist', 4, 420);
    world.addStaffMember('nurse', 4, 150);
    world.addStaffMember('nurse', 4, 150); // one for the OR, one for the exam

    surgeryPatient(world, 'appendicitis', 1);
    const walkIn = world.spawnPatient('laceration');
    world.releasePatientHoldings(walkIn);
    walkIn.stage = { kind: 'waiting' };
    walkIn.acuity = 5;
    walkIn.stepIndex = 0;
    walkIn.waitingSince = world.clock.tick;

    world.tick();
    expect(world.reservations.size).toBe(2); // BOTH dispatched in one pass
  });
});

describe('hints name the new role (§5 — no code change, asserted not assumed)', () => {
  it('tells the player to hire an Anesthesiologist, naming the condition', () => {
    const world = orWorld();
    world.addStaffMember('surgeon', 4, 500);
    world.addStaffMember('nurse', 4, 150);
    surgeryPatient(world, 'gallstones', 3);

    const need = computeBlockedNeeds(world).find((n) => n.key === 'role:anesthesiologist');
    expect(need, 'the blocked panel names the missing OR role').toBeDefined();
    expect(need!.label).toContain('Anesthesiologist');
    expect(need!.label.toLowerCase()).toContain('gallstones');
    // "an Anesthesiologist", never "a Anesthesiologist" — the shared article()
    // helper, exercised on a vowel-initial label for the first time.
    expect(need!.label).toContain('an Anesthesiologist');
  });
});
