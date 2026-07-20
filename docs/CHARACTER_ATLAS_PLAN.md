# Character Sprite-Atlas Milestone (Tier B) — PLAN

**Status: §1 CONTRACT CHANGE RATIFIED (owner, 2026-07-20). Two split-lens
pre-impl reviews COMPLETE — both READY-WITH-FIXES; findings folded into this
v2. Implementing Stage 1.** Stage-2 art sourcing is still open but does NOT
block Stage 1 (§7).

## v2 — what the pre-impl reviews changed (both lenses independently)

1. **The archetype table was WRONG for most roles (the central finding, both
   reviews).** `radTech/sonographer/evs/maintenance/anesthesiologist` already
   render as generic **scrubs**, not "shirts"; the doctor's role colour is
   near-white and unusable as a tint (its coat/shirt/steth/slacks are fixed);
   greeter (vest) and receptionist (collar+badge) are distinct. §2 is rebuilt
   around a **`scrubs`** archetype with an **optional `cap` layer**
   (`SCRUB_CAP_ROLES`) + optional surgeon `mask`, plus `gown`, `coat`,
   `greeter`, `receptionist`. Committing Stage-2 art against the old table would
   have "baked the mis-map into money."
2. **Stage 1 no longer refactors `drawCharacter`.** The original "refactor the
   procedural drawer into tintable layers" was the biggest risk (HI/LO
   alpha-overlay shading ≠ multiply-tint math; interleaved z-order — near-arm
   over stethoscope over torso — can't be reproduced by a flat layer stack) with
   NO Stage-1 payoff. **Option B:** keep `drawCharacter` UNTOUCHED as the
   fallback; build the compositor against **authored (or a placeholder) atlas**
   only. Stage 1 now has a genuinely BYTE-IDENTICAL procedural render — "no
   visible change" is finally true, not over-claimed.
3. **Bake must pin the pad frame.** `generateTexture` crops to content bounds;
   without an explicit `frame: Rectangle(-9,-46,18,47)` (or a full-pad
   transparent sprite), `FEET_ANCHOR = 46/47` breaks per-key (float/sink). This
   is a BAKE-step rule, not just an art-spec test.
4. **The boot narrative was wrong (in our favour).** `generateCharacterTextures`
   is already inside the awaited `renderer.init()` (`renderer.ts:321`,
   `main.ts:107`), so async adds ONE `await` with no `main.ts` ripple. BUT there
   is no existing loading gate — "New Game" full-page-reloads to `?seed=` with no
   TitleScreen mounted during `bootstrap()`. Accept a marginally longer blank
   frame (bundled same-origin atlas loads fast; fallback covers absence) or add a
   minimal spinner. §3/§6 corrected.
5. **Half the promised tests can't run headless** (`generateTexture` needs a
   GPU; Vitest is `node`/jsdom). §8 rewritten: the contract tests are the
   PURE-DATA ones — `archetypeOf` exhaustiveness over `CharacterKind`, the
   key-set enumeration, the tint-source wiring, and the fallback-selection
   function; texture-resolves + bounds move to live-drive acceptance.
6. **Palette-collapse risk (art lens, Stage-2 gate).** Collapsing 8 roles into
   one `scrubs` silhouette makes hue the primary differentiator, and the full
   clinical set does NOT clear ≥25° pairwise TODAY (evs/maintenance ~7°,
   sonographer/radTech ~21°). The Stage-2 art brief must add silhouette-
   differentiating detail for these roles OR the clinical palette gets a
   re-spread — an owner decision recorded in §11, not a Stage-1 blocker.
7. **Art spec gaps folded into §4:** shoes (fixed) and legs (per-archetype tint)
   were omitted; the walk spec now carries real numbers (bob −2px, arm ±3px,
   lift 3px, frame 2 = right foot / frame 4 = left, centerline x = 0, all layers
   share one registration and bob together).

> **One-line goal:** replace the procedural vector characters with authored
> sprites **without exploding art volume**, by a *palette-swap atlas* — author a
> few grayscale garment **archetypes** and tint them per role at boot from the
> existing `ROLE_DEFS.color` SSOT.

---

## §0 — The one load-bearing fact (why this is cheap on the code side)

The renderer already looks characters up through a **frozen key**:
`characterKey(kind, variant, facing, frame)` (`src/render/sprites/characters.ts`).
The art-contract comment says outright that an atlas is meant to satisfy exactly
this key. Concretely:

- `generateCharacterTextures(renderer)` builds a `Map<string, Texture>` keyed by
  that string, once at renderer init.
