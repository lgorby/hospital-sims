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
  // Expansion 1 (GDD §12): the cheap imaging on-ramp and the OR's dual-staff lead.
  sonographer: { label: 'Sonographer', salaryPerDay: 180, color: 0x76c7e0, standingPost: false },
  surgeon: { label: 'Surgeon', salaryPerDay: 500, color: 0x2d6a4f, standingPost: false },
  greeter: { label: 'Volunteer Greeter', salaryPerDay: 50, color: 0xe9c46a, standingPost: true },
  // Amenities Stage 2 (AMENITIES_PLAN §4.4): the cleaning crew. Brown/tan —
  // deliberately far from the teal/green cluster (art-review color-spread
  // note). NOTE: adding a role mints constructor candidates (~12 seeded rng
  // draws before tick 0), shifting EVERY fixed-seed trajectory — the Stage-2
  // re-pin pass (impl plan §S2.6b) landed together with this entry.
  evs: { label: 'EVS Worker', salaryPerDay: 90, color: 0x9b7653, standingPost: false },
  // Amenities Stage 3 (AMENITIES_PLAN §5.3): the repair trade. Orange —
  // far from the teal/green cluster AND from evs brown. NOTE: adding a role
  // mints constructor candidates (~12 seeded rng draws before tick 0),
  // shifting EVERY fixed-seed trajectory — the Stage-3 re-pin pass (impl
  // plan §S3.8) landed together with this entry.
  maintenance: { label: 'Maintenance Tech', salaryPerDay: 140, color: 0xe07a3f, standingPost: false },
} as const;

export type RoleId = keyof typeof ROLE_DEFS;
export const ROLE_IDS = Object.keys(ROLE_DEFS) as RoleId[];
