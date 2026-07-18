import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/commands';
import { EventBus } from '../src/events';
import { validateRoomRect } from '../src/sim/build';
import { BALANCE } from '../src/sim/data/balance';
import { ROOM_DEFS, type RoomType } from '../src/sim/data/rooms';
import { perTileRate, priceOf, roomQuality, sellbackAmount } from '../src/sim/formulas';
import { World } from '../src/sim/world';

/**
 * Capacity epic Stage 0 — the size-based economy (CAPACITY_PLAN §4.1, owner
 * ruling "size affects cost"). One formula (`priceOf`) prices new builds now
 * and expansions in Stage B; the regression of record is the design-review
 * MAJOR 1 exploit: a drag-grown room must never cost its flat minimum price.
 */

const ROOM_TYPES = Object.keys(ROOM_DEFS) as RoomType[];

function rectOf(type: RoomType, extraCols = 0, extraRows = 0) {
  const def = ROOM_DEFS[type];
  return { col: 5, row: 5, cols: def.minCols + extraCols, rows: def.minRows + extraRows };
}

describe('priceOf / perTileRate (SSOT formulas)', () => {
  it('a minimum-size rect prices at exactly the table cost — every room type', () => {
    for (const type of ROOM_TYPES) {
      expect(priceOf(type, rectOf(type))).toBe(ROOM_DEFS[type].cost);
    }
  });

  it('a ROTATED minimum rect (equal area) also prices at the table cost', () => {
    // reception min 2×3 — the 3×2 orientation the sim accepts.
    expect(priceOf('reception', { col: 0, row: 0, cols: 3, rows: 2 })).toBe(
      ROOM_DEFS.reception.cost,
    );
  });

  it('every extra tile charges the derived per-tile rate', () => {
    for (const type of ROOM_TYPES) {
      const def = ROOM_DEFS[type];
      const grown = rectOf(type, 1, 0); // +minRows tiles
      const extraTiles = grown.cols * grown.rows - def.minCols * def.minRows;
      expect(priceOf(type, grown)).toBe(def.cost + perTileRate(type) * extraTiles);
      expect(perTileRate(type)).toBe(Math.ceil(def.cost / (def.minCols * def.minRows)));
    }
  });

  it('REGRESSION OF RECORD (design-review MAJOR 1): a drag-grown room is never flat-priced', () => {
    for (const type of ROOM_TYPES) {
      expect(priceOf(type, rectOf(type, 2, 2))).toBeGreaterThan(ROOM_DEFS[type].cost);
    }
  });

  it('a rotated OVERSIZED rect prices by area, not dimension order', () => {
    // reception min 2×3 (area 6): a 4×2 rect (area 8) = 2 extra tiles in the
    // rotated orientation — would catch a dimension-based regression.
    expect(priceOf('reception', { col: 0, row: 0, cols: 4, rows: 2 })).toBe(
      ROOM_DEFS.reception.cost + perTileRate('reception') * 2,
    );
  });

  it('sub-minimum rects clamp to base values (defensive, unreachable via validation)', () => {
    const tiny = { col: 0, row: 0, cols: 1, rows: 1 };
    expect(priceOf('exam', tiny)).toBe(ROOM_DEFS.exam.cost);
    expect(roomQuality('exam', tiny)).toBe(0);
  });
});

describe('buildRoom charges the sized price (world integration)', () => {
  it('an oversized build debits priceOf and tallies it as construction', () => {
    const world = new World(new EventBus(), 42);
    const cashBefore = world.cash;
    const rect = rectOf('triage', 2, 1); // 4×3 vs min 2×2
    world.buildRoom('triage', rect, { col: rect.col + rect.cols, row: rect.row });
    expect(world.rooms.size).toBe(1);
    const price = priceOf('triage', rect);
    expect(price).toBeGreaterThan(ROOM_DEFS.triage.cost);
    expect(cashBefore - world.cash).toBe(price);
    expect(world.today.construction).toBe(price);
  });

  it('a minimum-size build still costs exactly the table price (no regression)', () => {
    const world = new World(new EventBus(), 42);
    const cashBefore = world.cash;
    const rect = rectOf('triage');
    world.buildRoom('triage', rect, { col: rect.col + rect.cols, row: rect.row });
    expect(cashBefore - world.cash).toBe(ROOM_DEFS.triage.cost);
  });

  it('validation prices the ACTUAL rect: affordable at min size, rejected when grown', () => {
    const world = new World(new EventBus(), 42);
    world.cash = ROOM_DEFS.triage.cost; // exactly the flat price
    expect(validateRoomRect(world, 'triage', rectOf('triage')).ok).toBe(true);
    const grown = validateRoomRect(world, 'triage', rectOf('triage', 1, 1));
    expect(grown.ok).toBe(false);
    if (!grown.ok) expect(grown.reason).toBe('Not enough cash');
  });
});

describe('rect-aware sellback (one formula for sim payout and UI label)', () => {
  it('selling an oversized room refunds the ratio of its SIZED price', () => {
    const world = new World(new EventBus(), 42);
    const rect = rectOf('triage', 2, 1);
    world.buildRoom('triage', rect, { col: rect.col + rect.cols, row: rect.row });
    const room = [...world.rooms.values()][0]!;
    const expected = Math.floor(priceOf('triage', rect) * BALANCE.economy.roomSellbackRatio);
    expect(sellbackAmount(room.type, room.rect)).toBe(expected);
    const cashBefore = world.cash;
    const queue = new CommandQueue();
    queue.push({ type: 'sellRoom', roomId: room.id });
    world.applyCommands(queue);
    expect(world.rooms.size).toBe(0);
    expect(world.cash - cashBefore).toBe(expected);
  });

  it('build-then-sell at ANY size never profits (ratio < 1 end to end)', () => {
    for (const extra of [0, 1, 3] as const) {
      const world = new World(new EventBus(), 42);
      const cashStart = world.cash;
      const rect = rectOf('exam', extra, extra);
      world.buildRoom('exam', rect, { col: rect.col + rect.cols, row: rect.row });
      const room = [...world.rooms.values()][0]!;
      const queue = new CommandQueue();
      queue.push({ type: 'sellRoom', roomId: room.id });
      world.applyCommands(queue);
      expect(world.rooms.size).toBe(0); // premise: the sell really happened
      expect(world.cash).toBeLessThan(cashStart); // no arbitrage loop
    }
  });
});

describe('roomQuality formula (moved from buildRoom — Stage B pre-req)', () => {
  it('matches the built room quality for min and grown sizes', () => {
    const world = new World(new EventBus(), 42);
    const rect = rectOf('exam', 1, 2);
    world.buildRoom('exam', rect, { col: rect.col + rect.cols, row: rect.row });
    const room = [...world.rooms.values()][0]!;
    expect(room.quality).toBe(roomQuality('exam', rect));
    expect(roomQuality('exam', rectOf('exam'))).toBe(0); // min size = no bonus
  });
});
