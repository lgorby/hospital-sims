import { Graphics, type Renderer, type Texture } from 'pixi.js';
import { TILE_H, TILE_W } from './iso';

/**
 * Runtime-generated placeholder textures (tech plan §2.6): this module is the
 * single texture source. When the art pass lands, these functions read a
 * sprite atlas instead — callers never change.
 */
export interface TileTextures {
  /** Two ground shades for a subtle checkerboard. */
  ground: [Texture, Texture];
  /** White diamond for tinting: room floors, build ghosts. */
  plain: Texture;
  highlight: Texture;
  marker: Texture;
  entrance: Texture;
  /** One 2-tile bed sliced into two per-tile textures (west half, east half). */
  bedWest: Texture;
  bedEast: Texture;
  /** Capsule person, anchored at the feet. */
  patient: Texture;
}

function diamond(g: Graphics, fill: number, alpha = 1): Graphics {
  return g
    .poly([TILE_W / 2, 0, TILE_W, TILE_H / 2, TILE_W / 2, TILE_H, 0, TILE_H / 2])
    .fill({ color: fill, alpha });
}

/** A box prism filling one tile — the per-tile slice of multi-tile furniture. */
function bedSlice(westHalf: boolean): Graphics {
  const g = new Graphics();
  const rise = 12;
  const top = [TILE_W / 2, -rise, TILE_W, TILE_H / 2 - rise, TILE_W / 2, TILE_H - rise, 0, TILE_H / 2 - rise];
  // South-east face
  g.poly([TILE_W / 2, TILE_H - rise, TILE_W, TILE_H / 2 - rise, TILE_W, TILE_H / 2, TILE_W / 2, TILE_H]).fill(0x5d7fa3);
  // South-west face
  g.poly([0, TILE_H / 2 - rise, TILE_W / 2, TILE_H - rise, TILE_W / 2, TILE_H, 0, TILE_H / 2]).fill(0x6f94ba);
  // Mattress top
  g.poly(top).fill(westHalf ? 0xd7e3f0 : 0xbcd0e6);
  if (westHalf) {
    // Pillow on the west slice
    g.ellipse(TILE_W / 2, TILE_H / 2 - rise - 2, 12, 6).fill(0xffffff);
  }
  return g;
}

function person(): Graphics {
  const g = new Graphics();
  // Near-invisible padding rect pins the texture bounds to exactly
  // (-8,-44)..(8,1) so the renderer's PERSON_OFFSET stays trivially correct.
  g.rect(-8, -44, 16, 45).fill({ color: 0xffffff, alpha: 0.001 });
  // Feet at (0,0) in local space; drawn upward. Gown-colored capsule + head.
  g.ellipse(0, -4, 7, 4).fill({ color: 0x000000, alpha: 0.18 }); // contact shadow
  g.roundRect(-7, -30, 14, 26, 7).fill(0xdfe8f5).stroke({ color: 0x9fb0c5, width: 1 });
  g.circle(0, -36, 7).fill(0xf2c9a8).stroke({ color: 0xc9a184, width: 1 });
  return g;
}

export function generateTileTextures(renderer: Renderer): TileTextures {
  const groundA = diamond(new Graphics(), 0xd8d3c8).stroke({ color: 0xc4bfb2, width: 1 });
  const groundB = diamond(new Graphics(), 0xcfc9bd).stroke({ color: 0xc4bfb2, width: 1 });
  const plain = diamond(new Graphics(), 0xffffff);
  const highlight = diamond(new Graphics(), 0xffe066, 0.55).stroke({ color: 0xe0a800, width: 2 });
  const marker = diamond(new Graphics(), 0x2a9d8f, 0.85).stroke({ color: 0x1d6f66, width: 2 });
  const entrance = diamond(new Graphics(), 0x8a6f4d).stroke({ color: 0x6b5439, width: 2 });

  return {
    ground: [renderer.generateTexture(groundA), renderer.generateTexture(groundB)],
    plain: renderer.generateTexture(plain),
    highlight: renderer.generateTexture(highlight),
    marker: renderer.generateTexture(marker),
    entrance: renderer.generateTexture(entrance),
    bedWest: renderer.generateTexture(bedSlice(true)),
    bedEast: renderer.generateTexture(bedSlice(false)),
    patient: renderer.generateTexture(person()),
  };
}
