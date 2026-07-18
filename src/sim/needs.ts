import { BALANCE } from './data/balance';
import { CONDITION_DEFS, CONDITION_IDS, type ConditionId } from './data/conditions';
import { ROLE_DEFS, type RoleId } from './data/roles';
import { ROOM_DEFS, type RoomType } from './data/rooms';
import type { Patient } from './entities/patient';
import type { World } from './world';

/**
 * "What's blocked" derivation (HINTS_PLAN §2.1): the ONE place unmet
 * room/staff needs are computed. Pure and renderer-free — no rng, no
 * mutation, no DOM; reads world state only. Two consumers: the dispatcher's
 * urgent-need toasts and the persistent BlockedPanel (both use `label`, so
 * wording is single-sourced).
 *
 * LOAD-BEARING (save-gate safety, HINTS_PLAN §2.1): this pipeline must never
 * mutate anything — the dispatcher consumer writes only via `world.hintOnce`,
 * and nothing calls this during `loadWorld`. Hints have zero sim feedback, so
 * the world trajectory (and the save round-trip gate) is untouched by
 * construction.
 */

export interface BlockedNeed {
  /** Stable dedupe/hint key: 'room:<RoomType>' | 'role:<RoleId>'. */
  key: string;
  kind: 'room' | 'role';
  room?: RoomType;
  role?: RoleId;
  /** Live pre-terminal patients affected (deduped per need). */
  patients: number;
  /** Deduped condition labels driving this need (table order); empty for
   *  check-in/triage needs (not condition-specific). */
  conditions: string[];
  /** true = blocks someone's CURRENT progress; false = an upcoming step. */
  urgent: boolean;
  /** Display line — the ONE wording for panel rows AND toasts. */
  label: string;
}

/** Per-key aggregate built during the scan, finalized into a BlockedNeed. */
interface Aggregate {
  kind: 'room' | 'role';
  room?: RoomType;
  role?: RoleId;
  patientIds: Set<number>;
  conditions: Set<ConditionId>;
  urgent: boolean;
  /** Fixed label suffix for the check-in needs (else conditions drive it). */
  checkIn: boolean;
  /** Need also stems from triage duty (nurse) — named in the suffix so a
   *  condition union can't understate why the role is needed. */
  triage: boolean;
}

/** 'a'/'an' for a def label — covers today's vowel-initial labels plus the
 *  initialisms pronounced with a vowel sound (X-Ray, MRI). Exported: the
 *  checklist composes the same "Build a/an X" phrases (one wording source). */
export function article(label: string): 'a' | 'an' {
  return /^[AEIOU]/.test(label) || /^(X-|MRI)/.test(label) ? 'an' : 'a';
}

// Kind-typed so a stage rename is a compile error here, not silently dropped
// check-in needs (review NIT).
const CHECK_IN_STAGES = new Set<Patient['stage']['kind']>([
  'atEntrance',
  'queuedCheckIn',
  'checkingIn',
]);

