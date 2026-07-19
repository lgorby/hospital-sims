import type { EventBus } from '../events';
import type { GameLoop } from '../loop';
import { BALANCE } from '../sim/data/balance';
import { FINANCE_CATEGORIES, type CashTotals } from '../sim/data/finance';
import { ROOM_DEFS, type RoomCategory } from '../sim/data/rooms';
import {
  amenitySellback,
  averageBillPerPatient,
  departmentCapital,
  hospitalValue,
  netFromCategories,
} from '../sim/formulas';
import type { World } from '../sim/world';
import { CATEGORY_LABELS } from './buildMenu';
import { money } from './format';
import { modalRow, modalSection } from './modal';
import { PausingOverlay } from './pausingOverlay';

/** The one "nothing here" glyph in this modal (FINANCE_PLAN §3.1). */
const EM_DASH = '—';

/**
 * Graph geometry (§3.3): a fixed viewBox with `preserveAspectRatio="none"`,
 * CSS-sized to the card — so these are SVG user units, not pixels, and the
 * numbers never reach the player as balance.
 */
const GRAPH_WIDTH = 300;
const GRAPH_HEIGHT = 120;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Below this many CLOSED days a polyline is a dot, so the graph is omitted. */
const MIN_GRAPH_DAYS = 2;

/** Department column headers — declared once so the header row and the data
 *  rows cannot drift in width. "Capital invested", NEVER "Spent": it is a
 *  replacement-cost read that also bills the free starting rooms (§5.1). */
const DEPARTMENT_HEADERS = [
  'Rooms',
  'Income today',
  'Income total',
  'Capital invested',
  'Patients seen',
] as const;

/** Category display order = the build menu's (the directory's §9 invariant). */
const CATEGORIES = Object.keys(CATEGORY_LABELS) as RoomCategory[];

/** One rendered grid cell: text plus the optional tone class `modal-row` styles. */
type Cell = { text: string; tone?: string };

/** A grid column — a closed day, Today, or Total. `DayTally`/`DayReport`
 *  satisfy `CashTotals` structurally, so one shape serves all three (§9.2). */
type Column = { label: string; totals: CashTotals };

/**
 * The finances window (FINANCE_PLAN §3, the RCT finances-window analog): a
 * pausing modal opened from a HUD button beside Save/Load, showing the
 * category grid × last N days + Today + Total, the summary block, the cash
 * graph, and the departmental ledger.
 *
 * It sets `allowResumeToPaused` because it is the FIRST overlay a player opens
 * at will: pause with Space, open Finances, press Continue, and the base
 * class's speed-1 fallback would silently resume a deliberately paused game
 * (plan re-review MAJOR N1).
 */
export class FinanceModal extends PausingOverlay {
  constructor(
    loop: GameLoop,
    private readonly world: World,
    private readonly events: EventBus,
  ) {
    super(loop);
    this.allowResumeToPaused = true;
  }

  /** The scrolling region between the title and Continue — see `render`. */
  private body!: HTMLElement;

  mount(parent: HTMLElement): void {
    this.buildShell(parent, 'finance');
    // The shared 340px card cannot hold a 9-column grid; widen THIS card only,
    // so every other modal keeps its shipped geometry.
    this.card.classList.add('finance-card');
    // Foreclosure trumps bookkeeping — the same contract DailyReportModal has.
    this.events.on('gameOver', () => this.hide());
    // A day boundary trumps bookkeeping too, and this is the STRUCTURAL half
    // of the single-overlay rule (verification MINOR). `open()`'s guard only
    // covers finances-over-something; nothing stopped something-over-finances,
    // because the daily report has no reciprocal guard. That was survivable
    // only because a paused sim can't reach midnight — i.e. it depended on no
    // command reaching the queue, not on an interlock. A forced fast-forward
    // stacked both overlays, and dismissing this one left the report up with
    // the clock RUNNING behind a modal that claims to pause. Yielding here
    // costs nothing: the report captures the clock and owns it from now on.
    this.events.on('dayEnded', () => this.hide());
  }

  /** HUD entry point (the `SaveLoadModal.mountButton` precedent). */
  mountButton(parent: HTMLElement): void {
    const button = document.createElement('button');
    button.textContent = '💷 Finances';
    button.className = 'hud-button';
    button.setAttribute('data-ui', '');
    button.addEventListener('click', () => {
      this.open();
      button.blur();
    });
    parent.appendChild(button);
  }

