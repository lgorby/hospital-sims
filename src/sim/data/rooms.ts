import type { RoleId } from './roles';

/** Prop ids placeable on tiles (`Tile.object`). GDD §5 "required equipment". */
export type PropId =
  | 'desk'
  | 'chair'
  | 'vitalsCart'
  | 'bed'
  | 'xrayMachine'
  | 'nebulizer'
  | 'traumaBed'
  | 'helpDesk'
  | 'ultrasoundCart'
  | 'ctGantry'
  | 'mriBore'
  | 'shieldScreen'
  | 'gammaCamera'
  | 'hotLabBench'
  | 'dialysisMachine'
  | 'orTable'
  | 'anesthesiaCart'
  | 'scrubSink'
  // Amenities epic Stage 1: restroom fixture + the freestanding amenities
  // (AMENITY_DEFS carries their costs; ids join PropId so Tile.object and
  // the save grid RLE accept them — AMENITIES_PLAN §3.4).
  | 'toiletStall'
  | 'trashcan'
  | 'vending'
  | 'plant'
  // SHIFTS Stage 2 (SHIFTS_STAGE2_CONTRACT §2): the staff-lounge seat. Its
  // occupancy is DERIVED from staff `onBreak` claims (the toiletStall/restroom
  // precedent), and it is NON-WALKABLE so `slotAnchorTile` stands the staffer
  // on a tile beside it, unchanged.
  | 'loungeSeat';

/**
 * How many of a prop a room's footprint carries (capacity epic Stage A):
 * `fixed` is today's behavior; `perTiles` scales with area — one prop per
 * `tilesPerProp` tiles, floored, clamped to [min, max]. RULE (CAPACITY_PLAN
 * §3.2): a MINIMUM-size room must derive exactly its pre-epic count, so
 * existing saves and the balance harness behave identically at min size.
 */
export type PropDensity =
  | { readonly kind: 'fixed'; readonly count: number }
  | {
      readonly kind: 'perTiles';
      readonly tilesPerProp: number;
      readonly min: number;
      readonly max?: number;
    };

/** One auto-placed equipment item (M3 ruling: fixed layouts, no rearrange UI in V1). */
export interface PropSpec {
  readonly id: PropId;
  /** Seats people stand on stay walkable; machines/desks block the tile. */
  readonly walkable: boolean;
  readonly density: PropDensity;
}

/**
 * How many patients a room serves CONCURRENTLY (capacity epic Stage A,
 * owner-ratified roster): `single` = one reservation at a time (today);
 * `perProp` = one slot per placed slot-prop (beds/machines/chairs) — the
 * props ARE the capacity. `noun` labels the inspect-panel readout.
 */
export type CapacityRule =
  | { readonly kind: 'single' }
  | { readonly kind: 'perProp'; readonly prop: PropId; readonly noun: string };

/**
 * The one table per prop (§3.1 rule 5 — one module per fact): placeholder-art
 * palette, prism height, and `tiles` — the horizontal strip length that BOTH
 * placement (world) and per-tile slicing (renderer, §2.5) read.
 */
