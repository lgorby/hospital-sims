import { CommandQueue } from './commands';
import { EventBus } from './events';
import { GameLoop } from './loop';
import { WorldRenderer } from './render/renderer';
import { BuildMenu } from './ui/buildMenu';
import { DebugPanel } from './ui/debugPanel';
import { HirePanel } from './ui/hirePanel';
import { Hud } from './ui/hud';
import { InspectPanel } from './ui/inspect';
import { ThoughtLog } from './ui/thoughtLog';
import { Toasts } from './ui/toasts';
import { setupNewGame } from './sim/newGame';
import { World } from './sim/world';

async function bootstrap(): Promise<void> {
  const events = new EventBus();
  const commands = new CommandQueue();
  // Fixed seed for now — new-game flow (M4) will randomize and display it.
  const world = new World(events, 1337);
  setupNewGame(world);

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

  loop.start();
}

void bootstrap();
