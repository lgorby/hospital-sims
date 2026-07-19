import { describe, it } from 'vitest';

import {
  HOURS_PER_DAY,
  TICKS_PER_DAY,
  TICKS_PER_GAME_HOUR,
} from '../src/sim/clock';
import { BALANCE } from '../src/sim/data/balance';
import { ROLE_DEFS, type RoleId } from '../src/sim/data/roles';
import { ROOM_DEFS, ROOM_TYPES, type RoomType } from '../src/sim/data/rooms';
import { EventBus } from '../src/events';
import { setupNewGame } from '../src/sim/newGame';
import { World } from '../src/sim/world';
import {
  COMPACT_BUILD,
  EXPANSION_WING,
  REFERENCE_BUILD,
  matureStaffRoster,
  type RoomSpec,
} from './fixtures/builds';

/**
 * THE EARLY-GAME ECONOMY PROBE — ECONOMY_STAGE1_CONTRACT §4, the v2 prerequisite.
 *
 * Three straight contracts (observation, shifts, economy Stage-1) died the SAME
 * way: deriving balance numbers from the mature, cash-rich REFERENCE build,
 * where affordability is trivial. The rebalance's binding arm — where a fee cut
 * plus new utility/repair costs either bankrupt a new player or don't — is the
 * EARLY GAME, and no probe measured it. This one does.
 *
 * It is a MEASUREMENT INSTRUMENT, not an assertion suite: it prints tables and
 * asserts nothing (the balance thresholds it feeds live in the Stage-1
 * regressions, which land WITH the change). The three rebalance levers do NOT
 * exist in the sim yet, so the probe INJECTS them from outside `src/` (the
 * `edProbe.withArm` / observation-measurement precedent):
 *   - fee scale   — a fraction of each treatment/outpatient fee is refunded out
 *                   of `world.cash` the moment it is billed, so the sim's own
 *                   bankruptcy check sees the reduced cash.
 *   - utilities   — a per-game-hour charge, room footprint tiles × a per-type
 *                   rate, debited every game hour.
 *   - repairs     — a per-type cash charge on every breakdown (`roomBroken`),
 *                   the stochastic maintenance cost the game lacks today. Charged
 *                   on the BREAK as a proxy for on-completion (contract §5.3): no
 *                   repair-completion event exists, and break-count ≈ completion-
 *                   count. NOTE the starter build has no breakable room, so this
 *                   lever gets ZERO signal on the binding arm — see the N/A note.
 *
 * Because the levers are LINEAR, the RAW streams (gross revenue, payroll, tile-
 * hours, breakdowns) are reported per arm so v2 can solve the fee scale / rates
 * ANALYTICALLY against a target margin on the binding arm — no N-D sweep.
 *
 * Run: ECONOMY_PROBE=1 npx vitest run test/economyProbe.test.ts --disable-console-intercept
 */

// --------------------------------------------------------------------------
// The early-game arm — the BINDING build that does not exist in any other probe.
// Reception + waiting come from setupNewGame (free); the player has bought a
// triage, one exam and one ER out of the $50k start. Rects are lifted verbatim
// from REFERENCE_BUILD, so they are known-legal against the pre-built rooms.
// --------------------------------------------------------------------------
const EARLY_GAME_BUILD: RoomSpec[] = [
  { type: 'triage', rect: { col: 10, row: 28, cols: 2, rows: 2 }, door: { col: 12, row: 29 } },
  { type: 'exam', rect: { col: 14, row: 27, cols: 3, rows: 3 }, door: { col: 17, row: 28 } },
  { type: 'er', rect: { col: 32, row: 26, cols: 3, rows: 4 }, door: { col: 35, row: 27 } },
];

const EARLY_STAFF: { role: RoleId; count: number }[] = [
  { role: 'nurse', count: 1 },
  { role: 'doctor', count: 1 },
  // The receptionist is already hired by setupNewGame.
];

// --------------------------------------------------------------------------
// The candidate levers. These are STARTING GUESSES to be refined analytically
// from the raw streams — NOT shipping numbers. Rates are $/tile/game-hour;
// repairs are $/breakdown. Grouped by draw class so a reviewer can sanity-check
// the shape: imaging/OR draw the most power and cost the most to fix.
// --------------------------------------------------------------------------
function ratesByType(pick: (t: RoomType) => number): Record<RoomType, number> {
  const out = {} as Record<RoomType, number>;
  for (const t of ROOM_TYPES) out[t] = pick(t);
  return out;
}

