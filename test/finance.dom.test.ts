// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events';
import type { GameLoop } from '../src/loop';
import { BALANCE } from '../src/sim/data/balance';
import type { DayReport } from '../src/sim/dailyStats';
import { FINANCE_CATEGORIES } from '../src/sim/data/finance';
import { ROOM_DEFS, type RoomCategory } from '../src/sim/data/rooms';
import { departmentCapital, netFromCategories } from '../src/sim/formulas';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';
import { DailyReportModal } from '../src/ui/dailyReport';
import { FinanceModal } from '../src/ui/finance';
import { money } from '../src/ui/format';

/**
 * FINANCE_PLAN §11.11–§11.12 — the finances modal's DOM contract (happy-dom,
 * the `*.dom.test.ts` fixture idiom). The load-bearing claims: the grid's row
 * set is STABLE across columns, the breakdown row is display-only, the graph
 * degrades safely (too few days, flat cash), the departmental ledger agrees
 * with the rooms it sums, exactly one overlay owns the clock, and — the
 * re-review MAJOR N1 pin — a deliberately paused game stays paused.
 */

class FakeLoop {
  speed = 1;
  setSpeed(s: number): void {
    this.speed = s;
  }
}

function makeReport(day: number, over: Partial<DayReport> = {}): DayReport {
  return {
    day,
    arrivals: 0,
    treated: 0,
    died: 0,
    leftAma: 0,
    electiveTreated: 0,
    electiveNoShow: 0,
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

function fixture() {
  document.body.replaceChildren();
  const events = new EventBus();
  const world = new World(events, 42);
  setupNewGame(world);
  const loop = new FakeLoop();
  const modal = new FinanceModal(loop as unknown as GameLoop, world, events);
  modal.mount(document.body);
  return { world, events, loop, modal };
}

/** The card only exists once `open()` has rendered it. */
function card(): HTMLElement {
  return document.querySelector('#finance .modal-card')!;
}

function overlay(): HTMLElement {
  return document.querySelector('#finance')!;
}

/** A row by its first span's text (works for both grid rows and modalRow). */
function rowByLabel(label: string): HTMLElement | null {
  return (
    [...card().querySelectorAll<HTMLElement>('.modal-row')].find(
      (row) => row.querySelector('span')?.textContent === label,
    ) ?? null
  );
}

function cellTexts(row: HTMLElement): string[] {
  return [...row.querySelectorAll('.finance-cell')].map((c) => c.textContent ?? '');
}

/** The section box (`.modal-rows`) following the h3 with this title. */
function section(title: string): HTMLElement {
  const heading = [...card().querySelectorAll('h3')].find((h) => h.textContent === title);
  expect(heading, `section "${title}"`).toBeDefined();
  return heading!.nextElementSibling as HTMLElement;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('finances grid (§3.1)', () => {
  it('renders every category across the day / Today / Total columns', () => {
    const { world, modal } = fixture();
    world.history.push(makeReport(1, { revenue: 100 }), makeReport(2, { payroll: 40 }));
    world.today.revenue = 50;
    Object.assign(world.lifetime, { revenue: 150, payroll: 40 });
    modal.open();

    // 2 closed days + Today + Total. The header names them in that order.
    const columns = ['Day 1', 'Day 2', 'Today', 'Total'];
    expect(cellTexts(section('Income & expenditure').querySelector('.finance-head')!)).toEqual(
      columns,
    );

    // EVERY category row renders — including the ones the daily report
    // zero-suppresses: a grid needs a stable row set across columns.
    for (const category of FINANCE_CATEGORIES) {
      const row = rowByLabel(category.label);
      expect(row, category.label).not.toBeNull();
      expect(cellTexts(row!)).toHaveLength(columns.length);
    }

    // Zero cells are em-dashes; expenses are negated by `kind` alone.
    expect(cellTexts(rowByLabel('Patient fees')!)).toEqual(['$100', '—', '$50', '$150']);
    expect(cellTexts(rowByLabel('Payroll')!)).toEqual(['—', '−$40', '—', '−$40']);
    expect(cellTexts(rowByLabel('Hiring')!)).toEqual(['—', '—', '—', '—']);
  });

  it('shows only the last historyShownDays closed days, oldest → newest', () => {
    const { world, modal } = fixture();
    const stored = BALANCE.finance.historyCapDays;
    for (let day = 1; day <= stored; day += 1) world.history.push(makeReport(day));
    modal.open();

    const shown = BALANCE.finance.historyShownDays;
    const headers = cellTexts(section('Income & expenditure').querySelector('.finance-head')!);
    // shown days + Today + Total.
    expect(headers).toHaveLength(shown + 2);
    expect(headers[0]).toBe(`Day ${stored - shown + 1}`);
    expect(headers[shown - 1]).toBe(`Day ${stored}`);
    expect(headers.slice(-2)).toEqual(['Today', 'Total']);
  });

  it('the breakdown row indents and is NEVER summed into Net', () => {
    const { world, modal } = fixture();
    // A vending-only day: `revenue` already CONTAINS vendingRevenue, so Net
    // must count it exactly once.
    world.today.revenue = 15;
    world.today.vendingRevenue = 15;
    modal.open();

    const vending = rowByLabel('Vending')!;
    expect(vending.classList.contains('finance-breakdown')).toBe(true);
    expect(cellTexts(vending)[0]).toBe('$15'); // renders...

    // ...but Net is the shared fold, which skips `kind: 'breakdown'`.
    expect(netFromCategories(world.today)).toBe(15); // premise, not vacuous
    const net = rowByLabel('Net')!;
    // Today is the second-to-last column (no closed days here).
    expect(cellTexts(net).slice(-2)).toEqual(['$15', '$0']);
    expect(net.classList.contains('finance-net')).toBe(true);
  });

  it('Net agrees with netFromCategories in every column', () => {
    const { world, modal } = fixture();
    world.history.push(makeReport(1, { revenue: 300, payroll: 80, construction: 1000 }));
    world.today.payroll = 25;
    Object.assign(world.lifetime, { revenue: 300, payroll: 105, construction: 1000 });
    modal.open();

    expect(cellTexts(rowByLabel('Net')!)).toEqual([
      money(netFromCategories(world.history[0]!)),
      money(netFromCategories(world.today)),
      money(netFromCategories(world.lifetime)),
    ]);
  });
});

describe('summary block (§3.2)', () => {
  it('average bill is an em-dash before any counted discharge', () => {
    const { modal } = fixture();
    modal.open();
    expect(rowByLabel('Average bill per patient')!.querySelectorAll('span')[1]!.textContent).toBe(
      '—',
    );
  });

  it('states the "since this save was upgraded" notice only when watermarked', () => {
    const first = fixture();
    first.modal.open();
    expect(card().querySelector('.finance-note')).toBeNull();

    const migrated = fixture();
    migrated.world.lifetimeTreatedBase = 12;
    migrated.world.lifetimeTreated = 12;
    migrated.modal.open();
    const notes = card().querySelectorAll('.finance-note');
    expect(notes).toHaveLength(1); // ONCE (§7 Q7), not per section
    expect(notes[0]!.textContent).toContain('since this save was upgraded');
  });
});

describe('cash graph (§3.3)', () => {
  it('is omitted below 2 closed days', () => {
    const { world, modal } = fixture();
    world.history.push(makeReport(1, { cash: 5000 }));
    modal.open();
    expect(card().querySelector('.finance-graph')).toBeNull();
    expect([...card().querySelectorAll('h3')].map((h) => h.textContent)).not.toContain(
      'Cash over time',
    );
  });

  it('survives a flat cash run (min === max) without dividing by zero', () => {
    const { world, modal } = fixture();
    // span = (max − min) || 1 — the degenerate case the spec calls out.
    world.history.push(makeReport(1, { cash: 5000 }), makeReport(2, { cash: 5000 }));
    modal.open();
    const points = card().querySelector('.finance-graph-line')!.getAttribute('points')!;
    expect(points).not.toContain('NaN');
    expect(points).toBe('0,120 300,120');
  });

  it('draws the zero line only when zero is inside the range', () => {
    const positive = fixture();
    positive.world.history.push(makeReport(1, { cash: 4000 }), makeReport(2, { cash: 9000 }));
    positive.modal.open();
    // Off-scale zero would pin to an edge and read as break-even — omitted.
    expect(card().querySelector('.finance-graph-zero')).toBeNull();
    expect(card().querySelector('.finance-graph-line')!.getAttribute('points')).toBe('0,120 300,0');

    const straddling = fixture();
    straddling.world.history.push(makeReport(1, { cash: -1000 }), makeReport(2, { cash: 1000 }));
    straddling.modal.open();
    const zero = card().querySelector('.finance-graph-zero')!;
    expect(zero.getAttribute('y1')).toBe('60'); // midpoint of −1000…1000
  });

  it('graphs the STORED history, not the shown columns', () => {
    const { world, modal } = fixture();
    const stored = BALANCE.finance.historyCapDays;
    for (let day = 1; day <= stored; day += 1) world.history.push(makeReport(day, { cash: day }));
    modal.open();
    const points = card().querySelector('.finance-graph-line')!.getAttribute('points')!;
    expect(points.split(' ')).toHaveLength(stored);
    // And the scale labels use money(), over the full stored range.
    expect(
      [...card().querySelectorAll('.finance-graph-scale')].map((s) => s.textContent),
    ).toEqual([money(stored), money(1)]);
  });

  // Live-drive MAJOR 1: the labels were emitted into a horizontal flex row
  // under the graph, so on a RISING week the line climbed left→right while the
  // labels read "$49,780 … $45,970" — a player reading them as start→end saw
  // their cash falling during a week it rose. They describe the VERTICAL axis,
  // so max must be identifiable as the top edge and min as the bottom.
  it('anchors the scale labels to the vertical extremes, not left-to-right', () => {
    const { world, modal } = fixture();
    // A strictly RISING run — the case the old layout inverted.
    for (let day = 1; day <= 4; day += 1) {
      world.history.push(makeReport(day, { cash: 1000 * day }));
    }
    modal.open();
    const max = card().querySelector('.finance-graph-max')!;
    const min = card().querySelector('.finance-graph-min')!;
    expect(max.textContent).toBe(money(4000));
    expect(min.textContent).toBe(money(1000));
    // Each label is its own positioned element inside the graph frame — NOT
    // two anonymous spans whose meaning depends on document order.
    const frame = card().querySelector('.finance-graph-frame')!;
    expect(frame.contains(max)).toBe(true);
    expect(frame.contains(min)).toBe(true);
    expect(max.classList.contains('finance-graph-scale')).toBe(true);
    expect(min.classList.contains('finance-graph-scale')).toBe(true);
  });
});

// Live-drive MAJOR 2: with a graph and four departments the card ran past the
// shared 80vh cap, and on a ≤800px-tall window Continue sat below the fold
// with no scrollbar and no Esc (the bottom-bar peel is suppressed while a
// modal is open) — the player was left in a paused game with no visible exit.
describe('the way out is always on screen (live-drive MAJOR 2)', () => {
  it('scrolls the body and keeps Continue outside the scroller', () => {
    const { world, modal } = fixture();
    for (let day = 1; day <= 7; day += 1) world.history.push(makeReport(day, { cash: 1000 * day }));
    modal.open();
    const body = card().querySelector('.finance-body')!;
    const cont = card().querySelector('.modal-continue')!;
    // Every heavy section lives INSIDE the scrolling region...
    expect(body.querySelector('.finance-graph')).not.toBeNull();
    expect(body.querySelectorAll('.finance-row').length).toBeGreaterThan(0);
    // ...and Continue is a direct child of the card, never inside the scroller.
    expect(body.contains(cont)).toBe(false);
    expect(cont.parentElement).toBe(card());
  });
});

describe('departments (§5.1)', () => {
  it('totals match the room sum and the ledger closes with unallocated payroll', () => {
    const { world, modal } = fixture();
    const rooms = [...world.rooms.values()];
    expect(rooms.length).toBeGreaterThan(0); // premise: setupNewGame built rooms
    // Credit one room so the numbers are not all-zero em-dashes.
    const earner = rooms[0]!;
    earner.revenueToday = 450;
    earner.revenueTotal = 3900;
    earner.visitsTotal = 17;
    world.lifetime.payroll = 9140;
    modal.open();

    const categories = new Set(rooms.map((r) => ROOM_DEFS[r.type].category));
    for (const category of categories) {
      const owned = rooms.filter((r) => ROOM_DEFS[r.type].category === category);
      const today = owned.reduce((n, r) => n + r.revenueToday, 0);
      const total = owned.reduce((n, r) => n + r.revenueTotal, 0);
      const seen = owned.reduce((n, r) => n + r.visitsTotal, 0);
      const row = rowByLabel(labelFor(category));
      expect(row, category).not.toBeNull();
      expect(cellTexts(row!)).toEqual([
        String(owned.length),
        today === 0 ? '—' : money(today),
        total === 0 ? '—' : money(total),
        money(departmentCapital(world, category)),
        String(seen),
      ]);
    }

    // The honest closer: payroll is hospital overhead by construction (§6).
    // It is a LIFETIME figure and the label says so (review MINOR): unlabelled
    // under an "Income today" column it read as one day's wages dwarfing one
    // day's income. It is a grid row, so the money lands in a money column
    // rather than under "Patients seen" (live-drive NIT 2).
    // It sits OUTSIDE the column grid (verification NIT): under any column
    // header the figure read as that column's kind of number — first a
    // patient count, then negative income for a department that doesn't
    // exist. It belongs to no column because it belongs to no department.
    const payroll = rowByLabel('Payroll (not allocated)')!;
    expect(payroll).not.toBeNull();
    expect(payroll.classList.contains('finance-footer')).toBe(true);
    expect(payroll.querySelectorAll('.finance-cell')).toHaveLength(0);
    expect(payroll.querySelector('.bad')!.textContent).toBe('−$9,140');
    expect(payroll.querySelector('.finance-footer-note')!.textContent).toContain('lifetime');
    expect(section('Departments').contains(payroll)).toBe(true);
  });

  /**
   * The block sums what we CURRENTLY own, but `lifetime.revenue` remembers
   * every fee ever billed — so revenue earned in a room since SOLD had no
   * department to sit under, and the block was quietly short of Patient fees
   * with nothing explaining the gap. This row is what makes it reconcile.
   */
  it('reconciles with lifetime revenue by naming income from sold rooms', () => {
    const { world, modal } = fixture();
    const room = [...world.rooms.values()][0]!;
    room.revenueTotal = 400;
    // $1,000 billed lifetime, $400 of it in a room we still own, no vending ⇒
    // $600 was earned somewhere that no longer exists.
    world.lifetime.revenue = 1000;
    modal.open();

    const sold = rowByLabel('Sold rooms (no longer owned)')!;
    expect(sold).not.toBeNull();
    expect(cellTexts(sold)[2]).toBe(money(600));

    // And the block now adds up: every income-total cell plus the sold row
    // equals lifetime revenue exactly.
    const totals = [...section('Departments').querySelectorAll<HTMLElement>('.finance-row')]
      .filter((r) => !r.classList.contains('finance-head'))
      .map((r) => cellTexts(r)[2] ?? '—');
    const sum = totals
      .filter((t) => t !== '—')
      .reduce((acc, t) => acc + Number(t.replace(/[^0-9]/g, '')), 0);
    expect(sum).toBe(1000);
  });

  it('omits the sold-rooms row when everything earned is still owned', () => {
    const { world, modal } = fixture();
    const room = [...world.rooms.values()][0]!;
    room.revenueTotal = 400;
    world.lifetime.revenue = 400;
    modal.open();
    expect(rowByLabel('Sold rooms (no longer owned)')).toBeNull();
  });

  it('shows what the machines took today, not just their lifetime (v8)', () => {
    const { world, modal } = fixture();
    world.placeAmenity('vending', { col: 4, row: 4 });
    const machine = world.amenityAt(4, 4)!;
    machine.revenueToday = 35;
    machine.revenueTotal = 220;
    modal.open();

    const amenities = rowByLabel('Amenities')!;
    // Income today is a real figure now — it used to be a permanent em-dash
    // because no per-day number existed anywhere in the game.
    expect(cellTexts(amenities)[1]).toBe(money(35));
    expect(cellTexts(amenities)[2]).toBe(money(220));
  });

  it('says "Capital invested", never "Spent" (it bills the free starting rooms)', () => {
    const { modal } = fixture();
    modal.open();
    const headers = cellTexts(section('Departments').querySelector('.finance-head')!);
    expect(headers).toContain('Capital invested');
    expect(headers.join(' ')).not.toContain('Spent');
  });
});

/** Department rows are labelled with the build menu's category names. */
function labelFor(category: RoomCategory): string {
  return { basics: 'Basics', imaging: 'Imaging', treatment: 'Treatment', comfort: 'Comfort' }[
    category
  ];
}

describe('overlay ownership of the clock (§3)', () => {
  it('opening Finances over a visible modal is a no-op', () => {
    const { modal, loop } = fixture();
    // A rival overlay, visible — the daily report in practice.
    const rival = document.createElement('div');
    rival.className = 'modal-overlay';
    document.body.appendChild(rival);

    modal.open();
    expect(overlay().classList.contains('hidden')).toBe(true);
    expect(card().children).toHaveLength(0); // nothing rendered either
    expect(loop.speed).toBe(1); // and the rival kept the clock
  });

  it('gameOver hides it — foreclosure trumps bookkeeping', () => {
    const { modal, events, loop } = fixture();
    modal.open();
    expect(overlay().classList.contains('hidden')).toBe(false);
    events.emit('gameOver', { day: 3, cash: -10000, reputation: 200, treated: 4, died: 1 });
    expect(overlay().classList.contains('hidden')).toBe(true);
    // hide(), not closeAndResume(): a dead game must not un-pause.
    expect(loop.speed).toBe(0);
  });

  /**
   * Verification MINOR: the guard used to be one-directional. `open()` refuses
   * to open over a live overlay, but the daily report has no reciprocal guard,
   * so a forced tick at midnight stacked BOTH — and dismissing finances left
   * the report on screen with the clock running behind a modal that claims to
   * pause. Yielding to the day boundary is the structural half of the rule.
   */
  it('yields to the day boundary so two overlays can never be live at once', () => {
    const { world, events, modal } = fixture();
    modal.open();
    expect(overlay().classList.contains('hidden')).toBe(false);

    // The real payload the coordinator would carry into the daily report.
    events.emit('dayEnded', { ...world.today, day: 1, cash: world.cash, reputation: 500, avgWaitGameMinutes: null, waitBonusAwarded: false });
    expect(overlay().classList.contains('hidden')).toBe(true);
  });

  it('PAUSE HONESTY: paused → open → Continue leaves the game paused', () => {
    const { modal, loop } = fixture();
    loop.speed = 0; // the player pressed Space
    modal.open();
    expect(loop.speed).toBe(0);
    continueButton().click();
    // allowResumeToPaused = true: the speed-1 fallback must not fire here.
    expect(loop.speed).toBe(0);
  });

  it('restores the pre-open speed on Continue', () => {
    const { modal, loop } = fixture();
    loop.speed = 3;
    modal.open();
    expect(loop.speed).toBe(0);
    continueButton().click();
    expect(loop.speed).toBe(3);
  });

  it("the daily report's speed-0 fallback is UNCHANGED by the additive flag", () => {
    // The regression pin for re-review MAJOR N1's fix: midnight overlays open
    // only at a day boundary, where a captured 0 means "the sim happened to be
    // stopped" — they must still resume at the fallback.
    const events = new EventBus();
    const loop = new FakeLoop();
    const daily = new DailyReportModal(loop as unknown as GameLoop, events);
    daily.mount(document.body);
    loop.speed = 0;
    daily.open(makeReport(1));
    const cont = document.querySelector<HTMLButtonElement>('#dailyreport .modal-continue')!;
    cont.click();
    expect(loop.speed).toBe(1);
  });
});

function continueButton(): HTMLButtonElement {
  return card().querySelector<HTMLButtonElement>('.modal-continue')!;
}
