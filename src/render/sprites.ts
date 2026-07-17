import { Graphics, type Renderer, type Texture } from 'pixi.js';
import { PROP_STYLE, type PropId } from '../sim/data/rooms';
import { PROP_RISE_PAD, shade, TILE_H, TILE_W } from './sprites/shared';

/**
 * Tile + prop textures (100% procedural, tech plan §2.6) AND the barrel that
 * re-exports the character module + shared contract, so the renderer keeps a
 * single `from './sprites'` import surface. When the art pass lands, these
 * read a sprite atlas instead — callers never change.
 *
 * ART PASS (this milestone) owns: ground tiles, room floors, props/equipment,
 * and (in renderer.ts) walls + scene compositing. INVARIANTS: strip length
 * lives ONLY in `PROP_STYLE[id].tiles`; the `propKey` lookup contract is
 * frozen; every prop texture keeps identical bounds via the PROP_RISE_PAD
 * padding rect so placement math stays uniform.
 */

// Re-exports so `./sprites` remains the one render-art import surface.
export * from './sprites/shared';
export * from './sprites/characters';

export interface TileTextures {
  /** Two ground shades for a subtle checkerboard. */
  ground: [Texture, Texture];
  /** Near-white soft-shaded diamond for tinting room floors by `def.floorColor`. */
  plain: Texture;
  highlight: Texture;
  marker: Texture;
  entrance: Texture;
  /** Per-tile prop slices, keyed `${PropId}:${'single'|'west'|'east'}` (§2.5 slicing). */
  props: Map<string, Texture>;
}

export type PropSlice = 'single' | 'west' | 'east';

export function propKey(id: PropId, slice: PropSlice): string {
  return `${id}:${slice}`;
}

/** Tile diamond outline (center-top origin), shared by every ground/floor tile. */
const DIAMOND: readonly number[] = [
  TILE_W / 2, 0,
  TILE_W, TILE_H / 2,
  TILE_W / 2, TILE_H,
  0, TILE_H / 2,
];
/** Upper / lower halves of the diamond — soft directional-light shading. */
const DIAMOND_TOP: readonly number[] = [TILE_W / 2, 0, TILE_W, TILE_H / 2, 0, TILE_H / 2];
const DIAMOND_BOTTOM: readonly number[] = [0, TILE_H / 2, TILE_W, TILE_H / 2, TILE_W / 2, TILE_H];

/** Diamond scaled toward its center — used for inset seams / welcome-mat rings. */
function scaledDiamond(k: number): number[] {
  const cx = TILE_W / 2;
  const cy = TILE_H / 2;
  const out: number[] = [];
  for (let i = 0; i < DIAMOND.length; i += 2) {
    out.push(cx + (DIAMOND[i]! - cx) * k, cy + (DIAMOND[i + 1]! - cy) * k);
  }
  return out;
}

function diamond(g: Graphics, fill: number, alpha = 1): Graphics {
  return g.poly(DIAMOND as number[]).fill({ color: fill, alpha });
}

/**
 * Soft-shaded ground tile: a gently lit upper half, a shadowed lower half, and
 * a faint inset seam so the floor reads as *laid tiles* rather than a flat
 * checkerboard — the "RCT warmth" backdrop. Kept low-contrast on purpose; the
 * two parity shades still carry the checker, this just adds volume.
 */
function groundTile(base: number): Graphics {
  const g = new Graphics();
  g.poly(DIAMOND as number[]).fill(base);
  g.poly(DIAMOND_TOP as number[]).fill({ color: shade(base, 1.05), alpha: 0.5 });
  g.poly(DIAMOND_BOTTOM as number[]).fill({ color: shade(base, 0.9), alpha: 0.35 });
  g.poly(scaledDiamond(0.8)).stroke({ color: shade(base, 0.86), width: 1, alpha: 0.3 });
  g.poly(DIAMOND as number[]).stroke({ color: shade(base, 0.8), width: 1, alpha: 0.5 });
  return g;
}

