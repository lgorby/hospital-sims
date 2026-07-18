import type { EventBus } from '../events';
import { gameMinutesToTicks } from './clock';
import { emptyDayTally, type DayTally } from './dailyStats';
import { AMENITY_IDS, type AmenityId } from './data/amenities';
import { BALANCE } from './data/balance';
import { CONDITION_IDS, type ConditionId } from './data/conditions';
import type { PersonName } from './data/names';
import { ROLE_IDS, type RoleId } from './data/roles';
import { PROP_STYLE, ROOM_DEFS, ROOM_TYPES, type PropId, type RoomType } from './data/rooms';
import type { NeedBreak, Patient, PatientStage } from './entities/patient';
import type { Room } from './entities/room';
import type { Candidate, Job, Reservation, Staff, StaffDuty } from './entities/staff';
import { treatmentDurationTicks } from './formulas';
import type { GridPoint, Rect } from './types';
import { World, type Mess, type Tile } from './world';

/**
 * Phase-1 save/load (docs/PERSISTENCE_PLAN.md): one versioned JSON snapshot of
 * the full World. Snapshot, not replay — the save IS the state. Every field is
 * written deliberately (explicit per-entity serializers, plan rule 3) so
 * `SAVE_VERSION` can be migrated deliberately later.
 */
export const SAVE_VERSION = 5;

/**
 * THE version-acceptance policy (SSOT audit #8): loadWorld's gate and the UI's
 * import pre-check both call this, so they can never disagree about which save
 * files are loadable. Widen here (not at call sites) when a migration lands.
 *
 * v1 → v2 migration ruling (Expansion 1, PERSISTENCE_PLAN rule 6): v2 added
 * rooms/roles/conditions/props — new enum VALUES in the tables, no field
 * changed shape or meaning. Every v1 id still exists in the v2 tables, so a
 * v1 payload VALIDATES against the current tables unchanged (forward-
 * compatible by construction). ONE restore-time transform is required all the
 * same: the hiring pool is minted at construction and replenished only
 * like-for-like, so restoreInto tops up candidates for roles the save
 * predates (sonographer/surgeon) — a no-op for complete (v2) pools.
 *
 * v2 → v3 (capacity epic Stage A, CAPACITY_PLAN §5): reservations gain
 * `slotIndex` (which capacity slot a reservation holds). Migration is a
 * read-time default: pre-v3 saves lack the field and restore `slotIndex: 0`,
 * which is exactly right — a pre-Stage-A room could hold at most ONE
 * reservation, and every legacy room's slot 0 exists. A re-save stamps v3.
 *
 * v3 → v4 (amenities epic Stage 1, AMENITIES_PLAN §3.5): patients gain
 * `bladder`/`thirst`/`needBreak`/`needBreakHoldUntil`; the world gains
 * `amenities` (roomless props — trashcan/vending/plant, `fill` a Stage-2
 * field shipped at 0); `today` gains `vendingRevenue`. Migration is read-time
 * defaults: pre-v4 patients restore full meters (stats.vitalsMax) and no
 * break, amenities restore empty, and `readTally` defaults `vendingRevenue`
 * to 0 (version-aware — its shape check would otherwise refuse every old
 * save, review MAJOR 3). An old save plays identically until meters cross
 * thresholds.
 *
 * v4 → v5 (amenities epic Stage 2, AMENITIES_PLAN §4.5): the world gains
 * `messes` + `jobs`; staff duty gains the `job` kind; `today` gains
 * `messTicks` (TALLY_KEY_VERSIONS). Migration is read-time defaults: pre-v5
 * saves restore empty mess/job maps and messTicks 0. NOTE (§S2.6b): v5 also
 * added the `evs` ROLE, so `topUpCandidates` mints evs candidates on every
 * v≤4 load — deliberate stream divergence, the v1→v2 sonographer precedent.
 * Anything below 1 or above SAVE_VERSION is refused.
 */
export function isLoadableVersion(version: number): boolean {
  return version >= 1 && version <= SAVE_VERSION;
}

// --------------------------------------------------------------- saved shapes

/**
 * The Saved* interfaces mirror the runtime entity shapes ON PURPOSE as
 * separate declarations (not re-exports): adding a field to an ENTITY breaks
 * compilation here (writePatient/readPatient and friends must return complete
 * objects), forcing a deliberate schema decision (plan rule 3). NOTE this
 * guarantee does NOT extend to new World-LEVEL mutable fields — nothing forces
 * those into the snapshot. Adding one is a manual checklist (see Phase 1 in
 * docs/PERSISTENCE_PLAN.md): SaveData field + serializeWorld + validate/restore
 * in loadWorld + SAVE_VERSION bump.
 */
export interface SavedPoint {
  col: number;
  row: number;
}

