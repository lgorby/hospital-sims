import type { CommandQueue, Command } from '../commands';
import type { EventBus } from '../events';
import { doorFromOutsideTile, validateRoomBuild, validateRoomSell } from './build';
import { GameClock } from './clock';
import { BALANCE } from './data/balance';
import { generateAge, generateName } from './data/names';
import { ROOM_DEFS, type RoomType } from './data/rooms';
import type { Door, Room } from './entities/room';
import type { Patient } from './entities/patient';
import { findPath, type PathGrid } from './path/astar';
import { SeededRng } from './rng';
import { updateMovement } from './systems/movement';
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
  cash: number = BALANCE.economy.startingCash;
  reputation: number = BALANCE.reputation.starting;
  private nextEntityId = 1;

  constructor(
    private events: EventBus,
    seed: number,
  ) {
    this.rng = new SeededRng(seed);
    this.grid = Array.from({ length: this.cols }, () =>
      Array.from(
        { length: this.rows },
        (): Tile => ({ walkable: true, roomId: null, object: null, marker: false }),
      ),
    );
  }

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
      case 'debugSpawnPatient':
        this.spawnPatient();
        return;
      case 'debugWalkTo':
        this.walkAllTo({ col: command.col, row: command.row });
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

  private buildRoom(type: RoomType, rect: Rect, doorOutside: GridPoint | null): void {
    const isOpen = ROOM_DEFS[type].kind === 'open';
    const door: Door | null =
      isOpen || !doorOutside ? null : doorFromOutsideTile(rect, doorOutside);
    const check = validateRoomBuild(this, type, rect, isOpen ? null : door);
    if (!check.ok) {
      this.events.emit('buildRejected', { reason: check.reason });
      return;
    }

    const def = ROOM_DEFS[type];
    const id = this.nextEntityId++;
    const room: Room = {
      id,
      type,
      rect,
      door,
      quality: (rect.cols * rect.rows - def.minCols * def.minRows) * BALANCE.rooms.qualityPerExtraTile,
    };
    this.rooms.set(id, room);
    for (const tile of rectTiles(rect)) {
      this.tileAt(tile.col, tile.row)!.roomId = id;
    }
    if (type === 'exam') this.placeBed(room);
    this.cash -= def.cost;
    this.events.emit('cashChanged', { cash: this.cash });
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
    this.cash += Math.floor(ROOM_DEFS[room.type].cost * BALANCE.economy.roomSellbackRatio);
    this.events.emit('cashChanged', { cash: this.cash });
    this.events.emit('roomSold', { roomId });
    this.recomputePaths();
  }

  roomAt(p: GridPoint): Room | null {
    const id = this.tileAt(p.col, p.row)?.roomId ?? null;
    return id === null ? null : (this.rooms.get(id) ?? null);
  }

  private spawnPatient(): void {
    const id = this.nextEntityId++;
    const patient: Patient = {
      id,
      name: generateName(this.rng),
      age: generateAge(this.rng),
      at: { ...BALANCE.map.entrance },
      next: null,
      path: [],
      target: null,
      progress: 0,
    };
    this.patients.set(id, patient);
    this.events.emit('patientSpawned', { patientId: id });
  }

  private walkAllTo(goal: GridPoint): void {
    for (const patient of this.patients.values()) {
      this.setPatientTarget(patient, goal);
    }
  }

  private setPatientTarget(patient: Patient, goal: GridPoint): void {
    const start = patient.next ?? patient.at;
    const path = findPath(this, start, goal);
    if (!path) {
      // No path is a first-class outcome (Flow rule 8): finish the committed
      // step, then stop.
      patient.path = [];
      patient.target = null;
      return;
    }
    patient.target = goal;
    patient.path = path.slice(1);
    if (patient.next === null) {
      patient.next = patient.path.shift() ?? null;
      patient.progress = 0;
      // Already standing on the goal: arrival is immediate, so don't leave a
      // phantom target behind (M1 review M-3 — M2's dispatcher reads target).
      if (patient.next === null) patient.target = null;
    }
  }

  /** Blunt M1 policy (tech plan §2.4): recompute every active path on build/sell. */
  private recomputePaths(): void {
    for (const patient of this.patients.values()) {
      if (patient.target) this.setPatientTarget(patient, patient.target);
    }
  }

  /** One fixed-timestep sim step. */
  tick(): void {
    this.clock.advance();
    updateMovement(this);
    if (this.clock.isMidnight) {
      this.events.emit('dayEnded', { day: this.clock.day - 1 });
    }
  }
}

export { rectContains };
