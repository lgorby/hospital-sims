import type { ConditionId } from '../data/conditions';
import type { PersonName } from '../data/names';
import type { GridPoint } from '../types';

/**
 * Explicit lifecycle stage (tech plan §2.3 — discriminated union). Walking is
 * NOT a stage: it's implied by `next !== null` within whatever stage the
 * patient is in, which is what keeps lostness (M3) a movement sub-state.
 */
export type PatientStage =
  /** No reception available — waits at the entrance until patience expires (Flow rule 1). */
  | { kind: 'atEntrance' }
  /** In (or walking to) a check-in queue slot; slot 0 is the desk. */
  | { kind: 'queuedCheckIn'; roomId: number; slot: number }
  | { kind: 'checkingIn'; roomId: number; ticksRemaining: number }
  /** Checked in, waiting for a triage bay + nurse. */
  | { kind: 'waitingTriage' }
  /** Triaged, waiting for the next treatment step's room + staff. */
  | { kind: 'waiting' }
  /** Bound to a reservation — walking there or being treated (see Reservation.phase). */
  | { kind: 'reserved'; reservationId: number }
  | { kind: 'leaving'; reason: 'discharged' | 'ama' }
  | { kind: 'dead'; since: number };

export interface Patient {
  id: number;
  name: PersonName;
  age: number;
  condition: ConditionId;
  /** null until triage assigns it (untriaged decay uses acuity 3 — Flow rule 2). */
  acuity: number | null;
  health: number;
  patience: number;
  /** Index of the next not-yet-completed treatment step. */
  stepIndex: number;
  /** Fees billed so far (per-step payment — GDD §6). */
  billed: number;
  stage: PatientStage;
  /** Tick when the current wait began (priority aging); null while not waiting. */
  waitingSince: number | null;
  /** Dispatcher won't reserve for this patient before this tick (Flow rule 8 retry hold). */
  dispatchHoldUntil: number;
  /** Waiting room whose capacity this patient occupies; null = standing (1.5× patience). */
  waitingRoomId: number | null;

  // Walker fields (movement system)
  at: GridPoint;
  next: GridPoint | null;
  path: GridPoint[];
  target: GridPoint | null;
  progress: number;
}
