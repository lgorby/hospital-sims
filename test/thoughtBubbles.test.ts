import { describe, expect, it } from 'vitest';

import {
  BUBBLE_FADE_MS,
  BUBBLE_LIFETIME_MS,
  MAX_LIVE_BUBBLES,
  ThoughtBubbles,
} from '../src/render/thoughtBubbles';

/**
 * The pure half of the in-world thought bubble (owner ask 2026-07-18, bubbles
 * chosen first 2026-07-19). `renderer.ts` keeps only Pixi placement, which is
 * untested by design; everything with a decision in it lives here — the
 * `hintLine.ts` precedent.
 */
describe('ThoughtBubbles', () => {
  it('shows a thought at full alpha immediately', () => {
    const b = new ThoughtBubbles();
    b.add(1, 'I hate waiting', 0);
    expect(b.visible(0)).toEqual([{ patientId: 1, text: 'I hate waiting', alpha: 1 }]);
  });

  it('holds full alpha until the fade window, then ramps down', () => {
    const b = new ThoughtBubbles();
    b.add(1, 'x', 0);
    // Just before the fade begins, still fully readable — the point of holding
    // the head of the lifetime rather than fading from t=0.
    const beforeFade = BUBBLE_LIFETIME_MS - BUBBLE_FADE_MS - 1;
    expect(b.visible(beforeFade)[0]?.alpha).toBe(1);
    // Halfway through the fade.
    const midFade = BUBBLE_LIFETIME_MS - BUBBLE_FADE_MS / 2;
    expect(b.visible(midFade)[0]?.alpha).toBeCloseTo(0.5, 5);
  });

  it('expires and prunes at the lifetime boundary', () => {
    const b = new ThoughtBubbles();
    b.add(1, 'x', 0);
    expect(b.visible(BUBBLE_LIFETIME_MS - 1)).toHaveLength(1);
    expect(b.visible(BUBBLE_LIFETIME_MS)).toHaveLength(0);
    // Pruned as a side effect of asking what is visible — a caller cannot
    // forget to prune, so an off-screen bubble cannot leak.
    expect(b.size).toBe(0);
  });

  it('REPLACES a patients bubble rather than queueing behind it', () => {
    const b = new ThoughtBubbles();
    b.add(1, 'first', 0);
    b.add(1, 'second', 100);
    const shown = b.visible(100);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.text).toBe('second');
    // And the replacement restarts the clock — otherwise a fresh thought would
    // inherit its predecessor's remaining life and could vanish instantly.
    expect(b.visible(100 + BUBBLE_LIFETIME_MS - 1)).toHaveLength(1);
  });

  it('caps concurrent bubbles and evicts the OLDEST', () => {
    const b = new ThoughtBubbles();
    for (let i = 0; i < MAX_LIVE_BUBBLES + 2; i++) b.add(i, `t${i}`, i);
    expect(b.size).toBe(MAX_LIVE_BUBBLES);
    const ids = b.visible(MAX_LIVE_BUBBLES + 2).map((v) => v.patientId);
    expect(ids).not.toContain(0); // the two oldest are gone
    expect(ids).not.toContain(1);
    expect(ids).toContain(MAX_LIVE_BUBBLES + 1); // the newest survived
  });

  it('a REPLACED bubble is treated as newest for eviction, not oldest', () => {
    // The delete-then-set in `add` exists for this: without it, Map.set on an
    // existing key keeps the ORIGINAL insertion position, so a patient who
    // thinks continuously would be evicted first despite being most active.
    const b = new ThoughtBubbles();
    for (let i = 0; i < MAX_LIVE_BUBBLES; i++) b.add(i, `t${i}`, i);
    b.add(0, 'patient 0 thinks again', 100); // refresh the oldest
    b.add(99, 'newcomer', 101); // forces one eviction
    const ids = b.visible(101).map((v) => v.patientId);
    expect(ids).toContain(0); // refreshed, so it survived
    expect(ids).not.toContain(1); // patient 1 is now the oldest and went
  });

  it('a replace AT the cap evicts nobody', () => {
    // The precise boundary the `while (size > MAX)` guard hinges on, and the
    // one the eviction-order test above does NOT reach (it adds a newcomer,
    // which legitimately evicts). `add` does delete-then-set, so at the cap a
    // replace is net-zero and the loop must not fire. An `if` instead of a
    // `while`, or a set-before-delete, would drop an innocent bubble here.
    const b = new ThoughtBubbles();
    for (let i = 0; i < MAX_LIVE_BUBBLES; i++) b.add(i, `t${i}`, i);
    expect(b.size).toBe(MAX_LIVE_BUBBLES);
    b.add(2, 'patient 2 thinks again', 500);
    expect(b.size).toBe(MAX_LIVE_BUBBLES);
    // Every original patient is still present — nobody was evicted.
    const ids = b.visible(500).map((v) => v.patientId).sort((x, y) => x - y);
    expect(ids).toEqual([...Array(MAX_LIVE_BUBBLES).keys()]);
  });

  it('returns bubbles oldest-first, which the render order depends on', () => {
    const b = new ThoughtBubbles();
    b.add(7, 'first', 0);
    b.add(8, 'second', 10);
    b.add(9, 'third', 20);
    expect(b.visible(30).map((v) => v.patientId)).toEqual([7, 8, 9]);
  });

  it('removing an unknown patient is a harmless no-op', () => {
    // The renderer's reap loop calls remove() for every departing patient,
    // the vast majority of whom never had a bubble.
    const b = new ThoughtBubbles();
    b.add(1, 'x', 0);
    expect(() => b.remove(999)).not.toThrow();
    expect(b.size).toBe(1);
  });

  it('removes a departed patients bubble on request', () => {
    const b = new ThoughtBubbles();
    b.add(1, 'x', 0);
    b.add(2, 'y', 0);
    b.remove(1);
    expect(b.visible(0).map((v) => v.patientId)).toEqual([2]);
  });

  it('clamps alpha when the clock moves backwards', () => {
    // performance.now() is monotonic, but a bubble added with a stale `now`
    // (or a caller reusing a captured timestamp) must not produce alpha > 1.
    const b = new ThoughtBubbles();
    b.add(1, 'x', 1000);
    const shown = b.visible(0);
    expect(shown[0]?.alpha).toBeLessThanOrEqual(1);
    expect(shown[0]?.alpha).toBeGreaterThanOrEqual(0);
  });

  it('clear drops everything', () => {
    const b = new ThoughtBubbles();
    b.add(1, 'x', 0);
    b.add(2, 'y', 0);
    b.clear();
    expect(b.size).toBe(0);
  });
});
