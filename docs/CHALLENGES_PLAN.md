# Phase 2 — Seed Challenges (scoping draft)

**Status: SCOPED & OWNER-RATIFIED (2026-07-17). Ready for implementation; not
yet built.** Detailed scope for `docs/PERSISTENCE_PLAN.md` §Phase 2 ("async
multiplayer without a backend"). Hardened by 3 adversarial review rounds; the
six owner decisions are ratified in §10. Implementation begins with the standard
pre-implementation review of the *code* plan (this doc is the design contract).
The V1 stance holds: **no backend, no accounts, no database.**

Companion to `PERSISTENCE_PLAN.md` (persistence roadmap) and `TECH_PLAN.md`
(architecture / SSOT §3.1). Where they disagree with this doc, they win until
this doc is ratified.

**Revision:** Draft v5 — v1→v3 incorporated adversarial review rounds 1-3; v4
folded in the ratified owner decisions (§10). v5 revises decision #2 after the
**pre-implementation code-plan review** (`docs/CHALLENGES_IMPL_PLAN.md`): the
rules-identity comparability notice is **deferred to Phase 3** (§2.1) — both the
manual and auto-hash options were poor trades, and Phase 2's honor-system +
co-versioned live deploy make the warning low-value. Round 1 independently
verified the core determinism premise (the `src/sim/` tree is free of
`Math.random`/`Date.now`/`performance.now`/`new Date` and of non-IEEE-safe float
ops, so identical inputs yield identical streams cross-machine).

---

## 1. What a seed challenge is

A **challenge** is a fixed, shareable scenario that makes two players' runs
directly comparable. Everything the *simulation* does is identical between
players; the **only** variable is the player's own decisions (what to build,
who to hire, when). Score is a day-N outcome.

> Comparability principle: **same inputs to the sim ⇒ same arrival stream and
> same world evolution for a given command stream.** The player's command
> stream is the skill differentiator; nothing else may differ.

**Phase 2 ships ONE flavour: the seed challenge** — `?challenge=<id>` or
`?seed=N&goal=…`: a fresh deterministic run (`setupNewGame` start) with a goal.
Save-file challenges ("here's my hospital at day 10 — survive the wave") are
**deferred out of Phase 2** (§3.1) because they cannot be scored comparably or
shared without changes this phase deliberately avoids.

Phase 2 comparison **never replays a player's command stream** — each run is
self-contained and scored live on the player's own machine. Command
*application timing* (which tick a build lands on) is therefore part of that
player's own outcome and needs no cross-player determinism; deterministic
`applyAt(tick)` scheduling stays a Phase-3 concern. (The existing fixed-seed
replay test guarantees save→load→run parity with *no new commands* — it does not
and need not guarantee that a command intent reproduces across sessions.)

---

## 2. Determinism completeness — what a challenge MUST pin

For two players' runs to be comparable, **every input to the sim except the
player's commands** must match. Round 1 enumerated the sim's inputs and
confirmed there are three; the third is a real gap today.

1. **Seed** — drives every `world.rng` draw: arrivals, acuity, wrong-turn
   rolls, treatment success, the hiring candidate pool, generated names. The
   `?seed=` value, canonicalized to `[0, 2^31)` (§4). ✓
2. **Starting scenario** — the world *before* any player command. In Phase 2
   this is always `setupNewGame` (fixed reception + waiting room + one
   receptionist). ✓
3. **Rules identity — THE GAP.** The sim's output for a given (seed, scenario,
   commands) depends on the **entire `src/sim/` tree**: `BALANCE` and every
   `src/sim/data/*` table, but ALSO `formulas.ts`, `clock.ts` (tick/day
   constants and `gameMinutes→ticks` rounding), `world.ts` (spawn / routing /
   reservation / `closeDay` / `applyReputation` logic), `rng.ts`, `build.ts`,
   and `path/astar.ts` (path choice changes arrival timing and per-tile
   wrong-turn rolls). `SAVE_VERSION` does **not** change when any of these are
   edited. A challenge MUST stamp a **rules identity**; comparison across
   mismatched identities is *flagged, not trusted*. → §2.1.