export function computeBlockedNeeds(world: World): BlockedNeed[] {
  // Precompute presence once (O(P+S), HINTS_PLAN §2.1 perf note).
  const builtRooms = new Set<RoomType>();
  for (const room of world.rooms.values()) builtRooms.add(room.type);
  // `firing` members still count as hired — they work while walking out, and
  // the panel must not flash a need during the walk (review NIT).
  const hiredRoles = new Set<RoleId>();
  for (const member of world.staff.values()) hiredRoles.add(member.role);

  const aggregates = new Map<string, Aggregate>();
  const add = (
    patientId: number,
    kind: 'room' | 'role',
    id: RoomType | RoleId,
    opts: { urgent: boolean; condition?: ConditionId; checkIn?: boolean; triage?: boolean },
  ): void => {
    const key = `${kind}:${id}`;
    let agg = aggregates.get(key);
    if (!agg) {
      agg = {
        kind,
        ...(kind === 'room' ? { room: id as RoomType } : { role: id as RoleId }),
        patientIds: new Set(),
        conditions: new Set(),
        urgent: false,
        checkIn: false,
        triage: false,
      };
      aggregates.set(key, agg);
    }
    agg.patientIds.add(patientId);
    if (opts.condition !== undefined) agg.conditions.add(opts.condition);
    agg.urgent ||= opts.urgent;
    agg.checkIn ||= opts.checkIn ?? false;
    agg.triage ||= opts.triage ?? false;
  };

  for (const patient of world.patients.values()) {
    const stage = patient.stage.kind;
    // Pre-terminal only: `leaving` walkers and fading `dead` patients are
    // still in `world.patients` — a corpse must not keep a need alive
    // (pre-impl review MAJOR 1).
    if (stage === 'leaving' || stage === 'dead') continue;

    // Check-in (urgent — these patients are blocked NOW).
    if (CHECK_IN_STAGES.has(stage)) {
      if (!builtRooms.has('reception')) {
        add(patient.id, 'room', 'reception', { urgent: true, checkIn: true });
      } else if (!hiredRoles.has('receptionist')) {
        // Hired-not-posted deliberately passes: transient walks must not flash.
        add(patient.id, 'role', 'receptionist', { urgent: true, checkIn: true });
      }
    }

    // Triage is everyone's next stop until they've been triaged: urgent once
    // someone is already waitingTriage, upcoming while still checking in.
    if (CHECK_IN_STAGES.has(stage) || stage === 'waitingTriage') {
      const urgent = stage === 'waitingTriage';
      if (!builtRooms.has('triage')) add(patient.id, 'room', 'triage', { urgent, triage: true });
      if (!hiredRoles.has('nurse')) add(patient.id, 'role', 'nurse', { urgent, triage: true });
    }

    // Treatment chain look-ahead: every remaining step, current-first. A
    // `reserved` patient's in-progress step necessarily has its room/staff,
    // so scanning from stepIndex is uniform and harmless (HINTS_PLAN §2.1).
    const steps = CONDITION_DEFS[patient.condition].steps;
    for (let i = patient.stepIndex; i < steps.length; i++) {
      const step = steps[i]!;
      const urgent = stage === 'waiting' && i === patient.stepIndex;
      if (!builtRooms.has(step.room)) {
        add(patient.id, 'room', step.room, { urgent, condition: patient.condition });
      }
      for (const role of step.roles) {
        if (!hiredRoles.has(role)) {
          add(patient.id, 'role', role, { urgent, condition: patient.condition });
        }
      }
    }
  }

  const needs: BlockedNeed[] = [];
  for (const [key, agg] of aggregates) {
    // Deduped condition labels in CONDITION_IDS table order (deterministic).
    const conditions = CONDITION_IDS.filter((id) => agg.conditions.has(id)).map(
      (id) => CONDITION_DEFS[id].label,
    );
    const defLabel = agg.kind === 'room' ? ROOM_DEFS[agg.room!].label : ROLE_DEFS[agg.role!].label;
    const base = `${agg.kind === 'room' ? 'Build' : 'Hire'} ${article(defLabel)} ${defLabel}`;
    // Reasons: the "why" the owner was missing (pre-impl review MAJOR 2).
    // Triage duty is named alongside conditions so a union can't understate it;
    // the Triage Bay itself skips the self-evident "needed for triage".
    const reasons = [
      ...(agg.triage && key !== 'room:triage' ? ['triage'] : []),
      ...conditions,
    ];
    const suffix = agg.checkIn
      ? " — patients can't check in"
      : reasons.length > 0
        ? ` — needed for ${reasons.join(', ')}`
        : '';
    needs.push({
      key,
      kind: agg.kind,
      ...(agg.room !== undefined ? { room: agg.room } : {}),
      ...(agg.role !== undefined ? { role: agg.role } : {}),
      patients: agg.patientIds.size,
      conditions,
      urgent: agg.urgent,
      label: base + suffix,
    });
  }

  // Restroom need (amenities Stage 1, §1.11 / pre-impl MINOR 9): meter-based,
  // not condition-based, so it lives outside the aggregate scan. Urgent when
  // ≥1 patient in the ACTIONABLE stages (waiting/waitingTriage, design §3.1)
  // is below the bladder threshold with no restroom built; upcoming otherwise
  // while patients exist. The label is the ONE wording (panel + toast SSOT).
  if (!builtRooms.has('restroom')) {
    let preTerminal = 0;
    let seeking = 0;
    for (const patient of world.patients.values()) {
      const stage = patient.stage.kind;
      if (stage === 'leaving' || stage === 'dead') continue;
      preTerminal += 1;
      if (
        (stage === 'waiting' || stage === 'waitingTriage') &&
        patient.bladder < BALANCE.needs.seekThreshold
      ) {
        seeking += 1;
      }
    }
    if (preTerminal > 0) {
      needs.push({
        key: 'room:restroom',
        kind: 'room',
        room: 'restroom',
        patients: seeking > 0 ? seeking : preTerminal,
        conditions: [],
        urgent: seeking > 0,
        label: 'Build a Restroom — patients need the restroom',
      });
    }
  }

  // Total, deterministic order: urgent first, most-affected first, key tiebreak.
  needs.sort((a, b) => {
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
    if (a.patients !== b.patients) return b.patients - a.patients;
    return a.key < b.key ? -1 : 1;
  });
  return needs;
}
