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

/**
 * Legal lifecycle transitions, declared in one table (tech plan §2.3, audit
 * #5). Self-transitions (same kind, new payload — re-slotting, re-queueing)
 * are always legal and not listed. `World.setPatientStage` is the enforcement
 * point; violations are counted, never thrown (prod degrades gracefully,
 * tests assert the counter is empty).
 */
export const LEGAL_STAGE_TRANSITIONS: Record<
  PatientStage['kind'],
  readonly PatientStage['kind'][]
> = {
  atEntrance: ['queuedCheckIn', 'leaving', 'dead'],
  queuedCheckIn: ['checkingIn', 'atEntrance', 'leaving', 'dead'],
  checkingIn: ['queuedCheckIn', 'waitingTriage', 'atEntrance', 'leaving', 'dead'],
  waitingTriage: ['reserved', 'leaving', 'dead'],
  waiting: ['reserved', 'leaving', 'dead'],
  reserved: ['waitingTriage', 'waiting', 'leaving', 'dead'],
  leaving: [],
  dead: [],
};

/**
 * Need side-trip sub-state (amenities epic Stage 1, AMENITIES_PLAN §3.2):
 * NOT a lifecycle stage — the `lost` precedent. Stage stays waiting/
 * waitingTriage; the dispatcher skips on-break patients like lost ones.
 * Stall/machine claims are DERIVED from these (a stall is taken iff some
 * live patient's needBreak references it), so terminal clears release
 * everything by construction (rule-7 analogue).
 */
export type NeedBreak = {
  kind: 'restroom' | 'vending';
  /** Restroom claims: the room + the claimed stall slot. */
  roomId?: number;
  slot?: number;
  /** Vending claims: the MACHINE's tile (the walk goal is an adjacent
   *  tile picked once at claim time). */
  tile?: GridPoint;
  phase: 'walking' | 'using';
  /** Set when `using` begins. */
  ticksRemaining: number;
  /** Claim tick — the watchdog abandons breaks that never reach `using`. */
  startedAt: number;
};

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
  /** Need meters (amenities Stage 1, §3.1) — vitals 0–100 scale, decay like patience. */
  bladder: number;
  thirst: number;
  /** In-flight need side-trip; null = none. See NeedBreak. */
  needBreak: NeedBreak | null;
  /** No side-trip triggers before this tick (failed/abandoned-break retry hold). */
  needBreakHoldUntil: number;

  // Walker fields (movement system)
  at: GridPoint;
  next: GridPoint | null;
  path: GridPoint[];
  target: GridPoint | null;
  progress: number;
}
