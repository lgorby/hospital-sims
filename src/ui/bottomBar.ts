import { isModalOpen, isTextEditable } from './dom';

/** What a registered panel gets back: enough to close itself or ask if it's open. */
export interface DropdownHandle {
  readonly isOpen: boolean;
  close(): void;
}

interface Entry {
  button: HTMLButtonElement;
  panel: HTMLElement;
  open: boolean;
  onOpen?: () => void;
}

/**
 * Bottom-bar dropdown coordinator (GDD §9 owner ruling, 2026-07-17): the
 * build catalog's category dropdowns, the hire panel, and the thought log are
 * MUTUALLY EXCLUSIVE — opening any one closes the others; they never overlap.
 * Panels register here instead of knowing about each other.
 *
 * Conventions (unchanged from pre-expansion behavior):
 * - a panel's toggle button toggles it; the click drops focus so keyboard
 *   shortcuts (Space, digits, camera pan) stay on the game;
 * - clicking the world does NOT dismiss panels — canvas clicks are gameplay
 *   (build placement, entity selection), not dismissal;
 * - Esc closes whatever is open (alongside the renderer's mode cancel), but a
 *   visible modal owns the keyboard (M4 review #3 pattern).
 */
export class BottomBarDropdowns {
  private entries: Entry[] = [];

  constructor() {
    // Capture phase + consuming the event only when a panel actually closed:
    // Esc peels one layer at a time (M4 ruling) — first press closes the open
    // dropdown, the next reaches the renderer's cancel-mode listener. With
    // nothing open the event passes through untouched.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || isTextEditable(e.target) || isModalOpen()) return;
        if (!this.entries.some((entry) => entry.open)) return;
        this.closeAll();
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      { capture: true },
    );
  }

  /**
   * Wire a toggle button to a panel (panel starts closed with class
   * `hidden`). The open state is mirrored onto the button as class `open`.
   */
  register(
    button: HTMLButtonElement,
    panel: HTMLElement,
    onOpen?: () => void,
  ): DropdownHandle {
    const entry: Entry = { button, panel, open: false, onOpen };
    this.entries.push(entry);
    button.addEventListener('click', () => {
      this.setOpen(entry, !entry.open);
      button.blur();
    });
    return {
      get isOpen(): boolean {
        return entry.open;
      },
      close: () => this.setOpen(entry, false),
    };
  }

  /** Close every registered dropdown (Esc, or a tool pick dismissing the catalog). */
  closeAll(): void {
    for (const entry of this.entries) this.setOpen(entry, false);
  }

  private setOpen(entry: Entry, open: boolean): void {
    if (entry.open === open) return;
    if (open) {
      // Mutual exclusion — the one place that enforces the §9 ruling.
      for (const other of this.entries) {
        if (other !== entry) this.setOpen(other, false);
      }
    }
    entry.open = open;
    entry.panel.classList.toggle('hidden', !open);
    entry.button.classList.toggle('open', open);
    if (open) entry.onOpen?.();
  }
}