export interface SavedRect {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

export interface SavedName {
  first: string;
  last: string;
  full: string;
  short: string;
}

export type SavedPatientStage =
  | { kind: 'atEntrance' }
  | { kind: 'queuedCheckIn'; roomId: number; slot: number }
  | { kind: 'checkingIn'; roomId: number; ticksRemaining: number }
  | { kind: 'waitingTriage' }
  | { kind: 'waiting' }
  | { kind: 'reserved'; reservationId: number }
  | { kind: 'leaving'; reason: 'discharged' | 'ama' }
  | { kind: 'dead'; since: number };

/** v4 (amenities Stage 1): the need side-trip sub-state. Restroom claims
 *  carry roomId+slot; vending claims carry the machine tile. */
export interface SavedNeedBreak {
  kind: 'restroom' | 'vending';
  roomId?: number;
  slot?: number;
  tile?: SavedPoint;
  phase: 'walking' | 'using';
  ticksRemaining: number;
  startedAt: number;
}

export interface SavedPatient {
  id: number;
  name: SavedName;
  age: number;
  condition: ConditionId;
  acuity: number | null;
  health: number;
  patience: number;
  wayfinding: number;
  lost: { since: number } | null;
  reportedMood: 'content' | 'impatient' | 'critical';
  arrivedAtTick: number;
  firstTreatedAtTick: number | null;
  stepIndex: number;
  billed: number;
  stage: SavedPatientStage;
  waitingSince: number | null;
  dispatchHoldUntil: number;
  waitingRoomId: number | null;
  /** v4 (amenities Stage 1): need meters + side-trip. Pre-v4 defaults:
   *  meters `stats.vitalsMax` (normative, not a literal), break null, hold 0. */
  bladder: number;
  thirst: number;
  needBreak: SavedNeedBreak | null;
  needBreakHoldUntil: number;
  // In-flight walker state — paths are saved, never recomputed on load.
  at: SavedPoint;
  next: SavedPoint | null;
  path: SavedPoint[];
  target: SavedPoint | null;
  progress: number;
}

export type SavedStaffDuty =
  | { kind: 'idle' }
  | { kind: 'post'; roomId: number }
  | { kind: 'reserved'; reservationId: number }
  /** v5 (amenities Stage 2): bound to a facility job. */
  | { kind: 'job'; jobId: number };

export interface SavedStaff {
  id: number;
  name: SavedName;
  age: number;
  role: RoleId;
  skill: number;
  salaryPerDay: number;
  duty: SavedStaffDuty;
  firing: boolean;
  at: SavedPoint;
  next: SavedPoint | null;
  path: SavedPoint[];
  target: SavedPoint | null;
  progress: number;
}

export interface SavedRoom {
  id: number;
  type: RoomType;
  rect: SavedRect;
  door: { inside: SavedPoint; outside: SavedPoint } | null;
  quality: number;
}

export interface SavedReservation {
  id: number;
  kind: 'triage' | 'treatment';
  patientId: number;
  roomId: number;
  staffIds: number[];
  stepIndex: number;
  /** v3 (Stage A): the capacity slot held. Pre-v3 saves restore 0. */
  slotIndex: number;
  phase: 'gathering' | 'active';
  ticksRemaining: number;
  patientWaitingSince: number | null;
}

/** v4 (amenities Stage 1): a freestanding roomless prop. `fill` is Stage-2
 *  surface (trashcan contents), always 0 in Stage 1 — shipped now so Stage 2
 *  needs no map migration. */
export interface SavedAmenity {
  kind: AmenityId;
  tile: SavedPoint;
  fill: number;
}

/** v5 (amenities Stage 2, §4.5): a floor mess — a walkable decal, keyed by
 *  its tile at runtime (serialized as an array like everything else). */
export interface SavedMess {
  kind: 'vomit' | 'litter' | 'water';
  tile: SavedPoint;
  since: number;
}

/** v5 (amenities Stage 2, §4.5): a facility job. `repair` is a reserved
 *  union value with NO legal v5 target — the border REJECTS it (a
 *  shape-valid repair job would sit queued forever, pre-impl MINOR 10). */
export interface SavedJob {
  id: number;
  kind: 'clean' | 'empty' | 'repair';
  tile: SavedPoint;
  staffId: number | null;
  phase: 'queued' | 'assigned' | 'working';
  ticksRemaining: number;
  holdUntil: number;
}

export interface SavedCandidate {
  id: number;
  role: RoleId;
  name: SavedName;
  age: number;
  skill: number;
  salaryPerDay: number;
}

/**
 * The on-disk shape. Entity payloads are declared explicitly (not `Patient`
 * etc. re-exports) so a future entity-field addition forces a deliberate
 * decision here — that's the point of plan rule 3.
 */
export interface SaveData {
  /** Bump on ANY schema change; the loader refuses newer versions. */
  saveVersion: number;
  /** Display/bookkeeping only — state is authoritative. */
  seed: number;
  /** SeededRng internal state — MUST round-trip (plan rule 2). */
  rngState: number;
  tick: number;
  cash: number;
  reputation: number;
  today: DayTally;
  lifetimeTreated: number;
  lifetimeDied: number;
  bankruptSinceTick: number | null;
  gameOver: boolean;
  /** One-shot hint keys already shown — saved so loads don't replay hints. */
  hintedOnce: string[];
  /** Per-tile walkable/roomId/object/marker, run-length encoded. */
  grid: string;
  rooms: SavedRoom[];
  /** v4: FROZEN position — immediately after rooms (impl plan §1.12; the
   *  byte-identity fixtures pin serializer insertion order forever). */
  amenities: SavedAmenity[];
  /** v5: FROZEN positions — messes then jobs, immediately after amenities
   *  (impl plan §S2.4; same byte-identity pinning). */
  messes: SavedMess[];
  jobs: SavedJob[];
  patients: SavedPatient[];
  staff: SavedStaff[];
  candidates: SavedCandidate[];
  reservations: SavedReservation[];
  /** receptionRoomId → ordered patientIds. */
  checkInQueues: [number, number[]][];
  nextEntityId: number;
}

export type LoadResult = { ok: true; world: World } | { ok: false; reason: string };

// ------------------------------------------------------- validation primitives

/** Malformed-save marker: loadWorld turns any of these into `{ ok: false }`. */
class SaveFormatError extends Error {}

function fail(label: string, expected: string): never {
  throw new SaveFormatError(`${label}: expected ${expected}`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(label, 'an object');
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(label, 'an array');
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(label, 'a finite number');
  return value;
}

function asInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(label, 'an integer');
  return value;
}

function asBool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(label, 'a boolean');
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(label, 'a string');
  return value;
}

function asNumberOrNull(value: unknown, label: string): number | null {
  return value === null ? null : asNumber(value, label);
}

function asIntOrNull(value: unknown, label: string): number | null {
  return value === null ? null : asInt(value, label);
}

function asOneOf<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) {
    fail(label, `one of [${options.join(', ')}]`);
  }
  return value as T;
}

// -------------------------------------------------------- point/name plumbing

function writePoint(p: GridPoint): SavedPoint {
  return { col: p.col, row: p.row };
}

function writePointOrNull(p: GridPoint | null): SavedPoint | null {
  return p === null ? null : writePoint(p);
}

function readPoint(value: unknown, label: string): GridPoint {
  const o = asRecord(value, label);
  return { col: asInt(o.col, `${label}.col`), row: asInt(o.row, `${label}.row`) };
}

function readPointOrNull(value: unknown, label: string): GridPoint | null {
  return value === null ? null : readPoint(value, label);
}

function readPath(value: unknown, label: string): GridPoint[] {
  return asArray(value, label).map((p, i) => readPoint(p, `${label}[${i}]`));
}

function writeRect(rect: Rect): SavedRect {
  return { col: rect.col, row: rect.row, cols: rect.cols, rows: rect.rows };
}

function readRect(value: unknown, label: string): Rect {
  const o = asRecord(value, label);
  return {
    col: asInt(o.col, `${label}.col`),
    row: asInt(o.row, `${label}.row`),
    cols: asInt(o.cols, `${label}.cols`),
    rows: asInt(o.rows, `${label}.rows`),
  };
}

function writeName(name: PersonName): SavedName {
  return { first: name.first, last: name.last, full: name.full, short: name.short };
}

function readName(value: unknown, label: string): PersonName {
  const o = asRecord(value, label);
  return {
    first: asString(o.first, `${label}.first`),
    last: asString(o.last, `${label}.last`),
    full: asString(o.full, `${label}.full`),
    short: asString(o.short, `${label}.short`),
  };
}

// ------------------------------------------------------------------ DayTally

/** Key list from the SSOT factory — a new tally field is auto-carried and auto-validated. */
const TALLY_KEYS = Object.keys(emptyDayTally()) as (keyof DayTally)[];

/**
 * Tally keys introduced AFTER v1, keyed by the SAVE_VERSION that added them
 * (review MAJOR 3): `readTally` throws on any missing key, so without this a
 * new tally field would refuse every older save. Loading a save older than a
 * key's version defaults it to the factory 0; same-or-newer saves must carry
 * it. Unlisted keys are v1 (always required).
 */
const TALLY_KEY_VERSIONS: Partial<Record<keyof DayTally, number>> = {
  vendingRevenue: 4,
  messTicks: 5,
};

function writeTally(tally: DayTally): DayTally {
  const copy = emptyDayTally();
  for (const key of TALLY_KEYS) copy[key] = tally[key];
  return copy;
}

function readTally(value: unknown, label: string, saveVersion: number): DayTally {
  const o = asRecord(value, label);
  const copy = emptyDayTally(); // factory zeroes are the version defaults
  for (const key of TALLY_KEYS) {
    if (saveVersion < (TALLY_KEY_VERSIONS[key] ?? 1)) continue;
    copy[key] = asNumber(o[key], `${label}.${key}`);
  }
  return copy;
}

// ------------------------------------------------------------------- patients

