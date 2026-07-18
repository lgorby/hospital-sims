import type { EventBus } from '../events';
import { ROLE_DEFS } from '../sim/data/roles';
import { ROOM_DEFS } from '../sim/data/rooms';
import { article } from '../sim/needs';
import type { World } from '../sim/world';

const DISMISS_DELAY_MS = 2500;

interface Item {
  label: string;
  done: boolean;
}

/**
 * Guided first-run checklist (GDD §9): replaces a tutorial. Items check off
 * as the events land — in any order — and the panel dismisses itself once
 * everything is done.
 */
export class Checklist {
  private panel!: HTMLElement;
  private list!: HTMLElement;
  // Labels compose from the defs (§3.1, M4 review #5) — renames stay in sync,
  // and `article` (needs.ts) keeps a/an correct across renames too.
  private items = new Map<string, Item>([
    ['triage', { label: `Build ${article(ROOM_DEFS.triage.label)} ${ROOM_DEFS.triage.label}`, done: false }],
    ['nurse', { label: `Hire ${article(ROLE_DEFS.nurse.label)} ${ROLE_DEFS.nurse.label}`, done: false }],
    ['exam', { label: `Build ${article(ROOM_DEFS.exam.label)} ${ROOM_DEFS.exam.label}`, done: false }],
    ['doctor', { label: `Hire ${article(ROLE_DEFS.doctor.label)} ${ROLE_DEFS.doctor.label}`, done: false }],
    ['treat', { label: 'Treat your first patient', done: false }],
  ]);

  constructor(
    private world: World,
    private events: EventBus,
  ) {}

  mount(parent: HTMLElement): void {
    // A loaded world arrives with progress: seed from state so a ?load= boot
    // never re-shows a completed tutorial. If there is nothing left to teach,
    // the panel never mounts at all.
    this.seedFromWorld();
    if ([...this.items.values()].every((i) => i.done)) return;

    this.panel = document.createElement('div');
    this.panel.id = 'checklist';
    this.panel.setAttribute('data-ui', '');
    const h = document.createElement('h3');
    h.textContent = 'Getting started';
    this.list = document.createElement('div');
    this.panel.append(h, this.list);
    parent.appendChild(this.panel);
    this.render();

    this.events.on('roomBuilt', ({ roomId }) => {
      const type = this.world.rooms.get(roomId)?.type;
      if (type === 'triage') this.complete('triage');
      if (type === 'exam') this.complete('exam');
    });
    this.events.on('staffHired', ({ staffId }) => {
      const role = this.world.staff.get(staffId)?.role;
      if (role === 'nurse') this.complete('nurse');
      if (role === 'doctor') this.complete('doctor');
    });
    // First TREATMENT fee = first successfully treated step (triage is
    // free). Source-gated: vending revenue rides the same billFee choke
    // point, and a $5 soda must not check off "treat your first patient"
    // (Stage-1 live-drive review MAJOR 1).
    this.events.on('feeBilled', ({ source }) => {
      if (source === 'treatment') this.complete('treat');
    });
  }

  /** Mirror of the live-event conditions, evaluated against current World state. */
  private seedFromWorld(): void {
    const roles = new Set([...this.world.staff.values()].map((s) => s.role));
    const seeded: Record<string, boolean> = {
      triage: this.world.roomsOfType('triage').length > 0,
      exam: this.world.roomsOfType('exam').length > 0,
      nurse: roles.has('nurse'),
      doctor: roles.has('doctor'),
      // Same signal as the live feeBilled path: any billed treatment counts.
      treat: this.world.lifetimeTreated > 0,
    };
    for (const [key, done] of Object.entries(seeded)) {
      if (done) this.items.get(key)!.done = true;
    }
  }

  private complete(key: string): void {
    const item = this.items.get(key);
    if (!item || item.done) return;
    item.done = true;
    this.render();
    if ([...this.items.values()].every((i) => i.done)) {
      this.panel.classList.add('done');
      window.setTimeout(() => this.panel.remove(), DISMISS_DELAY_MS);
    }
  }

  private render(): void {
    this.list.replaceChildren();
    for (const item of this.items.values()) {
      const row = document.createElement('div');
      row.className = item.done ? 'check-item checked' : 'check-item';
      row.textContent = `${item.done ? '☑' : '☐'} ${item.label}`;
      this.list.appendChild(row);
    }
  }
}
