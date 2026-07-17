/**
 * Typed pub/sub — the sim→render/ui channel (tech plan §2.2).
 * Event payloads are declared once, here, and imported everywhere.
 */
/** Game speed multiplier; 0 = paused. Declared here (the payload SSOT) — loop.ts re-exports it. */
export type Speed = 0 | 1 | 2 | 3;

export interface EventMap {
  /** Loop-layer speed changed (0 = paused). */
  speedChanged: { speed: Speed };
  cashChanged: { cash: number };
  dayEnded: { day: number };
  roomBuilt: { roomId: number };
  roomSold: { roomId: number };
  /** A build/sell command failed sim-side validation (UI shows the reason). */
  buildRejected: { reason: string };
  patientSpawned: { patientId: number };
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
    this.handlers.get(event)?.forEach((h) => h(payload));
  }
}
