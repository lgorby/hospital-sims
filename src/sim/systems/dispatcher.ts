import { GAME_MINUTES_PER_HOUR, gameMinutesToTicks, ticksToGameMinutes } from '../clock';
import { BALANCE } from '../data/balance';
import { CONDITION_DEFS } from '../data/conditions';
import { ROLE_DEFS } from '../data/roles';
import { ROOM_DEFS } from '../data/rooms';
import type { Room } from '../entities/room';
import type { Patient } from '../entities/patient';
import type { Job, Reservation, Staff } from '../entities/staff';
import { checkInCapacity, effectivePriority, treatmentDurationTicks } from '../formulas';
import { computeBlockedNeeds } from '../needs';
import { findPath } from '../path/astar';
import { ORTHOGONAL_STEPS, samePoint, type GridPoint } from '../types';
import type { Walker, World } from '../world';

/**
 * The dispatcher (GDD §4): matches waiting patients to free rooms + free
 * staff with all-or-nothing reservations, runs the check-in pipeline, and
 * promotes gathered reservations to active treatments.
 */
export function updateDispatcher(world: World): void {
  postStandingStaff(world);
  reRouteEntranceWaiters(world);
  processCheckIn(world);
  assignTriage(world);
  assignTreatment(world);
  assignJobs(world); // Stage 2 (§S2.3): after assignTreatment (frozen slot)
  promoteGatheredReservations(world);
  progressJobs(world);
  emitUrgentNeedHints(world);
}

/**
 * Flow rule 5, one source (HINTS_PLAN §2.2): toast every URGENT unmet need —
 * something blocking a patient's progress RIGHT NOW. Upcoming (look-ahead)
 * needs are panel-only, so day one isn't a toast burst duplicating the
 * checklist. Replaces the former inline room:triage / role:nurse / cond:*
 * hints (those keys are inert in legacy saves; the need:* keys fire once).
 * MUST stay mutation-free apart from hintOnce (save-gate invariant, §2.1).
 */
function emitUrgentNeedHints(world: World): void {
  for (const need of computeBlockedNeeds(world)) {
    if (need.urgent) world.hintOnce(`need:${need.key}`, need.label);
  }
}

function idleStaff(world: World, filter: (s: Staff) => boolean): Staff[] {
  return [...world.staff.values()].filter((s) => s.duty.kind === 'idle' && !s.firing && filter(s));
}

/** Stage A: a room accepts dispatch while it has an open capacity slot —
 *  `single` rooms behave exactly as the old any-reservation-blocks check. */
function hasOpenSlot(world: World, room: Room): boolean {
  return world.openSlots(room) > 0;
}

/**
 * Deterministic standing-post spot: beside the room's desk prop when it has
 * one, else the first walkable interior tile that isn't the doorway. Prefers
 * unclaimed tiles (Flow rule 14) — atrium tiles are public, so a patient may
 * be standing on the obvious spot.
 */
function postTile(world: World, room: Room): { col: number; row: number } {
  const candidates: { col: number; row: number }[] = [];
  for (let row = room.rect.row; row < room.rect.row + room.rect.rows; row++) {
    for (let col = room.rect.col; col < room.rect.col + room.rect.cols; col++) {
      const tile = world.tileAt(col, row);
      if (!tile?.object || tile.walkable) continue; // desk/help-desk style props
      for (const step of ORTHOGONAL_STEPS) {
        const p = { col: col + step.col, row: row + step.row };
        if (!world.isInsideRoom(p, room) || !world.isWalkable(p)) continue;
        if (room.door && samePoint(room.door.inside, p)) continue;
        candidates.push(p);
      }
    }
  }
  for (let row = room.rect.row; row < room.rect.row + room.rect.rows; row++) {
    for (let col = room.rect.col; col < room.rect.col + room.rect.cols; col++) {
      const p = { col, row };
      if (!world.isWalkable(p)) continue;
      if (room.door && samePoint(room.door.inside, p)) continue;
      candidates.push(p);
    }
  }
  const free = candidates.find((p) => !world.isTileClaimed(p));
  return free ?? candidates[0] ?? room.door?.inside ?? { col: room.rect.col, row: room.rect.row };
}

