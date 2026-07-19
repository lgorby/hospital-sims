# Hospital Simms

Isometric hospital tycoon (RollerCoaster Tycoon × Theme Hospital). TypeScript + PixiJS v8 + Vite, fixed-timestep deterministic sim, DOM-overlay UI.

**Read `docs/HANDOFF.md` first** — orientation: current state, open threads,
gotchas. It is deliberately short enough to read in one pass; keep it that way.

Then, as needed:
- `docs/INVARIANTS.md` — the do-not-regress list. **Read before changing sim
  behaviour.** Every entry came from an adversarial review and has a regression
  test behind it.
- `docs/CHANGELOG.md` — shipped work and the provenance of past decisions.
- `docs/GAME_DESIGN.md` — design contract (Flow rules 1–14, rosters, balance).
- `docs/TECH_PLAN.md` — architecture contract (sim/render split, §3.1 SSOT,
  §2.6 art contract).

## Commands

- `npm run dev` — dev server (localhost:5173)
- `npm test` — Vitest (headless sim tests; all sim logic is renderer-free)
- `npm run build` — `tsc --noEmit && vite build`
- `npm run lint` — ESLint; `no-magic-numbers` is scoped to `src/ui/` and `src/sim/systems/` on purpose (SSOT enforcement, tech plan §3.1)

## Hard rules (established, enforced, reviewed)

1. **SSOT (tech plan §3.1):** every game number lives in `src/sim/data/` only. Types derive from the `as const` tables (`keyof typeof`). Derived values are pure functions in `src/sim/formulas.ts`, called by sim AND UI. Time conversions live in `src/sim/clock.ts` only.
2. **Nothing in `src/sim/` may import Pixi or touch the DOM.** The sim is deterministic: no `Math.random`/`Date.now` — only the seeded `world.rng`. Render-side variety hashes entity IDs instead.
3. **All world mutations flow through the CommandQueue**; sim→UI communication through the typed EventBus (`src/events.ts`). Speed/pause lives in the loop layer, never the sim — commands must apply even while paused.
4. **Workflow per milestone:** implement → launch an independent adversarial review agent → fix ALL findings + add a regression test per finding → build/test/lint green → commit → next milestone. The GDD is descriptive; code is authoritative for balance numbers.
5. Windows/PowerShell 5.1 environment: use the Write/Edit tools for file content (a PowerShell `Get-Content`/`Set-Content` round-trip once mangled UTF-8 `§` characters).