function writePatientStage(stage: PatientStage): SavedPatientStage {
  switch (stage.kind) {
    case 'atEntrance':
    case 'waitingTriage':
    case 'waiting':
      return { kind: stage.kind };
    case 'queuedCheckIn':
      return { kind: 'queuedCheckIn', roomId: stage.roomId, slot: stage.slot };
    case 'checkingIn':
      return { kind: 'checkingIn', roomId: stage.roomId, ticksRemaining: stage.ticksRemaining };
    case 'reserved':
      return { kind: 'reserved', reservationId: stage.reservationId };
    case 'leaving':
      return { kind: 'leaving', reason: stage.reason };
    case 'dead':
      return { kind: 'dead', since: stage.since };
  }
}

function readPatientStage(value: unknown, label: string): PatientStage {
  const o = asRecord(value, label);
  const kind = asString(o.kind, `${label}.kind`);
  switch (kind) {
    case 'atEntrance':
    case 'waitingTriage':
    case 'waiting':
      return { kind };
    case 'queuedCheckIn':
      return {
        kind,
        roomId: asInt(o.roomId, `${label}.roomId`),
        slot: asInt(o.slot, `${label}.slot`),
      };
    case 'checkingIn':
      return {
        kind,
        roomId: asInt(o.roomId, `${label}.roomId`),
        ticksRemaining: asNumber(o.ticksRemaining, `${label}.ticksRemaining`),
      };
    case 'reserved':
      return { kind, reservationId: asInt(o.reservationId, `${label}.reservationId`) };
    case 'leaving':
      return { kind, reason: asOneOf(o.reason, ['discharged', 'ama'], `${label}.reason`) };
    case 'dead':
      return { kind, since: asNumber(o.since, `${label}.since`) };
    default:
      return fail(`${label}.kind`, 'a known patient stage kind');
  }
}

function writeNeedBreak(nb: NeedBreak): SavedNeedBreak {
  // Kind-shaped: restroom claims write roomId+slot, vending claims write the
  // machine tile — fixed key order per kind (byte-identity depends on it).
  return {
    kind: nb.kind,
    ...(nb.roomId !== undefined ? { roomId: nb.roomId } : {}),
    ...(nb.slot !== undefined ? { slot: nb.slot } : {}),
    ...(nb.tile !== undefined ? { tile: writePoint(nb.tile) } : {}),
    phase: nb.phase,
    ticksRemaining: nb.ticksRemaining,
    startedAt: nb.startedAt,
  };
}

function readNeedBreak(value: unknown, label: string): NeedBreak {
  const o = asRecord(value, label);
  const kind = asOneOf(o.kind, ['restroom', 'vending'], `${label}.kind`);
  // Bounded (code review NIT): a hostile `using` timer beyond the longest
  // legal use duration would hide the patient from the dispatcher with
  // patience paused until health death. Untrusted input dies at the border.
  const maxUseTicks = gameMinutesToTicks(
    Math.max(BALANCE.needs.restroomUseGameMinutes, BALANCE.needs.vendingUseGameMinutes),
  );
  const ticksRemaining = asNumber(o.ticksRemaining, `${label}.ticksRemaining`);
  if (ticksRemaining < 0 || ticksRemaining > maxUseTicks) {
    fail(`${label}.ticksRemaining`, `a use timer within [0, ${maxUseTicks}] ticks`);
  }
  const shared = {
    phase: asOneOf(o.phase, ['walking', 'using'], `${label}.phase`),
    ticksRemaining,
    startedAt: asNumber(o.startedAt, `${label}.startedAt`),
  };
  // Shape is kind-strict: a restroom claim NEEDS roomId+slot (a vending claim
  // a tile) or the sim would deref undefined; extraneous fields are dropped.
  if (kind === 'restroom') {
    return {
      kind,
      roomId: asInt(o.roomId, `${label}.roomId`),
      slot: asInt(o.slot, `${label}.slot`),
      ...shared,
    };
  }
  return { kind, tile: readPoint(o.tile, `${label}.tile`), ...shared };
}

function writePatient(p: Patient): SavedPatient {
  return {
    id: p.id,
    name: writeName(p.name),
    age: p.age,
    condition: p.condition,
    acuity: p.acuity,
    health: p.health,
    patience: p.patience,
    wayfinding: p.wayfinding,
    lost: p.lost === null ? null : { since: p.lost.since },
    reportedMood: p.reportedMood,
    arrivedAtTick: p.arrivedAtTick,
    firstTreatedAtTick: p.firstTreatedAtTick,
    stepIndex: p.stepIndex,
    billed: p.billed,
    stage: writePatientStage(p.stage),
    waitingSince: p.waitingSince,
    dispatchHoldUntil: p.dispatchHoldUntil,
    waitingRoomId: p.waitingRoomId,
    bladder: p.bladder,
    thirst: p.thirst,
    needBreak: p.needBreak === null ? null : writeNeedBreak(p.needBreak),
    needBreakHoldUntil: p.needBreakHoldUntil,
    at: writePoint(p.at),
    next: writePointOrNull(p.next),
    path: p.path.map(writePoint),
    target: writePointOrNull(p.target),
    progress: p.progress,
  };
}

function readPatient(value: unknown, label: string, saveVersion: number): Patient {
  const o = asRecord(value, label);
  const lost = o.lost === null ? null : asRecord(o.lost, `${label}.lost`);
  const V4 = 4; // amenities Stage 1 — meters + side-trips (§3.5)
  return {
    id: asInt(o.id, `${label}.id`),
    name: readName(o.name, `${label}.name`),
    age: asNumber(o.age, `${label}.age`),
    condition: asOneOf(o.condition, CONDITION_IDS, `${label}.condition`),
    acuity: asNumberOrNull(o.acuity, `${label}.acuity`),
    health: asNumber(o.health, `${label}.health`),
    patience: asNumber(o.patience, `${label}.patience`),
    wayfinding: asNumber(o.wayfinding, `${label}.wayfinding`),
    lost: lost === null ? null : { since: asNumber(lost.since, `${label}.lost.since`) },
    reportedMood: asOneOf(
      o.reportedMood,
      ['content', 'impatient', 'critical'],
      `${label}.reportedMood`,
    ),
    arrivedAtTick: asNumber(o.arrivedAtTick, `${label}.arrivedAtTick`),
    firstTreatedAtTick: asNumberOrNull(o.firstTreatedAtTick, `${label}.firstTreatedAtTick`),
    stepIndex: asInt(o.stepIndex, `${label}.stepIndex`),
    billed: asNumber(o.billed, `${label}.billed`),
    stage: readPatientStage(o.stage, `${label}.stage`),
    waitingSince: asNumberOrNull(o.waitingSince, `${label}.waitingSince`),
    dispatchHoldUntil: asNumber(o.dispatchHoldUntil, `${label}.dispatchHoldUntil`),
    waitingRoomId: asIntOrNull(o.waitingRoomId, `${label}.waitingRoomId`),
    // v3→v4 migration (the readReservation slotIndex precedent): pre-v4
    // patients restore FULL meters (normative vitalsMax, not a literal 100),
    // no break, no hold — an old save plays identically until meters cross
    // thresholds (AMENITIES_PLAN §3.5 compat statement).
    bladder: saveVersion < V4 ? BALANCE.stats.vitalsMax : asNumber(o.bladder, `${label}.bladder`),
    thirst: saveVersion < V4 ? BALANCE.stats.vitalsMax : asNumber(o.thirst, `${label}.thirst`),
    needBreak:
      saveVersion < V4 || o.needBreak === null
        ? null
        : readNeedBreak(o.needBreak, `${label}.needBreak`),
    needBreakHoldUntil:
      saveVersion < V4 ? 0 : asNumber(o.needBreakHoldUntil, `${label}.needBreakHoldUntil`),
    at: readPoint(o.at, `${label}.at`),
    next: readPointOrNull(o.next, `${label}.next`),
    path: readPath(o.path, `${label}.path`),
    target: readPointOrNull(o.target, `${label}.target`),
    progress: asNumber(o.progress, `${label}.progress`),
  };
}

