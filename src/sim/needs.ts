import { gameMinutesToTicks } from './clock';
import { BALANCE } from './data/balance';
import { CONDITION_DEFS, CONDITION_IDS, type ConditionId } from './data/conditions';
import { ROLE_DEFS, type RoleId } from './data/roles';
import { ROOM_DEFS, type RoomType } from './data/rooms';
import { staffRatioFor } from './formulas';
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
  /** Stable dedupe/hint key: 'room:<RoomType>' | 'role:<RoleId>' |
   *  'broken:<roomId>:<brokenSince>' (instance-keyed — Stage 3, design
   *  MINOR 8: hintedOnce persists per save, so a room-keyed toast would
   *  announce only the FIRST breakdown ever) | ED B1's
   *  'capacity:<RoomType>' and 'capacity:<RoomType>:<RoleId>'. */
  key: string;
  kind: 'room' | 'role' | 'broken' | 'capacity';
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

  // EVS need (amenities Stage 2, §S2.5): mess-based, not condition-based, so
  // it lives outside the aggregate scan like the restroom need. Urgent at
  // ≥ EVS_URGENT_MESSES standing messes with no EVS hired; upcoming when any
  // mess exists. `patients` carries the standing-MESS count (pre-impl MINOR
  // 13): it drives the sort tie-break, and messes aren't patients.
  if (!hiredRoles.has('evs') && world.messes.size > 0) {
    needs.push({
      key: 'role:evs',
      kind: 'role',
      role: 'evs',
      patients: world.messes.size,
      conditions: [],
      urgent: world.messes.size >= BALANCE.mess.evsUrgentMesses,
      label: 'Hire an EVS Worker — messes need cleaning',
    });
  }

  // Broken rooms (amenities Stage 3, §6): per-instance callouts, always
  // urgent — a disabled room blocks progress NOW. `patients: 0` (design:
  // no patient count — broken rows sort after patient-backed urgent rows;
  // accepted). The §6 sketch's room-type/roomId payload fields are dropped
  // (no consumer needs them — recorded design delta, pre-impl NIT 10).
  for (const room of world.rooms.values()) {
    if (room.brokenSince === null) continue;
    needs.push({
      key: `broken:${room.id}:${room.brokenSince}`,
      kind: 'broken',
      patients: 0,
      conditions: [],
      urgent: true,
      label: `${ROOM_DEFS[room.type].label} is broken — needs repair`,
    });
  }

  // Maintenance need (Stage 3): broken-room-based, standalone like role:evs.
  // Always urgent while anything is broken and nobody can fix it; `patients`
  // carries the broken-room count (the role:evs mess-count precedent — it
  // drives the sort tie-break).
  if (!hiredRoles.has('maintenance')) {
    let brokenRooms = 0;
    for (const room of world.rooms.values()) {
      if (room.brokenSince !== null) brokenRooms += 1;
    }
    if (brokenRooms > 0) {
      needs.push({
        key: 'role:maintenance',
        kind: 'role',
        role: 'maintenance',
        patients: brokenRooms,
        conditions: [],
        urgent: true,
        label: 'Hire a Maintenance Tech — a room needs repair',
      });
    }
  }

  needs.push(...capacityNeeds(world));

  // Total, deterministic order: urgent first, most-affected first, key tiebreak.
  needs.sort((a, b) => {
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
    if (a.patients !== b.patients) return b.patients - a.patients;
    return a.key < b.key ? -1 : 1;
  });
  return needs;
}

/**
 * ED epic Stage B1 §5.3 — the SHORTAGE scan (owner ask 2026-07-19: "continued
 * hints if we need more particular staff to cover areas").
 *
 * The scan above is EXISTENCE-based ("is this room built / this role hired?"),
 * deliberately, so a staffer's transient walk never flashes a hint. That left
 * the game silent on its most common real failure: the room IS built, the
 * nurse IS hired, and nothing is happening because every bay is occupied or
 * every nurse is already busy. A player watched patients die outside an idle
 * operating room with no explanation. The three states:
 *
 *   1. no free bay     → expand the room to add bays
 *   2. every X is busy → hire another X for THIS room
 *   3. role not hired  → already `role:<id>` above, deliberately NOT repeated
 *
 * State 1 is also THE remedy for an existing save whose ER still holds one
 * bed: the density change only affects new builds and expansions, so without
 * this row the game never tells that player what to do.
 *
 * SCOPE: every STAFFED room, not just ratio rooms. Naming the specific role
 * per area is the point — the day's case mix decides whether the ED is short
 * a nurse (lacerations) or a doctor (fractures, kidney stones), and
 * diagnosing WHICH resource binds is meant to be the skill (ED_PLAN §7.2).
 * The transient-flash problem that scoping to ratio rooms used to dodge is
 * handled properly instead, by `capacityHintWaitGameMinutes`: a 1:1 room is
 * briefly "all staff busy" between every patient, so only a patient who has
 * been waiting a REAL interval counts as blocked by a shortage.
 *
 * Lives HERE, not in the UI, because `label` is the single wording source for
 * the BlockedPanel AND the dispatcher's toasts, and because the availability
 * test below must not drift from the dispatcher's `availableStaff`.
 * Pure: reads world state, mutates nothing.
 */
