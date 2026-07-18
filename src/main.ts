import { CommandQueue } from './commands';
import { EventBus } from './events';
import { GameLoop } from './loop';
import { WorldRenderer } from './render/renderer';
import { BlockedPanel } from './ui/blockedPanel';
import { BottomBarDropdowns } from './ui/bottomBar';
import { BuildMenu } from './ui/buildMenu';
import { ChallengeController } from './ui/challengeController';
import { ChallengeResultCard } from './ui/challengeResultCard';
import { Checklist } from './ui/checklist';
import { DailyReportModal } from './ui/dailyReport';
import { DebugPanel } from './ui/debugPanel';
import { DirectoryPanel } from './ui/directory';
import { GameOverScreen } from './ui/gameOver';
import { HirePanel } from './ui/hirePanel';
import { Hud } from './ui/hud';
import { InspectPanel } from './ui/inspect';
import { MidnightModalCoordinator } from './ui/midnightModal';
import { SaveLoadModal, installAutosave } from './ui/saveLoad';
import { isSlotName, readSlotRaw, slotLabel } from './ui/saveStore';
import { ThoughtLog } from './ui/thoughtLog';
import { TitleScreen } from './ui/title';
import { Toasts } from './ui/toasts';
import { clearBootParams, resolveBoot, SEED_MAX } from './sim/challenge';
import type { ChallengeSpec } from './sim/data/challenges';
import { setupNewGame } from './sim/newGame';
import { loadWorld } from './sim/save';
import { World } from './sim/world';

/** New game = navigate to ?seed=<random>. A full reload is the teardown-free
 *  way to boot a fresh deterministic world (and makes runs shareable). */
function startNewGame(): void {
  const url = new URL(window.location.href);
  // A fresh run must not re-load a save NOR re-enter a challenge — the scrub
  // list is grammar SSOT in challenge.ts (post-commit review MAJOR: leaving
  // `challenge`/`goal` here re-booted the same challenge from its game-over).
  clearBootParams(url.searchParams);
  // Math.random is fine HERE (bootstrap layer): the seed is the boundary —
  // everything inside the sim draws from world.rng only. SEED_MAX is the one
  // seed-bound SSOT (challenge.ts) — the roll and challenge seeds agree.
  url.searchParams.set('seed', String(Math.floor(Math.random() * SEED_MAX)));
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

/** How to obtain the World: a fresh run, a Phase-1 save, or a challenge run. */
type Boot =
  | { kind: 'new'; seed: number }
  | { kind: 'load'; raw: string }
  | { kind: 'challenge'; spec: ChallengeSpec };

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
  } else if (boot.kind === 'challenge') {
    // Challenge mode: a fresh deterministic run whose World rejects every
    // debug* command (plan §7). Seed lives inside the scenario.
    world = new World(events, boot.spec.scenario.seed, true);
    setupNewGame(world);
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
    blockedPanel.update();
    directory.update();
  });

  const hud = new Hud(world, loop, renderer, events);
  hud.mount(document.getElementById('hud')!, document.getElementById('readout')!);

  const uiRoot = document.getElementById('ui')!;
  // GDD §9 ruling: bottom-bar panels are mutually exclusive dropdowns — the
  // coordinator is shared so no panel needs to know about the others.
  const bottomBar = new BottomBarDropdowns();
  const buildMenu = new BuildMenu(renderer, commands, events, bottomBar, world, world.challengeMode);
  buildMenu.mount(uiRoot);
  const jump = (col: number, row: number): void => renderer.jumpTo(col, row);
  new Toasts(events, world, jump).mount(uiRoot);
  new HirePanel(world, commands, events, bottomBar).mount(uiRoot, buildMenu.staffButton);
  new ThoughtLog(events, jump, bottomBar).mount(uiRoot, document.getElementById('buildbar')!);
  // The hospital directory (owner ask 2026-07-18): the right-side inventory
  // pullout — rows jump the camera AND select, so the inspect card opens.
  const directory = new DirectoryPanel(world, events, jump, renderer);
  directory.mount(uiRoot, document.getElementById('buildbar')!, bottomBar);
  const inspect = new InspectPanel(world, commands, renderer);
  inspect.mount(uiRoot);
  // A challenge run is provably debug-free (plan §7): the World rejects debug*
  // commands, and the dev panel that would send them isn't even mounted, so a
  // stray backtick reveals nothing.
  if (boot.kind !== 'challenge') new DebugPanel(renderer, commands, world).mount(uiRoot);
  // Left column (HINTS_PLAN §2.3): one fixed flex stack owns top-left, so the
  // checklist and the blocked panel never overlap and re-flow on dismiss.
  const leftStack = document.createElement('div');
  leftStack.id = 'leftstack';
  uiRoot.appendChild(leftStack);
  new Checklist(world, events).mount(leftStack);
  const blockedPanel = new BlockedPanel(world, events);
  blockedPanel.mount(leftStack);

  // Midnight overlays (plan §6): the coordinator is the SINGLE `dayEnded`
  // owner — it opens the daily report OR (in a challenge, at goal.day) the
  // result card, never both. A challenge run also wires the controller + card.
  const coordinator = new MidnightModalCoordinator(events);
  const dailyReport = new DailyReportModal(loop, events);
  dailyReport.mount(uiRoot);
  coordinator.setDailyReport(dailyReport);

  let controller: ChallengeController | null = null;
  if (boot.kind === 'challenge') {
    controller = new ChallengeController(world, events, boot.spec);
    const resultCard = new ChallengeResultCard(loop, events);
    resultCard.mount(uiRoot);
    coordinator.setChallenge(controller, resultCard);
  }
  new GameOverScreen(loop, events, startNewGame, controller).mount(uiRoot);

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

// All boot-param grammar lives in `resolveBoot` (sim, pure + tested). main.ts
// only turns the decision into the right side effect. The `load` slot is
// validated + read HERE (localStorage is UI-side); everything else is decided.
const action = resolveBoot(new URLSearchParams(window.location.search));
switch (action.kind) {
  case 'load': {
    // ?load=<slot> — full-reload load flow (mirrors the ?seed= boot contract).
    if (!isSlotName(action.slot)) {
      showBootFailure(
        'This save could not be loaded',
        `"${action.slot}" is not a save slot (expected 1, 2, 3, or auto).`,
      );
      break;
    }
    const raw = readSlotRaw(action.slot);
    if (raw === null) {
      showBootFailure(
        'This save could not be loaded',
        `${slotLabel(action.slot)} is empty or unreadable in this browser. ` +
          'Saves live in browser storage — on a new machine, use Import on the title screen.',
      );
      break;
    }
    runBoot({ kind: 'load', raw });
    break;
  }
  case 'challenge':
    runBoot({ kind: 'challenge', spec: action.spec });
    break;
  case 'seed':
    runBoot({ kind: 'new', seed: action.seed });
    break;
  case 'failure':
    // A malformed challenge is a readable card, never a fresh roll (MAJOR-3).
    showBootFailure('This challenge could not start', action.reason);
    break;
  case 'title':
    new TitleScreen(startNewGame).mount(document.getElementById('ui')!);
    break;
}