// ---------------------------------------------------------------------- staff

function writeStaffDuty(duty: StaffDuty): SavedStaffDuty {
  switch (duty.kind) {
    case 'idle':
      return { kind: 'idle' };
    case 'post':
      return { kind: 'post', roomId: duty.roomId };
    case 'reserved':
      return { kind: 'reserved', reservationId: duty.reservationId };
    case 'job':
      return { kind: 'job', jobId: duty.jobId };
  }
}

function readStaffDuty(value: unknown, label: string): StaffDuty {
  const o = asRecord(value, label);
  const kind = asString(o.kind, `${label}.kind`);
  switch (kind) {
    case 'idle':
      return { kind };
    case 'post':
      return { kind, roomId: asInt(o.roomId, `${label}.roomId`) };
    case 'reserved':
      return { kind, reservationId: asInt(o.reservationId, `${label}.reservationId`) };
    case 'job':
      return { kind, jobId: asInt(o.jobId, `${label}.jobId`) };
    default:
      return fail(`${label}.kind`, 'a known staff duty kind');
  }
}

function writeStaff(s: Staff): SavedStaff {
  return {
    id: s.id,
    name: writeName(s.name),
    age: s.age,
    role: s.role,
    skill: s.skill,
    salaryPerDay: s.salaryPerDay,
    duty: writeStaffDuty(s.duty),
    firing: s.firing,
    at: writePoint(s.at),
    next: writePointOrNull(s.next),
    path: s.path.map(writePoint),
    target: writePointOrNull(s.target),
    progress: s.progress,
  };
}

function readStaff(value: unknown, label: string): Staff {
  const o = asRecord(value, label);
  return {
    id: asInt(o.id, `${label}.id`),
    name: readName(o.name, `${label}.name`),
    age: asNumber(o.age, `${label}.age`),
    role: asOneOf(o.role, ROLE_IDS, `${label}.role`),
    skill: asNumber(o.skill, `${label}.skill`),
    salaryPerDay: asNumber(o.salaryPerDay, `${label}.salaryPerDay`),
    duty: readStaffDuty(o.duty, `${label}.duty`),
    firing: asBool(o.firing, `${label}.firing`),
    at: readPoint(o.at, `${label}.at`),
    next: readPointOrNull(o.next, `${label}.next`),
    path: readPath(o.path, `${label}.path`),
    target: readPointOrNull(o.target, `${label}.target`),
    progress: asNumber(o.progress, `${label}.progress`),
  };
}

// ---------------------------------------------------------------------- rooms

function writeRoom(room: Room): SavedRoom {
  return {
    id: room.id,
    type: room.type,
    rect: writeRect(room.rect),
    door:
      room.door === null
        ? null
        : { inside: writePoint(room.door.inside), outside: writePoint(room.door.outside) },
    quality: room.quality,
  };
}

function readRoom(value: unknown, label: string): Room {
  const o = asRecord(value, label);
  const door = o.door === null ? null : asRecord(o.door, `${label}.door`);
  return {
    id: asInt(o.id, `${label}.id`),
    type: asOneOf(o.type, ROOM_TYPES, `${label}.type`),
    rect: readRect(o.rect, `${label}.rect`),
    door:
      door === null
        ? null
        : {
            inside: readPoint(door.inside, `${label}.door.inside`),
            outside: readPoint(door.outside, `${label}.door.outside`),
          },
    quality: asNumber(o.quality, `${label}.quality`),
  };
}

// ------------------------------------------------------------------ amenities

function writeAmenity(a: { kind: AmenityId; tile: GridPoint; fill: number }): SavedAmenity {
  return { kind: a.kind, tile: writePoint(a.tile), fill: a.fill };
}

function readAmenity(
  value: unknown,
  label: string,
): { kind: AmenityId; tile: GridPoint; fill: number } {
  const o = asRecord(value, label);
  return {
    kind: asOneOf(o.kind, AMENITY_IDS, `${label}.kind`),
    tile: readPoint(o.tile, `${label}.tile`),
    fill: asNumber(o.fill, `${label}.fill`),
  };
}

// ------------------------------------------------- messes & jobs (v5)

function writeMess(m: Mess): SavedMess {
  return { kind: m.kind, tile: writePoint(m.tile), since: m.since };
}

function readMess(value: unknown, label: string): Mess {
  const o = asRecord(value, label);
  return {
    // `water` is ACCEPTED (§S2.4): the kind ships in the v5 schema (Stage-3
    // piping bursts) and a clean job cleans any mess — no dead state.
    kind: asOneOf(o.kind, ['vomit', 'litter', 'water'], `${label}.kind`),
    tile: readPoint(o.tile, `${label}.tile`),
    since: asNumber(o.since, `${label}.since`),
  };
}

function writeJob(j: Job): SavedJob {
  return {
    id: j.id,
    kind: j.kind,
    tile: writePoint(j.tile),
    staffId: j.staffId,
    phase: j.phase,
    ticksRemaining: j.ticksRemaining,
    holdUntil: j.holdUntil,
  };
}

function readJob(value: unknown, label: string): Job {
  const o = asRecord(value, label);
  const kind = asOneOf(o.kind, ['clean', 'empty', 'repair'], `${label}.kind`);
  // `repair` is REJECTED in v5 (pre-impl MINOR 10): a reserved union value
  // with no legal target — it would sit queued forever.
  if (kind === 'repair') fail(`${label}.kind`, "a v5-workable job kind ('repair' is Stage 3)");
  // Bounded like readNeedBreak (§S2.4): the longest job duration at the
  // slowest skill — a hostile timer would pin the worker indefinitely.
  const maxJobTicks = treatmentDurationTicks(
    Math.max(BALANCE.mess.cleanGameMinutes, BALANCE.mess.emptyGameMinutes),
    BALANCE.stats.min,
    0,
  );
  const ticksRemaining = asNumber(o.ticksRemaining, `${label}.ticksRemaining`);
  if (ticksRemaining < 0 || ticksRemaining > maxJobTicks) {
    fail(`${label}.ticksRemaining`, `a job timer within [0, ${maxJobTicks}] ticks`);
  }
  return {
    id: asInt(o.id, `${label}.id`),
    kind,
    tile: readPoint(o.tile, `${label}.tile`),
    staffId: asIntOrNull(o.staffId, `${label}.staffId`),
    phase: asOneOf(o.phase, ['queued', 'assigned', 'working'], `${label}.phase`),
    ticksRemaining,
    holdUntil: asNumber(o.holdUntil, `${label}.holdUntil`), // finite-guarded by asNumber
  };
}

// --------------------------------------------------- reservations, candidates

function writeReservation(r: Reservation): SavedReservation {
  return {
    id: r.id,
    kind: r.kind,
    patientId: r.patientId,
    roomId: r.roomId,
    staffIds: [...r.staffIds],
    stepIndex: r.stepIndex,
    slotIndex: r.slotIndex,
    phase: r.phase,
    ticksRemaining: r.ticksRemaining,
    patientWaitingSince: r.patientWaitingSince,
  };
}