**Phase-2 invariant (promoted from PERSISTENCE_PLAN's Phase-3 note):** because
Phase-2 comparison is inherently cross-device, the "no `Math.sin/cos/tan/pow/
sqrt/exp/log` in `src/sim/`" rule becomes a **Phase-2 invariant enforced by
lint/test**, not just a Phase-3 aspiration — a future `formulas.ts` that adds
`Math.pow` would silently break cross-machine comparability under an unchanged
`RULES_VERSION`. Grep is clean today; the guard keeps it clean.

### 2.1 Rules identity — the "may not be comparable" NOTICE is DEFERRED to Phase 3

**OWNER RULING (2026-07-17, revised after the pre-implementation review): Phase 2
ships NO comparability warning.** The rules-identity *gap* (input 3 above) is
real, but the pre-impl review showed every Phase-2 mechanism for surfacing it is
a poor trade: a manual `RULES_VERSION` is ongoing effort the owner explicitly
wants to avoid, and an automatic `src/sim/**` hash is noisy (fires on cosmetic
edits → the notice gets ignored) AND adds a Vite plugin + CRLF normalization.
Since **Phase 2 is honor-system (§7) and the live auto-deploy keeps players
co-versioned** (everyone on `hospital-sims.vercel.app` runs the same build; a
built-in challenge always resolves from the current table), the warning's value
is small. **Deferred to Phase 3**, where command-log replay makes comparability
*verifiable* and the rules fingerprint gets a real home.

Consequences for the Phase-2 design: `ChallengeSpec` carries **no** rules-hash
field, ad-hoc URLs carry **no** `&r=` param, and there is no mismatch notice or
`RULES_HASH` build plugin. **The one guard that STAYS is the float-op lint**
(§2 invariant) — keeping `src/sim/` cross-machine-deterministic is a Phase-3
prerequisite worth protecting now, at zero cost.

Options originally considered for a Phase-2 notice (all now deferred):
- **(a) Manual `RULES_VERSION` integer**, bumped on ANY behavior-changing edit
  **anywhere in `src/sim/`**. Simple, honest about logic changes, one SSOT
  constant. Cost: discipline (same failure class as the "new World field → save
  checklist" rule — mitigated the same way: a documented checklist + a test
  guard, see below).
- **(b) Build-time content hash** over the `sim/data/*` tables. Automatic for
  *data* changes, but **blind to logic changes** in `formulas.ts`/`world.ts`/
  `astar.ts`/etc. (edit the dispatcher, hash unchanged) — false confidence, and
  those non-data files are the majority of the determinism surface (finding
  MAJOR 2). Adds build tooling.
- **(c) Hybrid**: data-hash + manual `SIM_LOGIC_VERSION`. Most precise, most
  moving parts.

(Deferred: none of these ship in Phase 2 — see the ruling above.)

---

## 3. The `ChallengeSpec` model + SSOT placement

One internal shape, produced by two sources (DRY — one validator, one resolver):

```ts
// src/sim/data/challenges.ts  (SSOT — as const table + derived types)
// A curated, named, built-in challenge. No rules field: a built-in resolves
// from the CURRENT table, so it always carries the current build's RULES_HASH.
interface ChallengeDef {
  id: string;             // stable slug, used in the URL
  label: string;          // display name
  blurb: string;          // one-line pitch
  seed: number;           // pins the arrival stream (canonicalized [0, 2^31))
  goal: ChallengeGoal;    // §5
}

// Resolved, validated form the game actually runs on. BOTH the built-in table
// and an ad-hoc URL resolve to this — nothing downstream knows which source.
interface ChallengeSpec {
  source: 'builtin' | 'url';
  id: string | null;               // builtin id, or null for ad-hoc
  scenario: { kind: 'default'; seed: number }; // seed lives WITH the scenario
  goal: ChallengeGoal;             // §5
  // No rules-identity field in Phase 2 (§2.1 — comparability notice deferred).
}
```

`seed` lives **inside** the `default` scenario variant, not on the spec (finding
MINOR 5): it is meaningful only for a generated run. When save-file scenarios
return (Phase 3), they add a `{ kind: 'save'; … }` variant whose determinism
comes from the save's persisted `rngState`, not a top-level seed.

SSOT/DRY placement (the coding-discipline core):
- **Challenge data** (built-in defs, the goal-metric registry, `RULES_VERSION`)
  lives ONLY in `src/sim/data/` as `as const` tables; types derive via
  `keyof typeof` (§3.1 rule 1).
- **Parsing + validation + resolution** live in ONE pure, renderer-free module
  `src/sim/challenge.ts` (sim-side, unit-testable, no Pixi/DOM). `main.ts` calls
  it; it never re-parses URLs itself. (Today seed parsing is inline in
  `main.ts`; challenges centralize it and the bare-`seed` parse should migrate
  here too, so one module owns all boot-param grammar.)
- **Scoring** is a pure function in `src/sim/formulas.ts` reading a
  `ChallengeContext` (§5) — called by the result UI and any harness test alike.

### 3.1 Save-file challenges — DEFERRED out of Phase 2 (owner confirm)

Round 1 (MAJOR 4) showed folding them in now is unsound:
- A Phase-1 `SaveData` has **no field for `goal` or `rulesVersion`**, so the
  comparability notice (§2.1) could never fire and carrying the goal in the file
  means a `SAVE_VERSION` bump + serializer/validator changes — contradicting
  "zero new load logic."
- A save is tens of KB; a **URL cannot carry it**, so a save-file challenge has
  **no shareable channel** without a file hand-off, which defeats the one-click
  share story.

**Proposed: move save-file challenges to Phase 3**, where the command-log replay
format (needed anyway for verifiable results) gives them both a compact
shareable scenario and a versioned goal home. Phase 2 = seed challenges only.
*This narrows PERSISTENCE_PLAN §Phase 2 — flagged for owner sign-off (§10 Q6).*

---

## 4. URL contract (extends the `main.ts` boot path)

Current boot params (`main.ts:132-163`): `?load=<slot>`, `?seed=<digits>`, else
title. A bare malformed `seed` currently **rolls a fresh random seed**
(`main.ts:159-160`) — which for a challenge would silently give every recipient
a *different world*. So challenges must preempt that path.

New precedence, all parsing in `src/sim/challenge.ts`:

1. `?load=<slot>` — unchanged (existing invariant preserved).
2. **Challenge branch — fires when `challenge` OR `goal` is present**, ahead of
   the bare-`seed` branch:
   - `?challenge=<builtin-id>` — self-contained: the table supplies seed + goal
     + rulesVersion. The primary shareable form. An extra `seed`/`goal` param
     alongside a builtin id is **ignored** (the table wins), so a copy-paste
     artifact can't produce a conflicting or different-looking-but-same run
     (round-2 nit).
   - `?seed=N&goal=<metric>:<day>` — ad-hoc: `seed` required, resolves to
     `source:'url'`. (No `&r=` rules-fingerprint param in Phase 2 — §2.1.)
   - **A malformed challenge (unknown id, bad `goal`, `goal` without `seed`,
     out-of-range seed) is a readable boot-failure card (`showBootFailure`),
     NEVER a fresh random roll.** This is the MAJOR-3 fix: presence of
     `challenge`/`goal` disables the roll-fresh fallback entirely.
3. `?seed=<digits>` (no challenge/goal) — unchanged bare-seed behavior.
4. else → title.

**Seed canonicalization (finding NIT 2):** challenge seeds — builtin and ad-hoc
— are constrained to `[0, 2^31)` and normalized *before* display, so the URL
identity, `world.seed`, and the HUD chip always agree (today `main.ts` accepts
`/^\d{1,10}$/` up to 9,999,999,999 while `SeededRng` does `seed >>> 0`, so
`?seed=5000000000` would run as a different, aliased world). The bare-`seed`
path's existing range behavior is left alone; only challenge seeds tighten.

---

## 5. Scoring — metric-agnostic, snapshot-sourced, terminal-aware

Do NOT hardcode "reputation" or "cash". A challenge's `goal` names a metric from
an SSOT registry, so the owner's choice is *data*, not code:

```ts
// src/sim/data/challenges.ts
interface ChallengeGoal {
  metric: ScoreMetricId;   // keyof typeof SCORE_METRICS
  day: number;             // integer ≥ 1; scored at this day's close
  target?: number;         // optional pass/fail threshold; absent = compare raw
}
```

**The scoring context (findings MINOR 1 + round-2).** `DayReport` holds the
*current day's* tally (reset at midnight) plus true snapshots of
`cash`/`reputation`. Cumulative counts live on `World` as the flat scalars
`lifetimeTreated`/`lifetimeDied` (`world.ts:89-91`, serialized in `save.ts`) —
there is **no grouped `lifetime` object** today (round-2 correction; v2 wrongly
called it existing SSOT). A metric selector receives a `ChallengeContext`,
assembled once at the terminal:

```ts
interface ChallengeContext {
  outcome: 'reached' | 'dnf';
  report: DayReport | null;   // goal.day DayReport on 'reached'; null on 'dnf'
  terminal: {                 // ALWAYS present (on 'dnf' from the gameOver payload)
    cash: number; reputation: number;
    lifetimeTreated: number; lifetimeDied: number;
  };
}
// SCORE_METRICS[id] = { label, kind, select(ctx): number | null }
// snapshot   → ctx.terminal.cash / .reputation           (reached AND dnf)
// dailyFlow  → ctx.report?.treated / dayNet(ctx.report)  (null on dnf — no day closed)
// cumulative → ctx.terminal.lifetimeTreated / .lifetimeDied
```

`select()` is the ONE place a metric maps to a number; it reads existing SSOT
fields only (no re-tally). `terminal` is populated on BOTH terminals — the
`gameOver` event already carries cash/reputation/treated/died
(`world.ts:1171-1177`), so snapshot and cumulative metrics score on a DNF too;
only daily-flow metrics return `null` on DNF (no day closed). **Cumulative
metrics today are limited to treated/died** — any further cumulative counter
("total revenue by day N") is deliberate NEW work (a new `World` counter + save
field + `SAVE_VERSION` bump), not free (§10 Q1 is capped accordingly).

**`goal.day` semantics — pinned (finding MINOR 2).** `closeDay` emits
`report.day = clock.day - 1` — **1-based, end-of-day** — at
`tick = day × TICKS_PER_DAY`, and the snapshotted `reputation` **already
includes that day's close bonus** (applied before the snapshot). The scoring
predicate is exactly `report.day === goal.day`. Validator: `goal.day` is an
integer `≥ 1`.

**Terminal-awareness — game-over before goal.day (finding MAJOR 1).** A run can
go bankrupt before reaching `goal.day`; `World.tick()` becomes a no-op after
`gameOver` and `closeDay` is gated on `!gameOver`, so **`dayEnded` for
`goal.day` may never fire**. The challenge therefore has **two terminals**,
whichever comes first:
- `dayEnded` with `report.day === goal.day` → outcome `reached`, score computed.
- `gameOver` before that → outcome `dnf` (did-not-finish); a target-based
  challenge is a **fail**, a compare-raw challenge records DNF (no number).

Both emit a single `challengeComplete` typed event carrying
`{ spec, outcome, score|null, context }`. A challenge can never silently hang.

**Once-latch (round-2):** the challenge controller latches on the FIRST terminal
and unsubscribes — a `reached` at goal.day followed by a *later* `gameOver` (the
run plays on past the goal, then busts) must NOT emit a second
`challengeComplete`. A single `completed` flag guards it. **DNF ordering
(round-2):** for a compare-raw challenge a DNF sorts below every numeric score,
and the share line prints `DNF (busted day N)` so an exchanged DNF is still
meaningful.

---

## 6. Result surfacing + sharing

On `challengeComplete`, show a result card. Two overlays converge on the same
`dayEnded` tick (findings MINOR 4 + round-2): the always-on `DailyReportModal`
(mounted `main.ts:108`, subscribes to `dayEnded` *itself*) and the challenge
card. "A visible `.modal-overlay` owns the clock" forbids both opening. v2
asserted the card "replaces" the report without saying **who suppresses whom** —
so v3 names a concrete owner:

**Mechanism — a `MidnightModalCoordinator`** (mirrors the `BottomBarDropdowns`
coordinator, HANDOFF §9 ruling). Both `DailyReportModal` and the challenge card
register with it; neither knows the other exists. On each `dayEnded` the
coordinator alone decides which overlay opens: when the active challenge's
`goal.day` closes, it opens the challenge card and the daily report **yields**
(its numbers render *inside* the card, so nothing is lost); on every other
midnight the daily report opens exactly as today. The coordinator is the SINGLE
owner of "which overlay opens at a day boundary." This removes the independent
double-subscription that made "replaces" undefined.

- **`reached`:** coordinator opens the challenge card (daily numbers embedded);
  the card owns the clock and restores speed on close like the daily modal.
- **`dnf`:** the result folds into the **game-over screen** (which already hides
  an open daily report per the M4 invariant) — no coordinator conflict.

The card shows the score/outcome and a **copyable share line** + the challenge
URL to send others. Honor-system by design (§7): the share line is a claim, not
a proof.

---

## 7. Integrity (Phase 2 = honor system, stated plainly)

- **No verification without a backend.** Phase-1 saves are *state, not
  commands*, so you cannot replay someone's play to verify a score. Verifiable
  results need a command-log replay format — explicitly **Phase 3**. Phase 2
  comparison is honor-system; the UI says so.
- **Debug commands break comparability — ALL of them (finding NIT 1).** Not just
  `debugSetCash`/`debugFastForward`: `debugSpawnPatient`, `debugForce`, and
  `debugWalkTo` also apply, and `debugSpawnPatient`/`debugForce` **consume
  `world.rng` draws**, shifting the entire downstream stream. Decision (§10 Q3):
  in challenge mode either DISABLE every `debug*` command at the CommandQueue
  boundary (SSOT — the one mutation gate) or mark the result "debug-tainted".
  Whatever is chosen must cover the complete `debug*` set, enumerated from
  `applyCommand` in `world.ts`.

---

## 8. SSOT / DRY ledger (the discipline this scope commits to)

| Concern | Single source of truth |
|---|---|
| Built-in challenge defs, goal metrics, `RULES_VERSION` | `src/sim/data/challenges.ts` (`as const`; types derived) |
| URL parse / validate / resolve (incl. bare seed, migrated) | `src/sim/challenge.ts` (pure, renderer-free, tested) |
| Score = metric → number | `SCORE_METRICS[*].select(ChallengeContext)` in `formulas.ts` |
| Day-N outcome data | `DayReport` (day flow + cash/rep) + `World.lifetimeTreated`/`lifetimeDied` scalars (cumulative) + the `gameOver` payload (DNF) — no re-tally |
| Scenario start | existing `setupNewGame` |
| Version-acceptance (future save scenarios) | existing `isLoadableVersion` |
| Midnight overlay ownership | new `MidnightModalCoordinator` (daily report + challenge card register; neither knows the other — §6) |
| Terminal detection | existing `dayEnded` / `gameOver` events (no new polling) |

No game number, metric, or challenge parameter exists outside `src/sim/data/`.
The renderer/UI reads challenge state; it never owns it.

---

## 9. Test plan (renderer-free, per milestone workflow)

- `challenge.ts` parse/validate: valid + every malformed URL form — unknown id,
  goal-without-seed, bad metric, non-integer/`<1` day, out-of-range seed; assert
  each yields a boot-failure, **never a fresh random roll** (MAJOR 3).
- Determinism: same `ChallengeSpec` → identical arrival stream (extends the
  fixed-seed replay test).
- Scoring: each `SCORE_METRICS` selector reads the right field for its `kind`;
  score sampled at exactly `report.day === goal.day`, reputation includes the
  close bonus (MINOR 2).
- **Terminal: bankruptcy before `goal.day` → one `challengeComplete{dnf}`, no
  hang, target-based = fail** (MAJOR 1); snapshot/cumulative metrics still score
  from `terminal`, daily-flow metrics score `null` (round-2).
- **Once-latch: a `reached` at goal.day followed by a later `gameOver` emits
  exactly ONE `challengeComplete`** (round-2).
- **`MidnightModalCoordinator`: on the goal.day close the challenge card opens
  and the daily report yields; on any other midnight the daily report opens**
  (round-2).
- `RULES_VERSION` mismatch → notice surfaced, run still boots (no crash/refusal).
- Float-determinism lint: assert `src/sim/` has no `Math.sin/cos/tan/pow/sqrt/
  exp/log` (MINOR 3 invariant).
- `RULES_VERSION` guard — **a CI / pre-commit git-diff check, NOT a Vitest unit
  test** (a unit test has no view of the commit delta): fires on a `src/sim/**`
  behavioral change with no version bump (MAJOR 2), silent on a pure
  version-bump commit.

---

## 10. Owner decisions — RATIFIED (2026-07-17)

1. **Scoring default = reputation, compare-raw** (leaderboard-style: highest
   reputation by the challenge's day wins). The `SCORE_METRICS` registry still
   supports cash / treated / died for other challenges; day is per-challenge.
2. **Rules identity = no Phase-2 warning** (§2.1 ruling, revised after the
   pre-impl review). A comparability notice is DEFERRED to Phase 3 (verifiable
   replay); Phase 2 is honor-system + co-versioned on the live deploy, and both
   the manual and auto-hash options were poor trades. Only the float-op
   determinism lint stays.
3. **Debug commands in challenge mode = disabled** — every `debug*` is blocked at
   the CommandQueue boundary while a challenge is active (§7); a challenge run is
   provably debug-free.
4. **Verification = honor-system for Phase 2** (owner default) — verifiable
   command-log replay is deferred to Phase 3.
5. **Launch roster = a few curated built-in challenges + ad-hoc `?seed=…&goal=…`
   URLs** (owner default).
6. **Save-file challenges = deferred to Phase 3** (confirmed, §3.1) — this
   narrows PERSISTENCE_PLAN §Phase 2 to seed challenges.

**Residual, non-blocking (decide during implementation):** the exact metric set
beyond reputation; the content of the curated built-in roster; the flagship
challenge's day-N. None gate starting the build.

## 11. Explicitly OUT of Phase 2 (stays Phase 3)

Save-file challenges (§3.1); the rules-identity comparability notice / fingerprint
(§2.1); command-log replay / verifiable results; any leaderboard or cross-device
sync (needs a backend + database); `applyAt(tick)` deterministic command
scheduling; real-time/lockstep play. Phase 2 ships *shareable, honor-system*
**seed** challenges on the determinism we already have — nothing more.
