import type { PersonName } from '../data/names';
import type { RoleId } from '../data/roles';
import type { GridPoint } from '../types';

export type StaffDuty =
  | { kind: 'idle' }
  /** Standing post (receptionist at a reception desk; greeter in M3). */
  | { kind: 'post'; roomId: number }
  /** Bound to a reservation — walking there or working it. */
  | { kind: 'reserved'; reservationId: number };

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
  /** gathering: parties walking to the room. active: timer running. */
  phase: 'gathering' | 'active';
  ticksRemaining: number;
}
