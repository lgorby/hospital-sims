import { gameMinutesToTicks } from '../clock';
import { BALANCE } from '../data/balance';
import { ROOM_DEFS } from '../data/rooms';
import type { Patient, NeedBreak } from '../entities/patient';
import type { Room } from '../entities/room';
import { findPath } from '../path/astar';
import { ORTHOGONAL_STEPS, type GridPoint } from '../types';
import type { World } from '../world';

/**
 * Need side-trips (amenities epic Stage 1, AMENITIES_PLAN §3.2 / impl plan
 * §1.9): a sub-state machine following the `lost` precedent — the lifecycle
 * stage stays `waiting`/`waitingTriage`, `waitingSince` keeps aging (Flow
 * rule 6), and the dispatcher skips on-break patients. Stall/machine claims
 * are DERIVED from `needBreak` (world.stallClaims / vendingClaimedBy), so
 * terminal clears release everything by construction (rule-7 analogue).
 *
 * Runs between thoughts and the dispatcher (frozen tick order).
 */

/** Meters are only ACTIONABLE (trigger a side-trip) in the free-waiting
 *  stages (§3.1): queued-at-desk patients won't abandon the desk slot,
 *  reserved patients won't break a gathering. */
function eligibleStage(patient: Patient): boolean {
  return patient.stage.kind === 'waiting' || patient.stage.kind === 'waitingTriage';
}

/** The retry hold after ANY failed or abandoned claim (pre-impl MAJOR 4):
 *  without it, every below-threshold waiter re-probes findPath every tick. */
function setRetryHold(world: World, patient: Patient): void {
  patient.needBreakHoldUntil =
    world.clock.tick + gameMinutesToTicks(BALANCE.needs.breakRetryGameMinutes);
}

export function updatePatientNeeds(world: World): void {
  const watchdogTicks = gameMinutesToTicks(BALANCE.needs.breakWatchdogGameMinutes);
  for (const patient of [...world.patients.values()]) {
    if (patient.stage.kind === 'dead' || patient.stage.kind === 'leaving') continue;
    if (patient.needBreak !== null) {
      advanceBreak(world, patient, patient.needBreak, watchdogTicks);
      continue;
    }
    // Trigger gates (design MAJOR 1 — the canReachRoom class): eligible
    // stage, not lost (never setWalkerTarget a lost patient), hold honored.
    if (!eligibleStage(patient) || patient.lost !== null) continue;
    if (world.clock.tick < patient.needBreakHoldUntil) continue;
    // A FAILED probe of one need must not starve the other (code review
    // MINOR 2: a perpetually-full restroom would otherwise re-arm the shared
    // hold every window and a free vending machine two tiles away never gets
    // tried). Try both needs this tick; the hold is set once, only when
    // every probe that ran against EXISTING candidates failed.
    let claimed = false;
    let probeFailed = false;
    if (patient.bladder < BALANCE.needs.seekThreshold) {
      const outcome = tryClaimRestroom(world, patient);
      claimed = outcome === 'claimed';
      probeFailed ||= outcome === 'failed';
    }
    if (!claimed && patient.thirst < BALANCE.needs.seekThreshold) {
      const outcome = tryClaimVending(world, patient);
      claimed = outcome === 'claimed';
      probeFailed ||= outcome === 'failed';
    }
    if (!claimed && probeFailed) setRetryHold(world, patient);
  }
}

