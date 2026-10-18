/**
 * Per-session prompt mutex for ACP `session/prompt`.
 *
 * ACP allows exactly one prompt per session at a time, and the gateway turns a
 * concurrent attempt into HTTP 409 (`session busy`). Two things make a plain
 * Set<string> wrong:
 *
 * 1. `cancel()` is only a notification — the cancelled `session/prompt` request
 *    is still pending, and its `finally` runs *after* the UI may already have
 *    started the next turn. An unconditional delete there frees a lease the
 *    next turn now owns, so a third prompt slips in. Releases are therefore
 *    token-checked: a stale turn can only release its own lease.
 * 2. A crashed agent process never resolves the pending request, so the session
 *    must be released on exit (`reset()`) or it stays 409 forever.
 */
export class PromptLock {
  /** sessionId -> monotonically increasing lease token */
  private leases = new Map<string, number>();
  private seq = 0;

  /** Lease currently owning the session, or null when idle. */
  current(sessionId: string): number | null {
    return this.leases.get(sessionId) ?? null;
  }

  isBusy(sessionId: string): boolean {
    return this.leases.has(sessionId);
  }

  /** Take the session, or throw the 409 contract when a turn is still running. */
  acquire(sessionId: string): number {
    if (this.leases.has(sessionId)) {
      throw new Error("session busy: previous prompt still running (409)");
    }
    const lease = ++this.seq;
    this.leases.set(sessionId, lease);
    return lease;
  }

  /**
   * Release only when `lease` still owns the session. Returns false for a stale
   * release (the turn was cancelled and a newer turn owns the session).
   */
  release(sessionId: string, lease: number): boolean {
    if (this.leases.get(sessionId) !== lease) return false;
    this.leases.delete(sessionId);
    return true;
  }

  /**
   * Drop the current lease without waiting for the cancelled request to settle,
   * so the UI can retry immediately. The old turn's `release()` becomes a no-op
   * because it no longer matches.
   */
  preempt(sessionId: string): void {
    this.leases.delete(sessionId);
  }

  /** Sessions with a running turn; used by the active-work quit guard. */
  busySessions(): string[] {
    return [...this.leases.keys()];
  }

  get size(): number {
    return this.leases.size;
  }

  /** Agent process exited: nothing can still be running on the wire. */
  reset(): void {
    this.leases.clear();
  }
}
