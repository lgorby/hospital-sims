import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { TICKS_PER_DAY } from '../src/sim/clock';
import { CONDITION_DEFS, CONDITION_IDS, type ConditionId,
  ELECTIVE_CONDITION_IDS, EMERGENCY_CONDITION_IDS,
} from '../src/sim/data/conditions';
import { PROP_STYLE, ROOM_DEFS, ROOM_TYPES, type RoomType } from '../src/sim/data/rooms';
import { rollCondition, rollElectiveCondition } from '../src/sim/systems/spawn';
import { propTargetCount } from '../src/sim/formulas';
import { rectTiles } from '../src/sim/types';
import { World } from '../src/sim/world';

/**
 * Expansion 1 — Departments & Imaging (GDD §12): imaging suite (ultrasound,
 * CT, MRI, nuclear medicine), dialysis, and the OR + surgeon, with eight new
 * conditions riding them. Sim-side gate tests.
 */

/** FROZEN ids — the UI and render layers code against these exact keys. */
const NEW_ROOMS: readonly RoomType[] = ['ultrasound', 'ct', 'mri', 'nucMed', 'dialysis', 'surgery'];

describe('frozen Expansion-1 ids (cross-agent contract)', () => {
  it('the six new room ids exist, walled, in imaging/treatment categories', () => {
    for (const type of NEW_ROOMS) {
      expect(ROOM_DEFS[type], type).toBeDefined();
      expect(ROOM_DEFS[type].kind).toBe('treatment');
      expect(['imaging', 'treatment']).toContain(ROOM_DEFS[type].category);
    }
  });

  it('the eight new condition ids exist with GDD §12 acuity ranges', () => {
    const expected: Record<string, [number, number]> = {
      kidneyStones: [3, 3],
      backInjury: [4, 4],
      thyroid: [4, 5],
      kidneyFailure: [2, 3],
      gallstones: [3, 3],
      headInjury: [2, 2],
      appendicitis: [2, 2],
      stroke: [1, 1],
    };
    for (const [id, [min, max]] of Object.entries(expected)) {
      const def = CONDITION_DEFS[id as ConditionId];
      expect(def, id).toBeDefined();
      expect([def.acuityMin, def.acuityMax], id).toEqual([min, max]);
    }
  });
});

function setup(seed = 42) {
  const events = new EventBus();
  const world = new World(events, seed);
  const queue = new CommandQueue();
  const rejections: string[] = [];
  events.on('buildRejected', ({ reason }) => rejections.push(reason));
  const apply = () => world.applyCommands(queue);
  return { world, queue, events, rejections, apply };
}

/** Most simultaneous occupants a room must hold: the largest step crew + the patient. */
function maxOccupants(type: RoomType): number {
  let maxRoles = 0;
  for (const id of CONDITION_IDS) {
    for (const step of CONDITION_DEFS[id].steps) {
      if (step.room === type) maxRoles = Math.max(maxRoles, step.roles.length);
    }
  }
  return maxRoles + 1;
}

