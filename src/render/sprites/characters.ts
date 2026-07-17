import { Graphics, type Renderer, type Texture } from 'pixi.js';
import { ROLE_DEFS, ROLE_IDS, type RoleId } from '../../sim/data/roles';
import { FACINGS, shade, type Facing } from './shared';

/**
 * Character textures — 100% procedural (tech plan §2.6). The renderer looks
 * textures up through `characterKey(kind, variant, facing, frame)`, which is
 * exactly the contract a sprite atlas would satisfy later; this module is the
 * only thing that knows how a person is drawn.
 *
 * ART PASS: four genuinely distinct facings. SE/SW face TOWARD the viewer (we
 * draw the face); NE/NW face AWAY (back of the head, no face). Left-facing
 * variants (SW, NW) are the horizontal mirror of the right-facing ones (SE,
 * NE) — mirroring is BAKED into the texture (renderer keeps scale.x = 1), so
 * `drawCharacter` flips every x-coordinate through `dir` and the away/toward
 * split is chosen by `showFace`. Only two rigs are actually authored per kind
 * (a front-right and a back-right); the other two facings fall out of the flip.
 *
 * INVARIANTS: the texture-key shape (`characterKey`), `CHARACTER_FRAMES`,
 * `FEET_ANCHOR` (renderer anchors sprites by it), variant counts, and
 * determinism (variety hashes the entity id via `variantFor` — never
 * Math.random). ALL geometry stays inside the padding rect x −9..9, y −46..1
 * so the feet anchor is a constant fraction for every kind/facing/frame, and
 * the planted foot always sits at y = 0 (bob moves the body, not the feet).
 */

export type CharacterKind = RoleId | 'patient';
/** Frame 0 = idle; frames 1..N = walk cycle (contact / pass / contact / pass). */
export const CHARACTER_FRAMES = 5;
export const PATIENT_VARIANTS = 8;
export const STAFF_VARIANTS = 4;
/** Feet anchor inside the padded texture (pad rect spans x −9..9, y −46..1). */
export const FEET_ANCHOR = { x: 0.5, y: 46 / 47 };

const SKIN_TONES = [0xf2c9a8, 0xd9a377, 0xb07b4f, 0x8a5a3a] as const;
const HAIR_COLORS = [0x3b2f2f, 0x6e4f2f, 0xc7873a, 0x8f8f8f] as const;
/**
 * Roles drawn with a scrub cap instead of hair. Typed against RoleId so a
 * typo'd id is a compile error; any role absent here gets the generic hair
 * treatment — new roles need no code change (the generator iterates ROLE_IDS
 * and reads ROLE_DEFS[role].color, both SSOT).
 */
const SCRUB_CAP_ROLES: ReadonlySet<RoleId> = new Set(['nurse', 'respTherapist', 'surgeon']);

const GOWN_COLOR = 0xdfe8f5;
const GOWN_TRIM = 0x9fb0c5;
const COAT_WHITE = 0xf4f4f0;
const COAT_SHIRT = 0x51698a;
const DOCTOR_SLACKS = 0x39445c;
const SHOE = 0x3a3a44;
const STETH = 0x2b2b33;
const BADGE = 0xf5f5ef;
const GREETER_SHIRT = 0xeceff2;
const MASK = 0xe6eef0;

/** Soft form shading — a lit top band and a shadowed underside, kept inside
 * whatever silhouette they're painted over so they never spill onto transparency. */
const HI = { color: 0xffffff, alpha: 0.12 } as const;
const LO = { color: 0x000000, alpha: 0.14 } as const;

interface WalkPhase {
  /** Body bob (px, negative = up). */
  bob: number;
  /** Arm swing (px, applied ± to the two arms). */
  arm: number;
  /** Left / right foot lift (px, raises the foot off the ground). */
  liftL: number;
  liftR: number;
}