const HIGH_DRAW: readonly RoomType[] = ['xray', 'ct', 'mri', 'nucMed', 'ultrasound', 'surgery', 'dialysis'];
const MED_DRAW: readonly RoomType[] = ['er', 'exam', 'triage', 'resp'];

const UTIL_PER_TILE_HOUR = ratesByType((t) =>
  HIGH_DRAW.includes(t) ? 1.5 : MED_DRAW.includes(t) ? 0.6 : 0.3,
);

// Only rooms with a `failure` block ever break; the rest are charged nothing.
const REPAIR_COST = ratesByType((t) => {
  if (!('failure' in ROOM_DEFS[t])) return 0;
  if (t === 'mri') return 1_800;
  if (t === 'ct' || t === 'nucMed') return 1_200;
  if (t === 'surgery') return 1_500;
  if (t === 'xray') return 400;
  if (t === 'dialysis') return 600;
  return 200; // restroom, resp — cheap piping/mechanical
});

interface Levers {
  label: string;
  feeScale: number;
  /** Always-on base draw (HVAC/lighting), $/tile/game-hour. Keep small — a flat
   *  per-tile rate is regressive against low-VOLUME rooms (CT earns little but is
   *  16 tiles) AND the starter. */
  utilPerTileHour: Record<RoomType, number>;
  /** Usage draw, $ per ACTIVE room-hour (a room holding ≥1 reservation). This is
   *  the main size/scale lever: a busy MRI pays a lot, an idle CT little, so it
   *  tracks revenue instead of punishing low-volume rooms — the design-MAJOR-3
   *  "scale utilities by USE" remedy. */
  utilPerActiveHour: Record<RoomType, number>;
  repairCost: Record<RoomType, number>;
}

const ZERO_UTIL = ratesByType(() => 0);
const ZERO_REPAIR = ratesByType(() => 0);

/** Today's economy: full fees, no new costs. Should reproduce the ~82% margin. */
const BASELINE: Levers = {
  label: 'BASELINE (today)',
  feeScale: 1,
  utilPerTileHour: ZERO_UTIL,
  utilPerActiveHour: ZERO_UTIL,
  repairCost: ZERO_REPAIR,
};

/** The contract §3 ballpark: cut fees ~half, add FLAT per-tile utilities + repairs.
 *  Retained to show WHY flat per-tile fails (CT goes net-negative). */
const BALLPARK: Levers = {
  label: 'BALLPARK (fee×0.5 +flat-util +repair)',
  feeScale: 0.5,
  utilPerTileHour: UTIL_PER_TILE_HOUR,
  utilPerActiveHour: ZERO_UTIL,
  repairCost: REPAIR_COST,
};

/** Equipment rooms — carry the usage-scaled utility; basic clinical rooms don't
 *  (protecting the throughput-starved starter, whose triage/exam/ER are active). */
const EQUIP: readonly RoomType[] = ['xray', 'ct', 'mri', 'nucMed', 'ultrasound', 'surgery', 'dialysis'];

/**
 * DERIVED from the raw streams (levers are linear): a ~32% fee trim (starter-safe),
 * a tiny always-on per-tile HVAC base, and a per-ACTIVE-hour usage charge on
 * EQUIPMENT only — sized to the weakest OUTPATIENT-driven room (nucMed) staying
 * net-positive. Target: starter stays solvent & grows; mature collapses from ~84%
 * to the measured room-positive/starter-safe FLOOR (~40%), where 2× payroll bites.
 */
const DERIVED_FLAT: Levers = {
  label: 'DERIVED-FLAT (fee×0.68 +HVAC0.05 +usage130flat +repair)',
  feeScale: 0.68,
  utilPerTileHour: ratesByType(() => 0.05),
  utilPerActiveHour: ratesByType((t) => (EQUIP.includes(t) ? 130 : 0)),
  repairCost: REPAIR_COST,
};

/**
 * Measured full-fee revenue per ACTIVE room-hour (REFERENCE arm) — the basis for
 * a PER-TYPE usage rate. A FLAT rate is bounded below by the weakest earner
 * (xray $156), so it can't tax the fat rooms (surgery $720) without sinking xray.
 * A per-type rate = k × (this) charges each room the same FRACTION of its hourly
 * take, so every room keeps the same margin and none goes negative — and k can go
 * higher, reaching a tighter mature floor. (Review finding 1.)
 */
