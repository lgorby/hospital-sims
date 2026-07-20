# Character Sprite-Atlas Milestone (Tier B) — PLAN

**Status: DRAFT / NOT READY.** Do not write code until: (a) the owner ratifies
the §2.6 "100% procedural art" contract change (§1 below), (b) two independent
split-lens pre-implementation reviews have run, and (c) Stage-2 art is sourced.
This doc frames the design, the effort, and the risks so those reviews have a
target.

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

**The archetype mapping is the art-volume win.** Instead of 12 fully-drawn kinds,
author a handful of garment archetypes and tint them per role:

| Archetype | Roles | Tinted region |
|---|---|---|
| `gown` | patient | gown = fixed; skin/hair per variant |
| `scrubs-cap` | nurse, respTherapist, surgeon* | scrub top/cap = `ROLE_DEFS.color` |
| `coat` | doctor | coat fixed white; shirt accent = role color |
| `shirt` | receptionist, radTech, sonographer, greeter, evs, maintenance, anesthesiologist | torso = `ROLE_DEFS.color` |

`*surgeon` = `scrubs-cap` + a `mask` accessory layer. Archetype is derived from a
small `Record<CharacterKind, Archetype>` (compile-complete, so a new role must be
mapped or it fails a test — the `CATEGORY_LABELS` precedent). `SCRUB_CAP_ROLES`
(already an SSOT export) seeds the scrubs archetype membership.

**Layer set per archetype × facing × frame** (authored grayscale/neutral):
`body` (skin, tinted by variant skin-tone), `hair-or-cap` (tinted by variant hair
OR role color for caps), `outfit` (tinted by `ROLE_DEFS.color`), `accessories`
(mask / stethoscope / badge — fixed colors, no tint). This is the §4 art spec.

*Alternative considered — live multi-layer tint (no bake):* each actor becomes a
`Container` of 2–4 tinted sprites synced per frame. Fewer baked textures, but it
changes the hot path (more draw objects per actor, the sync loop rewritten) and
risks the 60fps DoD invariant. **Rejected** for Stage 1 in favour of baking,
which keeps the hot path byte-identical. Revisit only if texture memory becomes a
real constraint (it does not at ~1040 textures today).

---

## §3 — What changes in code (small), what doesn't (the hot path)

**Changes — all inside `generateCharacterTextures` + boot wiring:**
- `generateCharacterTextures` becomes **async**: `await Assets.load(atlas)` →
  composite+tint+bake per key → return the same `Map<string,Texture>`.
- Renderer init becomes async (it currently calls the sync generator in the
  constructor). Ripples to `main.ts` boot: a **loading state** before the world
  renders (the title screen is the natural gate — boot is already staged there).
- A new `archetypeOf(kind)` map + a tint-composite helper. `drawCharacter` is
  **retained** as the fallback layer source (§6), refactored to emit per-layer
  grayscale graphics rather than one baked figure (so the same compositor serves
  both the procedural-fallback and the authored-atlas paths — one code path, two
  layer sources).

**Does NOT change:** `characterKey`, `variantFor`, `FEET_ANCHOR`,
`CHARACTER_FRAMES`, `PHASES`, `facingFromStep`, `makeCharacterSprite`, the
per-frame `sprite.texture = …get(characterKey(...))` sync, the depth sort, the
2-rigs-mirrored facing scheme. The atlas-lookup contract is the firewall.

---

## §4 — The art spec (the unforgiving constraint on whoever draws it)

This is where a milestone like this usually dies — art authored off-spec makes
actors float, sink, or jitter. The spec is non-negotiable:

- **Canvas / bounds:** every layer frame draws inside the pad rect **x −9..9,
  y −46..1** (the current `FEET_ANCHOR = 46/47` depends on it). The **planted
  foot sits at y = 0** in every frame; the *bob* moves the body, never the feet.
- **Facings:** author **two rigs only** — front-right (SE) and back-right (NE).
  SW/NW are the horizontal mirror, baked at composite time (renderer keeps
  `scale.x = 1`). SE/SW show the face; NE/NW show the back of the head.
