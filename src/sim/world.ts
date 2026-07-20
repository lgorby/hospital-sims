import type { CommandQueue, Command } from '../commands';
import type { EventBus } from '../events';
import {
  doorFromOutsideTile,
  validateAmenityPlace,
  validateAmenitySell,
  validateRoomBuild,
  validateRoomExpand,
  validateRoomSell,
} from './build';
import { GameClock, gameMinutesToTicks, TICKS_PER_DAY, ticksToGameMinutes } from './clock';
import { emptyDayTally, type DayReport, type DayTally } from './dailyStats';
import { AMENITY_DEFS, type Amenity, type AmenityId } from './data/amenities';
import { BALANCE } from './data/balance';
import { CONDITION_DEFS, conditionElective, type ConditionId } from './data/conditions';
import { emptyCashTotals, type CashTallyKey, type CashTotals } from './data/finance';
import { generateAge, generateName, generateStaffAge } from './data/names';
import { ROLE_DEFS, ROLE_IDS, type RoleId } from './data/roles';
import {
  PROP_STYLE,
  ROOM_DEFS,
  roomFailure,
  type PropId,
  type PropSpec,
  type RoomType,
} from './data/rooms';
import type { Door, Room } from './entities/room';
import { LEGAL_STAGE_TRANSITIONS, type Patient, type PatientStage } from './entities/patient';
import type { Candidate, Job, Reservation, Staff } from './entities/staff';
import {
  amenitySellback,
  auraCoversTile,
  breakdownChance,
  candidateSalary,
  checkInCapacity,
  cleanlinessRepDelta,
  dischargeReputationGain,
  expandPrice,
  plantCoversTile,
  priceOf,
  propTargetCount,
  roomQuality,
  sellbackAmount,
} from './formulas';
import { findPath, type PathGrid } from './path/astar';
import { SeededRng } from './rng';
import { updateDecay } from './systems/decay';
import { updateDispatcher } from './systems/dispatcher';
import { updateMess } from './systems/mess';
import { updatePatientNeeds } from './systems/patientNeeds';
import { updateEconomy } from './systems/economy';
import { updateMovement } from './systems/movement';
import { updateSpawn } from './systems/spawn';
import { resolveTreatmentOutcome, updateTreatment } from './systems/treatment';
import { updateThoughts } from './systems/thoughts';
import { updateWayfinding } from './systems/wayfinding';
import { THOUGHTS, type ThoughtKey } from './data/thoughts';
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
  /** Placed equipment prop occupying this tile (GDD §5; auto-placed on build). */
  object: PropId | null;
  /** M0 debug: visual marker toggled via the command queue. */
  marker: boolean;
}

/**
 * A floor mess (amenities Stage 2, AMENITIES_PLAN §4.1): a walkable decal —
 * NOT a Tile field (the grid RLE stays untouched; messes serialize
 * explicitly). At most one per tile; a second event refreshes `since`.
 * `water` is Stage-3 surface (piping bursts) — the kind ships now so the
 * v5 save schema is stable; a clean job cleans any kind.
 */
export interface Mess {
  kind: 'vomit' | 'litter' | 'water';
  tile: GridPoint;
  since: number;
}

/** Shared walker shape — patients and staff both satisfy it. */
export interface Walker {
  /** Entity id — also the A* variety seed (equal-length path spreading). */
  id: number;
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
  /**
   * Freestanding amenity state (Stage 1, AMENITIES_PLAN §3.4), keyed
   * `${col},${row}` — the tile IS the identity. `fill` is Stage-2 surface
   * (trashcan contents) and stays 0 in Stage 1; it ships in SAVE_VERSION 4
   * so Stage 2 needs no map migration.
   */
  readonly amenities = new Map<
    string,
    Amenity
  >();
  /** Floor messes (Stage 2, §4.1), keyed `${col},${row}`. */
  readonly messes = new Map<string, Mess>();
  /** Facility job queue (Stage 2, §4.3) — clean/empty (+repair in Stage 3). */
  readonly jobs = new Map<number, Job>();
  /** Bumped on every mess add/remove — the sim-side proximity cache's
   *  invalidation counter (the auraRevision pattern). */
  messRevision = 0;
  cash: number = BALANCE.economy.startingCash;
  reputation: number = BALANCE.reputation.starting;
  /** Running tally for the current day; snapshotted + reset at midnight (M4). */
  today: DayTally = emptyDayTally();
  /** Lifetime counters for the game-over summary. */
  lifetimeTreated = 0;
  lifetimeDied = 0;
  /** Closed-day reports, oldest → newest, trimmed to `historyCapDays`
   *  (FINANCE_PLAN §9.5) — the finances grid's columns and cash graph. */
  readonly history: DayReport[] = [];
  /** Lifetime cash totals (§3.1 Total, §3.2 average). Real state, not a sum
   *  over live rooms — a SOLD room takes its counter with it. */
  readonly lifetime: CashTotals = emptyCashTotals();
  /**
   * Discharges that happened BEFORE this save gained lifetime tracking — 0 on
   * a new game, set to the restored `lifetimeTreated` on a v6→v7 migration.
   * Without this watermark the average bill divides fresh revenue by
   * pre-upgrade discharges and reads permanently, invisibly low (§3.2).
   * Not readonly: the migration assigns it.
   */
  lifetimeTreatedBase = 0;
  /** Tick when cash first dropped below the bankruptcy threshold; null = solvent. */
  bankruptSinceTick: number | null = null;
  /** Terminal state (M4): once set, tick() is a no-op — the world is frozen. */
  gameOver = false;
  /** Illegal stage-transition log (audit #5) — tests assert it stays empty. */
  readonly stageViolations: string[] = [];
  /** One-shot advisory hints already shown (Flow rule 5 "once per condition type"). */
  private hintedOnce = new Set<string>();
  private nextEntityId = 1;

  /**
   * The ONLY way to change a patient's lifecycle stage (tech plan §2.3, audit
   * #5): kind transitions validate against LEGAL_STAGE_TRANSITIONS, plus the
   * semantic invariant a kind-table can't see — 'waiting' means "triaged,
   * awaiting treatment", so it requires acuity (the audit-#1 bug class).
   */
  setPatientStage(patient: Patient, next: PatientStage): void {
    const from = patient.stage.kind;
    const legalKind = from === next.kind || LEGAL_STAGE_TRANSITIONS[from].includes(next.kind);
    const triagedOk = next.kind !== 'waiting' || patient.acuity !== null;
    if (!legalKind || !triagedOk) {
      this.stageViolations.push(`${from}→${next.kind}#${patient.id}`);
      console.warn(`Illegal stage transition ${from}→${next.kind} (patient ${patient.id})`);
    }
    patient.stage = next;
  }