/**
 * Room-floor base, tinted per-room by `def.floorColor` (SSOT). Near-white so
 * the tint reads true, with a lit top / shadowed bottom gradient and an inner
 * border ring — so a floor reads as an inviting *room*, not a colored patch.
 * Shading is baked as grayscale and multiplies under the tint.
 */
function floorTile(): Graphics {
  const g = new Graphics();
  g.poly(DIAMOND as number[]).fill(0xe8e8e8);
  g.poly(DIAMOND_TOP as number[]).fill({ color: 0xffffff, alpha: 0.7 });
  g.poly(DIAMOND_BOTTOM as number[]).fill({ color: 0x000000, alpha: 0.1 });
  g.poly(scaledDiamond(0.82)).stroke({ color: 0x000000, width: 1, alpha: 0.06 });
  g.poly(DIAMOND as number[]).stroke({ color: 0x000000, width: 1, alpha: 0.14 });
  return g;
}

/** Entrance mat — kept clearly readable: warm brown with a lighter welcome-mat center. */
function entranceTile(): Graphics {
  const base = 0x8a6f4d;
  const g = new Graphics();
  g.poly(DIAMOND as number[]).fill(base);
  g.poly(scaledDiamond(0.72)).fill(shade(base, 1.14));
  g.poly(scaledDiamond(0.72)).stroke({ color: shade(base, 0.78), width: 1 });
  g.poly(DIAMOND as number[]).stroke({ color: 0x6b5439, width: 2 });
  return g;
}

/**
 * Placeholder-art embellishments drawn on top of the generic prism. Typed
 * against PropId so a typo'd id is a compile error; Partial means any id
 * absent here renders as a plain prism by default — a brand-new prop needs
 * NO code in this file. Placeholder paint only: the atlas lookup contract
 * (`propKey`, §2.6) is untouched, and strip length still lives ONLY in
 * `PROP_STYLE[id].tiles`.
 */
type PropDecor = 'pillow' | 'backrest' | 'monitor' | 'panel' | 'basin';
const PROP_DECOR: Readonly<Partial<Record<PropId, PropDecor>>> = {
  // Beds/tables patients lie on get a pillow at the head end.
  bed: 'pillow',
  traumaBed: 'pillow',
  orTable: 'pillow',
  chair: 'backrest',
  // Desks & carts read as workstations with a small monitor on top.
  desk: 'monitor',
  helpDesk: 'monitor',
  vitalsCart: 'monitor',
  ultrasoundCart: 'monitor',
  anesthesiaCart: 'monitor',
  // Big imaging machines get a recessed front control panel + status light.
  xrayMachine: 'panel',
  ctGantry: 'panel',
  mriBore: 'panel',
  gammaCamera: 'panel',
  shieldScreen: 'panel',
  // Wet-work stations read as a basin sunk into the top surface.
  scrubSink: 'basin',
  dialysisMachine: 'basin',
  nebulizer: 'basin',
  hotLabBench: 'basin',
};

