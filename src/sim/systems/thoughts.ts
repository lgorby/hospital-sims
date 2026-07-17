import { moodOf } from '../formulas';
import type { World } from '../world';

/**
 * Thought log feed (GDD §9): mood TRANSITIONS emit a thought — the same
 * moments the render-side bubbles appear, via the shared moodOf formula.
 * Lifecycle thoughts (lost, rescued, discharged, complication) are emitted
 * at their event sites through world.emitThought.
 */
export function updateThoughts(world: World): void {
  for (const patient of world.patients.values()) {
    if (patient.stage.kind === 'dead' || patient.stage.kind === 'leaving') continue;
    const mood = moodOf(patient.health, patient.patience);
    if (mood === patient.reportedMood) continue;
    patient.reportedMood = mood;
    if (mood === 'impatient') world.emitThought(patient, 'impatient');
    if (mood === 'critical') world.emitThought(patient, 'critical');
  }
}
