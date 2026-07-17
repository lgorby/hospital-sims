import type { CommandQueue } from './commands';
import type { EventBus, Speed } from './events';
import { BALANCE } from './sim/data/balance';
import type { World } from './sim/world';

export type { Speed } from './events';

const TICK_MS = 1000 / BALANCE.time.ticksPerSecond;
/** Spiral-of-death guard: never run more than this many ticks in one frame. */
const MAX_TICKS_PER_FRAME = 10;

/** Browser services the loop needs — injectable so tests can drive frames by hand. */
export interface LoopHost {
  requestFrame(callback: (now: number) => void): void;
  onVisibilityChange(callback: () => void): void;
  isHidden(): boolean;
}

const browserHost: LoopHost = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  onVisibilityChange: (callback) => document.addEventListener('visibilitychange', callback),
  isHidden: () => document.hidden,
};

/**
 * Fixed-timestep accumulator loop (tech plan §2.1). Speed lives HERE, not in
 * the sim — and commands apply every frame even at speed 0, so the player can
 * build/hire while paused and always unpause.
 */
export class GameLoop {
  private speedValue: Speed = 1;
  private speedBeforeBlur: Speed | null = null;
  private accumulator = 0;
  private lastTime: number | null = null;
  private running = false;

  constructor(
    private world: World,
    private commands: CommandQueue,
    private events: EventBus,
    private render: (alpha: number) => void,
    private host: LoopHost = browserHost,
  ) {
    // Auto-pause on tab blur: a throttled rAF must not cause a catch-up burst
    // or a silent multi-day skip (tech plan §2.1).
    host.onVisibilityChange(() => {
      if (host.isHidden()) {
        if (this.speedValue !== 0) {
          this.speedBeforeBlur = this.speedValue;
          this.setSpeed(0);
        }
      } else {
        // Reset the frame timer FIRST so the hidden duration never enters the
        // accumulator — restoring speed before the next frame would otherwise
        // replay the whole absence as one giant delta.
        this.lastTime = null;
        if (this.speedBeforeBlur !== null) {
          this.setSpeed(this.speedBeforeBlur);
          this.speedBeforeBlur = null;
        }
      }
    });
  }

  get speed(): Speed {
    return this.speedValue;
  }

  setSpeed(speed: Speed): void {
    if (speed === this.speedValue) return;
    this.speedValue = speed;
    if (speed !== 0) this.speedBeforeBlur = null;
    this.events.emit('speedChanged', { speed });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.host.requestFrame(this.frame);
  }

  private frame = (now: number): void => {
    if (!this.running) return;

    // Commands always apply — this is what makes "build while paused" work.
    this.world.applyCommands(this.commands);

    if (this.lastTime !== null && this.speedValue > 0) {
      this.accumulator += (now - this.lastTime) * this.speedValue;
      let ticksThisFrame = 0;
      while (this.accumulator >= TICK_MS && ticksThisFrame < MAX_TICKS_PER_FRAME) {
        this.world.tick();
        this.accumulator -= TICK_MS;
        ticksThisFrame += 1;
      }
      // Clamp leftover backlog so a hitch doesn't snowball.
      if (this.accumulator > TICK_MS * MAX_TICKS_PER_FRAME) {
        this.accumulator = TICK_MS * MAX_TICKS_PER_FRAME;
      }
    } else if (this.speedValue === 0) {
      this.accumulator = 0;
    }
    this.lastTime = now;

    // Alpha is an interpolation fraction — clamp so a tick-capped frame can't
    // hand the renderer a value outside [0, 1].
    this.render(Math.min(this.accumulator / TICK_MS, 1));
    this.host.requestFrame(this.frame);
  };
}