describe('new-room prop fit (GDD §12 equipment at minimum footprint)', () => {
  // Every walled room type is checked (the 8 pre-expansion rooms double as a
  // regression control); the six §12 rooms are the reason this test exists.
  const walledRooms = ROOM_TYPES.filter((type) => ROOM_DEFS[type].kind !== 'open');

  it.each(walledRooms.map((type) => [type] as const))(
    '%s at min size places every prop with the door landing free',
    (type) => {
      const t = setup();
      const def = ROOM_DEFS[type];
      const rect = { col: 10, row: 10, cols: def.minCols, rows: def.minRows };
      // South-middle door — the common hand-built orientation.
      const doorOutside = { col: 10 + Math.floor(def.minCols / 2), row: 10 + def.minRows };
      t.queue.push({ type: 'buildRoom', roomType: type, rect, doorOutside });
      t.apply();
      expect(t.rejections).toEqual([]);
      expect(t.world.rooms.size).toBe(1);
      const room = [...t.world.rooms.values()][0]!;

      // Every declared prop fully placed (the strand-revert backstop would
      // silently drop one otherwise) — counted in TILES, strips included.
      const placed = new Map<string, number>();
      for (const p of rectTiles(rect)) {
        const object = t.world.tileAt(p.col, p.row)!.object;
        if (object !== null) placed.set(object, (placed.get(object) ?? 0) + 1);
      }
      for (const spec of def.props) {
        expect(
          placed.get(spec.id) ?? 0,
          `${type}: ${spec.id} tiles placed`,
        ).toBe(propTargetCount(spec.density, rect) * PROP_STYLE[spec.id].tiles);
      }

      // Door landing stays free of props, and the interior keeps room for the
      // largest crew this room ever hosts plus the patient (all reachable —
      // the placement backstop already reverted anything that strands tiles).
      const door = room.door!;
      expect(t.world.tileAt(door.inside.col, door.inside.row)!.object).toBeNull();
      expect(t.world.tileAt(door.inside.col, door.inside.row)!.walkable).toBe(true);
      const standable = rectTiles(rect).filter((p) => {
        const tile = t.world.tileAt(p.col, p.row)!;
        return tile.walkable && !(p.col === door.inside.col && p.row === door.inside.row);
      });
      expect(standable.length, `${type}: room for crew + patient`).toBeGreaterThanOrEqual(
        maxOccupants(type),
      );
    },
  );

  it('ultrasound (the tightest footprint, 2 wide) also fits its props with an EAST door', () => {
    // The placement backstop silently DROPS a prop that can't legally fit, so
    // the 2-wide room gets a second door orientation: the 2-tile bed spans the
    // full width and must dodge a door landing on either axis.
    const t = setup();
    const rect = { col: 10, row: 10, cols: 2, rows: 3 };
    t.queue.push({
      type: 'buildRoom',
      roomType: 'ultrasound',
      rect,
      doorOutside: { col: 12, row: 11 }, // door inside (11,11), mid east wall
    });
    t.apply();
    expect(t.rejections).toEqual([]);
    const placed = new Map<string, number>();
    for (const p of rectTiles(rect)) {
      const object = t.world.tileAt(p.col, p.row)!.object;
      if (object !== null) placed.set(object, (placed.get(object) ?? 0) + 1);
    }
    for (const spec of ROOM_DEFS.ultrasound.props) {
      expect(placed.get(spec.id) ?? 0, spec.id).toBe(
        propTargetCount(spec.density, rect) * PROP_STYLE[spec.id].tiles,
      );
    }
    const door = [...t.world.rooms.values()][0]!.door!;
    expect(t.world.tileAt(door.inside.col, door.inside.row)!.object).toBeNull();
  });
});

describe('dual-staff OR (GDD §12: the second assignment-system stress test)', () => {
  const SURGERY_ROOM = {
    type: 'buildRoom',
    roomType: 'surgery',
    rect: { col: 10, row: 10, cols: 4, rows: 4 },
    doorOutside: { col: 12, row: 14 },
  } as const;
  const surgeryStep = CONDITION_DEFS.appendicitis.steps[1]!;

  // ANESTHESIA_PLAN §3: the OR is a THREE-role gather now (surgeon + nurse +
  // anesthesiologist). The assertions below all derive from
  // `surgeryStep.roles`, so they scale with the roster rather than pinning a
  // count — only the HIRING needed updating.
  it('a surgery reservation gathers all three OR roles simultaneously (all-or-nothing)', () => {
    const t = setup(7);
    t.queue.push(SURGERY_ROOM);
    t.apply();
    const surgeon = t.world.addStaffMember('surgeon', 5, 500);
    const nurse = t.world.addStaffMember('nurse', 5, 150);
    const anesthetist = t.world.addStaffMember('anesthesiologist', 5, 420);
    // Post-ultrasound appendicitis: stepIndex 1 is the OR step (test fixture
    // stage assignment is allowed; sim code must use setPatientStage).
    const patients = [1, 2].map(() => {
      const p = t.world.spawnPatient('appendicitis');
      p.stage = { kind: 'waiting' };
      p.acuity = 2;
      p.stepIndex = 1;
      p.waitingSince = t.world.clock.tick;
      return p;
    });

    t.world.tick();
    // Exactly ONE reservation holding BOTH roles — never a partial hold.
    expect(t.world.reservations.size).toBe(1);
    const reservation = [...t.world.reservations.values()][0]!;
    expect(reservation.staffIds.length).toBe(surgeryStep.roles.length);
    const reservedRoles = reservation.staffIds.map((id) => t.world.staff.get(id)!.role).sort();
    expect(reservedRoles).toEqual([...surgeryStep.roles].sort());

    let discharged = 0;
    t.events.on('patientDischarged', () => discharged++);
    for (let i = 0; i < 3 * TICKS_PER_DAY && discharged < 2; i++) {
      t.world.tick();
      for (const r of t.world.reservations.values()) {
        expect(r.staffIds.length).toBe(surgeryStep.roles.length);
      }
    }
    expect(discharged).toBe(2); // both operated in turn — no starvation, no deadlock
    expect(patients[0]!.stage.kind).toBe('leaving');
    expect(t.world.reservations.size).toBe(0);
    expect(surgeon.duty.kind).toBe('idle');
    expect(nurse.duty.kind).toBe('idle');
    expect(anesthetist.duty.kind).toBe('idle');
  });

  it('one missing role (no surgeon) means NO reservation — the others are never held', () => {
    const t = setup();
    t.queue.push(SURGERY_ROOM);
    t.apply();
    // Hire TWO of the three so exactly ONE role is missing — otherwise this
    // test would silently weaken to "two missing roles" when the OR gained
    // its third (the point is a PARTIAL gather never commits).
    const nurse = t.world.addStaffMember('nurse', 5, 150);
    const anesthetist = t.world.addStaffMember('anesthesiologist', 5, 420);
    const patient = t.world.spawnPatient('gallstones');
    patient.stage = { kind: 'waiting' };
    patient.acuity = 3;
    patient.stepIndex = 1; // gallstones' OR step
    patient.waitingSince = t.world.clock.tick;

    for (let i = 0; i < 10; i++) t.world.tick();
    expect(t.world.reservations.size).toBe(0);
    expect(nurse.duty.kind).not.toBe('reserved');
    expect(anesthetist.duty.kind).not.toBe('reserved');
  });
});