function readReservation(value: unknown, label: string, saveVersion: number): Reservation {
  const o = asRecord(value, label);
  return {
    id: asInt(o.id, `${label}.id`),
    kind: asOneOf(o.kind, ['triage', 'treatment'], `${label}.kind`),
    patientId: asInt(o.patientId, `${label}.patientId`),
    roomId: asInt(o.roomId, `${label}.roomId`),
    staffIds: asArray(o.staffIds, `${label}.staffIds`).map((id, i) =>
      asInt(id, `${label}.staffIds[${i}]`),
    ),
    stepIndex: asInt(o.stepIndex, `${label}.stepIndex`),
    // v2→v3 migration (Stage A): pre-v3 saves have no slotIndex — default 0
    // (correct: a pre-Stage-A room held at most one reservation). A v3 save
    // must carry it; validateReferences bounds it against the room's capacity.
    slotIndex: saveVersion < 3 ? 0 : asInt(o.slotIndex, `${label}.slotIndex`),
    phase: asOneOf(o.phase, ['gathering', 'active'], `${label}.phase`),
    ticksRemaining: asNumber(o.ticksRemaining, `${label}.ticksRemaining`),
    patientWaitingSince: asNumberOrNull(o.patientWaitingSince, `${label}.patientWaitingSince`),
  };
}

function writeCandidate(c: Candidate): SavedCandidate {
  return {
    id: c.id,
    role: c.role,
    name: writeName(c.name),
    age: c.age,
    skill: c.skill,
    salaryPerDay: c.salaryPerDay,
  };
}

function readCandidate(value: unknown, label: string): Candidate {
  const o = asRecord(value, label);
  return {
    id: asInt(o.id, `${label}.id`),
    role: asOneOf(o.role, ROLE_IDS, `${label}.role`),
    name: readName(o.name, `${label}.name`),
    age: asNumber(o.age, `${label}.age`),
    skill: asNumber(o.skill, `${label}.skill`),
    salaryPerDay: asNumber(o.salaryPerDay, `${label}.salaryPerDay`),
  };
}

// ------------------------------------------------------------------- grid RLE

/**
 * Grid RLE format. Tiles are serialized COLUMN-MAJOR (col 0..cols-1, and row
 * 0..rows-1 within each column — the same order as `world.grid[col][row]`) as
 * runs `<count>x<token>` joined by commas. A token is, in order:
 *
 *   'w' | 'b'        walkable / blocked
 *   'm'?             debug marker present
 *   'r<roomId>'?     tile belongs to room <roomId>
 *   'o<propId>'?     placed object (validated against PROP_STYLE keys)
 *
 * e.g. `"239xw,1xbr3odesk,5xwr3,1355xw"`. The string is AUTHORITATIVE: props
 * mutate walkable/object after build (and marker is player state), so tiles
 * are never re-derived from room defs on load.
 */
const RUN_PATTERN = /^(\d+)x(w|b)(m?)(?:r(\d+))?(?:o([A-Za-z]+))?$/;

const PROP_IDS = Object.keys(PROP_STYLE) as PropId[];

function tileToken(tile: Tile): string {
  let token = tile.walkable ? 'w' : 'b';
  if (tile.marker) token += 'm';
  if (tile.roomId !== null) token += `r${tile.roomId}`;
  if (tile.object !== null) token += `o${tile.object}`;
  return token;
}

/** Encode a full tile grid (exported for the round-trip test). */
export function encodeGrid(grid: Tile[][]): string {
  const runs: string[] = [];
  let current = '';
  let count = 0;
  for (const column of grid) {
    for (const tile of column) {
      const token = tileToken(tile);
      if (token === current) {
        count += 1;
      } else {
        if (count > 0) runs.push(`${count}x${current}`);
        current = token;
        count = 1;
      }
    }
  }
  if (count > 0) runs.push(`${count}x${current}`);
  return runs.join(',');
}

/**
 * Decode into a fresh cols×rows tile grid (exported for the round-trip test).
 * Throws SaveFormatError on malformed input — loadWorld's border catches it.
 */
export function decodeGrid(encoded: string, cols: number, rows: number): Tile[][] {
  const total = cols * rows;
  const tiles: Tile[] = [];
  for (const run of encoded.split(',')) {
    const match = RUN_PATTERN.exec(run);
    if (!match) fail('grid', `an RLE run like "<count>x<token>" (got "${run}")`);
    const count = Number(match[1]);
    const walkable = match[2] === 'w';
    const marker = match[3] === 'm';
    const roomId = match[4] === undefined ? null : Number(match[4]);
    const object =
      match[5] === undefined ? null : asOneOf(match[5], PROP_IDS, 'grid run object');
    if (count < 1 || tiles.length + count > total) {
      fail('grid', `runs totalling exactly ${total} tiles`);
    }
    for (let i = 0; i < count; i++) tiles.push({ walkable, roomId, object, marker });
  }
  if (tiles.length !== total) fail('grid', `runs totalling exactly ${total} tiles`);
  const grid: Tile[][] = [];
  for (let col = 0; col < cols; col++) grid.push(tiles.slice(col * rows, (col + 1) * rows));
  return grid;
}

// ----------------------------------------------------------------- serialize

/** Snapshot the world. Pure read — never mutates or emits. */
export function serializeWorld(world: World): SaveData {
  const priv = world.exportPrivateState();
  return {
    saveVersion: SAVE_VERSION,
    seed: world.seed,
    rngState: world.rng.getState(),
    tick: world.clock.tick,
    cash: world.cash,
    reputation: world.reputation,
    today: writeTally(world.today),
    lifetimeTreated: world.lifetimeTreated,
    lifetimeDied: world.lifetimeDied,
    bankruptSinceTick: world.bankruptSinceTick,
    gameOver: world.gameOver,
    hintedOnce: priv.hintedOnce,
    grid: encodeGrid(world.grid),
    rooms: [...world.rooms.values()].map(writeRoom),
    // v4 FROZEN position: immediately after rooms (impl plan §1.12).
    amenities: [...world.amenities.values()].map(writeAmenity),
    // v5 FROZEN positions: messes then jobs, after amenities (§S2.4).
    messes: [...world.messes.values()].map(writeMess),
    jobs: [...world.jobs.values()].map(writeJob),
    patients: [...world.patients.values()].map(writePatient),
    staff: [...world.staff.values()].map(writeStaff),
    candidates: world.candidates.map(writeCandidate),
    reservations: [...world.reservations.values()].map(writeReservation),
    checkInQueues: [...world.checkInQueues.entries()].map(
      ([roomId, ids]): [number, number[]] => [roomId, [...ids]],
    ),
    nextEntityId: priv.nextEntityId,
  };
}

/** serializeWorld → JSON string (what storage slots and export files hold). */
export function saveToString(world: World): string {
  return JSON.stringify(serializeWorld(world));
}

// ---------------------------------------------------------------------- load

/** Everything loadWorld restores, fully validated BEFORE any World exists. */
interface RestorePayload {
  seed: number;
  rngState: number;
  tick: number;
  cash: number;
  reputation: number;
  today: DayTally;
  lifetimeTreated: number;
  lifetimeDied: number;
  bankruptSinceTick: number | null;
  gameOver: boolean;
  hintedOnce: string[];
  grid: Tile[][];
  rooms: Room[];
  amenities: { kind: AmenityId; tile: GridPoint; fill: number }[];
  messes: Mess[];
  jobs: Job[];
  patients: Patient[];
  staff: Staff[];
  candidates: Candidate[];
  reservations: Reservation[];
  checkInQueues: [number, number[]][];
  nextEntityId: number;
}

