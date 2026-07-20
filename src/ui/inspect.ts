import type { CommandQueue } from '../commands';
import type { WorldRenderer, Selection } from '../render/renderer';
import { validateRoomSell } from '../sim/build';
import { AMENITY_DEFS, type AmenityId } from '../sim/data/amenities';
import { CONDITION_DEFS, conditionElective } from '../sim/data/conditions';
import { ROOM_DEFS, roomRetired } from '../sim/data/rooms';
import { ROLE_DEFS } from '../sim/data/roles';
import { type ShiftId } from '../sim/data/shifts';
import { BALANCE } from '../sim/data/balance';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_HOUR, ticksToGameMinutes } from '../sim/clock';
import {
  amenitySellback,
  moodOf,
  onShift,
  roomEarns,
  sellbackAmount,
  staffRatioFor,
} from '../sim/formulas';
import type { PatientStage } from '../sim/entities/patient';
import type { Reservation, StaffDuty } from '../sim/entities/staff';
import type { World } from '../sim/world';
import { money, patientStageLabel, staffDutyLabel } from './format';

/** Health/patience scale ceiling comes from the balance table (SSOT audit #1). */
const VITALS_MAX = BALANCE.stats.vitalsMax;
/** CSS width percentage scale — presentation, not a game number. */
const CSS_PERCENT = 100;
const MAX_SKILL_STARS = BALANCE.stats.max;

/** Escape interpolations — names/thoughts are data and must never be markup. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inspection panel (GDD §9): click a patient/staff/room in idle mode. A pure
 * projection — the DOM skeleton is rebuilt only when the selection identity
 * changes; live fields are re-polled every frame. Fire and Sell push commands.
 */
export class InspectPanel {
  private panel!: HTMLElement;
  private body!: HTMLElement;
  private actionButton!: HTMLButtonElement;
  /** Stage B: 'Expand' on room selections (above the Sell action). */
  private expandButton!: HTMLButtonElement;
  /** ED B1 (§5.3): 'Close'/'Reopen' on room selections — the drain gesture
   *  that makes a permanently-busy room expandable. Sits between Expand and
   *  Sell, i.e. next to the two rejection reasons it exists to resolve. */
  private closeButton!: HTMLButtonElement;
  /** SHIFTS Stage-1: day/night toggle on staff selections (rebalance coverage). */
  private shiftButton!: HTMLButtonElement;
  private shownKey = '';

  constructor(
    private world: World,
    private commands: CommandQueue,
    private renderer: WorldRenderer,
  ) {}

  mount(parent: HTMLElement): void {
    this.panel = document.createElement('div');
    this.panel.id = 'inspect';
    this.panel.setAttribute('data-ui', '');
    this.panel.classList.add('hidden');

    const header = document.createElement('div');
    header.className = 'inspect-header';
    const title = document.createElement('h3');
    title.textContent = 'Inspect';
    const close = document.createElement('button');
    close.textContent = '✕';
    close.setAttribute('data-ui', '');
    close.addEventListener('click', () => {
      this.renderer.selected = null;
    });
    header.append(title, close);

    this.body = document.createElement('div');
    this.expandButton = document.createElement('button');
    this.expandButton.className = 'inspect-action';
    this.expandButton.setAttribute('data-ui', '');
    this.closeButton = document.createElement('button');
    this.closeButton.className = 'inspect-action';
    this.closeButton.setAttribute('data-ui', '');
    this.shiftButton = document.createElement('button');
    this.shiftButton.className = 'inspect-action';
    this.shiftButton.setAttribute('data-ui', '');
    this.actionButton = document.createElement('button');
    this.actionButton.className = 'inspect-action';
    this.actionButton.setAttribute('data-ui', '');

    this.panel.append(
      header,
      this.body,
      this.expandButton,
      this.closeButton,
      this.shiftButton,
      this.actionButton,
    );
    parent.appendChild(this.panel);
  }

