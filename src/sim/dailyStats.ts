// NOTE: this import closes a CYCLE (formulas.ts imports `dayNet` for
// scoreChallenge). It is safe because neither module calls across the cycle at
// module-evaluation time and both sides export hoisted `function` declarations,
// so whichever the bundler evaluates first sees a live binding — under Vite's
// native ESM and Rollup's production output alike (verified by review). What
// WOULD break it is evaluating an exported binding at module scope on either
// side (e.g. `const X = netFromCategories(...)` at top level). Don't.
import { netFromCategories } from './formulas';

/**
 * Per-day tallies for the daily report (M4, GDD §9). The World owns one
 * `DayTally` for the running day, increments it at the same choke points that
 * emit events, snapshots it into a `DayReport` at midnight, and resets it.
 */
export interface DayTally {
  arrivals: number;
  /** Successful discharges. */
  treated: number;
  died: number;
  leftAma: number;
  /** Wrong-turn episodes (a patient can contribute several). */
  lostEpisodes: number;
  /** Treatment fees billed. */
  revenue: number;
  payroll: number;
  hireFees: number;
  /** Room build spend (capital, not operating expense). */
  construction: number;
  /** Room sell-back income. */
  sellIncome: number;
  /** Vending fees (amenities Stage 1) — a BREAKDOWN of `revenue`, billed
   *  through billFee at the same choke point; never added to dayNet again. */
  vendingRevenue: number;
  /** Σ messes.size per tick (Stage 2) — cleanlinessRepDelta's input; NOT a
   *  cash number, so dayNet ignores it. */
  messTicks: number;
  /** Net reputation change, clamp-aware (sums what was actually applied). */
  repDelta: number;
  /** Door-to-first-treatment waits (ticks), summed over patients whose FIRST
   *  treatment step went active today. Triage does not count as treatment. */
  waitSumTicks: number;
  waitCount: number;
}

export function emptyDayTally(): DayTally {
  return {
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
  };
}

/** Midnight snapshot carried by the `dayEnded` event. */
export interface DayReport extends DayTally {
  /** The day that just closed (1-based). */
  day: number;
  /** Cash and reputation AFTER day-close adjustments. */
  cash: number;
  reputation: number;
  /** null when no first-treatments happened today (then no bonus either). */
  avgWaitGameMinutes: number | null;
  /** Day-close rep bonus (avg wait under the balance threshold) — already applied. */
  waitBonusAwarded: boolean;
}

/**
 * The day's cash movement, one derivation for UI and harness alike (§3.1 rule
 * 4). Delegates to `netFromCategories` (FINANCE_PLAN §9.6) so the FINANCE
 * table is the single fold: a new cash category joins the net automatically
 * instead of being silently omitted here. A test pins byte-equality with the
 * legacy formula (`revenue + sellIncome − payroll − hireFees − construction`).
 */
export function dayNet(tally: DayTally): number {
  return netFromCategories(tally);
}
