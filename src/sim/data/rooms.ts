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
  | 'plant';

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
    staffedBy: ['doctor', 'nurse'],
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
    // The owner's ward scenario (Stage A): beds scale with the floor — 3×4
    // min (12 tiles) derives exactly the pre-epic 1 bed; growth earns more,
    // and each bed treats a patient CONCURRENTLY (with its own staff pair).
    capacity: { kind: 'perProp', prop: 'traumaBed', noun: 'Beds' },
    props: [
      { id: 'traumaBed', walkable: false, density: { kind: 'perTiles', tilesPerProp: 12, min: 1 } },
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
