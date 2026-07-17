import { dayOfTick } from '../sim/clock';
import { SAVE_VERSION } from '../sim/save';

/**
 * Phase-1 save storage (docs/PERSISTENCE_PLAN.md rule 5): localStorage slots.
 * The payload under each slot key is EXACTLY the `saveToString` contract
 * string — no envelope — so a slot's bytes and an exported file are the same
 * thing. Recency/display metadata lives under a separate key.
 *
 * Every localStorage touch is wrapped: quota errors and privacy modes must
 * surface as readable failures, never exceptions in UI handlers.
 */

export const SLOTS = ['1', '2', '3', 'auto'] as const;
export type SlotName = (typeof SLOTS)[number];
export const AUTO_SLOT: SlotName = 'auto';
export const MANUAL_SLOTS: readonly SlotName[] = ['1', '2', '3'];

/** Payload key: `hospitalSimms.save.<slot>` holds the raw contract JSON. */
const KEY_PREFIX = 'hospitalSimms.save.';
/** All slots' display metadata in one JSON object (savedAt is wall-clock ms). */
const META_KEY = 'hospitalSimms.saveMeta';

export interface SlotMeta {
  /** Wall-clock ms at save time (UI-side only — the sim never sees this). */
  savedAt: number;
  day: number | null;
  cash: number | null;
  seed: number | null;
}

export type MetaTable = Partial<Record<SlotName, SlotMeta>>;

export type StoreResult = { ok: true } | { ok: false; reason: string };

export function isSlotName(value: string): value is SlotName {
  return (SLOTS as readonly string[]).includes(value);
}

export function slotLabel(slot: SlotName): string {
  return slot === AUTO_SLOT ? 'Autosave' : `Slot ${slot}`;
}

/** Raw contract string for a slot, or null if empty/unreadable. */
export function readSlotRaw(slot: SlotName): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + slot);
  } catch {
    return null;
  }
}

/**
 * Store the raw contract string. The payload write is the one that matters;
 * the meta update is best-effort (a lost meta only degrades the slot's label).
 */
export function writeSlot(slot: SlotName, raw: string): StoreResult {
  try {
    localStorage.setItem(KEY_PREFIX + slot, raw);
  } catch (error) {
    return { ok: false, reason: storageFailureMessage(error) };
  }
  try {
    const meta = readAllMeta();
    meta[slot] = metaFromRaw(raw);
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* payload saved; only the display metadata was lost */
  }
  return { ok: true };
}

export function deleteSlot(slot: SlotName): void {
  try {
    localStorage.removeItem(KEY_PREFIX + slot);
  } catch {
    /* nothing to surface — the slot will still read as occupied if this failed */
  }
  try {
    const meta = readAllMeta();
    delete meta[slot];
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* best-effort */
  }
}

/** Parsed + shape-checked meta table; garbage collapses to "no metadata". */
export function readAllMeta(): MetaTable {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(META_KEY);
    if (raw === null) return {};
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const table: MetaTable = {};
  for (const slot of SLOTS) {
    const entry = record[slot];
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.savedAt !== 'number') continue;
    table[slot] = {
      savedAt: e.savedAt,
      day: typeof e.day === 'number' ? e.day : null,
      cash: typeof e.cash === 'number' ? e.cash : null,
      seed: typeof e.seed === 'number' ? e.seed : null,
    };
  }
  return table;
}

export function hasAnySave(): boolean {
  return SLOTS.some((slot) => readSlotRaw(slot) !== null);
}

/** Occupied slot with the newest `savedAt` (missing meta counts as oldest). */
export function mostRecentSlot(): SlotName | null {
  const meta = readAllMeta();
  let best: SlotName | null = null;
  let bestAt = -1;
  for (const slot of SLOTS) {
    if (readSlotRaw(slot) === null) continue;
    const at = meta[slot]?.savedAt ?? 0;
    if (at > bestAt) {
      bestAt = at;
      best = slot;
    }
  }
  return best;
}

/**
 * Import-time sanity check — cheap shape/version gate so a bad file gets a
 * readable message at pick time. Full validation happens in `loadWorld` at
 * boot (the sim border owns real parsing).
 */
export function validateSaveString(raw: string): StoreResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'the file is not valid JSON' };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'the file is not a Hospital Simms save' };
  }
  const version = (data as Record<string, unknown>).saveVersion;
  if (typeof version !== 'number') {
    return { ok: false, reason: 'the file has no saveVersion — not a Hospital Simms save' };
  }
  // Mirror loadWorld's exact gate: anything but the current version is refused
  // there, so accepting it here would let an import overwrite a slot with a
  // file whose Load can only fail.
  if (version > SAVE_VERSION) {
    return {
      ok: false,
      reason: `the save is from a newer game version (v${version}; this build loads v${SAVE_VERSION})`,
    };
  }
  if (version < SAVE_VERSION) {
    return {
      ok: false,
      reason: `the save is from an older game version (v${version}) this build can no longer load (v${SAVE_VERSION})`,
    };
  }
  return { ok: true };
}

/**
 * Loading is a full page reload (the established teardown-free boot path,
 * mirroring `?seed=`): navigate to `?load=<slot>`, dropping any seed param.
 */
export function navigateToLoad(slot: SlotName): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('seed');
  url.searchParams.set('load', slot);
  window.location.assign(url.toString());
}

/** Display fields parsed defensively out of the contract string. */
function metaFromRaw(raw: string): SlotMeta {
  const meta: SlotMeta = { savedAt: Date.now(), day: null, cash: null, seed: null };
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data === 'object' && data !== null) {
      const d = data as Record<string, unknown>;
      // clock.ts owns all time conversions (hard rule 1) — never re-derive.
      if (typeof d.tick === 'number') meta.day = dayOfTick(d.tick);
      if (typeof d.cash === 'number') meta.cash = d.cash;
      if (typeof d.seed === 'number') meta.seed = d.seed;
    }
  } catch {
    /* payload is opaque — keep nulls; the slot still lists as occupied */
  }
  return meta;
}

function storageFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `browser storage rejected the write (full or blocked in private browsing): ${detail}`;
}
