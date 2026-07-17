import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/sim/data/balance';
import { CONDITION_DEFS, CONDITION_IDS } from '../src/sim/data/conditions';
import { ROLE_DEFS } from '../src/sim/data/roles';
import { ROOM_DEFS, ROOM_TYPES } from '../src/sim/data/rooms';

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

  it('acuity ranges are valid (1–5, min ≤ max)', () => {
    for (const id of CONDITION_IDS) {
      const { acuityMin, acuityMax } = CONDITION_DEFS[id];
      expect(acuityMin).toBeGreaterThanOrEqual(1);
      expect(acuityMax).toBeLessThanOrEqual(5);
      expect(acuityMin).toBeLessThanOrEqual(acuityMax);
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
