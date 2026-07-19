// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { EventBus } from '../src/events';
import { BottomBarDropdowns } from '../src/ui/bottomBar';
import { ThoughtLog } from '../src/ui/thoughtLog';

/**
 * Thought-log entries follow the PERSON, not the place (owner ask
 * 2026-07-19: "pulse the patient so the user can follow their path").
 *
 * The defect this pins: the handler destructured `{ name, text, col, row }`
 * and dropped the `patientId` the event has always carried, then jumped to
 * `col,row` — where the thought HAPPENED. A patient walks away from that tile
 * within seconds, so the camera landed on empty floor and the pulse throbbed
 * over nobody. The id is what the player means when they click a name.
 */

interface Followed {
  patientId: number;
  col: number;
  row: number;
}

function fixture() {
  const events = new EventBus();
  const followed: Followed[] = [];
  const root = document.createElement('div');
  const host = document.createElement('div');
  const log = new ThoughtLog(
    events,
    (patientId, col, row) => followed.push({ patientId, col, row }),
    new BottomBarDropdowns(),
  );
  log.mount(root, host);
  return { events, root, followed };
}

function entries(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll('.thought')] as HTMLElement[];
}

describe('ThoughtLog', () => {
  it('passes the patientId to the follow handler, not just the thought tile', () => {
    const { events, root, followed } = fixture();
    events.emit('patientThought', {
      patientId: 77,
      name: 'Doris K.',
      text: "I've been waiting forever",
      col: 5,
      row: 6,
    });

    const rows = entries(root);
    expect(rows).toHaveLength(1);
    rows[0]!.click();

    // The id is the whole point — a test asserting only col/row would have
    // passed against the defective version.
    expect(followed).toEqual([{ patientId: 77, col: 5, row: 6 }]);
  });

  it('keeps each entry bound to its OWN patient', () => {
    const { events, root, followed } = fixture();
    for (const [patientId, name] of [
      [1, 'Ada L.'],
      [2, 'Bo T.'],
      [3, 'Cy R.'],
    ] as const) {
      events.emit('patientThought', { patientId, name, text: 'hm', col: patientId, row: 0 });
    }

    // Newest first (`prepend`), so the visual order is 3, 2, 1.
    const rows = entries(root);
    expect(rows).toHaveLength(3);
    rows[0]!.click();
    rows[2]!.click();

    expect(followed.map((f) => f.patientId)).toEqual([3, 1]);
  });

  it('names the person in the tooltip so the affordance reads as "follow"', () => {
    const { events, root } = fixture();
    events.emit('patientThought', {
      patientId: 9,
      name: 'Ida M.',
      text: 'so hungry',
      col: 1,
      row: 1,
    });
    expect(entries(root)[0]!.title).toBe('Click to follow Ida M.');
  });

  it('renders names and thoughts as TEXT, never markup', () => {
    const { events, root } = fixture();
    events.emit('patientThought', {
      patientId: 4,
      name: '<img src=x onerror=alert(1)>',
      text: '<script>alert(2)</script>',
      col: 0,
      row: 0,
    });
    const row = entries(root)[0]!;
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('script')).toBeNull();
    expect(row.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
