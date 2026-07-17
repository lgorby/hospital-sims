import type { PatientStage } from '../sim/entities/patient';
import type { Reservation, StaffDuty } from '../sim/entities/staff';

/** The one typographic minus — every signed number in the UI shares it. */
const MINUS = '−';

/** Sign prefix shared by money() and signedDelta() — QA nit: rep deltas once
 *  rendered an ASCII hyphen while money used '−'. */
function signPrefix(rounded: number, plusForPositive: boolean): string {
  if (rounded < 0) return MINUS;
  return plusForPositive ? '+' : '';
}

/** UI money formatting, one place: "$12,345" / "−$12,345". */
export function money(amount: number): string {
  const rounded = Math.round(amount);
  return `${signPrefix(rounded, false)}$${Math.abs(rounded).toLocaleString('en-US')}`;
}

/** Explicitly-signed delta ("+4", "−25") for gains/losses like rep changes. */
export function signedDelta(value: number): string {
  const rounded = Math.round(value);
  return `${signPrefix(rounded, true)}${Math.abs(rounded).toLocaleString('en-US')}`;
}

// ---------------------------------------------------------------------------
// Player-facing state labels (QA nit: panels leaked raw sim identifiers like
// "queuedCheckIn"). Typed Records over the union kinds: a new stage or duty
// kind fails to compile until it gets a label.

const PATIENT_STAGE_LABELS: Record<PatientStage['kind'], string> = {
  atEntrance: 'Waiting at the entrance',
  queuedCheckIn: 'In line at reception',
  checkingIn: 'Checking in',
  waitingTriage: 'Waiting for triage',
  waiting: 'Waiting for treatment',
  reserved: 'Heading to care', // refined by reservation phase below
  leaving: 'Leaving', // refined by reason below
  dead: 'Deceased',
};

/**
 * Player-facing patient state. Pass the reservation phase (cheap read from
 * world.reservations) to split walking-to-care from being treated.
 */
export function patientStageLabel(
  stage: PatientStage,
  reservationPhase?: Reservation['phase'],
): string {
  if (stage.kind === 'reserved' && reservationPhase === 'active') return 'Receiving care';
  if (stage.kind === 'leaving') {
    return stage.reason === 'discharged' ? 'Discharged — heading home' : 'Leaving untreated';
  }
  return PATIENT_STAGE_LABELS[stage.kind];
}

const STAFF_DUTY_LABELS: Record<StaffDuty['kind'], string> = {
  idle: 'Idle',
  post: 'At their post',
  reserved: 'With a patient', // refined by reservation phase below
};

/** Player-facing staff duty; phase splits walking-to-patient from treating. */
export function staffDutyLabel(duty: StaffDuty, reservationPhase?: Reservation['phase']): string {
  if (duty.kind === 'reserved') {
    return reservationPhase === 'active' ? 'Treating a patient' : 'Walking to a patient';
  }
  return STAFF_DUTY_LABELS[duty.kind];
}
