import { Graphics, type Renderer, type Texture } from 'pixi.js';
import { ROLE_DEFS, ROLE_IDS, type RoleId } from '../sim/data/roles';
import { PROP_STYLE, type PropId } from '../sim/data/rooms';
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
  /** Per-tile prop slices, keyed `${PropId}:${'single'|'west'|'east'}` (§2.5 slicing). */
  props: Map<string, Texture>;
}

/** Every prop texture is padded to the same canvas so placement math is uniform. */
export const PROP_RISE_PAD = 24;

export type PropSlice = 'single' | 'west' | 'east';

export function propKey(id: PropId, slice: PropSlice): string {
  return `${id}:${slice}`;
}

function diamond(g: Graphics, fill: number, alpha = 1): Graphics {
  return g
    .poly([TILE_W / 2, 0, TILE_W, TILE_H / 2, TILE_W / 2, TILE_H, 0, TILE_H / 2])
    .fill({ color: fill, alpha });
}

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
  if ((id === 'bed' || id === 'traumaBed') && slice !== 'east') {
    // Pillow on the head end
    g.ellipse(TILE_W / 2, TILE_H / 2 - rise - 2, 12, 6).fill(0xffffff);
  }
  if (id === 'chair') {
    // Little backrest so seats read at a glance.
    g.poly([0, TILE_H / 2 - rise, TILE_W / 2, TILE_H / 4 - rise, TILE_W / 2, TILE_H / 4 - rise - 8, 0, TILE_H / 2 - rise - 8])
      .fill(shade(color, 0.9));
  }
  return g;
}

