import type { CommandQueue } from '../commands';
import type { EventBus } from '../events';
import { ROLE_DEFS } from '../sim/data/roles';
import type { World } from '../sim/world';

const MAX_SKILL = 5;

/** Hire/fire panel: candidate cards + current roster, all read from World (SSOT). */
export class HirePanel {
  private panel!: HTMLElement;
  private open = false;

  constructor(
    private world: World,
    private commands: CommandQueue,
    private events: EventBus,
  ) {}

  mount(parent: HTMLElement, toggleButton: HTMLButtonElement): void {
    this.panel = document.createElement('div');
    this.panel.id = 'hirepanel';
    this.panel.setAttribute('data-ui', '');
    this.panel.classList.add('hidden');
    parent.appendChild(this.panel);

    toggleButton.addEventListener('click', () => this.toggle(toggleButton));
    this.events.on('staffHired', () => this.render());
    this.events.on('staffFired', () => this.render());
    this.events.on('staffUpdated', () => this.render()); // deferred fire → "Leaving…"
  }

  private toggle(button: HTMLButtonElement): void {
    this.open = !this.open;
    this.panel.classList.toggle('hidden', !this.open);
    button.classList.toggle('active', this.open);
    if (this.open) this.render();
  }

  private static stars(skill: number): string {
    return '★'.repeat(skill) + '☆'.repeat(MAX_SKILL - skill);
  }

  private render(): void {
    if (!this.open) return;
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
    for (const candidate of this.world.candidates) {
      const row = document.createElement('div');
      row.className = 'person-row';
      const label = document.createElement('span');
      label.textContent = `${candidate.name.full}, ${candidate.age} — ${ROLE_DEFS[candidate.role].label} ${HirePanel.stars(candidate.skill)} $${candidate.salaryPerDay}/day`;
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
