# Finances & departmental P&L — design + implementation plan (v3, FROZEN)

**Status: IMPLEMENTED 2026-07-18** (SAVE_VERSION 7, 568 tests, all gates
green — see the `*(finances)*` row in `docs/HANDOFF.md`). Built from v3 below
essentially as written. **Shipped deltas, for the record:** (1) §12's
"sell a room → hospital value drops by the sell-back" was MATHEMATICALLY
FALSE and is corrected in place — value is conserved, capital invested is
what drops; (2) the Departments block gained an **Amenities** row, because
excluding roomless props left it short of `Patient fees` by the vending take
with no line to explain the gap (live-drive MINOR); (3) the payroll closer
reads `Payroll (not allocated, lifetime)` and renders as a grid row — the
unlabelled version read as ONE DAY's wages under an "Income today" column;
(4) the finances card scrolls its body with Continue pinned outside it, and
the graph's scale labels anchor to the VERTICAL extremes (both live-drive
MAJORs — the modal had never been on screen when it was written);
(5) the directory gates its earned column on `roomEarns`, matching the
inspect card, rather than printing `$0` on rooms that cannot bill;
(6) an `Amenity` interface was extracted to `data/amenities.ts` (the shape
was inline in five places and drifted the moment `revenueTotal` was added);
(7) the daily report's zero-suppression predicate is `=== 0`, not `<= 0`, so
a future negative category cannot silently hide a real loss.

**Polish pass (same day, owner ask "fix them all"), SAVE_VERSION 8:** the
Departments block gained **`Sold rooms (no longer owned)`** — §5 sums only
rooms currently owned, so income from a SOLD room had no departmental home and
the block was quietly short of `Patient fees`; the derived row closes it.
Amenities gained **`revenueToday`** (SAVE_VERSION 8) — v7 gave machines only a
lifetime figure, so no per-day vending number existed anywhere and both the
directory column and the modal's Amenities row rendered a permanent em-dash.
Payroll moved out of the column grid into a bordered footer; the graph plot is
inset so labels sit beside it; `.finance-body` forces a visible scrollbar.
**§7 Q2 (per-room running costs) remains DEFERRED and is now scoped as its own
milestone in `HANDOFF.md` — it is a balance change, not a display change, and
it is what would turn this ledger into true P&L.**

**Original status: v3 — TWO pre-implementation review rounds folded; READY TO
FREEZE and build.** Owner
ask (2026-07-18): *"Do games like this show the profit and loss somewhere for
each department and totals… Let's mimic RollerCoaster Tycoon."* Companion to
`GAME_DESIGN.md` / `TECH_PLAN.md` (§3.1 SSOT); CLAUDE.md hard rules govern.
All numbers are **initial values** — `balance.ts` is authoritative at
implementation. This doc is BOTH the design and the implementation plan (the
fresh-context handoff builds straight from §9–§12).

**Review of record (v1 → v2), 2026-07-18: 8 MAJOR / 8 MINOR / 6 NIT — all
folded.** The MAJORs, for the record: (1) the Total column and
"average bill per patient" had NO data behind them — no lifetime cash
accumulator exists (`lifetimeTreated`/`lifetimeDied` are counts, and
`Σ room.revenueTotal` silently rises when a room is SOLD); (2) §6 promised
departments would show construction spend, but `today.construction` is one
hospital-wide scalar with no category dimension; (3) "same rendered output"
for the daily report was false — the real Money section zero-suppresses four
rows, negates expenses at the call site, and orders rows differently from the
table; (4) the flagship "completeness test" keyed on "cash-bearing", which is
neither typed nor machine-checkable; (5) a hand-written `SavedDayReport`
reader walks into the version trap (history entries carry no per-entry
version — the tally MUST route through the version-aware `readTally`);
(6) the frozen `closeDay` order contradicted its own rationale, and the
opposite resolution makes the autosave persist phantom earnings; (7)
`history.length ≤ historyCapDays` as a load-time REJECT couples a save's
validity to a tunable — lowering the cap would brick every existing save,
including production autosaves; (8) the track split wasn't disjoint
(`ui.css` shared, and the wiring site is `main.ts`, owned by no track).

**Re-review of record (v2 → v3), 2026-07-18: all 8 MAJORs verified CLOSED
against real code; 2 NEW MAJOR / 7 MINOR / 7 NIT — all folded.** The new
MAJORs: (N1) `PausingOverlay.resumeSpeed` falls back to speed 1 when the
game was ALREADY paused — harmless for the midnight-only overlays, but
Finances is the first overlay a PLAYER opens at will, so pause → open →
Continue would silently resume a deliberately paused game; (N2) the
average-bill denominator uses `lifetimeTreated`, which a v6 import restores
NONZERO while `lifetime` cash starts at 0 — permanently skewing the average
low on every migrated save, i.e. exactly the fabricated number §7 Q7
promised not to ship (fixed with a `lifetimeTreatedBase` watermark). The
re-review also confirmed a bonus property worth stating: because
`expandPrice = priceOf(new) − priceOf(old)`, `Σ priceOf(current rect)` is
EXACTLY the cash spent across a build+expand chain, not merely a
replacement-cost proxy (§5).

