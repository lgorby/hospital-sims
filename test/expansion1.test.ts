import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { TICKS_PER_DAY } from '../src/sim/clock';
import { CONDITION_DEFS, CONDITION_IDS, type ConditionId } from '../src/sim/data/conditions';
import { PROP_STYLE, ROOM_DEFS, ROOM_TYPES, type RoomType } from '../src/sim/data/rooms';
import { rollCondition } from '../src/sim/systems/spawn';
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
        ).toBe(spec.count * PROP_STYLE[spec.id].tiles);
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
      expect(placed.get(spec.id) ?? 0, spec.id).toBe(spec.count * PROP_STYLE[spec.id].tiles);
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

  it('a surgery reservation gathers surgeon + nurse simultaneously (all-or-nothing)', () => {
    const t = setup(7);
    t.queue.push(SURGERY_ROOM);
    t.apply();
    const surgeon = t.world.addStaffMember('surgeon', 5, 500);
    const nurse = t.world.addStaffMember('nurse', 5, 150);
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
  });

  it('one missing role (no surgeon) means NO reservation — the nurse is never held', () => {
    const t = setup();
    t.queue.push(SURGERY_ROOM);
    t.apply();
    const nurse = t.world.addStaffMember('nurse', 5, 150);
    const patient = t.world.spawnPatient('gallstones');
    patient.stage = { kind: 'waiting' };
    patient.acuity = 3;
    patient.stepIndex = 1; // gallstones' OR step (surgeon + nurse)
    patient.waitingSince = t.world.clock.tick;

    for (let i = 0; i < 10; i++) t.world.tick();
    expect(t.world.reservations.size).toBe(0);
    expect(nurse.duty.kind).not.toBe('reserved');
  });
});

describe('expansion spawn mix (GDD §12 weights)', () => {
  it('all 14 conditions can spawn under the live weights (seeded direct rolls)', () => {
    const t = setup(2026);
    const seen = new Set<ConditionId>();
    const DRAWS = 5000; // smallest weight is stroke at 4/148 ≈ 2.7% — ample margin
    for (let i = 0; i < DRAWS && seen.size < CONDITION_IDS.length; i++) {
      seen.add(rollCondition(t.world));
    }
    expect([...seen].sort()).toEqual([...CONDITION_IDS].sort());
  });
});
