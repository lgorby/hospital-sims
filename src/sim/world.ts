import type { CommandQueue, Command } from '../commands';
import type { EventBus } from '../events';
import { doorFromOutsideTile, validateRoomBuild, validateRoomSell } from './build';
import { GameClock, gameMinutesToTicks } from './clock';
import { BALANCE } from './data/balance';
import { CONDITION_DEFS, type ConditionId } from './data/conditions';
import { generateAge, generateName } from './data/names';
import { ROLE_DEFS, ROLE_IDS, type RoleId } from './data/roles';
import { ROOM_DEFS, WAITING_ROOM_BASE_CHAIRS, type RoomType } from './data/rooms';
import type { Door, Room } from './entities/room';
import type { Patient } from './entities/patient';
import type { Candidate, Reservation, Staff } from './entities/staff';
import { candidateSalary, dischargeReputationGain } from './formulas';
import { findPath, type PathGrid } from './path/astar';
import { SeededRng } from './rng';
import { updateDecay } from './systems/decay';
import { updateDispatcher } from './systems/dispatcher';
import { updateEconomy } from './systems/economy';
import { updateMovement } from './systems/movement';
import { updateSpawn } from './systems/spawn';
import { resolveTreatmentOutcome, updateTreatment } from './systems/treatment';
import {
  ORTHOGONAL_STEPS,
  rectContains,
  rectTiles,
  samePoint,
  type GridPoint,
  type Rect,
} from './types';

export interface Tile {
  walkable: boolean;
  roomId: number | null;
  /** Placed object occupying this tile (M1: the exam bed prop). */
  object: 'bed' | null;
  /** M0 debug: visual marker toggled via the command queue. */
  marker: boolean;
}

/** Shared walker shape — patients and staff both satisfy it. */
export interface Walker {
  at: GridPoint;
  next: GridPoint | null;
  path: GridPoint[];
  target: GridPoint | null;
  progress: number;
}

/**
 * The runtime single source of truth (tech plan §3.1 rule 3).
 * Pure TS — nothing here may import Pixi or touch the DOM.
 */
export class World implements PathGrid {
  readonly cols = BALANCE.map.cols;
  readonly rows = BALANCE.map.rows;
  readonly grid: Tile[][];
  readonly clock = new GameClock();
  readonly rng: SeededRng;
  readonly rooms = new Map<number, Room>();
  readonly patients = new Map<number, Patient>();
  readonly staff = new Map<number, Staff>();
  readonly reservations = new Map<number, Reservation>();
  readonly candidates: Candidate[] = [];
  /** receptionRoomId → ordered patientIds (slot index = queue position). */
  readonly checkInQueues = new Map<number, number[]>();
  cash: number = BALANCE.economy.startingCash;
  reputation: number = BALANCE.reputation.starting;
  /** One-shot advisory hints already shown (Flow rule 5 "once per condition type"). */
  private hintedOnce = new Set<string>();
  private nextEntityId = 1;

  constructor(
    readonly events: EventBus,
    seed: number,
  ) {
    this.rng = new SeededRng(seed);
    this.grid = Array.from({ length: this.cols }, () =>
      Array.from(
        { length: this.rows },
        (): Tile => ({ walkable: true, roomId: null, object: null, marker: false }),
      ),
    );
    for (const role of ROLE_IDS) {
      for (let i = 0; i < BALANCE.hiring.candidatesPerRole; i++) {
        this.candidates.push(this.makeCandidate(role));
      }
    }
  }

  takeId(): number {
    return this.nextEntityId++;
  }

  private makeCandidate(role: RoleId): Candidate {
    const skill = this.rng.intInRange(1, 5);
    return {
      id: this.takeId(),
      role,
      name: generateName(this.rng),
      age: generateAge(this.rng),
      skill,
      salaryPerDay: candidateSalary(ROLE_DEFS[role].salaryPerDay, skill),
    };
  }

  // ------------------------------------------------------------ grid queries

  tileAt(col: number, row: number): Tile | undefined {
    return this.grid[col]?.[row];
  }

  isWalkable(p: GridPoint): boolean {
    return this.tileAt(p.col, p.row)?.walkable ?? false;
  }

