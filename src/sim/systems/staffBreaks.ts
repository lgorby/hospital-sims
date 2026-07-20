import { gameMinutesToTicks } from '../clock';
import { BALANCE } from '../data/balance';
import type { Room } from '../entities/room';
import type { Staff, StaffBreak } from '../entities/staff';
import { inLunchWindow, meterDecayPerTick, onShift } from '../formulas';
import { findPath } from '../path/astar';
import { samePoint } from '../types';
import type { World } from '../world';
import { placeAtEntrance } from './shifts';

/**
 * SHIFTS Stage 2 (SHIFTS_STAGE2_CONTRACT §3) — the mid-shift lunch. Each real-
 * hired staffer takes ONE ~30-min lunch per shift, at a personal time staggered
 * across a window (an id hash, rng-free) so co-workers don't overlap, and a
 * per-role coverage cap keeps the floor from emptying. WITH a lounge the lunch
 * is short + on-site; WITHOUT one she leaves the building to eat (longer).
 *
 * Runs BETWEEN updatePatientNeeds and updateShifts (frozen tick order): breaks
 * settle here, the shift boundary reconciles next (cancel-lunch / respawn-gate),
 * then the dispatcher sees the settled pool. Lounge-seat occupancy is DERIVED
 * from `onBreak` (world.loungeSeatClaims), so release frees the seat by
 * construction. An on-break staffer is excluded from the dispatch pool by the
 * `onBreak === null` clause (dispatcher.ts).
 *
 * INERT for null-shift (test) rosters: they never satisfy the shift gate.
 */
export function updateStaffBreaks(world: World): void {
  const minute = world.clock.minuteOfDay;
  const watchdogTicks = gameMinutesToTicks(BALANCE.shifts.lunch.breakWatchdogGameMinutes);
  // ONE sequential pass in ascending id order (§3.3): advancing in-flight breaks
  // and triggering new ones together, mutating `onBreak` in place, so a later
  // candidate sees an earlier committer as on-break — the coverage cap resolves
  // deterministically, never on Map insertion order.
  const members = [...world.staff.values()].sort((a, b) => a.id - b.id);
  for (const member of members) {
    // SHIFTS Stage 3a: fatigue accrual/recovery runs FIRST — structurally before
    // the onBreak/tryStartLunch early exits, so home staff recover (they'd
    // otherwise never reach it). Lunch-rest is applied in advanceBreak.
    updateFatigue(world, member, minute);
    if (member.onBreak !== null) {
      advanceBreak(world, member, member.onBreak, watchdogTicks);
      continue;
    }
    tryStartLunch(world, member, minute);
  }
}

/**
 * SHIFTS Stage 3a (§3): load-weighted accrual while on-duty, recovery while
 * off-shift at home, FROZEN in the between windows. INERT for null-shift staff, so
 * every existing fixture stays bit-identical. Pure arithmetic, no rng.
 */
function updateFatigue(world: World, member: Staff, minute: number): void {
  if (member.shift === null) return; // null-shift (test) staff never tire
  const f = BALANCE.shifts.fatigue;
  const onDuty = onShift(member.shift, minute);
  if (onDuty && member.onFloor && member.onBreak === null) {
    // Accrue, LOAD-WEIGHTED: a base rate + more per active treatment bay, so the
    // busy bottleneck staff tire fastest — where the lounge payoff must land.
    // Alloc-free count (the staffLoadIn idiom) — no per-tick sort (post-impl review).
    let activeLoad = 0;
    for (const r of world.reservations.values()) {
      if (r.phase === 'active' && r.kind === 'treatment' && r.staffIds.includes(member.id)) {
        activeLoad += 1;
      }
    }
    const rate = f.basePerGameHour + f.workPerGameHour * activeLoad;
    member.fatigue = Math.min(f.max, member.fatigue + meterDecayPerTick(rate));
  } else if (!onDuty && !member.onFloor) {
    // Recover at home — SHIFT-gated, so guaranteed nightly even 1-deep.
    member.fatigue = Math.max(0, member.fatigue - meterDecayPerTick(f.recoveryPerGameHour));
  }
  // else: off-shift-on-floor (draining/walking home) OR on-shift-off-floor (an
  // off-floor lunch) → FROZEN. Lunch rest is applied at completion (advanceBreak).
}

