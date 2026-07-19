import { describe, expect, it } from 'vitest';

import { EventBus } from '../src/events';
import { TICKS_PER_GAME_HOUR } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import {
  CONDITION_DEFS,
  conditionElective,
  ELECTIVE_CONDITION_IDS,
} from '../src/sim/data/conditions';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';

/**
 * The outpatient / elective stream (OUTPATIENT_IMPL_PLAN).
 *
 * A referral is "a patient who arrives already triaged": it checks in, skips
 * triage, takes one imaging study, pays and leaves. The mechanism is a data
 * flag on the CONDITION plus acuity set at spawn — no new Patient field and no
 * new lifecycle stage.
 */

const MRI = { col: 4, row: 4, cols: 4, rows: 4 } as const;
const MRI_DOOR = { col: 6, row: 8 } as const;

function fixture(seed = 4242, opts: { mri?: boolean } = {}) {
  const events = new EventBus();
  const world = new World(events, seed);
  setupNewGame(world);
  if (opts.mri !== false) world.buildRoom('mri', MRI, MRI_DOOR, true);
  return { world, events };
}

/** Advance to a tick inside clinic hours. The clock starts at hour 0. */
function toClinicHours(world: World): void {
  const target = BALANCE.arrivals.outpatient.openHour * TICKS_PER_GAME_HOUR;
  while (world.clock.tick < target) world.tick();
}

function electives(world: World) {
  return [...world.patients.values()].filter((p) => conditionElective(p.condition));
}

describe('outpatient stream — arrival', () => {
  it('spawns NO referral outside clinic hours', () => {
    const { world } = fixture();
    const target = BALANCE.arrivals.outpatient.openHour * TICKS_PER_GAME_HOUR;
    while (world.clock.tick < target) world.tick();
    expect(electives(world)).toHaveLength(0);
  });

  it('spawns referrals once the clinic opens', () => {
    const { world } = fixture();
    toClinicHours(world);
    // A full clinic day at ~1/game-hour is ~10 referrals; a couple of hours is
    // ample to see at least one without asserting an exact seeded count.
    for (let i = 0; i < 3 * TICKS_PER_GAME_HOUR; i++) world.tick();
    expect(electives(world).length).toBeGreaterThan(0);
  });

  it('PRE-CLINIC ticks leave the rng stream untouched — the control window', () => {
    // §4's determinism claim: the clinic-hours check sits OUTSIDE rng.chance,
    // which consumes a draw unconditionally. Two worlds that differ only in
    // whether an elective modality exists must therefore be bit-identical
    // until the clinic opens. If the guard were moved inside `chance`, the
    // gated world would consume an extra draw per tick and diverge instantly.
    const withRoom = fixture(99).world;
    const without = fixture(99, { mri: false }).world;
    const target = BALANCE.arrivals.outpatient.openHour * TICKS_PER_GAME_HOUR;
    while (withRoom.clock.tick < target) {
      withRoom.tick();
      without.tick();
    }
    expect(withRoom.rng.getState()).toEqual(without.rng.getState());
  });

  it('is GATED: a hospital with no elective modality receives no referrals', () => {
    const { world } = fixture(4242, { mri: false });
    toClinicHours(world);
    for (let i = 0; i < 6 * TICKS_PER_GAME_HOUR; i++) world.tick();
    expect(electives(world)).toHaveLength(0);
  });
});

