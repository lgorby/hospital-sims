import type { EventBus } from '../events';
import type { GameLoop, Speed } from '../loop';
import { saveToString } from '../sim/save';
import type { World } from '../sim/world';
import { money } from './format';
import {
  AUTO_SLOT,
  MANUAL_SLOTS,
  SLOTS,
  deleteSlot,
  navigateToLoad,
  readAllMeta,
  readSlotRaw,
  slotLabel,
  validateSaveString,
  writeSlot,
  type SlotName,
} from './saveStore';

const PAUSED: Speed = 0;
const EXPORT_FILENAME = 'hospital-simms-save.json';
/** Revoke the download's object URL after the browser has started the fetch. */
const OBJECT_URL_REVOKE_DELAY_MS = 10_000;
/** Real saves are tens of KB — refuse absurd files before JSON.parse chokes. */
const IMPORT_SIZE_LIMIT_BYTES = 20_000_000;
/** An armed "Really delete?" button disarms itself after this long. */
const DELETE_CONFIRM_RESET_MS = 4000;

/** Present in-game; null on the title screen (load-only mode — no Save buttons). */
export interface GameContext {
  world: World;
  loop: GameLoop;
}

/**
 * Save/Load modal (Phase-1 persistence). Follows the DailyReportModal pattern:
 * a `.modal-overlay` with `data-ui` (which makes the existing HUD keyboard
 * suppression apply — "a visible .modal-overlay owns the clock"), pausing the
 * loop while open and restoring the previous speed on close.
 *
 * Import/export are the whole PC-to-PC story (plan rule 5): export downloads a
 * slot's raw contract JSON; import accepts a picked or dropped .json file.
 */
export class SaveLoadModal {
  private overlay!: HTMLElement;
  private card!: HTMLElement;
  private slotsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private fileInput!: HTMLInputElement;
  private resumeSpeed: Speed = PAUSED;
  /** Invoked after the modal hides — the title screen re-renders its buttons
   *  so imports/deletes made in here are reflected immediately. */
  onClose: (() => void) | null = null;

  constructor(private game: GameContext | null) {}