const REV_PER_ACTIVE_HR: Partial<Record<RoomType, number>> = {
  mri: 314, ct: 318, nucMed: 257, xray: 156, ultrasound: 211, dialysis: 216, surgery: 720,
};

/** k = fraction of each equipment room's hourly take taken as usage utility.
 *  0.52 leaves equipment ~ (0.68−0.52)/0.68 ≈ 24% of its scaled revenue as margin —
 *  meaningful profit (imaging still worth building), while collapsing the mature
 *  margin further than the flat rate and keeping EVERY room net-positive. */
const PERTYPE_K = 0.52;
const DERIVED_PERTYPE: Levers = {
  label: `DERIVED-PERTYPE (fee×0.68 +HVAC0.05 +usage${PERTYPE_K}×rev/hr +repair)`,
  feeScale: 0.68,
  utilPerTileHour: ratesByType(() => 0.05),
  utilPerActiveHour: ratesByType((t) => Math.round(PERTYPE_K * (REV_PER_ACTIVE_HR[t] ?? 0))),
  repairCost: REPAIR_COST,
};

interface Arm {
  name: string;
  build: RoomSpec[];
  staff: { role: RoleId; count: number }[];
  days: number;
  /**
   * A mid-run reputation collapse — the mechanism a death cluster acts through
   * (deaths cost reputation; reputation drives arrivals). Applied at the close
   * of `atDay` so the arm runs at steady state first, then takes the hit: the
   * operating-leverage test (does cash TROUGH and CLIMB BACK), not a lower
   * static rep, which would merely reduce arrivals and make the arm EASIER.
   */
  shock?: { atDay: number; reputation: number };
}

interface Probe {
  seed: number;
  grossTreatment: number;
  grossOutpatient: number;
  grossVending: number;
  payrollPerDay: number;
  utilitiesTotal: number;
  repairsTotal: number;
  breaksByType: Map<RoomType, number>;
  tilesByType: Map<RoomType, number>;
  revenueByType: Map<RoomType, number>;
  /** Ticks a room of this type held ≥1 reservation (÷TICKS_PER_GAME_HOUR = active
   *  room-hours). Summed over all rooms of the type. */
  activeTicksByType: Map<RoomType, number>;
  /** The usage (active-hour) portion of utilitiesTotal, for the reporting split. */
  usageTotal: number;
  cashAtStart: number;
  cashEnd: number;
  minCash: number;
  bankrupted: boolean;
  /** cash sampled at the close of each day. */
  cashTrajectory: number[];
  days: number;
  discharged: number;
  died: number;
  leftAma: number;
}

