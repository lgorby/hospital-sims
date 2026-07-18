/**
 * Thought-log strings (GDD §9) — game content, so it lives in sim/data per
 * SSOT rule 1. Selection is hashed from (patient id + tick), never the sim
 * RNG, so thoughts cost no determinism budget.
 */
export const THOUGHTS = {
  impatient: [
    "I've been waiting forever…",
    'Is anyone actually working here?',
    'My whole day, gone.',
    'I could have driven to the next town by now.',
  ],
  critical: [
    "I don't feel so good…",
    'Everything is going dark…',
    'Somebody… help…',
  ],
  lost: [
    'Where am I?!',
    'I got lost… again.',
    'These corridors all look the same!',
  ],
  rescued: [
    'Finally — someone who knows the way!',
    'Ah, THERE it is.',
    'Note to self: bring breadcrumbs.',
  ],
  discharged: [
    'Great care here!',
    'Good as new.',
    "That wasn't so bad.",
  ],
  complication: [
    "That… didn't go how they said it would.",
    'Why does it hurt MORE now?',
    'I want a second opinion.',
  ],
  // Amenities epic Stage 1 (AMENITIES_PLAN §3.1–3.2).
  needsRestroom: [
    'I really need the restroom…',
    'Where is the bathroom in this place?',
    "I can't hold it much longer!",
  ],
  needsVending: [
    'So thirsty…',
    'Is there a vending machine around?',
    'I could really use a drink.',
  ],
  accident: [
    'Oh no. Oh no no no.',
    "…I couldn't hold it.",
    'This is the worst day of my life.',
  ],
  // Stage 2: emitted at the vomit roll (mess.ts) — accidents already speak;
  // a silent vomit read as a bug in review.
  vomit: [
    'Urrgh… I need a doctor…',
    "I told them I wasn't feeling well.",
    'Someone should clean that up…',
  ],
} as const;

export type ThoughtKey = keyof typeof THOUGHTS;