- `makeCharacterSprite` / the per-frame sync loop (`renderer.ts`) only ever do
  `characterTextures.get(characterKey(...))` and `sprite.anchor.set(FEET_ANCHOR…)`.

**So the actor hot path does NOT change.** Only the *source* of the textures in
that map changes. Everything downstream — facing math (`facingFromStep`), frame
selection (walk-cycle progress over `CHARACTER_FRAMES`), the feet anchor, the
depth sort — is untouched. This is the entire reason Tier B is a contained
milestone rather than a renderer rewrite.

Current shape to preserve: `kind ∈ {'patient'} ∪ ROLE_IDS` (12 kinds),
`variant` (patient 8 / staff 4, `variantFor` = `entityId % N`), `facing` (4, but
only 2 rigs authored — SW/NW are the baked mirror of SE/NE), `frame` (5 = idle +
4 walk, driven by `PHASES`). Color today is **baked into each texture**
(`outfit = ROLE_DEFS[kind].color`; skin/hair per variant).

---

## §1 — The contract change (OWNER GATE — do not skip)

Tier B **deliberately breaks a stated invariant.** `INVARIANTS.md` — *"Render art
is 100% procedural + deterministic … no asset files"* — and `TECH_PLAN §2.6`.

What actually changes and what does NOT:

- **Determinism is UNAFFECTED.** Art is render-only; the sim never sees a
  texture, the seeded `world.rng` is untouched, and variety still hashes the
  entity id (`variantFor`). No `Math.random`/`Date.now` enters.
- **What changes:** "no asset files" and "instant synchronous boot." An atlas is
  a bundled image; loading it is async.

**Required decision:** amend the contract to *"procedural is the deterministic
FALLBACK; an optional authored atlas enhances it."* The procedural generator is
**kept, not deleted** (§6). With sign-off, `INVARIANTS.md` line "Render art is
100% procedural" is reworded and this plan is cited.

---

## §2 — Approach: boot-time bake of tinted layers

The naïve idea "just `sprite.tint` the character" fails: `tint` multiplies the
*whole* sprite by one color, but a character has several colored regions (outfit,
skin, hair/cap, shoes, accessories). Tinting the outfit would also tint the face.

**Chosen approach — composite grayscale LAYERS, tint each, then BAKE:** at boot,
for every `(kind, variant, facing, frame)`, composite the archetype's grayscale
layer sprites — each tinted by the right color — into a `Container`, then
`renderer.generateTexture(container)` and store it in the SAME map under the SAME
`characterKey`. **The render loop then looks up a finished baked texture exactly
as it does today.** Tinting happens once, at boot, per texture — never per frame.

**The archetype mapping is the art-volume win** — but it must match what each
role ACTUALLY renders today (the pre-impl reviews rebuilt this; the first draft's
`shirt` bucket matched zero of its roles and the doctor mis-tint was invisible):

| Archetype | Roles | Role-colour region | Optional layers |
|---|---|---|---|
| `gown` | patient | **none** (no role) | skin legs, `GOWN_TRIM` shoes/trim, hair — fixed/variant only |
| `scrubs` | nurse, respTherapist, surgeon, radTech, sonographer, evs, maintenance, anesthesiologist | torso + arms + legs(darker) + V-neck/pocket | `cap` (iff `SCRUB_CAP_ROLES` — nurse/RT/surgeon, else hair); `mask` (iff surgeon, fixed) |
| `coat` | doctor | **NONE** — `.color` ≈ white, unusable | coat + shirt-V + stethoscope + slacks are ALL fixed colours; hair |
| `greeter` | greeter | vest side-panels only | fixed `GREETER_SHIRT` torso, `BADGE`, role-tinted arms/legs, hair |
| `receptionist` | receptionist | torso + arms + legs + collar(lightened) | `BADGE` (fixed), hair |

Archetype comes from a compile-complete `Record<CharacterKind, Archetype>` (a new
role must be mapped or it fails an exhaustiveness test — the `CATEGORY_LABELS`
precedent). `cap`/`mask` are **optional layers WITHIN `scrubs`**, keyed exactly as
`SCRUB_CAP_SET` / `kind === 'surgeon'` are today.

**Layer / tint model (the §4 contract).** Each layer names a **tint source**:
`role` (`ROLE_DEFS.color`), `skin`, `hair`, or `fixed:<hex>`. Today's many
`shade(x, k)` derivations (e.g. legs `shade(outfit, 0.5)`, receptionist collar
`shade(outfit, 1.28)`) become **the layer's grayscale brightness `k`** tinted by
source `x` — so a derived tint is just a layer authored darker/lighter. Layers
include, per archetype: `body`(skin), `hair`|`cap`, `outfit`, `legs`, `shoes`,
and the fixed accessories (`mask`/`steth`/`badge`/`vest`/`collar` as applicable).
Shoes are ALWAYS a fixed layer (`SHOE`) — never role-tinted, or you get green
shoes; legs differ by archetype (skin for `gown`, role-darker for staff, fixed for
`coat`).