## 1. What RollerCoaster Tycoon actually shows (the model we're copying)

RCT surfaces money at **two levels**, and that split is the whole design:

| RCT surface | What it shows | Our analog |
|---|---|---|
| **Finances window** | Income/expenditure by CATEGORY as a grid: one column per month, most recent last | **Finances modal**: categories × last N DAYS + Today + Total (§3) |
| **Finances → graph** | Cash over time | Cash-by-day sparkline, inline SVG (§3.3) |
| **Company value** | Cash + assets − loan | **Hospital value** = cash + sell-back value of every room/amenity (§3.2) |
| **Ride window → Income tab** | THIS ride's income/hour, running cost/hour, profit, customers | **Room inspect card**: this room's income today / lifetime + patients seen (§4) |
| **Shop windows** | Per-shop sales | **Vending machines**: per-unit lifetime revenue (§4.2) |
| Loan / interest / marketing / research | Core RCT money loops | **OUT of scope v1** (§8) |

The load-bearing lesson: **per-unit numbers live on the unit itself** (you
click the ride to learn what it earns), while the finances window answers
"where did the money go". We already have the click-the-unit surface (the
inspect card) and a per-day tally — this epic connects them.

**Honest scope statement (review MINOR 12).** RCT rides show *profit*
because rides have *running costs*. We have none (§7 Q2 defers them as a
balance change), so v1 ships **income** per unit and a **two-sided
departmental ledger** (income earned vs capital invested), with payroll
explicitly labelled as unallocated hospital overhead. §4/§5 wording must not
promise "does it pay for itself" — that claim arrives with §7 Q2.

## 2. Design principles

1. **SSOT (§3.1).** ONE category table (`FINANCE_CATEGORIES`) drives the
   finances grid, the daily report's Money section, `dayNet`, AND the
   lifetime totals — a new money field cannot be tallied yet invisible, nor
   counted twice. Derivations (`hospitalValue`, `departmentCapital`,
   `roomEarns`) are pure functions in `formulas.ts` called by sim AND UI.
2. **DRY.** One `money()` formatter, one `modalSection`/`modalRow` builder,
   one `readTally` (history delegates to it), and ONE increment path
   (`World.addCash`) that feeds today AND lifetime — no parallel bookkeeping.
3. **Attribution at existing choke points**, never a new scan: `billFee`
   already sees the reservation, so it names the room in the same call that
   moves the cash (the M4 tally invariant).
4. **No fake precision.** Costs attach to a department only where real.
   Payroll is hospital-wide by construction (§6) and is rendered as such.
5. **Determinism untouched.** Zero rng, zero new sim feedback. Money is
   already sim state, so the new counters are SAVED state (plan rule 6 →
   SAVE_VERSION 7), not derived. **No new RoleId ⇒ no constructor-candidate
   shift ⇒ NO fixed-seed re-pin** (verified: nothing here draws `world.rng`;
   harness seed 1338 must stay green — asserted in §11.9, not assumed).
6. **Nothing per-frame.** The modal renders on open (the world is paused
   behind it); the inspect card rides the existing frame-poll; the directory
   column joins its existing renderKey (§9.8 covers the churn ruling).

## 3. Surface A — the Finances modal (the RCT finances window)

Opened from a HUD button beside Save/Load (`💷 Finances`), a
`PausingOverlay` modal like the daily report: **it pauses the game and
restores the speed on close** — the `.modal-overlay` owns the clock (M4
invariant). It also subscribes `gameOver → hide()` (review MINOR 11 —
foreclosure trumps bookkeeping, exactly as `DailyReportModal` does; without
it, `closeAndResume()` would un-pause a dead game).

**It must restore speed 0 (re-review MAJOR N1).** `PausingOverlay` currently
resolves `resumeSpeed = loop.speed === 0 ? RESUME_FALLBACK : loop.speed` —
correct for the daily report and challenge card, which only ever open at
midnight, but WRONG for the first overlay a player opens at will: pause with
Space, open Finances, press Continue, and the game silently resumes at 1×.
Fix in the base class, additively: `protected allowResumeToPaused = false`,
which `FinanceModal` sets `true` to capture `loop.speed` verbatim (0
included). Default `false` preserves every existing overlay's behavior
byte-for-byte. Pinned by a DOM test (paused → open → close → speed still 0).

**Single-overlay argument, stated (review MINOR 11):** midnight cannot fire
while Finances is open, because `PausingOverlay.show()` sets speed 0 and the
sim stops ticking; the reverse (opening Finances over a visible daily report)
is blocked today only because `.modal-overlay` covers the HUD full-bleed. That
is incidental, so the open handler ALSO guards on
`document.querySelector('.modal-overlay:not(.hidden)')` and no-ops — pinned by
a DOM test, so a future z-index/pointer-events change cannot silently produce
two overlays each capturing `resumeSpeed`.