export const PROP_STYLE: Record<PropId, { color: number; rise: number; tiles: number }> = {
  desk: { color: 0xa07444, rise: 14, tiles: 1 },
  chair: { color: 0x6d7f99, rise: 8, tiles: 1 }, // muted steel-blue: contrasts the green waiting-room floor (art review)
  vitalsCart: { color: 0xd9d4c9, rise: 14, tiles: 1 },
  bed: { color: 0xbcd0e6, rise: 12, tiles: 2 },
  xrayMachine: { color: 0x4a4258, rise: 22, tiles: 2 },
  // Unreachable since DEPARTMENTS_PLAN §3 retired `resp` — retained
  // deliberately (§3.7): adding it to `exam.props` would consume a tile in a
  // 3×3 minimum and perturb quality and auto-placement.
  nebulizer: { color: 0x5aa08c, rise: 14, tiles: 1 },
  traumaBed: { color: 0xd6a0a0, rise: 12, tiles: 2 },
  helpDesk: { color: 0xc9a35a, rise: 14, tiles: 1 },
  // Expansion 1 (GDD §12). HARD CONSTRAINT: tiles ≤ 2 — the renderer's strip
  // slicing supports single/west/east segments only.
  ultrasoundCart: { color: 0xdfe6ee, rise: 14, tiles: 1 },
  ctGantry: { color: 0xe8e4f0, rise: 20, tiles: 2 },
  mriBore: { color: 0xced6f0, rise: 22, tiles: 2 },
  shieldScreen: { color: 0x6e7480, rise: 18, tiles: 1 },
  gammaCamera: { color: 0x8d86a8, rise: 20, tiles: 2 },
  hotLabBench: { color: 0xb0a06a, rise: 14, tiles: 1 },
  dialysisMachine: { color: 0x7fb5ad, rise: 16, tiles: 1 },
  orTable: { color: 0xd9dde2, rise: 12, tiles: 2 },
  anesthesiaCart: { color: 0x6a7fa8, rise: 14, tiles: 1 },
  scrubSink: { color: 0xc2d4dd, rise: 12, tiles: 1 },
  // Amenities epic Stage 1 (colors at Track-R art discretion; all 1-tile).
  toiletStall: { color: 0xdce8ee, rise: 14, tiles: 1 },
  trashcan: { color: 0x707a70, rise: 10, tiles: 1 },
  vending: { color: 0xc44b4b, rise: 22, tiles: 1 },
  plant: { color: 0x4f9a5e, rise: 16, tiles: 1 },
  // SHIFTS Stage 2: a couch/armchair — a warm upholstered tone, apart from the
  // clinical palette.
  loungeSeat: { color: 0x8a6d5a, rise: 12, tiles: 1 },
};

/** Waiting room chair count included in the base build (GDD §5). */
export const WAITING_ROOM_BASE_CHAIRS = 6;

/** Build-menu grouping (GDD §9 owner ruling: the catalog renders as category dropdowns). */
export type RoomCategory = 'basics' | 'imaging' | 'treatment' | 'comfort';

/** Amenities Stage 3 (AMENITIES_PLAN §5.1): rooms with a failure entry wear
 *  out by USE and break down — `mechanical` just disables; `piping` also
 *  bursts water messes. Rooms without one never break. */
export interface RoomFailure {
  readonly kind: 'mechanical' | 'piping';
}

interface RoomDef {
  readonly label: string;
  readonly kind: 'treatment' | 'open';
  readonly category: RoomCategory;
  readonly minCols: number;
  readonly minRows: number;
  readonly cost: number;
  /** Roles that can staff this room's work (empty = unstaffed, e.g. waiting room). */
  readonly staffedBy: readonly RoleId[];
  /**
   * ED epic Stage B1 (ED_PLAN §3.2): how many concurrent reservations ONE
   * staffer of this role may hold IN THIS ROOM. An absent role — and every
   * room without the field — is 1, i.e. today's exclusive binding, so ratio
   * staffing is opt-in per room by construction. Read ONLY through
   * `formulas.staffRatioFor`. Keys must be a subset of `staffedBy`
   * (data.test.ts). A ratio staffer's reservations are all in ONE room:
   * that is what makes "zone" mean anything, and it is the incentive to
   * consolidate (two 2-bay ERs need 2 nurses; one 4-bay ER needs 1).
   */
  readonly staffRatio?: Readonly<Partial<Record<RoleId, number>>>;
  /** Placeholder floor tint (render palette lives with the data it colors). */
  readonly floorColor: number;
  /** Concurrent-patient rule (Stage A) — see CapacityRule. */
  readonly capacity: CapacityRule;
  /** Use-based failure model (Stage 3) — absent = this room never breaks. */
  readonly failure?: RoomFailure;
  /** Auto-placed equipment (M3): placed on build, reverted if it would strand tiles. */
  readonly props: readonly PropSpec[];
}

