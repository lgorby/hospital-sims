/**
 * Pure builder for the build / expand / amenity ghost's revalidation key
 * (`WorldRenderer.drawGhost`). The ghost re-runs its validators — which read
 * live cash, geometry and actors — ONLY when this key changes, keeping the
 * `draw()` hot path off a per-frame revalidation.
 *
 * The key must therefore capture EVERY input the validators read, and that
 * includes `cash`: `validateRoomRect` / `validateRoomExpand` /
 * `validateAmenityPlace` all fail with "Not enough cash" (`sim/build.ts`), and
 * cash can change WITHOUT the sim tick advancing — build / sell / place-amenity
 * commands apply while the game is PAUSED (the "build while paused" contract),
 * where the tick is frozen. Keying freshness on the tick alone therefore left a
 * stale-GREEN ghost after a paused spend (a player could not afford the room
 * the ghost still said was placeable). This is a Pixi-free pure function so the
 * regression lives in the renderer-free suite (`test/ghostKey.test.ts`).
 */
export interface GhostKeyInput {
  /** Sim tick — changes ≤10×/s while running; frozen while paused. */
  tick: number;
  /** Live cash — the input the tick used to (wrongly) stand in for. */
  cash: number;
  // Ids/kinds are only ever interpolated into the key string, so accept
  // whatever the sim uses for them (room ids are numbers, kinds are strings).
  /** Armed amenity kind, or null. Takes priority (modes are exclusive). */
  amenity: string | number | null;
  buildType: string | number | null;
  buildPhase: string | null;
  expandRoomId: string | number | null;
  rect: { col: number; row: number; cols: number; rows: number } | null;
  hoveredTile: { col: number; row: number } | null;
}

export function ghostValidityKey(i: GhostKeyInput): string {
  // Guards test `=== null` (the renderer passes `?? null` for absent modes),
  // NOT truthiness — an id of 0 or an empty-string kind must not collapse a
  // real armed tool into the "no ghost" branch (review NIT; ids start at 1
  // today, so this is robustness, matching the old object-presence keying).
  if (i.amenity !== null) {
    return (
      `amenity:${i.amenity}:${i.tick}:${i.cash}:` +
      `${i.hoveredTile ? `${i.hoveredTile.col},${i.hoveredTile.row}` : 'off'}`
    );
  }
  if (i.buildType === null && i.expandRoomId === null) return '';
  const mode = i.buildType !== null ? `${i.buildType}:${i.buildPhase}` : `expand:${i.expandRoomId}`;
  const rect = i.rect ? `${i.rect.col},${i.rect.row},${i.rect.cols},${i.rect.rows}` : 'none';
  const door =
    i.buildType !== null && i.buildPhase === 'door' && i.hoveredTile
      ? `${i.hoveredTile.col},${i.hoveredTile.row}`
      : '-';
  return `${mode}:${i.tick}:${i.cash}:${rect}:${door}`;
}