*Alternative considered — live multi-layer tint (no bake):* each actor becomes a
`Container` of 2–4 tinted sprites synced per frame. Fewer baked textures, but it
changes the hot path (more draw objects per actor, the sync loop rewritten) and
risks the 60fps DoD invariant. **Rejected** for Stage 1 in favour of baking,
which keeps the hot path byte-identical. Revisit only if texture memory becomes a
real constraint (it does not at ~1040 textures today).

---

## §3 — What changes in code (small), what doesn't (the hot path)

**Changes — all inside `generateCharacterTextures` + a small boot await:**
- `generateCharacterTextures` gains an **async** path: try `Assets.load(atlas)`;
  on success, for each key composite the archetype's tinted layers → bake with
  the pinned frame → return the same `Map<string,Texture>`; on absence/failure,
  **call the existing procedural generator unchanged**.
- **The async ripple is one `await`**, NOT a constructor rewrite: the generator
  is already called inside `renderer.init()` (`renderer.ts:321`), which `main.ts`
  already `await`s before the loop starts. No `main.ts` ordering change. There is
  no existing loading-screen gate (New Game full-reloads to `?seed=` with no
  TitleScreen mounted), so either accept a marginally longer blank first frame (a
  bundled same-origin atlas loads fast; fallback covers absence) or add a minimal
  spinner — an owner/polish call, not a blocker.
- New: the `Archetype` type + `ARCHETYPE_OF` map + the `LayerSpec` tint contract
  (§4) + the compositor. **`drawCharacter` is UNTOUCHED** (Option B) — it is the
  fallback, byte-identical to today.

**Does NOT change:** `characterKey`, `variantFor`, `FEET_ANCHOR`,
`CHARACTER_FRAMES`, `PHASES`, `facingFromStep`, `makeCharacterSprite`, the
per-frame `sprite.texture = …get(characterKey(...))` sync, the depth sort, the
2-rigs-mirrored facing scheme. The atlas-lookup contract is the firewall.

---

## §4 — The art spec (the unforgiving constraint on whoever draws it)

This is where a milestone like this usually dies — art authored off-spec makes
actors float, sink, or jitter. The spec is non-negotiable:

- **Canvas / bounds:** every layer frame draws inside the pad rect **x −9..9,
  y −46..1**, centreline at **x = 0** (the current `FEET_ANCHOR = 46/47` and the
  SW/NW mirror both depend on it). The **planted foot sits at y = 0** in every
  frame; the *bob* moves the body, never the feet. **BAKE RULE (not just art):**
  the compositor bakes with an explicit `frame: new Rectangle(-9, -46, 18, 47)`
  (or a transparent full-pad sprite in every container), because
  `generateTexture` otherwise crops to content bounds and `FEET_ANCHOR` breaks
  per-key.
- **Facings:** author **two rigs only** — front-right (SE) and back-right (NE).
  SW/NW are the horizontal mirror, baked at composite time (renderer keeps
  `scale.x = 1`). SE/SW show the face; NE/NW show the back of the head.
- **Frames + walk numbers:** 5 per facing — frame 0 idle; the walk cycle is
  contact/pass/contact/pass. All layers of a frame **share one registration and
  bob together**. Displacements (from `PHASES`): **bob −2 px** on the two pass
  frames (2 and 4); **arm swing ±3 px**; **foot lift 3 px**, **frame 2 lifts the
  RIGHT foot, frame 4 the LEFT**.
- **Layers:** separate registered sprites (packed atlas + frame data). Per the §2
  contract: `body`(skin), `hair`|`cap`, `outfit`, `legs`, `shoes`, and fixed
  accessories (`mask`/`steth`/`badge`/`vest`/`collar`). **Tintable layers are
  authored near-white** so a multiply tint reads true, with `shade(x,k)`
  derivations baked as the layer's brightness; **`shoes` is ALWAYS fixed
  (`SHOE`)** and **`legs` tint differs by archetype** (skin/role-darker/fixed).
  Z-ordered so the near arm draws OVER front accessories over torso (today's
  order — a flat stack must preserve it).