/** SSOT for room types (GDD §5). Build menu, dispatcher, and economy all read from here. */
export const ROOM_DEFS = {
  reception: {
    label: 'Reception',
    kind: 'treatment',
    category: 'basics',
    minCols: 2,
    minRows: 3,
    cost: 2_000,
    floorColor: 0xe3c9a8,
    staffedBy: ['receptionist'],
    capacity: { kind: 'single' },
    props: [{ id: 'desk', walkable: false, density: { kind: 'fixed', count: 1 } }],
  },
  waiting: {
    label: 'Waiting Room',
    kind: 'treatment',
    category: 'basics',
    minCols: 3,
    minRows: 3,
    cost: 1_000,
    floorColor: 0xc9d9b1,
    staffedBy: [],
    // Seats scale with the floor (Stage A): 1 chair per 1.5 tiles — 3×3 min
    // (9 tiles) derives exactly the pre-epic 6, so old saves/harness match.
    capacity: { kind: 'perProp', prop: 'chair', noun: 'Seats' },
    props: [
      {
        id: 'chair',
        walkable: true,
        density: { kind: 'perTiles', tilesPerProp: 1.5, min: WAITING_ROOM_BASE_CHAIRS },
      },
    ],
  },
  triage: {
    label: 'Triage Bay',
    kind: 'treatment',
    category: 'basics',
    minCols: 2,
    minRows: 2,
    cost: 1_500,
    floorColor: 0xf0d1a0,
    staffedBy: ['nurse'],
    capacity: { kind: 'single' },
    props: [{ id: 'vitalsCart', walkable: false, density: { kind: 'fixed', count: 1 } }],
  },
  exam: {
    label: 'Exam Room',
    kind: 'treatment',
    category: 'treatment',
    minCols: 3,
    minRows: 3,
    cost: 3_000,
    floorColor: 0xaacbe0,
    // `respTherapist` joins for DEPARTMENTS_PLAN §3: asthma's nebulizer and
    // pneumonia's respiratory therapy are delivered at the bedside here. The
    // `step.roles ⊆ room.staffedBy` invariant (data.test.ts) requires it.
    // Audited (pre-impl review NIT 15) — the third role changes DISPLAY only:
    // `standingPost` is false, `staffRatioFor` returns 1 for an absent key,
    // `everySlotApproachable` early-returns on `single`, and `capacityNeeds`
    // is gated on `step.roles`, so a flu patient can never produce a spurious
    // "Every Respiratory Therapist is busy". No third-role assumption exists.
    staffedBy: ['doctor', 'nurse', 'respTherapist'],
    capacity: { kind: 'single' },
    props: [{ id: 'bed', walkable: false, density: { kind: 'fixed', count: 1 } }],
  },
  xray: {
    label: 'X-Ray',
    kind: 'treatment',
    category: 'imaging',
    minCols: 3,
    minRows: 4,
    cost: 8_000,
    floorColor: 0xb9b1c9,
    staffedBy: ['radTech'],
    capacity: { kind: 'single' },
    // Stage-3 failure roster (§5.1 ratified): imaging gantries + OR + resp
    // are `mechanical`; restroom + dialysis are `piping`; ultrasound (a
    // cart) and the basics deliberately never break.
    failure: { kind: 'mechanical' },
    props: [{ id: 'xrayMachine', walkable: false, density: { kind: 'fixed', count: 1 } }],
  },
  // RETIRED — see RETIRED_ROOMS below. Kept in the table on purpose: `RoomType`
  // derives from this object and `save.ts` validates against `ROOM_TYPES`, so
  // deleting it would refuse every live save holding one (DEPARTMENTS_PLAN
  // §3.3). Nothing routes here; asthma and pneumonia are treated at the
  // bedside in `exam`. Its `failure`, `nebulizer` prop and floor colour are
  // retained-but-unreachable per §3.7 — do not "clean them up" expecting a
  // no-op, and do not re-point a condition step here (data.test.ts guards it).
  resp: {
    label: 'Respiratory Therapy',
    kind: 'treatment',
    category: 'treatment',
    minCols: 3,
    minRows: 3,
    cost: 5_000,
    floorColor: 0xa9d9c9,
    staffedBy: ['respTherapist'],
    capacity: { kind: 'single' },
    failure: { kind: 'mechanical' },
    props: [{ id: 'nebulizer', walkable: false, density: { kind: 'fixed', count: 1 } }],
  },
  er: {
    label: 'ER Bay',
    kind: 'treatment',
    category: 'treatment',
    minCols: 3,
    minRows: 4,
    cost: 10_000,
    floorColor: 0xe0a9a9,
    staffedBy: ['doctor', 'nurse'],
    // ED epic Stage B1. Cal. Title 22 §70217 sets the ED nurse cap at 1:4
    // INSTANTANEOUS (no shift averaging) — that is where `nurse: 4` comes
    // from and it is kept. `doctor: 4` is DELIBERATELY NOT the researched
    // 1:15 zone number: at `tilesPerProp: 6` a 15-bed ED needs 90 tiles, so
    // 1:15 would be inert at every buildable size. 4 puts the physician
    // threshold inside the range players actually build, which is what makes
    // the binding constraint MOVE with the day's case mix (ED_PLAN §7.2):
    // laceration (wt 20) is nurse-only, fracture + kidney stones (wt 23) are
    // doctor-only, chest pain/head injury/stroke (wt 19) need both. Sharing
    // is not free — see BALANCE.treatment.attentionSkillPenaltyPerPatient.
    staffRatio: { nurse: 4, doctor: 4 },
    // The owner's ward scenario (Stage A): beds scale with the floor. Stage B1
    // halves the density (12 → 6) so the minimum 3×4 derives 2 bays, answering
    // Stage A's death signal: at λ=0.54/h and ~63 min mean occupancy, 1 bay
    // queues ~53 min with a 120-min stroke freezing the department, 2 bays
    // ~9 min, and 4 bays ~1 min — which would delete the pressure entirely
    // (ED_PLAN §5). Capacity derives from PLACED prop tiles, so this affects
    // new builds and expansions only; existing saved ERs keep their one bed.
    capacity: { kind: 'perProp', prop: 'traumaBed', noun: 'Beds' },
    props: [
      { id: 'traumaBed', walkable: false, density: { kind: 'perTiles', tilesPerProp: 6, min: 2 } },
    ],
  },
  // ---- Expansion 1 (GDD §12): imaging suite + treatment departments.
  // Prop ordering note: multi-tile strips are listed FIRST in each props list
  // so they get first pick of open runs — in tight footprints (ultrasound is
  // 2 wide) a 1-tile prop placed first can strand the only legal 2-tile run.
  ultrasound: {
    label: 'Ultrasound',
    kind: 'treatment',
    category: 'imaging',
    minCols: 2,
    minRows: 3,
    cost: 4_000,
    floorColor: 0x9fc4d6,
    staffedBy: ['sonographer'],
    capacity: { kind: 'single' },
    props: [
      { id: 'bed', walkable: false, density: { kind: 'fixed', count: 1 } },
      { id: 'ultrasoundCart', walkable: false, density: { kind: 'fixed', count: 1 } },
    ],
  },
  ct: {
    label: 'CT Scanner',
    kind: 'treatment',
    category: 'imaging',
    minCols: 4,
    minRows: 4,
    cost: 14_000,
    floorColor: 0xc4b5d6,
    staffedBy: ['radTech'],
    capacity: { kind: 'single' },
    failure: { kind: 'mechanical' },
    props: [
      { id: 'ctGantry', walkable: false, density: { kind: 'fixed', count: 1 } },
      { id: 'desk', walkable: false, density: { kind: 'fixed', count: 1 } },
    ],
  },
  mri: {
    label: 'MRI',
    kind: 'treatment',
    category: 'imaging',
    minCols: 4,
    minRows: 4,
    cost: 18_000,
    floorColor: 0xa8aed6,
    staffedBy: ['radTech'],
    capacity: { kind: 'single' },
    failure: { kind: 'mechanical' },
    props: [
      { id: 'mriBore', walkable: false, density: { kind: 'fixed', count: 1 } },
      { id: 'desk', walkable: false, density: { kind: 'fixed', count: 1 } },
      { id: 'shieldScreen', walkable: false, density: { kind: 'fixed', count: 1 } },
    ],
  },
  nucMed: {
    label: 'Nuclear Medicine',
    kind: 'treatment',
    category: 'imaging',
    minCols: 3,
    minRows: 4,
    cost: 16_000,
    floorColor: 0xcfd9a0,
    staffedBy: ['radTech'],
    capacity: { kind: 'single' },
    failure: { kind: 'mechanical' },
    props: [
      { id: 'gammaCamera', walkable: false, density: { kind: 'fixed', count: 1 } },
      { id: 'hotLabBench', walkable: false, density: { kind: 'fixed', count: 1 } },
    ],
  },
  dialysis: {
    label: 'Dialysis',
    kind: 'treatment',
    category: 'treatment',
    minCols: 3,
    minRows: 4,
    cost: 9_000,
    floorColor: 0xa0d9d0,
    staffedBy: ['nurse'],
    // RATIFIED retro jump (CAPACITY_PLAN §8 Q2): both min-size machines now
    // treat concurrently (1→2 at ship). Chairs mirror the machine density so
    // every new machine gets its companion seat.
    failure: { kind: 'piping' },
    capacity: { kind: 'perProp', prop: 'dialysisMachine', noun: 'Machines' },
    props: [
      {
        id: 'dialysisMachine',
        walkable: false,
        density: { kind: 'perTiles', tilesPerProp: 6, min: 2 },
      },
      { id: 'chair', walkable: true, density: { kind: 'perTiles', tilesPerProp: 6, min: 2 } },
    ],
  },
  surgery: {
    label: 'Operating Room',
    kind: 'treatment',
    category: 'treatment',
    minCols: 4,
    minRows: 4,
    cost: 20_000,
    floorColor: 0x9fd0b0,
    staffedBy: ['surgeon', 'nurse', 'anesthesiologist'],
    capacity: { kind: 'single' },
    failure: { kind: 'mechanical' },
    props: [
      { id: 'orTable', walkable: false, density: { kind: 'fixed', count: 1 } },
      { id: 'anesthesiaCart', walkable: false, density: { kind: 'fixed', count: 1 } },
      { id: 'scrubSink', walkable: false, density: { kind: 'fixed', count: 1 } },
    ],
  },
  // Amenities epic Stage 1 (AMENITIES_PLAN §3.3): unstaffed, self-service —
  // occupancy is DERIVED from patients' needBreak claims, never reservations.
  // 2×3 min (6 tiles) derives exactly 2 stalls (perTiles 3, min 2).
  restroom: {
    label: 'Restroom',
    kind: 'treatment',
    category: 'comfort',
    minCols: 2,
    minRows: 3,
    cost: 2_500,
    floorColor: 0xcfe0e8,
    staffedBy: [],
    failure: { kind: 'piping' },
    capacity: { kind: 'perProp', prop: 'toiletStall', noun: 'Stalls' },
    props: [
      {
        id: 'toiletStall',
        walkable: false,
        density: { kind: 'perTiles', tilesPerProp: 3, min: 2 },
      },
    ],
  },
  // SHIFTS Stage 2 (SHIFTS_STAGE2_CONTRACT §2): where staff take their
  // mid-shift lunch. Unstaffed, self-service — seat occupancy is DERIVED from
  // staff `onBreak` claims (the restroom precedent), never reservations. 3×3
  // min (9 tiles) derives exactly 3 seats (perTiles 3, min 3). No `failure`
  // entry — a lounge has no equipment to break.
  lounge: {
    label: 'Staff Lounge',
    kind: 'treatment',
    category: 'comfort',
    minCols: 3,
    minRows: 3,
    cost: 3_000,
    floorColor: 0xe6dcc3,
    staffedBy: [],
    capacity: { kind: 'perProp', prop: 'loungeSeat', noun: 'Seats' },
    props: [
      {
        id: 'loungeSeat',
        walkable: false,
        density: { kind: 'perTiles', tilesPerProp: 3, min: 3 },
      },
    ],
  },
  atrium: {
    label: 'Atrium',
    kind: 'open',
    category: 'comfort',
    minCols: 4,
    minRows: 4,
    cost: 4_000,
    floorColor: 0xd0e8d0,
    staffedBy: ['greeter'],
    capacity: { kind: 'single' },
    props: [{ id: 'helpDesk', walkable: false, density: { kind: 'fixed', count: 1 } }],
  },
} as const satisfies Record<string, RoomDef>;