function readRestorePayload(root: Record<string, unknown>, saveVersion: number): RestorePayload {
  return {
    seed: asInt(root.seed, 'seed'),
    rngState: asInt(root.rngState, 'rngState'),
    tick: asInt(root.tick, 'tick'),
    cash: asNumber(root.cash, 'cash'),
    reputation: asNumber(root.reputation, 'reputation'),
    today: readTally(root.today, 'today', saveVersion),
    lifetimeTreated: asNumber(root.lifetimeTreated, 'lifetimeTreated'),
    lifetimeDied: asNumber(root.lifetimeDied, 'lifetimeDied'),
    bankruptSinceTick: asNumberOrNull(root.bankruptSinceTick, 'bankruptSinceTick'),
    gameOver: asBool(root.gameOver, 'gameOver'),
    hintedOnce: asArray(root.hintedOnce, 'hintedOnce').map((k, i) =>
      asString(k, `hintedOnce[${i}]`),
    ),
    grid: decodeGrid(asString(root.grid, 'grid'), BALANCE.map.cols, BALANCE.map.rows),
    rooms: asArray(root.rooms, 'rooms').map((r, i) => readRoom(r, `rooms[${i}]`)),
    // v3→v4: pre-v4 saves carry no amenities — restore an empty store.
    amenities:
      saveVersion < 4
        ? []
        : asArray(root.amenities, 'amenities').map((a, i) => readAmenity(a, `amenities[${i}]`)),
    // v4→v5: pre-v5 saves carry no messes/jobs — restore empty maps (§4.5).
    messes:
      saveVersion < 5
        ? []
        : asArray(root.messes, 'messes').map((m, i) => readMess(m, `messes[${i}]`)),
    jobs:
      saveVersion < 5 ? [] : asArray(root.jobs, 'jobs').map((j, i) => readJob(j, `jobs[${i}]`)),
    patients: asArray(root.patients, 'patients').map((p, i) =>
      readPatient(p, `patients[${i}]`, saveVersion),
    ),
    staff: asArray(root.staff, 'staff').map((s, i) => readStaff(s, `staff[${i}]`)),
    candidates: asArray(root.candidates, 'candidates').map((c, i) =>
      readCandidate(c, `candidates[${i}]`),
    ),
    reservations: asArray(root.reservations, 'reservations').map((r, i) =>
      readReservation(r, `reservations[${i}]`, saveVersion),
    ),
    checkInQueues: asArray(root.checkInQueues, 'checkInQueues').map((entry, i): [number, number[]] => {
      const pair = asArray(entry, `checkInQueues[${i}]`);
      if (pair.length !== 2) fail(`checkInQueues[${i}]`, 'a [roomId, patientIds[]] pair');
      return [
        asInt(pair[0], `checkInQueues[${i}][0]`),
        asArray(pair[1], `checkInQueues[${i}][1]`).map((id, j) =>
          asInt(id, `checkInQueues[${i}][1][${j}]`),
        ),
      ];
    }),
    nextEntityId: asInt(root.nextEntityId, 'nextEntityId'),
  };
}

/**
 * Referential integrity (audit #8 — the border kills garbage, and "garbage"
 * includes SHAPE-valid saves with dangling ids): a reservation pointing at
 * absent staff makes `world.staff.get(id)!` in the dispatcher/treatment
 * systems throw every tick (bricked game), and a too-low nextEntityId makes
 * takeId() reissue live ids and silently overwrite map entries. Everything an
 * id field can point at is checked here, before any World exists.
 */
