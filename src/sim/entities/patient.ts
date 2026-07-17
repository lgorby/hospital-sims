import type { PersonName } from '../data/names';
import type { GridPoint } from '../types';

/**
 * M1 patient: a named actor that can walk. Lifecycle states (waiting,
 * inTreatment, …) arrive with the dispatcher in M2.
 */
export interface Patient {
  id: number;
  name: PersonName;
  age: number;
  /** Tile currently occupied (or being departed). */
  at: GridPoint;
  /** Tile currently being stepped into, if walking. */
  next: GridPoint | null;
  /** Remaining tiles after `next`. */
  path: GridPoint[];
  target: GridPoint | null;
  /** Progress of the at→next step, 0..1. */
  progress: number;
}