/** Post idle standing-post staff (receptionists, greeters) to their rooms. */
function postStandingStaff(world: World): void {
  const staffedRooms = new Set<number>();
  for (const s of world.staff.values()) {
    if (s.duty.kind === 'post') staffedRooms.add(s.duty.roomId);
  }
  for (const room of world.rooms.values()) {
    const def = ROOM_DEFS[room.type];
    const postRole = def.staffedBy.find((role) => ROLE_DEFS[role].standingPost);
    if (!postRole || staffedRooms.has(room.id)) continue;
    if (def.kind !== 'open' && !room.door) continue;
    const candidate = idleStaff(world, (s) => s.role === postRole)[0];
    if (!candidate) continue;
    candidate.duty = { kind: 'post', roomId: room.id };
    world.setWalkerTarget(candidate, postTile(world, room));
    staffedRooms.add(room.id);
  }
}

/** Patients stuck at the entrance get routed once a reception has queue capacity. */
function reRouteEntranceWaiters(world: World): void {
  const receptions = world.roomsOfType('reception').filter((r) => r.door);
  const hasCapacity = (roomId: number): boolean =>
    world.queueFor(roomId).length < checkInCapacity();
  if (receptions.some((r) => hasCapacity(r.id))) {
    for (const patient of world.patients.values()) {
      if (patient.stage.kind === 'atEntrance') world.routeToCheckIn(patient);
    }
  }
  // Queued at an unstaffed desk while a staffed one has room? Migrate — a dead
  // queue never advances and silently AMAs everyone in it (M3-gate review).
  const staffed = world.staffedReceptionIds();
  if (staffed.size === 0) return;
  for (const patient of [...world.patients.values()]) {
    if (patient.stage.kind !== 'queuedCheckIn' || staffed.has(patient.stage.roomId)) continue;
    if (!receptions.some((r) => staffed.has(r.id) && hasCapacity(r.id))) break;
    const since = patient.waitingSince;
    world.leaveQueue(patient);
    world.routeToCheckIn(patient);
    patient.waitingSince = since ?? patient.waitingSince; // migration isn't a fresh wait
  }
}

function processCheckIn(world: World): void {
  for (const room of world.roomsOfType('reception')) {
    if (!room.door) continue;
    const queue = world.queueFor(room.id);
    const frontId = queue[0];
    if (frontId === undefined) continue;
    const front = world.patients.get(frontId);
    if (!front) {
      queue.shift();
      continue;
    }

    const receptionistReady = [...world.staff.values()].some(
      (s) =>
        s.duty.kind === 'post' &&
        s.duty.roomId === room.id &&
        world.walkerArrived(s) &&
        world.isInsideRoom(s.at, room),
    );

    if (front.stage.kind === 'checkingIn') {
      // The desk only works while staffed (M2 review #4): if the receptionist
      // was fired or hasn't arrived, the check-in reverts to the desk slot and
      // restarts when someone is posted again — never a headless check-in.
      if (!receptionistReady) {
        world.setPatientStage(front, { kind: 'queuedCheckIn', roomId: room.id, slot: 0 });
        continue;
      }
      front.stage.ticksRemaining -= 1;
      if (front.stage.ticksRemaining <= 0) {
        world.leaveQueue(front);
        world.setPatientStage(front, { kind: 'waitingTriage' });
        front.waitingSince = world.clock.tick;
        world.assignWaitingSpot(front);
      }
      continue;
    }

    // Desk processes only when the front patient is AT the desk and a
    // receptionist is posted and has arrived (Flow rule 1).
    if (front.stage.kind !== 'queuedCheckIn' || front.stage.slot !== 0) continue;
    if (!world.walkerArrived(front) || !samePoint(front.at, world.queueSlotTile(room, 0))) continue;
    if (!receptionistReady) continue;
    world.setPatientStage(front, {
      kind: 'checkingIn',
      roomId: room.id,
      ticksRemaining: gameMinutesToTicks(BALANCE.reception.checkInGameMinutes),
    });
  }
}