  private isOpenRoom(roomId: number): boolean {
    const room = this.rooms.get(roomId);
    return room !== undefined && ROOM_DEFS[room.type].kind === 'open';
  }

  private isDoorEdge(roomId: number, inside: GridPoint, outside: GridPoint): boolean {
    const door = this.rooms.get(roomId)?.door;
    return (
      door !== null &&
      door !== undefined &&
      samePoint(door.inside, inside) &&
      samePoint(door.outside, outside)
    );
  }

  /** May a single orthogonal step be taken? Edge walls (room boundaries) live here. */
  canStep(from: GridPoint, to: GridPoint): boolean {
    const tileFrom = this.tileAt(from.col, from.row);
    const tileTo = this.tileAt(to.col, to.row);
    if (!tileFrom || !tileTo || !tileTo.walkable) return false;
    if (tileFrom.roomId === tileTo.roomId) return true;
    if (
      tileFrom.roomId !== null &&
      !this.isOpenRoom(tileFrom.roomId) &&
      !this.isDoorEdge(tileFrom.roomId, from, to)
    ) {
      return false;
    }
    if (
      tileTo.roomId !== null &&
      !this.isOpenRoom(tileTo.roomId) &&
      !this.isDoorEdge(tileTo.roomId, to, from)
    ) {
      return false;
    }
    return true;
  }

  roomAt(p: GridPoint): Room | null {
    const id = this.tileAt(p.col, p.row)?.roomId ?? null;
    return id === null ? null : (this.rooms.get(id) ?? null);
  }

  roomsOfType(type: RoomType): Room[] {
    return [...this.rooms.values()].filter((r) => r.type === type);
  }

  /**
   * Is this tile someone's standing spot or destination? (V1 collision model,
   * Flow rule 14: walkers pass through each other in motion, but standing
   * spots are exclusive — destinations avoid claimed tiles.)
   */
  isTileClaimed(p: GridPoint, ignore?: Walker): boolean {
    for (const person of [...this.patients.values(), ...this.staff.values()]) {
      if (person === ignore) continue;
      if (person.target && samePoint(person.target, p)) return true;
      if (this.walkerArrived(person) && samePoint(person.at, p)) return true;
    }
    return false;
  }