export type RoomType = keyof typeof ROOM_DEFS;
export const ROOM_TYPES = Object.keys(ROOM_DEFS) as RoomType[];

/**
 * The one `failure` accessor (Stage 3): the `as const` table's union type
 * only carries `failure` on entries that declare it, so property access
 * doesn't compile — this widens through the RoomDef interface. Undefined =
 * the room never breaks.
 */
export function roomFailure(type: RoomType): RoomFailure | undefined {
  return (ROOM_DEFS[type] as RoomDef).failure;
}

/**
 * The one `staffRatio` accessor (ED Stage B1) — same widening as
 * `roomFailure` above, for the same `as const` reason. Undefined = this room
 * binds staff exclusively. Callers should prefer `formulas.staffRatioFor`,
 * which applies the "absent ⇒ 1" default.
 */
export function roomStaffRatio(type: RoomType): Readonly<Partial<Record<RoleId, number>>> | undefined {
  return (ROOM_DEFS[type] as RoomDef).staffRatio;
}

/**
 * Room types withdrawn from the build catalog (DEPARTMENTS_PLAN §3.3).
 *
 * A retired room is NOT deleted. `RoomType` derives from `ROOM_DEFS` and
 * `save.ts` validates with `asOneOf(o.type, ROOM_TYPES)`, so removing an entry
 * would make every LIVE save containing that room refuse to load — and the
 * game is deployed. Retirement keeps the def loadable and keeps existing
 * rooms standing; it only takes the type out of the build menu.
 *
 * THE FACT LIVES HERE, in `src/sim/data/`, not in the UI (hard rule 1): the
 * sim and the UI must never disagree about what exists. `CATEGORY_LABELS` is
 * keyed by CATEGORY, so it could not express this even if the rule allowed it.
 *
 * `world.buildRoom` is deliberately PERMISSIVE — retirement is a catalog
 * concept, and the save/maintenance fixtures build `resp` through the command
 * path to cover schema corners that must keep working (pre-impl review
 * MINOR 10).
 *
 * `resp`: DEPARTMENTS_PLAN §3. Nebulizer and ventilator care are delivered at
 * the patient's bedside by a mobile therapist (AARC, 3-0), so asthma and
 * pneumonia now route to `exam` and nothing routes here. Owner decision, with
 * the evidentiary gap recorded in §3.0 — the research supports the ROUTING
 * change; retiring the building is a game-design call taken on top of it.
 */
export const RETIRED_ROOMS: readonly RoomType[] = ['resp'];

/** Is this type withdrawn from the build catalog? (See RETIRED_ROOMS.) */
export function roomRetired(type: RoomType): boolean {
  return RETIRED_ROOMS.includes(type);
}