function validateReferences(data: RestorePayload): void {
  // -- global id uniqueness + the id counter above every issued id
  const allIds = new Set<number>();
  let maxId = 0;
  const register = (id: number, label: string): void => {
    if (allIds.has(id)) fail(label, `a globally unique id (${id} is used twice)`);
    allIds.add(id);
    maxId = Math.max(maxId, id);
  };
  data.rooms.forEach((r, i) => register(r.id, `rooms[${i}].id`));
  data.patients.forEach((p, i) => register(p.id, `patients[${i}].id`));
  data.staff.forEach((s, i) => register(s.id, `staff[${i}].id`));
  data.reservations.forEach((r, i) => register(r.id, `reservations[${i}].id`));
  data.candidates.forEach((c, i) => register(c.id, `candidates[${i}].id`));
  // v5: job ids join the global-uniqueness register + the nextEntityId bound
  // (§S2.4 — ids come from takeId(), so they share the one id space).
  data.jobs.forEach((j, i) => register(j.id, `jobs[${i}].id`));
  if (data.nextEntityId <= maxId) {
    fail(
      'nextEntityId',
      `a counter above every saved id (got ${data.nextEntityId}, highest id is ${maxId})`,
    );
  }

  const roomIds = new Set(data.rooms.map((r) => r.id));
  const patientIds = new Set(data.patients.map((p) => p.id));
  const staffIds = new Set(data.staff.map((s) => s.id));
  const reservationIds = new Set(data.reservations.map((r) => r.id));
  const mustResolve = (id: number, pool: Set<number>, label: string, what: string): void => {
    if (!pool.has(id)) fail(label, `${what} that exists in this save (got id ${id})`);
  };

  // -- reservations: patient, room, every staff member
  data.reservations.forEach((r, i) => {
    mustResolve(r.patientId, patientIds, `reservations[${i}].patientId`, 'a patient');
    mustResolve(r.roomId, roomIds, `reservations[${i}].roomId`, 'a room');
    r.staffIds.forEach((id, j) =>
      mustResolve(id, staffIds, `reservations[${i}].staffIds[${j}]`, 'a staff member'),
    );
  });

  // -- reservation capacity slots (v3, Stage A): in-range for the room's
  // GRID-derived capacity and exclusive per room — a hostile slotIndex would
  // otherwise stack two patients on one bed or anchor into the fallback path.
  const roomsById = new Map(data.rooms.map((r) => [r.id, r]));
  // Grid-derived slot capacity, shared by reservation slots and (v4) stall
  // claims. DELIBERATELY floor(total/stripLen), which is ≤ the runtime's
  // per-run strip consumption on hand-crafted grids (a 3-tile bed run: 1
  // here, 2 at runtime) — the border may only ever be STRICTER than the sim,
  // never more permissive. Don't "harmonize" this to the run-based count.
  const gridPropCapacity = (room: Room, prop: PropId): number => {
    let propTiles = 0;
    for (let col = room.rect.col; col < room.rect.col + room.rect.cols; col++) {
      for (let row = room.rect.row; row < room.rect.row + room.rect.rows; row++) {
        if (data.grid[col]?.[row]?.object === prop) propTiles += 1;
      }
    }
    return Math.floor(propTiles / PROP_STYLE[prop].tiles);
  };
  const slotsHeld = new Map<number, Set<number>>();
  data.reservations.forEach((r, i) => {
    if (r.slotIndex < 0) fail(`reservations[${i}].slotIndex`, 'a non-negative slot');
    const room = roomsById.get(r.roomId)!; // resolved above
    const rule = ROOM_DEFS[room.type].capacity;
    const capacity = rule.kind === 'perProp' ? gridPropCapacity(room, rule.prop) : 1;
    if (r.slotIndex >= capacity) {
      fail(
        `reservations[${i}].slotIndex`,
        `a slot below the room's capacity of ${capacity} (got ${r.slotIndex})`,
      );
    }
    const held = slotsHeld.get(r.roomId) ?? new Set<number>();
    if (held.has(r.slotIndex)) {
      fail(`reservations[${i}].slotIndex`, `an exclusive slot (slot ${r.slotIndex} is held twice)`);
    }
    held.add(r.slotIndex);
    slotsHeld.set(r.roomId, held);
  });

  // -- patient stage payloads + waiting-room seat
  data.patients.forEach((p, i) => {
    if (p.stage.kind === 'queuedCheckIn' || p.stage.kind === 'checkingIn') {
      mustResolve(p.stage.roomId, roomIds, `patients[${i}].stage.roomId`, 'a room');
    }
    if (p.stage.kind === 'reserved') {
      mustResolve(
        p.stage.reservationId,
        reservationIds,
        `patients[${i}].stage.reservationId`,
        'a reservation',
      );
    }
    if (p.waitingRoomId !== null) {
      mustResolve(p.waitingRoomId, roomIds, `patients[${i}].waitingRoomId`, 'a room');
    }
  });

  // -- amenities ↔ grid tiles, BOTH ways (v4, AMENITIES_PLAN §3.5): every
  // entry sits on an in-bounds tile carrying its prop (non-walkable — the
  // §3.4 rule), one entry per tile; and every amenity-prop tile on the grid
  // has an entry (a propped tile with no store entry would render but never
  // sell or claim).
  const amenityTileKeys = new Set<string>();
  const vendingTileKeys = new Set<string>();
  data.amenities.forEach((a, i) => {
    const { col, row } = a.tile;
    const tile = data.grid[col]?.[row];
    if (!tile) fail(`amenities[${i}].tile`, 'a tile inside the map');
    const key = `${col},${row}`;
    if (amenityTileKeys.has(key)) {
      fail(`amenities[${i}].tile`, `one amenity per tile (${key} appears twice)`);
    }
    amenityTileKeys.add(key);
    if (a.kind === 'vending') vendingTileKeys.add(key);
    if (tile.object !== a.kind) {
      fail(`amenities[${i}]`, `a grid tile carrying '${a.kind}' (got '${tile.object}')`);
    }
    if (tile.walkable) fail(`amenities[${i}]`, 'a non-walkable amenity tile (§3.4 rule)');
    if (a.fill < 0) fail(`amenities[${i}].fill`, 'a non-negative fill');
    // Bounded above (Stage-2 code review MINOR): a can beyond capacity is
    // unproducible in-sim and would be permanently dead post-load (dropLitter
    // skips it as full; the overflow mint only fires ON reaching capacity).
    if (a.fill > BALANCE.mess.trashcanCapacity) {
      fail(`amenities[${i}].fill`, `a fill within [0, ${BALANCE.mess.trashcanCapacity}]`);
    }
  });
  const amenityKindSet = new Set<string>(AMENITY_IDS);
  for (let col = 0; col < data.grid.length; col++) {
    const column = data.grid[col]!;
    for (let row = 0; row < column.length; row++) {
      const object = column[row]!.object;
      if (object !== null && amenityKindSet.has(object) && !amenityTileKeys.has(`${col},${row}`)) {
        fail('grid', `tile (${col},${row}) carries amenity prop '${object}' with no amenities entry`);
      }
    }
  }

  // -- need-break claims (v4): restroom claims resolve to a restroom room
  // with the slot inside its grid-derived stall count, exclusively held;
  // vending claims sit on a vending amenity tile, one user per machine.
  const stallClaimsHeld = new Set<string>();
  const vendingClaimsHeld = new Set<string>();
  data.patients.forEach((p, i) => {
    const nb = p.needBreak;
    if (nb === null) return;
    if (nb.kind === 'restroom') {
      mustResolve(nb.roomId!, roomIds, `patients[${i}].needBreak.roomId`, 'a room');
      const room = roomsById.get(nb.roomId!)!;
      if (room.type !== 'restroom') {
        fail(`patients[${i}].needBreak.roomId`, `a restroom (room ${room.id} is ${room.type})`);
      }
      const stalls = gridPropCapacity(room, 'toiletStall');
      if (nb.slot! < 0 || nb.slot! >= stalls) {
        fail(
          `patients[${i}].needBreak.slot`,
          `a stall below the room's count of ${stalls} (got ${nb.slot})`,
        );
      }
      const claimKey = `${nb.roomId}:${nb.slot}`;
      if (stallClaimsHeld.has(claimKey)) {
        fail(`patients[${i}].needBreak.slot`, `an exclusive stall (${claimKey} is held twice)`);
      }
      stallClaimsHeld.add(claimKey);
    } else {
      const key = `${nb.tile!.col},${nb.tile!.row}`;
      if (!vendingTileKeys.has(key)) {
        fail(`patients[${i}].needBreak.tile`, `a vending machine tile (got ${key})`);
      }
      if (vendingClaimsHeld.has(key)) {
        fail(`patients[${i}].needBreak.tile`, `one user per machine (${key} is claimed twice)`);
      }
      vendingClaimsHeld.add(key);
    }
  });

  // -- messes (v5, §S2.4): in-bounds tiles, at most one per tile; kind
  // validity (incl. `water` acceptance) already enforced by readMess.
  const messTileKeys = new Set<string>();
  data.messes.forEach((m, i) => {
    if (!data.grid[m.tile.col]?.[m.tile.row]) fail(`messes[${i}].tile`, 'a tile inside the map');
    const key = `${m.tile.col},${m.tile.row}`;
    if (messTileKeys.has(key)) fail(`messes[${i}].tile`, `one mess per tile (${key} appears twice)`);
    messTileKeys.add(key);
  });

  // -- jobs (v5, §S2.4): job↔target BOTH ways (clean → a mess on the tile;
  // empty → a trashcan amenity on the tile; ≤1 job per tile; every mess has
  // a job — the addMess mint invariant), phase ⇔ staffId consistency, and
  // assigned/working back-references an `evs` worker whose duty is this job.
  const trashcanTileKeys = new Set(
    data.amenities.filter((a) => a.kind === 'trashcan').map((a) => `${a.tile.col},${a.tile.row}`),
  );
  const staffById = new Map(data.staff.map((s) => [s.id, s]));
  const jobTileKeys = new Set<string>();
  data.jobs.forEach((j, i) => {
    if (!data.grid[j.tile.col]?.[j.tile.row]) fail(`jobs[${i}].tile`, 'a tile inside the map');
    const key = `${j.tile.col},${j.tile.row}`;
    if (jobTileKeys.has(key)) fail(`jobs[${i}].tile`, `one job per tile (${key} is targeted twice)`);
    jobTileKeys.add(key);
    if (j.kind === 'clean' && !messTileKeys.has(key)) {
      fail(`jobs[${i}].tile`, `a mess on the clean job's tile (none at ${key})`);
    }
    if (j.kind === 'empty' && !trashcanTileKeys.has(key)) {
      fail(`jobs[${i}].tile`, `a trashcan on the empty job's tile (none at ${key})`);
    }
    if (j.phase === 'queued') {
      if (j.staffId !== null) {
        fail(`jobs[${i}].staffId`, `null for a queued job (got ${j.staffId})`);
      }
    } else {
      if (j.staffId === null) fail(`jobs[${i}].staffId`, `a worker for an ${j.phase} job`);
      const member = staffById.get(j.staffId);
      if (!member) fail(`jobs[${i}].staffId`, `a staff member in this save (got ${j.staffId})`);
      if (member.role !== 'evs') {
        fail(`jobs[${i}].staffId`, `an EVS worker (staff ${j.staffId} is a ${member.role})`);
      }
      if (member.duty.kind !== 'job' || member.duty.jobId !== j.id) {
        fail(`jobs[${i}].staffId`, `a worker whose duty back-references this job`);
      }
      // A `working` worker stands at/beside the target (Stage-2 code review
      // NIT): a legal work tile is the job tile or an orthogonal neighbor,
      // so anything farther is a hostile save working the mess remotely.
      if (j.phase === 'working') {
        const dist = Math.max(
          Math.abs(member.at.col - j.tile.col),
          Math.abs(member.at.row - j.tile.row),
        );
        if (dist > 1) {
          fail(`jobs[${i}]`, `a working worker within 1 tile of the target (at distance ${dist})`);
        }
      }
    }
  });
  // Reverse direction: a mess with NO job would never be cleaned — an
  // uncleanable permanent reputation leak (the addMess invariant).
  data.messes.forEach((m, i) => {
    if (!jobTileKeys.has(`${m.tile.col},${m.tile.row}`)) {
      fail(`messes[${i}]`, 'a job targeting the mess tile (none does)');
    }
  });

  // -- staff duty payloads
  const jobsById = new Map(data.jobs.map((j) => [j.id, j]));
  data.staff.forEach((s, i) => {
    if (s.duty.kind === 'post') {
      mustResolve(s.duty.roomId, roomIds, `staff[${i}].duty.roomId`, 'a room');
    }
    if (s.duty.kind === 'reserved') {
      mustResolve(
        s.duty.reservationId,
        reservationIds,
        `staff[${i}].duty.reservationId`,
        'a reservation',
      );
    }
    if (s.duty.kind === 'job') {
      const job = jobsById.get(s.duty.jobId);
      if (!job) {
        fail(`staff[${i}].duty.jobId`, `a job in this save (got id ${s.duty.jobId})`);
      }
      if (job.staffId !== s.id) {
        fail(`staff[${i}].duty.jobId`, `a job assigned back to this worker (job ${job.id})`);
      }
    }
  });

  // -- check-in queues: room + patients resolve, each patient in ≤1 position
  const queuedPatientIds = new Set<number>();
  data.checkInQueues.forEach(([roomId, ids], i) => {
    mustResolve(roomId, roomIds, `checkInQueues[${i}] roomId`, 'a room');
    ids.forEach((id, j) => {
      mustResolve(id, patientIds, `checkInQueues[${i}][1][${j}]`, 'a patient');
      if (queuedPatientIds.has(id)) {
        fail(
          `checkInQueues[${i}][1][${j}]`,
          `each patient in at most one queue position (patient ${id} appears twice)`,
        );
      }
      queuedPatientIds.add(id);
    });
  });

  // -- room footprints fully inside the map
  data.rooms.forEach((room, i) => {
    const { col, row, cols, rows } = room.rect;
    if (
      col < 0 ||
      row < 0 ||
      cols < 1 ||
      rows < 1 ||
      col + cols > BALANCE.map.cols ||
      row + rows > BALANCE.map.rows
    ) {
      fail(`rooms[${i}].rect`, `a footprint inside the ${BALANCE.map.cols}×${BALANCE.map.rows} map`);
    }
  });

  // -- every grid-tile room reference resolves (also kills absurd RLE roomIds)
  for (let col = 0; col < data.grid.length; col++) {
    const column = data.grid[col]!;
    for (let row = 0; row < column.length; row++) {
      const roomId = column[row]!.roomId;
      if (roomId !== null && !roomIds.has(roomId)) {
        fail('grid', `tile (${col},${row}) to reference a saved room (got id ${roomId})`);
      }
    }
  }
}

