/**
 * SHIFTS Stage-1 (SHIFTS_STAGE1_CONTRACT). The two-shift model's id set.
 * `null` on a staffer means "no shift — always on duty" (today's behaviour, and
 * the default), so the availability gate is INERT until shifts are assigned.
 */
export const SHIFT_IDS = ['day', 'night'] as const;
export type ShiftId = (typeof SHIFT_IDS)[number];
