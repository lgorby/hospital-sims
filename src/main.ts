import { CommandQueue } from './commands';
import { EventBus } from './events';
import { GameLoop } from './loop';
import { WorldRenderer } from './render/renderer';
import { BuildMenu } from './ui/buildMenu';
import { DebugPanel } from './ui/debugPanel';
import { HirePanel } from './ui/hirePanel';
import { Hud } from './ui/hud';
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
  });

  const hud = new Hud(world, loop, renderer, events);
  hud.mount(document.getElementById('hud')!, document.getElementById('readout')!);

  const uiRoot = document.getElementById('ui')!;
  const buildMenu = new BuildMenu(renderer, commands, events);
  buildMenu.mount(uiRoot);
  new Toasts(events).mount(uiRoot);
  new HirePanel(world, commands, events).mount(uiRoot, buildMenu.staffButton);
  new DebugPanel(renderer, commands).mount(uiRoot);

  loop.start();
}

void bootstrap();
