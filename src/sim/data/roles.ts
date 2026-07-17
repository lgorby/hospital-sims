/** SSOT for staff roles (tech plan §3.1). Colors are the placeholder-art palette (§2.6). */
export const ROLE_DEFS = {
  receptionist: { label: 'Receptionist', salaryPerDay: 80, color: 0xc98bdb, standingPost: true },
  nurse: { label: 'Nurse', salaryPerDay: 150, color: 0x2a9d8f, standingPost: false },
  doctor: { label: 'Doctor', salaryPerDay: 300, color: 0xf1f1f1, standingPost: false },
  radTech: {
    label: 'Radiology Technologist',
    salaryPerDay: 200,
    color: 0x1d3557,
    standingPost: false,
  },
  respTherapist: {
    label: 'Respiratory Therapist',
    salaryPerDay: 200,
    color: 0x52b788,
    standingPost: false,
  },
  greeter: { label: 'Volunteer Greeter', salaryPerDay: 50, color: 0xe9c46a, standingPost: true },
} as const;

export type RoleId = keyof typeof ROLE_DEFS;
export const ROLE_IDS = Object.keys(ROLE_DEFS) as RoleId[];
