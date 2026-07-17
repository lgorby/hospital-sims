import type { RoleId } from './roles';

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
  },
  waiting: {
    label: 'Waiting Room',
    kind: 'treatment',
    minCols: 3,
    minRows: 3,
    cost: 1_000,
    floorColor: 0xc9d9b1,
    staffedBy: [],
  },
  triage: {
    label: 'Triage Bay',
    kind: 'treatment',
    minCols: 2,
    minRows: 2,
    cost: 1_500,
    floorColor: 0xf0d1a0,
    staffedBy: ['nurse'],
  },
  exam: {
    label: 'Exam Room',
    kind: 'treatment',
    minCols: 3,
    minRows: 3,
    cost: 3_000,
    floorColor: 0xaacbe0,
    staffedBy: ['doctor', 'nurse'],
  },
  xray: {
    label: 'X-Ray',
    kind: 'treatment',
    minCols: 3,
    minRows: 4,
    cost: 8_000,
    floorColor: 0xb9b1c9,
    staffedBy: ['radTech'],
  },
  resp: {
    label: 'Respiratory Therapy',
    kind: 'treatment',
    minCols: 3,
    minRows: 3,
    cost: 5_000,
    floorColor: 0xa9d9c9,
    staffedBy: ['respTherapist'],
  },
  er: {
    label: 'ER Bay',
    kind: 'treatment',
    minCols: 3,
    minRows: 4,
    cost: 10_000,
    floorColor: 0xe0a9a9,
    staffedBy: ['doctor', 'nurse'],
  },
  atrium: {
    label: 'Atrium',
    kind: 'open',
    minCols: 4,
    minRows: 4,
    cost: 4_000,
    floorColor: 0xd0e8d0,
    staffedBy: ['greeter'],
  },
} as const satisfies Record<string, RoomDef>;

export type RoomType = keyof typeof ROOM_DEFS;
export const ROOM_TYPES = Object.keys(ROOM_DEFS) as RoomType[];

/** Waiting room chair count included in the base build (GDD §5). */
export const WAITING_ROOM_BASE_CHAIRS = 6;