describe('outpatient stream — lifecycle', () => {
  /** Drive a lone referral to the head of check-in and complete it. */
  function seatedReferral(seed = 4242) {
    const f = fixture(seed);
    const patient = f.world.spawnPatient('mriScan', {
      acuity: CONDITION_DEFS.mriScan.acuityMax,
    });
    return { ...f, patient };
  }

  it('arrives PRE-TRIAGED — acuity is set at spawn, not at triage', () => {
    const { patient } = seatedReferral();
    expect(patient.acuity).toBe(5);
    expect(conditionElective('mriScan')).toBe(true);
  });

  it('goes checkingIn -> waiting with NO stage violations', () => {
    const { world, patient } = seatedReferral();
    // Run until it clears check-in. A receptionist is posted by setupNewGame.
    for (let i = 0; i < 4 * TICKS_PER_GAME_HOUR; i++) {
      world.tick();
      if (patient.stage.kind === 'waiting' || patient.stage.kind === 'reserved') break;
    }
    expect(['waiting', 'reserved']).toContain(patient.stage.kind);
    // THE guard this milestone widened. An elective must never have entered
    // waitingTriage, and the widening must not have let anything illegal past.
    expect(world.stageViolations).toEqual([]);
  });

  it('an EMERGENCY still routes through waitingTriage — the branch does not leak', () => {
    const { world } = fixture();
    const flu = world.spawnPatient('flu');
    for (let i = 0; i < 4 * TICKS_PER_GAME_HOUR; i++) {
      world.tick();
      if (flu.stage.kind === 'waitingTriage') break;
    }
    expect(flu.stage.kind).toBe('waitingTriage');
    expect(flu.acuity).toBeNull(); // triage has not run — no triage bay exists
    expect(world.stageViolations).toEqual([]);
  });

  it('a referral ages EXACTLY like an equally-acute emergency — no special treatment', () => {
    /**
     * The code review raised this as MAJOR 5: an aged referral prices at
     * `5 - 0.5 x 8 = 1.0` and so can outrank a freshly-triaged acuity-1
     * stroke, inside its own ~8.3-hour patience budget.
     *
     * MEASURED, and the framing is half wrong. An EMERGENCY flu patient
     * (acuity 5) aged the same 8 hours prices at 1.0 too. The inversion is
     * pre-existing `agingPerHourWaited` behaviour — the deliberate
     * anti-starvation rule that stops low-acuity patients waiting forever
     * (Flow rule 6) — and it applies to every low-acuity patient, walk-in or
     * referral. The elective stream does not introduce it and must not be
     * blamed for it.
     *
     * What this milestone DOES owe is parity: a referral must not age
     * FASTER than an identical emergency. That is the invariant here.
     */
    const { world } = fixture();
    const mk = (condition: 'mriScan' | 'flu') => {
      const p = world.spawnPatient(condition, { acuity: 5 });
      p.stage = { kind: 'waiting' };
      p.waitingSince = world.clock.tick;
      return p;
    };
    const referral = mk('mriScan');
    const walkIn = mk('flu');

    for (let i = 0; i < 8 * TICKS_PER_GAME_HOUR; i++) world.clock.advance();

    const priority = (p: { acuity: number | null; waitingSince: number | null }): number => {
      const hoursWaited = (world.clock.tick - (p.waitingSince ?? 0)) / TICKS_PER_GAME_HOUR;
      return (p.acuity ?? 3) - BALANCE.dispatcher.agingPerHourWaited * hoursWaited;
    };
    // Same acuity, same wait, same queue ⇒ identical priority. A referral that
    // aged faster would be jumping the queue on the strength of its channel.
    expect(priority(referral)).toBe(priority(walkIn));
  });
});

describe('outpatient stream — money and reputation', () => {
  it('bills with source "outpatient", so the checklist cannot mistake it for a walk-in', () => {
    const { world, events } = fixture();
    const sources: string[] = [];
    events.on('feeBilled', ({ source }) => sources.push(source));
    world.billFee(CONDITION_DEFS.mriScan.steps[0]!.fee, 'MRI Scan (referral) — MRI scan', {
      source: 'outpatient',
    });
    expect(sources).toEqual(['outpatient']);
  });

  it('a no-show costs electiveNoShowLoss, NOT the full amaLoss', () => {
    // Design review MAJOR 4: flat amaLoss (8) against the +2 an elective
    // discharge earns puts break-even at a 20% walkout rate, and the baseline
    // is ~25% with electives sorting last — the stream would have been
    // reputation-NEGATIVE in expectation.
    const { world } = fixture();
    const before = world.reputation;
    const referral = world.spawnPatient('mriScan', { acuity: 5 });
    referral.stage = { kind: 'waiting' };
    world.patientLeavesAma(referral);
    expect(before - world.reputation).toBe(BALANCE.reputation.electiveNoShowLoss);

    const before2 = world.reputation;
    const flu = world.spawnPatient('flu', { acuity: 5 });
    flu.stage = { kind: 'waiting' };
    world.patientLeavesAma(flu);
    expect(before2 - world.reputation).toBe(BALANCE.reputation.amaLoss);
  });

  it('the elective fee ANCHORS to the identical existing step — zero arbitrage', () => {
    // The drafted 900/1100 made an elective scan more profitable per
    // staff-minute than a stroke, paying the player to starve their own ED.
    const backInjuryMri = CONDITION_DEFS.backInjury.steps[0]!;
    const thyroidNuc = CONDITION_DEFS.thyroid.steps[0]!;
    expect(CONDITION_DEFS.mriScan.steps[0]!.fee).toBe(backInjuryMri.fee);
    expect(CONDITION_DEFS.mriScan.steps[0]!.durationGameMinutes).toBe(
      backInjuryMri.durationGameMinutes,
    );
    expect(CONDITION_DEFS.nucMedScan.steps[0]!.fee).toBe(thyroidNuc.fee);
    expect(CONDITION_DEFS.nucMedScan.steps[0]!.durationGameMinutes).toBe(
      thyroidNuc.durationGameMinutes,
    );
  });
});

describe('outpatient stream — data integrity', () => {
  it('every elective condition is a single imaging step its room can staff', () => {
    for (const id of ELECTIVE_CONDITION_IDS) {
      const def = CONDITION_DEFS[id];
      expect(def.steps, id).toHaveLength(1);
      expect(def.acuityMin, id).toBe(5);
      expect(def.acuityMax, id).toBe(5);
    }
  });

  it('outpatient.weights covers exactly the elective roster — no missing, no extra', () => {
    // This is what would catch a new elective condition added without a
    // weight, which would otherwise simply never spawn.
    expect(Object.keys(BALANCE.arrivals.outpatient.weights).sort()).toEqual(
      [...ELECTIVE_CONDITION_IDS].sort(),
    );
  });
});
