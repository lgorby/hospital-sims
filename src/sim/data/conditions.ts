import type { RoleId } from './roles';
import type { RoomType } from './rooms';

interface TreatmentStep {
  readonly label: string;
  readonly room: RoomType;
  /** All listed roles are required simultaneously (all-or-nothing reservation). */
  readonly roles: readonly RoleId[];
  readonly durationGameMinutes: number;
  /** Billed on completion of this step — per-step payment (GDD §6). */
  readonly fee: number;
}

interface ConditionDef {
  readonly label: string;
  /** Inclusive acuity range rolled at triage (1 = critical, 5 = minor). */
  readonly acuityMin: number;
  readonly acuityMax: number;
  readonly steps: readonly TreatmentStep[];
}

/** SSOT for the V1 condition roster (GDD §3). Treatment paths are data, not code. */
export const CONDITION_DEFS = {
  flu: {
    label: 'Flu',
    acuityMin: 4,
    acuityMax: 5,
    steps: [{ label: 'Exam', room: 'exam', roles: ['doctor'], durationGameMinutes: 30, fee: 150 }],
  },
  laceration: {
    label: 'Laceration',
    acuityMin: 3,
    acuityMax: 4,
    steps: [
      // ED_PLAN Stage A: lacerations are sutured in the emergency department,
      // not a clinic exam room. Room CHANGED, chain length unchanged.
      { label: 'Sutures', room: 'er', roles: ['nurse'], durationGameMinutes: 40, fee: 200 },
    ],
  },
  fracture: {
    label: 'Fracture',
    acuityMin: 3,
    acuityMax: 3,
    steps: [
      { label: 'X-ray', room: 'xray', roles: ['radTech'], durationGameMinutes: 20, fee: 200 },
      // ED_PLAN Stage A: fractures are reduced and cast in the ED.
      { label: 'Casting', room: 'er', roles: ['doctor'], durationGameMinutes: 30, fee: 300 },
    ],
  },
  asthma: {
    label: 'Asthma Attack',
    acuityMin: 2,
    acuityMax: 3,
    steps: [
      {
        // DEPARTMENTS_PLAN §3: a respiratory therapist delivers the neb at the
        // patient's BEDSIDE (AARC, confirmed 3-0 — RTs are mobile, and APEX
        // standards prohibit routinely treating several patients at once), so
        // this happens in an exam room rather than a room of its own. Stage A's
        // principle: change the ROOM of an existing step, never lengthen the
        // chain. `roles` is unchanged, so the therapist is still the binding
        // resource — which is the research's actual point.
        label: 'Nebulizer',
        room: 'exam',
        roles: ['respTherapist'],
        durationGameMinutes: 45,
        fee: 400,
      },
    ],
  },
  pneumonia: {
    label: 'Pneumonia',
    acuityMin: 2,
    acuityMax: 3,
    steps: [
      { label: 'X-ray', room: 'xray', roles: ['radTech'], durationGameMinutes: 20, fee: 200 },
      {
        // DEPARTMENTS_PLAN §3 — bedside, same as asthma's nebulizer. The
        // preceding X-ray step is unchanged. At 60 min this is the longest
        // exam-room occupancy in the game, which is why §3.2 measures exam
        // contention in weight × DURATION rather than arrival weight.
        label: 'Respiratory therapy',
        room: 'exam',
        roles: ['respTherapist'],
        durationGameMinutes: 60,
        fee: 500,
      },
    ],
  },
  chestPain: {
    label: 'Chest Pain',
    acuityMin: 1,
    acuityMax: 2,
    steps: [
      {
        label: 'ER treatment',
        room: 'er',
        roles: ['doctor', 'nurse'],
        durationGameMinutes: 90,
        fee: 1_200,
      },
    ],
  },
  // ---- Expansion 1 (GDD §12): referral-heavy roster — five of eight at
  // acuity ≤ 3 ride the §7 case-mix shift, so these paths matter as rep grows.
  kidneyStones: {
    label: 'Kidney Stones',
    acuityMin: 3,
    acuityMax: 3,
    steps: [
      { label: 'CT scan', room: 'ct', roles: ['radTech'], durationGameMinutes: 25, fee: 350 },
      // ED_PLAN Stage A: renal colic is one of the most common ED
      // presentations — the pain is what brings people in.
      { label: 'Pain control', room: 'er', roles: ['doctor'], durationGameMinutes: 30, fee: 300 },
    ],
  },
  backInjury: {
    label: 'Back Injury',
    acuityMin: 4,
    acuityMax: 4,
    steps: [
      { label: 'MRI scan', room: 'mri', roles: ['radTech'], durationGameMinutes: 40, fee: 500 },
      { label: 'Consult', room: 'exam', roles: ['doctor'], durationGameMinutes: 30, fee: 250 },
    ],
  },
  thyroid: {
    label: 'Thyroid Disorder',
    acuityMin: 4,
    acuityMax: 5,
    steps: [
      {
        label: 'Nuclear scan',
        room: 'nucMed',
        roles: ['radTech'],
        durationGameMinutes: 45,
        fee: 450,
      },
      { label: 'Consult', room: 'exam', roles: ['doctor'], durationGameMinutes: 25, fee: 250 },
    ],
  },
  kidneyFailure: {
    label: 'Kidney Failure',
    acuityMin: 2,
    acuityMax: 3,
    steps: [
      { label: 'Dialysis', room: 'dialysis', roles: ['nurse'], durationGameMinutes: 120, fee: 700 },
    ],
  },
  gallstones: {
    label: 'Gallstones',
    acuityMin: 3,
    acuityMax: 3,
    steps: [
      {
        label: 'Ultrasound',
        room: 'ultrasound',
        roles: ['sonographer'],
        durationGameMinutes: 25,
        fee: 250,
      },
      {
        label: 'Surgery',
        room: 'surgery',
        roles: ['surgeon', 'nurse', 'anesthesiologist'],
        // ANESTHESIA_PLAN §4: shorter + dearer to pay for the third salary.
        // 120 → 90 min, $1,500 → $2,000 (the case also bills a $250
        // ultrasound first, so total case revenue is 1,750 → 2,250).
        durationGameMinutes: 90,
        fee: 2_000,
      },
    ],
  },
  headInjury: {
    label: 'Head Injury',
    acuityMin: 2,
    acuityMax: 2,
    steps: [
      { label: 'CT scan', room: 'ct', roles: ['radTech'], durationGameMinutes: 25, fee: 350 },
      {
        label: 'ER treatment',
        room: 'er',
        roles: ['doctor', 'nurse'],
        durationGameMinutes: 75,
        fee: 1_000,
      },
    ],
  },
  appendicitis: {
    label: 'Appendicitis',
    acuityMin: 2,
    acuityMax: 2,
    steps: [
      {
        label: 'Ultrasound',
        room: 'ultrasound',
        roles: ['sonographer'],
        durationGameMinutes: 25,
        fee: 250,
      },
      {
        label: 'Surgery',
        room: 'surgery',
        roles: ['surgeon', 'nurse', 'anesthesiologist'],
        // ANESTHESIA_PLAN §4: 100 → 80 min, $1,800 → $2,300 (total case
        // revenue 2,050 → 2,550 with the ultrasound step).
        durationGameMinutes: 80,
        fee: 2_300,
      },
    ],
  },
  stroke: {
    label: 'Stroke',
    acuityMin: 1,
    acuityMax: 1,
    steps: [
      { label: 'CT scan', room: 'ct', roles: ['radTech'], durationGameMinutes: 20, fee: 350 },
      {
        label: 'ER treatment',
        room: 'er',
        roles: ['doctor', 'nurse'],
        durationGameMinutes: 120,
        fee: 1_600,
      },
    ],
  },
} as const satisfies Record<string, ConditionDef>;

export type ConditionId = keyof typeof CONDITION_DEFS;
export const CONDITION_IDS = Object.keys(CONDITION_DEFS) as ConditionId[];