- **Variety:** the 8 patient / 4 staff variants are produced by **tinting** the
  `body`/`hair`/`legs` layers (skin-tone × hair-color combos, the current
  `SKIN_TONES`/`HAIR_COLORS`; patient legs are skin-tinted). Whether to keep 8/4
  or trim is an owner/art call (§11).

---

## §5 — Determinism & save

**No `SAVE_VERSION` bump. No sim change. No re-pin.** Characters are render-only;
the bake is deterministic (fixed inputs → fixed textures); the only new
non-deterministic surface is asset *load*, fully contained by the fallback (§6).
Nothing in `src/sim/` is touched.

---

## §6 — Boot flow & failure handling

- **Async load** behind a loading state; the title screen gates it (a click is
  already required there, and the browser autoplay/gesture rule aside, boot is
  already a staged flow).
- **The procedural generator is the FALLBACK, not deleted.** If the atlas is
  absent (dev, tests, headless driver) or fails to load (network, corrupt), the
  compositor runs against the *procedural* grayscale layers instead — the game
  renders exactly as today, never a hard failure, and the test/`/run-hospital-
  simms` paths stay assetless. This is what makes the milestone safe to ship
  before art exists.

---

## §7 — Staging (the engineering ships BEFORE any art exists)

This is the de-risking spine, **revised to Option B after the pre-impl reviews**
(the original "refactor `drawCharacter` into layers" was the milestone's biggest
risk — shading/z-order math changes, visual regression, no headless test — for
ZERO Stage-1 payoff, since Stage 1 shows no change anyway):

- **Stage 1 — the pipeline, procedural render UNTOUCHED.** `drawCharacter` and
  the current procedural generator are left exactly as-is and become the
  **fallback**. Build alongside them: the archetype/tint **contract** (`§4`,
  code + exhaustiveness test), the **compositor** (layer set + tint sources →
  `Container` → `generateTexture` with the pinned `-9,-46,18,47` frame), the
  **async atlas loader + fallback-selection** (atlas present → composite; absent
  or failed → procedural), and a tiny **placeholder atlas** (a few hand-made
  grayscale layers to the §4 spec) that exercises the compositor end-to-end in a
  live-drive. **Result: procedural render is BYTE-IDENTICAL to today (no visible
  change), and the game is art-ready.** Full workflow + post-impl review here.
- **Stage 2 — ART, the visible upgrade.** Replace the placeholder atlas with real
  authored layers to the §4 spec. Pure asset swap; Stage-1 code frozen.
  Visual-acceptance live-drive; the palette-collapse decision (§11) lands here.

**Honest framing:** Stage 1 delivers **no visible change** — it makes the game
art-ready (art drops in with no code). The *visible* upgrade is Stage 2, gated on
sourcing art (the real cost — see §11).

---

## §8 — Testing & acceptance

