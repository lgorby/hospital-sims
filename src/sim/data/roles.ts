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
  // COLOUR-SPREAD (art-review note): the SCRUB_CAP_ROLES trio (nurse,
  // respTherapist, surgeon — defined below) all wear the scrub-cap silhouette,
  // so at iso scale they read only by hue. They USED to cluster in one green
  // band (nurse teal 173°, RT + surgeon BOTH ~152–153°, telling apart only by
  // the surgeon's mask). Now spread across the green→teal arc — RT lime 86°,
  // surgeon mid-green 125°, nurse teal 173° (pairwise ≥ ~39° apart). Guarded by
  // data.test.ts "scrub-cap clinical roles are hue-separated". Nurse is the
  // anchor (most-seen role, teal = nurse is established); these two moved.
  respTherapist: {
    label: 'Respiratory Therapist',
    salaryPerDay: 200,
    color: 0x7fb539,
    standingPost: false,
  },
  // Expansion 1 (GDD §12): the cheap imaging on-ramp and the OR's dual-staff lead.
  sonographer: { label: 'Sonographer', salaryPerDay: 180, color: 0x76c7e0, standingPost: false },
  surgeon: { label: 'Surgeon', salaryPerDay: 500, color: 0x2d7633, standingPost: false },
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
  // ANESTHESIA_PLAN §2 (owner ask: "the game actually needs to model
  // anesthesiology"). Crimson — clear of the teal/green clinical cluster, of
  // evs brown and of maintenance orange. The one standing red OBJECT in the
  // world is the vending machine (PROP_STYLE.vending 0xc44b4b), so this was
  // colour-checked in frame WITH one. Salary sits between nurse and surgeon:
  // it is the brake that stops "just hire three" being free, and it is why
  // §4 raises surgery fees. NOTE: adding a role mints constructor candidates
  // (~12 seeded rng draws before tick 0), shifting EVERY fixed-seed
  // trajectory — the re-pin sweep (§6) landed together with this entry, the
  // evs/maintenance precedent.
  anesthesiologist: {
    label: 'Anesthesiologist',
    salaryPerDay: 420,
    color: 0xc1121f,
    standingPost: false,
  },
} as const;

export type RoleId = keyof typeof ROLE_DEFS;
export const ROLE_IDS = Object.keys(ROLE_DEFS) as RoleId[];

/**
 * Roles whose sprite wears a scrub cap instead of hair (render silhouette,
 * render/sprites/characters.ts). SSOT because two facts depend on it: the
 * renderer draws the cap, AND — since a shared silhouette leaves colour as the
 * only iso-scale differentiator — these must stay hue-separated (guarded by
 * data.test.ts "scrub-cap clinical roles are hue-separated"). Co-located with
 * the colours above so the two never drift: add a role here and both the cap
 * and the colour-spread guard pick it up automatically.
 */
export const SCRUB_CAP_ROLES = [
  'nurse',
  'respTherapist',
  'surgeon',
] as const satisfies readonly RoleId[];
