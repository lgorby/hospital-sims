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
      { label: 'Sutures', room: 'exam', roles: ['nurse'], durationGameMinutes: 40, fee: 200 },
    ],
  },
  fracture: {
    label: 'Fracture',
    acuityMin: 3,
    acuityMax: 3,
    steps: [
      { label: 'X-ray', room: 'xray', roles: ['radTech'], durationGameMinutes: 20, fee: 200 },
      { label: 'Casting', room: 'exam', roles: ['doctor'], durationGameMinutes: 30, fee: 300 },
    ],
  },
  asthma: {
    label: 'Asthma Attack',
    acuityMin: 2,
    acuityMax: 3,
    steps: [
      {
        label: 'Nebulizer',
        room: 'resp',
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
        label: 'Respiratory therapy',
        room: 'resp',
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
      { label: 'Consult', room: 'exam', roles: ['doctor'], durationGameMinutes: 30, fee: 300 },
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
        roles: ['surgeon', 'nurse'],
        durationGameMinutes: 120,
        fee: 1_500,
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
        roles: ['surgeon', 'nurse'],
        durationGameMinutes: 100,
        fee: 1_800,
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
