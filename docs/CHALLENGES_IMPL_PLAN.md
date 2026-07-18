# Phase 2 — Seed Challenges: implementation plan (draft v2)

**Status: PLANNING (2026-07-17). No code yet.** How to build the ratified scope
in `docs/CHALLENGES_PLAN.md`. This is the *code* plan; it passed one
pre-implementation adversarial review (2 major, 4 minor, 2 nit) — v2 folds the
findings in. Design decisions live in CHALLENGES_PLAN; this doc is file layout,
APIs, ordering, and tests only. SSOT §3.1 governs throughout.

**v2 changes (pre-implementation review):**
- **Rules-identity notice DEFERRED to Phase 3** (review MAJOR-1 + owner "least
  effort" directive): the `RULES_HASH` Vite plugin, its CRLF-normalization, the
  dev sentinel, and the `authoredHash`/mismatch-notice are all removed from
  Phase 2. Phase 2 is honor-system and live-site players are co-versioned, so the
  warning is low value; Phase 3's command-log replay makes comparability real.
  *(Reverses ratified decision #2 — flagged for owner confirm.)*
- **Modal seam resolved** (MAJOR-2): the coordinator is the SINGLE `dayEnded`
  subscriber and calls the controller synchronously — no emit/mount-order race.
- Constructor default, `resolveBoot`, and reached-path context reads folded in.

---

## 1. File manifest

**New (sim — Track 1):**
- `src/sim/data/challenges.ts` — SSOT `as const`: `CHALLENGE_DEFS` (built-in
  roster), `SCORE_METRICS` (id → `{ label, kind }`), goal/metric literal types
  derived via `keyof typeof`.
- `src/sim/challenge.ts` — pure, renderer-free: `resolveBoot(params)` (the whole
  boot-branch decision as a discriminated union), URL parse/validate →
  `ChallengeSpec`, seed canonicalization, goal grammar.

**New (UI — Track 2):**
- `src/ui/challengeController.ts` — `resolveIfTerminal(report)` +
  `onGameOver(payload)`; computes the score at the first terminal, once-latches,
  emits `challengeComplete`.
- `src/ui/midnightModal.ts` — `MidnightModalCoordinator` (the SINGLE `dayEnded`
  subscriber; owns which overlay opens at a day boundary).
- `src/ui/challengeResultCard.ts` — result overlay + share line.

**Touched:**
- `src/events.ts` — add `challengeComplete` to `EventMap` (payload SSOT).
- `src/sim/formulas.ts` — add pure `scoreChallenge(goal, ctx)` (§3.1 derived).
- `src/sim/world.ts` — add `challengeMode` (defaulted ctor arg); `applyCommand`
  rejects every `debug*` when set (the one mutation gate — scope §7).
- `src/main.ts` — call `resolveBoot`; construct World with `challengeMode`; mount
  controller + coordinator + card.
- `src/ui/dailyReport.ts` — register with the coordinator instead of subscribing
  to `dayEnded` directly.
- `src/ui/title.ts` — a "Challenges" entry listing built-ins.
- `vite.config.ts` — **untouched** in Phase 2 (no hash plugin).
- `src/ui/ui.css` — result-card styles (reuse `.modal-*`).

`src/sim/save.ts` is **NOT** touched — see §4 (defaulted ctor arg keeps its
`new World(...)` call site compiling).

---

## 2. Frozen contract (freeze FIRST; both tracks build against this)

```ts
// events.ts
challengeComplete: {
  spec: ChallengeSpec;
  outcome: 'reached' | 'dnf';
  score: number | null;      // null = daily-flow metric on a DNF (scope §5)
  context: ChallengeContext;
};

// sim/world.ts — defaulted so save.ts + every test call site compile untouched
class World { constructor(events: EventBus, seed: number, challengeMode?: boolean) }

// sim/challenge.ts — the ENTIRE boot decision is one pure, testable function
type BootAction =
  | { kind: 'load'; slot: string }
  | { kind: 'challenge'; spec: ChallengeSpec }
  | { kind: 'seed'; seed: number }
  | { kind: 'title' }
  | { kind: 'failure'; reason: string };   // → showBootFailure, NEVER a fresh roll
function resolveBoot(params: URLSearchParams): BootAction;

// sim/formulas.ts
function scoreChallenge(goal: ChallengeGoal, ctx: ChallengeContext): number | null;

// ui/challengeController.ts — the coordinator calls this SYNCHRONOUSLY (see §5)
interface ChallengeResult { outcome: 'reached' | 'dnf'; score: number | null; context: ChallengeContext; }
class ChallengeController {
  resolveIfTerminal(report: DayReport): ChallengeResult | null; // non-null only on goal.day; latches + emits
  onGameOver(payload: GameOverPayload): ChallengeResult | null; // DNF terminal; latches + emits
}
```

`ChallengeSpec` (now WITHOUT any rules-hash field), `ChallengeGoal`, and
`ChallengeContext` are as declared in CHALLENGES_PLAN §3/§5 (v5). Freeze these +
the four signatures above before parallel work.

---

## 3. Rules identity — DEFERRED to Phase 3 (was §3 hash plugin)

Removed from Phase 2 per review MAJOR-1. No `RULES_HASH`, no Vite plugin, no
`&r=` URL param, no mismatch notice. Rationale: Phase 2 is honor-system (scope
§7) and the live auto-deploy keeps players co-versioned, so a comparability
warning is low value; an automatic src/sim hash is also noisy (fires on cosmetic
edits) and non-trivial (build tooling + CRLF normalization). Phase 3's
command-log replay is where comparability becomes verifiable and the rules
fingerprint gets a real home. **The one guard that STAYS is the float-op lint**
(scope §2 invariant) — it keeps `src/sim/` cross-machine-deterministic
regardless, which Phase 3 will depend on.

---

## 4. Determinism & coupling (keep the sim pure)

The challenge is **read-only on the sim** except one gate: `World.challengeMode`
(a defaulted boot-time boolean) makes `applyCommand` reject `debug*`. Everything
else observes events and never mutates the world.
- `challengeMode` defaults to `false`, so `save.ts` (`new World(events, seed)`)
  and every World-constructing test compile untouched.
- Review-confirmed determinism: `debugSpawnPatient`/`debugForce`/
  `debugFastForward` DO draw `world.rng`, but a challenge run has
  `challengeMode = true` and rejects them, so the scored run's stream is
  unperturbed — rejection is a no-op, not a stream shift. `challengeMode` is
  runtime state, not `src/sim` source and not saved.

**Residual — save interaction.** A Phase-1 save has no challenge field, so saving
mid-challenge and reloading via `?load=` yields a NORMAL run. Lean: accept +
document for Phase 2 (least code).

---

## 5. Midnight-modal ownership (review MAJOR-2 — resolved, race-free)

The coordinator is the **single** `dayEnded` subscriber; `DailyReportModal` and
`ChallengeResultCard` register with it and never subscribe to `dayEnded`
themselves. On each close the coordinator calls
`controller.resolveIfTerminal(report)` **synchronously**:
- returns a `ChallengeResult` → the coordinator opens the result card (daily
  numbers embedded) and the daily report yields; the controller has already
  latched + emitted `challengeComplete` (for the share line / telemetry).
- returns `null` → the coordinator opens the ordinary daily report.

Because the overlay choice is a plain return value, it is **independent of
EventBus emit/registration order** (the flaw in v1). DNF: `gameOver` is handled
by the game-over screen path, which calls `controller.onGameOver(payload)` and
folds the result in (game-over already hides an open daily report, M4
invariant) — no coordinator conflict.

---

## 6. Build order (parallel, disjoint file ownership)

0. **Freeze the §2 contract** (types + `challengeComplete` + the four signatures,
   incl. the World ctor arg and `resolveIfTerminal`).
1. **Track 1 (sim):** `data/challenges.ts` → `challenge.ts` (`resolveBoot` +
   parse) → `formulas.scoreChallenge` → `world.challengeMode` gate →
   `events.challengeComplete`. Verifies `tsc`+lint+own tests.
2. **Track 2 (UI):** `challengeController` → `midnightModal` coordinator +
   `dailyReport` registration → `challengeResultCard` → `title` roster →
   `main.ts` wiring + css. Builds against the frozen contract.
3. **Barrier → integration:** drive `?challenge=` and `?seed=&goal=` to goal day
   (result card + share URL) and to bankruptcy pre-goal (DNF) via
   `/run-hospital-simms`.
4. **Two parallel adversarial reviews** (code/contract vs live-drive), fix all,
   regression test per major, gates, commit.

Ownership: `events.ts`/`formulas.ts`/`world.ts` = Track 1 writes; `main.ts` =
Track 2. No file is written by both; the World-ctor signature and
`resolveIfTerminal` are in the freeze so Track 2 isn't blocked.

## 7. Test list (renderer-free unless noted)

- `resolveBoot`: every branch — `load` / `challenge` / `seed` / `title` /
  `failure`; specifically `?seed=<bad>&goal=…` and `?challenge=<unknown>` →
  `failure` (→ boot card), **never** `seed`/`title` (protects scope MAJOR-3 as a
  UNIT test, not just live-drive).
- `challenge.ts` parse: valid + malformed goal/metric/day, seed canonicalization
  ([0,2^31), aliasing), `goal`-without-`seed`.
- `scoreChallenge`: each `SCORE_METRICS` kind reads the right field; sampled at
  `report.day === goal.day`; reputation includes the close bonus; daily-flow →
  `null` on DNF; snapshot/cumulative score on DNF from the `gameOver` payload.
- `challengeController`: once-latch — `reached` then a later `gameOver` = ONE
  emit; `gameOver` before goal = ONE `{dnf}`; reached-path context reads
  `world.lifetimeTreated/Died` directly (they're public, `world.ts:89-90`).
- `world.challengeMode`: every `debug*` rejected when true, allowed when false;
  rng stream identical either way.
- Float-determinism lint: `src/sim/` has no `Math.sin/cos/tan/pow/sqrt/exp/log`.
- Coordinator (jsdom/logic): goal-day close → result card + report suppressed
  via the synchronous `resolveIfTerminal` return; ordinary midnight → report.
- Determinism replay: same `ChallengeSpec` → identical arrival stream.

## 8. Residuals to pin during implementation

1. Save/load interaction with an active challenge (§4) — accept-and-document.
2. Result-card copy: share-line text (`reached` and `DNF (busted day N)`).
3. Roster UI depth on the title screen (list vs one flagship) — curated roster
   content is a residual owner call (CHALLENGES_PLAN §10).
