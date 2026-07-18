// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { TICKS_PER_GAME_HOUR } from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import { dayNet, type DayReport } from '../src/sim/dailyStats';
import { cleanlinessRepDelta } from '../src/sim/formulas';
import { appendDailyReportSections } from '../src/ui/dailyReport';
import { money } from '../src/ui/format';

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

/**
 * FINANCE_PLAN §9.8 / §11.11 — the Money section now FOLDS the §9.1 category
 * table (reportOrder, showWhenZero, kind-driven negation + tone) instead of
 * hand-listing its rows, and must render byte-identically to what shipped.
 * These pin the shipped output directly, so a wrong fold fails here rather
 * than silently reordering or re-toning the player's report.
 */
describe('daily report Money section (the §9.1 fold renders what shipped)', () => {
  /** Every Money row as label / value / tone, in render order. */
  function moneyRows(card: HTMLElement): [string, string, string][] {
    const section = card.querySelectorAll('.modal-rows')[1]!;
    return [...section.querySelectorAll('.modal-row')].map((row) => {
      const spans = row.querySelectorAll('span');
      return [spans[0]!.textContent ?? '', spans[1]!.textContent ?? '', spans[1]!.className];
    });
  }

  it('a full day renders every row in the SHIPPED order, negation and tone', () => {
    const report = makeReport({
      revenue: 2400,
      vendingRevenue: 45,
      payroll: 1880,
      hireFees: 100,
      construction: 8000,
      sellIncome: 2000,
      cash: 12345,
    });
    // reportOrder, NOT the table's array order (that one is the finances
    // GRID's): sell-back income closes the section, above the hand-rendered
    // Net / Cash on hand.
    expect(moneyRows(render(report))).toEqual([
      ['Patient fees', '$2,400', 'good'],
      ['Vending', '$45', 'good'], // a BREAKDOWN of revenue, toned like income
      ['Payroll', '−$1,880', 'bad'], // kind: 'expense' drives BOTH sign + tone
      ['Hiring', '−$100', 'bad'],
      ['Construction', '−$8,000', 'bad'],
      ['Sell-back income', '$2,000', 'good'],
      ['Net', `${money(dayNet(report))}`, dayNet(report) >= 0 ? 'good' : 'bad'],
      ['Cash on hand', '$12,345', ''], // toneless, and not a category
    ]);
  });

  it('an empty day zero-suppresses exactly the showWhenZero:false rows', () => {
    // Patient fees and Payroll always render (showWhenZero); the other four
    // appear only when they happened — the shipped conditionals, in table form.
    expect(moneyRows(render(makeReport()))).toEqual([
      ['Patient fees', '$0', 'good'],
      ['Payroll', '$0', 'bad'],
      ['Net', '$0', 'good'],
      ['Cash on hand', '$0', ''],
    ]);
  });

  it('Net is the fold itself and never double-counts the vending breakdown', () => {
    // dayNet reads `revenue`, which already contains vending — the breakdown
    // row is display-only. Same revenue, same net, extra row.
    const withVending = makeReport({ revenue: 100, vendingRevenue: 40 });
    const without = makeReport({ revenue: 100 });
    expect(dayNet(withVending)).toBe(dayNet(without));
    const rows = moneyRows(render(withVending));
    expect(rows.some(([label]) => label === 'Vending')).toBe(true);
    expect(rows.find(([label]) => label === 'Net')![1]).toBe(money(dayNet(without)));
  });
});

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