/** Advance an in-flight break: watchdog → arrival flip → using countdown. */
function advanceBreak(
  world: World,
  patient: Patient,
  nb: NeedBreak,
  watchdogTicks: number,
): void {
  if (nb.phase === 'walking') {
    // Watchdog (§3.2): a break that never reached `using` in 30 game-minutes
    // is abandoned — covers lost wanderers, whose retained target means they
    // never read as "arrived".
    if (world.clock.tick - nb.startedAt >= watchdogTicks) {
      world.clearNeedBreak(patient, { hold: true });
      return;
    }
    if (!world.walkerArrived(patient)) return;
    // The FROZEN walking→using flip (pre-impl MAJOR 3): arrived AND at the
    // target — restroom: inside the room; vending: orthogonally adjacent to
    // the machine tile. Arrived ANYWHERE ELSE (setWalkerTarget nulls target
    // on no-path, so a dead path reads as "arrived") → immediate abandon —
    // never wait out the watchdog, never flip `using` in a corridor.
    const room = nb.roomId === undefined ? null : (world.rooms.get(nb.roomId) ?? null);
    // Vending flip additionally requires a legal STANDING zone (code review
    // MAJOR 1): orthogonal adjacency is Manhattan distance and can hold
    // ACROSS a wall — without the zone check a patient inside a neighboring
    // walled room would flip to `using` through it.
    const atTarget =
      nb.kind === 'restroom'
        ? room !== null && world.isInsideRoom(patient.at, room)
        : nb.tile !== undefined &&
          orthAdjacent(patient.at, nb.tile) &&
          standingZoneOk(world, patient.at);
    if (!atTarget) {
      world.clearNeedBreak(patient, { hold: true });
      return;
    }
    nb.phase = 'using';
    nb.ticksRemaining = gameMinutesToTicks(
      nb.kind === 'restroom'
        ? BALANCE.needs.restroomUseGameMinutes
        : BALANCE.needs.vendingUseGameMinutes,
    );
    return;
  }
  // using
  nb.ticksRemaining -= 1;
  if (nb.ticksRemaining > 0) return;
  // Completion (§3.2): meter reset to full; vending charges through billFee
  // (inside revenue/dayNet like every fee — review MAJOR 3) with the
  // breakdown line incremented at the SAME choke point, never re-added.
  if (nb.kind === 'restroom') {
    patient.bladder = BALANCE.stats.vitalsMax;
    // Stage-3 wear hook (§5.1): restrooms have no reservations, so their
    // use completion lives here. No-op while broken (a claimant who was
    // in-flight at the breakdown finishes without re-rolling).
    const usedRoom = nb.roomId === undefined ? null : (world.rooms.get(nb.roomId) ?? null);
    if (usedRoom) world.applyRoomUse(usedRoom);
  } else {
    patient.thirst = BALANCE.stats.vitalsMax;
    world.billFee(BALANCE.needs.vendingPrice, 'Vending', 'vending');
    world.today.vendingRevenue += BALANCE.needs.vendingPrice;
    dropLitter(world, patient);
  }
  // clearNeedBreak re-runs assignWaitingSpot: the seat may be gone → the
  // standing fallback (Flow rule 4, unchanged machinery).
  world.clearNeedBreak(patient, { hold: false });
}

function orthAdjacent(a: GridPoint, b: GridPoint): boolean {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row) === 1;
}

/**
 * Vending-completion litter (Stage 2, §4.1 / impl plan §S2.2): the nearest
 * NON-FULL trashcan within `litterTrashcanRadius` (Chebyshev, like the plant
 * aura) takes the trash — `fill += 1` silently (no event; the inspect card
 * is frame-polled). Tie-break: the FIRST minimal-distance can in
 * `world.amenities` insertion order (placement order — save-stable, since
 * `restoreInto` preserves it; pre-impl MINOR 11). No can in range → litter
 * on the patient's tile.
 *
 * Overflow order (FROZEN — pre-impl MAJOR 2): a can REACHING
 * `trashcanCapacity` mints the `empty` job FIRST, then addMess — addMess's
 * one-job-per-target check then suppresses its own clean-job mint (no
 * double-mint; the overflow decal on a non-walkable tile is fine, decals
 * aren't collision).
 */
function dropLitter(world: World, patient: Patient): void {
  const radius = BALANCE.mess.litterTrashcanRadius;
  let best: { fill: number; tile: GridPoint } | null = null;
  let bestDist = Infinity;
  for (const amenity of world.amenities.values()) {
    if (amenity.kind !== 'trashcan') continue;
    if (amenity.fill >= BALANCE.mess.trashcanCapacity) continue; // full — skip
    const dist = Math.max(
      Math.abs(amenity.tile.col - patient.at.col),
      Math.abs(amenity.tile.row - patient.at.row),
    );
    if (dist > radius || dist >= bestDist) continue; // strict: FIRST minimal wins
    best = amenity;
    bestDist = dist;
  }
  if (best === null) {
    world.addMess('litter', patient.at);
    return;
  }
  best.fill += 1;
  if (best.fill >= BALANCE.mess.trashcanCapacity) {
    world.mintJob('empty', best.tile); // FIRST (frozen order)
    world.addMess('litter', best.tile); // finds the empty job — no clean mint
  }
}

/** A legal vending STANDING zone (code review MAJOR 1 — the
 *  nearestFreeStandingTile `qualifies` rule): corridor or open-plan, never a
 *  walled-room interior. Walled interiors are walkable, and ORTHOGONAL_STEPS
 *  would otherwise happily pick one for a machine hugging a room's wall —
 *  the patient then paths in through the DOOR and drinks through the wall,
 *  loitering inside a treatment room (M3 no-loitering invariant).
 *
 *  Stage 2 refactor note (impl plan §S2.1): the claim-time PICK moved onto
 *  `world.standableTile` (zone + door rule, no opts — corridor-only; the
 *  same-room exception cannot leak). THIS zone-only check stays local for
 *  the walking→using FLIP, whose Stage-1 contract is FROZEN: the flip must
 *  NOT gain the door rule (a patient legally standing on a door landing
 *  mid-corridor still flips). */
function standingZoneOk(world: World, p: GridPoint): boolean {
  const room = world.roomAt(p);
  return room === null || ROOM_DEFS[room.type].kind === 'open';
}