### 3.1 The grid (the RCT table)

Rows = `FINANCE_CATEGORIES` in table order (ALL non-breakdown rows always
render — a grid needs a stable row set across columns; `showWhenZero` governs
the daily report only). Columns = the last `historyShownDays` (7) closed days,
oldest → newest, then **Today** (the live tally) and **Total** (lifetime).

```
                 Day 3   Day 4   Day 5   Today    Total
 Patient fees    $2,400  $3,150  $2,900  $1,050  $12,300
   · Vending        $45     $60     $30     $15     $220
 Sell-back income     —      —   $2,000      —    $2,000
 Payroll        −$1,880 −$1,880 −$2,020   −$700  −$9,140
 Hiring           −$100      —    −$100      —    −$300
 Construction   −$8,000      —   −$9,000      —  −$31,000
 ─────────────────────────────────────────────────────
 Net            −$7,535  $1,330 −$6,220    $350 −$25,920
```

- Vending renders **indented under Patient fees** — a BREAKDOWN of `revenue`,
  never a net line (`kind: 'breakdown'` is display-only and is never summed;
  `dayNet` reads `revenue`, which already contains it).
- `kind: 'expense'` drives BOTH the display negation and the subtraction in
  net — one flag, no separate sign field (review MAJOR 3).
- Empty/zero cells render `—`. Days before the save existed are not columns.
- The Net row is the SAME `dayNet` every other surface uses.
- **Total is lifetime, and it is REAL** (review MAJOR 1): it reads
  `world.lifetime`, not a sum over the 30-day history and not a sum over live
  rooms (a sold room takes its counter with it).

### 3.2 Summary block (above the grid)

- **Cash on hand** — live.
- **Hospital value** = `cash + Σ sellbackAmount(room.type, room.rect) +
  Σ amenitySellback(kind)` — the RCT "company value" analog.
- **Today's net** (the live tally through `dayNet`).
- **Average bill per patient** = `(lifetime.revenue −
  lifetime.vendingRevenue) ÷ (world.lifetimeTreated − lifetimeTreatedBase)`
  — treatment fees only, over discharges COUNTED IN THE SAME WINDOW.
  **`lifetimeTreatedBase` (re-review MAJOR N2)** is a watermark: 0 on a new
  game, set to the restored `lifetimeTreated` on a v6→v7 migration. Without
  it a migrated save divides fresh revenue by pre-upgrade discharges and
  reads permanently, invisibly low — a fabricated number, which §7 Q7
  forbids. `—` when the denominator is 0 (before the first discharge, and
  for the first post-import discharge-free stretch).

### 3.3 The cash graph

An inline **SVG polyline** of end-of-day cash across the **stored 30-day
history** (not the 7 shown columns). Deliberately not Pixi and not a charting
library: a DOM element inside the modal, drawn once on open. Concrete spec
(re-review MINOR M7 — the v2 text was not buildable):

- Fixed `viewBox="0 0 300 120"`, `preserveAspectRatio="none"`, CSS-sized to
  the card width; no intrinsic px size.
- `min`/`max` over the entry cash values; **`span = (max − min) || 1`** — the
  degenerate flat-cash run must not divide by zero.
- `x = i / (n − 1) × 300` (n ≥ 2 guaranteed by the omit rule),
  `y = 120 − ((value − min) / span) × 120`.
- The zero line renders **only when `min <= 0 <= max`** (otherwise it is
  off-scale and misleading); min/max value labels use `money()`.
- Fewer than 2 closed days → the graph is omitted entirely.

## 4. Surface B — per-unit income (the RCT ride window)

### 4.1 Rooms

The room inspect card gains an **Income** block, rendered only for rooms that
can bill (`roomEarns(type)` — §9.2, derived from `CONDITION_DEFS`):

```
 Income today     $450
 Income total   $3,900
 Patients seen     17
```

Frame-polled like every other line on that card. "Patients seen" (NOT
"Treated" — review MINOR 10: `DayTally.treated`/`lifetimeTreated` mean
DISCHARGES, and a 2-step patient would read as 2) counts completed treatment
STEPS in this room; the sim field is named `visitsTotal` for the same reason.

The card's contract is **"learn what this room brings in"** — per-unit
PROFIT arrives with running costs (§7 Q2).

### 4.2 Vending machines (our shops)

The amenity card gains `Income total $220` for vending machines — per-machine
lifetime revenue, so a badly-placed machine is visibly dead (how RCT exposes
a shop nobody walks past). Trashcans/plants earn nothing and render no line.
A machine SOLD mid-use never double-counts: `sellAmenity` clears live claims
through `clearNeedBreak` before deleting the entry, so the completion path
never fires for it (verified; pinned by a test — §11.4).

## 5. Surface C — departments (the owner's "each department")

**A department IS a `RoomCategory`** (Basics · Imaging · Treatment · Comfort)
— already the SSOT the build menu and the directory group by.

