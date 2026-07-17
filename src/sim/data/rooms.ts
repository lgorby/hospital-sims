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
  | 'scrubSink';

/** One auto-placed equipment item (M3 ruling: fixed layouts, no rearrange UI in V1). */
export interface PropSpec {
  readonly id: PropId;
  /** Seats people stand on stay walkable; machines/desks block the tile. */
  readonly walkable: boolean;
  readonly count: number;
}

/**
 * The one table per prop (§3.1 rule 5 — one module per fact): placeholder-art
 * palette, prism height, and `tiles` — the horizontal strip length that BOTH
 * placement (world) and per-tile slicing (renderer, §2.5) read.
 */
export const PROP_STYLE: Record<PropId, { color: number; rise: number; tiles: number }> = {
  desk: { color: 0xa07444, rise: 14, tiles: 1 },
  chair: { color: 0x7d9463, rise: 8, tiles: 1 },
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
};

/** Waiting room chair count included in the base build (GDD §5). */
export const WAITING_ROOM_BASE_CHAIRS = 6;

/** Build-menu grouping (GDD §9 owner ruling: the catalog renders as category dropdowns). */
export type RoomCategory = 'basics' | 'imaging' | 'treatment' | 'comfort';

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
    props: [{ id: 'desk', walkable: false, count: 1 }],
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
    props: [{ id: 'chair', walkable: true, count: WAITING_ROOM_BASE_CHAIRS }],
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
    props: [{ id: 'vitalsCart', walkable: false, count: 1 }],
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
    props: [{ id: 'bed', walkable: false, count: 1 }],
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
    props: [{ id: 'xrayMachine', walkable: false, count: 1 }],
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
    props: [{ id: 'nebulizer', walkable: false, count: 1 }],
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
    props: [{ id: 'traumaBed', walkable: false, count: 1 }],
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
    props: [
      { id: 'bed', walkable: false, count: 1 },
      { id: 'ultrasoundCart', walkable: false, count: 1 },
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
    props: [
      { id: 'ctGantry', walkable: false, count: 1 },
      { id: 'desk', walkable: false, count: 1 },
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
    props: [
      { id: 'mriBore', walkable: false, count: 1 },
      { id: 'desk', walkable: false, count: 1 },
      { id: 'shieldScreen', walkable: false, count: 1 },
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
    props: [
      { id: 'gammaCamera', walkable: false, count: 1 },
      { id: 'hotLabBench', walkable: false, count: 1 },
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
    props: [
      { id: 'dialysisMachine', walkable: false, count: 2 },
      { id: 'chair', walkable: true, count: 2 },
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
    staffedBy: ['surgeon', 'nurse'],
    props: [
      { id: 'orTable', walkable: false, count: 1 },
      { id: 'anesthesiaCart', walkable: false, count: 1 },
      { id: 'scrubSink', walkable: false, count: 1 },
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
    props: [{ id: 'helpDesk', walkable: false, count: 1 }],
  },
} as const satisfies Record<string, RoomDef>;

export type RoomType = keyof typeof ROOM_DEFS;
export const ROOM_TYPES = Object.keys(ROOM_DEFS) as RoomType[];
