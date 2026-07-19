/**
 * SSOT for money CATEGORIES (FINANCE_PLAN §9.1, tech plan §3.1 rule 1): ONE
 * table drives the finances grid, the daily report's Money section, `dayNet`
 * AND the lifetime totals — a new money field cannot be tallied yet invisible,
 * nor counted twice.
 */
import type { DayTally } from '../dailyStats';

export type CashTallyKey =
  | 'revenue'
  | 'vendingRevenue'
  | 'sellIncome'
  | 'payroll'
  | 'hireFees'
  | 'construction';

/**
 * Frozen shape: `kind` drives display negation, the net fold, AND the row tone
 * ('expense' → 'bad', otherwise 'good' — which reproduces the shipped daily
 * report exactly); `showWhenZero` governs the DAILY REPORT only (the grid
 * always renders every non-breakdown row, because a grid needs a stable row
 * set across columns); `reportOrder` preserves the daily report's shipped row
 * order independently of ARRAY order, which is the GRID order (§3.1).
 * `field` IS the id: category keys and DayTally keys are deliberately the same
 * strings, so `tallyCash` needs no mapping.
 */
export type FinanceCategory = {
  readonly field: CashTallyKey;
  readonly label: string;
  readonly showWhenZero: boolean;
  readonly reportOrder: number;
} & (
  | { readonly kind: 'income' | 'expense' }
  | { readonly kind: 'breakdown'; readonly under: CashTallyKey }
);

/** ARRAY order = the §3.1 GRID order. `reportOrder` = the daily report's. */
export const FINANCE_CATEGORIES = [
  { field: 'revenue', label: 'Patient fees', kind: 'income', showWhenZero: true, reportOrder: 0 },
  {
    field: 'vendingRevenue',
    label: 'Vending',
    kind: 'breakdown',
    under: 'revenue',
    showWhenZero: false,
    reportOrder: 1,
  },
  {
    field: 'sellIncome',
    label: 'Sell-back income',
    kind: 'income',
    showWhenZero: false,
    reportOrder: 5,
  },
  { field: 'payroll', label: 'Payroll', kind: 'expense', showWhenZero: true, reportOrder: 2 },
  { field: 'hireFees', label: 'Hiring', kind: 'expense', showWhenZero: false, reportOrder: 3 },
  {
    field: 'construction',
    label: 'Construction',
    kind: 'expense',
    showWhenZero: false,
    reportOrder: 4,
  },
] as const satisfies readonly FinanceCategory[];

/**
 * The partition guard (§11.1): DayTally keys that are NOT cash. Adding a tally
 * key forces a choice here or above — the union must equal
 * `Object.keys(emptyDayTally())`, test-enforced with no duplicates.
 */
export const NON_CASH_TALLY_KEYS = [
  'arrivals',
  'treated',
  'died',
  'leftAma',
  'electiveTreated',
  'electiveNoShow',
  'lostEpisodes',
  'messTicks',
  'repDelta',
  'waitSumTicks',
  'waitCount',
] as const satisfies readonly (keyof DayTally)[];

/** Lifetime cash totals — the same keys, one running sum each (§3.1 Total). */
export type CashTotals = Record<CashTallyKey, number>;

export function emptyCashTotals(): CashTotals {
  return {
    revenue: 0,
    vendingRevenue: 0,
    sellIncome: 0,
    payroll: 0,
    hireFees: 0,
    construction: 0,
  };
}
