# Persistence & Multiplayer Plan

Scoping document (2026-07-17, owner-requested). Companion to `TECH_PLAN.md`.
**Phase 1 is SHIPPED** (same day — `src/sim/save.ts`, `src/ui/saveStore.ts`,
`src/ui/saveLoad.ts`; round-trip determinism test green; currently
`SAVE_VERSION` 2 after Expansion 1 added enum values, with v1 loadable via a
candidate-pool top-up migration). Phases 2–3 remain scoped-only. The V1 stance
stands: **no backend, no accounts, no database** — everything below layers onto
that without contradicting it until the explicitly-marked later phases.

## Phase 1 — Save/load, portable PC-to-PC (SHIPPED — spec below is as-built)

**Format: one versioned JSON snapshot of the full `World`.**

```jsonc
{
  "saveVersion": 1,          // bump on ANY schema change; loader refuses newer
  "seed": 617433884,         // display/bookkeeping only — state is authoritative
  "rngState": 2894613067,    // SeededRng internal state — MUST round-trip
  "tick": 48123,
  "cash": 23450, "reputation": 412,
  "today": { /* DayTally */ }, "lifetime": { "treated": 210, "died": 4 },
  "bankruptSinceTick": null, "gameOver": false,
  "grid": "RLE string",      // walkable/roomId/object per tile, run-length encoded
  "rooms": [ /* Room.toJSON() */ ],
  "patients": [ /* Patient.toJSON() — includes stage, lost, path, in-flight walk */ ],
  "staff": [], "reservations": [], "checkInQueues": {}, "candidates": [],
  "nextEntityId": 991
}
```

Design rules:

1. **Snapshot, not replay.** Player commands aren't recorded, so a seed alone
   cannot reconstruct a mid-game world. The snapshot is the save. (A
   command-log replay format is a Phase-3 option — see Multiplayer.)
2. **`SeededRng` must expose and restore its internal state** — saving the
   original seed is NOT enough once numbers have been drawn. This is the one
   sim-code prerequisite; add `rng.getState()`/`setState()` first.
3. **Explicit `toJSON`/`fromJSON` per entity** (tech plan M4-stretch note):
   entities are classes holding Maps and in-flight paths. No `JSON.stringify`
   of live objects — every field is written deliberately so `saveVersion` can
   be migrated deliberately.
4. **Round-trip test is the acceptance test:** save → load → run N ticks must
   produce the identical event log as never-saved (extends the existing
   fixed-seed determinism replay test). This test also becomes the multiplayer
   readiness gate (see below).
5. **Storage + PC-to-PC portability, in the same phase:**
   - `localStorage` slots (auto-save at midnight piggybacks on `closeDay`).
   - **Export = download `hospital-simms-save.json`; Import = file picker /
     drag-drop.** That is the whole PC-to-PC story — no server, works offline,
     survives browser wipes. Saves are ~tens of KB; gzip via
     `CompressionStream` if slots get tight.
   - The `?seed=` URL stays as the lightweight "share a fresh run" channel.
6. **Adding a World-level mutable field is a manual checklist** — the compiler
   only guards ENTITY fields (the explicit per-entity serializers must return
   complete objects); nothing forces a new `World` scalar/collection into the
   snapshot. The checklist: add it to `SaveData`, write it in `serializeWorld`,
   validate and restore it in `loadWorld`, and **bump `saveVersion`**.

## Phase 2 — Async multiplayer without a backend (cheap, high fun-per-effort)

- **Seed challenges:** same seed + same scenario ruleset → compare day-N
  reputation/cash. Shareable as a URL (`?seed=N&challenge=day5`). Zero
  netcode; only needs the Phase-1 determinism guarantees.
- **Save-file challenges:** "here's my hospital at day 10 — survive the
  chest-pain wave." A save file IS the scenario format (GDD §11's unlockable
  maps fall out of this for free).

## Phase 3 — Real-time multiplayer (needs the determinism we already have)

The sim was built as a **deterministic fixed-timestep machine fed only by a
command queue** — which is precisely the shape lockstep networking wants:

- **Deterministic lockstep (recommended):** peers exchange *commands* stamped
  with an execution tick; every client runs the identical sim. Bandwidth is
  tiny (commands, not state). Prerequisites, all cheap to keep true now:
  1. All randomness through `world.rng` in fixed system order — already law.
  2. Commands applied at a deterministic tick boundary — today they apply
     "whenever the frame drains"; lockstep needs `applyAt(tick)` scheduling.
  3. Cross-platform float determinism — the known lockstep risk (JS is IEEE-754
     everywhere, but keep `Math.sin/cos/pow` out of sim math; grep is clean today).
  4. Desync detection: periodic world-hash exchange; the Phase-1 snapshot
     doubles as the resync payload.
- **Server-authoritative** (only if drop-in/spectate/persistence-across-
  sessions is wanted): the first phase that needs a real backend + database.
  Decision deferred until Phase 2 proves demand.

## What to protect starting NOW (costs nothing today, everything later)

- Never let `Math.random`/`Date.now` into `src/sim/` (already enforced).
- Keep every mutation a `Command` (already enforced) — lockstep and replays
  both ride on this.
- When adding entity fields, remember each one is a future `toJSON` line —
  prefer plain serializable data over closures/references (the codebase
  already complies; `Reservation.staffIds` being ids, not references, is the
  pattern to copy).