/**
 * Claim the nearest reachable free stall (§3.2/§3.3). The walk goal is
 * computed ONCE at claim time (pre-impl MAJOR 3 — `slotAnchorTile` is
 * claim-order-dependent and its fallthrough consumes rng; never re-derive it
 * per tick). Returns 'none' when no restroom exists (zero-cost probe — no
 * hold, so the first restroom built helps immediately), 'failed' when every
 * candidate was full/unreachable (hold set), 'claimed' on success.
 */
function tryClaimRestroom(world: World, patient: Patient): 'claimed' | 'failed' | 'none' {
  const restrooms = world.roomsOfType('restroom').filter((r) => r.door !== null);
  if (restrooms.length === 0) return 'none';
  const start = patient.next ?? patient.at;
  let best: { room: Room; slot: number; pathLength: number } | null = null;
  for (const room of restrooms) {
    const slot = world.freeStallIndex(room);
    if (slot === null) continue; // full — walking claimants hold stalls too
    // Reachability gate (design MAJOR 1): never claim a stall you can't
    // walk to — an unreachable claim + the dispatcher skip would hide the
    // patient in a permanent abandon/re-claim loop.
    const path = findPath(world, start, room.door!.inside, patient.id);
    if (path === null) continue;
    if (best === null || path.length < best.pathLength) {
      best = { room, slot, pathLength: path.length };
    }
  }
  if (best === null) return 'failed'; // caller sets the hold (pre-impl MAJOR 4)
  // Goal picked ONCE, now: the claim exists before slotAnchorTile runs, so
  // the anchor prefers this patient's own stall neighborhood deterministically.
  patient.needBreak = {
    kind: 'restroom',
    roomId: best.room.id,
    slot: best.slot,
    phase: 'walking',
    ticksRemaining: 0,
    startedAt: world.clock.tick,
  };
  // The seat is released for real arrivals (review MINOR 13); the patient
  // re-competes for one on return.
  patient.waitingRoomId = null;
  world.emitThought(patient, 'needsRestroom');
  world.setWalkerTarget(patient, world.slotAnchorTile(best.room, best.slot));
  return 'claimed';
}

/**
 * Claim the nearest reachable free vending machine (§3.2/§3.4). Standing
 * tile picked at claim time, claim-aware, deterministic: fixed
 * ORTHOGONAL_STEPS order, first LEGAL neighbor — walkable, unclaimed, a
 * legal standing zone (corridor/open-plan, code review MAJOR 1), and not a
 * door landing. Zero available standing tiles / all machines claimed or
 * unreachable → 'failed' (caller sets the hold).
 */
function tryClaimVending(world: World, patient: Patient): 'claimed' | 'failed' | 'none' {
  const machines = [...world.amenities.values()].filter((a) => a.kind === 'vending');
  if (machines.length === 0) return 'none'; // zero-cost probe — no hold
  const start = patient.next ?? patient.at;
  let best: { tile: GridPoint; stand: GridPoint; pathLength: number } | null = null;
  for (const machine of machines) {
    const tileKey = `${machine.tile.col},${machine.tile.row}`;
    if (world.vendingClaimedBy(tileKey) !== null) continue; // one user at a time
    let stand: GridPoint | null = null;
    for (const step of ORTHOGONAL_STEPS) {
      const p = { col: machine.tile.col + step.col, row: machine.tile.row + step.row };
      if (!world.isWalkable(p)) continue;
      // The ONE standing-zone rule (Stage 2 refactor, behavior-identical):
      // corridor/open-plan + never a door landing. NO opts — vending stands
      // stay corridor-only (the same-room exception cannot leak, §S2.1).
      if (!world.standableTile(p)) continue;
      if (world.isTileClaimed(p, patient)) continue;
      stand = p;
      break;
    }
    if (stand === null) continue;
    const path = findPath(world, start, stand, patient.id);
    if (path === null) continue;
    if (best === null || path.length < best.pathLength) {
      best = { tile: machine.tile, stand, pathLength: path.length };
    }
  }
  if (best === null) return 'failed';
  patient.needBreak = {
    kind: 'vending',
    tile: { col: best.tile.col, row: best.tile.row },
    phase: 'walking',
    ticksRemaining: 0,
    startedAt: world.clock.tick,
  };
  patient.waitingRoomId = null;
  world.emitThought(patient, 'needsVending');
  world.setWalkerTarget(patient, best.stand);
  return 'claimed';
}

/** Shared with decay (accident × in-flight break, pre-impl MINOR 8): a
 *  bladder accident clears a matching restroom claim — the meter is full
 *  again, so the claim must not pin "Occupied" gates for a need that no
 *  longer exists. Exported for the decay system; no hold (nothing failed). */
export function clearMatchingRestroomBreak(world: World, patient: Patient): void {
  if (patient.needBreak?.kind === 'restroom') {
    world.clearNeedBreak(patient, { hold: false });
  }
}
