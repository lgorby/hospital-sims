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
  | 'helpDesk';

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
};

/** Waiting room chair count included in the base build (GDD §5). */
export const WAITING_ROOM_BASE_CHAIRS = 6;

interface RoomDef {
  readonly label: string;
  readonly kind: 'treatment' | 'open';
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
    minCols: 3,
    minRows: 4,
    cost: 10_000,
    floorColor: 0xe0a9a9,
    staffedBy: ['doctor', 'nurse'],
    props: [{ id: 'traumaBed', walkable: false, count: 1 }],
  },
  atrium: {
    label: 'Atrium',
    kind: 'open',
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