function makeReservation(
  world: World,
  kind: 'triage' | 'treatment',
  patient: Patient,
  room: Room,
  staffMembers: Staff[],
  stepIndex: number,
): void {
  // Stage A: claim the lowest free capacity slot (0 for `single` rooms). The
  // index is STABLE for the reservation's lifetime — anchoring and the save
  // both carry it (CAPACITY_PLAN §3.3).
  const slotIndex = world.freeSlotIndex(room);
  const reservation: Reservation = {
    id: world.takeId(),
    kind,
    patientId: patient.id,
    roomId: room.id,
    staffIds: staffMembers.map((s) => s.id),
    stepIndex,
    slotIndex,
    phase: 'gathering',
    ticksRemaining: 0,
    patientWaitingSince: patient.waitingSince,
  };
  world.reservations.set(reservation.id, reservation);
  world.setPatientStage(patient, { kind: 'reserved', reservationId: reservation.id });
  patient.waitingSince = null;
  patient.waitingRoomId = null;
  // Per-slot anchoring (Stage A): the patient stands beside THEIR bed/machine
  // so concurrent occupants don't pile on random interior tiles; single rooms
  // keep the classic free-interior pick inside slotAnchorTile's fallback.
  const patientSpot =
    ROOM_DEFS[room.type].capacity.kind === 'perProp'
      ? world.slotAnchorTile(room, slotIndex)
      : world.freeInteriorTile(room, room.door?.inside);
  world.setWalkerTarget(patient, patientSpot);
  for (const member of staffMembers) {
    member.duty = { kind: 'reserved', reservationId: reservation.id };
    world.setWalkerTarget(member, world.freeInteriorTile(room, patientSpot));
  }
}

/**
 * Never reserve a room the patient can't path to (M3-gate review): a doomed
 * reservation just round-trips through the rule-8 cancel. Staff reachability
 * is left to the cancel + retry-hold safety net — patients and staff share
 * the same connected floor in practice.
 */
function canReachRoom(world: World, walker: Walker, room: Room): boolean {
  return (
    room.door !== null && findPath(world, walker.next ?? walker.at, room.door.inside) !== null
  );
}

/**
 * Waiting patients eligible for dispatch: rule-8 retry hold honored, lost
 * patients skipped (M3-gate ruling — never idle staff against a wanderer),
 * and on-break patients skipped exactly like lost ones (amenities §3.2 —
 * they re-enter the pool the tick the break ends).
 */
function dispatchable(world: World, stageKind: 'waitingTriage' | 'waiting'): Patient[] {
  return [...world.patients.values()].filter(
    (p) =>
      p.stage.kind === stageKind &&
      p.lost === null &&
      p.needBreak === null &&
      world.clock.tick >= p.dispatchHoldUntil,
  );
}

function assignTriage(world: World): void {
  const waiting = dispatchable(world, 'waitingTriage').sort(
    (a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0),
  );
  if (waiting.length === 0) return;
  // Flow rule 5 hints moved to emitUrgentNeedHints (HINTS_PLAN §2.2).
  for (const patient of waiting) {
    const nurse = idleStaff(world, (s) => s.role === 'nurse')[0];
    if (!nurse) return;
    const bay = world
      .roomsOfType('triage')
      .find((r) => hasOpenSlot(world, r) && canReachRoom(world, patient, r));
    if (!bay) continue;
    makeReservation(world, 'triage', patient, bay, [nurse], 0);
  }
}