// A clean 4-frame cycle: contact (arms wide) → pass (body rises, R foot up) →
// contact (arms wide, opposite) → pass (body rises, L foot up). The alternating
// lifted foot + bob sells "walking" instead of "sliding".
const PHASES: readonly WalkPhase[] = [
  { bob: 0, arm: 0, liftL: 0, liftR: 0 }, // idle
  { bob: 0, arm: 3, liftL: 0, liftR: 0 },
  { bob: -2, arm: 0, liftL: 0, liftR: 3 },
  { bob: 0, arm: -3, liftL: 0, liftR: 0 },
  { bob: -2, arm: 0, liftL: 3, liftR: 0 },
];

/**
 * Draw one character texture in canonical right-facing orientation. `dir`
 * flips every x so the same rig serves the left-facing keys; `showFace`
 * chooses the toward-viewer (face) vs away (back of head) treatment.
 */
function drawCharacter(
  kind: CharacterKind,
  skin: number,
  hair: number,
  facing: Facing,
  frame: number,
): Graphics {
  const dir = facing === 'SW' || facing === 'NW' ? -1 : 1;
  const showFace = facing === 'SE' || facing === 'SW';
  const g = new Graphics();

  // dir-aware primitive helpers (x is a CENTER coordinate, mirrored by dir).
  const rr = (cx: number, y: number, w: number, h: number, r: number): Graphics =>
    g.roundRect(cx * dir - w / 2, y, w, h, r);
  const cc = (cx: number, y: number, r: number): Graphics => g.circle(cx * dir, y, r);
  const ee = (cx: number, y: number, rx: number, ry: number): Graphics =>
    g.ellipse(cx * dir, y, rx, ry);
  const pg = (pts: number[]): Graphics => g.poly(pts.map((v, i) => (i % 2 === 0 ? v * dir : v)));

  // Padding rect pins texture bounds to exactly (−9,−46)..(9,1) so the feet
  // anchor is a constant fraction for every kind/facing/frame.
  g.rect(-9, -46, 18, 47).fill({ color: 0xffffff, alpha: 0.001 });

  const { bob, arm, liftL, liftR } = PHASES[frame]!;
  const isPatient = kind === 'patient';
  const outfit = isPatient ? GOWN_COLOR : ROLE_DEFS[kind as RoleId].color;
  const cap = !isPatient && SCRUB_CAP_ROLES.has(kind as RoleId);
  const isDoctor = kind === 'doctor';
  const topColor = isPatient ? GOWN_COLOR : isDoctor ? COAT_WHITE : outfit;
  const sleeve = isDoctor ? COAT_WHITE : topColor;
  const legColor = isPatient ? shade(skin, 0.98) : isDoctor ? DOCTOR_SLACKS : shade(outfit, 0.5);

  // A top-lit rounded panel that keeps its shading inside its own silhouette.
  const panel = (
    cx: number,
    top: number,
    w: number,
    h: number,
    r: number,
    color: number,
    strokeColor?: number,
  ): void => {
    rr(cx, top, w, h, r).fill(color);
    rr(cx, top, w, h * 0.5, r).fill(HI);
    rr(cx, top + h * 0.62, w, h * 0.38, r).fill(LO);
    if (strokeColor !== undefined) rr(cx, top, w, h, r).stroke({ color: strokeColor, width: 1 });
  };

  // ── Contact shadow (fixed at the feet; kept inside the pad's bottom edge). ──
  g.ellipse(0, -1.6, 7.5, 2.6).fill({ color: 0x000000, alpha: 0.18 });

  // ── Legs + shoes (drawn behind the torso). ──
  const leg = (cx: number, lift: number): void => {
    const hipY = -13 + bob;
    const footTop = -3 - lift;
    rr(cx, hipY, 4, footTop - hipY + 1, 2).fill(legColor);
    rr(cx, hipY, 4, (footTop - hipY) * 0.5, 2).fill(HI);
    // Shoe/slipper points in the walk direction (dir-forward).
    const shoeColor = isPatient ? GOWN_TRIM : SHOE;
    rr(cx + 0.8, footTop, 5, 3, 1.4).fill(shoeColor);
    rr(cx + 0.8, footTop, 5, 1.4, 1.4).fill({ color: 0xffffff, alpha: 0.1 });
  };
  leg(-2.6, liftL);
  leg(2.6, liftR);

  const torsoTop = -31 + bob;
  const TW = 15;
  const TH = 18;
  const TR = 5;
  const shoulderY = -30 + bob;
  const armLen = 11;
  const armW = 3.2;
  const armCx = 7;

  // ── Far arm (behind the torso). ──
  const drawArm = (cx: number, swing: number, shade0: number): void => {
    const top = shoulderY + swing;
    rr(cx, top, armW, armLen, 1.6).fill(shade(sleeve, shade0));
    rr(cx, top, armW, armLen * 0.5, 1.6).fill(HI);
    cc(cx, top + armLen + 1, 1.9).fill(skin); // hand
  };
  drawArm(-armCx, -arm, 0.82);

  // ── Torso + role-specific rig. ──
  panel(0, torsoTop, TW, TH, TR, topColor, shade(topColor, 0.72));

  // Front-of-body ITEMS (V-neck, badges, stethoscope, vest trim, pockets) only
  // exist on the toward-viewer facings. On the away facings we draw a
  // back-appropriate treatment (a center seam / back tie) so an actor walking
  // NE/NW never wears their badge on their spine. The base outfit/torso/cap are
  // already drawn above and stay identical for every facing.
  if (isDoctor) {
    if (showFace) {
      // Open white coat: shirt V + placket, plus a stethoscope.
      pg([-3.5, torsoTop + 1, 3.5, torsoTop + 1, 0, torsoTop + 8]).fill(COAT_SHIRT);
      rr(0, torsoTop + 6, 2, TH - 7, 1).fill(COAT_SHIRT);
      rr(-2.6, torsoTop + 1, 1.2, 9, 0.6).fill(STETH);
      rr(2.6, torsoTop + 1, 1.2, 8, 0.6).fill(STETH);
      cc(2.6, torsoTop + 10, 1.7).fill(STETH);
    } else {
      // Coat back: a plain center vent.
      rr(0, torsoTop + 8, 1.2, TH - 8, 0.6).fill(shade(COAT_WHITE, 0.9));
    }
  } else if (isPatient) {
    // Hospital gown: soft trim, hem, and back ties when seen from behind.
    rr(0, torsoTop, TW, TH, TR).stroke({ color: GOWN_TRIM, width: 1 });
    rr(0, torsoTop + TH - 3, TW, 3, 1.5).fill(shade(GOWN_COLOR, 0.85));
    if (showFace) {
      pg([-2.5, torsoTop, 2.5, torsoTop, 0, torsoTop + 4]).fill(shade(GOWN_COLOR, 0.9));
    } else {
      rr(0, torsoTop + 2, 1.4, TH - 5, 0.7).fill(shade(GOWN_COLOR, 0.82));
      cc(0, torsoTop + 5, 1).fill(GOWN_TRIM);
      cc(0, torsoTop + 11, 1).fill(GOWN_TRIM);
    }
  } else if (kind === 'greeter') {
    // Volunteer: light shirt under an open vest (two side panels). The panels
    // wrap around, so they read on both sides; only the badge is front-only.
    panel(0, torsoTop, TW, TH, TR, GREETER_SHIRT);
    panel(-4, torsoTop, 6.5, TH - 0.5, 2.5, outfit);
    panel(4, torsoTop, 6.5, TH - 0.5, 2.5, outfit);
    if (showFace) {
      rr(3, torsoTop + 8, 3, 4, 0.8).fill(BADGE);
    }
  } else if (kind === 'receptionist') {
    if (showFace) {
      // Blouse: bright collar + a clipped name badge.
      pg([-4, torsoTop, -0.5, torsoTop, -2.5, torsoTop + 4]).fill(shade(outfit, 1.28));
      pg([4, torsoTop, 0.5, torsoTop, 2.5, torsoTop + 4]).fill(shade(outfit, 1.28));
      rr(3, torsoTop + 8, 3, 4, 0.8).fill(BADGE);
    } else {
      // Collar seen from the back: a small bright band across the nape.
      rr(0, torsoTop, 6, 2, 1).fill(shade(outfit, 1.28));
    }
  } else if (showFace) {
    // Generic scrubs (nurse, RT, surgeon, radTech, sonographer, and any future
    // role): V-neck + a chest pocket. Reads as clinical staff by default.
    pg([-3, torsoTop, 3, torsoTop, 0, torsoTop + 5]).fill(shade(outfit, 0.78));
    rr(3, torsoTop + 9, 3.2, 3.4, 0.6).fill(shade(outfit, 0.86));
  } else {
    // Scrubs back: a plain collar band across the nape.
    rr(0, torsoTop, 7, 2, 1).fill(shade(outfit, 0.78));
  }

  // ── Near arm (in front of the torso). ──
  drawArm(armCx, arm, 1.0);

  // ── Head: crown (hair or cap) + face (toward) or back-of-head (away). ──
  const hx = 1.3;
  // Base kept high enough that the crown top (hy − 7.8) stays inside the pad's
  // −46 edge even at the −2 bob, so the texture bounds never grow.
  const hy = -36 + bob;
  const crown = cap ? shade(outfit, 0.95) : hair;
  if (showFace) {
    cc(hx, hy - 1.6, 6.2).fill(crown); // hair / cap crown
    cc(hx + 0.4, hy + 0.9, 5.5).fill(skin); // face over the lower crown
    cc(hx - 1.4, hy - 0.4, 3.2).fill(HI);
    ee(hx + 2, hy + 2.6, 3, 2.8).fill(LO);
    if (cap) {
      // Cap band across the brow.
      rr(hx, hy - 3.4, 11, 2.2, 1).fill(shade(outfit, 0.85));
    }
    if (kind === 'surgeon') {
      // Surgical mask over the lower face + ear ties.
      rr(hx + 0.4, hy + 2.2, 10, 5, 1.5).fill(MASK);
      rr(hx + 0.4, hy + 2.2, 10, 2.5, 1.5).fill({ color: 0x000000, alpha: 0.06 });
      rr(-4.6, hy + 1.2, 1, 3, 0.5).fill(shade(MASK, 0.85));
      rr(6.2, hy + 1.2, 1, 3, 0.5).fill(shade(MASK, 0.85));
    } else {
      // Eyes (shifted toward the walk direction for a subtle 3/4 turn).
      ee(hx - 1.4, hy + 0.4, 0.9, 1.2).fill(0x2b2b33);
      ee(hx + 2.4, hy + 0.4, 0.9, 1.2).fill(0x2b2b33);
    }
  } else {
    // Away: full crown, a nape shadow, and a sliver of neck skin.
    cc(hx, hy - 0.3, 6.1).fill(crown);
    cc(hx - 1.6, hy - 2.2, 3.4).fill(HI);
    ee(hx, hy + 2.8, 4.4, 3.2).fill(LO);
    ee(hx, hy + 5, 2.4, 1.6).fill(skin);
    if (cap) {
      // Cap tie knot at the back.
      cc(hx, hy + 1, 1.6).fill(shade(outfit, 0.82));
      rr(hx, hy + 1, 2.4, 4, 1).fill(shade(outfit, 0.88));
    }
  }

  return g;
}

/** Texture-atlas key (§2.6 contract). Facing is part of the key. */
export function characterKey(
  kind: CharacterKind,
  variant: number,
  facing: Facing,
  frame: number,
): string {
  return `${kind}:${variant}:${facing}:${frame}`;
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
      for (const facing of FACINGS) {
        for (let frame = 0; frame < CHARACTER_FRAMES; frame++) {
          textures.set(
            characterKey(kind, variant, facing, frame),
            renderer.generateTexture(drawCharacter(kind, skin, hair, facing, frame)),
          );
        }
      }
    }
  }
  return textures;
}