- **Headless contract tests** (the ones that actually run in the `node`/jsdom
  suite — `generateTexture` needs a GPU, so texture-level tests CANNOT):
  `ARCHETYPE_OF` is exhaustive over `CharacterKind` (a new role fails until
  mapped — the `data.test` `CATEGORY_LABELS` precedent); the key-set enumeration
  (`kind × variant × facing × frame`) matches expectation; the `LayerSpec` tint
  wiring resolves against `ROLE_DEFS.color`/`SKIN_TONES`/`HAIR_COLORS` (no layer
  claims a tint source that doesn't exist); the **fallback-selection** decision
  is a pure function, tested directly (not through `Assets`).
- **GPU / live-drive acceptance** (`/run-hospital-simms`, the only place texture
  bake + anchor can be checked): every `characterKey` resolves to a texture; no
  float/sink at the feet (bounds honoured); 4 facings correct (face toward / back
  away); walk reads; tints match `ROLE_DEFS.color` (the colour-spread win pays
  off again). Run against BOTH the placeholder atlas AND the procedural fallback
  (assets removed), confirming the fallback is byte-identical to today.

---

## §9 — Risks (ranked)

1. **Art production is the real cost and it is EXTERNAL** (Stage 2): commission a
   pixel artist, adapt an asset pack, or AI-generate + heavy cleanup. **AI
   struggles with animation consistency** across facings/frames — be cautious for
   walk cycles specifically. This dwarfs the code effort.
2. **The anchor/bounds art spec is unforgiving** (§4) — off-spec art floats or
   sinks. Mitigate with a template/overlay guide and a bounds contract test.
3. **Bundle + texture memory:** an atlas PNG adds to the currently-pure-JS
   bundle (fine on the Vercel static host); baking keeps ~today's texture count.
4. **Async-boot ripple + the §2.6 contract change** — real but bounded; the
   fallback and the owner gate contain them.
5. **Style-fit:** authored art must match the iso scale, camera, and palette;
   a mismatched pack reads worse than the clean procedural art.

---

## §10 — Effort estimate

- **Stage 1 (code), Option B:** ~1–1.5 days — the archetype/`LayerSpec` contract
  + exhaustiveness test, the compositor (composite + pinned-frame bake), the async
  loader + fallback-selection, and a small placeholder atlas. **Lower risk than
  the v1 estimate** because the risky `drawCharacter`→layers refactor is DROPPED
  (procedural is the untouched fallback) — so there is no visual-regression
  surface in Stage 1.
- **Stage 2 (art):** external, days–weeks depending on source (§11). The code
  side is a placeholder→real-atlas swap; the only new decision is the
  palette-collapse one (§11.2).

---

## §11 — Stage-2 art: the options, and the open decisions

**§1 contract change: RATIFIED (owner, 2026-07-20).**

### The art-source options (for "artwork better than what we have")

The game is **isometric** — characters are small (~18×47 px pad), foreshortened,
seen from a fixed 3/4 angle, and need **4 facings × 5 frames**. That constraint,
not "which looks nicest," is what rules options in or out.

| Option | What | Fit to Tier B | Cost / time | Risk |
|---|---|---|---|---|
| **A. Push the procedural art** | Refine `drawCharacter` (shading, proportions, detail) — NOT an atlas | N/A (no atlas) | ~hours, in-house | Low; limited ceiling (never pixel-art/hand-drawn) |
| **B. Commission to the §4 layer spec** | An artist draws grayscale tint-layers + fixed layers, our facings/frames/anchor | **Perfect** — palette-swap holds, `ROLE_DEFS.color` SSOT preserved | $$–$$$, weeks | Low fit, high cost; needs a good brief (§4 is it) |
| **C. Buy + adapt an asset pack** | An existing iso/top-down character pack | **Partial** — most packs ship *per-role full-colour* sprites, NOT tint layers with our exact 4 facings/5 frames/anchor | $–$$, days | Style-fit + re-slice/re-anchor; often only 4-dir but wrong frame count |
| **D. AI-generate + cleanup** | Generate sprites, hand-fix | Poor for animation | $, days | **High** — AI can't hold consistency across facings/walk frames; fine for a static portrait, bad for a walk cycle |
| **E. Hybrid** | AI/artist makes a few **key poses** per archetype; a human/tool builds the facings + walk frames + layers to spec | Good | $$, 1–2 wk | Medium; needs a rigger/animator step |

**Important interaction with the design:** option **C with per-role full-colour
sprites changes the milestone** — you'd load one texture set per role and NOT
tint-composite at all. That makes the *code* simpler (no compositor) and
**dissolves the palette-collapse issue** (each role has its own art), but it
**loses the palette-swap art-volume win** (you now need art for all ~11 roles)
and the `ROLE_DEFS.color` SSOT stops driving appearance. If you go this way, say
so before Stage 1 — the compositor becomes unnecessary and Stage 1 shrinks to
"load per-role textures behind the same `characterKey`."

**Recommendation:** **B** (commission to the §4 spec) if you want the palette-swap
design and top fidelity-per-effort; **C** if you'd rather buy a finished look fast
and accept per-role art (and the simpler code). **A** is the genuine quick win if
you just want a bump now with no assets. Avoid **D** for the walk cycles.

### Open decisions (needed for Stage 2, not Stage 1)

1. **Art source** — B / C / A / E above.
2. **Palette-collapse (v2 note 6):** if the `scrubs` archetype tints 8 roles,
   either the art adds per-role silhouette detail OR the clinical palette gets a
   re-spread (evs/maintenance ~7°, sonographer/radTech ~21° today). Which?
3. **Variants:** keep 8 patient / 4 staff, or trim (fewer tint combos = less art)?
4. **Target style** — pixel-art, clean flat-shaded, matched-to-current?
5. **Loading state:** minimal spinner, or accept a slightly longer blank first
   frame (fallback covers a missing atlas)?

---

## Workflow (per `CLAUDE.md`)

DRAFT → **owner sign-off on §1** → **2 independent split-lens pre-impl reviews**
(one code/contract: the async-boot ripple, the compositor, the fallback, save-
neutrality; one art/render-feel: the archetype mapping, the anchor spec, facing/
walk legibility) → implement **Stage 1** → post-impl review → **Stage 2** art
swap → visual acceptance. The GDD/tech-plan §2.6 + the `INVARIANTS` art line are
amended as part of Stage 1 landing.
