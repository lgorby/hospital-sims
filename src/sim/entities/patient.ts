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
  /** Sense of direction 1–5 (GDD §3): low = prone to wrong turns on long walks. */
  wayfinding: number;
  /**
   * Lost sub-state (GDD §3, tech plan §2.3): NOT a lifecycle stage. A lost
   * walker abandons its path but RETAINS its target; stall checks exempt it
   * (M3-gate ruling) — only timeout/terminal events release its reservation.
   */
  lost: { since: number } | null;
  /** Last mood the thought log reported — transitions emit `patientThought`. */
  reportedMood: 'content' | 'impatient' | 'critical';
  /** Spawn tick — the "door" end of the door-to-first-treatment wait (M4). */
  arrivedAtTick: number;
  /** Tick the first TREATMENT reservation went active (triage excluded); null until then. */
  firstTreatedAtTick: number | null;
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
