# Click a patient, read THEIR thoughts

**Status:** PARTIALLY SHIPPED — needs a rewrite for the remaining half. The
LIVE-bubble half of the owner's ask SHIPPED (`f9ecbbb`, in-world thought bubbles,
render-only). This doc covers the CARD-HISTORY half (the last N thoughts on the
inspect card). **Reviewed 2026-07-19; the decisions below OVERRIDE the original
draft body — read them before touching §3-§8, which still argue the old bump.**

> ## SETTLED DECISIONS (fold into a rewrite; the draft body §3-§8 is STALE)
> - **NO SAVE_VERSION BUMP.** The draft's headline cost is GONE. Verified: the
>   save reader is key-by-key over `asRecord` (`save.ts:407-410`), which does no
>   unknown-key check, so an older deployed build silently ignores an added
>   `thoughts` field, and the ring is INERT state no old build can corrupt itself
>   with. Every bump in the `save.ts:33-138` policy log is owed to a concrete
>   old-build FAILURE; a dropped thought ring has none. So the field is additive,
>   no gate, `SAVE_VERSION` stays 11. (This is what makes it a small feature.)
> - **Eviction: DEDUPE BY KEY** (owner call). A pure-recency 3-ring is dominated
>   by lost/rescued pairs + restroom/vending spam and evicts the critical/
>   complication thoughts a player actually wants. Dedupe-by-key: a repeated
>   thought replaces its predecessor rather than consuming a second slot.
> - **`thoughtText(key, patientId, tick)` goes in `src/sim/data/thoughts.ts`**,
>   beside `conditionElective`/`roomFailure`/the other table accessors — NOT
>   `formulas.ts` (TECH_PLAN §3.1 names "one pure fn in sim/", not formulas).
> - **Store `{key, tick}`, not text or key-alone.** Text is a pure function of
>   `(key, patientId, tick)`; storing the pair re-derives it exactly. This makes
>   the `THOUGHTS` arrays **append-only and order-frozen** once shipped (a reorder
>   silently rewrites what saved patients "said") — needs an INVARIANTS entry.
> - Back-compat regression must use the REAL downgrade helper
>   (`save.test.ts:840-860`, which DELETES fields), NOT the version-stamp tamper
>   lines at `:534/544/552` (that made a regression vacuous elsewhere).
> - Call-site count for `emitThought` is **11**, not the "9" the draft says.
> - **Lower priority now** — the live surface (bubbles) already delivers the RCT
>   moment; the card history is a nice-to-have, not urgent.

**Origin:** owner ask 2026-07-18. Owner chose shape **(b), the sim ring buffer**.
**Save impact (CORRECTED):** **NONE — SAVE_VERSION stays 11.** The §3 argument
below is superseded.

---

_Original draft below (§1-§8), retained for the design detail; its save-bump
argument (§3) and its "9 call sites" are SUPERSEDED by the box above._

---

## 1. The feature

Today the inspect card shows a patient's condition, acuity, vitals, state,
billed total and a mood emoji (`ui/inspect.ts:217-238`). Their actual thoughts
go **only** to the global 💭 feed, mixed in with everyone else's.

The owner wants the RollerCoaster Tycoon moment: pick up a guest, read what
*that* guest is thinking. Ship: **the last 3 thoughts, newest first, on the
patient inspect card, surviving reload.**

## 2. Why (b) and not the free option

Option (a) — filter the existing thought log by `patientId` — is genuinely
available (`thoughtLog.ts:47` carries the id) and costs nothing. It was
rejected, and the reason is the whole point of the feature:

The log's 100-entry scrollback is **DOM-node trimming**
(`thoughtLog.ts:64`), shared across all patients, and **dies on reload**. So
option (a) produces a card that is empty **exactly when a player most wants
it**: after loading a save, and in the busy hospital that generates the most
interesting thoughts. A feature whose failure mode is correlated with its
moment of value is not a cheap version of the feature — it is a different,
worse feature.

## 3. THE SAVE BUMP — the expensive part, justified explicitly