/**
 * Restore a fully-validated payload into a fresh World. NEVER calls
 * setupNewGame or recomputePaths (in-flight paths are part of the save), and
 * emits NO events — the caller decides what the UI hears about a load.
 * stageViolations starts empty; aura caches rebuild lazily (signature 'never').
 */
function restoreInto(world: World, data: RestorePayload): void {
  // The constructor drew from the rng to roll the candidate pool — overwrite
  // both with the saved truth, in that order.
  world.rng.setState(data.rngState);
  world.candidates.length = 0;
  world.candidates.push(...data.candidates);
  world.clock.tick = data.tick;
  world.cash = data.cash;
  world.reputation = data.reputation;
  world.today = data.today;
  world.lifetimeTreated = data.lifetimeTreated;
  world.lifetimeDied = data.lifetimeDied;
  world.bankruptSinceTick = data.bankruptSinceTick;
  world.gameOver = data.gameOver;
  for (let col = 0; col < world.cols; col++) {
    for (let row = 0; row < world.rows; row++) {
      const tile = world.grid[col]![row]!;
      const saved = data.grid[col]![row]!;
      tile.walkable = saved.walkable;
      tile.roomId = saved.roomId;
      tile.object = saved.object;
      tile.marker = saved.marker;
    }
  }
  for (const room of data.rooms) world.rooms.set(room.id, room);
  for (const a of data.amenities) world.amenities.set(`${a.tile.col},${a.tile.row}`, a);
  for (const m of data.messes) world.messes.set(`${m.tile.col},${m.tile.row}`, m);
  for (const job of data.jobs) world.jobs.set(job.id, job);
  for (const patient of data.patients) world.patients.set(patient.id, patient);
  for (const member of data.staff) world.staff.set(member.id, member);
  for (const reservation of data.reservations) world.reservations.set(reservation.id, reservation);
  for (const [roomId, ids] of data.checkInQueues) world.checkInQueues.set(roomId, ids);
  world.restorePrivateState({ hintedOnce: data.hintedOnce, nextEntityId: data.nextEntityId });
  // Cross-version pool repair (v1→v2 review MAJOR): a save minted before a
  // role existed can never offer its candidates otherwise. Complete pools
  // (every same-version save) make this a strict no-op — zero rng draws, so
  // byte-identity of save→load→save holds. Must follow restorePrivateState:
  // new candidate ids come from the restored counter.
  world.topUpCandidates();
}

/**
 * Parse + validate + version-check + rebuild a World. Garbage dies at this
 * border (audit #8): malformed JSON, wrong shape, dangling id references, or
 * a newer saveVersion all return `{ ok: false, reason }` — never throw, never
 * half-construct.
 */
export function loadWorld(events: EventBus, raw: string): LoadResult {
  try {
    const parsed: unknown = JSON.parse(raw);
    const root = asRecord(parsed, 'save');
    const version = asInt(root.saveVersion, 'saveVersion');
    if (version > SAVE_VERSION) {
      return {
        ok: false,
        reason: `Save version ${version} is newer than this game understands (version ${SAVE_VERSION}) — update the game to load it`,
      };
    }
    // The accept/refuse decision is isLoadableVersion's alone (SSOT): v1 loads
    // via the additive-content ruling documented on that function.
    if (!isLoadableVersion(version)) {
      return { ok: false, reason: `Unrecognized save version ${version}` };
    }
    // Validate EVERYTHING before a World exists — a failure below never
    // half-constructs (the World is only built once the payload is clean).
    const payload = readRestorePayload(root, version);
    validateReferences(payload);
    // A finished game is frozen (tick() is a no-op) and its gameOver event
    // already fired — loading one would be an unexplained dead world.
    if (payload.gameOver) {
      return {
        ok: false,
        reason: 'This save is from a finished game (game over) — start a new game instead',
      };
    }
    const world = new World(events, payload.seed);
    restoreInto(world, payload);
    return { ok: true, world };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason:
        error instanceof SaveFormatError
          ? `Corrupt save: ${detail}`
          : `Not a valid save file: ${detail}`,
    };
  }
}
