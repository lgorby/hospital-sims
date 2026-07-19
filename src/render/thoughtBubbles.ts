/**
 * In-world thought bubbles (owner ask 2026-07-18: the RollerCoaster Tycoon
 * "pick up a guest and read their thoughts" moment).
 *
 * This is the LIVE half of that ask. `docs/PATIENT_THOUGHTS_IMPL_PLAN.md`
 * covers the archival half — the last N thoughts on the inspect card — and the
 * two compose: the bubble says what a patient is thinking NOW, the card says
 * what they thought earlier. The owner chose bubbles first (2026-07-19)
 * because they are the live surface, and GDD §9's mood display already
 * specifies "visual feedback (thought bubbles)".
 *
 * PURE AND PIXI-FREE by design, so the lifetime/eviction logic is unit-tested
 * (`test/thoughtBubbles.test.ts`) while `renderer.ts` keeps only the placement
 * it cannot test. This is the `hintLine.ts` bargain — a stateful render-adjacent
 * concern factored out precisely so it has a test.
 *
 * THREE RULINGS, each of which cost something to establish:
 *
 * 1. **`performance.now()`, never sim ticks.** `loop.ts:92` multiplies the
 *    accumulator by the speed setting, so a tick-timed bubble would vanish 3x
 *    faster at speed 3 and — the real defect — would NEVER expire at speed 0,
 *    pinning a bubble on screen for the whole time a player sits paused. The
 *    jump pulse uses wall-clock timing for exactly this reason.
 *
 * 2. **Keyed by patient, not a queue.** `patientThought` is SIM-driven and
 *    fires for many patients at once in a busy hospital; a single slot (the
 *    `pulseTarget` shape) would flicker between them. One live bubble per
 *    patient, and a new thought REPLACES that patient's current bubble rather
 *    than queueing behind it — a stale thought is worse than a missed one.
 *
 * 3. **Capped, oldest-evicted.** Uncapped, a busy hospital paints the map with
 *    overlapping text. The cap is on CONCURRENT bubbles, so the display
 *    degrades to "the most recent few" instead of to soup.
 */

/** Wall-clock lifetime of one bubble. Long enough to read a short sentence. */
export const BUBBLE_LIFETIME_MS = 4000;
/** Fade-out occupies the tail of the lifetime; the head is held at full alpha
 *  so the text is readable for most of its life rather than dimming at once. */
export const BUBBLE_FADE_MS = 900;
/** Max bubbles on screen at once. Beyond this the oldest is dropped. */
export const MAX_LIVE_BUBBLES = 5;

interface Bubble {
  patientId: number;
  text: string;
  startedAt: number;
}

/** What the renderer needs to draw one bubble this frame. */
export interface VisibleBubble {
  patientId: number;
  text: string;
  /** 0..1, already faded. Never 0 — an expired bubble is dropped, not drawn. */
  alpha: number;
}

export class ThoughtBubbles {
  /** Insertion-ordered by Map contract, which is what makes "evict the oldest"
   *  a `keys().next()` and not a scan. Re-inserting on replace keeps that true. */
  private live = new Map<number, Bubble>();

  /**
   * Record a thought. Replaces any live bubble for the same patient — see
   * ruling 2. `now` is injected rather than read here so the class stays pure
   * and the tests can drive time directly.
   */
  add(patientId: number, text: string, now: number): void {
    // Delete-then-set, so a replaced bubble moves to the END of the insertion
    // order. Without the delete, `Map.set` on an existing key keeps the ORIGINAL
    // position, and a patient who thinks continuously would stay first in line
    // and be evicted first despite being the most recently active.
    this.live.delete(patientId);
    this.live.set(patientId, { patientId, text, startedAt: now });
    while (this.live.size > MAX_LIVE_BUBBLES) {
      const oldest = this.live.keys().next();
      if (oldest.done === true) break;
      this.live.delete(oldest.value);
    }
  }

  /**
   * Drop a patient's bubble outright — called when they are discharged, die or
   * leave. Without this the renderer leaks a Text/Graphics pair per departed
   * patient, and `updateActors`' reap loop is the only thing that would notice.
   */
  remove(patientId: number): void {
    this.live.delete(patientId);
  }

  /** Everything that should be drawn this frame, oldest first. Expired
   *  bubbles are dropped as a side effect — pruning is not a separate call a
   *  caller could forget. */
  visible(now: number): VisibleBubble[] {
    const out: VisibleBubble[] = [];
    // Deleting the CURRENT entry during Map iteration is well-defined in JS, so
    // no defensive copy is taken (review MINOR: the spread this replaced cost
    // an allocation on every frame that had any bubble at all).
    for (const bubble of this.live.values()) {
      const age = now - bubble.startedAt;
      if (age >= BUBBLE_LIFETIME_MS) {
        this.live.delete(bubble.patientId);
        continue;
      }
      // A clock that jumps backwards (or a bubble added "in the future" by a
      // caller passing a stale `now`) must not produce alpha > 1.
      const remaining = BUBBLE_LIFETIME_MS - age;
      const alpha = remaining >= BUBBLE_FADE_MS ? 1 : remaining / BUBBLE_FADE_MS;
      out.push({
        patientId: bubble.patientId,
        text: bubble.text,
        alpha: Math.max(0, Math.min(1, alpha)),
      });
    }
    return out;
  }

  /** Live count, for tests and for the renderer's cheap "anything to do?" check. */
  get size(): number {
    return this.live.size;
  }

  /**
   * Drop everything.
   *
   * NOT currently reachable, and that is a property of the boot contract rather
   * than an oversight (review NIT): the world is never replaced in place —
   * `bootstrap` runs once (`main.ts:74`) and `?load=` is a FULL PAGE RELOAD
   * (`main.ts:234`), which discards the renderer and this instance with it.
   * Kept as the correct hook if in-place loading ever lands, because a
   * surviving renderer would otherwise show the previous world's thoughts over
   * the new world's patients.
   */
  clear(): void {
    this.live.clear();
  }
}