function runEconomy(seed: number, arm: Arm, levers: Levers): Probe {
  const events = new EventBus();
  const world = new World(events, seed);
  setupNewGame(world);

  // Bankroll the imaging/OR CAPITAL only (the operating-envelope convention the
  // ED probe uses); everything else is bought from the $50k start, so the
  // early-game arm pays REAL capex and its post-build cash is the honest floor.
  world.cash += arm.build
    .filter((r) => EXPANSION_WING.includes(r.type))
    .reduce((sum, r) => sum + ROOM_DEFS[r.type].cost, 0);
  for (const spec of arm.build) world.buildRoom(spec.type, spec.rect, spec.door);
  // buildRoom REJECTS silently (emits buildRejected, returns) on overlap / bad
  // door / trap-BFS failure — so a fixture edit could measure fewer rooms than
  // claimed while reporting a full build (the edProbe layout-arm guard). +2 for
  // the pre-built reception + waiting.
  const expectedRooms = arm.build.length + 2;
  if (world.rooms.size !== expectedRooms) {
    const got = [...world.rooms.values()].map((r) => r.type).sort().join(',');
    throw new Error(`${arm.name}: expected ${expectedRooms} rooms, built ${world.rooms.size} [${got}]`);
  }
  world.placeAmenity('vending', { col: 26, row: 33 });
  world.placeAmenity('trashcan', { col: 27, row: 33 });
  for (const { role, count } of arm.staff) {
    for (let i = 0; i < count; i++) world.addStaffMember(role, 3, ROLE_DEFS[role].salaryPerDay);
  }

  const roomType = new Map<number, RoomType>();
  for (const room of world.rooms.values()) roomType.set(room.id, room.type);

  const p: Probe = {
    seed,
    grossTreatment: 0,
    grossOutpatient: 0,
    grossVending: 0,
    payrollPerDay: [...world.staff.values()].reduce((s, m) => s + m.salaryPerDay, 0),
    utilitiesTotal: 0,
    repairsTotal: 0,
    breaksByType: new Map(),
    tilesByType: new Map(),
    revenueByType: new Map(),
    activeTicksByType: new Map(),
    usageTotal: 0,
    cashAtStart: world.cash,
    cashEnd: 0,
    minCash: world.cash,
    bankrupted: false,
    cashTrajectory: [],
    days: arm.days,
    discharged: 0,
    died: 0,
    leftAma: 0,
  };

  // Footprint tiles per type over ALL rooms (incl. the free reception+waiting),
  // matching what the hourly utilities charge actually iterates. Constant per
  // day — reported raw so utilities can be recomputed at any rate.
  for (const room of world.rooms.values()) {
    p.tilesByType.set(room.type, (p.tilesByType.get(room.type) ?? 0) + room.rect.cols * room.rect.rows);
  }

  events.on('feeBilled', ({ amount, source }) => {
    if (source === 'vending') {
      p.grossVending += amount;
      return; // vending is fee-exempt (contract §3 MINOR)
    }
    if (source === 'outpatient') p.grossOutpatient += amount;
    else p.grossTreatment += amount;
    // Refund the cut portion so the sim's cash — and its bankruptcy check — see
    // the reduced fee in real time.
    world.cash -= amount * (1 - levers.feeScale);
  });
  events.on('roomBroken', ({ roomId }) => {
    const t = roomType.get(roomId);
    if (t === undefined) return;
    const cost = levers.repairCost[t];
    p.breaksByType.set(t, (p.breaksByType.get(t) ?? 0) + 1);
    p.repairsTotal += cost;
    world.cash -= cost;
  });
  events.on('patientDischarged', () => (p.discharged += 1));
  events.on('patientDied', () => (p.died += 1));
  events.on('patientLeftAma', () => (p.leftAma += 1));

  const totalTicks = TICKS_PER_DAY * arm.days;
  const hourlyActive = new Map<RoomType, number>(); // active-room-ticks in the current hour
  for (let i = 0; i < totalTicks; i++) {
    world.tick();
    // Usage sampling: a room is ACTIVE this tick if it holds ≥1 reservation.
    // NB this is reservation-HELD time (dispatch → walk → treat → complete), not
    // pure equipment-in-use time — a committed room draws prep/HVAC, so it is a
    // defensible "room in service" proxy, but the contract should state it
    // (review finding 4): a metered-power model would gate on an occupied stage.
    const activeRooms = new Set<number>();
    for (const res of world.reservations.values()) activeRooms.add(res.roomId);
    for (const roomId of activeRooms) {
      const t = roomType.get(roomId);
      if (t === undefined) continue;
      hourlyActive.set(t, (hourlyActive.get(t) ?? 0) + 1);
      p.activeTicksByType.set(t, (p.activeTicksByType.get(t) ?? 0) + 1);
    }
    if (world.clock.tick % TICKS_PER_GAME_HOUR === 0) {
      let base = 0;
      for (const room of world.rooms.values()) {
        base += room.rect.cols * room.rect.rows * levers.utilPerTileHour[room.type];
      }
      let usage = 0;
      for (const [t, ticks] of hourlyActive) {
        usage += (ticks / TICKS_PER_GAME_HOUR) * levers.utilPerActiveHour[t];
      }
      hourlyActive.clear();
      world.cash -= base + usage;
      p.utilitiesTotal += base + usage;
      p.usageTotal += usage;
    }
    if (world.cash < p.minCash) p.minCash = world.cash;
    if (world.bankruptSinceTick !== null) p.bankrupted = true;
    if (world.clock.tick % TICKS_PER_DAY === 0) {
      const dayClosed = world.clock.tick / TICKS_PER_DAY; // 1-based: first close = day 1
      p.cashTrajectory.push(Math.round(world.cash));
      if (arm.shock && dayClosed === arm.shock.atDay) world.reputation = arm.shock.reputation;
    }
  }

  for (const room of world.rooms.values()) {
    p.revenueByType.set(room.type, (p.revenueByType.get(room.type) ?? 0) + room.revenueTotal);
  }
  p.cashEnd = world.cash;
  return p;
}