/** A box prism filling one tile — the per-tile slice of (multi-tile) furniture. */
function propSlice(id: PropId, slice: PropSlice): Graphics {
  const { color, rise } = PROP_STYLE[id];
  const g = new Graphics();
  // Constant padding rect → identical texture bounds for every prop/slice.
  g.rect(0, -PROP_RISE_PAD, TILE_W, TILE_H + PROP_RISE_PAD).fill({ color: 0xffffff, alpha: 0.001 });
  const top = [
    TILE_W / 2, -rise,
    TILE_W, TILE_H / 2 - rise,
    TILE_W / 2, TILE_H - rise,
    0, TILE_H / 2 - rise,
  ];
  // South-east face
  g.poly([TILE_W / 2, TILE_H - rise, TILE_W, TILE_H / 2 - rise, TILE_W, TILE_H / 2, TILE_W / 2, TILE_H])
    .fill(shade(color, 0.62));
  // South-west face
  g.poly([0, TILE_H / 2 - rise, TILE_W / 2, TILE_H - rise, TILE_W / 2, TILE_H, 0, TILE_H / 2])
    .fill(shade(color, 0.78));
  // Top face — west slices slightly lighter so strips read as one object.
  g.poly(top).fill(slice === 'west' ? shade(color, 1.12) : color);
  // Soft highlight rim along the lit top edges — gives the prism a little pop.
  g.poly([0, TILE_H / 2 - rise, TILE_W / 2, -rise, TILE_W, TILE_H / 2 - rise])
    .stroke({ color: shade(color, 1.28), width: 1, alpha: 0.55 });

  const decor = PROP_DECOR[id];
  const headEnd = slice !== 'east'; // single-ended decor lives on the west/single slice
  if (decor === 'pillow' && headEnd) {
    // Pillow on the head end (west slice of a strip, or a single tile).
    g.ellipse(TILE_W / 2, TILE_H / 2 - rise - 2, 12, 6).fill(0xffffff);
  } else if (decor === 'backrest') {
    // Little backrest so seats read at a glance.
    g.poly([0, TILE_H / 2 - rise, TILE_W / 2, TILE_H / 4 - rise, TILE_W / 2, TILE_H / 4 - rise - 8, 0, TILE_H / 2 - rise - 8])
      .fill(shade(color, 0.9));
  } else if (decor === 'monitor' && headEnd) {
    // A small screen perched on the back of the top surface → a workstation.
    const sy = -rise - 6;
    g.rect(TILE_W / 2 - 3, sy + 3, 6, 5).fill(shade(color, 0.7)); // stand
    g.rect(TILE_W / 2 - 9, sy - 2, 18, 8).fill(shade(color, 0.42)); // screen
    g.rect(TILE_W / 2 - 7, sy, 14, 3).fill(shade(color, 1.25)); // screen glow
  } else if (decor === 'basin') {
    // A basin sunk into the top surface → sink / dialysis / nebulizer tub.
    g.ellipse(TILE_W / 2, TILE_H / 2 - rise, 13, 6).fill(shade(color, 0.58));
    g.ellipse(TILE_W / 2, TILE_H / 2 - rise - 1, 9, 4).fill(shade(color, 0.85));
  } else if (decor === 'panel') {
    // Recessed control panel with a status light on the SE (front) face.
    // Face basis: base corner + u (along top toward SE) + v (downward).
    const bx = TILE_W / 2;
    const by = TILE_H - rise;
    const ux = TILE_W / 2;
    const uy = -rise;
    const at = (a: number, b: number): [number, number] => [bx + ux * a, by + uy * a + rise * b];
    g.poly([...at(0.28, 0.2), ...at(0.72, 0.2), ...at(0.72, 0.8), ...at(0.28, 0.8)])
      .fill(shade(color, 0.5));
    const [lx, ly] = at(0.6, 0.42);
    g.circle(lx, ly, 1.6).fill(shade(color, 1.6));
  }
  return g;
}

export function generateTileTextures(renderer: Renderer): TileTextures {
  const groundA = groundTile(0xd8d3c8);
  const groundB = groundTile(0xcfc9bd);
  const plain = floorTile();
  const highlight = diamond(new Graphics(), 0xffe066, 0.55).stroke({ color: 0xe0a800, width: 2 });
  const marker = diamond(new Graphics(), 0x2a9d8f, 0.85).stroke({ color: 0x1d6f66, width: 2 });
  const entrance = entranceTile();

  const props = new Map<string, Texture>();
  for (const id of Object.keys(PROP_STYLE) as PropId[]) {
    const slices: PropSlice[] = PROP_STYLE[id].tiles > 1 ? ['single', 'west', 'east'] : ['single'];
    for (const slice of slices) {
      props.set(propKey(id, slice), renderer.generateTexture(propSlice(id, slice)));
    }
  }

  return {
    ground: [renderer.generateTexture(groundA), renderer.generateTexture(groundB)],
    plain: renderer.generateTexture(plain),
    highlight: renderer.generateTexture(highlight),
    marker: renderer.generateTexture(marker),
    entrance: renderer.generateTexture(entrance),
    props,
  };
}