- **Frames:** 5 per facing — frame 0 idle, frames 1–4 the walk cycle matching
  `PHASES` (contact / pass / contact / pass, alternating lifted foot + bob).
- **Layers:** separate, registered PNGs (or one packed atlas + JSON frame data):
  `body`, `hair`, `cap`, `outfit`, `mask`, `steth`, `badge`. **Tintable layers
  are authored near-white** so a multiply tint reads true; fixed layers are
  authored in final color. The renderer never needs to know pixel details — only
  which layers an archetype composites and which tint each takes.
- **Variety:** the 8 patient / 4 staff variants are produced by **tinting** the
  `body`/`hair` layers (skin-tone × hair-color combos, the current
  `SKIN_TONES`/`HAIR_COLORS` tables), NOT by authoring 8 bodies. Whether to keep
  8/4 or trim is an owner/art call (§10).

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

This is the de-risking spine. Split the milestone so the code is fully testable
with zero art dependency:

- **Stage 1 — CODE ONLY, no external art, ~no visible change.** Build the async
  load + layer-composite + tint-bake + fallback pipeline, fed by a grayscale
  atlas **generated from the current procedural art** (`drawCharacter` refactored
  to emit grayscale per-layer sources). This proves the *entire* architecture —
  boot flow, compositor, tint tables, contract tests, fallback — with **no
  artist engaged**. Visible result ≈ today, by design. Full workflow + reviews
  run here.
- **Stage 2 — ART, the visible upgrade.** Swap the procedural grayscale layers
  for authored PNG layers to the §4 spec. Pure asset swap; Stage-1 code is
  frozen. Visual-acceptance live-drive only.

**Honest framing for the owner:** the *engineering* delivers no visible change on
its own — it makes the game **art-ready** (art drops in with no code). The
*visible* upgrade is Stage 2 and is gated on sourcing art.

---

## §8 — Testing & acceptance

- **Contract tests** (renderer-free where feasible; note the Pixi-in-test caveat
  the `data.test`/`ghostKey.test` split follows): every `characterKey` across
  `kind × variant × facing × frame` resolves to a texture (no missing key);
  `archetypeOf` is exhaustive over `CharacterKind` (a new role fails until
  mapped); the fallback path is selected when assets are absent; baked textures
  honor the pad bounds (the anchor contract).
- **Visual acceptance** (live-drive, `/run-hospital-simms`): all roles readable
  and distinct; 4 facings correct (face toward / back away); walk reads (foot
  planted, bob present); tints match `ROLE_DEFS.color` (this is where the
  colour-spread win pays off again); no float/sink at the feet.

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

- **Stage 1 (code):** ~1–2 focused days — async loader, the composite/tint/bake
  compositor, the `drawCharacter` grayscale-layer refactor, the fallback, the
  boot loading state, and the contract tests. **Low architectural risk** — the
  atlas seam already exists.
- **Stage 2 (art):** external, days–weeks depending on source. The code side is
  a swap.

---

## §11 — Open questions for the owner

1. Ratify the §1 contract change (procedural → fallback + optional atlas)?
2. Art source for Stage 2: commission / asset pack / AI+cleanup?
3. Keep 8 patient / 4 staff variants, or trim (fewer tint combos = less art)?
4. Target style — pixel-art, clean flat-shaded, or matched-to-current? (Drives
   both the art brief and whether the tint-region approach holds.)

---

## Workflow (per `CLAUDE.md`)

DRAFT → **owner sign-off on §1** → **2 independent split-lens pre-impl reviews**
(one code/contract: the async-boot ripple, the compositor, the fallback, save-
neutrality; one art/render-feel: the archetype mapping, the anchor spec, facing/
walk legibility) → implement **Stage 1** → post-impl review → **Stage 2** art
swap → visual acceptance. The GDD/tech-plan §2.6 + the `INVARIANTS` art line are
amended as part of Stage 1 landing.
