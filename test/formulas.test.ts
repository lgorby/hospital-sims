import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/sim/data/balance';
import {
  dischargeReputationGain,
  effectivePriority,
  successChance,
  timeOfDayMultiplier,
  treatmentDurationTicks,
} from '../src/sim/formulas';
import { gameMinutesToTicks } from '../src/sim/clock';

describe('formulas', () => {
  it('successChance follows the GDD curve and clamps', () => {
    // Skill 1, full health: base 0.70.
    expect(successChance(1, 100)).toBeCloseTo(0.7);
    // Skill 5, full health: 0.70 + 0.06×4 = 0.94.
    expect(successChance(5, 100)).toBeCloseTo(0.94);
    // Crashing patient (health 0): 0.70 − 0.20 = 0.50 → at the floor.
    expect(successChance(1, 0)).toBe(BALANCE.treatment.successMin);
    // Never exceeds the cap.
    expect(successChance(99, 100)).toBe(BALANCE.treatment.successMax);
  });

  it('effectivePriority ages: an acuity-5 patient waiting 5h beats a fresh acuity-3', () => {
    expect(effectivePriority(5, 5)).toBeLessThan(effectivePriority(3, 0));
    expect(effectivePriority(1, 0)).toBeLessThan(effectivePriority(2, 0));
  });

  it('treatmentDurationTicks: skill speeds up, quality speeds up', () => {
    const base = treatmentDurationTicks(30, 3, 0); // 30 × (1.3−0.3) = 30 min
    expect(base).toBe(gameMinutesToTicks(30));
    expect(treatmentDurationTicks(30, 5, 0)).toBeLessThan(base);
    expect(treatmentDurationTicks(30, 3, 5)).toBeLessThan(base);
  });

  it('dischargeReputationGain maps acuity 1→+8 and 5→+2', () => {
    expect(dischargeReputationGain(1)).toBe(BALANCE.reputation.dischargeGainMax);
    expect(dischargeReputationGain(5)).toBe(BALANCE.reputation.dischargeGainMin);
  });

  it('timeOfDayMultiplier reads the non-uniform blocks correctly', () => {
    expect(timeOfDayMultiplier(0)).toBe(0.3);
    expect(timeOfDayMultiplier(5)).toBe(0.3); // 04–06 stays in the first block
    expect(timeOfDayMultiplier(9)).toBe(0.8);
    expect(timeOfDayMultiplier(16)).toBe(1.5);
    expect(timeOfDayMultiplier(23)).toBe(0.5);
  });
});
