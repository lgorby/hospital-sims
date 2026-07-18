import { HOURS_PER_DAY, TICKS_PER_GAME_HOUR } from '../clock';
import type { World } from '../world';

/** Salaries charge hourly, pro-rated from per-day rates (GDD §6). */
export function updateEconomy(world: World): void {
  if (world.clock.tick % TICKS_PER_GAME_HOUR !== 0) return;
  let payrollPerDay = 0;
  for (const member of world.staff.values()) payrollPerDay += member.salaryPerDay;
  if (payrollPerDay === 0) return;
  world.cash -= payrollPerDay / HOURS_PER_DAY;
  // tallyCash, not `today.payroll +=` (FINANCE_PLAN §9.5): today and lifetime
  // move together or the finances grid's Today and Total columns disagree.
  world.tallyCash('payroll', payrollPerDay / HOURS_PER_DAY);
  world.events.emit('cashChanged', { cash: world.cash });
}