  open(): void {
    // Only one overlay may own the clock (§3). This is HALF the rule — it
    // stops finances opening over a live overlay; the `dayEnded` subscription
    // in `mount` is the other half. Do not re-justify this guard with "midnight
    // cannot fire while we're open": pausing makes that true only for as long
    // as nothing forces a tick through the queue, which is not an interlock.
    if (document.querySelector('.modal-overlay:not(.hidden)')) return;
    this.show();
    this.render();
  }

  /**
   * Built ON OPEN only (principle 6): the world is paused behind the overlay,
   * so nothing here can go stale while it is visible — and `hospitalValue`
   * walks every room and amenity, which must never ride a frame poll.
   */
  private render(): void {
    this.card.replaceChildren();
    const title = document.createElement('h2');
    title.textContent = 'Finances';
    this.card.appendChild(title);

    // The report body SCROLLS and Continue is pinned outside it (live-drive
    // MAJOR 2): with a graph and four departments this card runs past 80vh,
    // and on a short window the button fell off the bottom with no scrollbar
    // and no Esc (the bottom-bar peel is suppressed while a modal is open) —
    // a paused game with no visible way out. The title and Continue stay
    // outside the scroller so the way out is always on screen.
    this.body = document.createElement('div');
    this.body.className = 'finance-body';
    this.card.appendChild(this.body);

    this.appendSummary();
    this.appendGrid();
    this.appendGraph();
    this.appendDepartments();

    const cont = document.createElement('button');
    cont.textContent = 'Continue';
    cont.className = 'modal-continue';
    cont.setAttribute('data-ui', '');
    cont.addEventListener('click', () => this.closeAndResume());
    this.card.appendChild(cont);
  }

  /** §3.2 — the four headline numbers, every one a `formulas.ts` derivation. */
  private appendSummary(): void {
    const world = this.world;
    const box = modalSection(this.body, 'Summary');
    modalRow(box, 'Cash on hand', money(world.cash));
    modalRow(box, 'Hospital value', money(hospitalValue(world)));
    const todayNet = netFromCategories(world.today);
    modalRow(box, "Today's net", money(todayNet), todayNet >= 0 ? 'good' : 'bad');
    // null before the first discharge counted in the lifetime window — an
    // em-dash rather than a fabricated $0 (§7 Q7).
    const avg = averageBillPerPatient(
      world.lifetime,
      world.lifetimeTreated,
      world.lifetimeTreatedBase,
    );
    modalRow(box, 'Average bill per patient', avg === null ? EM_DASH : money(avg));

    // Stated ONCE, and for the save's whole life (§7 Q7): a pre-v7 save cannot
    // reconstruct its lifetime cash, so Total means "since the upgrade". The
    // watermark is the honest marker — `lifetime` being all-zero stops being
    // true after one day while the skew would last forever.
    if (world.lifetimeTreatedBase > 0) {
      const note = document.createElement('p');
      note.className = 'finance-note';
      note.textContent = 'Total is since this save was upgraded — earlier days were not recorded.';
      this.body.appendChild(note);
    }
  }

  /** §3.1 — the RCT table: categories down, days across. */
  private appendGrid(): void {
    const world = this.world;
    const columns: Column[] = [
      // Oldest → newest, like RCT's months. `history` is already trimmed to
      // historyCapDays; we SHOW the last historyShownDays of it.
      ...world.history.slice(-BALANCE.finance.historyShownDays).map((report) => ({
        label: `Day ${report.day}`,
        totals: report as CashTotals,
      })),
      { label: 'Today', totals: world.today },
      // Lifetime, not a sum over history: a sold room takes its counter with
      // it, and the stored window is only 30 days (§3.1, review MAJOR 1).
      { label: 'Total', totals: world.lifetime },
    ];

    const box = modalSection(this.body, 'Income & expenditure');
    const template = gridTemplate(columns.length);
    gridRow(
      box,
      '',
      columns.map((column) => ({ text: column.label })),
      template,
      'finance-head',
    );

    // EVERY non-breakdown row always renders: a grid needs a stable row set
    // across columns, so `showWhenZero` (the daily report's rule) is not read
    // here. The breakdown row renders too, indented, and is never summed.
    for (const category of FINANCE_CATEGORIES) {
      const breakdown = category.kind === 'breakdown';
      const expense = category.kind === 'expense';
      const cells = columns.map((column): Cell => {
        const amount = column.totals[category.field];
        if (amount === 0) return { text: EM_DASH };
        // ONE flag: `kind` drives the display negation AND the tone.
        return { text: money(expense ? -amount : amount), tone: expense ? 'bad' : 'good' };
      });
      gridRow(box, category.label, cells, template, breakdown ? 'finance-breakdown' : '');
    }

    // The SAME fold every other surface uses — dayNet delegates to it, so the
    // Today column cannot disagree with tonight's daily report.
    const netCells = columns.map((column): Cell => {
      const net = netFromCategories(column.totals);
      return { text: money(net), tone: net >= 0 ? 'good' : 'bad' };
    });
    gridRow(box, 'Net', netCells, template, 'finance-net');
  }