function capacityNeeds(world: World): BlockedNeed[] {
  const blockedFor = gameMinutesToTicks(BALANCE.dispatcher.capacityHintWaitGameMinutes);
  const longWait = (p: Patient): boolean =>
    p.waitingSince !== null && world.clock.tick - p.waitingSince >= blockedFor;

  // Which room types have someone genuinely stuck outside them, and on which
  // roles. `waitingTriage` is included: triage is a staffed room like any
  // other, and a starved triage queue is the single loudest version of this
  // failure (a ratio staffer never returns to `idle`, and `assignTriage`
  // gates on availability — so a busy ED can hold the only nurse indefinitely
  // and every arrival strands untriaged. ED_PLAN §5b item 5).
  const blocked = new Map<RoomType, { roles: Set<RoleId>; patients: Set<number> }>();
  const note = (type: RoomType, roles: readonly RoleId[], patientId: number): void => {
    let entry = blocked.get(type);
    if (!entry) {
      entry = { roles: new Set(), patients: new Set() };
      blocked.set(type, entry);
    }
    entry.patients.add(patientId);
    for (const role of roles) entry.roles.add(role);
  };
  for (const patient of world.patients.values()) {
    if (!longWait(patient)) continue;
    if (patient.stage.kind === 'waitingTriage') {
      note('triage', ROOM_DEFS.triage.staffedBy, patient.id);
      continue;
    }
    if (patient.stage.kind !== 'waiting') continue;
    const step = CONDITION_DEFS[patient.condition].steps[patient.stepIndex];
    if (step) note(step.room, step.roles, patient.id);
  }

  const needs: BlockedNeed[] = [];
  // Table order, not insertion order (determinism).
  for (const type of Object.keys(ROOM_DEFS) as RoomType[]) {
    const entry = blocked.get(type);
    if (!entry) continue;
    // Unbuilt is `room:<type>`; broken is `broken:<id>`; a CLOSED room is the
    // player's own deliberate act and announces itself on the inspect card.
    const open = world.roomsOfType(type).filter((r) => !r.closed && r.brokenSince === null);
    if (open.length === 0) continue;

    const label = ROOM_DEFS[type].label;
    const rule = ROOM_DEFS[type].capacity;
    const withSlot = open.filter((r) => world.openSlots(r) > 0);
    if (withSlot.length === 0) {
      // THE REMEDY DEPENDS ON THE CAPACITY RULE, and getting this wrong is
      // worse than silence — it sends the player to spend money on something
      // that cannot help. Only waiting/ER/dialysis/restroom are `perProp`,
      // where floor area buys slots. EVERY other treatment room is `single`:
      // expanding one buys QUALITY, never a second patient, so the only way
      // to treat two at once is a second room. (Reported by the owner, who
      // expanded Respiratory Therapy on this hint's advice and correctly got
      // no new capacity — `resp` is single, and the row rightly refused to
      // clear because nothing had changed.)
      needs.push({
        key: `capacity:${type}`,
        kind: 'capacity',
        room: type,
        patients: entry.patients.size,
        conditions: [],
        urgent: true,
        label:
          rule.kind === 'perProp'
            ? // The room's OWN noun — "beds" for the ER, "machines" for
              // dialysis, "seats" for the waiting room. A hardcoded "bays"
              // was wrong everywhere except the ER.
              `${label} is full — expand it to add ${rule.noun.toLowerCase()}`
            : `${label} is busy — build another one (it treats one patient at a time)`,
      });
      continue;
    }

    // A slot is free, so the blocker is the staffer. This mirrors the
    // dispatcher's `availableStaff` and must stay in step with it: idle takes
    // any free slot; an engaged staffer qualifies only while their load IN
    // THAT ROOM is under the ratio (1 for every non-ED room, so an engaged
    // staffer never qualifies there); `firing`, posted and job-bound cannot.
    for (const role of ROOM_DEFS[type].staffedBy) {
      if (!entry.roles.has(role)) continue;
      const ratio = staffRatioFor(type, role);
      const hired = [...world.staff.values()].filter((s) => s.role === role);
      if (hired.length === 0) continue; // state 3 — `role:<id>` already covers it
      const someoneFree = hired.some((s) => {
        if (s.firing) return false;
        if (s.duty.kind === 'idle') return true;
        if (s.duty.kind !== 'reserved') return false;
        return withSlot.some((r) => {
          const load = world.staffLoadIn(s.id, r.id);
          return load > 0 && load < ratio;
        });
      });
      if (someoneFree) continue;
      needs.push({
        key: `capacity:${type}:${role}`,
        kind: 'capacity',
        room: type,
        role,
        patients: entry.patients.size,
        conditions: [],
        urgent: true,
        // Names the ROLE and the AREA: "which resource, and where" is the
        // diagnosis the player is being asked to make.
        label: `Every ${ROLE_DEFS[role].label} is busy — hire another for the ${label}`,
      });
    }
  }
  return needs;
}