  constructor(
    readonly events: EventBus,
    /** The boot seed — display/bookkeeping only once ticks have run (saves carry rng state). */
    readonly seed: number,
    /**
     * Phase 2: a challenge run rejects every `debug*` command at the mutation
     * gate (plan §7). Runtime state only — NOT `src/sim` source and NOT saved,
     * so `save.ts`'s `new World(events, seed)` compiles untouched and a save
     * reloaded via `?load=` is a normal (non-challenge) run.
     */
    readonly challengeMode = false,
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

  /**
   * SAVE-SCOPED (src/sim/save.ts only): snapshot the private fields a save
   * must carry — one-shot hint keys and the id counter. Gameplay code uses
   * `hintOnce()`/`takeId()`; this pair exists so serialization never needs to
   * widen those fields' visibility.
   */
  exportPrivateState(): { hintedOnce: string[]; nextEntityId: number } {
    return { hintedOnce: [...this.hintedOnce], nextEntityId: this.nextEntityId };
  }

  /** SAVE-SCOPED (src/sim/save.ts only): counterpart of exportPrivateState(). */
  restorePrivateState(state: { hintedOnce: string[]; nextEntityId: number }): void {
    this.hintedOnce.clear();
    for (const key of state.hintedOnce) this.hintedOnce.add(key);
    this.nextEntityId = state.nextEntityId;
  }

  /**
   * SAVE-SCOPED (src/sim/save.ts only): refill the hiring pool to
   * candidatesPerRole for every role, via the normal makeCandidate path.
   * The pool is minted once in the constructor and only replenished
   * like-for-like on hire, so a save from BEFORE a role existed could
   * otherwise never offer it (v1→v2 review MAJOR: an unhirable Surgeon the
   * dispatcher still hints for). A complete pool — every same-version save —
   * is a strict NO-OP: zero rng draws, zero ids issued, so byte-identity of
   * save→load→save is untouched. Topping up a deficit consumes rng draws and
   * ids, deliberately diverging the migrated world from its origin version.
   * MUST run after restorePrivateState (ids come from the restored counter).
   */
  topUpCandidates(): void {
    for (const role of ROLE_IDS) {
      let have = 0;
      for (const c of this.candidates) if (c.role === role) have += 1;
      for (let i = have; i < BALANCE.hiring.candidatesPerRole; i++) {
        this.candidates.push(this.makeCandidate(role));
      }
    }
  }

  private makeCandidate(role: RoleId): Candidate {
    const skill = this.rng.intInRange(BALANCE.stats.min, BALANCE.stats.max);
    return {
      id: this.takeId(),
      role,
      name: generateName(this.rng),
      age: generateStaffAge(this.rng),
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
    if (!this.tileAt(to.col, to.row)?.walkable) return false;
    return this.canApproach(from, to);
  }

  /**
   * `canStep` minus the destination-walkability requirement: may `from`
   * legally FACE `to` across this edge (same room, open plan, or a door)?
   * Exists because Manhattan adjacency holds THROUGH edge-walls (Stage-2
   * code review MAJOR: a corridor tile is adjacent to an in-room mess across
   * the wall — job work tiles must never be picked there; and trashcan
   * targets are non-walkable, so plain canStep can't express "serve it").
   */
  canApproach(from: GridPoint, to: GridPoint): boolean {
    const tileFrom = this.tileAt(from.col, from.row);
    const tileTo = this.tileAt(to.col, to.row);
    if (!tileFrom || !tileTo) return false;
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

  // ---------------------------------------------------- capacity (Stage A)

  /**
   * Slot-prop strip ORIGINS in deterministic row-major order — the slot ids
   * (index in this array = `Reservation.slotIndex`). Derived from the tile
   * grid, so capacity needs no saved state: `tilesWithObject / stripLength`
   * (CAPACITY_PLAN §2.2) falls out of consuming each strip as it is met
   * (placement lays strips west→east on one row).
   */
  slotOrigins(room: Room): GridPoint[] {
    const cap = ROOM_DEFS[room.type].capacity;
    if (cap.kind !== 'perProp') return [];
    return this.stripOrigins(room.rect, cap.prop);
  }

  /** Strip origins of ANY prop id within a rect (row-major consumption) —
   *  slot derivation and Stage B's additive re-densify both count with this. */
  private stripOrigins(rect: Rect, prop: PropId): GridPoint[] {
    const stripLen = PROP_STYLE[prop].tiles;
    const origins: GridPoint[] = [];
    for (let row = rect.row; row < rect.row + rect.rows; row++) {
      for (let col = rect.col; col < rect.col + rect.cols; col++) {
        if (this.tileAt(col, row)!.object !== prop) continue;
        origins.push({ col, row });
        col += stripLen - 1; // consume the rest of this strip
      }
    }
    return origins;
  }

  /** Concurrent-patient capacity: 1 for `single` rooms, else the placed slot
   *  count. Sim (dispatch) and UI (inspect readout) both read THIS. Known
   *  edge (review NIT): a perProp room whose slot props ALL failed placement
   *  derives capacity 0 and is undispatchable — unreachable at min sizes
   *  (placement fit is test-proven); Stage B's expansion recompute must keep
   *  it that way or add a hint. */
  capacityOf(room: Room): number {
    // Stage 3 (§5.2): a broken room disables — hasOpenSlot gates every
    // dispatch path and freeStallIndex returns null for restrooms. Actives
    // finish (transiently negative openSlots is the verified-safe case).
    // Broken (Stage 3, a dice roll) and closed (ED B1, the player's choice)
    // disable a room identically — this ONE line gates every dispatch path.
    if (room.brokenSince !== null || room.closed) return 0;
    return ROOM_DEFS[room.type].capacity.kind === 'single' ? 1 : this.slotOrigins(room).length;
  }

  /** Live reservations currently holding this room (any phase). */
  reservationsOn(roomId: number): Reservation[] {
    return [...this.reservations.values()].filter((r) => r.roomId === roomId);
  }

  /**
   * ED epic Stage B1: every live reservation naming this staffer — their
   * "panel". A staffer's LOAD is DERIVED, never separately tracked (the
   * restroom-occupancy precedent), so there is no counter to leak and no new
   * saved state. Id-ascending: `releaseReservation` picks a witness from this
   * and the sim must be deterministic.
   */
  reservationsOfStaff(staffId: number): Reservation[] {
    return [...this.reservations.values()]
      .filter((r) => r.staffIds.includes(staffId))
      .sort((a, b) => a.id - b.id);
  }

  /** …of which how many are in this room (the ratio is per-room — §1). */
  staffLoadIn(staffId: number, roomId: number, opts: { activeOnly?: boolean } = {}): number {
    let load = 0;
    for (const r of this.reservations.values()) {
      if (r.roomId !== roomId || !r.staffIds.includes(staffId)) continue;
      // `activeOnly` is for the ATTENTION PENALTY (post-impl review MINOR 5).
      // Dispatch capacity must count gathering reservations — they are held
      // slots. Divided attention must not: a nurse merely WALKING toward bay 2
      // was permanently slowing bay 1's whole treatment, and kept the penalty
      // even if bay 2's gather was then cancelled, because `ticksRemaining` is
      // frozen at promotion. Only patients actually being treated divide her.
      if (opts.activeOnly && r.phase !== 'active') continue;
      load += 1;
    }
    return load;
  }

  /** Free capacity slots — the dispatcher reserves while this is > 0. */
  openSlots(room: Room): number {
    return this.capacityOf(room) - this.reservationsOn(room.id).length;
  }

  /** The lowest slot index no live reservation holds (0 for `single` rooms). */
  freeSlotIndex(room: Room): number {
    const taken = new Set(this.reservationsOn(room.id).map((r) => r.slotIndex));
    const cap = this.capacityOf(room);
    for (let i = 0; i < cap; i++) if (!taken.has(i)) return i;
    // Callers must guard on openSlots > 0 — reaching here would double-book
    // slot 0 (two patients on one bed). Loud, not silent (review NIT).
    console.warn(`freeSlotIndex on a full room (id ${room.id}) — caller missed openSlots guard`);
    return 0;
  }

  /**
   * Where the patient of `slotIndex`'s reservation stands: a deterministic
   * walkable tile beside their slot strip (prefer unclaimed — Flow rule 14),
   * so concurrent occupants gather at THEIR bed instead of stacking on random
   * interior tiles (CAPACITY_PLAN §3.3 anchoring). Range-safe: an out-of-range
   * slot (hostile save) falls back to a free interior tile.
   */
  slotAnchorTile(room: Room, slotIndex: number): GridPoint {
    const cap = ROOM_DEFS[room.type].capacity;
    const origin = this.slotOrigins(room)[slotIndex];
    if (cap.kind === 'perProp' && origin) {
      const stripLen = PROP_STYLE[cap.prop].tiles;
      const candidates: GridPoint[] = [];
      for (let i = 0; i < stripLen; i++) {
        const stripTile = { col: origin.col + i, row: origin.row };
        for (const step of ORTHOGONAL_STEPS) {
          const p = { col: stripTile.col + step.col, row: stripTile.row + step.row };
          if (!rectContains(room.rect, p)) continue;
          if (!this.tileAt(p.col, p.row)!.walkable) continue;
          if (room.door && samePoint(p, room.door.inside)) continue;
          candidates.push(p);
        }
      }
      const free = candidates.find((p) => !this.isTileClaimed(p));
      if (free) return free;
      // All bedside tiles claimed: fall THROUGH to freeInteriorTile (which
      // still prefers unclaimed) rather than stacking on a claimed bedside
      // tile while free interior tiles exist (Stage A review — rule 14).
    }
    return this.freeInteriorTile(room, room.door?.inside);
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

  // ------------------------------------------------------------------- auras

  /** Bumped each time the aura grid actually recomputes — cheap dirty-check
   *  for overlays. Deliberately NOT saved (plan rule 6 checklist): a derived
   *  render-cache stamp with no sim meaning; it resets to 0 on load and the
   *  'never' aura signature rebuilds coverage lazily on first query. */
  auraRevision = 0;
  /** Aura state is fully determined by this signature — atrium footprints + staffing. */
  private auraSignature = 'never';
  /** Signature is rechecked at most once per tick (M3 review: overlay queries per frame). */
  private auraCheckedTick = -1;
  private auraGuidance: boolean[][] = [];
  private auraComfort: boolean[][] = [];

  /** Is the atrium's help desk staffed — greeter posted AND arrived (M3 ruling)? */
  atriumStaffed(room: Room): boolean {
    for (const s of this.staff.values()) {
      if (
        s.duty.kind === 'post' &&
        s.duty.roomId === room.id &&
        this.walkerArrived(s) &&
        this.isInsideRoom(s.at, room)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Recompute the aura grid when atriums or their staffing changed (tech plan
   * §2.3). Signature-checked every tick, so greeter arrival/departure — the
   * invalidation moment the docs call out — is caught without explicit hooks.
   */
  refreshAuras(): void {
    if (this.clock.tick === this.auraCheckedTick) return;
    this.auraCheckedTick = this.clock.tick;
    const atriums = this.roomsOfType('atrium');
    // Plants project a small comfort aura (amenities Stage 1, §3.4) — their
    // tiles join the signature so placing/selling one bumps `auraRevision`
    // and the overlay cache rebuilds (the aura-input rule, HANDOFF).
    const plants = [...this.amenities.values()].filter((a) => a.kind === 'plant');
    // The RECT is part of the signature (Stage B, design-review MAJOR 5):
    // rooms can now GROW post-build — an expanded atrium must rebuild its
    // coverage, not keep the old footprint's aura.
    const signature =
      atriums
        .map(
          (room) =>
            `${room.id}:${this.atriumStaffed(room) ? 1 : 0}:` +
            `${room.rect.col},${room.rect.row},${room.rect.cols},${room.rect.rows}`,
        )
        .join('|') +
      `#plants:${plants.map((a) => `${a.tile.col},${a.tile.row}`).join('|')}`;
    if (signature === this.auraSignature) return;
    this.auraSignature = signature;
    // Public change stamp: render-side overlay caches rebuild ONLY when this
    // moves (perf DoD finding: per-frame full rebuilds cost ~2ms at 40×40).
    this.auraRevision += 1;
    this.auraGuidance = Array.from({ length: this.cols }, () => Array(this.rows).fill(false));
    this.auraComfort = Array.from({ length: this.cols }, () => Array(this.rows).fill(false));

    const radius = BALANCE.wayfinding.guidanceAuraRadius;
    for (const room of atriums) {
      const staffed = this.atriumStaffed(room);
      // Membership via the ONE aura formula (SSOT audit #3): Euclidean ≤
      // radius from ANY footprint tile, walls ignored (M3 ruling) — the
      // build-ghost preview asks auraCoversTile directly, so it can't drift.
      const minCol = Math.max(0, room.rect.col - radius);
      const maxCol = Math.min(this.cols - 1, room.rect.col + room.rect.cols - 1 + radius);
      const minRow = Math.max(0, room.rect.row - radius);
      const maxRow = Math.min(this.rows - 1, room.rect.row + room.rect.rows - 1 + radius);
      for (let col = minCol; col <= maxCol; col++) {
        for (let row = minRow; row <= maxRow; row++) {
          if (!auraCoversTile(room.rect, { col, row }, radius)) continue;
          this.auraComfort[col]![row] = true;
          if (staffed) this.auraGuidance[col]![row] = true;
        }
      }
    }

    // Plant comfort auras (Stage 1): pure comfort, never guidance. Membership
    // via the ONE formula (plantCoversTile) so any preview can't drift.
    const plantRadius = BALANCE.needs.plantAuraRadius;
    for (const plant of plants) {
      const minCol = Math.max(0, plant.tile.col - plantRadius);
      const maxCol = Math.min(this.cols - 1, plant.tile.col + plantRadius);
      const minRow = Math.max(0, plant.tile.row - plantRadius);
      const maxRow = Math.min(this.rows - 1, plant.tile.row + plantRadius);
      for (let col = minCol; col <= maxCol; col++) {
        for (let row = minRow; row <= maxRow; row++) {
          if (!plantCoversTile(plant.tile, { col, row }, plantRadius)) continue;
          this.auraComfort[col]![row] = true;
        }
      }
    }
  }

  /** No wrong turns here; lost patients recover on entry (staffed atriums, GDD §5). */
  hasGuidanceAura(p: GridPoint): boolean {
    this.refreshAuras();
    return this.auraGuidance[p.col]?.[p.row] ?? false;
  }

  /** Patience decays ×0.75 here (any atrium, staffed or not — GDD §5). */
  hasComfortAura(p: GridPoint): boolean {
    this.refreshAuras();
    return this.auraComfort[p.col]?.[p.row] ?? false;
  }

  // ---------------------------------------------------------------- commands

  /**
   * Drains and applies all pending commands. Called by the loop every frame,
   * including at speed 0 — building while paused is an RCT tradition.
   */
  applyCommands(queue: CommandQueue): void {
    for (const command of queue.drain()) {
      this.applyCommand(command);
      // Commands apply while paused (same tick) — force an aura recheck so
      // building/selling/hiring reflects in coverage immediately.
      this.auraCheckedTick = -1;
    }
  }

  private applyCommand(command: Command): void {
    // Phase 2 (plan §7, owner ruling §10.3): a challenge run is provably
    // debug-free — every `debug*` command is dropped here at the one mutation
    // gate. `startsWith('debug')` covers the COMPLETE set (all debug commands
    // are so prefixed; no non-debug command is), so a future `debug*` is
    // auto-covered. Rejection is a pure no-op: the rejected `debug*` commands
    // that draw `world.rng` never run, so the scored run's stream is unperturbed.
    if (this.challengeMode && command.type.startsWith('debug')) return;
    switch (command.type) {
      case 'buildRoom':
        this.buildRoom(command.roomType, command.rect, command.doorOutside);
        return;
      case 'expandRoom':
        this.expandRoom(command.roomId, command.rect);
        return;
      case 'setRoomClosed':
        this.setRoomClosed(command.roomId, command.closed);
        return;
      case 'sellRoom':
        this.sellRoom(command.roomId);
        return;
      case 'placeAmenity':
        this.placeAmenity(command.kind, { col: command.col, row: command.row });
        return;
      case 'sellAmenity':
        this.sellAmenity({ col: command.col, row: command.row });
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
      case 'debugBreakRoom': {
        // Live-drive/test affordance (Stage 3): mirrors the REAL breakdown
        // path (the debugForce precedent — bursts included). Guarded at the
        // border (audit #8): unknown, no-failure, or already-broken rooms
        // are inert no-ops.
        const room = this.rooms.get(command.roomId);
        if (!room || !roomFailure(room.type) || room.brokenSince !== null) return;
        this.breakRoom(room);
        return;
      }
      case 'debugForce':
        this.debugForce(command.patientId, command.outcome);
        return;
      case 'debugFastForward': {
        // The CommandQueue is the public mutation API (audit #8): clamp so a
        // hostile/buggy payload can't block the tab for minutes.
        const MAX_FAST_FORWARD_TICKS = 7 * TICKS_PER_DAY;
        const ticks = Math.min(Math.max(0, Math.floor(command.ticks)), MAX_FAST_FORWARD_TICKS);
        for (let i = 0; i < ticks; i++) this.tick();
        return;
      }
      case 'debugSetCash':
        // Balancing/testing aid (M4). Finite-guarded (audit #8): NaN would
        // poison every later += AND permanently arm the bankruptcy check.
        if (!Number.isFinite(command.amount)) return;
        this.cash = command.amount;
        this.events.emit('cashChanged', { cash: this.cash });
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

    // Geometry sweep (Stage 2, design MAJOR 4): messes (and their jobs) on
    // the footprint are deleted BEFORE the room exists — jobs never block
    // builds, and a corridor vomit must not be buried under a wall or prop
    // as an uncleanable permanent reputation leak.
    for (const tile of rectTiles(rect)) this.removeMess(tile);

    const id = this.takeId();
    const room: Room = {
      id,
      type,
      rect,
      door,
      quality: roomQuality(type, rect),
      wear: 0,
      brokenSince: null,
      closed: false,
      revenueToday: 0,
      revenueTotal: 0,
      visitsTotal: 0,
    };
    this.rooms.set(id, room);
    for (const tile of rectTiles(rect)) {
      this.tileAt(tile.col, tile.row)!.roomId = id;
    }
    this.placeProps(room);
    if (!free) {
      // Size-based economy (Stage 0, CAPACITY_PLAN §4.1): the price grows
      // per tile beyond the minimum footprint — a min-size stamp costs
      // exactly the table cost.
      const price = priceOf(type, rect);
      this.cash -= price;
      this.tallyCash('construction', price);
      this.events.emit('cashChanged', { cash: this.cash });
    }
    this.events.emit('roomBuilt', { roomId: id });
    this.recomputePaths();
  }

  /** Auto-place every prop the room def declares (GDD §5 equipment, M3
   *  ruling). Counts derive from the footprint (Stage A density rules) — a
   *  bigger room places more beds/chairs; failed placements skip silently and
   *  capacity derives from what actually landed (grid = truth). */
  private placeProps(room: Room): void {
    for (const spec of ROOM_DEFS[room.type].props) {
      const count = propTargetCount(spec.density, room.rect);
      for (let i = 0; i < count; i++) this.placePropStrip(room, spec);
    }
  }

  /**
   * Stage B (CAPACITY_PLAN §4.2): grow a built room to a validated superset
   * rect. ADDITIVE re-densify: existing prop tiles are preserved verbatim
   * (byte-identity of the untouched layout); only the density DELTA places new
   * strips, wherever the deterministic layout finds room in the grown rect.
   * Charges `expandPrice` (the Stage-0 curve). Emits `roomChanged`.
   */
  expandRoom(roomId: number, rect: Rect, free = false): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const check = validateRoomExpand(this, roomId, rect, free);
    if (!check.ok) {
      this.events.emit('buildRejected', { reason: check.reason });
      return;
    }
    const price = expandPrice(room.type, room.rect, rect);
    // Geometry sweep (Stage 2, design MAJOR 4): the DELTA tiles being
    // claimed lose their messes + jobs; the old interior is untouched.
    for (const tile of rectTiles(rect)) {
      if (!rectContains(room.rect, tile)) this.removeMess(tile);
    }
    room.rect = rect;
    for (const tile of rectTiles(rect)) {
      this.tileAt(tile.col, tile.row)!.roomId = roomId; // delta tiles join; old tiles no-op
    }
    // Additive density top-up: place only what the grown footprint newly earns.
    for (const spec of ROOM_DEFS[room.type].props) {
      const target = propTargetCount(spec.density, rect);
      const have = this.stripOrigins(rect, spec.id).length;
      for (let i = have; i < target; i++) this.placePropStrip(room, spec);
    }
    room.quality = roomQuality(room.type, rect);
    if (!free) {
      this.cash -= price;
      this.tallyCash('construction', price);
      this.events.emit('cashChanged', { cash: this.cash });
    }
    this.events.emit('roomChanged', { roomId });
    this.recomputePaths();
  }

  /**
   * Place one horizontal prop strip on the first legal run of tiles.
   * Props must never strand part of the room (M1 review M-8): the interior
   * must stay door-connected after placement, else revert and try the next
   * spot. Placement validation ran BEFORE the prop existed, so this is the
   * backstop that keeps the invariant stated rather than accidental.
   */
  private placePropStrip(room: Room, spec: PropSpec): void {
    // Open rooms center their prop (a help desk belongs mid-plaza, and corners
    // stay clear for through-traffic); walled rooms scan row-major as ever.
    if (ROOM_DEFS[room.type].kind === 'open') {
      const center = {
        col: room.rect.col + Math.floor((room.rect.cols - PROP_STYLE[spec.id].tiles) / 2),
        row: room.rect.row + Math.floor(room.rect.rows / 2),
      };
      if (this.tryPlaceStripAt(room, spec, center)) return;
    }
    // Walkable seats scatter checkerboard-first so a row of chairs reads as
    // chairs, not one slab; blocking props keep the plain row-major scan.
    const tiles = PROP_STYLE[spec.id].tiles;
    const passes: ((p: GridPoint) => boolean)[] =
      spec.walkable && tiles === 1
        ? [(p): boolean => (p.col + p.row) % 2 === 0, (): boolean => true]
        : [(): boolean => true];
    for (const included of passes) {
      for (let row = room.rect.row; row < room.rect.row + room.rect.rows; row++) {
        for (let col = room.rect.col; col <= room.rect.col + room.rect.cols - tiles; col++) {
          if (!included({ col, row })) continue;
          if (this.tryPlaceStripAt(room, spec, { col, row })) return;
        }
      }
    }
  }

  /** Place the strip with its west end at `origin`; revert and refuse if illegal. */
  private tryPlaceStripAt(room: Room, spec: PropSpec, origin: GridPoint): boolean {
    const strip: Tile[] = [];
    for (let i = 0; i < PROP_STYLE[spec.id].tiles; i++) {
      const p = { col: origin.col + i, row: origin.row };
      if (!rectContains(room.rect, p)) return false;
      const tile = this.tileAt(p.col, p.row)!;
      if (tile.object !== null || !tile.walkable || (room.door && samePoint(room.door.inside, p))) {
        return false;
      }
      // Never place onto a person's tile (Stage B review MAJOR 1): expansion
      // top-up runs with occupants legally inside the old footprint — a
      // blocking prop under a walker entombs them (A* rejects unwalkable
      // starts) and wedges the room forever. Byte-neutral for NEW builds:
      // their validation already guarantees an actor-free footprint.
      for (const person of [...this.patients.values(), ...this.staff.values()]) {
        if (samePoint(person.at, p) || (person.next && samePoint(person.next, p))) return false;
      }
      strip.push(tile);
    }
    for (const tile of strip) {
      tile.object = spec.id;
      if (!spec.walkable) tile.walkable = false;
    }
    if (spec.walkable || (this.roomInteriorConnected(room) && this.everySlotApproachable(room, spec))) {
      return true;
    }
    for (const tile of strip) {
      tile.object = null;
      tile.walkable = true;
    }
    return false;
  }

  /**
   * A capacity SLOT strip must have somewhere to stand beside it (ED Stage
   * B1) — the "structurally workable anchor" rule Stage 3 established for
   * repair jobs, applied to beds. Without it, a dense room packs its slot
   * props into solid rows: `roomInteriorConnected` still passes (the
   * remaining tiles are connected to each other) but the innermost beds have
   * NO walkable orthogonal neighbour, so `slotAnchorTile` silently falls
   * through to a random interior tile and the "bay" is a bed nobody can reach.
   * Refusing the placement instead keeps capacity HONEST: it derives from
   * what actually landed, so the room reports the number of usable bays.
   * Non-slot and walkable props (chairs are sat ON) are unaffected.
   */
  private everySlotApproachable(room: Room, spec: PropSpec): boolean {
    const def = ROOM_DEFS[room.type];
    const cap = def.capacity;
    if (cap.kind !== 'perProp' || cap.prop !== spec.id) return true;
    // Only rooms that anchor a RESERVATION beside the slot prop. In a
    // self-service room the patient occupies the prop itself — a restroom
    // stall is claimed and stood IN (occupancy derives from `stallClaims`,
    // never `reservationsOn`) and a waiting chair is sat ON — so "somewhere
    // to stand beside it" is meaningless there, and imposing it would rewrite
    // restroom layouts for no gain. Staffed ⇔ treated-beside, which is
    // exactly the `slotAnchorTile` consumer set.
    if (def.staffedBy.length === 0) return true;
    // EVERY strip, not just the one just placed: the check is order-dependent
    // because a later bed can consume the last walkable neighbour of an
    // earlier one. Verifying the whole set after each placement is what turns
    // a solid block of beds into a staggered, reachable ward.
    const stripLen = PROP_STYLE[spec.id].tiles;
    return this.stripOrigins(room.rect, cap.prop).every((origin) => {
      for (let i = 0; i < stripLen; i++) {
        for (const step of ORTHOGONAL_STEPS) {
          const p = { col: origin.col + i + step.col, row: origin.row + step.row };
          if (!rectContains(room.rect, p)) continue;
          if (room.door && samePoint(room.door.inside, p)) continue;
          if (this.tileAt(p.col, p.row)!.walkable) return true;
        }
      }
      return false;
    });
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
    // Geometry sweep (Stage 2, design MAJOR 4): messes inside the sold room
    // leave with it (their jobs deleted, workers released).
    for (const tile of rectTiles(room.rect)) this.removeMess(tile);
    // Stage-3 orphan rule (§5.2): the repair job targets the ROOM, not a
    // mess — it leaves with the room too, its tech released (step-out).
    for (const job of [...this.jobs.values()]) {
      if (job.roomId === roomId) {
        this.jobs.delete(job.id);
        this.releaseJobWorker(job);
        this.events.emit('jobChanged', { jobId: job.id });
      }
    }
    for (const tile of rectTiles(room.rect)) {
      const t = this.tileAt(tile.col, tile.row)!;
      t.roomId = null;
      t.object = null;
      t.walkable = true;
    }
    this.rooms.delete(roomId);
    this.checkInQueues.delete(roomId);
    // Staff posted here go idle (and stop walking to the rubble); waiting
    // patients seated here lose their seat.
    for (const s of this.staff.values()) {
      if (s.duty.kind === 'post' && s.duty.roomId === roomId) {
        s.duty = { kind: 'idle' };
        s.path = [];
        s.target = null;
      }
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
    // SSOT (audit #2): the sim's payout and the UI's button label share this.
    const sellback = sellbackAmount(room.type, room.rect); // rect-aware (Stage 0)
    this.cash += sellback;
    this.tallyCash('sellIncome', sellback);
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
    age = generateStaffAge(this.rng),
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
      shift: null, // SHIFTS Stage-1: no shift = always on (probe assigns it)
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
    this.tallyCash('hireFees', BALANCE.economy.hireFee);
    this.events.emit('cashChanged', { cash: this.cash });
  }

  private fireStaff(staffId: number): void {
    const member = this.staff.get(staffId);
    if (!member) return;
    if (member.duty.kind === 'job') {
      // Rule-7 analogue (Stage 2, §4.3): requeue the job in ANY phase —
      // staffId null, phase queued, NO hold (the job didn't fail) — then the
      // existing firing path. Without this branch the instant removeStaff
      // below would leave a dangling staffId on the job.
      const job = this.jobs.get(member.duty.jobId);
      if (job) {
        job.staffId = null;
        job.phase = 'queued';
        job.ticksRemaining = 0;
        this.events.emit('jobChanged', { jobId: job.id });
      }
      this.removeStaff(member);
      return;
    }
    if (member.duty.kind === 'reserved') {
      // ED epic Stage B1: act on the WHOLE panel, not just the witness
      // reservation. Firing a ratio nurse who holds four bays used to cancel
      // one and remove her, leaving three reservations with a `staffIds`
      // entry naming a deleted staffer — `promoteGatheredReservations` does
      // `world.staff.get(id)!` and would blow up on the next tick. At N=1 the
      // panel has one entry and this is byte-identical to the old two
      // branches. The snapshot is a fresh array, so cancelling under it is
      // safe (a cancel can never delete a DIFFERENT panel member).
      const panel = this.reservationsOfStaff(member.id);
      // Gathering is not mid-treatment (M3 ruling): cancel per Flow rule 8 —
      // patient re-queued with wait clock intact, co-staff released. No
      // corridor hint; nothing's blocked.
      for (const r of panel) {
        if (r.phase === 'gathering') this.cancelReservation(r, { hint: false });
      }
      if (panel.some((r) => r.phase === 'active')) {
        member.firing = true; // finishes what it is already treating (GDD §4)
        this.events.emit('staffUpdated', { staffId: member.id });
        return;
      }
      if (this.staff.has(member.id)) this.removeStaff(member);
      return;
    }
    this.removeStaff(member);
  }

  private removeStaff(member: Staff): void {
    this.staff.delete(member.id);
    this.events.emit('staffFired', { staffId: member.id });
  }

  // -------------------------------------------------------- patient routing

  // ------------------------------------------------- messes & jobs (Stage 2)

  /** The job targeting this tile, if any (one job per target, §4.3). */
  jobAt(tile: GridPoint): Job | null {
    for (const job of this.jobs.values()) {
      if (samePoint(job.tile, tile)) return job;
    }
    return null;
  }

  /**
   * Mint a queued job iff none targets the tile (one job per target, §4.3 —
   * the keyed check). The overflow path calls this with 'empty' BEFORE
   * addMess (FROZEN order, pre-impl MAJOR 2), so addMess's own 'clean' mint
   * then finds the empty job and stands down — no double-mint. Returns the
   * job, or null when the tile was already targeted (Stage-3 pre-impl MAJOR
   * 2a: the repair path must never treat a suppressed mint as success).
   */
  mintJob(kind: Job['kind'], tile: GridPoint, roomId: number | null = null): Job | null {
    if (this.jobAt(tile) !== null) return null;
    const job: Job = {
      id: this.takeId(),
      kind,
      tile: { col: tile.col, row: tile.row },
      roomId,
      staffId: null,
      phase: 'queued',
      ticksRemaining: 0,
      holdUntil: 0,
    };
    this.jobs.set(job.id, job);
    this.events.emit('jobChanged', { jobId: job.id });
    return job;
  }

  /** One mess per tile (a repeat refreshes `since`); mints a `clean` job iff
   *  none targets the tile; emits `messChanged`; bumps `messRevision`. */
  addMess(kind: Mess['kind'], tile: GridPoint): void {
    const key = `${tile.col},${tile.row}`;
    const existing = this.messes.get(key);
    if (existing) {
      existing.since = this.clock.tick;
    } else {
      this.messes.set(key, {
        kind,
        tile: { col: tile.col, row: tile.row },
        since: this.clock.tick,
      });
    }
    // Stage-3 code-review MAJOR 1: a REPAIR job can hold a WALKABLE anchor
    // (the scan's pass-2 tiles), and both organic mess sources drop at
    // `patient.at` — an in-room accident/vomit on the anchor would leave a
    // mess whose only cover is a job that leaves at repair completion (a
    // border-invalid world whose own save refuses to load; clean/empty
    // suppression stays NORMAL — refreshes and can-overflows rely on it).
    // Re-anchor the repair job off the tile (the scan skips job-held tiles,
    // including its own current one), releasing any worker to re-converge
    // on the new anchor — a WORKING tech left in place would violate the
    // border's worker-beside-target bound the moment the tile moved.
    const holder = this.jobAt(tile);
    if (holder?.kind === 'repair') {
      const room = holder.roomId === null ? null : (this.rooms.get(holder.roomId) ?? null);
      const next = room === null ? null : this.repairAnchorTile(room);
      if (next !== null && this.jobAt(next) === null) {
        if (holder.staffId !== null) {
          this.releaseJobWorker(holder);
          holder.phase = 'queued';
          holder.ticksRemaining = 0;
        }
        holder.tile = { col: next.col, row: next.row };
        this.events.emit('jobChanged', { jobId: holder.id });
      } else {
        console.warn(`addMess: could not re-anchor repair job ${holder.id} off ${key}`);
      }
    }
    this.mintJob('clean', tile); // no-op when ANY job already targets the tile
    this.messRevision += 1;
    this.events.emit('messChanged', { col: tile.col, row: tile.row });
  }

  /**
   * Delete the mess on `tile` + THE GENERAL ORPHAN RULE (§4.3, design MINOR
   * 12): the job targeting that tile is deleted in ANY phase, its worker
   * released (idle + the unconditional walled-room step-out). No-op when no
   * mess exists there — geometry sweeps call this over whole footprints, and
   * the empty-job completion path deletes its own job BEFORE calling in
   * (never a re-entrant delete of the completing job).
   */
  removeMess(tile: GridPoint): void {
    const key = `${tile.col},${tile.row}`;
    if (!this.messes.delete(key)) return;
    const job = this.jobAt(tile);
    if (job) {
      this.jobs.delete(job.id);
      this.releaseJobWorker(job);
      this.events.emit('jobChanged', { jobId: job.id });
    }
    this.messRevision += 1;
    this.events.emit('messChanged', { col: tile.col, row: tile.row });
  }

  /**
   * Detach a job's worker: duty idle, walk state cleared, and the
   * unconditional walled-room step-out — the `releaseReservation` clause
   * verbatim (design MAJOR 6: an EVS idling inside the restroom they just
   * mopped would pin its sale). Emits `staffUpdated`. Safe on unassigned
   * jobs and jobs whose worker is already detached.
   */
  releaseJobWorker(job: Job): void {
    const staffId = job.staffId;
    job.staffId = null;
    if (staffId === null) return;
    const member = this.staff.get(staffId);
    if (!member || member.duty.kind !== 'job' || member.duty.jobId !== job.id) return;
    member.duty = { kind: 'idle' };
    member.path = [];
    member.target = null;
    const standing = member.next ?? member.at;
    const room = this.roomAt(standing);
    if (room && ROOM_DEFS[room.type].kind !== 'open') {
      const spot = this.nearestFreeStandingTile(standing, member);
      if (spot) this.setWalkerTarget(member, spot);
    }
    this.events.emit('staffUpdated', { staffId: member.id });
  }

  // ---------------------------------------------- failures & repair (Stage 3)

  /**
   * THE wear choke point (§5.1 / impl plan §S3.1): no failure def → no-op;
   * already broken → no-op (no wear while disabled — keeps the border's
   * broken ⇒ wear 0 invariant, and a finishing restroom occupant can't
   * double-break the room). Else wear += 1 and roll the ONE derivation.
   */
  applyRoomUse(room: Room): void {
    const failure = roomFailure(room.type);
    if (!failure || room.brokenSince !== null) return;
    room.wear += 1;
    if (this.rng.chance(breakdownChance(failure.kind, room.wear))) this.breakRoom(room);
  }

  /**
   * The repair-job ANCHOR (impl plan §S3.1, pre-impl MAJOR 1): a tile is
   * eligible iff NO job targets it (MAJOR 2a — a suppressed repair mint is
   * a border-invalid world) AND it has ≥1 orthogonal neighbor that is
   * walkable + standable (same-room exception) + legally facing it across
   * the edge — a claim-FREE structural pre-check (claims are transient;
   * jobWorkTile arbitrates them at assignment). Without it, a 2×3
   * west-door restroom's stalls anchor a job no worker can ever stand
   * beside — a permanently unrepairable room on an eternal re-hold loop.
   * Scan: non-walkable prop tiles row-major (the machine), then walkable
   * non-door tiles row-major (a propless room is border-legal), then the
   * rect origin as a defensive last resort. Deterministic, rng-free, and
   * stable while broken (no expand while broken; props never move).
   */
  private repairAnchorTile(room: Room): GridPoint {
    const workable = (tile: GridPoint): boolean => {
      if (this.jobAt(tile) !== null) return false;
      for (const step of ORTHOGONAL_STEPS) {
        const n = { col: tile.col + step.col, row: tile.row + step.row };
        if (!this.isWalkable(n)) continue;
        if (!this.standableTile(n, { sameRoomAs: tile })) continue;
        if (!this.canApproach(n, tile)) continue;
        return true;
      }
      return false;
    };
    const passes: ((t: Tile, p: GridPoint) => boolean)[] = [
      (t): boolean => t.object !== null && !t.walkable,
      (t, p): boolean =>
        t.walkable && !(room.door && samePoint(room.door.inside, p)),
    ];
    for (const pass of passes) {
      for (const p of rectTiles(room.rect)) {
        const t = this.tileAt(p.col, p.row)!;
        if (pass(t, p) && workable(p)) return p;
      }
    }
    // Last resort (post-impl review MINOR 2): even here, NEVER a job-held
    // tile — a held anchor either suppresses the repair mint (a broken room
    // with no job — the MAJOR-2a border-invalid world) or double-books the
    // tile on an addMess re-anchor. Workability is best-effort at this depth.
    for (const p of rectTiles(room.rect)) {
      if (this.jobAt(p) === null) return p;
    }
    return { col: room.rect.col, row: room.rect.row }; // every tile job-held — unreachable in practice
  }

  /**
   * ED epic Stage B1 (owner ask): close or reopen a room. Closing borrows
   * `breakRoom`'s disable-never-harm contract EXACTLY — flag, then a rule-8
   * cancel of gathering reservations, while ACTIVE treatments run to
   * completion — so a close is a drain, never a patient thrown out of a bed.
   * `capacityOf` returns 0 meanwhile, which is the one line that stops new
   * dispatch. No repair job and no burst: nothing is broken.
   *
   * This is what makes a busy room expandable: `validateRoomExpand` and
   * `validateRoomSell` both reject while any reservation is live, so without
   * a way to stop the inflow the ED — the room that most needs more bays —
   * could never grow. Idempotent, and a no-op on a broken room (it is
   * already disabled; letting the two flags interleave would just complicate
   * the repair path for no gain).
   */
  setRoomClosed(roomId: number, closed: boolean): void {
    const room = this.rooms.get(roomId);
    if (!room || room.closed === closed) return;
    // The broken guard is ASYMMETRIC on purpose (post-impl review MAJOR 1).
    // Refusing to CLOSE a broken room is right — it is already disabled. But
    // refusing to REOPEN one strands the room forever: a closed room still
    // drains its actives, `applyRoomUse` still rolls wear on them, so the last
    // draining treatment can break a room that is already closed. Both flags
    // set, reopen refused, and after the repair `closed` is still true with no
    // hint (capacity needs deliberately stay silent on closed rooms) — a
    // department that silently serves nobody. Reopening is always harmless:
    // `capacityOf` returns 0 while broken regardless.
    if (closed && room.brokenSince !== null) return;
    room.closed = closed;
    if (closed) {
      for (const reservation of [...this.reservations.values()]) {
        if (reservation.roomId === room.id && reservation.phase === 'gathering') {
          // Not a layout problem — no corridor hint (Flow rule 8, hint:false).
          this.cancelReservation(reservation, { hint: false });
        }
      }
    }
    this.events.emit('roomChanged', { roomId: room.id });
  }

  /**
   * THE breakdown path (§5.2 / impl plan §S3.1) — the wear roll and
   * `debugBreakRoom` share it. FROZEN order: flag → rule-8 cancel of
   * gathering reservations (actives finish — disable, never harm) → mint
   * the repair job → piping burst → events. The mint is guaranteed by the
   * anchor scan skipping job-held tiles; a null return here is a bug, and
   * it warns loudly rather than silently bricking the save border.
   */
  breakRoom(room: Room): void {
    room.brokenSince = this.clock.tick;
    room.wear = 0;
    for (const reservation of [...this.reservations.values()]) {
      if (reservation.roomId === room.id && reservation.phase === 'gathering') {
        // Not a layout problem — no corridor hint (the breakdown announces
        // itself through the needs pipeline's instance-keyed toast).
        this.cancelReservation(reservation, { hint: false });
      }
    }
    const anchor = this.repairAnchorTile(room);
    const job = this.mintJob('repair', anchor, room.id);
    if (!job) {
      console.warn(
        `breakRoom: repair mint suppressed for room ${room.id} at ${anchor.col},${anchor.row}`,
      );
    }
    if (roomFailure(room.type)?.kind === 'piping') this.burstPipes(room);
    this.events.emit('roomBroken', { roomId: room.id });
    this.events.emit('roomChanged', { roomId: room.id });
  }

  /**
   * Piping burst (§5.4 / impl plan §S3.3): 2–4 `water` messes on rng-picked
   * candidates — walkable tiles inside the rect + orthogonally-adjacent
   * corridor/open-plan tiles (never a neighboring WALLED room's interior).
   * Tiles already holding a mess are excluded (addMess would only refresh
   * `since` — the count claim stays honest, pre-impl MINOR 5), as are
   * job-held tiles (pre-impl MAJOR 2b: water on the repair anchor would
   * outlive its suppressed clean job as a border-invalid jobless mess).
   * FROZEN rng order: count draw, then per-pick index draws WITHOUT
   * replacement; fewer candidates than count → place them all.
   */
  private burstPipes(room: Room): void {
    const candidates: GridPoint[] = [];
    const consider = (p: GridPoint): void => {
      if (!this.isWalkable(p)) return;
      if (this.messes.has(`${p.col},${p.row}`)) return;
      if (this.jobAt(p) !== null) return;
      candidates.push(p);
    };
    for (const tile of rectTiles(room.rect)) consider(tile);
    const { rect } = room;
    const ring: GridPoint[] = [];
    for (let col = rect.col; col < rect.col + rect.cols; col++) {
      ring.push({ col, row: rect.row - 1 }, { col, row: rect.row + rect.rows });
    }
    for (let row = rect.row; row < rect.row + rect.rows; row++) {
      ring.push({ col: rect.col - 1, row }, { col: rect.col + rect.cols, row });
    }
    for (const p of ring) {
      const neighborRoom = this.roomAt(p);
      if (neighborRoom !== null && ROOM_DEFS[neighborRoom.type].kind !== 'open') continue;
      consider(p);
    }
    const count = this.rng.intInRange(
      BALANCE.maintenance.burstMessesMin,
      BALANCE.maintenance.burstMessesMax,
    );
    for (let i = 0; i < count && candidates.length > 0; i++) {
      const picked = candidates.splice(this.rng.intBelow(candidates.length), 1)[0]!;
      this.addMess('water', picked);
    }
  }

  /** Mess-proximity cache (§4.2 channel 1): rebuilt only when `messRevision`
   *  moves — the auraCheckedTick pattern with messRevision as the signature
   *  (an O(1) compare, so no per-tick guard is needed on top). */
  private messNearGrid: boolean[][] = [];
  private messNearRevision = -1;

  /** Mess within BALANCE.mess.patienceRadius (Chebyshev — a square patch,
   *  like the plant aura). ONE flag per tile: "once, not per mess". */
  hasMessNear(p: GridPoint): boolean {
    if (this.messNearRevision !== this.messRevision) {
      this.messNearRevision = this.messRevision;
      this.messNearGrid = Array.from({ length: this.cols }, () =>
        Array<boolean>(this.rows).fill(false),
      );
      const radius = BALANCE.mess.patienceRadius;
      for (const mess of this.messes.values()) {
        const minCol = Math.max(0, mess.tile.col - radius);
        const maxCol = Math.min(this.cols - 1, mess.tile.col + radius);
        const minRow = Math.max(0, mess.tile.row - radius);
        const maxRow = Math.min(this.rows - 1, mess.tile.row + radius);
        for (let col = minCol; col <= maxCol; col++) {
          for (let row = minRow; row <= maxRow; row++) {
            this.messNearGrid[col]![row] = true;
          }
        }
      }
    }
    return this.messNearGrid[p.col]?.[p.row] ?? false;
  }

  /**
   * A legal standing zone (impl plan §S2.1, promoted from patientNeeds):
   * corridor/open-plan OR inside the room containing `opts.sameRoomAs`, and
   * never any room's door tile. Vending stand picks call it with NO opts
   * (corridor-only — the same-room exception cannot leak); assignJobs
   * passes `sameRoomAs: job.tile`. Claim-awareness stays at call sites.
   */
  standableTile(p: GridPoint, opts: { sameRoomAs?: GridPoint } = {}): boolean {
    const room = this.roomAt(p);
    const zoneOk =
      room === null ||
      ROOM_DEFS[room.type].kind === 'open' ||
      (opts.sameRoomAs !== undefined && this.roomAt(opts.sameRoomAs)?.id === room.id);
    if (!zoneOk) return false;
    for (const r of this.rooms.values()) {
      if (!r.door) continue;
      if (samePoint(r.door.inside, p) || samePoint(r.door.outside, p)) return false;
    }
    return true;
  }

  // ------------------------------------------------- amenities (Stage 1)

  amenityAt(col: number, row: number): Amenity | null {
    return this.amenities.get(`${col},${row}`) ?? null;
  }

  /**
   * slot → patientId, DERIVED from live needBreak claims (§3.3): a stall is
   * taken iff some live patient's needBreak references {roomId, slot}. No
   * stored reservation-like state — terminal clears release by construction.
   * Sim (claiming) and UI (inspect "Stalls 1/2" + "In use") both read this.
   */
  stallClaims(roomId: number): Map<number, number> {
    const claims = new Map<number, number>();
    for (const p of this.patients.values()) {
      const nb = p.needBreak;
      if (nb?.kind === 'restroom' && nb.roomId === roomId && nb.slot !== undefined) {
        claims.set(nb.slot, p.id);
      }
    }
    return claims;
  }

  /** Lowest unclaimed stall slot, or null when full (claim-aware — walking
   *  claimants hold their stall exactly like reservations hold beds). */
  freeStallIndex(room: Room): number | null {
    const capacity = this.capacityOf(room);
    const claims = this.stallClaims(room.id);
    for (let i = 0; i < capacity; i++) if (!claims.has(i)) return i;
    return null;
  }

  /** patientId of the live vending claim on this machine tile, or null. */
  vendingClaimedBy(tileKey: string): number | null {
    for (const p of this.patients.values()) {
      const nb = p.needBreak;
      if (nb?.kind === 'vending' && nb.tile && `${nb.tile.col},${nb.tile.row}` === tileKey) {
        return p.id;
      }
    }
    return null;
  }

  /** Validate → mutate → tally → emit `amenityPlaced` → recomputePaths (§1.7).
   *  recomputePaths is load-bearing (pre-impl MAJOR 2): movement never
   *  re-validates steps, so a precomputed path THROUGH the new machine must be
   *  repaired exactly as buildRoom does. */
  placeAmenity(kind: AmenityId, tile: GridPoint): void {
    const check = validateAmenityPlace(this, kind, tile);
    if (!check.ok) {
      this.events.emit('buildRejected', { reason: check.reason });
      return;
    }
    // Geometry sweep (Stage 2, design MAJOR 4): a mess on the tile leaves
    // before the machine lands (its job deleted, worker released).
    this.removeMess(tile);
    const t = this.tileAt(tile.col, tile.row)!;
    t.object = kind;
    t.walkable = false; // amenity props are ALWAYS non-walkable (§3.4 rule)
    this.amenities.set(`${tile.col},${tile.row}`, {
      kind,
      tile: { col: tile.col, row: tile.row },
      fill: 0,
      revenueToday: 0,
      revenueTotal: 0,
    });
    const cost = AMENITY_DEFS[kind].cost;
    this.cash -= cost;
    this.tallyCash('construction', cost); // capital bucket — dayNet stays honest
    this.events.emit('cashChanged', { cash: this.cash });
    this.events.emit('amenityPlaced', { col: tile.col, row: tile.row, kind });
    this.recomputePaths();
  }

  /** Validate → sweep live claims (abandon path) → mutate → refund → emit
   *  `amenitySold` → recomputePaths (§1.7 / §3.4 sell sweep). */
  sellAmenity(tile: GridPoint): void {
    const check = validateAmenitySell(this, tile);
    if (!check.ok) {
      this.events.emit('buildRejected', { reason: check.reason });
      return;
    }
    const key = `${tile.col},${tile.row}`;
    const amenity = this.amenities.get(key)!;
    // Selling sweeps its state (§3.4): live vending claims on THIS machine are
    // cleared via the abandon path — hold set, meter unchanged.
    for (const p of [...this.patients.values()]) {
      const nb = p.needBreak;
      if (nb?.kind === 'vending' && nb.tile && samePoint(nb.tile, tile)) {
        this.clearNeedBreak(p, { hold: true });
      }
    }
    // Stage 2 (pre-impl MAJOR 1 — the orphaned-mess rep-leak): an overflowed
    // can's `empty` job is deleted FIRST (releasing any worker), THEN
    // removeMess — the overflow litter leaves WITH the can (its contents
    // were the mess; the tile underneath is clean). Never a mess with no
    // job and no minter left behind.
    const job = this.jobAt(tile);
    if (job) {
      this.jobs.delete(job.id);
      this.releaseJobWorker(job);
      this.events.emit('jobChanged', { jobId: job.id });
    }
    this.removeMess(tile);
    const t = this.tileAt(tile.col, tile.row)!;
    t.object = null;
    t.walkable = true;
    this.amenities.delete(key);
    // SSOT: the payout and the inspect button label share amenitySellback.
    const refund = amenitySellback(amenity.kind);
    this.cash += refund;
    this.tallyCash('sellIncome', refund);
    this.events.emit('cashChanged', { cash: this.cash });
    this.events.emit('amenitySold', { col: tile.col, row: tile.row, kind: amenity.kind });
    this.recomputePaths();
  }

  /**
   * THE one abandon/clear path for need side-trips (§3.2): clears the
   * sub-state and target/path, optionally sets the retry hold, then re-spots
   * non-lost patients. Lost patients get target = null — the lost-timeout
   * semantics, NOT a retained target a later recovery would walk into a stall
   * they no longer hold (design MAJOR 1 + MINOR 10). Terminal choke points
   * call it with {hold:false}; claims are derived, so release is automatic.
   */
  clearNeedBreak(patient: Patient, opts: { hold: boolean }): void {
    if (patient.needBreak === null) return;
    patient.needBreak = null;
    if (opts.hold) {
      patient.needBreakHoldUntil =
        this.clock.tick + gameMinutesToTicks(BALANCE.needs.breakRetryGameMinutes);
    }
    patient.target = null;
    patient.path = [];
    if (patient.lost) return; // wanderers get their spot at recovery (M3 rule)
    this.assignWaitingSpot(patient);
  }

  /**
   * `opts.acuity` arrives PRE-TRIAGED (OUTPATIENT_IMPL_PLAN §3.3) — the
   * elective stream's whole mechanism. It must be set at construction rather
   * than patched afterwards, because `setPatientStage` enforces the semantic
   * invariant that `waiting` requires `acuity !== null`, and a referral has no
   * triage step to set it later. Omitted = emergency, triage rolls it.
   *
   * NOTE the draw order is unchanged either way: `acuity` is not rng-rolled
   * here, so an elective spawn consumes exactly the same draws as a walk-in.
   */
  spawnPatient(condition: ConditionId, opts: { acuity?: number } = {}): Patient {
    const patient: Patient = {
      id: this.takeId(),
      name: generateName(this.rng),
      age: generateAge(this.rng),
      condition,
      // An ELECTIVE condition is pre-triaged BY CONSTRUCTION, whatever spawned
      // it. Defaulting here rather than at the caller closes a whole class:
      // `debugSpawnPatient` (and any test fixture) would otherwise mint a
      // referral with acuity null, which `processCheckIn` then routes to
      // `waiting` — tripping the very invariant that makes the stage-table
      // widening safe. Found by live-drive; the headless suite missed it
      // because nothing else spawns an elective off-stream.
      acuity: opts.acuity ?? (conditionElective(condition) ? CONDITION_DEFS[condition].acuityMax : null),
      health: BALANCE.stats.vitalsMax,
      patience: BALANCE.stats.vitalsMax,
      wayfinding: this.rng.intInRange(BALANCE.stats.min, BALANCE.stats.max),
      lost: null,
      reportedMood: 'content',
      arrivedAtTick: this.clock.tick,
      firstTreatedAtTick: null,
      stepIndex: 0,
      billed: 0,
      stage: { kind: 'atEntrance' },
      waitingSince: null,
      dispatchHoldUntil: 0,
      waitingRoomId: null,
      // Need meters spawn part-full (§3.1/§1.5): rng-rolled in
      // [spawnMeterMin, vitalsMax] — two in-order draws on the seeded stream
      // (bladder first). Fixed-seed expectations were re-pinned with this.
      bladder: this.rng.intInRange(BALANCE.needs.spawnMeterMin, BALANCE.stats.vitalsMax),
      thirst: this.rng.intInRange(BALANCE.needs.spawnMeterMin, BALANCE.stats.vitalsMax),
      needBreak: null,
      needBreakHoldUntil: 0,
      at: { ...BALANCE.map.entrance },
      next: null,
      path: [],
      target: null,
      progress: 0,
    };
    this.patients.set(patient.id, patient);
    this.today.arrivals += 1;
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
    // Capacity = the desk slot + queueDepthTiles behind it (GDD Flow rule 1;
    // SSOT audit #5 — the dispatcher and UI share checkInCapacity()).
    const capacity = checkInCapacity();
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
      this.setPatientStage(patient, { kind: 'atEntrance' });
      // ??= so per-tick re-route attempts never reset AMA/aging timing (M2 review #8).
      patient.waitingSince ??= this.clock.tick;
      // Overflow arrivals cluster NEAR the entrance on exclusive standing
      // spots (Flow rules 1/14, audit #13) instead of stacking on the exact
      // entrance tile.
      if (!patient.target && samePoint(patient.at, BALANCE.map.entrance)) {
        const spot = this.nearestFreeStandingTile(patient.at, patient);
        if (spot && !samePoint(spot, patient.at)) this.setWalkerTarget(patient, spot);
      }
      return;
    }
    const queue = this.queueFor(best.id);
    queue.push(patient.id);
    const slot = queue.length - 1;
    this.setPatientStage(patient, { kind: 'queuedCheckIn', roomId: best.id, slot });
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
        this.setPatientStage(p, { kind: 'queuedCheckIn', roomId, slot });
        this.setWalkerTarget(p, this.queueSlotTile(room, slot));
      }
    });
  }

  /** A free chair tile if the room has one (M3 props), else any interior tile. */
  private freeSeatTile(room: Room, forPatient: Patient): GridPoint {
    const isChairAt = (p: GridPoint): boolean => {
      const tile = this.tileAt(p.col, p.row);
      return tile?.object === 'chair' && tile.walkable;
    };
    // Already on a chair here? Keep it — re-seating must not shuffle people
    // one chair over (M3 review; own claim doesn't count, Flow rule 14).
    if (
      rectContains(room.rect, forPatient.at) &&
      isChairAt(forPatient.at) &&
      !this.isTileClaimed(forPatient.at, forPatient)
    ) {
      return { ...forPatient.at };
    }
    const chairs = rectTiles(room.rect).filter(
      (p) => isChairAt(p) && !this.isTileClaimed(p, forPatient),
    );
    if (chairs.length > 0) return chairs[this.rng.intBelow(chairs.length)]!;
    return this.freeInteriorTile(room);
  }

  /** Seat the patient in a waiting room with capacity, or leave them standing. */
  assignWaitingSpot(patient: Patient): void {
    // Lost patients get no destination — they wander until recovery, which
    // calls back in for a real spot (M3 timeout/cancel ruling). Any retained
    // target is dropped: the reservation it pointed at is gone by now.
    if (patient.lost) {
      patient.waitingRoomId = null;
      patient.target = null;
      patient.path = [];
      return;
    }
    const waitingRooms = this.roomsOfType('waiting').filter((r) => r.door);
    for (const room of waitingRooms) {
      const seated = [...this.patients.values()].filter((p) => p.waitingRoomId === room.id).length;
      // Seats = the placed chairs (Stage A): a bigger waiting room finally
      // seats more people. capacityOf counts chair tiles, not a constant.
      if (seated < this.capacityOf(room)) {
        patient.waitingRoomId = room.id;
        this.setWalkerTarget(patient, this.freeSeatTile(room, patient));
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
    const before = this.reputation;
    this.reputation = Math.min(
      BALANCE.reputation.max,
      Math.max(0, this.reputation + delta),
    );
    // Report the APPLIED delta — clamping at 0/max must not skew the tally.
    this.today.repDelta += this.reputation - before;
    this.events.emit('reputationChanged', { reputation: this.reputation });
  }

  /**
   * THE cash-tally increment (FINANCE_PLAN §9.5, principle 2): today AND
   * lifetime in one call, so the finances grid's Today and Total columns can
   * never disagree. It does NOT move `world.cash` — every call site still
   * adjusts cash itself, which is exactly why it is not named `addCash`.
   */
  tallyCash(key: CashTallyKey, amount: number): void {
    this.today[key] += amount;
    this.lifetime[key] += amount;
  }

  /** All patient fees flow through here (revenue tally choke point, M4).
   *  `source` discriminates treatment billing from amenity revenue — the
   *  checklist's "treat your first patient" must not complete on a $5 soda
   *  (Stage-1 live-drive review MAJOR 1). `roomId` attributes the fee to the
   *  room that earned it (FINANCE_PLAN §4.1); an options object because a
   *  positional optional that the treatment path MUST supply isn't
   *  structural. */
  billFee(
    amount: number,
    label: string,
    opts: { source?: 'treatment' | 'vending' | 'outpatient'; roomId?: number } = {},
  ): void {
    const source = opts.source ?? 'treatment';
    this.cash += amount;
    this.tallyCash('revenue', amount);
    if (opts.roomId !== undefined) {
      const room = this.rooms.get(opts.roomId);
      if (room) {
        room.revenueToday += amount;
        room.revenueTotal += amount;
        room.visitsTotal += 1;
      }
    }
    this.events.emit('cashChanged', { cash: this.cash });
    this.events.emit('feeBilled', { amount, label, source });
  }

  /**
   * Finish a repair (dispatcher §S3.4): restore service AND charge the parts
   * cost (ECONOMY Stage-1). Extracted from the dispatcher so the charge is unit-
   * testable and there is one place the repair-completion economics live.
   */
  completeRepair(room: Room): void {
    room.brokenSince = null;
    const cost = BALANCE.economy.repairCost[room.type] ?? 0;
    if (cost > 0) {
      this.cash -= cost;
      this.tallyCash('repairs', cost);
      this.events.emit('cashChanged', { cash: this.cash });
    }
    this.events.emit('roomChanged', { roomId: room.id });
  }

  /** Emit an advisory toast at most once per key (Flow rule 5). */
  hintOnce(key: string, message: string): void {
    if (this.hintedOnce.has(key)) return;
    this.hintedOnce.add(key);
    this.events.emit('hint', { message });
  }

  /** Thought-log entry (GDD §9). Text picked by id+tick hash — no rng cost. */
  emitThought(patient: Patient, key: ThoughtKey): void {
    const options = THOUGHTS[key];
    const text = options[(patient.id + this.clock.tick) % options.length]!;
    this.events.emit('patientThought', {
      patientId: patient.id,
      name: patient.name.short,
      text,
      col: patient.at.col,
      row: patient.at.row,
    });
  }

  /**
   * Flow rule 8: a reservation whose participants cannot reach the room is
   * cancelled — resources released, patient re-queued — never a silent stall.
   */
  cancelReservation(reservation: Reservation, opts: { hint?: boolean } = {}): void {
    const patient = this.patients.get(reservation.patientId);
    this.releaseReservation(reservation);
    if (!patient) return;
    this.setPatientStage(
      patient,
      reservation.kind === 'triage' ? { kind: 'waitingTriage' } : { kind: 'waiting' },
    );
    // Flow rule 6 ruling: the wait clock survives the failed reservation.
    patient.waitingSince = reservation.patientWaitingSince ?? this.clock.tick;
    // Hot-loop guard (M3-gate review): without a hold, the dispatcher would
    // re-reserve the same doomed room next tick — reserve/cancel forever.
    patient.dispatchHoldUntil =
      this.clock.tick + gameMinutesToTicks(BALANCE.dispatcher.cancelRetryGameMinutes);
    this.assignWaitingSpot(patient);
    // The corridor hint is for layout problems only — cancellations with other
    // causes (fired staff, lost-timeout) pass hint:false (M3 rulings).
    if (opts.hint !== false) {
      this.hintOnce(
        `noPath:${patient.id}`,
        `${patient.name.short} couldn't reach the room — check your corridors`,
      );
    }
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

  /**
   * Free the room and return staff to idle (or remove them if fired mid-job).
   *
   * ED epic Stage B1: a RATIO staffer may hold several reservations in this
   * room, so releasing ONE must not free their whole panel — a death in bay 1
   * must not walk the nurse out of bays 2-4. The remaining-load branch below
   * is the whole of that fix: Flow rules 7 and 8 both funnel through here
   * (`releasePatientHoldings` scopes to the patient's one reservation, and
   * `cancelReservation` calls this), so neither needs its own change.
   */
  releaseReservation(reservation: Reservation): void {
    // Idempotence: a second call on an already-detached reservation would
    // recompute `remaining` from a panel that no longer holds it and could
    // step out a staffer who has just been legitimately re-bound. No live
    // double-release path exists today, but `fireStaff` below is the first
    // caller-controlled release ORDERING in the codebase (review MINOR).
    if (!this.reservations.delete(reservation.id)) return;
    for (const staffId of reservation.staffIds) {
      const member = this.staff.get(staffId);
      if (!member) continue;
      const remaining = this.reservationsOfStaff(member.id);
      if (remaining.length > 0) {
        // Re-point the witness and leave them standing: `duty` is no longer
        // "the reservation I hold" but "A reservation I hold". Prefer an
        // ACTIVE one — the lowest id is the OLDEST, hence the likeliest to be
        // stale-gathering while another is under way, which is exactly what
        // made the inspect card read "Walking to a patient" at a nurse who
        // was standing still mid-treatment. Firing is deferred to the LAST
        // release; `availableStaff` excludes `firing`, so the panel drains
        // and takes no new patients meanwhile.
        member.duty = {
          kind: 'reserved',
          reservationId: (remaining.find((r) => r.phase === 'active') ?? remaining[0]!).id,
        };
        this.events.emit('staffUpdated', { staffId: member.id });
        continue;
      }
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
    this.clearNeedBreak(patient, { hold: false }); // rule-7 analogue (§3.2)
    this.releasePatientHoldings(patient);
    this.setPatientStage(patient, { kind: 'dead', since: this.clock.tick });
    patient.lost = null;
    patient.next = null;
    patient.path = [];
    patient.target = null;
    this.today.died += 1;
    this.lifetimeDied += 1;
    this.applyReputation(-BALANCE.reputation.deathLoss);
    this.events.emit('patientDied', {
      patientId: patient.id,
      name: patient.name.full,
      condition: CONDITION_DEFS[patient.condition].label,
      col: patient.at.col,
      row: patient.at.row,
    });
  }

  patientLeavesAma(patient: Patient): void {
    this.clearNeedBreak(patient, { hold: false }); // rule-7 analogue (§3.2)
    this.releasePatientHoldings(patient);
    this.setPatientStage(patient, { kind: 'leaving', reason: 'ama' });
    patient.lost = null; // exits clear lostness (M3-gate ruling)
    this.today.leftAma += 1;
    if (conditionElective(patient.condition)) this.today.electiveNoShow += 1;
    // An elective no-show is not an abandoned emergency
    // (OUTPATIENT_IMPL_PLAN §3.6). Flat `amaLoss` against the +2 an elective
    // discharge earns puts break-even at a 20% walkout rate, and the measured
    // baseline is ~25% with electives sorting LAST — so the stream would have
    // been reputation-NEGATIVE in expectation, silently.
    this.applyReputation(
      -(conditionElective(patient.condition)
        ? BALANCE.reputation.electiveNoShowLoss
        : BALANCE.reputation.amaLoss),
    );
    this.setWalkerTarget(patient, BALANCE.map.entrance);
    this.events.emit('patientLeftAma', {
      patientId: patient.id,
      name: patient.name.full,
      col: patient.at.col,
      row: patient.at.row,
    });
  }

  dischargePatient(patient: Patient, totalBilled: number): void {
    this.clearNeedBreak(patient, { hold: false }); // rule-7 analogue (§3.2)
    this.releasePatientHoldings(patient);
    this.setPatientStage(patient, { kind: 'leaving', reason: 'discharged' });
    patient.lost = null; // exits clear lostness (M3-gate ruling)
    this.today.treated += 1;
    // Subset counter, not an addition: the daily report needs to separate a
    // clinic that pays for itself from one that does not (§3.7).
    if (conditionElective(patient.condition)) this.today.electiveTreated += 1;
    this.lifetimeTreated += 1;
    this.applyReputation(dischargeReputationGain(patient.acuity ?? BALANCE.decay.untriagedAcuity));
    this.setWalkerTarget(patient, BALANCE.map.entrance);
    this.emitThought(patient, 'discharged');
    this.events.emit('patientDischarged', {
      patientId: patient.id,
      name: patient.name.full,
      totalBilled,
      col: patient.at.col,
      row: patient.at.row,
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
      // KNOWN divergence (Stage-3 post-impl review NIT): the wear hook lives
      // in updateTreatment, so a debug-forced complication adds NO wear —
      // adding it here would shift debug rng draws for no test value.
      resolveTreatmentOutcome(this, this.reservations.get(patient.stage.reservationId)!, false);
    } else {
      patient.health -= BALANCE.treatment.complicationHealthPenalty;
      if (patient.health <= 0) {
        patient.health = 0;
        this.killPatient(patient);
      } else {
        this.emitThought(patient, 'complication');
        this.events.emit('patientComplication', {
          patientId: patient.id,
          name: patient.name.full,
          col: patient.at.col,
          row: patient.at.row,
        });
      }
    }
  }

  // --------------------------------------------------------------- walkers

  setWalkerTarget(walker: Walker, goal: GridPoint): void {
    const start = walker.next ?? walker.at;
    const path = findPath(this, start, goal, walker.id);
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
      // A lost patient's retained target is a RECOVERY destination, not an
      // active walk (M3 review) — re-pathing it would march the "wanderer"
      // in a beeline while ❓-lost, or null the target on A* failure.
      if (patient.lost) continue;
      if (patient.target) this.setWalkerTarget(patient, patient.target);
    }
    for (const member of this.staff.values()) {
      if (member.target) this.setWalkerTarget(member, member.target);
    }
  }

  // -------------------------------------------------------------------- tick

  /** One fixed-timestep sim step. System order per tech plan §2.1. */
  tick(): void {
    if (this.gameOver) return; // terminal state (M4): the world is frozen
    this.clock.advance();
    updateSpawn(this);
    updateDecay(this);
    updateThoughts(this);
    updatePatientNeeds(this); // side-trips BEFORE dispatch (plan §1.9 order)
    updateDispatcher(this);
    updateWayfinding(this);
    updateMovement(this);
    updateTreatment(this);
    updateMess(this); // Stage 2 (§4 / design §7 order): after treatment, before economy
    updateEconomy(this);
    // Movement may have delivered a posted greeter this tick — invalidate the
    // aura cache so post-tick queries (render overlay, next tick's systems)
    // see arrivals immediately (M3 review: at most 2 rechecks per tick).
    this.auraCheckedTick = -1;
    this.checkBankruptcy();
    if (!this.gameOver && this.clock.isMidnight) this.closeDay();
  }

  /**
   * Bankruptcy lose-state (GDD §2, M4): cash strictly below the threshold for
   * a full uninterrupted game day loses. Climbing back above resets the clock.
   */
  private checkBankruptcy(): void {
    if (this.cash >= BALANCE.economy.bankruptcyThreshold) {
      this.bankruptSinceTick = null;
      return;
    }
    if (this.bankruptSinceTick === null) {
      this.bankruptSinceTick = this.clock.tick;
      const t = BALANCE.economy.bankruptcyThreshold;
      const label = `${t < 0 ? '−' : ''}$${Math.abs(t).toLocaleString('en-US')}`;
      this.events.emit('hint', {
        message: `Deep in debt — climb above ${label} within a day or the bank forecloses`,
      });
    }
    const graceTicks = gameMinutesToTicks(BALANCE.economy.bankruptcyGraceGameMinutes);
    if (this.clock.tick - this.bankruptSinceTick < graceTicks) return;
    this.gameOver = true;
    this.events.emit('gameOver', {
      // The day that actually elapsed. At a midnight tick `clock.day` has
      // already rolled to the next day, so report the day that just closed —
      // otherwise "lasted N days" / the DNF "busted day N" over-count by one
      // (final review, finding 1b). A bust can only fire well after grace, so
      // this is never day 0.
      day: this.clock.isMidnight ? this.clock.day - 1 : this.clock.day,
      cash: this.cash,
      reputation: this.reputation,
      treated: this.lifetimeTreated,
      died: this.lifetimeDied,
    });
  }

  /**
   * Midnight close. FROZEN order (M4 + FINANCE_PLAN §9.5): wait bonus →
   * cleanliness rep → build the report snapshot → push a COPY to `history`
   * and trim → reset every `room.revenueToday` → reset `today` → emit
   * `dayEnded`. Both resets precede the emit deliberately: the `dayEnded`
   * autosave must persist a CONSISTENT new-day state (`today` zeroed ⇔ every
   * `revenueToday` zeroed), so a reload can never show phantom earnings. No
   * `dayEnded` consumer may read `room.revenueToday` — pinned by a test.
   * Pushing history BEFORE the emit is likewise deliberate: the autosave
   * captures the entry that just closed.
   */
  private closeDay(): void {
    const avgWaitGameMinutes =
      this.today.waitCount === 0
        ? null
        : ticksToGameMinutes(this.today.waitSumTicks / this.today.waitCount);
    // No first-treatments today ⇒ no bonus (an empty hospital isn't "fast").
    const waitBonusAwarded =
      avgWaitGameMinutes !== null &&
      avgWaitGameMinutes < BALANCE.reputation.dayCloseWaitThresholdGameMinutes;
    if (waitBonusAwarded) this.applyReputation(BALANCE.reputation.dayCloseWaitBonus);
    // Cleanliness reputation (Stage 2, §4.2): the ONE formula — the daily
    // report row reads the same derivation. Beside the wait bonus, BEFORE
    // the snapshot (closeDay order is load-bearing): the delta must land
    // inside repDelta AND the report.
    this.applyReputation(cleanlinessRepDelta(this.today.messTicks, this.today.arrivals));
    const report: DayReport = {
      ...this.today,
      day: this.clock.day - 1,
      cash: this.cash,
      reputation: this.reputation,
      avgWaitGameMinutes,
      waitBonusAwarded,
    };
    // A COPY: the emitted payload must never alias stored history, or a
    // consumer that mutates what it was handed rewrites the past.
    this.history.push({ ...report });
    // Trim from the FRONT — oldest out, newest kept (the same end the
    // load-time trim keeps, §9.7).
    while (this.history.length > BALANCE.finance.historyCapDays) this.history.shift();
    for (const room of this.rooms.values()) room.revenueToday = 0;
    // Machines reset in the SAME step as rooms — one "earned today" epoch, so
    // no surface can mix a fresh room figure with a stale machine one.
    for (const amenity of this.amenities.values()) amenity.revenueToday = 0;
    this.today = emptyDayTally();
    this.events.emit('dayEnded', report);
  }
}