describe('expansion spawn mix (GDD §12 weights)', () => {
  /**
   * AMENDED for the outpatient stream (OUTPATIENT_IMPL_PLAN §2.2). The guard's
   * intent — no condition may be defined yet unreachable — is unchanged; what
   * changed is that there are now TWO streams, so "reachable from
   * `rollCondition`" is too strong a phrasing of it.
   *
   * Amended to the true invariant (every condition reachable from ITS OWN
   * stream) plus the INVERSE guard (no condition reachable from both).
   * Deliberately NOT weakened to "reachable from either", which would let an
   * elective leak into the walk-in mix undetected — the Departments Stage 1
   * precedent, where filing `resp` under the exempt list "would have
   * mislabelled it and permanently disarmed the guard."
   */
  it('every condition spawns from its OWN stream, and from only that stream', () => {
    const t = setup(2026);
    // An MRI + nucMed suite, so the elective roll's room-gate is open. Built
    // free: this is a roster probe, not an economy one.
    t.world.buildRoom('mri', { col: 4, row: 4, cols: 4, rows: 4 }, { col: 6, row: 8 }, true);
    t.world.buildRoom('nucMed', { col: 10, row: 4, cols: 3, rows: 4 }, { col: 11, row: 8 }, true);

    const emergency = new Set<ConditionId>();
    const elective = new Set<ConditionId>();
    const DRAWS = 5000; // smallest weight is stroke at 4/148 ≈ 2.7% — ample margin
    for (let i = 0; i < DRAWS; i++) {
      emergency.add(rollCondition(t.world));
      const id = rollElectiveCondition(t.world);
      if (id !== null) elective.add(id);
    }

    expect([...emergency].sort()).toEqual([...EMERGENCY_CONDITION_IDS].sort());
    expect([...elective].sort()).toEqual([...ELECTIVE_CONDITION_IDS].sort());
    // The inverse guard: the two streams partition the roster.
    for (const id of emergency) expect(elective.has(id)).toBe(false);
    expect(emergency.size + elective.size).toBe(CONDITION_IDS.length);
  });

  it('the elective roll is GATED on the modality being built', () => {
    const t = setup(2026); // setupNewGame builds reception + waiting only
    expect(rollElectiveCondition(t.world)).toBeNull();

    t.world.buildRoom('mri', { col: 4, row: 4, cols: 4, rows: 4 }, { col: 6, row: 8 }, true);
    // Only MRI exists, so the WHOLE elective stream routes to it — which is
    // what makes a single scanner saturate (OUTPATIENT_IMPL_PLAN §2).
    for (let i = 0; i < 200; i++) expect(rollElectiveCondition(t.world)).toBe('mriScan');
  });
});