export function generateTileTextures(renderer: Renderer): TileTextures {
  const groundA = diamond(new Graphics(), 0xd8d3c8).stroke({ color: 0xc4bfb2, width: 1 });
  const groundB = diamond(new Graphics(), 0xcfc9bd).stroke({ color: 0xc4bfb2, width: 1 });
  const plain = diamond(new Graphics(), 0xffffff);
  const highlight = diamond(new Graphics(), 0xffe066, 0.55).stroke({ color: 0xe0a800, width: 2 });
  const marker = diamond(new Graphics(), 0x2a9d8f, 0.85).stroke({ color: 0x1d6f66, width: 2 });
  const entrance = diamond(new Graphics(), 0x8a6f4d).stroke({ color: 0x6b5439, width: 2 });

  const props = new Map<string, Texture>();
  for (const id of Object.keys(PROP_STYLE) as PropId[]) {
    const slices: PropSlice[] =
      PROP_STYLE[id].tiles > 1 ? ['single', 'west', 'east'] : ['single'];
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

// --------------------------------------------------------------- characters
//
// "Placeholder-plus": still 100% procedural, but with role silhouettes, limbs,
// a 4-frame walk cycle, and per-person skin/hair variety. The renderer looks
// textures up through characterKey() — exactly the contract a sprite atlas
// will satisfy later (§2.6), so the future art pass changes nothing here.

export type CharacterKind = RoleId | 'patient';
/** Frame 0 = idle; frames 1..4 = walk cycle. */
export const CHARACTER_FRAMES = 5;
export const PATIENT_VARIANTS = 8;
export const STAFF_VARIANTS = 4;
/** Feet anchor inside the padded texture (pad rect spans x −9..9, y −46..1). */
export const FEET_ANCHOR = { x: 0.5, y: 46 / 47 };

const SKIN_TONES = [0xf2c9a8, 0xd9a377, 0xb07b4f, 0x8a5a3a] as const;
const HAIR_COLORS = [0x3b2f2f, 0x6e4f2f, 0xc7873a, 0x8f8f8f] as const;
const GOWN_COLOR = 0xdfe8f5;
const GOWN_TRIM = 0x9fb0c5;
const PATIENT_PANTS = 0xb9c8de;
const COAT_WHITE = 0xf4f4f0;
const COAT_SHIRT = 0x51698a;

interface WalkPhase {
  /** Horizontal leg split (px). */
  split: number;
  /** Body bob (px, negative = up). */
  bob: number;
  /** Arm swing (px, applied ± to the two arms). */
  arm: number;
}

const PHASES: readonly WalkPhase[] = [
  { split: 1, bob: 0, arm: 0 }, // idle
  { split: 4, bob: 0, arm: 2 },
  { split: 1, bob: -1, arm: 0 },
  { split: -4, bob: 0, arm: -2 },
  { split: 1, bob: -1, arm: 0 },
];

function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.floor(((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.floor(((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.floor((color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}

function drawCharacter(kind: CharacterKind, skin: number, hair: number, frame: number): Graphics {
  const g = new Graphics();
  // Padding rect pins texture bounds to exactly (−9,−46)..(9,1) so the feet
  // anchor is a constant fraction for every kind/frame.
  g.rect(-9, -46, 18, 47).fill({ color: 0xffffff, alpha: 0.001 });

  const { split, bob, arm } = PHASES[frame]!;
  const isPatient = kind === 'patient';
  const outfit = isPatient ? GOWN_COLOR : ROLE_DEFS[kind].color;
  const pants = isPatient ? PATIENT_PANTS : shade(outfit, 0.55);
  const sleeve = kind === 'doctor' ? COAT_WHITE : outfit;

  // Contact shadow
  g.ellipse(0, -2, 8, 3.5).fill({ color: 0x000000, alpha: 0.18 });
  // Legs
  g.roundRect(-5 - split, -12 + bob, 4, 12, 2).fill(pants);
  g.roundRect(1 + split, -12 + bob, 4, 12, 2).fill(pants);
  // Arms (swing opposite phases)
  g.roundRect(-9, -28 + bob - arm, 3, 11, 2).fill(sleeve);
  g.roundRect(6, -28 + bob + arm, 3, 11, 2).fill(sleeve);
  // Torso
  if (kind === 'doctor') {
    // White coat over a shirt: coat body, center gap, collar V.
    g.roundRect(-8, -30 + bob, 16, 20, 4)
      .fill(COAT_WHITE)
      .stroke({ color: 0xc9c9c2, width: 1 });
    g.rect(-1, -28 + bob, 2, 18).fill(COAT_SHIRT);
    g.poly([-4, -30 + bob, 4, -30 + bob, 0, -25 + bob]).fill(COAT_SHIRT);
  } else if (isPatient) {
    g.roundRect(-8, -30 + bob, 16, 20, 4)
      .fill(GOWN_COLOR)
      .stroke({ color: GOWN_TRIM, width: 1 });
    g.rect(-8, -14 + bob, 16, 2).fill(shade(GOWN_COLOR, 0.85)); // gown hem
  } else {
    g.roundRect(-8, -30 + bob, 16, 20, 4)
      .fill(outfit)
      .stroke({ color: shade(outfit, 0.7), width: 1 });
    g.rect(-3, -30 + bob, 6, 3).fill(shade(outfit, 0.8)); // neckline
  }
  // Head: hair/cap behind, face in front.
  const headY = -36 + bob;
  const scrubCap = kind === 'nurse' || kind === 'respTherapist';
  if (scrubCap) {
    g.circle(0, headY - 2, 6.2).fill(shade(outfit, 0.9));
  } else {
    g.circle(0, headY - 1.5, 6.2).fill(hair);
  }
  g.ellipse(0, headY + 0.5, 5.4, 5.4).fill(skin);
  return g;
}

export function characterKey(kind: CharacterKind, variant: number, frame: number): string {
  return `${kind}:${variant}:${frame}`;
}

/** Deterministic per-entity look — id-hashed, never touching the sim RNG. */
export function variantFor(kind: CharacterKind, entityId: number): number {
  return entityId % (kind === 'patient' ? PATIENT_VARIANTS : STAFF_VARIANTS);
}

export function generateCharacterTextures(renderer: Renderer): Map<string, Texture> {
  const textures = new Map<string, Texture>();
  const kinds: CharacterKind[] = ['patient', ...ROLE_IDS];
  for (const kind of kinds) {
    const variants = kind === 'patient' ? PATIENT_VARIANTS : STAFF_VARIANTS;
    for (let variant = 0; variant < variants; variant++) {
      const skin = SKIN_TONES[variant % SKIN_TONES.length]!;
      const hair = HAIR_COLORS[(variant * 3 + 1) % HAIR_COLORS.length]!;
      for (let frame = 0; frame < CHARACTER_FRAMES; frame++) {
        textures.set(
          characterKey(kind, variant, frame),
          renderer.generateTexture(drawCharacter(kind, skin, hair, frame)),
        );
      }
    }
  }
  return textures;
}
