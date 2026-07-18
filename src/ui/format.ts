import type { PatientStage } from '../sim/entities/patient';
import type { Job, Reservation, StaffDuty } from '../sim/entities/staff';

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
  job: 'On a facilities job', // refined by jobKind below (Stage 2 freeze)
};

/** Per-job-kind duty wording (Stage 2 freeze — the inspect caller resolves
 *  the kind from world.jobs; the record fallback covers a missing job). */
const JOB_KIND_LABELS: Record<Job['kind'], string> = {
  clean: 'Cleaning',
  empty: 'Emptying a trashcan',
  repair: 'Repairing',
};

/** En-route wording (Stage-3 live-drive MINOR 2: "Repairing" while still
 *  walking contradicted the room card's "repair pending") — the
 *  reservation walking/working split, applied to jobs. */
const JOB_ENROUTE_LABELS: Record<Job['kind'], string> = {
  clean: 'Heading to a mess',
  empty: 'Heading to a trashcan',
  repair: 'Heading to a repair',
};

/** Player-facing staff duty; phase splits walking-to-patient from treating.
 *  For jobs, `jobPhase` splits en-route from at-work the same way. */
export function staffDutyLabel(
  duty: StaffDuty,
  reservationPhase?: Reservation['phase'],
  jobKind?: Job['kind'],
  jobPhase?: Job['phase'],
): string {
  if (duty.kind === 'reserved') {
    return reservationPhase === 'active' ? 'Treating a patient' : 'Walking to a patient';
  }
  if (duty.kind === 'job' && jobKind !== undefined) {
    return jobPhase === 'working' ? JOB_KIND_LABELS[jobKind] : JOB_ENROUTE_LABELS[jobKind];
  }
  return STAFF_DUTY_LABELS[duty.kind];
}