1. **Finances modal, Departments section** — per category: rooms built,
   **income today**, **income total**, **capital invested**
   (`departmentCapital` = `Σ priceOf(room.type, room.rect)` over live rooms;
   pure, zero new state), and patients seen. Closed by a single
   hospital-level row: **`Payroll (not allocated) −$9,140`** — the honest
   two-sided ledger (review MAJOR 2 + MINOR 12).
   Two properties worth stating so nobody "fixes" them: (a) because
   `expandPrice = priceOf(new) − priceOf(old)`, `Σ priceOf(CURRENT rect)` is
   EXACTLY the cash spent across a build→expand chain — not a proxy
   (re-review); (b) it therefore also bills the new-game starting rooms,
   which were built `free` — deliberate, it is a replacement-cost read of
   what the department is worth, not a receipt (re-review NIT N4; note it in
   the UI copy as "Capital invested", never "Spent").
2. **Directory rows**: each room row gains a dim earned-today value, and each
   category header gains the department subtotal — the inventory list doubles
   as the P&L browser.

## 6. The payroll ruling (THE design decision — §7 Q1)

`updateEconomy` charges ONE hourly slice of every salary hospital-wide, and
staff are dispatched wherever the queue points (a nurse serves triage, then
dialysis, then the ER). **There is no department ownership of staff**, so a
"department profit" number requires an ALLOCATION POLICY, not a query.

- **v1 RECOMMENDED — payroll stays hospital overhead**, rendered as an
  explicit `Payroll (not allocated)` line inside the Departments block so the
  ledger reads as two-sided rather than silently omitting the biggest cost.
  Matches RCT (staff wages are a park-wide category, never charged to a ride).
- Alternative (Phase 2): time-weighted attribution — while a staff member is
  bound to a reservation, their hourly wage accrues to that room. Real
  numbers; needs a per-tick hook in `updateEconomy`, a rule for idle/walking
  time, and its own save fields.

## 7. Owner decisions to ratify (recommendations bolded)

1. **Payroll attribution** — **hospital overhead in v1, shown as an explicit
   unallocated line** (§6). Alternative: time-weighted (Phase 2).
2. **Per-room running costs** (the RCT "running cost/hour" that makes per-ride
   PROFIT meaningful) — **not in v1**: a balance change (every room becomes a
   drain; the M4-tuned economy shifts; the harness envelope needs re-tuning).
   Deferred as its own balance pass; when it lands, §4.1 gains a Profit line
   and departments become true P&L.
