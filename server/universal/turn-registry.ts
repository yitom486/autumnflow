/**
 * In-memory turn ledger for POST /api/universal/chat.
 *
 * A turn is accepted once and then owns the ACP prompt. HTTP/SSE connections
 * are just subscribers: a dropped stream can reconnect with the same turnId
 * (and Last-Event-ID) without re-sending the prompt to the agent. Events are
 * buffered with a monotonically increasing seq; completed turns stay available
 * for a short grace window so a late retry can still read the final answer.
 */
export type TurnStatus = "running" | "done" | "error";

export interface TurnEvent {
  seq: number;
  data: Record<string, unknown>;
}

export interface TurnRecord {
  id: string;
  agentId: string;
  sessionId: string;
  status: TurnStatus;
  events: TurnEvent[];
  nextSeq: number;
  createdAt: number;
  updatedAt: number;
  listeners: Set<(event: TurnEvent) => void>;
  endListeners: Set<() => void>;
}

/** Keep enough events for a long streaming answer; bounded per completed turn. */
export const TURN_MAX_EVENTS = 20_000;
/** Completed turns remain replayable for this long (network retry / reload). */
export const TURN_RETENTION_MS = 15 * 60 * 1000;
/** Hard cap on simultaneous retained turns. */
export const TURN_MAX_RETAINED = 100;

export class TurnRegistry {
  private turns = new Map<string, TurnRecord>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  create(id: string, info: { agentId: string; sessionId: string }): TurnRecord {
    const existing = this.turns.get(id);
    if (existing) return existing;
    const now = Date.now();
    const record: TurnRecord = {
      id,
      agentId: info.agentId,
      sessionId: info.sessionId,
      status: "running",
      events: [],
      nextSeq: 1,
      createdAt: now,
      updatedAt: now,
      listeners: new Set(),
      endListeners: new Set(),
    };
    this.turns.set(id, record);
    this.prune(now);
    this.ensureCleanup();
    return record;
  }

  get(id: string): TurnRecord | undefined {
    return this.turns.get(id);
  }

  /** Append one durable event, assign seq, and wake every live subscriber. */
  append(id: string, data: Record<string, unknown>): TurnEvent | null {
    const record = this.turns.get(id);
    if (!record || record.status !== "running") return null;
    if (record.events.length >= TURN_MAX_EVENTS) {
      console.warn(`[TurnRegistry] turn ${id} exceeded ${TURN_MAX_EVENTS} events; dropping oldest replay entries`);
      record.events.splice(0, Math.max(1, Math.floor(TURN_MAX_EVENTS / 10)));
    }
    const event = { seq: record.nextSeq++, data };
    record.events.push(event);
    record.updatedAt = Date.now();
    for (const listener of record.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error(`[TurnRegistry] subscriber failed for ${id}:`, err);
      }
    }
    return event;
  }

  finish(id: string, status: Exclude<TurnStatus, "running">): void {
    const record = this.turns.get(id);
    if (!record || record.status !== "running") return;
    record.status = status;
    record.updatedAt = Date.now();
    for (const end of record.endListeners) {
      try {
        end();
      } catch (err) {
        console.error(`[TurnRegistry] end listener failed for ${id}:`, err);
      }
    }
    record.listeners.clear();
    record.endListeners.clear();
  }

  /**
   * Replay events after `afterSeq`, then subscribe to future ones. The end
   * callback fires exactly once when the turn is already finished, or when
   * finish() is called after this subscription.
   */
  subscribe(
    id: string,
    afterSeq: number,
    onEvent: (event: TurnEvent) => void,
    onEnd: () => void,
  ): () => void {
    const record = this.turns.get(id);
    if (!record) {
      onEnd();
      return () => {};
    }
    let last = Math.max(0, Math.floor(Number(afterSeq) || 0));
    for (const event of record.events) {
      if (event.seq > last) {
        last = event.seq;
        onEvent(event);
      }
    }
    if (record.status !== "running") {
      queueMicrotask(onEnd);
      return () => {};
    }
    let ended = false;
    const listener = (event: TurnEvent) => {
      if (event.seq <= last) return;
      last = event.seq;
      onEvent(event);
    };
    const end = () => {
      if (ended) return;
      ended = true;
      onEnd();
    };
    record.listeners.add(listener);
    record.endListeners.add(end);
    return () => {
      record.listeners.delete(listener);
      record.endListeners.delete(end);
    };
  }

  /** Remove finished turns past the retention window and cap retained rows. */
  prune(now = Date.now()): void {
    const finished = [...this.turns.values()]
      .filter((turn) => turn.status !== "running")
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const turn of finished) {
      if (now - turn.updatedAt > TURN_RETENTION_MS) this.turns.delete(turn.id);
    }
    while (this.turns.size > TURN_MAX_RETAINED) {
      const oldest = [...this.turns.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!oldest || oldest.status === "running") break;
      this.turns.delete(oldest.id);
    }
  }

  private ensureCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.prune(), 60_000);
    this.cleanupTimer.unref?.();
  }

  /** Test helper: clear all state without leaving a timer behind. */
  resetForTest(): void {
    this.turns.clear();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

export const turnRegistry = new TurnRegistry();