  /** §3.3 — end-of-day cash across the STORED history, not the shown columns. */
  private appendGraph(): void {
    const history = this.world.history;
    // One point is not a line, and the x formula divides by (n − 1).
    if (history.length < MIN_GRAPH_DAYS) return;
    const values = history.map((report) => report.cash);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // A flat cash run (every day identical) must not divide by zero.
    const span = max - min || 1;
    const points = values
      .map((value, i) => {
        const x = (i / (values.length - 1)) * GRAPH_WIDTH;
        const y = GRAPH_HEIGHT - ((value - min) / span) * GRAPH_HEIGHT;
        return `${x},${y}`;
      })
      .join(' ');

    const box = modalSection(this.body, 'Cash over time');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`);
    // Stretch to the card: the shape is the message, the aspect ratio is not.
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'finance-graph');

    // Only drawn when zero is actually inside the range — off-scale, a zero
    // line pinned to an edge reads as "we are at break-even" and lies.
    if (min <= 0 && max >= 0) {
      const zeroY = GRAPH_HEIGHT - ((0 - min) / span) * GRAPH_HEIGHT;
      const zero = document.createElementNS(SVG_NS, 'line');
      zero.setAttribute('x1', '0');
      zero.setAttribute('x2', String(GRAPH_WIDTH));
      zero.setAttribute('y1', String(zeroY));
      zero.setAttribute('y2', String(zeroY));
      zero.setAttribute('class', 'finance-graph-zero');
      svg.appendChild(zero);
    }

    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', points);
    line.setAttribute('class', 'finance-graph-line');
    svg.appendChild(line);

    // The scale labels describe the VERTICAL axis, so they anchor to the
    // vertical extremes — max at the top edge, min at the bottom (live-drive
    // MAJOR 1). Laid out horizontally under the graph they read as "start …
    // end", which inverts the story on every rising week: a player sees the
    // line climb while the labels count down.
    const frame = document.createElement('div');
    frame.className = 'finance-graph-frame';
    frame.appendChild(svg);
    for (const [text, edge] of [
      [money(max), 'max'],
      [money(min), 'min'],
    ] as const) {
      const label = document.createElement('span');
      label.className = `finance-graph-scale finance-graph-${edge}`;
      label.textContent = text;
      frame.appendChild(label);
    }
    box.appendChild(frame);
  }

  /**
   * §5.1 — the two-sided departmental ledger. A department IS a `RoomCategory`
   * (the SSOT the build menu and directory already group by). Income only:
   * rooms have no running costs in v1 (§7 Q2), so this must never be read as
   * "does the department pay for itself".
   */
  private appendDepartments(): void {
    const world = this.world;
    const box = modalSection(this.body, 'Departments');
    const template = gridTemplate(DEPARTMENT_HEADERS.length);
    gridRow(
      box,
      '',
      DEPARTMENT_HEADERS.map((text) => ({ text })),
      template,
      'finance-head',
    );

    for (const category of CATEGORIES) {
      let rooms = 0;
      let incomeToday = 0;
      let incomeTotal = 0;
      let seen = 0;
      for (const room of world.rooms.values()) {
        if (ROOM_DEFS[room.type].category !== category) continue;
        rooms += 1;
        incomeToday += room.revenueToday;
        incomeTotal += room.revenueTotal;
        seen += room.visitsTotal;
      }
      const cells: Cell[] = [
        { text: String(rooms) },
        moneyCell(incomeToday, 'good'),
        moneyCell(incomeTotal, 'good'),
        // Pure, zero new state — and it deliberately bills the free starting
        // rooms, because it reads what the department is WORTH.
        moneyCell(departmentCapital(world, category)),
        { text: String(seen) },
      ];
      gridRow(box, CATEGORY_LABELS[category], cells, template);
    }

    // Amenities are roomless, so they belong to no RoomCategory — but omitting
    // them silently left the block short of Patient fees by exactly the vending
    // take, with no line to explain the gap (live-drive MINOR 1). They get
    // their own row: income is per-machine lifetime revenue, capital is what
    // the machines are worth, and the room columns read `—` because a machine
    // is not a room and has no patients-seen.
    let vendingToday = 0;
    let vendingTotal = 0;
    let amenityCapital = 0;
    for (const amenity of world.amenities.values()) {
      vendingToday += amenity.revenueToday;
      vendingTotal += amenity.revenueTotal;
      amenityCapital += amenitySellback(amenity.kind);
    }
    if (world.amenities.size > 0) {
      gridRow(
        box,
        'Amenities',
        [
          { text: String(world.amenities.size) },
          moneyCell(vendingToday, 'good'),
          moneyCell(vendingTotal, 'good'),
          moneyCell(amenityCapital),
          { text: EM_DASH },
        ],
        template,
      );
    }

    // THE reconciling line. Everything above sums what we CURRENTLY own, but
    // `lifetime.revenue` remembers every fee ever billed — including fees
    // earned in rooms since sold, which have no department left to sit under.
    // Without this row the block was quietly short of Patient fees with
    // nothing to explain the gap, and a player who sold a room would be told
    // their hospital had earned less than it did. Derived, zero new state.
    let ownedTotal = 0;
    for (const room of world.rooms.values()) ownedTotal += room.revenueTotal;
    // max(0) is defensive, not expected: a pre-v7 save restores rooms with
    // counters 0 AND lifetime 0, so the two sides stay consistent.
    const soldRoomIncome = Math.max(0, world.lifetime.revenue - ownedTotal - vendingTotal);
    if (soldRoomIncome > 0) {
      gridRow(
        box,
        'Sold rooms (no longer owned)',
        [
          { text: EM_DASH },
          { text: EM_DASH },
          moneyCell(soldRoomIncome, 'good'),
          { text: EM_DASH },
          { text: EM_DASH },
        ],
        template,
      );
    }

    // The honest closer (§6): staff are dispatched hospital-wide, so charging
    // payroll to a department would need an allocation POLICY, not a query.
    // Shown rather than omitted, so the ledger reads as two-sided. It is a
    // LIFETIME figure and says so — unlabelled beneath an "Income today"
    // column it reads as one day's wages dwarfing one day's income, which is
    // a wrong conclusion about viability (review MINOR). Rendered as a grid
    // row so the money lands in a money column, not under "Patients seen".
    // Rendered OUTSIDE the column grid (verification NIT): as a grid row its
    // money landed under a column header — first "Patients seen", then
    // "Income total", where it read as negative income for a department that
    // does not exist. It belongs to no column because it belongs to no
    // department; a bordered footer says that visually, the way the grid's Net
    // row does.
    const footer = document.createElement('div');
    footer.className = 'modal-row finance-footer';
    const label = document.createElement('span');
    label.textContent = 'Payroll (not allocated)';
    const value = document.createElement('span');
    value.className = 'bad';
    value.textContent = world.lifetime.payroll === 0 ? EM_DASH : money(-world.lifetime.payroll);
    const note = document.createElement('span');
    note.className = 'finance-footer-note';
    note.textContent = 'lifetime · staff serve the whole hospital';
    footer.append(label, note, value);
    box.appendChild(footer);
  }
}

/**
 * The one multi-column row builder. `modalRow` is a two-span flex row and
 * cannot express N value columns, so the grid keeps its own builder HERE
 * rather than widening the shared one for a single caller (reported to the
 * orchestrator). It still emits `.modal-row` + the shared tone classes, so the
 * card's typography and colors stay the daily report's.
 */
function gridRow(
  parent: HTMLElement,
  label: string,
  cells: readonly Cell[],
  template: string,
  rowClass = '',
): void {
  const row = document.createElement('div');
  row.className = `modal-row finance-row${rowClass ? ` ${rowClass}` : ''}`;
  row.style.gridTemplateColumns = template;
  const labelSpan = document.createElement('span');
  labelSpan.className = 'finance-label';
  labelSpan.textContent = label;
  row.appendChild(labelSpan);
  for (const cell of cells) {
    const value = document.createElement('span');
    value.className = 'finance-cell';
    value.textContent = cell.text;
    if (cell.tone) value.classList.add(cell.tone);
    row.appendChild(value);
  }
  parent.appendChild(row);
}

/** Label column + N equal value columns, as one inline grid template. The
 *  label column is generous because the longest labels ("Sell-back income",
 *  "Payroll (not allocated, lifetime)") wrapped at 1.5fr and left single rows
 *  taller than their neighbours (live-drive NIT 3). */
function gridTemplate(columns: number): string {
  return `minmax(0, 2.4fr) repeat(${columns}, minmax(0, 1fr))`;
}

/** Money cell with the §3.1 zero rule — an em-dash beats a row of "$0". */
function moneyCell(amount: number, tone?: string): Cell {
  if (amount === 0) return { text: EM_DASH };
  return { text: money(amount), tone };
}
