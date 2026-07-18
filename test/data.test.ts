import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/sim/data/balance';
import { CONDITION_DEFS, CONDITION_IDS } from '../src/sim/data/conditions';
import { ROLE_DEFS, ROLE_IDS } from '../src/sim/data/roles';
import { PROP_STYLE, ROOM_DEFS, ROOM_TYPES, type RoomType } from '../src/sim/data/rooms';

/**
 * Rooms that legitimately appear in NO condition step (GDD §3 "every room
 * earns ≥1 condition path" applies to treatment paths): the check-in/waiting
 * pipeline and the atrium are infrastructure, not treatment. Adding a room
 * type without either a condition path or an entry here fails the roster
 * integrity test below — that's the point.
 */
// restroom: self-service amenity infrastructure (amenities Stage 1) — visited
// via needBreak side-trips, never a treatment step (AMENITIES_PLAN §3.3).
const CONDITION_STEP_EXEMPT_ROOMS: readonly RoomType[] = [
  'waiting',
  'reception',
  'triage',
  'atrium',
  'restroom',
];

describe('SSOT data integrity', () => {
  it('every condition step references a real room and real roles', () => {
    for (const id of CONDITION_IDS) {
      for (const step of CONDITION_DEFS[id].steps) {
        expect(ROOM_DEFS[step.room]).toBeDefined();
        expect(step.roles.length).toBeGreaterThan(0);
        for (const role of step.roles) {
          expect(ROLE_DEFS[role]).toBeDefined();
        }
      }
    }
  });

  it("every condition step's roles can staff its room", () => {
    for (const id of CONDITION_IDS) {
      for (const step of CONDITION_DEFS[id].steps) {
        const allowed = ROOM_DEFS[step.room].staffedBy;
        for (const role of step.roles) {
          expect(allowed, `${id}/${step.label}: ${role} not allowed in ${step.room}`).toContain(
            role,
          );
        }
      }
    }
  });

  it('every room type is used by ≥1 condition step or is explicitly exempt (GDD §3/§12)', () => {
    const usedRooms = new Set<RoomType>();
    for (const id of CONDITION_IDS) {
      for (const step of CONDITION_DEFS[id].steps) usedRooms.add(step.room);
    }
    for (const type of ROOM_TYPES) {
      const earnsItsKeep = usedRooms.has(type) || CONDITION_STEP_EXEMPT_ROOMS.includes(type);
      expect(earnsItsKeep, `${type}: no condition path and not exempt`).toBe(true);
    }
    // The exemption list must not mask a room that HAS gained a path.
    for (const type of CONDITION_STEP_EXEMPT_ROOMS) {
      expect(usedRooms.has(type), `${type} is exempt but appears in a condition step`).toBe(false);
    }
  });

  it('every role appears in ≥1 condition step, staffs a standing post, or works the job queue', () => {
    const usedRoles = new Set<string>();
    for (const id of CONDITION_IDS) {
      for (const step of CONDITION_DEFS[id].steps) {
        for (const role of step.roles) usedRoles.add(role);
      }
    }
    // Amenities Stage 2 (AMENITIES_PLAN §4.3): EVS works the facility JOB
    // queue — dispatched via world.jobs (assignJobs), never condition steps
    // or standing posts. A future maintenance role (Stage 3) joins this set.
    const jobQueueRoles = new Set<string>(['evs']);
    for (const role of ROLE_IDS) {
      const standingPostSomewhere =
        ROLE_DEFS[role].standingPost &&
        ROOM_TYPES.some((type) => (ROOM_DEFS[type].staffedBy as readonly string[]).includes(role));
      expect(
        usedRoles.has(role) || standingPostSomewhere || jobQueueRoles.has(role),
        `${role}: earns no condition step, no standing post, and no job-queue duty`,
      ).toBe(true);
    }
  });

  it('acuity ranges are valid (1–5, min ≤ max)', () => {
    for (const id of CONDITION_IDS) {
      const { acuityMin, acuityMax } = CONDITION_DEFS[id];
      expect(acuityMin).toBeGreaterThanOrEqual(1);
      expect(acuityMax).toBeLessThanOrEqual(5);
      expect(acuityMin).toBeLessThanOrEqual(acuityMax);
    }
  });

  it('every prop strip is 1–2 tiles (the renderer slices single/west/east segments only)', () => {
    for (const [id, style] of Object.entries(PROP_STYLE)) {
      expect(style.tiles, `${id}.tiles`).toBeGreaterThanOrEqual(1);
      expect(style.tiles, `${id}.tiles`).toBeLessThanOrEqual(2);
    }
  });

  it('every room footprint fits the map', () => {
    for (const type of ROOM_TYPES) {
      expect(ROOM_DEFS[type].minCols).toBeLessThanOrEqual(BALANCE.map.cols);
      expect(ROOM_DEFS[type].minRows).toBeLessThanOrEqual(BALANCE.map.rows);
    }
  });

  it('decay tables cover acuities 1–5', () => {
    for (let acuity = 1; acuity <= 5; acuity++) {
      expect(BALANCE.decay.healthPerGameHour[acuity]).toBeGreaterThan(0);
      expect(BALANCE.decay.patiencePerGameHour[acuity]).toBeGreaterThan(0);
    }
  });

  it('time-of-day curve covers the full 24h in ascending blocks', () => {
    let previousUntil = 0;
    for (const block of BALANCE.arrivals.timeOfDayCurve) {
      expect(block.untilHour).toBeGreaterThan(previousUntil);
      expect(block.multiplier).toBeGreaterThan(0);
      previousUntil = block.untilHour;
    }
    expect(previousUntil).toBe(24);
  });

  it('entrance is on the map edge', () => {
    const { col, row }: { col: number; row: number } = BALANCE.map.entrance;
    const onEdge =
      col === 0 || row === 0 || col === BALANCE.map.cols - 1 || row === BALANCE.map.rows - 1;
    expect(onEdge).toBe(true);
  });
});