function assignTreatment(world: World): void {
  const waiting = dispatchable(world, 'waiting')
    .filter((p) => p.acuity !== null)
    .sort((a, b) => priorityOf(world, a) - priorityOf(world, b));

  for (const patient of waiting) {
    const def = CONDITION_DEFS[patient.condition];
    const step = def.steps[patient.stepIndex];
    if (!step) continue;
    // Flow rule 5 hints moved to emitUrgentNeedHints (HINTS_PLAN §2.2).
    const room = world
      .roomsOfType(step.room)
      .find((r) => hasOpenSlot(world, r) && canReachRoom(world, patient, r));
    if (!room) continue;
    // All-or-nothing (tech plan §5): every required role or nothing at all.
    const chosen: Staff[] = [];
    for (const role of step.roles) {
      const member = idleStaff(world, (s) => s.role === role && !chosen.includes(s))[0];
      if (!member) break;
      chosen.push(member);
    }
    if (chosen.length !== step.roles.length) continue;
    makeReservation(world, 'treatment', patient, room, chosen, patient.stepIndex);
  }
}

function priorityOf(world: World, patient: Patient): number {
  const waitedHours =
    patient.waitingSince === null
      ? 0
      : ticksToGameMinutes(world.clock.tick - patient.waitingSince) / GAME_MINUTES_PER_HOUR;
  return effectivePriority(patient.acuity ?? BALANCE.decay.untriagedAcuity, waitedHours);
}

// ------------------------------------------------- facility jobs (Stage 2)

/**
 * Where a job is worked from (the FROZEN §S2.3 derivation): the mess tile
 * itself when it's walkable, standable (with the same-room exception — an
 * accident inside a treatment room is worked from that room's interior) and
 * unclaimed; else the FIRST claim-aware standable orthogonal neighbor
 * (`sameRoomAs: job.tile`). The adjacent-neighbor rule is what keeps a mess
 * under a seated patient workable, so long claims starve nothing.
 * Non-walkable targets (trashcans) always use a neighbor. Claim-awareness
 * ignores the probing worker's own spot (Flow rule 14 — own claim doesn't
 * count).
 */
function jobWorkTile(world: World, job: Job, worker: Staff): GridPoint | null {
  if (
    world.isWalkable(job.tile) &&
    world.standableTile(job.tile, { sameRoomAs: job.tile }) &&
    !world.isTileClaimed(job.tile, worker)
  ) {
    return job.tile;
  }
  for (const step of ORTHOGONAL_STEPS) {
    const p = { col: job.tile.col + step.col, row: job.tile.row + step.row };
    if (!world.isWalkable(p)) continue;
    if (!world.standableTile(p, { sameRoomAs: job.tile })) continue;
    // The neighbor must legally FACE the target across this edge (Stage-2
    // code review MAJOR: Manhattan adjacency holds THROUGH edge-walls — an
    // in-room mess whose own tile is claimed would otherwise be "worked"
    // from the corridor on the far side of the wall).
    if (!world.canApproach(p, job.tile)) continue;
    if (world.isTileClaimed(p, worker)) continue;
    return p;
  }
  return null;
}

/**
 * Arrived AT the work tile — named by RE-DERIVING it (the derivation is
 * deterministic and ignores the worker's own claim, so a completed walk
 * matches its own goal). Anything else — including a dead path that stopped
 * orthogonally adjacent ACROSS A WALL (Manhattan adjacency holds through
 * walls, the Stage-1 vending-flip bug class) — reads as "arrived elsewhere"
 * and requeues. If claims shifted mid-walk the derivation may now name a
 * different tile: that also requeues (+hold) and the next assignment walks
 * to the new tile — convergent, never a through-wall clean.
 */
function atJobSite(world: World, worker: Staff, job: Job): boolean {
  const derived = jobWorkTile(world, job, worker);
  return derived !== null && samePoint(worker.at, derived);
}

/** Requeue a job (fire/stall analogues, §4.3): staffId null, phase queued,
 *  timer cleared; `hold` arms the retry window (a stall is a failure — the
 *  fire path passes false: the job didn't fail). */
function requeueJob(world: World, job: Job, opts: { hold: boolean }): void {
  job.staffId = null;
  job.phase = 'queued';
  job.ticksRemaining = 0;
  if (opts.hold) {
    job.holdUntil = world.clock.tick + gameMinutesToTicks(BALANCE.mess.jobRetryGameMinutes);
  }
  world.events.emit('jobChanged', { jobId: job.id });
}

