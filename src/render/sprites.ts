import { Graphics, type Renderer, type Texture } from 'pixi.js';
import { PROP_STYLE, type PropId, type RoomFailure } from '../sim/data/rooms';
import type { Mess } from '../sim/world';
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
  /** Flat ground-level mess decals (amenities Stage 2, §4.1), keyed by
   *  `messKey(kind, variant)` — the renderer picks variant + mirror by
   *  hashing TILE coords (never rng), so a mess always re-syncs identically. */
  messes: Map<string, Texture>;
  /** Broken-room hazard decals (Stage 3, §S3.7), keyed by `hazardKey(kind)` —
   *  sparks for mechanical failures, steam-and-drip for piping. One variant
   *  per kind; the renderer's mirror bit hashes the anchor tile (never rng). */
  hazards: Map<string, Texture>;
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
type PropDecor = 'pillow' | 'backrest' | 'monitor' | 'panel' | 'basin' | 'toilet' | 'vendingFront';
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
  // Amenities Stage 1: the restroom fixture + the vending machine keep the
  // prism silhouette and add readable decor; trashcan/plant are full custom
  // silhouettes (see CUSTOM_PROPS) — a diamond prism can't read as a bin/pot.
  toiletStall: 'toilet',
  vending: 'vendingFront',
};

/** Fixed product palette for the vending glass front — deterministic, no rng. */
const VENDING_PRODUCT_COLORS: readonly number[] = [0xffd166, 0x7ec8e3, 0x9ade7c, 0xf49f6e];

/**
 * Cylindrical lidded bin — replaces the prism entirely (a gray diamond box
 * read as "crate", not "trashcan"). Same padded canvas; all coords stay
 * inside the PROP_RISE_PAD bounds so placement math is untouched.
 */
function trashcanProp(g: Graphics, color: number, rise: number): void {
  const cx = TILE_W / 2;
  const rx = 11; // bin radius (screen px)
  const bottomY = TILE_H / 2 + 8;
  const topY = bottomY - (rise + 8); // a bin is taller than its prism rise
  // Ground contact shadow.
  g.ellipse(cx, bottomY + 2, rx + 3, 5).fill({ color: 0x000000, alpha: 0.15 });
  // Base cap + body cylinder.
  g.ellipse(cx, bottomY, rx, 5).fill(shade(color, 0.8));
  g.rect(cx - rx, topY, rx * 2, bottomY - topY).fill(shade(color, 0.92));
  // Vertical shading: lit toward the NW light, shadowed on the SE side.
  g.rect(cx - rx, topY, 6, bottomY - topY).fill({ color: shade(color, 1.18), alpha: 0.7 });
  g.rect(cx + rx - 7, topY, 7, bottomY - topY).fill({ color: shade(color, 0.68), alpha: 0.7 });
  // Two rolled ribs so the body reads as sheet metal.
  g.rect(cx - rx, topY + 5, rx * 2, 1.5).fill({ color: shade(color, 0.75), alpha: 0.8 });
  g.rect(cx - rx, bottomY - 6, rx * 2, 1.5).fill({ color: shade(color, 0.75), alpha: 0.8 });
  // Domed lid with a handle knob.
  g.ellipse(cx, topY, rx + 1.5, 5.5).fill(shade(color, 1.15));
  g.ellipse(cx, topY, rx + 1.5, 5.5).stroke({ color: shade(color, 0.6), width: 1 });
  g.ellipse(cx, topY - 2, rx - 4, 3.5).fill(shade(color, 1.28));
  g.ellipse(cx, topY - 3, 3, 1.8).fill(shade(color, 0.7));
}

/**
 * Potted plant — terracotta pot + a leafy cluster in shades of the SSOT green.
 * Replaces the prism (a green diamond box read as "hedge cube"). Deterministic
 * fixed offsets, no rng; bounds stay inside the shared padding rect.
 */
