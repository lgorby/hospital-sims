import type { AmenityId } from './sim/data/amenities';
import type { ChallengeContext, ChallengeSpec } from './sim/data/challenges';
import type { DayReport } from './sim/dailyStats';

/**
 * Typed pub/sub — the sim→render/ui channel (tech plan §2.2).
 * Event payloads are declared once, here, and imported everywhere.
 */
/** Game speed multiplier; 0 = paused. Declared here (the payload SSOT) — loop.ts re-exports it. */
export type Speed = 0 | 1 | 2 | 3;

/** Bankruptcy terminal payload (M4). Named so the challenge controller's
 *  `onGameOver` and the game-over screen share one declaration (SSOT). */
export interface GameOverPayload {
  day: number;
  cash: number;
  reputation: number;
  treated: number;
  died: number;
}

export interface EventMap {
  /** Loop-layer speed changed (0 = paused). */
  speedChanged: { speed: Speed };
  cashChanged: { cash: number };
  /** Midnight day-close snapshot (M4 daily report). */
  dayEnded: DayReport;
  /** Bankruptcy lose-state (M4): cash below threshold for a full game day. Sim is frozen. */
  gameOver: GameOverPayload;
  /**
   * Phase 2 challenge terminal (plan §5): emitted once, at the FIRST terminal —
   * `dayEnded` at `goal.day` (reached) or `gameOver` before it (dnf). `score`
   * is `null` for a daily-flow metric on a DNF. The controller once-latches.
   */
  challengeComplete: {
    spec: ChallengeSpec;
    outcome: 'reached' | 'dnf';
    score: number | null;
    context: ChallengeContext;
  };
  roomBuilt: { roomId: number };
  /** Stage B: a built room's footprint grew (expand tool) — re-render it. */
  roomChanged: { roomId: number };
  roomSold: { roomId: number };
  /** Amenities Stage 1: roomless prop placed/sold — render + panels react
   *  per-change (roomless props have no roomBuilt to piggyback on). */
  amenityPlaced: { col: number; row: number; kind: AmenityId };
  amenitySold: { col: number; row: number; kind: AmenityId };
  /** A build/sell command failed sim-side validation (UI shows the reason). */
  buildRejected: { reason: string };
  patientSpawned: { patientId: number };
  /**
   * Jumpable events carry a `{col,row}` snapshot at emit time (M3 ruling):
   * clicking the toast pans to the live entity if it still exists, else to
   * the snapshot — a death toast must outlive its patient.
   */
  patientDied: { patientId: number; name: string; condition: string; col: number; row: number };
  patientLeftAma: { patientId: number; name: string; col: number; row: number };
  patientDischarged: {
    patientId: number;
    name: string;
    totalBilled: number;
    col: number;
    row: number;
  };
  patientComplication: { patientId: number; name: string; col: number; row: number };
  /** Wayfinding (GDD §3): a patient took a wrong turn and is wandering. */
  patientLost: { patientId: number; name: string; col: number; row: number };
  patientRecovered: { patientId: number; name: string; col: number; row: number };
  /** Thought-log feed (GDD §9): emitted at mood/lifecycle moments. */
  patientThought: { patientId: number; name: string; text: string; col: number; row: number };
  feeBilled: { amount: number; label: string };
  staffHired: { staffId: number };
  staffFired: { staffId: number };
  /** Non-terminal staff change (e.g. fire deferred while mid-job) — UI re-renders. */
  staffUpdated: { staffId: number };
  /** Advisory toast: layout blocked a dispatch, or a needed facility is missing (Flow rules 5/8). */
  hint: { message: string };
  reputationChanged: { reputation: number };
  /** M0 debug: a marker was toggled on a tile via the command queue. */
  debugMarkerToggled: { col: number; row: number; present: boolean };
}

export type EventName = keyof EventMap;
type Handler<E extends EventName> = (payload: EventMap[E]) => void;

export class EventBus {
  private handlers = new Map<EventName, Set<Handler<EventName>>>();

  on<E extends EventName>(event: E, handler: Handler<E>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<EventName>);
    return () => set.delete(handler as Handler<EventName>);
  }

  emit<E extends EventName>(event: E, payload: EventMap[E]): void {
    // Handler isolation (audit #2): emits fire from inside sim mutation paths
    // (killPatient, billFee, …). A throwing UI handler must not skip its
    // siblings or unwind world.tick() mid-mutation.
    this.handlers.get(event)?.forEach((h) => {
      try {
        h(payload);
      } catch (error) {
        console.error(`EventBus handler for "${event}" threw:`, error);
      }
    });
  }
}