/**
 * Job assignment (the FROZEN §S2.3 loop — pre-impl MAJOR 6, the hot-loop/
 * starvation class). Per idle EVS (not firing): scan queued clean/empty
 * jobs oldest-first (= lowest id; ids from takeId() are monotonic),
 * SKIPPING jobs under a retry hold; per candidate, probe = work-tile
 * derivation + findPath. Probe FAILURE → the job takes a retry hold and the
 * scan CONTINUES to the next job (a held/unworkable oldest job never blocks
 * younger workable ones; a failed probe is not re-run until its window
 * expires). Probe SUCCESS → assign + walk.
 */
function assignJobs(world: World): void {
  // The trade split (§4.3 + §5.3): EVS clean/empty, Maintenance repairs.
  // Each pool runs the SAME frozen loop — Stage 3 added the second call,
  // not new semantics.
  assignJobsForRole(world, 'evs', ['clean', 'empty']);
  assignJobsForRole(world, 'maintenance', ['repair']);
}

function assignJobsForRole(
  world: World,
  role: 'evs' | 'maintenance',
  kinds: readonly Job['kind'][],
): void {
  const workers = idleStaff(world, (s) => s.role === role);
  if (workers.length === 0 || world.jobs.size === 0) return;
  const queued = [...world.jobs.values()]
    .filter((j) => j.phase === 'queued' && kinds.includes(j.kind))
    .sort((a, b) => a.id - b.id); // oldest = lowest job id
  for (const worker of workers) {
    for (const job of queued) {
      if (job.phase !== 'queued') continue; // taken by an earlier worker this tick
      if (job.holdUntil > world.clock.tick) continue; // held — skip, never block
      const workTile = jobWorkTile(world, job, worker);
      if (
        workTile === null ||
        findPath(world, worker.next ?? worker.at, workTile, worker.id) === null
      ) {
        job.holdUntil = world.clock.tick + gameMinutesToTicks(BALANCE.mess.jobRetryGameMinutes);
        continue; // failure → hold this job, CONTINUE to the next
      }
      job.staffId = worker.id;
      job.phase = 'assigned';
      worker.duty = { kind: 'job', jobId: job.id };
      world.setWalkerTarget(worker, workTile);
      world.events.emit('staffUpdated', { staffId: worker.id });
      world.events.emit('jobChanged', { jobId: job.id });
      break; // this worker is busy now — next worker
    }
  }
}

/**
 * Job lifecycle (§S2.3): arrival flips `working` (timer via the ONE duration
 * formula, quality 0); a stalled arrival requeues + holds; completion order
 * is FROZEN — clean: detach the worker, then removeMess (whose orphan
 * clause deletes the job); empty: fill = 0 → delete the job + release the
 * worker → removeMess (which then finds no job — never a re-entrant delete
 * of the completing job). Step-out + idle + events either way (the
 * releaseReservation clause lives in world.releaseJobWorker).
 * Iterates a SNAPSHOT — completion mutates the map (pre-impl MAJOR 2).
 */
