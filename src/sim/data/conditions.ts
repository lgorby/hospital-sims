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
} as const satisfies Record<string, ConditionDef>;

export type ConditionId = keyof typeof CONDITION_DEFS;
export const CONDITION_IDS = Object.keys(CONDITION_DEFS) as ConditionId[];
