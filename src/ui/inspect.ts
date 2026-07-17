import type { CommandQueue } from '../commands';
import type { WorldRenderer, Selection } from '../render/renderer';
import { validateRoomSell } from '../sim/build';
import { CONDITION_DEFS } from '../sim/data/conditions';
import { ROOM_DEFS } from '../sim/data/rooms';
import { ROLE_DEFS } from '../sim/data/roles';
import { BALANCE } from '../sim/data/balance';
import { moodOf } from '../sim/formulas';
import type { World } from '../sim/world';

const PERCENT_MAX = 100;
const MAX_SKILL_STARS = 5;

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
    this.actionButton = document.createElement('button');
    this.actionButton.className = 'inspect-action';
    this.actionButton.setAttribute('data-ui', '');

    this.panel.append(header, this.body, this.actionButton);
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
    const key = `${selection.kind}:${selection.id}`;
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.wireAction(selection);
    }
    this.renderBody(selection);
  }

  private stillExists(selection: Selection): boolean {
    if (selection.kind === 'patient') return this.world.patients.has(selection.id);
    if (selection.kind === 'staff') return this.world.staff.has(selection.id);
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
    } else {
      fresh.style.display = 'none';
    }
  }

  private line(label: string, value: string): string {
    return `<div class="inspect-row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
  }

  private bar(label: string, value: number, color: string): string {
    const pct = Math.max(0, Math.min(PERCENT_MAX, value));
    return (
      `<div class="inspect-row"><span>${label}</span>` +
      `<span class="bar"><span style="width:${pct.toFixed(0)}%;background:${color}"></span></span>` +
      `<span class="bar-num">${Math.ceil(pct)}</span></div>`
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
        this.line('State', p.stage.kind) +
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
        this.line('Duty', s.duty.kind + (s.firing ? ' (leaving after this patient)' : ''));
      return;
    }
    const room = this.world.rooms.get(selection.id)!;
    const def = ROOM_DEFS[room.type];
    const sellCheck = validateRoomSell(this.world, room.id);
    const posted = [...this.world.staff.values()].filter(
      (s) => s.duty.kind === 'post' && s.duty.roomId === room.id,
    );
    const reservation = [...this.world.reservations.values()].find((r) => r.roomId === room.id);
    const occupant =
      reservation === undefined
        ? '—'
        : (this.world.patients.get(reservation.patientId)?.name.short ?? '—');
    this.body.innerHTML =
      `<div class="inspect-name">${esc(def.label)}</div>` +
      this.line('Size', `${room.rect.cols}×${room.rect.rows}`) +
      this.line('Quality', `+${room.quality}`) +
      this.line('Staffed by', posted.map((s) => s.name.short).join(', ') || '—') +
      this.line('Treating', occupant);
    const refund = Math.floor(def.cost * BALANCE.economy.roomSellbackRatio);
    this.actionButton.textContent = sellCheck.ok
      ? `Sell (+$${refund.toLocaleString()})`
      : `Sell — ${sellCheck.reason}`;
    this.actionButton.disabled = !sellCheck.ok;
  }
}