/** Eligible + coverage-cap OK → commit to a lunch (§3.2–3.4). */
function tryStartLunch(world: World, member: Staff, minute: number): void {
  if (member.shift === null) return; // always-on (test rosters) never lunch
  if (!member.onFloor) return; // gone home / off-map
  if (member.lunchedThisShift) return; // one lunch per shift
  if (!onShift(member.shift, minute)) return;
  // Holds no LIVE work: idle, or a standing post she can un-post. A `reserved`
  // (gathering OR active) or `job` staffer must NOT leave — the lunch path has
  // no gather-cancel, so a gathering staffer walking off would strand her
  // patient (the mechanical-review MAJOR). She simply skips lunch (§3.4).
  if (member.duty.kind !== 'idle' && member.duty.kind !== 'post') return;
  if (!inLunchWindow(member.shift, member.id, minute)) return;
  if (!coveragePermits(world, member, minute)) return;
  startLunch(world, member);
}

/**
 * The coverage cap (§3.3, the "never all at once" guarantee): a lunch may start
 * only if — after this staffer leaves — at least `minSameRoleOnFloor` same-role
 * workers remain on-shift, on-floor, and NOT on break (walking-to-lunch counts
 * as on break). A solo-of-a-role therefore never lunches. Derived live, so it
 * cannot desync; null-shift colleagues count as always-present coverage.
 */
function coveragePermits(world: World, member: Staff, minute: number): boolean {
  let remaining = 0;
  for (const s of world.staff.values()) {
    if (s.id === member.id) continue;
    if (s.role !== member.role) continue;
    if (s.firing) continue; // a firing body leaves the floor — not coverage (rolePool parity)
    if (!onShift(s.shift, minute)) continue; // null shift ⇒ true (always on)
    if (!s.onFloor) continue;
    if (s.onBreak !== null) continue; // already on break (walking or using)
    remaining += 1;
  }
  return remaining >= BALANCE.shifts.lunch.minSameRoleOnFloor;
}

/** Go on break: a reachable lounge seat (on-site) if one exists, else off the
 *  floor to eat. Un-posts a standing-post staffer (goes idle) either way. */
function startLunch(world: World, member: Staff): void {
  const claim = claimLoungeSeat(world, member);
  if (claim !== null) {
    member.onBreak = {
      mode: 'lounge',
      roomId: claim.room.id,
      slot: claim.slot,
      phase: 'walking',
      ticksRemaining: 0,
      startedAt: world.clock.tick,
    };
    // Claim exists before slotAnchorTile runs (mirror tryClaimRestroom), so the
    // anchor prefers this staffer's own seat neighbourhood deterministically.
    member.duty = { kind: 'idle' }; // un-post if posted
    world.setWalkerTarget(member, world.slotAnchorTile(claim.room, claim.slot));
  } else {
    member.onBreak = {
      mode: 'offFloor',
      phase: 'walking',
      ticksRemaining: 0,
      startedAt: world.clock.tick,
    };
    member.duty = { kind: 'idle' }; // un-post if posted
    world.setWalkerTarget(member, BALANCE.map.entrance);
  }
  // Set at CLAIM (§3.5): she isn't re-selected next tick, and a rare watchdog
  // abort leaves this true — a failed walk costs the shift's lunch (bounded;
  // the entrance fallback is always reachable, so it essentially never fires).
  member.lunchedThisShift = true;
  world.events.emit('staffUpdated', { staffId: member.id });
}

