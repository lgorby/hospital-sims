import type { CommandQueue } from '../commands';
import type { EventBus } from '../events';
import { BALANCE } from '../sim/data/balance';
import { ROLE_DEFS, ROLE_IDS } from '../sim/data/roles';
import type { World } from '../sim/world';
import type { BottomBarDropdowns, DropdownHandle } from './bottomBar';

const MAX_SKILL = BALANCE.stats.max;

/**
 * Hire/fire panel: candidate cards + current roster, all read from World
 * (SSOT — whatever roles the tables contain is what renders). Candidates are
 * grouped under per-role headers so the 8-role roster scans cleanly; the
 * panel scrolls (max-height in ui.css). Open/close is coordinated by
 * BottomBarDropdowns (§9 mutual-exclusion ruling).
 */
export class HirePanel {
  private panel!: HTMLElement;
  private dropdown!: DropdownHandle;

  constructor(
    private world: World,
    private commands: CommandQueue,
    private events: EventBus,
    private bottomBar: BottomBarDropdowns,
  ) {}

  mount(parent: HTMLElement, toggleButton: HTMLButtonElement): void {
    this.panel = document.createElement('div');
    this.panel.id = 'hirepanel';
    this.panel.setAttribute('data-ui', '');
    this.panel.classList.add('hidden');
    parent.appendChild(this.panel);

    this.dropdown = this.bottomBar.register(toggleButton, this.panel, () => this.render());
    this.events.on('staffHired', () => this.render());
    this.events.on('staffFired', () => this.render());
    this.events.on('staffUpdated', () => this.render()); // deferred fire → "Leaving…"
  }

  private static stars(skill: number): string {
    return '★'.repeat(skill) + '☆'.repeat(MAX_SKILL - skill);
  }

  private render(): void {
    if (!this.dropdown.isOpen) return;
    this.panel.replaceChildren();

    const rosterTitle = document.createElement('h3');
    rosterTitle.textContent = 'Staff';
    this.panel.appendChild(rosterTitle);
    if (this.world.staff.size === 0) {
      const none = document.createElement('p');
      none.className = 'muted';
      none.textContent = 'No staff hired.';
      this.panel.appendChild(none);
    }
    for (const member of this.world.staff.values()) {
      const row = document.createElement('div');
      row.className = 'person-row';
      const label = document.createElement('span');
      label.textContent = `${member.name.full} — ${ROLE_DEFS[member.role].label} ${HirePanel.stars(member.skill)} $${member.salaryPerDay}/day`;
      const fire = document.createElement('button');
      fire.textContent = member.firing ? 'Leaving…' : 'Fire';
      fire.disabled = member.firing;
      fire.addEventListener('click', () => {
        this.commands.push({ type: 'fireStaff', staffId: member.id });
      });
      row.append(label, fire);
      this.panel.appendChild(row);
    }

    const candidatesTitle = document.createElement('h3');
    candidatesTitle.textContent = 'Candidates';
    this.panel.appendChild(candidatesTitle);
    // Grouped by role, in ROLE_IDS (table) order — data-driven: new roles in
    // the table appear here with zero UI changes. Empty pools render nothing.
    for (const role of ROLE_IDS) {
      const pool = this.world.candidates.filter((candidate) => candidate.role === role);
      if (pool.length === 0) continue;
      const head = document.createElement('div');
      head.className = 'role-head';
      head.textContent = ROLE_DEFS[role].label;
      this.panel.appendChild(head);
      for (const candidate of pool) {
        const row = document.createElement('div');
        row.className = 'person-row';
        const label = document.createElement('span');
        label.textContent = `${candidate.name.full}, ${candidate.age} — ${HirePanel.stars(candidate.skill)} $${candidate.salaryPerDay}/day`;
        const hire = document.createElement('button');
        hire.textContent = 'Hire';
        hire.addEventListener('click', () => {
          this.commands.push({ type: 'hireStaff', candidateId: candidate.id });
          // World replaces the candidate; staffHired re-renders.
        });
        row.append(label, hire);
        this.panel.appendChild(row);
      }
    }
  }
}
