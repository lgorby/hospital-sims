import { CommandQueue } from './commands';
import { EventBus } from './events';
import { GameLoop } from './loop';
import { WorldRenderer } from './render/renderer';
import { BuildMenu } from './ui/buildMenu';
import { Checklist } from './ui/checklist';
import { DailyReportModal } from './ui/dailyReport';
import { DebugPanel } from './ui/debugPanel';
import { GameOverScreen } from './ui/gameOver';
import { HirePanel } from './ui/hirePanel';
import { Hud } from './ui/hud';
import { InspectPanel } from './ui/inspect';
import { SaveLoadModal, installAutosave } from './ui/saveLoad';
import { isSlotName, readSlotRaw, slotLabel } from './ui/saveStore';
import { ThoughtLog } from './ui/thoughtLog';
import { TitleScreen } from './ui/title';
import { Toasts } from './ui/toasts';
import { setupNewGame } from './sim/newGame';
import { loadWorld } from './sim/save';
import { World } from './sim/world';

// Seeds are 31-bit non-negative ints — comfortably URL- and rng-safe.
const SEED_LIMIT = 0x80000000;

/** New game = navigate to ?seed=<random>. A full reload is the teardown-free
 *  way to boot a fresh deterministic world (and makes runs shareable). */
function startNewGame(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('load'); // a fresh run must not re-load a save
  // Math.random is fine HERE (bootstrap layer): the seed is the boundary —
  // everything inside the sim draws from world.rng only.
  url.searchParams.set('seed', String(Math.floor(Math.random() * SEED_LIMIT)));
  window.location.assign(url.toString());
}

/** Readable bootstrap failure (audit #3 pattern) — a card beats a blank page. */
function showBootFailure(title: string, message: string): void {
  const failure = document.createElement('div');
  failure.className = 'modal-overlay';
  failure.setAttribute('data-ui', '');
  const card = document.createElement('div');
  card.className = 'modal-card';
  const h2 = document.createElement('h2');
  h2.textContent = title;
  const p = document.createElement('p');
  p.textContent = message;
  const back = document.createElement('button');
  back.textContent = 'Back to title';
  back.className = 'modal-continue';
  back.setAttribute('data-ui', '');
  back.addEventListener('click', () => window.location.assign(window.location.pathname));
  card.append(h2, p, back);
  failure.appendChild(card);
  document.getElementById('ui')!.appendChild(failure);
}

/** How to obtain the World: a fresh deterministic run, or a Phase-1 save string. */
type Boot = { kind: 'new'; seed: number } | { kind: 'load'; raw: string };

async function bootstrap(boot: Boot): Promise<void> {
  const events = new EventBus();
  const commands = new CommandQueue();

  // World construction is decided here; everything below is shared wiring.
  let world: World;
  if (boot.kind === 'load') {
    const result = loadWorld(events, boot.raw);
    if (!result.ok) {
      showBootFailure(
        'This save could not be loaded',
        `The save data was rejected: ${result.reason}`,
      );
      return;
    }
    world = result.world;
  } else {
    world = new World(events, boot.seed);
    setupNewGame(world);
  }

  const renderer = new WorldRenderer(world, commands, events);
  await renderer.init(document.getElementById('world')!);

  const loop = new GameLoop(world, commands, events, (alpha) => {
    renderer.draw(alpha);
    hud.update();
    inspect.update();
  });

  const hud = new Hud(world, loop, renderer, events);
  hud.mount(document.getElementById('hud')!, document.getElementById('readout')!);

  const uiRoot = document.getElementById('ui')!;
  const buildMenu = new BuildMenu(renderer, commands, events);
  buildMenu.mount(uiRoot);
  const jump = (col: number, row: number): void => renderer.jumpTo(col, row);
  new Toasts(events, world, jump).mount(uiRoot);
  new HirePanel(world, commands, events).mount(uiRoot, buildMenu.staffButton);
  new ThoughtLog(events, jump).mount(uiRoot, document.getElementById('buildbar')!);
  const inspect = new InspectPanel(world, commands, renderer);
  inspect.mount(uiRoot);
  new DebugPanel(renderer, commands).mount(uiRoot);
  new Checklist(world, events).mount(uiRoot);
  new DailyReportModal(loop, events).mount(uiRoot);
  new GameOverScreen(loop, events, startNewGame).mount(uiRoot);

  // Phase-1 persistence: the save/load modal (HUD button opens it) and the
  // UI-side autosave subscriber (sim never touches localStorage).
  const saveLoad = new SaveLoadModal({ world, loop });
  saveLoad.mount(uiRoot);
  saveLoad.mountButton(document.getElementById('hud')!);
  installAutosave(events, world);

  loop.start();
}

/** Renderer init can reject on machines without WebGL — surface it readably. */
function runBoot(boot: Boot): void {
  bootstrap(boot).catch((error: unknown) => {
    showBootFailure(
      'Hospital Simms could not start',
      `Renderer initialization failed (${error instanceof Error ? error.message : String(error)}). ` +
        'A browser with WebGL support is required.',
    );
  });
}

const params = new URLSearchParams(window.location.search);
const loadParam = params.get('load');
const seedParam = params.get('seed');

if (loadParam !== null) {
  // ?load=<slot> — full-reload load flow (mirrors the ?seed= boot contract).
  if (!isSlotName(loadParam)) {
    showBootFailure(
      'This save could not be loaded',
      `"${loadParam}" is not a save slot (expected 1, 2, 3, or auto).`,
    );
  } else {
    const raw = readSlotRaw(loadParam);
    if (raw === null) {
      showBootFailure(
        'This save could not be loaded',
        `${slotLabel(loadParam)} is empty or unreadable in this browser. ` +
          'Saves live in browser storage — on a new machine, use Import on the title screen.',
      );
    } else {
      runBoot({ kind: 'load', raw });
    }
  }
} else if (seedParam !== null && /^\d{1,10}$/.test(seedParam)) {
  // Strict digits-only (M4 review #8): parseInt would silently boot '?seed=1e5'
  // as seed 1, making the URL and the HUD chip disagree about the run's name.
  runBoot({ kind: 'new', seed: Number.parseInt(seedParam, 10) });
} else if (seedParam !== null) {
  startNewGame(); // malformed seed → roll a fresh one (writes a valid integer)
} else {
  new TitleScreen(startNewGame).mount(document.getElementById('ui')!);
}
