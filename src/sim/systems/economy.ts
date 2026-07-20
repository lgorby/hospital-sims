import { HOURS_PER_DAY, TICKS_PER_GAME_HOUR } from '../clock';
import { roomHvacPerHour, roomUsagePerHour, shiftWageMultiplier } from '../formulas';
import type { World } from '../world';

/** Hourly operating costs: payroll (GDD §6) + utilities (ECONOMY Stage-1). */
export function updateEconomy(world: World): void {
  if (world.clock.tick % TICKS_PER_GAME_HOUR !== 0) return;

  // Payroll: hourly pro-rata of the WHOLE roster (charged on-shift or not — you
  // pay for coverage you hire). SHIFTS Stage-1: a SHIFTED staffer is paid a
  // per-shift wage (wageFactor), so 24/7 = 2× day-only; null-shift = full wage.
  let payrollPerDay = 0;
  for (const member of world.staff.values()) {
    payrollPerDay += member.salaryPerDay * shiftWageMultiplier(member.shift);
  }
  const payrollHour = payrollPerDay / HOURS_PER_DAY;
  if (payrollHour > 0) {
    world.cash -= payrollHour;
    // tallyCash, not `today.payroll +=` (FINANCE_PLAN §9.5): today and lifetime
    // move together or the finances grid's Today and Total columns disagree.
    world.tallyCash('payroll', payrollHour);
  }

  // Utilities (ECONOMY_STAGE1_CONTRACT v2): an always-on HVAC/lighting base on
  // EVERY room (size-scaled), plus a usage draw on each EQUIPMENT room that is
  // ACTIVE this hour (holds ≥1 reservation). Activity is sampled ONCE per
  // game-hour — an approximation of active-room-hours (the per-type rates were
  // derived per-tick); the aggregate is tuned via feeScale, and the per-room
  // net-positive invariant it must preserve is pinned by the economyStage1 guard.
  // A broken/closed room holds no reservation, so it draws only the base — the
  // double-penalty the v1 review flagged is avoided by construction. NB an
  // unstaffed but built hospital still pays the base every hour (payroll=0 no
  // longer short-circuits this) — so idle over-building is now a real cash drain.
  let utilities = 0;
  for (const room of world.rooms.values()) {
    utilities += roomHvacPerHour(room.rect);
    const usage = roomUsagePerHour(room.type);
    if (usage > 0 && world.reservationsOn(room.id).length > 0) utilities += usage;
  }
  if (utilities > 0) {
    world.cash -= utilities;
    world.tallyCash('utilities', utilities);
  }

  if (payrollHour > 0 || utilities > 0) world.events.emit('cashChanged', { cash: world.cash });
}