`SAVE_VERSION 11` is **deployed**, so v12 is **one-way for live players**
(`HANDOFF.md:49,53,140`). This is the first bump spent on a purely
player-facing quality-of-life feature rather than on content or correctness.
The reviewer should challenge it.

The argument for spending it: the ring is the *only* thing that makes the card
non-empty after a load, per §2. There is no half-measure that survives reload.

**Bump hygiene (mirrors the v11 precedent, `save.ts:33-138`):**
- `SAVE_VERSION = 12` (`save.ts:31`). `isLoadableVersion` (`:139`) needs no
  edit — it is `>= 1 && <= SAVE_VERSION`.
- One new migration paragraph in the running prose log (`:33-138`).
- `readPatient` gate: `saveVersion < 12 → []`. Follow the existing inline
  pattern (`readPatient`'s `V4` const at `:752`, ternaries `:780-787`).
- **v1–v11 saves must load**, with an empty ring. Regression required (§7).

**No fixture regeneration.** There are no on-disk save fixtures; the
byte-identity tests self-generate by round-trip (`save.test.ts:501`, `:910`,
`:1459`; `edRatio.test.ts:959`) and old-version payloads are built by
downgrading a fresh save in memory (`save.test.ts:534,544,552`).

## 4. THE DESIGN FORK — what exactly is stored

Thought text is **not** stored on the patient today; it is hash-picked at emit:

```ts
// world.ts:1892-1899
const options = THOUGHTS[key];
const text = options[(patient.id + this.clock.tick) % options.length]!;
```

Three candidates. **This contract asserts (iii); a reviewer should confirm.**

| | stored | reload fidelity | save size | verdict |
|---|---|---|---|---|
| (i) | `text` | exact | largest — duplicates `THOUGHTS` content into every save | rejected: content in saves |
| (ii) | `key` only | **wrong** — variant re-picks against the *load* tick | smallest | **rejected: silently changes what the patient said** |
| (iii) | `{ key, tick }` | exact — re-derives the same variant | small (2 ints) | **adopt** |

(iii) is the minimal faithful pair: `text` is a pure function of
`(key, patient.id, tick)`, and `patient.id` is already saved. **The stored
`tick` is not redundant bookkeeping — it is what makes the variant
reproducible**, and it doubles as the timestamp the card needs for a
"14 min ago" affordance.

**Consequence:** re-deriving text means the UI needs the same expression the
sim uses. That expression must move into **one exported pure function** —
`thoughtText(key, patientId, tick)` — called by `emitThought` AND the card.
This is tech plan §3.1 (derived values are pure functions in `formulas.ts`,
called by sim and UI). Duplicating the modulo in `inspect.ts` would be an
SSOT violation and should be rejected in review.

## 5. Implementation shape — match the existing idiom, invent nothing

The codebase already has exactly one in-sim capped array, and it is the
pattern to copy (`world.ts:141-143`, `:2238-2241`):

```ts
this.history.push({ ...report });   // a COPY — never alias what you store
while (this.history.length > BALANCE.finance.historyCapDays) this.history.shift();
```

So: **plain array, push + `while (len > cap) shift()`, cap in `BALANCE`.**
**Do not build a head/tail index ring** — it is not the house style and it
serializes worse.

| file | change |
|---|---|
| `src/sim/data/balance.ts` | `thoughts.perPatientCap: 3` — a NUMBER IN BALANCE, not a module const (`no-magic-numbers` is scoped to `sim/systems/` + `ui/`, but SSOT applies regardless) |
| `src/sim/data/thoughts.ts` | export `thoughtText(key, patientId, tick)` — the §4 pure function |
| `src/sim/entities/patient.ts:79-127` | `thoughts: RecentThought[]` — new type `{ key: ThoughtKey; tick: number }` |
| `src/sim/world.ts:1638` | spawn init `thoughts: []`. **MUST NOT draw from `this.rng`** — the RNG draw order is pinned (`world.ts:1664-1666`) and a draw here re-pins every fixed-seed expectation in the suite. A `[]` literal is safe. |
| `src/sim/world.ts:1892` | `emitThought` — push + trim, then emit as today. One insertion covers all 9 call sites. |
| `src/sim/save.ts` | `SAVE_VERSION` 12; `SavedPatient.thoughts` (append at a deliberate position, comment it "FROZEN position … (byte-identity)" per the `:259`/`:266` precedent); `writePatient` `:717-747`; `readPatient` `:749-794` + `< 12` gate |
| `src/ui/inspect.ts:217-238` | render the ring in the patient branch |
| `src/ui/ui.css` | a thought-block class |

**`emitThought` is a genuine single choke point** — 9 call sites, and the only
`events.emit('patientThought', …)` in `src/` is `world.ts:1895`. One line
covers the whole game. Verify this still holds at implementation time; if a
second emit site has appeared, the design assumption is broken.

### 5.1 Two traps

- **The card re-renders every frame.** `InspectPanel.update()` is polled per
  frame and calls `renderBody(selection)` **unconditionally** (`inspect.ts:110`);
  only the DOM *skeleton* is keyed on selection identity (`shownKey`, `:51`,
  `:102-108`). So the ring updates live with **zero invalidation plumbing** —
  do not add any.
- **Escaping.** The patient branch builds `innerHTML` with `esc()` on every
  interpolation. Thought text is authored content, not user input, but it must
  still go through `esc()` — the thought log deliberately uses `textContent`
  (`thoughtLog.ts:52`), and inconsistency here is how an XSS-shaped bug gets
  introduced later.

### 5.2 Load-time robustness — trim, never reject

`save.ts:603-609` sets the precedent and states the reason: coupling save
validity to a tunable "would brick every existing save the day the cap is
lowered." So `readPatient` must **trim to the balance cap**, not `fail()` on an
over-cap array, with a separate structural hard bound for hostile input
(the `MAX_HISTORY_ENTRIES = 1000` pattern, `save.ts:610`). An unknown
`ThoughtKey` in a save must be **dropped, not fatal**.

## 6. Explicitly out of scope

- Any change to the global thought log.
- Thoughts for staff.
- Surfacing the ring anywhere but the inspect card.
- Changing `THOUGHTS` content, or when thoughts fire.

## 7. Regressions required (one per major claim)

1. **Ring caps and evicts** — emit 5 thoughts, assert length 3 and that the
   oldest two are gone, newest-first ordering as rendered.
2. **Variant fidelity across save/load** — a patient with thoughts survives a
   round-trip and `thoughtText` returns the **identical string** before and
   after. This is the §4(iii) claim; it is the test that would have caught (ii).
3. **v11 → v12 back-compat** — a v11 save loads, patients get `thoughts: []`,
   no throw. Extend to v1 per the existing downgrade helper.
4. **Byte-identity round-trip still holds** — save → load → save
   (`save.test.ts:501` pattern) with a populated ring.
5. **Determinism unchanged** — two worlds on the same seed produce identical
   state after N ticks. Pins the §5 "no rng draw at spawn" requirement.
6. **DOM** — `inspect.dom.test.ts` (`fixture()` `:21`, patient cases `:54`): a
   selected patient with thoughts renders them; one with none renders no empty
   block.
7. **Over-cap save trims rather than fails** — pins §5.2.

## 8. Open questions a reviewer must settle

1. **Is the SAVE_VERSION 12 bump worth it for a QoL feature?** §3 makes the
   case; the reviewer should push back if the answer is no. A defensible
   alternative: **bank this and spend the bump when the next content or
   correctness change needs one anyway**, shipping both under one version.
   That is a real option and this contract does not dismiss it.
2. **Is 3 the right cap?** The handoff said 3–5. 3 is asserted for card space.
3. **Should the card show elapsed time** ("14 min ago")? The stored tick makes
   it free; it is also new UI surface and more to get wrong.
4. **Does `thoughtText` belong in `thoughts.ts` or `formulas.ts`?** §3.1 of the
   tech plan says derived pure functions live in `formulas.ts`; co-locating with
   the `THOUGHTS` table also has a case. Settle it.
5. **Should the ring record thoughts a patient has while off-screen/discharged?**
   Discharge emits a thought (`world.ts:2058`) — is the patient still
   selectable at that point, and does the last thought ever get seen?