3. **Loans & interest** (half of RCT's finance window) — **OUT**: bankruptcy
   at −$10k with a grace day is the loss condition; loans rewrite it.
4. **History window** — **show 7 days, store 30** (`historyShownDays` /
   `historyCapDays`). ~30 day-reports is a few KB of save.
5. **Finances = a pausing modal** (consistent with save/load + daily report
   and the `.modal-overlay` invariant) rather than a 4th bottom-bar dropdown.
6. **Vending per-machine revenue** — **yes** (§4.2).
7. **Pre-v7 saves start their Total at 0** (§9.7 migration) — lifetime
   counters cannot be reconstructed from a v6 save. The Total column is
   therefore "since this save was upgraded" for imported saves. **Accepted**
   (the alternative is a fabricated number); the modal states it once when
   `lifetimeTreatedBase > 0`. That same watermark keeps the average-bill row
   honest for the save's whole life (§3.2, re-review MAJOR N2) — the v2 plan
   showed the notice only while `lifetime` was all-zero, which stopped being
   true after one day while the skew lasted forever.

## 8. Out of scope (this epic)

Loans/interest/marketing/research (§7 Q3); per-room running costs (§7 Q2 —
deferred, not rejected); staff-level cost accounting; per-treatment price
setting (Theme Hospital's Casebook — changes balance and demand); CSV export;
multi-month aggregation.

---

# Implementation plan

## 9. Frozen contract (orchestrator writes ALL of this BEFORE tracks start)

### 9.1 `src/sim/data/finance.ts` (new — the category SSOT)

```ts
import type { DayTally } from '../dailyStats';

export type CashTallyKey =
  | 'revenue' | 'vendingRevenue' | 'sellIncome'
  | 'payroll' | 'hireFees' | 'construction';

/** Frozen shape (review MINOR 15): `kind` drives display negation, the net
 *  fold, AND the row tone (`expense` → 'bad', otherwise 'good' — which
 *  reproduces the shipped daily report exactly, re-review MINOR M4);
 *  `showWhenZero` governs the DAILY REPORT only (the grid always renders
 *  every non-breakdown row); `reportOrder` preserves the daily report's
 *  shipped row order independently of ARRAY order, which is the GRID order
 *  (re-review MINOR M3 — v2 declared them in report order while the §3.1
 *  mock drew grid order, contradicting itself). `field` IS the id: category
 *  keys and DayTally keys are deliberately the same strings, so `tallyCash`
 *  needs no mapping. */
export type FinanceCategory = {
  readonly field: CashTallyKey;
  readonly label: string;
  readonly showWhenZero: boolean;
  readonly reportOrder: number;
} & (
  | { readonly kind: 'income' | 'expense' }
  | { readonly kind: 'breakdown'; readonly under: CashTallyKey }
);

/** ARRAY order = the §3.1 GRID order. `reportOrder` = the daily report's. */
export const FINANCE_CATEGORIES = [
  { field: 'revenue',        label: 'Patient fees',      kind: 'income',    showWhenZero: true,  reportOrder: 0 },
  { field: 'vendingRevenue', label: 'Vending',           kind: 'breakdown', under: 'revenue',
                                                                            showWhenZero: false, reportOrder: 1 },
  { field: 'sellIncome',     label: 'Sell-back income',  kind: 'income',    showWhenZero: false, reportOrder: 5 },
  { field: 'payroll',        label: 'Payroll',           kind: 'expense',   showWhenZero: true,  reportOrder: 2 },
  { field: 'hireFees',       label: 'Hiring',            kind: 'expense',   showWhenZero: false, reportOrder: 3 },
  { field: 'construction',   label: 'Construction',      kind: 'expense',   showWhenZero: false, reportOrder: 4 },
] as const satisfies readonly FinanceCategory[];

/** The partition guard (review MAJOR 4): DayTally keys that are NOT cash.
 *  Adding a tally key forces a choice here or above — the union must equal
 *  Object.keys(emptyDayTally()), test-enforced with no duplicates. */
export const NON_CASH_TALLY_KEYS = [
  'arrivals', 'treated', 'died', 'leftAma', 'lostEpisodes',
  'messTicks', 'repDelta', 'waitSumTicks', 'waitCount',
] as const satisfies readonly (keyof DayTally)[];

/** Lifetime cash totals — the same keys, one running sum each (§3.1 Total). */
export type CashTotals = Record<CashTallyKey, number>;
export function emptyCashTotals(): CashTotals { /* all zeros */ }
```

**Label note:** `'Sell-back income'` matches the shipped daily-report label
exactly (review MAJOR 3) — the grid and the report share it.

### 9.2 `src/sim/formulas.ts` — new pure derivations (exact signatures)

```ts
/** Rooms that can bill: DERIVED from CONDITION_DEFS, not a hand-kept flag
 *  (review MINOR 9 — SSOT rule 1; a table + "test both ways" only polices a
 *  duplicate). Memoized into a module-level Set (the inspect card polls it
 *  per frame). Today's set: exam, xray, resp, er, ultrasound, ct, mri,
 *  nucMed, dialysis, surgery — pinned by ONE test. */
export function roomEarns(type: RoomType): boolean;

/** RCT "company value": cash + every room's + amenity's sell-back. Note the
 *  exact upstream signature — sellbackAmount(roomType, rect), NOT (room).
 *  MODAL-OPEN ONLY: iterates all rooms + amenities; never per-frame
 *  (re-review NIT N6). */
export function hospitalValue(world: World): number;

/** §5: what this category's footprints cost to build TODAY (rect-aware, the
 *  sellbackAmount convention — no amount-paid bookkeeping). Also counts
 *  `free`-built starting rooms — a replacement-cost read, by design. */
export function departmentCapital(world: World, category: RoomCategory): number;

/** §3.1 Net + §3.2 average — the table fold is THE net derivation. ONE
 *  param type: a DayTally satisfies CashTotals structurally (re-review NIT
 *  N5 — the v2 union was redundant). */
export function netFromCategories(totals: CashTotals): number;
/** Denominator is the WATERMARKED count (§3.2, re-review MAJOR N2); null
 *  when it is 0. */
export function averageBillPerPatient(
  lifetime: CashTotals,
  lifetimeTreated: number,
  lifetimeTreatedBase: number,
): number | null;
```
`dayNet` (dailyStats.ts) **delegates to `netFromCategories`** and a test pins
byte-equality with the legacy formula (`revenue + sellIncome − payroll −
hireFees − construction`) on a sample tally.

### 9.3 `src/sim/data/balance.ts`

```ts
finance: { historyShownDays: 7, historyCapDays: 30 },
```

### 9.4 `src/sim/entities/room.ts` + the amenity store

`Room` gains `revenueToday: number; revenueTotal: number; visitsTotal: number`.
The amenity value gains `revenueTotal: number`. Every `Room` literal
(buildRoom, tests) must initialize them — compile-enforced by the interface.

### 9.5 `src/sim/world.ts`

```ts
/** Closed-day reports, oldest → newest, trimmed to historyCapDays. */
readonly history: DayReport[] = [];
/** Lifetime cash totals (§3.1 Total, §3.2 average) — review MAJOR 1. */
readonly lifetime: CashTotals = emptyCashTotals();
/** Discharges that happened BEFORE this save gained lifetime tracking — 0
 *  on a new game, set to the restored lifetimeTreated on a v6→v7 migration
 *  (§3.2, re-review MAJOR N2). Not readonly: the migration assigns it. */
lifetimeTreatedBase = 0;

/** THE cash-tally increment (DRY, principle 2): today AND lifetime, one
 *  call. Every existing `this.today.<cashKey> += n` migrates to this.
 *  NAME (re-review NIT N3): `tallyCash`, NOT `addCash` — it does NOT move
 *  `world.cash`; every call site still adjusts cash itself, and a name
 *  implying otherwise invites a contributor to delete the adjacent line. */
tallyCash(key: CashTallyKey, amount: number): void;

/** billFee gains an OPTIONS object (review NIT 17 — a positional optional
 *  that must be supplied on the treatment path isn't structural). */
billFee(amount: number, label: string,
        opts?: { source?: 'treatment' | 'vending'; roomId?: number }): void;
```
**The 9 migration sites (verified by re-review — every one is a plain
`this.today.X += n` and none sits inside save-restore):** `world.ts`
construction ×2 (build, expand), sellIncome (sellRoom), hireFees,
amenity construction, amenity sellIncome, revenue (inside `billFee`);
`systems/economy.ts` payroll (the fractional hourly accrual migrates fine —
`tallyCash` is key-agnostic; the known float-dust NIT simply reaches
`lifetime.payroll`, which `money()` rounds); `systems/patientNeeds.ts`
vendingRevenue.
- `billFee` attributes when `roomId` is given: `room.revenueToday += amount`,
  `room.revenueTotal += amount`, `room.visitsTotal += 1`. Call sites: the ONE
  treatment site in `resolveTreatmentOutcome` (`reservation.roomId` is in
  scope and correct — verified; `dischargePatient` does NOT re-bill, it only
  forwards `patient.billed` into its event), and `updatePatientNeeds` for
  vending (no roomId; increments the machine's `amenity.revenueTotal` at the
  same choke point where `vendingRevenue` is tallied today).
- **`closeDay` order is LOAD-BEARING and extended (FROZEN):** wait bonus →
  cleanliness rep → build the `DayReport` snapshot → **push `{...report}` to
  `history`** (a COPY — review MINOR 13: the emitted payload must not alias
  stored history) **and trim to `historyCapDays`** → **reset every
  `room.revenueToday`** → reset `today` → emit `dayEnded`.
  **Rationale (review MAJOR 6 — the v1 text had this backwards):** the resets
  precede the emit so the `dayEnded` autosave persists a CONSISTENT new-day
  state (`today` zeroed ⇔ every `revenueToday` zeroed); a reload must never
  show phantom earnings. Pushing history before the emit is likewise
  deliberate — the autosave captures the entry. **No `dayEnded` consumer may
  read `room.revenueToday`** — pinned by a test.

### 9.6 `src/sim/dailyStats.ts`

`dayNet` delegates to `netFromCategories`. No new `DayTally` keys.

### 9.7 `src/sim/save.ts` — **SAVE_VERSION 7**

- `SavedRoom` += `revenueToday`, `revenueTotal`, `visitsTotal` (FROZEN
  position: after `brokenSince`). `SavedAmenity` += `revenueTotal` (after
  `fill`). `SaveData` += `lifetime: CashTotals`, `lifetimeTreatedBase:
  number`, then `history: SavedDayReport[]` (FROZEN positions: immediately
  after `jobs`). **Insertion order IS the byte-identity contract — the
  matching literals in `serializeWorld`, `writeRoom`, `writeAmenity` AND
  `writeDayReport` must place the new keys identically** (review NIT 22 +
  re-review NIT N7 — the rule covers all four writers, not just the root).
- **`writeDayReport` mirrors the reader (re-review MINOR M2):**
  `{ ...writeTally(r), day, cash, reputation, avgWaitGameMinutes,
  waitBonusAwarded }` — delegating to `writeTally` so a future tally key is
  carried automatically in `TALLY_KEYS` order.
- `readRoom` already takes `saveVersion` (v6) — extend it. `readAmenity` does
  NOT; thread it the same way (a two-line change, sole call site in
  `readRestorePayload`). Pre-v7 → all counters 0, `lifetime` zeros, `history`
  `[]`.
- **`readDayReport` delegates its tally to the version-aware `readTally`**
  (review MAJOR 5 — history entries carry no per-entry version, so a
  hand-written key-by-key reader would break every v7 save the moment v8 adds
  a tally key):
  ```ts
  function readDayReport(v: unknown, label: string, saveVersion: number): DayReport {
    const o = asRecord(v, label);
    return { ...readTally(o, label, saveVersion),
      day: asInt(o.day, `${label}.day`), cash: asNumber(...), reputation: asNumber(...),
      avgWaitGameMinutes: asNumberOrNull(...), waitBonusAwarded: asBool(...) };
  }
  ```
- Border: all four counters finite + non-negative; `lifetime` keys finite +
  non-negative; `lifetimeTreatedBase` finite, non-negative, ≤
  `lifetimeTreated`; history `day` values strictly increasing and ≤ the
  current day. **History length: TRIM ON LOAD, NEVER REJECT** (review MAJOR
  7 — a load-time reject against a BALANCE tunable would brick every
  existing save the day the cap is lowered, production autosaves included);
  keep a hard structural bound (1000) for malformed input only.
  **Trim site + direction (re-review MINOR M1):** in `readRestorePayload`,
  on the validated array, keeping the **newest** `historyCapDays` entries —
  the same end the runtime trim keeps. Consequence to respect: an over-cap
  save is NOT byte-identical on re-save (only reachable after a cap
  reduction; acceptable), so **the byte-identity fixture must never be
  over-cap**.
- **The World-level save checklist has FOUR steps, and the v2 plan named
  only two (re-review MINOR M6):** `SaveData` + `serializeWorld` (above),
  AND `RestorePayload` += `lifetime`/`lifetimeTreatedBase`/`history` with
  `readRestorePayload` reading them, AND `restoreInto` applying them.
  `history`/`lifetime` are declared `readonly`, so `restoreInto` CANNOT use
  the existing `world.today = data.today` idiom — use
  `Object.assign(world.lifetime, data.lifetime)` and
  `world.history.push(...data.history)`; `lifetimeTreatedBase` is a plain
  assignment. On a v<7 load, set `lifetimeTreatedBase = world.lifetimeTreated`
  AFTER the counters are restored (the §3.2 watermark).
- Round-trip pins: a room with `revenueToday > 0` AND `revenueTotal >
  revenueToday`, a vending machine with `revenueTotal > 0`, `history.length
  ≥ 2` (and UNDER cap), and a nonzero `lifetime` at the save tick.
- v6 fixture-LOAD test (the v5 precedent): counters 0, lifetime zeros,
  history empty, **`lifetimeTreatedBase === the fixture's lifetimeTreated`**
  (the N2 watermark, asserted). **No new role ⇒ no candidate top-up ⇒ no
  fixed-seed re-pin** — the first save bump with an untouched harness seed;
  assert 1338 stays green.

### 9.8 UI contract

- **`src/ui/pausingOverlay.ts`**: gains `protected allowResumeToPaused =
  false` (§3, re-review MAJOR N1). ADDITIVE — the default preserves every
  existing overlay byte-for-byte; only `FinanceModal` sets it true.
- **`src/ui/finance.ts` (new)**: `FinanceModal extends PausingOverlay`
  (`allowResumeToPaused = true`), HUD button via the
  `SaveLoadModal.mountButton` precedent, `gameOver → hide()`, the open-guard
  of §3. Renders §3.1–3.3 + §5.1 with `modalSection`/`modalRow`/`money()` —
  no new formatters.
- **`src/ui/dailyReport.ts`**: its Money section folds the §9.1 table
  (`reportOrder`, `showWhenZero`, `kind`-driven negation AND tone) and must
  render **byte-identically to today** — the existing DOM test is the gate,
  not a re-pin. **`Net` and `Cash on hand` stay HAND-RENDERED after the fold**
  (re-review MINOR M5): they are not categories — `Net` derives from
  `netFromCategories` with a sign-driven tone, `Cash on hand` is toneless and
  has no grid-row analog (the §3.2 summary block carries it).
- **`src/ui/inspect.ts`**: the §4 Income block (rooms passing `roomEarns`;
  vending machines).
- **`src/ui/directory.ts`**: earned-today value + category subtotals. The new
  values JOIN the existing `renderKey` — **keyed on the RENDERED `money()`
  string, not the raw float** (review MINOR 16: a raw key would rebuild the
  whole list on every billed fee and on payroll's fractional dust, churning
  DOM and hover state while the panel is open).

## 10. Track split (disjoint file ownership — the proven parallel workflow)

Freeze first (orchestrator): §9.1–§9.4 fully, §9.5–§9.7 as typed stubs, so
every track compiles from minute one. **`src/ui/ui.css` is split by marker
blocks** — `/* --- finance modal (U1) --- */` and `/* --- per-unit (U2) --- */`
— each track appending ONLY inside its own block (review MAJOR 8).

- **Track S (sim + save + tests)** — `world.ts`, `formulas.ts`,
  `dailyStats.ts`, `save.ts`, `systems/{treatment,patientNeeds}.ts`,
  `data/*`, `test/finance.test.ts`, `test/save.test.ts`, `test/harness.test.ts`.
- **Track U1 (the finances modal)** — `ui/finance.ts`,
  `ui/pausingOverlay.ts` (the additive `allowResumeToPaused` flag — U2's
  `dailyReport.ts` only EXTENDS the base and needs no edit there, so
  ownership stays single), **`src/main.ts` (wiring ONLY — construct +
  `mount` + `mountButton`, ≤5 lines, written verbatim in the freeze so no
  other track needs the file)**, its `ui.css` block,
  `test/finance.dom.test.ts`.
- **Track U2 (the per-unit surfaces)** — `ui/inspect.ts`, `ui/directory.ts`,
  `ui/dailyReport.ts`, its `ui.css` block, their DOM tests.
- **No render track** — the graph is inline SVG; Pixi is untouched.

Each track verifies `tsc --noEmit` + scoped lint before reporting. Then TWO
parallel adversarial reviewers (code/contract vs live-drive via
`/run-hospital-simms`); fix ALL findings + a regression test per MAJOR; gates
green. **The ORCHESTRATOR writes the HANDOFF entry and makes the commit**
(review NIT 21 — every prior epic worked this way).

## 11. Test list (~35 new)

1. **Partition guard**: `[...NON_CASH_TALLY_KEYS, ...FINANCE_CATEGORIES.map(
   c => c.field)]` sorted deep-equals `Object.keys(emptyDayTally())` sorted,
   with no duplicates (review MAJOR 4 — mechanical, and a new tally key fails
   it loudly).
2. `dayNet` parity with the legacy formula; a breakdown row is never summed
   (a vending-only day nets `revenue` exactly once).
3. Attribution: a successful step credits ITS room (`revenueToday`,
   `revenueTotal`, `visitsTotal` +1); a complication credits nothing; a
   multi-step condition credits each room separately; `addCash` moves today
   AND lifetime together.
4. Vending credits the MACHINE, never a room; **selling a machine mid-use
   yields no revenue and no crash** (review NIT 18).
5. `closeDay` FROZEN order: the snapshot carries the day's numbers; `history`
   gains exactly one entry; it is a COPY (mutating the emitted payload leaves
   history intact); `revenueToday` resets while `revenueTotal` survives;
   `today` resets; **no `dayEnded` consumer sees a nonzero `revenueToday`**.
6. History trim at `historyCapDays + 5` closed days (newest kept, oldest
   dropped) — and **a save with over-cap history LOADS and is trimmed to the
   NEWEST cap entries**, never rejected (review MAJOR 7 + re-review M1).
7. `hospitalValue` = cash + sellbacks (built, expanded, amenity); drops
   correctly on sell. `departmentCapital` sums `priceOf` per category.
8. `averageBillPerPatient` excludes vending, uses the WATERMARKED
   denominator, and is `null` before the first discharge — **plus the N2
   regression: a v6→v7 migrated world with a nonzero restored
   `lifetimeTreated` reports the average over post-upgrade discharges only,
   never a skewed one** (re-review MAJOR N2).
9. Save v7: round-trip byte identity; the §9.7 pins; border suites (negative
   counter, non-monotonic history days, structural over-bound); v6/v5 fixture
   LOAD; **harness seed 1338 green with no re-pin** (asserted).
10. `roomEarns` set pinned (§9.2) and derived — adding a condition step room
    changes it with no table edit.
11. DOM: grid renders every non-breakdown row across Day/Today/Total columns;
    the breakdown row indents and never lands in Net; graph omitted at <2
    days **and survives the degenerate flat-cash run (min === max) without
    dividing by zero**; Departments section totals match the room sum and show
    `Payroll (not allocated)`; inspect Income block only for earning rooms;
    directory earned column + subtotals; **the daily report's Money section is
    unchanged** (the shipped DOM test passes untouched); opening Finances over
    a visible modal is a no-op; `gameOver` hides Finances.
12. **Pause honesty (re-review MAJOR N1):** with the game manually PAUSED,
    opening Finances and pressing Continue leaves `loop.speed === 0`; the
    daily report's fallback behavior is unchanged (open at speed 0 → resume
    at the fallback), pinned so the additive flag can't regress it.

## 12. Live-drive checklist (reviewer 2)

Build a hospital, treat patients across imaging + treatment, use a vending
machine; open Finances: cash / hospital value / average bill sane, Today's
column matches the daily report at midnight, the Net row equals the report's
Net; close, run a day, reopen (columns shift, the graph appears at day 2);
click an X-Ray → Income today/total/Patients seen, cross-checked against the
department total (NOTE: the Departments block sums LIVE ROOMS only, so it is
short of `Patient fees` by any vending take and by revenue earned in rooms
since sold — both numbers are right; the Amenities row carries the vending
side); a never-used room reads $0 (the RCT "this ride earns nothing" read);
sell a room → **hospital value is CONSERVED, not reduced** (both reviews
confirmed the v2 wording was mathematically false: `hospitalValue` = cash +
Σ sellbacks, and `sellRoom` pays exactly `sellbackAmount` into cash, so the
two deltas cancel — there is not even a rounding residue, since `Math.floor`
is applied once inside the shared derivation). What DOES move: the
department's capital invested drops by `priceOf`, and `Sell-back income`
appears. Value visibly falls on a BUILD instead — you pay `priceOf` and gain
only `sellbackAmount`, so the spread is the real loss; departments show
`Payroll (not allocated, lifetime)`;
a v6 production save imports and plays (counters 0, history builds from the
next midnight, the §7 Q7 notice shows, and the average-bill row stays blank
until a POST-import discharge); the modal pauses on open and restores speed
on Continue — **including staying paused when the game was already paused**;
midnight cannot stack overlays; console clean throughout.
