import { useEffect, useRef } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { cleanupEmptySessions, sessionRpc } from "@/lib/universal-api";
import { invalidateSessions } from "@/lib/acp-queries";
import type { SessionItem } from "@/components/universal/Sidebar";
import { isThreadEmpty, type ChatThread } from "@/lib/threads";

/** Leave a fresh draft alone for a minute; only sweep clearly abandoned empties. */
export const EMPTY_SESSION_MIN_AGE_MS = 60_000;
/** Server-side sweep is conservative: only rows idle for five minutes. */
export const EMPTY_SESSION_SWEEP_AGE_MS = 5 * 60_000;
export const EMPTY_SESSION_SWEEP_INTERVAL_MS = 60_000;

/** True when a thread carries a real conversation (not just notices). */
function hasConversation(thread: ChatThread): boolean {
  return !isThreadEmpty(thread);
}

/**
 * Delete app-owned sessions that provably carry no conversation:
 * the local thread exists, has no user turn, has no assistant text, is not the
 * live session, and has been idle for EMPTY_SESSION_MIN_AGE_MS.
 *
 * The list already filters these out immediately; this is the eventual cleanup
 * so abandoned drafts don't accumulate in the Agent's store either.
 */
export function useEmptySessionCleanup(opts: {
  agentId: string;
  sessions: SessionItem[];
  threads: Record<string, ChatThread>;
  currentSessionId: string | null;
  connected: boolean;
  qc: QueryClient;
}): void {
  const { agentId, sessions, threads, currentSessionId, connected, qc } = opts;
  const attempted = useRef(new Set<string>());
  const lastSweep = useRef(new Map<string, number>());

  useEffect(() => {
    if (!connected || !agentId || sessions.length === 0) return;
    const now = Date.now();
    for (const item of sessions) {
      const sessionId = item.sessionId;
      if (!sessionId || sessionId === currentSessionId) continue;
      const thread = Object.values(threads).find(
        (t) => t.agentId === agentId && t.sessionId === sessionId
      );
      if (!thread) continue; // externally imported / unknown: never delete blind
      if (!isThreadEmpty(thread)) continue;
      if (now - (thread.updatedAt || 0) < EMPTY_SESSION_MIN_AGE_MS) continue;
      const key = `${agentId}:${sessionId}`;
      if (attempted.current.has(key)) continue;
      attempted.current.add(key);
      void sessionRpc(agentId, "delete", { sessionId })
        .catch((deleteErr) =>
          // Some agents only implement close; the local ref is still hidden by
          // the sidebar filter, but keep the fallback loud.
          sessionRpc(agentId, "close", { sessionId }).catch((closeErr) => {
            console.warn(
              `[App] 清理空会话失败（保留引用，仅从列表隐藏）: ${sessionId.slice(0, 8)}…`,
              deleteErr,
              closeErr
            );
          })
        )
        .finally(() => invalidateSessions(qc, agentId));
    }

    // Conservative server-side sweep for default-titled Agent sessions whose
    // local thread was already pruned (no thread = no precise local signal).
    // Runs at most once a minute; live/conversation ids are excluded.
    const last = lastSweep.current.get(agentId) ?? 0;
    if (now - last >= EMPTY_SESSION_SWEEP_INTERVAL_MS) {
      lastSweep.current.set(agentId, now);
      const except = new Set<string>();
      if (currentSessionId) except.add(currentSessionId);
      for (const thread of Object.values(threads)) {
        if (thread.agentId === agentId && thread.sessionId && hasConversation(thread)) {
          except.add(thread.sessionId);
        }
      }
      void cleanupEmptySessions(agentId, [...except], EMPTY_SESSION_SWEEP_AGE_MS)
        .then((result) => {
          if (result.deleted.length > 0) {
            console.info(`[App] 已清理 ${result.deleted.length} 个空会话（${agentId}）`);
            invalidateSessions(qc, agentId);
          }
        })
        .catch((err) => {
          // Automatic housekeeping is best-effort; the manual cleanup button
          // still reports every failure explicitly.
          console.debug("[App] 自动空会话清理失败（已忽略）:", err);
        });
    }
  }, [agentId, sessions, threads, currentSessionId, connected, qc]);
}
