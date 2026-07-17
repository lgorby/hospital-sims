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
import { ThoughtLog } from './ui/thoughtLog';
import { TitleScreen } from './ui/title';
import { Toasts } from './ui/toasts';
import { setupNewGame } from './sim/newGame';
import { World } from './sim/world';

// Seeds are 31-bit non-negative ints — comfortably URL- and rng-safe.
const SEED_LIMIT = 0x80000000;

/** New game = navigate to ?seed=<random>. A full reload is the teardown-free
 *  way to boot a fresh deterministic world (and makes runs shareable). */
function startNewGame(): void {
  const url = new URL(window.location.href);
  // Math.random is fine HERE (bootstrap layer): the seed is the boundary —
  // everything inside the sim draws from world.rng only.
  url.searchParams.set('seed', String(Math.floor(Math.random() * SEED_LIMIT)));
  window.location.assign(url.toString());
}

async function bootstrap(seed: number): Promise<void> {
  const events = new EventBus();
  const commands = new CommandQueue();
  const world = new World(events, seed);
  setupNewGame(world);

  const renderer = new WorldRenderer(world, commands, events);
  await renderer.init(document.getElementById('world')!);

  const loop = new GameLoop(world, commands, events, (alpha) => {
    renderer.draw(alpha);
    hud.update();
    inspect.update();
  });

  const hud = new Hud(world, loop, renderer, events, seed);
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

  loop.start();
}

const seedParam = new URLSearchParams(window.location.search).get('seed');
// Strict digits-only (M4 review #8): parseInt would silently boot '?seed=1e5'
// as seed 1, making the URL and the HUD chip disagree about the run's name.
if (seedParam !== null && /^\d{1,10}$/.test(seedParam)) {
  void bootstrap(Number.parseInt(seedParam, 10));
} else if (seedParam !== null) {
  startNewGame(); // malformed seed → roll a fresh one (writes a valid integer)
} else {
  new TitleScreen(startNewGame).mount(document.getElementById('ui')!);
}
