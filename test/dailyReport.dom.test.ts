// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { TICKS_PER_GAME_HOUR } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import { dayNet, type DayReport } from '../src/sim/dailyStats';
import { cleanlinessRepDelta } from '../src/sim/formulas';
import { appendDailyReportSections } from '../src/ui/dailyReport';

/**
 * Amenities Stage 2 (§S2.5): the daily report's Cleanliness row — a
 * REPUTATION line (reads cleanlinessRepDelta, the same formula closeDay
 * applies) in the Standing section, never part of dayNet. Tests the exported
 * section builder directly (the challengeUi makeReport fixture pattern).
 */

function makeReport(over: Partial<DayReport> = {}): DayReport {
  return {
    day: 1,
    arrivals: 0,
    treated: 0,
    died: 0,
    leftAma: 0,
    lostEpisodes: 0,
    revenue: 0,
    payroll: 0,
    hireFees: 0,
    construction: 0,
    sellIncome: 0,
    vendingRevenue: 0,
    messTicks: 0,
    repDelta: 0,
    waitSumTicks: 0,
    waitCount: 0,
    cash: 0,
    reputation: 500,
    avgWaitGameMinutes: null,
    waitBonusAwarded: false,
    ...over,
  };
}

function render(report: DayReport): HTMLElement {
  const card = document.createElement('div');
  appendDailyReportSections(card, report);
  return card;
}

/** The Cleanliness row's value span, or null when the row is absent. */
function cleanlinessRow(card: HTMLElement): { text: string; tone: string } | null {
  const row = [...card.querySelectorAll('.modal-row')].find(
    (r) => r.querySelector('span')?.textContent === 'Cleanliness',
  );
  if (!row) return null;
  const value = row.querySelectorAll('span')[1]!;
  return { text: value.textContent ?? '', tone: value.className };
}

describe('daily report Cleanliness row (amenities Stage 2)', () => {
  it('spotless day WITH arrivals: "+2 rep", tone good', () => {
    const report = makeReport({ arrivals: 5, messTicks: 0 });
    // Premise: the formula (the SSOT this row renders) awards the bonus.
    expect(cleanlinessRepDelta(report.messTicks, report.arrivals)).toBe(
      BALANCE.mess.cleanDayRepBonus,
    );
    const row = cleanlinessRow(render(report));
    expect(row).not.toBeNull();
    expect(row!.text).toBe(`+${BALANCE.mess.cleanDayRepBonus} rep`);
    expect(row!.tone).toBe('good');
  });

  it('messy day: negative delta with mess-hours context, tone bad', () => {
    // 8 mess-hours → floor(8 / messHoursPerRepPoint=4) = −2.
    const messTicks = 8 * TICKS_PER_GAME_HOUR;
    const report = makeReport({ arrivals: 5, messTicks });
    const delta = cleanlinessRepDelta(messTicks, report.arrivals);
    expect(delta).toBeLessThan(0); // premise, not vacuous
    const row = cleanlinessRow(render(report));
    expect(row).not.toBeNull();
    // The typographic minus (format.ts signedDelta) + the hours context.
    expect(row!.text).toBe(`−${Math.abs(delta)} rep (8 mess-hours)`);
    expect(row!.tone).toBe('bad');
  });

  it('absent on an empty day (0 arrivals, 0 mess — the closed-hospital gate)', () => {
    expect(cleanlinessRow(render(makeReport({ arrivals: 0, messTicks: 0 })))).toBeNull();
  });

  it('absent when mess rounds to zero rep (under one messHoursPerRepPoint step)', () => {
    // 2 mess-hours < the 4-hour step → delta 0 → no row (spec: absent when 0).
    // NOTE: the formula's `-Math.min(...)` yields IEEE −0 here; the row gate
    // is `!== 0`, and `−0 !== 0` is false — absent, as specced. Compare with
    // ===, not toBe (Object.is distinguishes −0).
    const messTicks = 2 * TICKS_PER_GAME_HOUR;
    const report = makeReport({ arrivals: 5, messTicks });
    expect(cleanlinessRepDelta(messTicks, report.arrivals) === 0).toBe(true); // premise
    expect(cleanlinessRow(render(report))).toBeNull();
  });

  it('cleanliness is reputation, never cash: dayNet ignores messTicks', () => {
    const base = makeReport({ arrivals: 5, revenue: 100, payroll: 40 });
    const messy = makeReport({ arrivals: 5, revenue: 100, payroll: 40, messTicks: 999 });
    expect(dayNet(messy)).toBe(dayNet(base));
    // And the row lives in the Standing section (after the wait row), not Money.
    const card = render(messy);
    const sections = [...card.querySelectorAll('.modal-rows')];
    const standing = sections[sections.length - 1]!;
    expect(
      [...standing.querySelectorAll('.modal-row')].some(
        (r) => r.querySelector('span')?.textContent === 'Cleanliness',
      ),
    ).toBe(true);
  });
});
