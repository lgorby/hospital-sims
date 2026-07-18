import type { CommandQueue } from '../commands';
import type { WorldRenderer, Selection } from '../render/renderer';
import { validateRoomSell } from '../sim/build';
import { AMENITY_DEFS, type AmenityId } from '../sim/data/amenities';
import { CONDITION_DEFS } from '../sim/data/conditions';
import { ROOM_DEFS } from '../sim/data/rooms';
import { ROLE_DEFS } from '../sim/data/roles';
import { BALANCE } from '../sim/data/balance';
import { amenitySellback, moodOf, sellbackAmount } from '../sim/formulas';
import type { PatientStage } from '../sim/entities/patient';
import type { Reservation, StaffDuty } from '../sim/entities/staff';
import type { World } from '../sim/world';
import { patientStageLabel, staffDutyLabel } from './format';

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
    this.actionButton = document.createElement('button');
    this.actionButton.className = 'inspect-action';
    this.actionButton.setAttribute('data-ui', '');

    this.panel.append(header, this.body, this.expandButton, this.actionButton);
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
      this.body.innerHTML =
        `<div class="inspect-name">${esc(s.name.full)}, ${s.age}</div>` +
        this.line('Role', ROLE_DEFS[s.role].label) +
        this.line('Skill', stars) +
        this.line('Salary', `$${s.salaryPerDay}/day`) +
        this.line(
          'Duty',
          // Stage 2: job duties resolve their kind from world.jobs so the line
          // reads "Cleaning" / "Emptying a trashcan"; the frozen format.ts
          // fallback covers a job deleted mid-frame (S2.1 freeze). Stage-3
          // live-drive MINOR 2: the PHASE splits en-route from at-work, so a
          // walking tech reads "Heading to a repair", not "Repairing".
          staffDutyLabel(
            s.duty,
            this.reservationPhase(s.duty),
            s.duty.kind === 'job' ? this.world.jobs.get(s.duty.jobId)?.kind : undefined,
            s.duty.kind === 'job' ? this.world.jobs.get(s.duty.jobId)?.phase : undefined,
          ) + (s.firing ? ' (leaving after this patient)' : ''),
        );
      return;
    }
    if (selection.kind === 'amenity') {
      const amenity = this.world.amenityAt(selection.col, selection.row)!;
      const def = AMENITY_DEFS[amenity.kind];
      // What it does (§3.4): vending's price is the billFee SSOT number; the
      // plant aura radius comes from the same table refreshAuras reads; the
      // trashcan is pure flavor until Stage-2 messes give it a job.
      const effectLine: Record<AmenityId, string> = {
        vending: this.line('Drinks', `$${BALANCE.needs.vendingPrice} per use`),
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
    // "In use" lists only USING claimants; walkers still crossing the map
    // read "on the way" (live-drive review MINOR 3 — the flat list overstated
    // occupancy while a claimant was three corridors away).
    const claimName = (id: number): string | undefined => this.world.patients.get(id)?.name.short;
    const occupant = stallClaims
      ? [...stallClaims.values()]
          .map((id) => {
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
    const statusLine = broken
      ? this.line('Status', `OUT OF SERVICE — repair ${repairUnderway ? 'underway' : 'pending'}`)
      : '';
    const capRule = def.capacity;
    let capacityLine = '';
    // While broken the status line REPLACES the perProp capacity readout —
    // capacityOf reads 0, and "Stalls 1/0" is exactly the confusion §5.2
    // forbids. Single-capacity rooms render no capacity line to replace
    // (pre-impl MINOR 4) — they just gain the status line. The restroom's
    // "In use" line below keeps rendering while broken: in-flight claimants
    // legitimately finish (deliberate, §S3.6).
    if (capRule.kind === 'perProp' && !broken) {
      const total = this.world.capacityOf(room);
      const used = stallClaims
        ? stallClaims.size
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
    this.body.innerHTML =
      `<div class="inspect-name">${esc(def.label)}</div>` +
      this.line('Size', `${room.rect.cols}×${room.rect.rows}`) +
      this.line('Quality', `+${room.quality}`) +
      statusLine +
      capacityLine +
      (runBy ? this.line('Run by', runBy) : '') +
      (hasPost ? this.line('Posted', posted.map((s) => s.name.short).join(', ') || '—') : '') +
      // "Treating" would be dishonest for a self-service room (§3.3).
      this.line(stallClaims ? 'In use' : 'Treating', occupant);
    // sellbackAmount is the sim's payout AND this label (SSOT audit #2);
    // rect-aware since Stage 0 (an oversized room refunds its sized price).
    const refund = sellbackAmount(room.type, room.rect);
    this.actionButton.textContent = sellCheck.ok
      ? `Sell (+$${refund.toLocaleString()})`
      : `Sell — ${sellCheck.reason}`;
    this.actionButton.disabled = !sellCheck.ok;
    // Stage 3: never invite a dead click — the sim rejects expanding a broken
    // room (validateRoomExpand: 'Out of service — repair it first'); mirror
    // the Sell reject idiom above. Re-set EVERY frame, not in wireAction —
    // repair completion must re-enable the button without a re-selection.
    this.expandButton.textContent = broken ? 'Expand — Out of service — repair it first' : 'Expand';
    this.expandButton.disabled = broken;
  }
}
