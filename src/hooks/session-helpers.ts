import { sessionOf, useStudioStore } from "@/stores/useStudioStore";
import { sessionRpc, type buildTranscriptFromReplay } from "@/lib/universal-api";
import type { Message } from "@/lib/message-types";

type ReplayedMessage = ReturnType<typeof buildTranscriptFromReplay>["messages"][number];

/**
 * Turn an agent's replayed transcript into chat messages. They are history:
 * marked as already seen so the entrance animation does not replay them.
 */
export function historyMessages(replayed: ReplayedMessage[], now: () => string): Message[] {
  const seenAt = Date.now();
  return replayed.map((m, index) => ({
    id: `hist-${seenAt}-${index}`,
    role: m.role,
    seenAt,
    content: m.content,
    thought: m.thought,
    toolCalls: m.toolCalls,
    images: m.images,
    contentBlocks: m.contentBlocks,
    artifacts: m.artifacts,
    timestamp: now(),
  }));
}

/** The note left in a session the agent no longer knows (kept as a read-only history). */
export function sessionGoneNotice(sidPrefix: string, now: () => string): Message {
  return {
    id: `sys-${Date.now()}-gone`,
    role: "system",
    content: `会话 (${sidPrefix}…) 在 Agent 端已失效或已过期（当前为历史记录视图）。点击上方「+ 新会话」可开启独立新会话。`,
    timestamp: now(),
  };
}

/**
 * Leaving the view's session: if the user never wrote in it, delete it on the
 * agent so abandoned zero-message sessions do not pile up in the sidebar.
 * `keep` is the session being opened (never delete what we are going to).
 */
export function discardEmptyDraft(
  agentId: string,
  st: ReturnType<typeof useStudioStore.getState>,
  keep?: string
): void {
  const prevSid = st.sessionId;
  if (!prevSid || prevSid === keep) return;
  if (sessionOf(st).messages.some((m) => m.role === "user")) return;
  void sessionRpc(agentId, "delete", { sessionId: prevSid }).catch(() => {});
}