/** Nearest reachable lounge with a free seat, or null (→ leave to eat). The
 *  walk goal is derived at claim time from the claimed slot (slotAnchorTile). */
function claimLoungeSeat(world: World, member: Staff): { room: Room; slot: number } | null {
  const lounges = world.roomsOfType('lounge').filter((r) => r.door !== null);
  if (lounges.length === 0) return null;
  const start = member.next ?? member.at;
  let best: { room: Room; slot: number; pathLength: number } | null = null;
  for (const room of lounges) {
    const slot = world.freeLoungeSeatIndex(room);
    if (slot === null) continue; // full — walking claimants hold seats too
    const path = findPath(world, start, room.door!.inside, member.id);
    if (path === null) continue; // unreachable now → prefer the always-reachable entrance
    if (best === null || path.length < best.pathLength) {
      best = { room, slot, pathLength: path.length };
    }
  }
  return best === null ? null : { room: best.room, slot: best.slot };
}

/** Advance an in-flight lunch: watchdog → arrival flip → using countdown → end. */
function advanceBreak(
  world: World,
  member: Staff,
  b: StaffBreak,
  watchdogTicks: number,
): void {
  if (b.phase === 'walking') {
    if (world.clock.tick - b.startedAt >= watchdogTicks) {
      abortBreak(world, member);
      return;
    }
    if (!world.walkerArrived(member)) return;
    // Arrived AT the target — lounge: inside the room; offFloor: at the entrance.
    // A dead path (setWalkerTarget nulls target on no-path) reads as "arrived"
    // somewhere else → abort, never flip `using` in the wrong place.
    const room = b.roomId === undefined ? null : (world.rooms.get(b.roomId) ?? null);
    const atTarget =
      b.mode === 'lounge'
        ? room !== null && world.isInsideRoom(member.at, room)
        : samePoint(member.at, BALANCE.map.entrance);
    if (!atTarget) {
      abortBreak(world, member);
      return;
    }
    b.phase = 'using';
    b.ticksRemaining = gameMinutesToTicks(
      b.mode === 'lounge'
        ? BALANCE.shifts.lunch.loungeBreakGameMinutes
        : BALANCE.shifts.lunch.offFloorBreakGameMinutes,
    );
    if (b.mode === 'offFloor') {
      // Now off-map: excluded from tile-claims / render / picking / dispatch.
      member.onFloor = false;
      member.path = [];
      member.target = null;
      world.events.emit('staffUpdated', { staffId: member.id });
    }
    return;
  }
  // using
  b.ticksRemaining -= 1;
  if (b.ticksRemaining > 0) return;
  // SHIFTS Stage 3a: a completed lunch RESTS — a lounge lunch rests more than
  // leaving the building (the payoff gap). Aborted lunches never reach here.
  const rest = b.mode === 'lounge'
    ? BALANCE.shifts.fatigue.loungeRest
    : BALANCE.shifts.fatigue.offFloorRest;
  member.fatigue = Math.max(0, member.fatigue - rest);
  const wasOffFloor = b.mode === 'offFloor';
  member.onBreak = null;
  if (wasOffFloor) {
    // Back on the floor at the entrance, idle — NOT respawn (that resets
    // lunchedThisShift → the double-lunch bug the review caught).
    placeAtEntrance(world, member);
  } else {
    // Already on the floor in the lounge; the dispatcher re-picks her.
    member.duty = { kind: 'idle' };
    world.events.emit('staffUpdated', { staffId: member.id });
  }
}

/** A watchdog/dead-path abort: clear the break, return to duty. `lunchedThisShift`
 *  stays true — she used her attempt (rare; §3.5). Walking-phase only, so she is
 *  still on-floor. */
function abortBreak(world: World, member: Staff): void {
  member.onBreak = null;
  member.duty = { kind: 'idle' };
  member.path = [];
  member.target = null;
  world.events.emit('staffUpdated', { staffId: member.id });
}
