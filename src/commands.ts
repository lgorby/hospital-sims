import type { ConditionId } from './sim/data/conditions';
import type { RoomType } from './sim/data/rooms';
import type { GridPoint, Rect } from './sim/types';

/**
 * The ui→sim channel (tech plan §2.2). All world mutations flow through here —
 * single-threaded, replayable. Speed/pause is NOT a command: it lives in the
 * loop layer so the game can always unpause (§2.2 "pause is not a dead sim").
 */
export type Command =
  | { type: 'buildRoom'; roomType: RoomType; rect: Rect; doorOutside: GridPoint | null }
  | { type: 'expandRoom'; roomId: number; rect: Rect }
  | { type: 'sellRoom'; roomId: number }
  | { type: 'hireStaff'; candidateId: number }
  | { type: 'fireStaff'; staffId: number }
  | { type: 'debugSpawnPatient'; condition?: ConditionId }
  | { type: 'debugForce'; patientId: number; outcome: 'death' | 'ama' | 'complication' }
  | { type: 'debugFastForward'; ticks: number }
  | { type: 'debugSetCash'; amount: number }
  | { type: 'debugWalkTo'; col: number; row: number }
  | { type: 'debugToggleMarker'; col: number; row: number };

export class CommandQueue {
  private queue: Command[] = [];

  push(command: Command): void {
    this.queue.push(command);
  }

  /** Removes and returns all pending commands, in order. */
  drain(): Command[] {
    if (this.queue.length === 0) return [];
    const drained = this.queue;
    this.queue = [];
    return drained;
  }
}
