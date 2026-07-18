/**
 * SSOT for freestanding amenity props (amenities epic Stage 1,
 * AMENITIES_PLAN §3.4) — the game's first roomless placeable props. Costs
 * live here (§3.1 rule 1); art (color/rise/tiles) lives in PROP_STYLE like
 * every other prop (the deliberate two-table split — same fact never twice).
 *
 * RULE (§3.4, test-enforced): every amenity is placed NON-walkable. The
 * room build/expand "Blocked by an object" rejection is what stops rooms
 * being stamped over amenities — a walkable amenity would silently lose
 * that protection.
 */
export const AMENITY_DEFS = {
  trashcan: { label: 'Trashcan', cost: 150 },
  vending: { label: 'Vending Machine', cost: 1_200 },
  plant: { label: 'Plant', cost: 300 },
} as const satisfies Record<string, { label: string; cost: number }>;

export type AmenityId = keyof typeof AMENITY_DEFS;
export const AMENITY_IDS = Object.keys(AMENITY_DEFS) as AmenityId[];