function plantProp(g: Graphics, color: number): void {
  const cx = TILE_W / 2;
  const pot = 0xb0714f;
  // Ground contact shadow.
  g.ellipse(cx, TILE_H / 2 + 4, 12, 5).fill({ color: 0x000000, alpha: 0.15 });
  // Pot: tapered body, lit rim band, darker base cap.
  g.poly([cx - 9, 10, cx + 9, 10, cx + 6, 20, cx - 6, 20]).fill(pot);
  g.poly([cx - 9, 10, cx + 9, 10, cx + 8.2, 13, cx - 8.2, 13]).fill(shade(pot, 1.18));
  g.ellipse(cx, 20, 6, 2.5).fill(shade(pot, 0.75));
  g.poly([cx + 3, 10, cx + 9, 10, cx + 6, 20, cx + 2, 20]).fill({ color: shade(pot, 0.78), alpha: 0.7 });
  // Foliage cluster: overlapping blobs, lit on the NW side, shadowed on the SE.
  g.ellipse(cx, 0, 12, 9).fill(color);
  g.ellipse(cx - 7, 3, 8, 6.5).fill(shade(color, 1.14));
  g.ellipse(cx + 7, 3, 8, 6.5).fill(shade(color, 0.82));
  g.ellipse(cx, -7, 7, 5.5).fill(shade(color, 1.22));
  // Leaf glints.
  g.ellipse(cx - 4, -4, 2.5, 1.5).fill({ color: shade(color, 1.5), alpha: 0.8 });
  g.ellipse(cx + 3, -8, 2, 1.2).fill({ color: shade(color, 1.5), alpha: 0.6 });
}

/** Amenity props whose whole silhouette is custom (never the generic prism). */
const CUSTOM_PROPS: Readonly<Partial<Record<PropId, (g: Graphics, color: number, rise: number) => void>>> = {
  trashcan: trashcanProp,
  plant: (g, color) => plantProp(g, color),
};

// ------------------------------------------------ mess decals (Stage 2, §4.1)

/**
 * Shape variants generated per mess kind. The renderer picks one (plus a
 * mirror bit) by hashing TILE coords at draw time — 6 distinct looks per kind,
 * stable across re-syncs of the same tile (render invariant: variety is
 * hashed, never rolled).
 */
export const MESS_VARIANTS = 3;

export function messKey(kind: Mess['kind'], variant: number): string {
  return `mess:${kind}:${variant}`;
}

/**
 * Deterministic init-time jitter in [0,1) — an integer mix of (variant, i),
 * never Math.random. Purely a texture-generation helper: the same inputs
 * always paint the same decal, so textures are reproducible frame zero.
 */
