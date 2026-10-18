/**
 * Per-session, non-durable state owned by one ACP connection.
 *
 * Everything here is keyed by ACP session id and is only meaningful while the
 * agent process is alive. Keeping it in one owner is what makes reclamation
 * possible: a long-lived host closes and deletes sessions for days, so any map
 * that is only cleared on `disconnect()` grows without bound. `drop()` is the
 * single reclamation point used by close/delete/forget paths.
 */
import type * as acp from "@agentclientprotocol/sdk";

/** Live SSE subscribers for one session (one per open chat stream). */
export type SessionSink = (evt: Record<string, unknown>) => void;

export class SessionState {
  /** Live SSE sinks; a turn broadcasts into these as updates arrive. */
  readonly sinks = new Map<string, Set<SessionSink>>();
  /** Last `available_commands_update` per session (undefined = never sent). */
  readonly commands = new Map<string, unknown[]>();
  /** childSessionId -> parentSessionId, learned from session/update. */
  readonly childParents = new Map<string, string>();
  /** childSessionId -> recent updates, replayed by viewChild. */
  readonly childUpdates = new Map<string, unknown[]>();
  /** childSessionId -> latest subagent_update. */
  readonly childStates = new Map<string, acp.SubagentUpdate>();
  /** terminalId -> owning sessionId. */
  readonly terminalOwners = new Map<string, string>();
  /** terminalId -> output captured on release (terminal/output after release). */
  readonly releasedTerminals = new Map<string, { sessionId: string; output: acp.TerminalOutputResponse }>();
  /** sessionId -> prompts sent in this process (first-turn hints depend on it). */
  readonly turnCounts = new Map<string, number>();

  /**
   * Forget everything recorded for one session. Terminals are reclaimed too:
   * their owner map is keyed by terminal id, not session id.
   */
  drop(sessionId: string): void {
    if (!sessionId) return;
    this.sinks.delete(sessionId);
    this.commands.delete(sessionId);
    this.childParents.delete(sessionId);
    this.childUpdates.delete(sessionId);
    this.childStates.delete(sessionId);
    this.turnCounts.delete(sessionId);
    for (const [terminalId, owner] of this.terminalOwners) {
      if (owner === sessionId) this.terminalOwners.delete(terminalId);
    }
    for (const [terminalId, released] of this.releasedTerminals) {
      if (released.sessionId === sessionId) this.releasedTerminals.delete(terminalId);
    }
  }

  /** Agent process gone: every entry refers to a session the process hosted. */
  clear(): void {
    this.sinks.clear();
    this.commands.clear();
    this.childParents.clear();
    this.childUpdates.clear();
    this.childStates.clear();
    this.terminalOwners.clear();
    this.releasedTerminals.clear();
    this.turnCounts.clear();
  }

  /** Diagnostics for the active-work snapshot and tests. */
  sizes(): Record<string, number> {
    return {
      sinks: this.sinks.size,
      commands: this.commands.size,
      childParents: this.childParents.size,
      childUpdates: this.childUpdates.size,
      childStates: this.childStates.size,
      terminalOwners: this.terminalOwners.size,
      releasedTerminals: this.releasedTerminals.size,
      turnCounts: this.turnCounts.size,
    };
  }
}