function progressJobs(world: World): void {
  for (const job of [...world.jobs.values()]) {
    if (!world.jobs.has(job.id)) continue; // deleted earlier this pass
    if (job.phase === 'queued' || job.staffId === null) continue;
    const worker = world.staff.get(job.staffId);
    if (!worker) {
      // Defensive: fireStaff requeues before removal, so this shouldn't
      // happen — but a dangling worker must never wedge the job forever.
      requeueJob(world, job, { hold: false });
      continue;
    }
    if (job.phase === 'assigned') {
      if (!world.walkerArrived(worker)) continue;
      if (!atJobSite(world, worker, job)) {
        // The rule-8 stalled analogue, immediate: release + requeue + hold.
        world.releaseJobWorker(job);
        requeueJob(world, job, { hold: true });
        continue;
      }
      job.phase = 'working';
      job.ticksRemaining = treatmentDurationTicks(
        job.kind === 'empty'
          ? BALANCE.mess.emptyGameMinutes
          : job.kind === 'repair'
            ? BALANCE.maintenance.repairGameMinutes
            : BALANCE.mess.cleanGameMinutes,
        worker.skill,
        0, // quality 0 — corridors have none (§S2.1: no new formula)
      );
      world.events.emit('jobChanged', { jobId: job.id });
      continue;
    }
    // working
    job.ticksRemaining -= 1;
    if (job.ticksRemaining > 0) continue;
    if (job.kind === 'empty') {
      const can = world.amenityAt(job.tile.col, job.tile.row);
      if (can) can.fill = 0;
      world.jobs.delete(job.id);
      world.releaseJobWorker(job);
      world.events.emit('jobChanged', { jobId: job.id });
      world.removeMess(job.tile); // the overflow decal — finds no job now
    } else if (job.kind === 'repair') {
      // Stage 3 (§S3.4 frozen order): delete the job, release the tech
      // (the unconditional walled-room step-out — never idling inside the
      // room they fixed), THEN restore service. Wear stayed 0 since the
      // breakdown. A missing room is unreachable (sellRoom deletes the
      // job) — defensively just drop the job.
      const room = job.roomId === null ? null : (world.rooms.get(job.roomId) ?? null);
      world.jobs.delete(job.id);
      world.releaseJobWorker(job);
      world.events.emit('jobChanged', { jobId: job.id });
      if (room) {
        room.brokenSince = null;
        world.events.emit('roomChanged', { roomId: room.id });
      }
    } else {
      // clean (any mess kind): worker already detached, so removeMess's
      // orphan clause deletes the job without a double-release.
      world.releaseJobWorker(job);
      world.removeMess(job.tile);
    }
  }
}

/** Everyone has arrived inside the room → start the timer. */
function promoteGatheredReservations(world: World): void {
  for (const reservation of [...world.reservations.values()]) {
    if (reservation.phase !== 'gathering') continue;
    const room = world.rooms.get(reservation.roomId);
    const patient = world.patients.get(reservation.patientId);
    if (!room || !patient) continue;
    const members = reservation.staffIds.map((id) => world.staff.get(id)!);

    // Flow rule 8 / M2 review #1: a participant who has STOPPED (no committed
    // step, no goal) but is not inside the room has no path — cancel the
    // reservation instead of stalling forever with the room and staff leaked.
    // LOST patients are exempt (M3-gate ruling): they retain the target and
    // wander; only the 60-min timeout or a terminal event releases them.
    const stalled = (w: Walker): boolean =>
      world.walkerArrived(w) && !world.isInsideRoom(w.at, room);
    if ((patient.lost === null && stalled(patient)) || members.some(stalled)) {
      world.cancelReservation(reservation);
      continue;
    }

    if (!world.walkerArrived(patient) || !world.isInsideRoom(patient.at, room)) continue;
    if (!members.every((m) => world.walkerArrived(m) && world.isInsideRoom(m.at, room))) continue;

    reservation.phase = 'active';
    // Belt-and-suspenders: treatment is not a walk, so an active patient can
    // never be lost (rule 3 — lost patience decay must not run mid-treatment).
    patient.lost = null;
    if (reservation.kind === 'triage') {
      reservation.ticksRemaining = gameMinutesToTicks(BALANCE.triage.durationGameMinutes);
    } else {
      // Door-to-first-treatment wait (M4 daily report): recorded when the
      // FIRST treatment goes active — triage doesn't count as treatment.
      if (patient.firstTreatedAtTick === null) {
        patient.firstTreatedAtTick = world.clock.tick;
        world.today.waitSumTicks += world.clock.tick - patient.arrivedAtTick;
        world.today.waitCount += 1;
      }
      const step = CONDITION_DEFS[patient.condition].steps[reservation.stepIndex]!;
      const averageSkill = members.reduce((sum, m) => sum + m.skill, 0) / members.length;
      reservation.ticksRemaining = treatmentDurationTicks(
        step.durationGameMinutes,
        averageSkill,
        room.quality,
      );
    }
  }
}