  /** Polled once per frame by the loop's render callback (like the HUD). */
  update(): void {
    const selection = this.renderer.selected;
    if (!selection || !this.stillExists(selection)) {
      this.panel.classList.add('hidden');
      this.shownKey = '';
      return;
    }
    this.panel.classList.remove('hidden');
    // Amenities carry no entity id — the tile is the identity (Stage 1 freeze).
    const key =
      selection.kind === 'amenity'
        ? `amenity:${selection.col},${selection.row}`
        : `${selection.kind}:${selection.id}`;
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.wireAction(selection);
    }
    this.renderBody(selection);
  }

  private stillExists(selection: Selection): boolean {
    if (selection.kind === 'patient') return this.world.patients.has(selection.id);
    if (selection.kind === 'staff') return this.world.staff.has(selection.id);
    if (selection.kind === 'amenity')
      return this.world.amenityAt(selection.col, selection.row) !== null;
    return this.world.rooms.has(selection.id);
  }

  /** (Re)bind the action button for the new selection identity. */
  private wireAction(selection: Selection): void {
    // Build from scratch — cloning would carry over the previous selection's
    // inline display:none / danger class (M3 review: Fire/Sell went missing
    // forever after any patient had been inspected).
    const fresh = document.createElement('button');
    fresh.className = 'inspect-action';
    fresh.setAttribute('data-ui', '');
    this.actionButton.replaceWith(fresh);
    this.actionButton = fresh;
    if (selection.kind === 'staff') {
      fresh.textContent = 'Fire';
      fresh.classList.add('danger');
      fresh.addEventListener('click', () =>
        this.commands.push({ type: 'fireStaff', staffId: selection.id }),
      );
    } else if (selection.kind === 'room') {
      fresh.classList.add('danger');
      fresh.addEventListener('click', () =>
        this.commands.push({ type: 'sellRoom', roomId: selection.id }),
      );
    } else if (selection.kind === 'amenity') {
      // Stage 1: the inspect card is the ONLY sell path for amenities (sell
      // MODE ignores their tiles — pre-impl NIT 14, deliberate). Label set in
      // renderBody alongside the room pattern.
      fresh.classList.add('danger');
      fresh.addEventListener('click', () =>
        this.commands.push({ type: 'sellAmenity', col: selection.col, row: selection.row }),
      );
    } else {
      fresh.style.display = 'none';
    }
    // Stage B: the Expand gesture entry point (CAPACITY_PLAN §4.2) — rebuilt
    // fresh like the action button so listeners never stack across selections.
    const freshExpand = document.createElement('button');
    freshExpand.className = 'inspect-action';
    freshExpand.setAttribute('data-ui', '');
    this.expandButton.replaceWith(freshExpand);
    this.expandButton = freshExpand;
    if (selection.kind === 'room') {
      freshExpand.textContent = 'Expand';
      freshExpand.addEventListener('click', () => {
        this.renderer.setMode({ kind: 'expand', roomId: selection.id });
        this.renderer.selected = null; // hand the bottom-left back to the map
      });
    } else {
      freshExpand.style.display = 'none';
    }
    // ED B1 (§5.3): Close/Reopen, rebuilt fresh for the same reason. The
    // `closed` flag is read at CLICK time, never captured here — the card is
    // wired once per selection identity but the room can be closed by any
    // other path (and the UI never caches authoritative state).
    const freshClose = document.createElement('button');
    freshClose.className = 'inspect-action';
    freshClose.setAttribute('data-ui', '');
    this.closeButton.replaceWith(freshClose);
    this.closeButton = freshClose;
    if (selection.kind === 'room') {
      freshClose.addEventListener('click', () => {
        const room = this.world.rooms.get(selection.id);
        if (!room) return;
        this.commands.push({ type: 'setRoomClosed', roomId: selection.id, closed: !room.closed });
      });
    } else {
      freshClose.style.display = 'none';
    }
    // SHIFTS Stage-1: the day/night toggle on staff selections, rebuilt fresh so
    // listeners never stack. The current shift is read at CLICK time (the card
    // never caches authoritative state — the hire panel can flip it too).
    const freshShift = document.createElement('button');
    freshShift.className = 'inspect-action';
    freshShift.setAttribute('data-ui', '');
    this.shiftButton.replaceWith(freshShift);
    this.shiftButton = freshShift;
    if (selection.kind === 'staff') {
      freshShift.addEventListener('click', () => {
        const member = this.world.staff.get(selection.id);
        if (!member) return;
        const next: ShiftId = (member.shift ?? 'day') === 'night' ? 'day' : 'night';
        this.commands.push({ type: 'setStaffShift', staffId: selection.id, shift: next });
      });
    } else {
      freshShift.style.display = 'none';
    }
  }

  /** Phase of the reservation a reserved stage/duty is bound to (else undefined). */
  private reservationPhase(state: PatientStage | StaffDuty): Reservation['phase'] | undefined {
    return state.kind === 'reserved'
      ? this.world.reservations.get(state.reservationId)?.phase
      : undefined;
  }

  private line(label: string, value: string): string {
    return `<div class="inspect-row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
  }

  /** A §4 Income line. Same row shape, but its own class: "Patients seen"
   *  does not fit the shared 72px label column, and widening that column
   *  would reflow every other card. */
  private incomeLine(label: string, value: string): string {
    return `<div class="inspect-row income"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
  }

  private bar(label: string, value: number, color: string): string {
    const clamped = Math.max(0, Math.min(VITALS_MAX, value));
    const pct = (clamped / VITALS_MAX) * CSS_PERCENT;
    return (
      `<div class="inspect-row"><span>${label}</span>` +
      `<span class="bar"><span style="width:${pct.toFixed(0)}%;background:${color}"></span></span>` +
      `<span class="bar-num">${Math.ceil(clamped)}</span></div>`
    );
  }

  private renderBody(selection: Selection): void {
    if (selection.kind === 'patient') {
      const p = this.world.patients.get(selection.id)!;
      const mood = { content: '🙂', impatient: '💢', critical: '💀' }[
        moodOf(p.health, p.patience)
      ];
      this.body.innerHTML =
        `<div class="inspect-name">${esc(p.name.full)}, ${p.age} ${mood}${p.lost ? ' ❓lost' : ''}</div>` +
        this.line('Condition', CONDITION_DEFS[p.condition].label) +
        // A referral arrives pre-triaged and never passes through a triage
        // bay. Unlabelled, a patient with an acuity and no triage history
        // reads as a bug (OUTPATIENT_IMPL_PLAN §3.7).
        (conditionElective(p.condition) ? this.line('Source', 'Referral (outpatient)') : '') +
        this.line('Acuity', p.acuity === null ? 'not triaged' : `${p.acuity}`) +
        this.bar('Health', p.health, '#57bb6a') +
        this.bar('Patience', p.patience, '#e0a800') +
        // Need meters (amenities Stage 1, §3.1) — same 0–vitalsMax scale.
        this.bar('Bladder', p.bladder, '#8e7cc3') +
        this.bar('Thirst', p.thirst, '#4aa3c9') +
        this.line('State', patientStageLabel(p.stage, this.reservationPhase(p.stage))) +
        this.line('Billed', `$${p.billed.toLocaleString()}`);
      return;
    }
    if (selection.kind === 'staff') {
      const s = this.world.staff.get(selection.id)!;
      const stars = '★'.repeat(s.skill) + '☆'.repeat(MAX_SKILL_STARS - s.skill);
      // ED B1 (§5.1/§5.2): the staffer's whole PANEL, not the witness alone.
      // A ratio staffer's reservations are all in ONE room (impl plan §1), so
      // the first one identifies the room the ratio applies in.
      const panel = this.world.reservationsOfStaff(s.id);
      const panelRoom = panel.length > 0 ? this.world.rooms.get(panel[0]!.roomId) : undefined;
      // Only rooms that actually SHARE a staffer get a load readout — a 1:1
      // exam room must not sprout "(1/1)" noise on every card.
      const ratio = panelRoom ? staffRatioFor(panelRoom.type, s.role) : 1;
      const panelLine =
        panelRoom && ratio > 1
          ? this.line(
              'Panel',
              `${ROOM_DEFS[panelRoom.type].label} ${this.world.staffLoadIn(s.id, panelRoom.id)}/${ratio}`,
            )
          : '';
      // SHIFTS Stage-1: shift + live floor status, and the toggle's label.
      const shiftLabel = s.shift ? s.shift.charAt(0).toUpperCase() + s.shift.slice(1) : 'Always';
      // SHIFTS Stage 2: an on-lunch staffer reads legibly (§3.7) — otherwise an
      // off-floor luncher looks like she quit, and a lounge one looks idle. Once
      // she's settled (`using`) show when she's back so a vanishing staffer has
      // an ETA, not a mystery.
      let status: string;
      if (s.onBreak !== null) {
        const where = s.onBreak.mode === 'lounge' ? 'in the staff lounge' : 'out for lunch';
        if (s.onBreak.phase === 'using') {
          const back =
            (this.world.clock.minuteOfDay + ticksToGameMinutes(s.onBreak.ticksRemaining)) %
            GAME_MINUTES_PER_DAY;
          const hh = String(Math.floor(back / GAME_MINUTES_PER_HOUR)).padStart(2, '0');
          const mm = String(Math.floor(back % GAME_MINUTES_PER_HOUR)).padStart(2, '0');
          status = `${where} — back ~${hh}:${mm}`;
        } else {
          status = where;
        }
      } else {
        status = !s.onFloor
          ? 'off duty (home)'
          : s.shift && !onShift(s.shift, this.world.clock.minuteOfDay)
            ? 'off shift (leaving)'
            : 'on duty';
      }
      const nextShift: ShiftId = (s.shift ?? 'day') === 'night' ? 'day' : 'night';
      this.shiftButton.textContent = `Switch to ${nextShift.charAt(0).toUpperCase() + nextShift.slice(1)} shift`;
      this.body.innerHTML =
        `<div class="inspect-name">${esc(s.name.full)}, ${s.age}</div>` +
        this.line('Role', ROLE_DEFS[s.role].label) +
        this.line('Skill', stars) +
        this.line('Salary', `$${s.salaryPerDay}/day`) +
        this.line('Shift', `${shiftLabel} — ${status}`) +
        this.line(
          'Duty',
          // SHIFTS Stage 2: on lunch her duty is idle, which would read "Idle" —
          // say "On lunch" instead (the mode shows in the Shift status above).
          s.onBreak !== null
            ? 'On lunch'
            : // Stage 2: job duties resolve their kind from world.jobs so the line
              // reads "Cleaning" / "Emptying a trashcan"; the frozen format.ts
              // fallback covers a job deleted mid-frame (S2.1 freeze). Stage-3
              // live-drive MINOR 2: the PHASE splits en-route from at-work, so a
              // walking tech reads "Heading to a repair", not "Repairing".
              staffDutyLabel(
                s.duty,
                // ED B1 §5.1: the PANEL's phases, not the witness reservation's.
                panel.map((r) => r.phase),
                s.duty.kind === 'job' ? this.world.jobs.get(s.duty.jobId)?.kind : undefined,
                s.duty.kind === 'job' ? this.world.jobs.get(s.duty.jobId)?.phase : undefined,
              ) + (s.firing ? ' (leaving after this patient)' : ''),
        ) +
        panelLine;
      return;
    }
    if (selection.kind === 'amenity') {
      const amenity = this.world.amenityAt(selection.col, selection.row)!;
      const def = AMENITY_DEFS[amenity.kind];
      // What it does (§3.4): vending's price is the billFee SSOT number; the
      // plant aura radius comes from the same table refreshAuras reads; the
      // trashcan is pure flavor until Stage-2 messes give it a job.
      const effectLine: Record<AmenityId, string> = {
        vending:
          this.line('Drinks', `$${BALANCE.needs.vendingPrice} per use`) +
          // FINANCE_PLAN §4.2 (our RCT shop window): per-MACHINE lifetime
          // revenue, so a badly-placed machine reads $0 and is visibly dead.
          // Trashcans and plants earn nothing and render no line at all.
          this.incomeLine('Income total', money(amenity.revenueTotal)),
        plant: this.line('Effect', `Comfort aura, ${BALANCE.needs.plantAuraRadius} tiles`),
        // Stage 2: `fill` is live trashcan contents (vending litter, §4.1) —
        // frame-polled like every card field, no event needed; the capacity is
        // the overflow threshold the sim reads (SSOT).
        trashcan:
          this.line('Effect', 'Keeps the ER tidy') +
          this.line('Fill', `${amenity.fill}/${BALANCE.mess.trashcanCapacity}`),
      };
      this.body.innerHTML =
        `<div class="inspect-name">${esc(def.label)}</div>` + effectLine[amenity.kind];
      // amenitySellback is the sim's payout AND this label (the sellbackAmount
      // pattern — never a locally computed 50%).
      const refund = amenitySellback(amenity.kind);
      this.actionButton.textContent = `Sell (+$${refund.toLocaleString()})`;
      this.actionButton.disabled = false;
      return;
    }
    const room = this.world.rooms.get(selection.id)!;
    const def = ROOM_DEFS[room.type];
    const sellCheck = validateRoomSell(this.world, room.id);
    // Stage A: a room can hold SEVERAL reservations (one per bed/machine) —
    // list every occupant, not an arbitrary .find of one.
    const reservations = this.world.reservationsOn(room.id);
    // Restroom occupancy is DERIVED from needBreak stall claims (§3.3) —
    // reservations are ALWAYS empty for the unstaffed self-service room, so
    // reading them would render a permanent "Stalls 0/2" (review MINOR 7).
    const stallClaims = room.type === 'restroom' ? this.world.stallClaims(room.id) : null;
    // SHIFTS Stage 2 (§2): a lounge derives occupancy from STAFF onBreak claims,
    // exactly like the restroom — reading reservations would render a permanent
    // "Seats 0/3" (the same review MINOR 7 the restroom special-case avoids).
    const loungeClaims = room.type === 'lounge' ? this.world.loungeSeatClaims(room.id) : null;
    const derivedClaims = stallClaims ?? loungeClaims; // slot → patientId (stall) | staffId (lounge)
    // "In use" lists only USING claimants; walkers still crossing the map
    // read "on the way" (live-drive review MINOR 3 — the flat list overstated
    // occupancy while a claimant was three corridors away).
    const claimName = (id: number): string | undefined => this.world.patients.get(id)?.name.short;
    const occupant = derivedClaims
      ? [...derivedClaims.values()]
          .map((id) => {
            // Lounge claims are STAFF ids; stall claims are PATIENT ids.
            if (loungeClaims) {
              const s = this.world.staff.get(id);
              if (!s) return undefined;
              return s.onBreak?.phase === 'walking' ? `${s.name.short} (on the way)` : s.name.short;
            }
            const name = claimName(id);
            if (name === undefined) return undefined;
            const walking = this.world.patients.get(id)?.needBreak?.phase === 'walking';
            return walking ? `${name} (on the way)` : name;
          })
          .filter((name): name is string => name !== undefined)
          .join(', ') || '—'
      : reservations
          .map((r) => claimName(r.patientId))
          .filter((name): name is string => name !== undefined)
          .join(', ') || '—';
    // Capacity readout ("Beds 1/3" / "Seats 4/9" / "Stalls 1/2"): used count
    // differs by rule — waiting-room seats by seated waiters, restroom stalls
    // by live claims, treatment slots by reservations. capacityOf is the same
    // SSOT the dispatcher reads.
    // Stage 3 (impl plan §S3.6): a broken room reads OUT OF SERVICE. The
    // repair status resolves from world.jobs by roomId (the staff-card
    // jobKind-resolution pattern) — frame-polled like every field, no event.
    const broken = room.brokenSince !== null;
    let repairUnderway = false;
    if (broken) {
      for (const job of this.world.jobs.values()) {
        if (job.kind === 'repair' && job.roomId === room.id) {
          repairUnderway = job.phase === 'working';
          break;
        }
      }
    }
    // ED B1 (§5.3): the player's own close reads as a DRAIN, not a fault —
    // gathering reservations were cancelled on close, so anything still live
    // is an active treatment running to completion. Broken wins the line:
    // `setRoomClosed` is a no-op on a broken room, so "repair it" is the only
    // actionable status there.
    const draining = room.closed && reservations.length > 0;
    const statusLine = broken
      ? this.line('Status', `OUT OF SERVICE — repair ${repairUnderway ? 'underway' : 'pending'}`)
      : room.closed
        ? this.line('Status', draining ? 'CLOSED — draining' : 'CLOSED')
        : '';
    const capRule = def.capacity;
    let capacityLine = '';
    // While broken the status line REPLACES the perProp capacity readout —
    // capacityOf reads 0, and "Stalls 1/0" is exactly the confusion §5.2
    // forbids. Single-capacity rooms render no capacity line to replace
    // (pre-impl MINOR 4) — they just gain the status line. The restroom's
    // "In use" line below keeps rendering while broken: in-flight claimants
    // legitimately finish (deliberate, §S3.6).
    // ED B1: a CLOSED room reads capacityOf 0 through the same line broken
    // rooms do, so it replaces the capacity readout for the same reason — a
    // draining "Beds 2/0" is exactly the confusion the status line prevents.
    if (capRule.kind === 'perProp' && !broken && !room.closed) {
      const total = this.world.capacityOf(room);
      const used = derivedClaims
        ? derivedClaims.size
        : room.type === 'waiting'
          ? [...this.world.patients.values()].filter((p) => p.waitingRoomId === room.id).length
          : reservations.length;
      capacityLine = this.line(capRule.noun, `${used}/${total}`);
    }
    // Who RUNS the room (role SSOT — the dialysis "hire a dialysis member"
    // confusion: roles were invisible in the UI). The posted-names line only
    // makes sense for standing-post rooms (reception/atrium); on treatment
    // rooms it was a misleading permanent "—" (staff arrive per-reservation).
    const runBy = def.staffedBy.map((role) => ROLE_DEFS[role].label).join(', ');
    const hasPost = def.staffedBy.some((role) => ROLE_DEFS[role].standingPost);
    // This body re-renders every frame — only scan the staff map for the two
    // room types that actually render a Posted line (review MINOR).
    const posted = hasPost
      ? [...this.world.staff.values()].filter(
          (s) => s.duty.kind === 'post' && s.duty.roomId === room.id,
        )
      : [];
    // ED B1 (§5.2) — per-staffer load, the readout that makes "another nurse
    // or another bay?" answerable: "1 nurse (3/4) · 1 doctor (2/4)". Only
    // roles this room type actually SHARES (ratio > 1) appear, so a 1:1 room
    // renders nothing rather than "(1/1)" noise on every card. Staff ids come
    // from the live reservations, deduped and id-sorted for a stable line.
    const loadParts: string[] = [];
    for (const role of def.staffedBy) {
      const ratio = staffRatioFor(room.type, role);
      if (ratio <= 1) continue;
      const ids = new Set<number>();
      for (const r of reservations) {
        for (const id of r.staffIds) {
          if (this.world.staff.get(id)?.role === role) ids.add(id);
        }
      }
      if (ids.size === 0) continue;
      const each = [...ids]
        .sort((a, b) => a - b)
        .map((id) => `${this.world.staffLoadIn(id, room.id)}/${ratio}`)
        .join(', ');
      const noun = ROLE_DEFS[role].label.toLowerCase();
      loadParts.push(`${ids.size} ${noun}${ids.size === 1 ? '' : 's'} (${each})`);
    }
    const loadLine = loadParts.length > 0 ? this.line('Staffing', loadParts.join(' · ')) : '';
    // FINANCE_PLAN §4.1 — the RCT ride-window Income tab, per room. Rendered
    // only for rooms that can BILL: roomEarns is derived from CONDITION_DEFS,
    // so a corridor or a waiting room renders nothing rather than a permanent
    // $0, while an earning room that has never been used reads $0 — the RCT
    // "this ride earns nothing" read, which is the whole point of the block.
    // INCOME, not profit: rooms have no running costs yet (§7 Q2), so nothing
    // here may imply the room pays for itself.
    // "Patients seen", never "Treated": treated/lifetimeTreated mean
    // DISCHARGES, and a 2-step patient would read as 2 across two rooms —
    // visitsTotal counts completed treatment STEPS in THIS room.
    const incomeLines = roomEarns(room.type)
      ? this.incomeLine('Income today', money(room.revenueToday)) +
        this.incomeLine('Income total', money(room.revenueTotal)) +
        this.incomeLine('Patients seen', String(room.visitsTotal))
      : '';
    this.body.innerHTML =
      `<div class="inspect-name">${esc(def.label)}</div>` +
      this.line('Size', `${room.rect.cols}×${room.rect.rows}`) +
      this.line('Quality', `+${room.quality}`) +
      statusLine +
      capacityLine +
      (runBy ? this.line('Run by', runBy) : '') +
      loadLine +
      (hasPost ? this.line('Posted', posted.map((s) => s.name.short).join(', ') || '—') : '') +
      // "Treating" would be dishonest for a self-service room (§3.3).
      this.line(stallClaims ? 'In use' : 'Treating', occupant) +
      // DEPARTMENTS_PLAN §3.6 defect 3: a retired room must SAY it is retired.
      // Otherwise it is a room the player paid for that quietly stops
      // receiving patients, which reads as a bug rather than a decision.
      (roomRetired(room.type)
        ? this.line('Retired', 'No longer takes patients — sells for a full refund')
        : '') +
      incomeLines;
    // sellbackAmount is the sim's payout AND this label (SSOT audit #2);
    // rect-aware since Stage 0 (an oversized room refunds its sized price).
    const refund = sellbackAmount(room.type, room.rect);
    // A retired room refunds in FULL (DEPARTMENTS_PLAN §3.6 defect 3) — say so
    // on the button, or a player who notices the bigger number assumes a bug.
    // `sellbackAmount` already applies the ratio; this only explains it.
    this.actionButton.textContent = sellCheck.ok
      ? roomRetired(room.type)
        ? `Sell (+$${refund.toLocaleString()} — full refund)`
        : `Sell (+$${refund.toLocaleString()})`
      : `Sell — ${sellCheck.reason}`;
    this.actionButton.disabled = !sellCheck.ok;
    // Stage 3: never invite a dead click — the sim rejects expanding a broken
    // room (validateRoomExpand: 'Out of service — repair it first'); mirror
    // the Sell reject idiom above. Re-set EVERY frame, not in wireAction —
    // repair completion must re-enable the button without a re-selection.
    // ED B1 (§5.3): the OTHER validateRoomExpand reject gets the same
    // treatment. It was previously invisible until the player had already
    // dragged a rect — and it is the whole reason Close exists, so it must be
    // legible RIGHT NEXT to the Close button that resolves it.
    this.expandButton.textContent = broken
      ? 'Expand — Out of service — repair it first'
      : reservations.length > 0
        ? 'Expand — Room is busy — wait for treatments to finish'
        : 'Expand';
    this.expandButton.disabled = broken || reservations.length > 0;
    // Close/Reopen. A broken room can't be closed (setRoomClosed no-ops on
    // one), so the button says why rather than dead-clicking. While the room
    // is busy the label names the OUTCOME, which is the sentence that connects
    // the Expand/Sell rejects above to this gesture.
    // `room.closed` is tested FIRST and reopening is never disabled
    // (post-impl review MAJOR 1): a closed room still drains its actives, and
    // a draining treatment can break it — so closed AND broken is reachable.
    // Testing `broken` first rendered a dead, unexplained "Reopen"; disabling
    // it stranded the room permanently, since `setRoomClosed` now allows
    // reopening a broken room (harmless — capacity stays 0 until repair).
    this.closeButton.textContent = room.closed
      ? draining
        ? 'Reopen — still draining'
        : 'Reopen'
      : broken
        ? 'Close — Out of service — repair it first'
        : reservations.length > 0
          ? 'Close — stop new patients so it can drain'
          : 'Close';
    this.closeButton.disabled = broken && !room.closed;
  }
}
