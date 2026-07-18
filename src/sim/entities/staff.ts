import type { PersonName } from '../data/names';
import type { RoleId } from '../data/roles';
import type { GridPoint } from '../types';

export type StaffDuty =
  | { kind: 'idle' }
  /** Standing post (receptionist at a reception desk; greeter in M3). */
  | { kind: 'post'; roomId: number }
  /** Bound to a reservation — walking there or working it. */
  | { kind: 'reserved'; reservationId: number }
  /** Amenities Stage 2: bound to a facility job (clean/empty; repair in
   *  Stage 3) — the non-patient work queue (AMENITIES_PLAN §4.3). */
  | { kind: 'job'; jobId: number };

/**
 * A facility work item (amenities Stage 2, impl plan §S2.1): the job queue
 * mirrors the reservation lifecycle — queued → assigned (worker walking) →
 * working (timer) → done — with the rule-7/8 analogues (fire → requeue;
 * stall → requeue + hold; orphaned target → job deleted, worker released).
 * `repair` is reserved for Stage 3 (no producer; v5 border REJECTS it).
 * Ids come from `takeId()` (global uniqueness; oldest = lowest id).
 */
export interface Job {
  id: number;
  kind: 'clean' | 'empty' | 'repair';
  /** clean/empty: the mess/can tile. repair (Stage 3): the ANCHOR — a
   *  structurally workable tile of the broken room (impl plan §S3.1,
   *  pre-impl MAJOR 1), stable while broken. */
  tile: GridPoint;
  /** Stage 3: the room a `repair` job fixes; null for clean/empty. */
  roomId: number | null;
  /** null = queued (unassigned). */
  staffId: number | null;
  phase: 'queued' | 'assigned' | 'working';
  /** Set when `working` begins (skill-scaled via treatmentDurationTicks). */
  ticksRemaining: number;
  /** Failed-probe retry hold (the dispatchHoldUntil analogue). */
  holdUntil: number;
}

export interface Staff {
  id: number;
  name: PersonName;
  age: number;
  role: RoleId;
  skill: number;
  salaryPerDay: number;
  duty: StaffDuty;
  /** Fired while busy: released → removed instead of returning to idle. */
  firing: boolean;

  // Walker fields (movement system)
  at: GridPoint;
  next: GridPoint | null;
  path: GridPoint[];
  target: GridPoint | null;
  progress: number;
}

/** A hire-panel candidate (GDD §4: randomized skill/salary tradeoffs). */
export interface Candidate {
  id: number;
  role: RoleId;
  name: PersonName;
  age: number;
  skill: number;
  salaryPerDay: number;
}

/**
 * All-or-nothing resource reservation (tech plan §5 risk table): one patient,
 * one room, N staff — acquired atomically by the dispatcher, released as a
 * unit on completion or any terminal patient event (Flow rule 7).
 */
export interface Reservation {
  id: number;
  kind: 'triage' | 'treatment';
  patientId: number;
  roomId: number;
  staffIds: number[];
  /** Treatment step this reservation executes (ignored for triage). */
  stepIndex: number;
  /**
   * Which capacity slot (bed/machine) this reservation holds (Stage A,
   * CAPACITY_PLAN §3.3). 0 for `single`-capacity rooms. STABLE for the
   * reservation's lifetime — assigned from the free-slot set at reservation
   * time, never rebound (an nth-live derivation would re-anchor everyone when
   * a neighbor cancels). Serialized (SAVE_VERSION 3; legacy saves restore 0).
   */
  slotIndex: number;
  /** gathering: parties walking to the room. active: timer running. */
  phase: 'gathering' | 'active';
  ticksRemaining: number;
  /**
   * The patient's `waitingSince` at reservation time. Re-queues (complication,
   * between steps, rule-8 cancel) restore it — the wait clock survives the
   * round-trip so aged priority is never wiped (Flow rule 6 ruling).
   */
  patientWaitingSince: number | null;
}
