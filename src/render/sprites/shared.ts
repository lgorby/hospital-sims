import { TILE_H, TILE_W } from '../iso';

/**
 * Shared render-art primitives + the FACING CONTRACT (frozen — do not edit as
 * part of the art pass; both the character module and the tile/prop module
 * read from here). Splitting these out keeps `characters.ts` and `sprites.ts`
 * free of an import cycle.
 */

export { TILE_H, TILE_W };

/** Multiply an RGB hex by `factor` per channel (shading/tinting placeholder art). */
export function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.floor(((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.floor(((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.floor((color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}

/** Every prop texture is padded to the same canvas so placement math is uniform. */
export const PROP_RISE_PAD = 24;

/**
 * The four diagonal facings an actor can walk in 2:1 iso (tech plan §2.6).
 * Grid steps are orthogonal, so each maps to exactly one screen diagonal:
 *   +col → SE, −col → NW, +row → SW, −row → NE.
 * NE/NW may be produced by mirroring SE/SW at texture-generation time (the
 * contract only requires the four KEYS exist — how they're drawn is art).
 */
export type Facing = 'NE' | 'NW' | 'SE' | 'SW';
export const FACINGS: readonly Facing[] = ['NE', 'NW', 'SE', 'SW'];

/** Resting facing for a standing actor — toward the viewer (down-screen). */
export const IDLE_FACING: Facing = 'SE';

/** Grid step (dcol,drow) → screen facing. Diagonal steps never occur in V1. */
export function facingFromStep(dcol: number, drow: number): Facing {
  if (dcol > 0) return 'SE';
  if (dcol < 0) return 'NW';
  if (drow > 0) return 'SW';
  if (drow < 0) return 'NE';
  return IDLE_FACING;
}