// --------------------------------------------------------------------------
// Reporting — per arm, averaged over seeds, with the raw streams up front.
// --------------------------------------------------------------------------
// ALL equipment rooms (not just the original 4) — a per-type utility rate must
// keep the WEAKEST-earning room (xray/ct) net-positive, so all must be visible.
const PL_TYPES: readonly RoomType[] = ['mri', 'nucMed', 'ct', 'xray', 'ultrasound', 'dialysis', 'surgery'];
const EXPANSION_TRIGGER = ROOM_DEFS.er.cost; // "can a new player afford another ER?"

function report(arm: Arm, levers: Levers, rows: Probe[]): void {
  const n = rows.length;
  const avg = (f: (r: Probe) => number): number => rows.reduce((s, r) => s + f(r), 0) / n;
  const scaledRev = (r: Probe): number =>
    (r.grossTreatment + r.grossOutpatient) * levers.feeScale + r.grossVending;
  const perDay = (v: number, r: Probe): number => v / r.days;

  const revDay = avg((r) => perDay(scaledRev(r), r));
  const payDay = avg((r) => r.payrollPerDay);
  const utilDay = avg((r) => perDay(r.utilitiesTotal, r));
  const repDay = avg((r) => perDay(r.repairsTotal, r));
  const profitDay = revDay - payDay - utilDay - repDay;
  const margin = revDay > 0 ? (profitDay / revDay) * 100 : 0;

  console.log(`\n=== ${arm.name}  ·  ${levers.label} ===`);
  console.log(
    [
      `rev/d $${revDay.toFixed(0)}`,
      `payroll/d $${payDay.toFixed(0)}`,
      `util/d $${utilDay.toFixed(0)}`,
      `repairs/d $${repDay.toFixed(0)}`,
      `profit/d $${profitDay.toFixed(0)}`,
      `MARGIN ${margin.toFixed(1)}%`,
    ].join(' | '),
  );
  console.log(
    [
      `grossTreat/d $${avg((r) => perDay(r.grossTreatment, r)).toFixed(0)}`,
      `grossOutp/d $${avg((r) => perDay(r.grossOutpatient, r)).toFixed(0)}`,
      `vending/d $${avg((r) => perDay(r.grossVending, r)).toFixed(0)}`,
      `disch/d ${avg((r) => perDay(r.discharged, r)).toFixed(1)}`,
      `died/d ${avg((r) => perDay(r.died, r)).toFixed(1)}`,
      `AMA/d ${avg((r) => perDay(r.leftAma, r)).toFixed(1)}`,
    ].join(' | '),
  );
  // Solvency. NB the raw `bankrupted 0/N` line is NOT a safety signal on a
  // cushioned short arm — a starter bleeding −$400/day off $34k is ~85 days from
  // the −$10k threshold, so it prints "bankrupted 0" while dying. The lateNet
  // and the ⚠ runway line below are what actually detect a slow bleed (finding 2).
  const bankrupts = rows.filter((r) => r.bankrupted).length;
  // cashTrajectory[0] is the close of DAY 1, so a hit at index d is day d+1 (finding 4).
  // This measures BANKING a second ER's cost ON TOP of a full starting reserve —
  // a growth proxy, NOT affordability (the starter already holds ≫ one ER; finding 3).
  const bankDay = (r: Probe): number => {
    const target = r.cashAtStart + EXPANSION_TRIGGER;
    const d = r.cashTrajectory.findIndex((c) => c >= target);
    return d < 0 ? Infinity : d + 1;
  };
  const bankedN = rows.filter((r) => Number.isFinite(bankDay(r))).length;
  const bankedDays = rows.map(bankDay).filter(Number.isFinite);
  // Daily net over the 2nd half of the run — surfaces a monotonic bleed the
  // bankruptcy line hides on a short, cushioned horizon.
  const lateNet = (r: Probe): number => {
    const t = r.cashTrajectory;
    if (t.length < 2) return 0;
    const mid = Math.floor(t.length / 2);
    return (t[t.length - 1]! - t[mid]!) / (t.length - 1 - mid);
  };
  console.log(
    [
      `cash@start $${avg((r) => r.cashAtStart).toFixed(0)}`,
      `cash@end $${avg((r) => r.cashEnd).toFixed(0)}`,
      `minCash $${avg((r) => r.minCash).toFixed(0)}`,
      `lateNet/d $${avg(lateNet).toFixed(0)}`,
      `bankrupted ${bankrupts}/${n}`,
      `banked+ER ${bankedN}/${n}${bankedDays.length ? ` (~day ${(bankedDays.reduce((s, d) => s + d, 0) / bankedDays.length).toFixed(1)})` : ''}`,
    ].join(' | '),
  );
  if (profitDay < 0) {
    const runway = (avg((r) => r.cashAtStart) - BALANCE.economy.bankruptcyThreshold) / -profitDay;
    console.log(
      `  ⚠ BLEEDING $${(-profitDay).toFixed(0)}/day ⇒ ~${runway.toFixed(0)} days to insolvency ` +
        `(beyond the ${rows[0]!.days}-day window — 'bankrupted 0' is NOT safe here)`,
    );
  }
  if (arm.shock) {
    // trajectory[atDay-1] is the PRE-shock close (cash is pushed, THEN rep is cut).
    // A real trough must appear AFTER that (slice atDay onward); comparing to it
    // distinguishes "dipped then recovered" from "never dipped" (review finding 2).
    const shockCash = (r: Probe): number => r.cashTrajectory[arm.shock!.atDay - 1] ?? r.cashAtStart;
    const postTrough = (r: Probe): number => Math.min(...r.cashTrajectory.slice(arm.shock!.atDay));
    const dipped = rows.filter((r) => postTrough(r) < shockCash(r)).length;
    const recovered = rows.filter((r) => postTrough(r) < shockCash(r) && r.cashEnd > postTrough(r)).length;
    console.log(
      `  SHOCK@day ${arm.shock.atDay} (rep→${arm.shock.reputation}): cash@shock $${avg(shockCash).toFixed(0)} → ` +
        `post-trough $${avg(postTrough).toFixed(0)} → end $${avg((r) => r.cashEnd).toFixed(0)} | ` +
        `dipped ${dipped}/${n} | recovered-from-dip ${recovered}/${n}` +
        (dipped === 0 ? ' (NO TROUGH — margin cushions the shock; recovery untested)' : ''),
    );
  }
  // Per-seed net/day — the averaged profit line can hide a seed bleeding without
  // bankrupting; this shows the spread (review finding 5).
  console.log(
    '  per-seed net/d: ' +
      rows.map((r) => `${r.seed} $${((r.cashEnd - r.cashAtStart) / r.days).toFixed(0)}`).join('  '),
  );
  // Per-room-type P&L — protect the LIVE outpatient milestone: utilities must
  // not turn a just-populated imaging/OR room into a net loss. util = base
  // (tiles × tileRate × 24, per-day-constant) + usage (active-hours × usageRate).
  const activeHrs = (r: Probe, t: RoomType): number => (r.activeTicksByType.get(t) ?? 0) / TICKS_PER_GAME_HOUR;
  const plParts = PL_TYPES.map((t) => {
    const rev = avg((r) => perDay((r.revenueByType.get(t) ?? 0) * levers.feeScale, r));
    const util = avg(
      (r) =>
        (r.tilesByType.get(t) ?? 0) * levers.utilPerTileHour[t] * HOURS_PER_DAY +
        perDay(activeHrs(r, t) * levers.utilPerActiveHour[t], r),
    );
    const rep = avg((r) => perDay((r.breaksByType.get(t) ?? 0) * levers.repairCost[t], r));
    return `${t} $${(rev - util - rep).toFixed(0)} (rev ${rev.toFixed(0)} -u ${util.toFixed(0)} -r ${rep.toFixed(0)})`;
  });
  console.log('  per-room P&L/d: ' + plParts.join(' | '));
  // The raw, lever-independent streams for the analytical solve.
  const tileHours = avg((r) => [...r.tilesByType.values()].reduce((s, v) => s + v, 0) * HOURS_PER_DAY);
  const breaksDay = avg((r) => perDay([...r.breaksByType.values()].reduce((s, v) => s + v, 0), r));
  const usageDay = avg((r) => perDay(r.usageTotal, r));
  console.log(
    `  RAW: grossRev/d $${avg((r) => perDay(r.grossTreatment + r.grossOutpatient, r)).toFixed(0)} | tile-hours/d ${tileHours.toFixed(0)} | usage-util/d $${usageDay.toFixed(0)} | breakdowns/d ${breaksDay.toFixed(2)}`,
  );
  // Per-type footprint (constant) + active room-hours/day (the usage lever base)
  // — enough to re-derive BOTH utility components at any rate for every type.
  console.log(
    '  tiles/type: ' + [...rows[0]!.tilesByType.entries()].map(([t, v]) => `${t} ${v}`).join(' '),
  );
  console.log(
    '  active-hrs/d: ' +
      [...rows[0]!.activeTicksByType.keys()]
        .map((t) => `${t} ${avg((r) => perDay(activeHrs(r, t), r)).toFixed(1)}`)
        .join(' '),
  );
  if (avg((r) => r.repairsTotal) === 0 && avg((r) => r.grossOutpatient) === 0) {
    console.log(
      '  (levers N/A on this arm: no breakable/imaging rooms — repairs & outpatient are 0 by' +
        ' construction, not because they are affordable; repairs are proxied by roomBroken)',
    );
  }
  console.log('  cash trajectory (day-close, seed ' + rows[0]!.seed + '): ' + rows[0]!.cashTrajectory.join(' → '));
}