  mount(parent: HTMLElement): void {
    this.overlay = document.createElement('div');
    this.overlay.id = 'saveload';
    this.overlay.className = 'modal-overlay hidden';
    this.overlay.setAttribute('data-ui', '');

    this.card = document.createElement('div');
    this.card.className = 'modal-card saveload-card';

    const title = document.createElement('h2');
    title.textContent = this.game ? 'Save / Load' : 'Load Game';
    this.card.appendChild(title);

    this.slotsEl = document.createElement('div');
    this.slotsEl.className = 'saveload-slots';
    this.card.appendChild(this.slotsEl);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'saveload-status';
    this.card.appendChild(this.statusEl);

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'application/json,.json';
    this.fileInput.style.display = 'none';
    this.fileInput.setAttribute('data-ui', '');
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      // Reset so re-picking the same file fires `change` again.
      this.fileInput.value = '';
      if (file) this.importFile(file);
    });
    this.card.appendChild(this.fileInput);

    const importRow = document.createElement('div');
    importRow.className = 'saveload-import-row';
    const importButton = document.createElement('button');
    importButton.textContent = 'Import save file…';
    importButton.setAttribute('data-ui', '');
    importButton.addEventListener('click', () => this.fileInput.click());
    importRow.appendChild(importButton);
    this.card.appendChild(importRow);

    const dropHint = document.createElement('div');
    dropHint.className = 'saveload-drophint';
    dropHint.textContent = 'or drop a hospital-simms-save.json here';
    this.card.appendChild(dropHint);

    // Mid-game exit path (owner ask: "once a game is started, how does the
    // user start a new game?" — there was NO in-game route to the title).
    // Only in the in-game modal (`this.game`); the title's load-only modal
    // doesn't need it. Passing through this modal nudges a save on the way
    // out; the bare-origin navigation lands on the title screen (New Game /
    // Continue / Challenges live there).
    if (this.game) {
      const quit = document.createElement('button');
      quit.textContent = 'Quit to Title';
      quit.className = 'title-alt saveload-quit';
      quit.setAttribute('data-ui', '');
      // Two-step arm (pre-push review MINOR): the ONLY autosave is midnight's,
      // so one stray click could discard most of a day — same guard pattern as
      // the slot Delete button beside it.
      let armed = false;
      quit.addEventListener('click', () => {
        if (!armed) {
          armed = true;
          quit.textContent = 'Really quit? Unsaved progress is lost';
          return;
        }
        window.location.assign(window.location.pathname);
      });
      this.card.appendChild(quit);
    }

    const closeButton = document.createElement('button');
    closeButton.textContent = 'Close';
    closeButton.className = 'modal-continue';
    closeButton.setAttribute('data-ui', '');
    closeButton.addEventListener('click', () => this.close());
    this.card.appendChild(closeButton);

    // The browser default for a dropped file is "navigate to it" — which
    // would replace the running game with raw JSON. Guard at window level so
    // a drop while the modal is CLOSED (title screen, mid-game) is inert, and
    // route a drop while it's open into the import path.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      this.card.classList.remove('dragover');
      if (this.overlay.classList.contains('hidden')) return;
      const file = e.dataTransfer?.files[0];
      if (file) this.importFile(file);
      else this.setStatus('Nothing droppable there — drop a .json save file.');
    });
    // Highlight while a drag hovers the open modal. `dragleave` also fires
    // when entering a child element — only clear when truly leaving.
    this.overlay.addEventListener('dragover', () => this.card.classList.add('dragover'));
    this.overlay.addEventListener('dragleave', (e) => {
      const to = e.relatedTarget;
      if (!(to instanceof Node) || !this.overlay.contains(to)) {
        this.card.classList.remove('dragover');
      }
    });

    this.overlay.appendChild(this.card);
    parent.appendChild(this.overlay);
  }

  /** HUD entry point: a button (BuildMenu/Hud styling conventions) that opens the modal. */
  mountButton(parent: HTMLElement): void {
    const button = document.createElement('button');
    button.textContent = 'Save / Load';
    button.className = 'hud-button';
    button.setAttribute('data-ui', '');
    button.addEventListener('click', () => {
      this.open();
      button.blur();
    });
    parent.appendChild(button);
  }

  open(): void {
    if (!this.overlay.classList.contains('hidden')) return;
    if (this.game) {
      // Same clock-ownership contract as the daily report: remember the speed,
      // pause while the modal is up, restore on close (0 stays 0 — a modal
      // opened while paused must not unpause on close).
      this.resumeSpeed = this.game.loop.speed;
      this.game.loop.setSpeed(PAUSED);
    }
    this.setStatus('');
    this.renderSlots();
    this.overlay.classList.remove('hidden');
  }

  close(): void {
    if (this.overlay.classList.contains('hidden')) return;
    this.overlay.classList.add('hidden');
    if (this.game) this.game.loop.setSpeed(this.resumeSpeed);
    this.onClose?.();
  }

  private renderSlots(): void {
    this.slotsEl.replaceChildren();
    const meta = readAllMeta();
    for (const slot of SLOTS) {
      const occupied = readSlotRaw(slot) !== null;
      const row = document.createElement('div');
      row.className = 'save-slot';

      const info = document.createElement('div');
      info.className = 'slot-info';
      const name = document.createElement('div');
      name.className = 'slot-name';
      name.textContent = slotLabel(slot);
      const detail = document.createElement('div');
      detail.className = 'slot-meta';
      if (occupied) {
        const m = meta[slot];
        const parts: string[] = [];
        if (m?.day != null) parts.push(`Day ${m.day}`);
        if (m?.cash != null) parts.push(money(m.cash));
        if (m?.seed != null) parts.push(`seed ${m.seed}`);
        parts.push(m ? new Date(m.savedAt).toLocaleString() : 'details unavailable');
        detail.textContent = parts.join(' · ');
      } else {
        detail.textContent = 'Empty';
        detail.classList.add('empty');
      }
      info.append(name, detail);
      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'slot-actions';
      if (this.game && slot !== AUTO_SLOT) {
        const save = this.actionButton(actions, 'Save', () => this.saveTo(slot));
        // A frozen (foreclosed) world is not worth snapshotting.
        if (this.game.world.gameOver) save.disabled = true;
      }
      if (occupied) {
        this.actionButton(actions, 'Load', () => navigateToLoad(slot));
        this.actionButton(actions, 'Export', () => this.exportSlot(slot));
        this.mountDeleteButton(actions, slot);
      }
      row.appendChild(actions);
      this.slotsEl.appendChild(row);
    }
  }

  /**
   * Two-step inline delete (review finding: one-click irreversible next to
   * Export): first click arms the button ("Really delete?"), a second click
   * within the window deletes; the arm times out back to normal. The result
   * is verified — a storage layer that refuses to remove surfaces as a
   * readable failure instead of being swallowed.
   */
  private mountDeleteButton(parent: HTMLElement, slot: SlotName): void {
    let armed = false;
    let resetTimer = 0;
    const disarm = (): void => {
      armed = false;
      window.clearTimeout(resetTimer);
      button.textContent = 'Delete';
      button.classList.remove('confirm');
    };
    const button = this.actionButton(parent, 'Delete', () => {
      if (!armed) {
        armed = true;
        button.textContent = 'Really delete?';
        button.classList.add('confirm');
        resetTimer = window.setTimeout(disarm, DELETE_CONFIRM_RESET_MS);
        return;
      }
      disarm();
      deleteSlot(slot);
      const gone = readSlotRaw(slot) === null;
      this.setStatus(
        gone
          ? `${slotLabel(slot)} deleted.`
          : `Delete failed: browser storage refused to remove ${slotLabel(slot)}.`,
      );
      this.renderSlots();
    });
    button.classList.add('danger');
  }

  private actionButton(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.textContent = label;
    button.setAttribute('data-ui', '');
    button.addEventListener('click', onClick);
    parent.appendChild(button);
    return button;
  }

  private saveTo(slot: SlotName): void {
    if (!this.game) return;
    let raw: string;
    try {
      raw = saveToString(this.game.world);
    } catch (error) {
      this.setStatus(
        `Save failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const result = writeSlot(slot, raw);
    this.setStatus(result.ok ? `Saved to ${slotLabel(slot)}.` : `Save failed: ${result.reason}`);
    this.renderSlots();
  }

  /** Download the slot's raw contract JSON via Blob + temporary anchor. */
  private exportSlot(slot: SlotName): void {
    const raw = readSlotRaw(slot);
    if (raw === null) {
      this.setStatus(`${slotLabel(slot)} is empty — nothing to export.`);
      return;
    }
    const blob = new Blob([raw], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = EXPORT_FILENAME;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOKE_DELAY_MS);
    this.setStatus(`Exported ${slotLabel(slot)} as ${EXPORT_FILENAME}.`);
  }

  private importFile(file: File): void {
    if (file.size > IMPORT_SIZE_LIMIT_BYTES) {
      this.setStatus('Import failed: that file is far too large to be a save.');
      return;
    }
    file
      .text()
      .then((text) => {
        const check = validateSaveString(text);
        if (!check.ok) {
          this.setStatus(`Import failed: ${check.reason}.`);
          return;
        }
        const slot = this.pickImportSlot();
        if (slot === null) {
          this.setStatus('All save slots are full — delete one first, then import again.');
          return;
        }
        const result = writeSlot(slot, text);
        if (!result.ok) {
          this.setStatus(`Import failed: ${result.reason}`);
          return;
        }
        this.renderSlots();
        this.setStatus(`Imported into ${slotLabel(slot)} — press its Load button to play.`);
      })
      .catch((error: unknown) => {
        this.setStatus(
          `Import failed: could not read the file (${error instanceof Error ? error.message : String(error)}).`,
        );
      });
  }

  /** First empty manual slot; null when all are full — import never silently
   *  overwrites an existing save (review finding: destructive by surprise). */
  private pickImportSlot(): SlotName | null {
    for (const slot of MANUAL_SLOTS) {
      if (readSlotRaw(slot) === null) return slot;
    }
    return null;
  }

  private setStatus(message: string): void {
    this.statusEl.textContent = message;
  }
}

/**
 * Autosave: UI-side subscriber (the sim must never touch localStorage) that
 * snapshots into the 'auto' slot at each day close. A failed autosave surfaces
 * as a hint toast and must never break the day-report flow — the EventBus
 * already isolates handlers, and this wraps anyway.
 */
export function installAutosave(events: EventBus, world: World): void {
  // A challenge run never autosaves (post-commit review): it would clobber the
  // player's sandbox auto slot with a world that reloads as a spec-less normal
  // run (challengeMode is deliberately unsaved). Manual saves stay available.
  if (world.challengeMode) return;
  events.on('dayEnded', () => {
    if (world.gameOver) return;
    try {
      const result = writeSlot(AUTO_SLOT, saveToString(world));
      if (!result.ok) events.emit('hint', { message: `Autosave failed: ${result.reason}` });
    } catch (error) {
      console.warn('Autosave failed:', error);
      events.emit('hint', {
        message: `Autosave failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}