  /**
   * Nearest free standing spot (Flow rules 4/14): BFS outward from `from` to
   * the first walkable corridor or open-room tile (optionally a waiting-room
   * interior) that is unclaimed and not a doorway tile — so loiterers never
   * squat on desk slots, door landings, or inside treatment rooms.
   */
  nearestFreeStandingTile(
    from: GridPoint,
    ignore?: Walker,
    opts: { includeWaitingRooms?: boolean } = {},
  ): GridPoint | null {
    const keyOf = (p: GridPoint): number => p.col * this.rows + p.row;
    const doorTiles = new Set<number>();
    for (const room of this.rooms.values()) {
      if (room.door) {
        doorTiles.add(keyOf(room.door.inside));
        doorTiles.add(keyOf(room.door.outside));
      }
    }
    const qualifies = (p: GridPoint): boolean => {
      const tile = this.tileAt(p.col, p.row);
      if (!tile?.walkable) return false;
      const zoneOk =
        tile.roomId === null ||
        this.isOpenRoom(tile.roomId) ||
        (opts.includeWaitingRooms === true && this.rooms.get(tile.roomId)?.type === 'waiting');
      return zoneOk && !doorTiles.has(keyOf(p)) && !this.isTileClaimed(p, ignore);
    };
    const visited = new Set<number>([keyOf(from)]);
    const queue: GridPoint[] = [from];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (qualifies(current)) return current;
      for (const step of ORTHOGONAL_STEPS) {
        const next = { col: current.col + step.col, row: current.row + step.row };
        const k = keyOf(next);
        if (visited.has(k) || !this.canStep(current, next)) continue;
        visited.add(k);
        queue.push(next);
      }
    }
    return null;
  }

  /** A random walkable interior tile, preferring unclaimed ones (Flow rule 14). */
  freeInteriorTile(room: Room, avoid?: GridPoint): GridPoint {
    const walkable = rectTiles(room.rect).filter(
      (t) => this.tileAt(t.col, t.row)!.walkable && !(avoid && samePoint(t, avoid)),
    );
    const unclaimed = walkable.filter((t) => !this.isTileClaimed(t));
    const options = unclaimed.length > 0 ? unclaimed : walkable;
    return options[this.rng.intBelow(options.length)] ?? room.door?.inside ?? room.rect;
  }

  isInsideRoom(p: GridPoint, room: Room): boolean {
    return rectContains(room.rect, p);
  }

  // ---------------------------------------------------------------- commands

  /**
   * Drains and applies all pending commands. Called by the loop every frame,
   * including at speed 0 — building while paused is an RCT tradition.
   */
  applyCommands(queue: CommandQueue): void {
    for (const command of queue.drain()) {
      this.applyCommand(command);
    }
  }

  private applyCommand(command: Command): void {
    switch (command.type) {
      case 'buildRoom':
        this.buildRoom(command.roomType, command.rect, command.doorOutside);
        return;
      case 'sellRoom':
        this.sellRoom(command.roomId);
        return;
      case 'hireStaff':
        this.hireStaff(command.candidateId);
        return;
      case 'fireStaff':
        this.fireStaff(command.staffId);
        return;
      case 'debugSpawnPatient':
        this.spawnPatient(command.condition ?? 'flu');
        return;
      case 'debugForce':
        this.debugForce(command.patientId, command.outcome);
        return;
      case 'debugFastForward':
        for (let i = 0; i < command.ticks; i++) this.tick();
        return;
      case 'debugWalkTo':
        // Debug-only: manually steer every patient (movement tests, sandboxing).
        for (const p of this.patients.values()) {
          this.setWalkerTarget(p, { col: command.col, row: command.row });
        }
        return;
      case 'debugToggleMarker': {
        const tile = this.tileAt(command.col, command.row);
        if (!tile) return;
        tile.marker = !tile.marker;
        this.events.emit('debugMarkerToggled', {
          col: command.col,
          row: command.row,
          present: tile.marker,
        });
        return;
      }
    }
  }

  // ---------------------------------------------------------------- building

  buildRoom(type: RoomType, rect: Rect, doorOutside: GridPoint | null, free = false): void {
    const isOpen = ROOM_DEFS[type].kind === 'open';
    const door: Door | null = isOpen || !doorOutside ? null : doorFromOutsideTile(rect, doorOutside);
    const check = validateRoomBuild(this, type, rect, isOpen ? null : door, free);
    if (!check.ok) {
      this.events.emit('buildRejected', { reason: check.reason });
      return;
    }

    const def = ROOM_DEFS[type];
    const id = this.takeId();
    const room: Room = {
      id,
      type,
      rect,
      door,
      quality:
        (rect.cols * rect.rows - def.minCols * def.minRows) * BALANCE.rooms.qualityPerExtraTile,
    };
    this.rooms.set(id, room);
    for (const tile of rectTiles(rect)) {
      this.tileAt(tile.col, tile.row)!.roomId = id;
    }
    if (type === 'exam') this.placeBed(room);
    if (!free) {
      this.cash -= def.cost;
      this.events.emit('cashChanged', { cash: this.cash });
    }
    this.events.emit('roomBuilt', { roomId: id });
    this.recomputePaths();
  }

  /** M1 placeholder prop: a 2-tile bed proving multi-tile depth slicing (tech plan §2.5). */
  private placeBed(room: Room): void {
    for (let row = room.rect.row; row < room.rect.row + room.rect.rows; row++) {
      for (let col = room.rect.col; col < room.rect.col + room.rect.cols - 1; col++) {
        const a = { col, row };
        const b = { col: col + 1, row };
        if (room.door && (samePoint(room.door.inside, a) || samePoint(room.door.inside, b))) {
          continue;
        }
        const tileA = this.tileAt(a.col, a.row)!;
        const tileB = this.tileAt(b.col, b.row)!;
        tileA.object = 'bed';
        tileB.object = 'bed';
        tileA.walkable = false;
        tileB.walkable = false;
        // Props must never strand part of the room (M1 review M-8): verify the
        // interior is still fully door-connected, else revert and try the next
        // spot. Placement validation ran BEFORE the prop existed, so this is
        // the backstop that keeps the invariant stated rather than accidental.
        if (this.roomInteriorConnected(room)) return;
        tileA.object = null;
        tileB.object = null;
        tileA.walkable = true;
        tileB.walkable = true;
      }
    }
  }

  /** Every walkable tile of the room reachable from its door-inside tile. */
  private roomInteriorConnected(room: Room): boolean {
    if (!room.door) return true;
    const walkableTiles = rectTiles(room.rect).filter((t) => this.tileAt(t.col, t.row)!.walkable);
    const start = room.door.inside;
    if (!this.tileAt(start.col, start.row)!.walkable) return false;
    const keyOf = (p: GridPoint): number => p.col * this.rows + p.row;
    const visited = new Set<number>([keyOf(start)]);
    const queue: GridPoint[] = [start];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const step of ORTHOGONAL_STEPS) {
        const next = { col: current.col + step.col, row: current.row + step.row };
        if (!rectContains(room.rect, next)) continue;
        const k = keyOf(next);
        if (visited.has(k) || !this.canStep(current, next)) continue;
        visited.add(k);
        queue.push(next);
      }
    }
    return visited.size === walkableTiles.length;
  }

  private sellRoom(roomId: number): void {
    const check = validateRoomSell(this, roomId);
    if (!check.ok) {
      this.events.emit('buildRejected', { reason: check.reason });
      return;
    }
    const room = this.rooms.get(roomId)!;
    for (const tile of rectTiles(room.rect)) {
      const t = this.tileAt(tile.col, tile.row)!;
      t.roomId = null;
      t.object = null;
      t.walkable = true;
    }
    this.rooms.delete(roomId);
    this.checkInQueues.delete(roomId);
    // Staff posted here go idle; waiting patients seated here lose their seat.
    for (const s of this.staff.values()) {
      if (s.duty.kind === 'post' && s.duty.roomId === roomId) s.duty = { kind: 'idle' };
    }
    for (const p of this.patients.values()) {
      if (p.waitingRoomId === roomId) {
        p.waitingRoomId = null;
        this.assignWaitingSpot(p); // re-seat elsewhere instead of standing in rubble
      }
      if (
        (p.stage.kind === 'queuedCheckIn' || p.stage.kind === 'checkingIn') &&
        p.stage.roomId === roomId
      ) {
        this.routeToCheckIn(p);
      }
    }
    this.cash += Math.floor(ROOM_DEFS[room.type].cost * BALANCE.economy.roomSellbackRatio);
    this.events.emit('cashChanged', { cash: this.cash });
    this.events.emit('roomSold', { roomId });
    this.recomputePaths();
  }

  // ------------------------------------------------------------------- staff

  /** Create a staff member at the entrance (hiring and the new-game setup both use this). */
  addStaffMember(
    role: RoleId,
    skill: number,
    salaryPerDay: number,
    name = generateName(this.rng),
    age = generateAge(this.rng),
  ): Staff {
    const member: Staff = {
      id: this.takeId(),
      name,
      age,
      role,
      skill,
      salaryPerDay,
      duty: { kind: 'idle' },
      firing: false,
      at: { ...BALANCE.map.entrance },
      next: null,
      path: [],
      target: null,
      progress: 0,
    };
    this.staff.set(member.id, member);
    this.events.emit('staffHired', { staffId: member.id });
    return member;
  }

  private hireStaff(candidateId: number): void {
    const index = this.candidates.findIndex((c) => c.id === candidateId);
    if (index === -1) return;
    if (this.cash < BALANCE.economy.hireFee) {
      this.events.emit('buildRejected', { reason: 'Not enough cash for the hire fee' });
      return;
    }
    const candidate = this.candidates[index]!;
    this.candidates.splice(index, 1, this.makeCandidate(candidate.role));
    this.addStaffMember(
      candidate.role,
      candidate.skill,
      candidate.salaryPerDay,
      candidate.name,
      candidate.age,
    );
    this.cash -= BALANCE.economy.hireFee;
    this.events.emit('cashChanged', { cash: this.cash });
  }

  private fireStaff(staffId: number): void {
    const member = this.staff.get(staffId);
    if (!member) return;
    if (member.duty.kind === 'reserved') {
      member.firing = true; // finishes the current patient first (GDD §4)
      this.events.emit('staffUpdated', { staffId: member.id });
      return;
    }
    this.removeStaff(member);
  }

  private removeStaff(member: Staff): void {
    this.staff.delete(member.id);
    this.events.emit('staffFired', { staffId: member.id });
  }

  // -------------------------------------------------------- patient routing

  spawnPatient(condition: ConditionId): Patient {
    const patient: Patient = {
      id: this.takeId(),
      name: generateName(this.rng),
      age: generateAge(this.rng),
      condition,
      acuity: null,
      health: 100,
      patience: 100,
      stepIndex: 0,
      billed: 0,
      stage: { kind: 'atEntrance' },
      waitingSince: null,
      dispatchHoldUntil: 0,
      waitingRoomId: null,
      at: { ...BALANCE.map.entrance },
      next: null,
      path: [],
      target: null,
      progress: 0,
    };
    this.patients.set(patient.id, patient);
    this.routeToCheckIn(patient);
    this.events.emit('patientSpawned', { patientId: patient.id });
    return patient;
  }

  /** Which reception rooms have a receptionist posted (walking there counts). */
  staffedReceptionIds(): Set<number> {
    const staffed = new Set<number>();
    for (const s of this.staff.values()) {
      if (s.duty.kind === 'post') staffed.add(s.duty.roomId);
    }
    return staffed;
  }

  /** Send a patient to the shortest check-in queue; atEntrance if none exists. */
  routeToCheckIn(patient: Patient): void {
    const receptions = this.roomsOfType('reception').filter((r) => r.door);
    const staffed = this.staffedReceptionIds();
    // Capacity = the desk slot + queueDepthTiles behind it (GDD Flow rule 1).
    const capacity = BALANCE.reception.queueDepthTiles + 1;
    let best: Room | null = null;
    let bestKey = Infinity;
    for (const room of receptions) {
      const length = this.queueFor(room.id).length;
      if (length >= capacity) continue;
      // An unstaffed desk never processes its queue, so any staffed desk beats
      // any unstaffed one; queue length breaks ties (M3-gate review).
      const key = length + (staffed.has(room.id) ? 0 : capacity);
      if (key < bestKey) {
        best = room;
        bestKey = key;
      }
    }
    if (!best) {
      patient.stage = { kind: 'atEntrance' };
      // ??= so per-tick re-route attempts never reset AMA/aging timing (M2 review #8).
      patient.waitingSince ??= this.clock.tick;
      return;
    }
    const queue = this.queueFor(best.id);
    queue.push(patient.id);
    const slot = queue.length - 1;
    patient.stage = { kind: 'queuedCheckIn', roomId: best.id, slot };
    patient.waitingSince = this.clock.tick;
    this.setWalkerTarget(patient, this.queueSlotTile(best, slot));
  }

  queueFor(roomId: number): number[] {
    let queue = this.checkInQueues.get(roomId);
    if (!queue) {
      queue = [];
      this.checkInQueues.set(roomId, queue);
    }
    return queue;
  }

  /** Queue slots extend outward from the door landing, away from the room. */
  queueSlotTile(room: Room, slot: number): GridPoint {
    const door = room.door!;
    const dir = {
      col: door.outside.col - door.inside.col,
      row: door.outside.row - door.inside.row,
    };
    let tile = door.outside;
    for (let i = 0; i < slot; i++) {
      const nextTile = { col: tile.col + dir.col, row: tile.row + dir.row };
      if (!this.isWalkable(nextTile) || this.tileAt(nextTile.col, nextTile.row)!.roomId !== null) {
        break; // clamp: stack on the last legal tile
      }
      tile = nextTile;
    }
    return tile;
  }

  /** Remove a patient from any check-in queue and re-slot everyone behind them. */
  leaveQueue(patient: Patient): void {
    if (patient.stage.kind !== 'queuedCheckIn' && patient.stage.kind !== 'checkingIn') return;
    const roomId = patient.stage.roomId;
    const queue = this.queueFor(roomId);
    const index = queue.indexOf(patient.id);
    if (index === -1) return;
    queue.splice(index, 1);
    const room = this.rooms.get(roomId);
    if (!room) return;
    queue.forEach((id, slot) => {
      const p = this.patients.get(id);
      if (p && p.stage.kind === 'queuedCheckIn') {
        p.stage = { kind: 'queuedCheckIn', roomId, slot };
        this.setWalkerTarget(p, this.queueSlotTile(room, slot));
      }
    });
  }

  /** Seat the patient in a waiting room with capacity, or leave them standing. */
  assignWaitingSpot(patient: Patient): void {
    const waitingRooms = this.roomsOfType('waiting').filter((r) => r.door);
    for (const room of waitingRooms) {
      const seated = [...this.patients.values()].filter((p) => p.waitingRoomId === room.id).length;
      if (seated < WAITING_ROOM_BASE_CHAIRS) {
        patient.waitingRoomId = room.id;
        this.setWalkerTarget(patient, this.freeInteriorTile(room));
        return;
      }
    }
    patient.waitingRoomId = null; // standing: 1.5× patience decay (Flow rule 4)
    // Flow rule 4: overflow waiters stand on a free tile in/around the waiting
    // room (or near where they are, if none exists) — never left parked on the
    // desk slot or inside a treatment room (M3-gate review).
    const anchor = waitingRooms[0]?.door?.outside ?? patient.next ?? patient.at;
    const spot = this.nearestFreeStandingTile(anchor, patient, { includeWaitingRooms: true });
    if (spot) this.setWalkerTarget(patient, spot);
  }

  // ------------------------------------------------------ terminal outcomes

  applyReputation(delta: number): void {
    this.reputation = Math.min(
      BALANCE.reputation.max,
      Math.max(0, this.reputation + delta),
    );
    this.events.emit('reputationChanged', { reputation: this.reputation });
  }

  billFee(amount: number, label: string): void {
    this.cash += amount;
    this.events.emit('cashChanged', { cash: this.cash });
    this.events.emit('feeBilled', { amount, label });
  }

  /** Emit an advisory toast at most once per key (Flow rule 5). */
  hintOnce(key: string, message: string): void {
    if (this.hintedOnce.has(key)) return;
    this.hintedOnce.add(key);
    this.events.emit('hint', { message });
  }

  /**
   * Flow rule 8: a reservation whose participants cannot reach the room is
   * cancelled — resources released, patient re-queued — never a silent stall.
   */
  cancelReservation(reservation: Reservation): void {
    const patient = this.patients.get(reservation.patientId);
    this.releaseReservation(reservation);
    if (!patient) return;
    patient.stage =
      reservation.kind === 'triage' ? { kind: 'waitingTriage' } : { kind: 'waiting' };
    // Flow rule 6 ruling: the wait clock survives the failed reservation.
    patient.waitingSince = reservation.patientWaitingSince ?? this.clock.tick;
    // Hot-loop guard (M3-gate review): without a hold, the dispatcher would
    // re-reserve the same doomed room next tick — reserve/cancel forever.
    patient.dispatchHoldUntil =
      this.clock.tick + gameMinutesToTicks(BALANCE.dispatcher.cancelRetryGameMinutes);
    this.assignWaitingSpot(patient);
    this.hintOnce(
      `noPath:${patient.id}`,
      `${patient.name.short} couldn't reach the room — check your corridors`,
    );
  }

  /** Flow rule 7: release EVERYTHING a patient holds, from any stage. */
  releasePatientHoldings(patient: Patient): void {
    this.leaveQueue(patient);
    patient.waitingRoomId = null;
    if (patient.stage.kind === 'reserved') {
      const res = this.reservations.get(patient.stage.reservationId);
      if (res) this.releaseReservation(res);
    }
  }

  /** Free the room and return staff to idle (or remove them if fired mid-job). */
  releaseReservation(reservation: Reservation): void {
    this.reservations.delete(reservation.id);
    for (const staffId of reservation.staffIds) {
      const member = this.staff.get(staffId);
      if (!member) continue;
      member.duty = { kind: 'idle' };
      if (member.firing) {
        this.removeStaff(member);
        continue;
      }
      // Released staff stop heading to the released room (stale-target leak)
      // and step out of walled rooms, so "Someone is inside" can't pin a sale
      // on an idle loiterer (Flow rules 9/11 — idle wandering proper is M3).
      member.path = [];
      member.target = null;
      const standing = member.next ?? member.at;
      const room = this.roomAt(standing);
      if (room && ROOM_DEFS[room.type].kind !== 'open') {
        const spot = this.nearestFreeStandingTile(standing, member);
        if (spot) this.setWalkerTarget(member, spot);
      }
    }
  }

  killPatient(patient: Patient): void {
    if (patient.stage.kind === 'dead') return;
    this.releasePatientHoldings(patient);
    patient.stage = { kind: 'dead', since: this.clock.tick };
    patient.next = null;
    patient.path = [];
    patient.target = null;
    this.applyReputation(-BALANCE.reputation.deathLoss);
    this.events.emit('patientDied', {
      patientId: patient.id,
      name: patient.name.full,
      condition: CONDITION_DEFS[patient.condition].label,
    });
  }

  patientLeavesAma(patient: Patient): void {
    this.releasePatientHoldings(patient);
    patient.stage = { kind: 'leaving', reason: 'ama' };
    this.applyReputation(-BALANCE.reputation.amaLoss);
    this.setWalkerTarget(patient, BALANCE.map.entrance);
    this.events.emit('patientLeftAma', { patientId: patient.id, name: patient.name.full });
  }

  dischargePatient(patient: Patient, totalBilled: number): void {
    this.releasePatientHoldings(patient);
    patient.stage = { kind: 'leaving', reason: 'discharged' };
    this.applyReputation(dischargeReputationGain(patient.acuity ?? BALANCE.decay.untriagedAcuity));
    this.setWalkerTarget(patient, BALANCE.map.entrance);
    this.events.emit('patientDischarged', {
      patientId: patient.id,
      name: patient.name.full,
      totalBilled,
    });
  }

  private debugForce(patientId: number, outcome: 'death' | 'ama' | 'complication'): void {
    const patient = this.patients.get(patientId);
    if (!patient || patient.stage.kind === 'dead' || patient.stage.kind === 'leaving') return;
    if (outcome === 'death') {
      this.killPatient(patient);
    } else if (outcome === 'ama') {
      this.patientLeavesAma(patient);
    } else if (
      patient.stage.kind === 'reserved' &&
      this.reservations.get(patient.stage.reservationId)?.kind === 'treatment'
    ) {
      // Mirror the REAL complication path (M2 review #11) so debug reproduces
      // the same bug class the game can hit, including death at health 0.
      resolveTreatmentOutcome(this, this.reservations.get(patient.stage.reservationId)!, false);
    } else {
      patient.health -= BALANCE.treatment.complicationHealthPenalty;
      if (patient.health <= 0) {
        patient.health = 0;
        this.killPatient(patient);
      } else {
        this.events.emit('patientComplication', {
          patientId: patient.id,
          name: patient.name.full,
        });
      }
    }
  }

  // --------------------------------------------------------------- walkers

  setWalkerTarget(walker: Walker, goal: GridPoint): void {
    const start = walker.next ?? walker.at;
    const path = findPath(this, start, goal);
    if (!path) {
      // No path is a first-class outcome (Flow rule 8): finish the committed
      // step, then stop.
      walker.path = [];
      walker.target = null;
      return;
    }
    walker.target = goal;
    walker.path = path.slice(1);
    if (walker.next === null) {
      walker.next = walker.path.shift() ?? null;
      walker.progress = 0;
      // Already standing on the goal: arrival is immediate, so don't leave a
      // phantom target behind (M1 review M-3 — the dispatcher reads target).
      if (walker.next === null) walker.target = null;
    }
  }

  /** Has this walker finished moving (no committed step, no pending goal)? */
  walkerArrived(walker: Walker): boolean {
    return walker.next === null && walker.target === null;
  }

  /** Blunt M1 policy (tech plan §2.4): recompute every active path on build/sell. */
  private recomputePaths(): void {
    for (const patient of this.patients.values()) {
      if (patient.target) this.setWalkerTarget(patient, patient.target);
    }
    for (const member of this.staff.values()) {
      if (member.target) this.setWalkerTarget(member, member.target);
    }
  }

  // -------------------------------------------------------------------- tick

  /** One fixed-timestep sim step. System order per tech plan §2.1. */
  tick(): void {
    this.clock.advance();
    updateSpawn(this);
    updateDecay(this);
    updateDispatcher(this);
    updateMovement(this);
    updateTreatment(this);
    updateEconomy(this);
    if (this.clock.isMidnight) {
      this.events.emit('dayEnded', { day: this.clock.day - 1 });
    }
  }
}

export { rectContains };