// --------------------------------------------------------------------------
declare const process: { env: Record<string, string | undefined> } | undefined;
const describeProbe =
  typeof process !== 'undefined' && process.env.ECONOMY_PROBE ? describe : describe.skip;

describeProbe('Economy Stage-1 probe (ECONOMY_STAGE1_CONTRACT §4)', () => {
  it('prints per-arm economy tables under candidate levers', () => {
    const seeds = [1337, 1338, 31337, 4242, 90210];

    const arms: Arm[] = [
      // THE BINDING ARM: a new player, real capex, minimal roster, 10 days.
      // (~$34k post-build cash, not $50k — that is spent on the triage/exam/ER.)
      { name: 'EARLY-GAME (starter, ~$34k post-build)', build: EARLY_GAME_BUILD, staff: EARLY_STAFF, days: 10 },
      // THE CEILING ARMS: the mature reference/compact builds — a well-run
      // hospital should still profit, just not at 82%.
      { name: 'REFERENCE (mature)', build: REFERENCE_BUILD, staff: matureStaffRoster(), days: 5 },
      { name: 'COMPACT (mature)', build: COMPACT_BUILD, staff: matureStaffRoster(), days: 5 },
    ];

    for (const arm of arms) {
      for (const levers of [BASELINE, DERIVED_PERTYPE]) {
        report(arm, levers, seeds.map((s) => runEconomy(s, arm, levers)));
      }
    }

    // WHY per-type: on REFERENCE, show the two rejected flat structures — flat
    // per-tile (BALLPARK: CT/xray net-negative) and flat per-active-hour
    // (DERIVED-FLAT: xray still net-negative, surgery barely taxed). Both are
    // dominated by DERIVED-PERTYPE above.
    const ref: Arm = { name: 'REFERENCE (mature)', build: REFERENCE_BUILD, staff: matureStaffRoster(), days: 5 };
    for (const levers of [BALLPARK, DERIVED_FLAT]) {
      report(ref, levers, seeds.map((s) => runEconomy(s, ref, levers)));
    }

    // THE SHOCK ARM (finding 1): NOT a low static rep — that reduces arrivals and
    // makes a capacity-bound hospital EASIER. A real operating-leverage test runs
    // a MATURE build under the tightened economy to steady state, then collapses
    // reputation mid-run (a death cluster's mechanism), and asks whether cash
    // TROUGHS and CLIMBS BACK — level is not enough at high operating leverage.
    // A HARSH shock (rep→50 ≈ 45% arrival cut) under the tightened per-type
    // economy — where operating leverage is real — so the trough is a genuine
    // test, not the vacuous "cash never dipped" the 40% economy produced.
    const shockArm: Arm = {
      name: 'SHOCK (mature, rep→50 @day6)',
      build: REFERENCE_BUILD,
      staff: matureStaffRoster(),
      days: 12,
      shock: { atDay: 6, reputation: 50 },
    };
    report(shockArm, DERIVED_PERTYPE, seeds.map((s) => runEconomy(s, shockArm, DERIVED_PERTYPE)));

    // The 2× payroll check (the direct shifts unblock): under the tightened
    // economy, does doubling labor drop the mature margin hard (cost now bites)?
    const dblStaff = matureStaffRoster().map((s) => ({ ...s, count: s.count * 2 }));
    const dblArm: Arm = { name: 'REFERENCE 2× payroll', build: REFERENCE_BUILD, staff: dblStaff, days: 5 };
    report(dblArm, DERIVED_PERTYPE, seeds.map((s) => runEconomy(s, dblArm, DERIVED_PERTYPE)));
  }, 600_000);
});
