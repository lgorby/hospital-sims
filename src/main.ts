import { CommandQueue } from './commands';
import { EventBus } from './events';
import { GameLoop } from './loop';
import { WorldRenderer } from './render/renderer';
import { BuildMenu } from './ui/buildMenu';
import { Hud } from './ui/hud';
import { World } from './sim/world';

async function bootstrap(): Promise<void> {
  const events = new EventBus();
  const commands = new CommandQueue();
  // Fixed seed for now — new-game flow (M4) will randomize and display it.
  const world = new World(events, 1337);

  const renderer = new WorldRenderer(world, commands, events);
  await renderer.init(document.getElementById('world')!);

  const loop = new GameLoop(world, commands, events, (alpha) => {
    renderer.draw(alpha);
    hud.update();
  });

  const hud = new Hud(world, loop, renderer, events);
  hud.mount(document.getElementById('hud')!, document.getElementById('readout')!);

  const buildMenu = new BuildMenu(renderer, commands, events);
  buildMenu.mount(document.getElementById('ui')!);

  loop.start();
}

void bootstrap();
