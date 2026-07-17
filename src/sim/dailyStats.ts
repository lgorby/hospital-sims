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

/** The day's cash movement, one derivation for UI and harness alike (§3.1 rule 4). */
export function dayNet(tally: DayTally): number {
  return tally.revenue + tally.sellIncome - tally.payroll - tally.hireFees - tally.construction;
}