function messJitter(variant: number, i: number): number {
  let h = (Math.imul(variant + 1, 374761393) + Math.imul(i + 1, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Vomit: an irregular sickly green-brown splat — overlapping flat (2:1)
 * ellipses so it never reads as a clean oval, a darker wet center, chunky
 * brown bits, and a few flung satellite droplets. FLAT on the ground plane
 * (all ellipses squashed 2:1 — no rise, decals are not prisms).
 */
function messVomit(g: Graphics, variant: number): void {
  const cx = TILE_W / 2;
  const cy = TILE_H / 2;
  const base = 0x8f8d4a; // sickly green-brown
  const chunk = 0x7a6b3c; // browner solids
  const j = (i: number, span: number): number => (messJitter(variant, i) - 0.5) * span;
  // Main splat body: three overlapping lobes.
  g.ellipse(cx + j(0, 6), cy + j(1, 3), 12 + j(2, 4), 6 + j(3, 2)).fill({ color: base, alpha: 0.92 });
  g.ellipse(cx + 6 + j(4, 5), cy + 2 + j(5, 3), 7, 3.6).fill({ color: shade(base, 0.9), alpha: 0.9 });
  g.ellipse(cx - 7 + j(6, 5), cy - 2 + j(7, 3), 6, 3).fill({ color: shade(base, 1.08), alpha: 0.9 });
  // Darker wet center.
  g.ellipse(cx + j(8, 4), cy + j(9, 2), 6.5, 3.2).fill({ color: shade(base, 0.72), alpha: 0.85 });
  // Chunky bits scattered over the pool.
  for (let i = 0; i < 5; i++) {
    const a = messJitter(variant, 10 + i) * Math.PI * 2;
    const d = 2 + messJitter(variant, 20 + i) * 6;
    g.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.5, 1.6, 0.9)
      .fill(shade(chunk, 0.9 + messJitter(variant, 30 + i) * 0.4));
  }
  // Satellite droplets flung past the rim.
  for (let i = 0; i < 3; i++) {
    const a = messJitter(variant, 40 + i) * Math.PI * 2;
    const d = 12 + messJitter(variant, 50 + i) * 4;
    g.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.5, 1.8, 1)
      .fill({ color: shade(base, 0.95), alpha: 0.85 });
  }
}

/**
 * Litter: scattered scraps — paper bits and wrappers in the vending-machine
 * product palette (the litter SOURCE is vending, so the colors rhyme), plus a
 * crumpled paper ball. Scraps are rotated flat quads squashed 2:1 onto the
 * ground plane, each with a sliver of drop shadow.
 */
function messLitter(g: Graphics, variant: number): void {
  const cx = TILE_W / 2;
  const cy = TILE_H / 2;
  const paper = 0xe8e4da;
  const j = (i: number, span: number): number => (messJitter(variant, i) - 0.5) * span;
  const scrap = (px: number, py: number, w: number, h: number, rot: number, color: number): void => {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const corners: readonly (readonly [number, number])[] = [[-w, -h], [w, -h], [w, h], [-w, h]];
    const at = (dy: number): number[] => {
      const pts: number[] = [];
      for (const [ox, oy] of corners) {
        pts.push(px + (ox * c - oy * s), py + (ox * s + oy * c) * 0.5 + dy);
      }
      return pts;
    };
    g.poly(at(0.8)).fill({ color: 0x000000, alpha: 0.1 }); // ground-contact shadow
    g.poly(at(0)).fill(color);
    g.poly(at(0)).stroke({ color: shade(color, 0.75), width: 0.6, alpha: 0.8 });
  };
  for (let i = 0; i < 6; i++) {
    const a = messJitter(variant, i) * Math.PI * 2;
    const d = 3 + messJitter(variant, 10 + i) * 9;
    const color =
      i % 2 === 0 ? paper : VENDING_PRODUCT_COLORS[(variant + i) % VENDING_PRODUCT_COLORS.length]!;
    scrap(
      cx + Math.cos(a) * d,
      cy + Math.sin(a) * d * 0.5,
      4.5 + messJitter(variant, 20 + i) * 3,
      2.2 + messJitter(variant, 30 + i) * 1.5,
      messJitter(variant, 40 + i) * Math.PI,
      color,
    );
  }
  // Crumpled paper ball — the one piece with a little height.
  const bx = cx + j(50, 12);
  const by = cy + j(51, 6);
  g.ellipse(bx, by + 1, 3.2, 1.4).fill({ color: 0x000000, alpha: 0.12 });
  g.circle(bx, by - 1, 2.6).fill(paper);
  g.circle(bx - 0.8, by - 1.8, 1.2).fill({ color: 0xffffff, alpha: 0.5 });
  g.circle(bx, by - 1, 2.6).stroke({ color: shade(paper, 0.8), width: 0.6 });
}

/**
 * Water: a translucent blue puddle with a sheen — pooled overlapping lobes, a
 * deeper center, NW-light glints (the wall/prop light convention), and a
 * bright rim so the edge reads on any floor color. No producer until Stage 3
 * (piping bursts) — the texture ships now so the atlas contract is complete.
 */
function messWater(g: Graphics, variant: number): void {
  const cx = TILE_W / 2;
  const cy = TILE_H / 2;
  const base = 0x4f86c2;
  const sheen = 0xdff0fa;
  const j = (i: number, span: number): number => (messJitter(variant, i) - 0.5) * span;
  // Pooled body: main lobe + two offset lobes for an irregular shoreline.
  g.ellipse(cx + j(0, 4), cy + j(1, 2), 13 + j(2, 3), 6.5 + j(3, 1.5)).fill({ color: base, alpha: 0.42 });
  g.ellipse(cx + 7 + j(4, 4), cy + 2 + j(5, 2), 7, 3.4).fill({ color: base, alpha: 0.38 });
  g.ellipse(cx - 8 + j(6, 4), cy - 2 + j(7, 2), 6, 3).fill({ color: base, alpha: 0.38 });
  // Deeper center.
  g.ellipse(cx + j(8, 3), cy + j(9, 1.5), 7, 3.4).fill({ color: shade(base, 0.8), alpha: 0.4 });
  // Sheen glints, lit from the NW.
  g.ellipse(cx - 4 + j(10, 3), cy - 2 + j(11, 1), 5, 1.6).fill({ color: sheen, alpha: 0.5 });
  g.ellipse(cx + 3 + j(12, 3), cy + 2 + j(13, 1), 2.4, 0.8).fill({ color: sheen, alpha: 0.35 });
  // Bright rim on the main lobe (same jitter indices → same geometry).
  g.ellipse(cx + j(0, 4), cy + j(1, 2), 13 + j(2, 3), 6.5 + j(3, 1.5))
    .stroke({ color: shade(base, 1.25), width: 1, alpha: 0.35 });
}

/** Exhaustive by construction: a new Mess kind is a compile error until painted. */
const MESS_PAINTERS: Readonly<Record<Mess['kind'], (g: Graphics, variant: number) => void>> = {
  vomit: messVomit,
  litter: messLitter,
  water: messWater,
};

/** One flat decal on the ground-tile canvas — positioned exactly like a ground
 *  tile (x − TILE_W/2, y), thanks to the constant near-invisible bounds rect. */
function messDecal(kind: Mess['kind'], variant: number): Graphics {
  const g = new Graphics();
  g.rect(0, 0, TILE_W, TILE_H).fill({ color: 0xffffff, alpha: 0.001 });
  MESS_PAINTERS[kind](g, variant);
  return g;
}

// --------------------------------------------- hazard decals (Stage 3, §S3.7)

export function hazardKey(kind: RoomFailure['kind']): string {
  return `hazard:${kind}`;
}

/**
 * Mechanical failure: a scorch smudge under the fault with a few jagged spark
 * bolts flung flat across the ground plane and hot pinpoints at their tips —
 * "the machine is arcing". Same flat decal language as the messes (all shapes
 * squashed toward 2:1, no rise), subtle but readable on any floor color.
 */
function hazardSparks(g: Graphics): void {
  const cx = TILE_W / 2;
  const cy = TILE_H / 2;
  const scorch = 0x3a3733;
  const spark = 0xffd23f; // hot yellow
  const ember = 0xf29a2e; // cooler orange secondary
  const hot = 0xfff3b8; // near-white pinpoints
  // Scorch smudge — two stacked soot lobes.
  g.ellipse(cx, cy, 9.5, 4.6).fill({ color: scorch, alpha: 0.38 });
  g.ellipse(cx + 2, cy + 1, 5, 2.4).fill({ color: shade(scorch, 0.55), alpha: 0.45 });
  // Jagged bolts radiating from the smudge (flat zigzag strokes).
  const bolt = (pts: readonly number[], color: number, width: number): void => {
    g.moveTo(cx + pts[0]!, cy + pts[1]!);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(cx + pts[i]!, cy + pts[i + 1]!);
    g.stroke({ color, width, alpha: 0.9 });
  };
  bolt([2, -1, 8, -4, 13, -2], spark, 1.4);
  bolt([-3, 1, -9, 3, -14, 1], spark, 1.4);
  bolt([1, 2, 5, 5, 11, 4], ember, 1.2);
  bolt([-1, -2, -4, -5, -9, -6], ember, 1.1);
  // Hot pinpoints at the bolt tips + one at the source.
  g.circle(cx + 13, cy - 2, 1.3).fill(hot);
  g.circle(cx - 14, cy + 1, 1.1).fill(hot);
  g.circle(cx + 11, cy + 4, 1).fill({ color: hot, alpha: 0.9 });
  g.circle(cx - 9, cy - 6, 0.9).fill({ color: hot, alpha: 0.85 });
  g.circle(cx, cy - 1, 1.5).fill({ color: hot, alpha: 0.95 });
}

/**
 * Piping failure: a standing water film with a bright rim (the messWater
 * palette, so the burst puddles nearby rhyme with it), a couple of landed
 * drips, and pale steam wisps curling up from the leak — "the pipe is
 * venting". Wisps stay inside the tile canvas: decals are flat, no rise pad.
 */
function hazardSteam(g: Graphics): void {
  const cx = TILE_W / 2;
  const cy = TILE_H / 2;
  const water = 0x4f86c2; // same base as messWater
  const sheen = 0xdff0fa;
  const mist = 0xeef5f8;
  // Standing film with a bright rim — reads "leak source", not a full puddle.
  g.ellipse(cx, cy + 2, 10, 5).fill({ color: water, alpha: 0.3 });
  g.ellipse(cx, cy + 2, 10, 5).stroke({ color: shade(water, 1.25), width: 1, alpha: 0.5 });
  g.ellipse(cx - 3, cy + 1, 4, 1.5).fill({ color: sheen, alpha: 0.4 });
  // Landed drips just past the rim.
  g.ellipse(cx + 10, cy - 1, 1.6, 0.9).fill({ color: water, alpha: 0.6 });
  g.ellipse(cx - 11, cy + 5, 1.4, 0.8).fill({ color: water, alpha: 0.6 });
  g.ellipse(cx + 6, cy + 7, 1.2, 0.7).fill({ color: water, alpha: 0.55 });
  // Steam wisps curling up from the film (upper half of the canvas), fading
  // with height; the NW-light glint convention keeps them pale, not white-hot.
  g.moveTo(cx - 4, cy).bezierCurveTo(cx - 8, cy - 3, cx - 2, cy - 6, cx - 6, cy - 10);
  g.stroke({ color: mist, width: 1.6, alpha: 0.55 });
  g.moveTo(cx + 3, cy + 1).bezierCurveTo(cx + 7, cy - 2, cx + 1, cy - 5, cx + 5, cy - 9);
  g.stroke({ color: mist, width: 1.4, alpha: 0.45 });
  g.moveTo(cx, cy - 2).bezierCurveTo(cx - 2, cy - 5, cx + 2, cy - 7, cx, cy - 11);
  g.stroke({ color: mist, width: 1.2, alpha: 0.35 });
}

/** Exhaustive by construction: a new failure kind is a compile error until painted. */
const HAZARD_PAINTERS: Readonly<Record<RoomFailure['kind'], (g: Graphics) => void>> = {
  mechanical: hazardSparks,
  piping: hazardSteam,
};

/** One flat hazard decal on the ground-tile canvas — same near-invisible
 *  bounds rect as messDecal, so ground-tile placement math applies verbatim. */
function hazardDecal(kind: RoomFailure['kind']): Graphics {
  const g = new Graphics();
  g.rect(0, 0, TILE_W, TILE_H).fill({ color: 0xffffff, alpha: 0.001 });
  HAZARD_PAINTERS[kind](g);
  return g;
}

/** A box prism filling one tile — the per-tile slice of (multi-tile) furniture. */
function propSlice(id: PropId, slice: PropSlice): Graphics {
  const { color, rise } = PROP_STYLE[id];
  const g = new Graphics();
  // Constant padding rect → identical texture bounds for every prop/slice.
  g.rect(0, -PROP_RISE_PAD, TILE_W, TILE_H + PROP_RISE_PAD).fill({ color: 0xffffff, alpha: 0.001 });
  // Fully custom silhouettes (amenities): drawn on the same padded canvas,
  // skipping the prism — the propKey lookup contract is untouched.
  const custom = CUSTOM_PROPS[id];
  if (custom) {
    custom(g, color, rise);
    return g;
  }
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
  } else if (decor === 'toilet') {
    // Cistern tank at the back + a bowl with a visible seat opening, on the
    // low porcelain block — reads "toilet" at tile scale (billboard-style
    // flats, same convention as the monitor decor).
    const cy = TILE_H / 2 - rise; // top-face center
    g.rect(TILE_W / 2 - 8, -rise - 11, 16, 10).fill(shade(color, 1.06)); // tank
    g.rect(TILE_W / 2 - 8, -rise - 11, 16, 2.5).fill(shade(color, 1.22)); // tank lid
    g.rect(TILE_W / 2 - 8, -rise - 11, 16, 10).stroke({ color: shade(color, 0.72), width: 1 });
    g.ellipse(TILE_W / 2, cy + 3, 10, 5.5).fill(shade(color, 0.82)); // bowl shadow rim
    g.ellipse(TILE_W / 2, cy + 2, 10, 5).fill(0xf6fafc); // seat
    g.ellipse(TILE_W / 2, cy + 2, 10, 5).stroke({ color: shade(color, 0.7), width: 1 });
    g.ellipse(TILE_W / 2, cy + 2, 5.5, 2.8).fill(shade(color, 0.55)); // opening
  } else if (decor === 'vendingFront') {
    // Glass-front machine on the SE face: dark window, shelves of colorful
    // products, a coin panel column, and a dispensing slot — tall + colorful
    // is the read. Face basis: S corner + u (true SE top edge) + v (down).
    const bx = TILE_W / 2;
    const by = TILE_H - rise;
    const ux = TILE_W / 2;
    const uy = -TILE_H / 2;
    const at = (a: number, b: number): [number, number] => [bx + ux * a, by + uy * a + rise * b];
    // Window glass.
    g.poly([...at(0.1, 0.08), ...at(0.68, 0.08), ...at(0.68, 0.6), ...at(0.1, 0.6)])
      .fill(0x2e3d4a);
    // Shelf rows of products (fixed palette — deterministic, never rng).
    const rows = [0.19, 0.33, 0.47];
    const cols = [0.17, 0.3, 0.43, 0.56];
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < cols.length; c++) {
        const [px, py] = at(cols[c]!, rows[r]!);
        g.circle(px, py, 1.9).fill(VENDING_PRODUCT_COLORS[(r + c) % VENDING_PRODUCT_COLORS.length]!);
      }
      const [sx, sy] = at(0.12, rows[r]! + 0.055);
      const [ex, ey] = at(0.66, rows[r]! + 0.055);
      g.poly([sx, sy, ex, ey, ex, ey + 1, sx, sy + 1]).fill({ color: 0x8fb7cc, alpha: 0.45 });
    }
    // Glass sheen.
    g.poly([...at(0.14, 0.1), ...at(0.3, 0.1), ...at(0.22, 0.58), ...at(0.14, 0.58)])
      .fill({ color: 0xcfe6f2, alpha: 0.18 });
    // Coin panel column: slot + glowing button.
    g.poly([...at(0.74, 0.1), ...at(0.92, 0.1), ...at(0.92, 0.48), ...at(0.74, 0.48)])
      .fill(shade(color, 0.72));
    g.poly([...at(0.79, 0.16), ...at(0.87, 0.16), ...at(0.87, 0.2), ...at(0.79, 0.2)])
      .fill(0x1d2226);
    const [kx, ky] = at(0.83, 0.32);
    g.circle(kx, ky, 1.6).fill(shade(color, 1.55));
    // Dispensing slot along the bottom.
    g.poly([...at(0.14, 0.72), ...at(0.86, 0.72), ...at(0.86, 0.88), ...at(0.14, 0.88)])
      .fill(shade(color, 0.42));
    g.poly([...at(0.14, 0.72), ...at(0.86, 0.72), ...at(0.86, 0.75), ...at(0.14, 0.75)])
      .fill(shade(color, 1.2));
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

  const messes = new Map<string, Texture>();
  for (const kind of Object.keys(MESS_PAINTERS) as Mess['kind'][]) {
    for (let variant = 0; variant < MESS_VARIANTS; variant++) {
      messes.set(messKey(kind, variant), renderer.generateTexture(messDecal(kind, variant)));
    }
  }

  const hazards = new Map<string, Texture>();
  for (const kind of Object.keys(HAZARD_PAINTERS) as RoomFailure['kind'][]) {
    hazards.set(hazardKey(kind), renderer.generateTexture(hazardDecal(kind)));
  }

  return {
    ground: [renderer.generateTexture(groundA), renderer.generateTexture(groundB)],
    plain: renderer.generateTexture(plain),
    highlight: renderer.generateTexture(highlight),
    marker: renderer.generateTexture(marker),
    entrance: renderer.generateTexture(entrance),
    props,
    messes,
    hazards,
  };
}
